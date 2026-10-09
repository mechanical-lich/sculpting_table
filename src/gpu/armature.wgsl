// Armature: instanced spheres and tapered links. Shares the mesh pass's
// uniform buffer (same layout as mesh.wgsl).

struct Uniforms {
  viewProj: mat4x4f,
  eye: vec4f,
  keyLight: vec4f,
  fillLight: vec4f,
  brush: vec4f,
  brushMirror: vec4f,
  brushColor: vec4f,
  baseColor: vec4f,
  options: vec4f,
};

@group(0) @binding(0) var<uniform> u: Uniforms;

/** 1 for solid drawing, lower for the see-through variant. */
override xrayAlpha: f32 = 1.0;
/** Links are drawn at this fraction of their end radii (matches pick.ts LINK_SCALE). */
override linkScale: f32 = 0.35;

struct Out {
  @builtin(position) position: vec4f,
  @location(0) world: vec3f,
  @location(1) normal: vec3f,
  @location(2) color: vec3f,
};

@vertex
fn vsSphere(@location(0) p: vec3f, @location(1) sphere: vec4f, @location(2) color: vec4f) -> Out {
  var out: Out;
  let w = sphere.xyz + p * sphere.w;
  out.position = u.viewProj * vec4f(w, 1.0);
  out.world = w;
  out.normal = p;
  out.color = color.rgb;
  return out;
}

// p = (cos, sin, t along the link).
@vertex
fn vsLink(@location(0) p: vec3f, @location(1) a: vec4f, @location(2) b: vec4f) -> Out {
  var out: Out;
  let axis = b.xyz - a.xyz;
  let dir = axis / max(length(axis), 1e-6);
  let helper = select(vec3f(0.0, 1.0, 0.0), vec3f(1.0, 0.0, 0.0), abs(dir.y) > 0.9);
  let side = normalize(cross(dir, helper));
  let up = cross(dir, side);
  let radial = side * p.x + up * p.y;
  let r = mix(a.w, b.w, p.z) * linkScale;
  let w = a.xyz + axis * p.z + radial * r;
  out.position = u.viewProj * vec4f(w, 1.0);
  out.world = w;
  out.normal = radial;
  out.color = vec3f(0.5, 0.52, 0.58);
  return out;
}

@fragment
fn fs(in: Out) -> @location(0) vec4f {
  let n = normalize(in.normal);
  let v = normalize(u.eye.xyz - in.world);
  let diff = max(dot(n, u.keyLight.xyz), 0.0) * 0.85 + max(dot(n, u.fillLight.xyz), 0.0) * 0.25;
  let hemi = mix(vec3f(0.08), vec3f(0.2), n.y * 0.5 + 0.5);
  let spec = pow(max(dot(n, normalize(u.keyLight.xyz + v)), 0.0), 32.0) * 0.2;
  let rgb = in.color * (diff + hemi) + vec3f(spec);
  return vec4f(rgb, xrayAlpha);
}
