/** Minimal column-major mat4 helpers (WebGPU clip space: z in [0, 1]). */

export type Vec3 = [number, number, number];

export function perspective(fovY: number, aspect: number, near: number, far: number): Float32Array {
  const f = 1 / Math.tan(fovY / 2);
  const nf = 1 / (near - far);
  const m = new Float32Array(16);
  m[0] = f / aspect;
  m[5] = f;
  m[10] = far * nf;
  m[11] = -1;
  m[14] = near * far * nf;
  return m;
}

/** View matrix from an orthonormal camera basis. */
export function viewFromBasis(eye: Vec3, right: Vec3, up: Vec3, forward: Vec3): Float32Array {
  const m = new Float32Array(16);
  m[0] = right[0];
  m[4] = right[1];
  m[8] = right[2];
  m[1] = up[0];
  m[5] = up[1];
  m[9] = up[2];
  m[2] = -forward[0];
  m[6] = -forward[1];
  m[10] = -forward[2];
  m[12] = -(right[0] * eye[0] + right[1] * eye[1] + right[2] * eye[2]);
  m[13] = -(up[0] * eye[0] + up[1] * eye[1] + up[2] * eye[2]);
  m[14] = forward[0] * eye[0] + forward[1] * eye[1] + forward[2] * eye[2];
  m[15] = 1;
  return m;
}

export function multiply(a: Float32Array, b: Float32Array): Float32Array {
  const out = new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      out[c * 4 + r] =
        a[r] * b[c * 4] +
        a[4 + r] * b[c * 4 + 1] +
        a[8 + r] * b[c * 4 + 2] +
        a[12 + r] * b[c * 4 + 3];
    }
  }
  return out;
}
