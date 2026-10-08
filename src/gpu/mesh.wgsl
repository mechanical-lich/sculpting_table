struct Uniforms {
  viewProj: mat4x4f,
  eye: vec4f,
  // xyz = direction toward the light, w unused.
  keyLight: vec4f,
  fillLight: vec4f,
  // xyz = brush center, w = world radius (<= 0 hides the ring).
  brush: vec4f,
  brushMirror: vec4f,
  // rgb = ring color, a = 1 while a stroke is active.
  brushColor: vec4f,
  baseColor: vec4f,
};

@group(0) @binding(0) var<uniform> u: Uniforms;

struct VSOut {
  @builtin(position) position: vec4f,
  @location(0) world: vec3f,
  @location(1) normal: vec3f,
};

@vertex
fn vs(@location(0) position: vec3f, @location(1) normal: vec3f) -> VSOut {
  var out: VSOut;
  out.position = u.viewProj * vec4f(position, 1.0);
  out.world = position;
  out.normal = normal;
  return out;
}

// Coverage of a ring drawn on the surface where distance to `b.xyz` equals
// the radius, plus a faint fill inside. Derivatives are taken before any
// branching to keep control flow uniform.
fn brushRing(world: vec3f, b: vec4f) -> f32 {
  let d = distance(world, b.xyz);
  let fw = max(fwidth(d), 1e-6);
  let ring = 1.0 - smoothstep(0.0, 1.5 * fw, abs(d - b.w));
  let fill = select(0.0, 0.06, d < b.w);
  return select(0.0, max(ring, fill), b.w > 0.0);
}

@fragment
fn fs(in: VSOut) -> @location(0) vec4f {
  let n = normalize(in.normal);
  let v = normalize(u.eye.xyz - in.world);

  // Clay: key + fill diffuse, low hemispheric ambient, soft spec and rim.
  // Kept fairly contrasty so sculpted forms read clearly.
  let key = u.keyLight.xyz;
  let fill = u.fillLight.xyz;
  let diffKey = max(dot(n, key), 0.0);
  let diffFill = max(dot(n, fill), 0.0) * 0.25;
  let hemi = mix(vec3f(0.07, 0.065, 0.06), vec3f(0.17, 0.18, 0.2), n.y * 0.5 + 0.5);
  let h = normalize(key + v);
  let spec = pow(max(dot(n, h), 0.0), 24.0) * 0.12;
  let rim = pow(1.0 - max(dot(n, v), 0.0), 4.0) * 0.08;

  var color = u.baseColor.rgb * (diffKey * 0.95 + diffFill + hemi) + vec3f(spec + rim);

  let ring = max(brushRing(in.world, u.brush), brushRing(in.world, u.brushMirror));
  color = mix(color, u.brushColor.rgb, ring);

  return vec4f(color, 1.0);
}
