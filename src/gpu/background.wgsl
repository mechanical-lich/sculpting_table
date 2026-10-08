struct VSOut {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
};

// Fullscreen triangle.
@vertex
fn vs(@builtin(vertex_index) i: u32) -> VSOut {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  var out: VSOut;
  out.position = vec4f(p * 2.0 - 1.0, 1.0, 1.0);
  out.uv = p;
  return out;
}

@fragment
fn fs(in: VSOut) -> @location(0) vec4f {
  let top = vec3f(0.36, 0.38, 0.42);
  let bottom = vec3f(0.13, 0.135, 0.15);
  return vec4f(mix(bottom, top, clamp(in.uv.y, 0.0, 1.0)), 1.0);
}
