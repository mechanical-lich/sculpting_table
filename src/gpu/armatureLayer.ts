import { createQuadSphere } from '../core/quadSphere';
import { LINK_SCALE } from '../core/armature/pick';
import type { ArmatureOverlay } from './renderer';
import armatureWgsl from './armature.wgsl?raw';

const LINK_SEGMENTS = 20;
const XRAY_ALPHA = 0.35;
/** Ghost spheres: a cool tint, drawn see-through on top. */
const GHOST_COLOR = [0.55, 0.8, 1.0, 1];

/**
 * Draws an armature: one instanced draw for spheres, one for links. Each
 * comes in a solid variant and a see-through one (for drawing over a skin
 * preview or a sculpt), selected by `overlay.xray`.
 */
export class ArmatureLayer {
  private readonly solid: { sphere: GPURenderPipeline; link: GPURenderPipeline };
  private readonly xray: { sphere: GPURenderPipeline; link: GPURenderPipeline };
  private readonly bindGroups = new Map<GPURenderPipeline, GPUBindGroup>();
  private readonly sphereVerts: GPUBuffer;
  private readonly sphereIndex: GPUBuffer;
  private readonly sphereIndexCount: number;
  private readonly linkVerts: GPUBuffer;
  private readonly linkIndex: GPUBuffer;
  private readonly linkIndexCount: number;
  private sphereInstances: GPUBuffer | null = null;
  private colorInstances: GPUBuffer | null = null;
  private linkInstances: GPUBuffer | null = null;
  // Ghosts get their own buffers: the sphere buffers are already queued for this frame.
  private ghostInstances: GPUBuffer | null = null;
  private ghostColors: GPUBuffer | null = null;
  private ghostColorData = new Float32Array(0);

  constructor(
    private readonly device: GPUDevice,
    format: GPUTextureFormat,
    depthFormat: GPUTextureFormat,
    sampleCount: number,
    private readonly uniformBuffer: GPUBuffer,
  ) {
    const module = device.createShaderModule({ label: 'armature', code: armatureWgsl });
    const make = (entry: 'vsSphere' | 'vsLink', xray: boolean): GPURenderPipeline => {
      // Spheres: (center, radius) and color per instance. Links: (a, ra) then
      // (b, rb), interleaved, so both attributes step 32 bytes.
      const instanceStride = entry === 'vsLink' ? 32 : 16;
      return device.createRenderPipeline({
        label: `armature ${entry}${xray ? ' xray' : ''}`,
        layout: 'auto',
        vertex: {
          module,
          entryPoint: entry,
          constants: { linkScale: LINK_SCALE },
          buffers: [
            {
              arrayStride: 12,
              attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }],
            },
            {
              arrayStride: instanceStride,
              stepMode: 'instance',
              attributes: [{ shaderLocation: 1, offset: 0, format: 'float32x4' }],
            },
            {
              arrayStride: instanceStride,
              stepMode: 'instance',
              attributes: [{ shaderLocation: 2, offset: 0, format: 'float32x4' }],
            },
          ],
        },
        fragment: {
          module,
          entryPoint: 'fs',
          constants: { xrayAlpha: xray ? XRAY_ALPHA : 1 },
          targets: [
            {
              format,
              blend: xray
                ? {
                    color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' },
                    alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
                  }
                : undefined,
            },
          ],
        },
        primitive: { topology: 'triangle-list', cullMode: 'back', frontFace: 'ccw' },
        depthStencil: xray
          ? { format: depthFormat, depthWriteEnabled: false, depthCompare: 'always' }
          : { format: depthFormat, depthWriteEnabled: true, depthCompare: 'less' },
        multisample: { count: sampleCount },
      });
    };
    this.solid = { sphere: make('vsSphere', false), link: make('vsLink', false) };
    this.xray = { sphere: make('vsSphere', true), link: make('vsLink', true) };

    // Unit sphere (a small quad sphere is plenty at screen size).
    const s = createQuadSphere(8);
    this.sphereVerts = this.upload(s.positions, GPUBufferUsage.VERTEX);
    this.sphereIndex = this.upload(s.indices, GPUBufferUsage.INDEX);
    this.sphereIndexCount = s.indices.length;

    // Open cylinder: two rings of (cos, sin, t).
    const lv = new Float32Array(LINK_SEGMENTS * 2 * 3);
    const li = new Uint32Array(LINK_SEGMENTS * 6);
    for (let i = 0; i < LINK_SEGMENTS; i++) {
      const a = (i / LINK_SEGMENTS) * Math.PI * 2;
      for (let ring = 0; ring < 2; ring++) {
        lv.set([Math.cos(a), Math.sin(a), ring], (i * 2 + ring) * 3);
      }
      const n = (i + 1) % LINK_SEGMENTS;
      // Outward-facing winding for side = dir x helper, up = dir x side.
      li.set([i * 2, n * 2, n * 2 + 1, i * 2, n * 2 + 1, i * 2 + 1], i * 6);
    }
    this.linkVerts = this.upload(lv, GPUBufferUsage.VERTEX);
    this.linkIndex = this.upload(li, GPUBufferUsage.INDEX);
    this.linkIndexCount = li.length;
  }

  draw(pass: GPURenderPassEncoder, overlay: ArmatureOverlay): void {
    if (overlay.count === 0) return;
    this.sphereInstances = this.ensure(this.sphereInstances, overlay.spheres);
    this.colorInstances = this.ensure(this.colorInstances, overlay.colors);
    const q = this.device.queue;
    q.writeBuffer(
      this.sphereInstances,
      0,
      overlay.spheres.buffer,
      overlay.spheres.byteOffset,
      overlay.count * 16,
    );
    q.writeBuffer(
      this.colorInstances,
      0,
      overlay.colors.buffer,
      overlay.colors.byteOffset,
      overlay.count * 16,
    );
    const set = overlay.xray ? this.xray : this.solid;

    if (overlay.linkCount > 0) {
      this.linkInstances = this.ensure(this.linkInstances, overlay.links);
      q.writeBuffer(
        this.linkInstances,
        0,
        overlay.links.buffer,
        overlay.links.byteOffset,
        overlay.linkCount * 32,
      );
      pass.setPipeline(set.link);
      pass.setBindGroup(0, this.bindGroup(set.link));
      pass.setVertexBuffer(0, this.linkVerts);
      // a and b interleaved per link: (a.xyzr, b.xyzr), so b starts 16 bytes in.
      pass.setVertexBuffer(1, this.linkInstances, 0);
      pass.setVertexBuffer(2, this.linkInstances, 16);
      pass.setIndexBuffer(this.linkIndex, 'uint32');
      pass.drawIndexed(this.linkIndexCount, overlay.linkCount);
    }

    pass.setPipeline(set.sphere);
    pass.setBindGroup(0, this.bindGroup(set.sphere));
    pass.setVertexBuffer(0, this.sphereVerts);
    pass.setVertexBuffer(1, this.sphereInstances);
    pass.setVertexBuffer(2, this.colorInstances);
    pass.setIndexBuffer(this.sphereIndex, 'uint32');
    pass.drawIndexed(this.sphereIndexCount, overlay.count);

    if (overlay.ghostCount > 0) this.drawGhosts(pass, overlay);
  }

  private drawGhosts(pass: GPURenderPassEncoder, overlay: ArmatureOverlay): void {
    const n = overlay.ghostCount;
    if (this.ghostColorData.length < n * 4) {
      this.ghostColorData = new Float32Array(n * 8);
      for (let i = 0; i < n * 2; i++) this.ghostColorData.set(GHOST_COLOR, i * 4);
    }
    this.ghostInstances = this.ensure(this.ghostInstances, overlay.ghosts);
    this.ghostColors = this.ensure(this.ghostColors, this.ghostColorData);
    const q = this.device.queue;
    q.writeBuffer(this.ghostInstances, 0, overlay.ghosts.buffer, overlay.ghosts.byteOffset, n * 16);
    q.writeBuffer(this.ghostColors, 0, this.ghostColorData.buffer, 0, n * 16);
    pass.setPipeline(this.xray.sphere);
    pass.setBindGroup(0, this.bindGroup(this.xray.sphere));
    pass.setVertexBuffer(0, this.sphereVerts);
    pass.setVertexBuffer(1, this.ghostInstances);
    pass.setVertexBuffer(2, this.ghostColors);
    pass.setIndexBuffer(this.sphereIndex, 'uint32');
    pass.drawIndexed(this.sphereIndexCount, n);
  }

  destroy(): void {
    for (const b of [this.sphereVerts, this.sphereIndex, this.linkVerts, this.linkIndex])
      b.destroy();
    this.sphereInstances?.destroy();
    this.colorInstances?.destroy();
    this.linkInstances?.destroy();
    this.ghostInstances?.destroy();
    this.ghostColors?.destroy();
  }

  private bindGroup(pipeline: GPURenderPipeline): GPUBindGroup {
    let g = this.bindGroups.get(pipeline);
    if (!g) {
      g = this.device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: { buffer: this.uniformBuffer } }],
      });
      this.bindGroups.set(pipeline, g);
    }
    return g;
  }

  private upload(data: Float32Array | Uint32Array, usage: number): GPUBuffer {
    const buf = this.device.createBuffer({
      size: data.byteLength,
      usage: usage | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(buf, 0, data.buffer, data.byteOffset, data.byteLength);
    return buf;
  }

  /** A vertex buffer at least as big as `data`, reallocated by doubling. */
  private ensure(buf: GPUBuffer | null, data: Float32Array): GPUBuffer {
    if (buf && buf.size >= data.byteLength) return buf;
    buf?.destroy();
    return this.device.createBuffer({
      size: Math.max(256, (buf?.size ?? 0) * 2, data.byteLength),
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
  }
}
