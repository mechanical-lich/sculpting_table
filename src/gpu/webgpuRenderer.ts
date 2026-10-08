import type { Mesh } from '../core/mesh';
import backgroundWgsl from './background.wgsl?raw';
import { DirtyChunks } from './dirtyChunks';
import meshWgsl from './mesh.wgsl?raw';
import type { FrameParams, Renderer } from './renderer';

const SAMPLE_COUNT = 4;
const DEPTH_FORMAT: GPUTextureFormat = 'depth24plus';
// mat4 + 7 vec4.
const UNIFORM_FLOATS = 16 + 7 * 4;

const BASE_COLOR = [0.66, 0.6, 0.55];
const RING_COLOR = [0.95, 0.85, 0.3];
const RING_COLOR_INVERT = [0.35, 0.7, 1.0];
const RING_COLOR_SMOOTH = [0.6, 0.95, 0.6];

export async function createWebGPURenderer(canvas: HTMLCanvasElement): Promise<WebGPURenderer> {
  if (!navigator.gpu) throw new Error('WebGPU is not available in this browser.');
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) throw new Error('No WebGPU adapter found.');
  const device = await adapter.requestDevice();
  // Validation errors are otherwise only console warnings; make them loud.
  device.addEventListener('uncapturederror', (e) => {
    console.error('WebGPU error:', (e as GPUUncapturedErrorEvent).error.message);
  });
  const context = canvas.getContext('webgpu');
  if (!context) throw new Error('Could not get a WebGPU canvas context.');
  return new WebGPURenderer(device, context);
}

interface GpuMesh {
  mesh: Mesh;
  positions: GPUBuffer;
  normals: GPUBuffer;
  indices: GPUBuffer;
  indexCount: number;
  dirty: DirtyChunks;
}

export class WebGPURenderer implements Renderer {
  private readonly format: GPUTextureFormat;
  private readonly meshPipeline: GPURenderPipeline;
  private readonly bgPipeline: GPURenderPipeline;
  private readonly uniformBuffer: GPUBuffer;
  private readonly uniformData = new Float32Array(UNIFORM_FLOATS);
  private readonly bindGroup: GPUBindGroup;
  private msaaTexture: GPUTexture | null = null;
  private depthTexture: GPUTexture | null = null;
  private gpuMesh: GpuMesh | null = null;

  constructor(
    readonly device: GPUDevice,
    private readonly context: GPUCanvasContext,
  ) {
    this.format = navigator.gpu.getPreferredCanvasFormat();
    context.configure({ device, format: this.format, alphaMode: 'opaque' });

    const meshModule = device.createShaderModule({ label: 'mesh', code: meshWgsl });
    const bgModule = device.createShaderModule({ label: 'background', code: backgroundWgsl });
    for (const m of [meshModule, bgModule]) void reportShaderErrors(m);
    const multisample = { count: SAMPLE_COUNT };

    this.meshPipeline = device.createRenderPipeline({
      label: 'mesh',
      layout: 'auto',
      vertex: {
        module: meshModule,
        entryPoint: 'vs',
        buffers: [
          { arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }] },
          { arrayStride: 12, attributes: [{ shaderLocation: 1, offset: 0, format: 'float32x3' }] },
        ],
      },
      fragment: { module: meshModule, entryPoint: 'fs', targets: [{ format: this.format }] },
      primitive: { topology: 'triangle-list', cullMode: 'back', frontFace: 'ccw' },
      depthStencil: { format: DEPTH_FORMAT, depthWriteEnabled: true, depthCompare: 'less' },
      multisample,
    });

    this.bgPipeline = device.createRenderPipeline({
      label: 'background',
      layout: 'auto',
      vertex: { module: bgModule, entryPoint: 'vs' },
      fragment: { module: bgModule, entryPoint: 'fs', targets: [{ format: this.format }] },
      primitive: { topology: 'triangle-list' },
      depthStencil: { format: DEPTH_FORMAT, depthWriteEnabled: false, depthCompare: 'always' },
      multisample,
    });

    this.uniformBuffer = device.createBuffer({
      label: 'uniforms',
      size: UNIFORM_FLOATS * 4,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.bindGroup = device.createBindGroup({
      layout: this.meshPipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: this.uniformBuffer } }],
    });
  }

  setMesh(mesh: Mesh): void {
    this.releaseMesh();
    const d = this.device;
    const make = (label: string, data: Float32Array | Uint32Array, usage: number) => {
      const buf = d.createBuffer({
        label,
        size: Math.ceil(data.byteLength / 4) * 4,
        usage: usage | GPUBufferUsage.COPY_DST,
      });
      d.queue.writeBuffer(buf, 0, data.buffer, data.byteOffset, data.byteLength);
      return buf;
    };
    this.gpuMesh = {
      mesh,
      positions: make('positions', mesh.positions, GPUBufferUsage.VERTEX),
      normals: make('normals', mesh.normals, GPUBufferUsage.VERTEX),
      indices: make('indices', mesh.indices, GPUBufferUsage.INDEX),
      indexCount: mesh.indices.length,
      dirty: new DirtyChunks(mesh.vertexCount),
    };
  }

  markDirty(vertices: Uint32Array): void {
    this.gpuMesh?.dirty.mark(vertices);
  }

  resize(widthPx: number, heightPx: number): void {
    const w = Math.max(1, Math.floor(widthPx));
    const h = Math.max(1, Math.floor(heightPx));
    const canvas = this.context.canvas as HTMLCanvasElement;
    if (canvas.width === w && canvas.height === h && this.msaaTexture) return;
    canvas.width = w;
    canvas.height = h;
    this.msaaTexture?.destroy();
    this.depthTexture?.destroy();
    this.msaaTexture = this.device.createTexture({
      size: [w, h],
      format: this.format,
      sampleCount: SAMPLE_COUNT,
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
    this.depthTexture = this.device.createTexture({
      size: [w, h],
      format: DEPTH_FORMAT,
      sampleCount: SAMPLE_COUNT,
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
  }

  render(frame: FrameParams): void {
    if (!this.msaaTexture || !this.depthTexture) return;
    const gm = this.gpuMesh;
    if (gm) this.flushDirty(gm);
    this.writeUniforms(frame);

    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: this.msaaTexture.createView(),
          resolveTarget: this.context.getCurrentTexture().createView(),
          loadOp: 'clear',
          storeOp: 'discard',
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
        },
      ],
      depthStencilAttachment: {
        view: this.depthTexture.createView(),
        depthLoadOp: 'clear',
        depthStoreOp: 'discard',
        depthClearValue: 1,
      },
    });

    pass.setPipeline(this.bgPipeline);
    pass.draw(3);

    if (gm) {
      pass.setPipeline(this.meshPipeline);
      pass.setBindGroup(0, this.bindGroup);
      pass.setVertexBuffer(0, gm.positions);
      pass.setVertexBuffer(1, gm.normals);
      pass.setIndexBuffer(gm.indices, 'uint32');
      pass.drawIndexed(gm.indexCount);
    }
    pass.end();
    this.device.queue.submit([encoder.finish()]);
  }

  destroy(): void {
    this.releaseMesh();
    this.msaaTexture?.destroy();
    this.depthTexture?.destroy();
    this.uniformBuffer.destroy();
    this.device.destroy();
  }

  /** Uploads only the touched chunks of the position and normal buffers. */
  private flushDirty(gm: GpuMesh): void {
    const { mesh, positions, normals } = gm;
    const q = this.device.queue;
    gm.dirty.flush(mesh.vertexCount, (first, count) => {
      const byteOffset = first * 12;
      const byteLength = count * 12;
      q.writeBuffer(
        positions,
        byteOffset,
        mesh.positions.buffer,
        mesh.positions.byteOffset + byteOffset,
        byteLength,
      );
      q.writeBuffer(
        normals,
        byteOffset,
        mesh.normals.buffer,
        mesh.normals.byteOffset + byteOffset,
        byteLength,
      );
    });
  }

  private writeUniforms(frame: FrameParams): void {
    const u = this.uniformData;
    u.set(frame.viewProj, 0);
    u.set([frame.eye[0], frame.eye[1], frame.eye[2], 1], 16);
    u.set([frame.keyLight[0], frame.keyLight[1], frame.keyLight[2], 0], 20);
    u.set([frame.fillLight[0], frame.fillLight[1], frame.fillLight[2], 0], 24);
    const b = frame.brush;
    if (b && b.radius > 0) {
      u.set([b.x, b.y, b.z, b.radius], 28);
      u.set(b.mirror ? [-b.x, b.y, b.z, b.radius] : [0, 0, 0, 0], 32);
      const color = b.smoothing ? RING_COLOR_SMOOTH : b.inverted ? RING_COLOR_INVERT : RING_COLOR;
      u.set([color[0], color[1], color[2], b.active ? 1 : 0], 36);
    } else {
      u.fill(0, 28, 40);
    }
    u.set([BASE_COLOR[0], BASE_COLOR[1], BASE_COLOR[2], 1], 40);
    this.device.queue.writeBuffer(this.uniformBuffer, 0, u);
  }

  private releaseMesh(): void {
    if (!this.gpuMesh) return;
    this.gpuMesh.positions.destroy();
    this.gpuMesh.normals.destroy();
    this.gpuMesh.indices.destroy();
    this.gpuMesh = null;
  }
}

async function reportShaderErrors(module: GPUShaderModule): Promise<void> {
  const info = await module.getCompilationInfo();
  for (const m of info.messages) {
    if (m.type === 'error') {
      console.error(`WGSL ${module.label}:${m.lineNum}:${m.linePos} ${m.message}`);
    }
  }
}
