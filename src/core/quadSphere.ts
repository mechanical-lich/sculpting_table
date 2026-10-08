export interface QuadSphere {
  positions: Float32Array;
  /** Triangles, two per quad. */
  indices: Uint32Array;
  /** Quads, four vertex ids each, counter-clockwise from outside. */
  quads: Uint32Array;
}

/**
 * A cube with `segments` x `segments` quads per face, projected onto a sphere
 * with the "spherified cube" mapping (more uniform than plain normalization).
 *
 * Triangles = 12 * segments^2. Segments of 204 give ~500k triangles.
 *
 * The result is exactly mirror-symmetric across x = 0, including the
 * triangulation, so symmetric strokes produce symmetric results. This needs
 * an even segment count (no quad straddles the plane).
 */
export function createQuadSphere(segments: number, radius = 1): QuadSphere {
  if (segments < 2 || segments % 2 !== 0) {
    throw new Error('createQuadSphere: segments must be an even number >= 2');
  }
  const n = segments;
  const side = n + 1;
  const vertexCount = 6 * n * n + 2;

  // Surface lattice point (i, j, k) -> vertex id, so cube edges and corners
  // are shared between faces.
  const lattice = new Int32Array(side * side * side).fill(-1);
  const positions = new Float32Array(vertexCount * 3);
  let nextVertex = 0;

  const vertexAt = (i: number, j: number, k: number): number => {
    const key = (i * side + j) * side + k;
    let id = lattice[key];
    if (id >= 0) return id;
    id = nextVertex++;
    lattice[key] = id;
    // (2i - n) / n is exactly negated by i -> n - i, which keeps x symmetric.
    const x = (2 * i - n) / n;
    const y = (2 * j - n) / n;
    const z = (2 * k - n) / n;
    const x2 = x * x,
      y2 = y * y,
      z2 = z * z;
    positions[id * 3] = radius * x * Math.sqrt(1 - y2 / 2 - z2 / 2 + (y2 * z2) / 3);
    positions[id * 3 + 1] = radius * y * Math.sqrt(1 - z2 / 2 - x2 / 2 + (z2 * x2) / 3);
    positions[id * 3 + 2] = radius * z * Math.sqrt(1 - x2 / 2 - y2 / 2 + (x2 * y2) / 3);
    return id;
  };

  // Each face fixes one lattice axis and walks the other two as (a, b), with
  // the a-axis cross the b-axis pointing outward so quads wind
  // counter-clockwise from outside. [fixedAxis, fixedValue, aAxis, bAxis]
  const faces = new Int32Array([
    0,
    n,
    1,
    2, // +X: y x z = +x
    0,
    0,
    2,
    1, // -X: z x y = -x
    1,
    n,
    2,
    0, // +Y: z x x = +y
    1,
    0,
    0,
    2, // -Y: x x z = -y
    2,
    n,
    0,
    1, // +Z: x x y = +z
    2,
    0,
    1,
    0, // -Z: y x x = -z
  ]);
  // Corner offsets in (a, b) for the quad corners 00, 10, 11, 01.
  const cornerA = [0, 1, 1, 0];
  const cornerB = [0, 0, 1, 1];

  const quadCount = 6 * n * n;
  const quads = new Uint32Array(quadCount * 4);
  const indices = new Uint32Array(quadCount * 6);
  const lat = new Int32Array(12); // lattice (i, j, k) of the four corners
  const ids = new Uint32Array(4);
  let q = 0;

  // Mirror-invariant ordering key for picking the quad diagonal: the diagonal
  // always passes through the corner with the smallest (|2i - n|, j, k).
  const keyLess = (p: number, r: number): boolean => {
    const pi = Math.abs(2 * lat[p] - n),
      ri = Math.abs(2 * lat[r] - n);
    if (pi !== ri) return pi < ri;
    if (lat[p + 1] !== lat[r + 1]) return lat[p + 1] < lat[r + 1];
    return lat[p + 2] < lat[r + 2];
  };

  for (let f = 0; f < 6; f++) {
    const fixedAxis = faces[f * 4],
      fixedValue = faces[f * 4 + 1],
      aAxis = faces[f * 4 + 2],
      bAxis = faces[f * 4 + 3];
    for (let b = 0; b < n; b++) {
      for (let a = 0; a < n; a++) {
        for (let c = 0; c < 4; c++) {
          const o = c * 3;
          lat[o + fixedAxis] = fixedValue;
          lat[o + aAxis] = a + cornerA[c];
          lat[o + bAxis] = b + cornerB[c];
          ids[c] = vertexAt(lat[o], lat[o + 1], lat[o + 2]);
        }
        const v00 = ids[0],
          v10 = ids[1],
          v11 = ids[2],
          v01 = ids[3];
        quads[q * 4] = v00;
        quads[q * 4 + 1] = v10;
        quads[q * 4 + 2] = v11;
        quads[q * 4 + 3] = v01;

        let min = 0;
        for (let c = 1; c < 4; c++) if (keyLess(c * 3, min * 3)) min = c;

        const o = q * 6;
        if (min === 0 || min === 2) {
          indices[o] = v00;
          indices[o + 1] = v10;
          indices[o + 2] = v11;
          indices[o + 3] = v00;
          indices[o + 4] = v11;
          indices[o + 5] = v01;
        } else {
          indices[o] = v00;
          indices[o + 1] = v10;
          indices[o + 2] = v01;
          indices[o + 3] = v10;
          indices[o + 4] = v11;
          indices[o + 5] = v01;
        }
        q++;
      }
    }
  }

  if (nextVertex !== vertexCount) {
    throw new Error(`createQuadSphere: expected ${vertexCount} vertices, got ${nextVertex}`);
  }
  return { positions, indices, quads };
}
