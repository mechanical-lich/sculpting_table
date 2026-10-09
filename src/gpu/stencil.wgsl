// Screen-space stencil overlay. Mirrors core/stencil.ts `screenToStencil`.

struct Stencil {
  // Center and half side length, in framebuffer pixels.
  center: vec2f,
  halfSize: f32,
  // Clockwise on screen, radians.
  angle: f32,
  opacity: f32,
  // 1 = repeat beyond the square.
  tile: f32,
  _pad: vec2f,
};

@group(0) @binding(0) var<uniform> s: Stencil;
@group(0) @binding(1) var image: texture_2d<f32>;
@group(0) @binding(2) var imageSampler: sampler;

@vertex
fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  return vec4f(p * 2.0 - 1.0, 0.0, 1.0);
}

@fragment
fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let d = pos.xy - s.center;
  let c = cos(s.angle);
  let sn = sin(s.angle);
  let u = (d.x * c + d.y * sn) / s.halfSize;
  let v = -(-d.x * sn + d.y * c) / s.halfSize;
  // The repeat sampler wraps with period 2 in (u, v), as `wrap` does on the CPU.
  let value = textureSample(image, imageSampler, vec2f((u + 1.0) * 0.5, (1.0 - v) * 0.5)).r;
  let inside = s.tile > 0.5 || (abs(u) <= 1.0 && abs(v) <= 1.0);
  // A thin frame shows the bounds of an untiled stencil.
  let px = 1.5 / s.halfSize;
  let onEdge = s.tile < 0.5 && max(abs(u), abs(v)) > 1.0 - px && max(abs(u), abs(v)) <= 1.0;
  let alpha = select(0.0, s.opacity, inside);
  let rgb = select(vec3f(value), vec3f(0.95, 0.85, 0.3), onEdge);
  return vec4f(rgb, select(alpha, 0.8, onEdge));
}
