import { computeAllNormals } from './normals';

/**
 * Vertex adjacency in CSR form. Neighbors of vertex v are
 * `neighbors[neighborOffsets[v] .. neighborOffsets[v + 1])`; likewise for
 * incident triangles. Rebuilt only when topology changes.
 */
export interface Adjacency {
  neighborOffsets: Uint32Array;
  neighbors: Uint32Array;
  triOffsets: Uint32Array;
  tris: Uint32Array;
}

export interface Mesh {
  vertexCount: number;
  triangleCount: number;
  /** xyz per vertex. */
  positions: Float32Array;
  /** Unit xyz per vertex. */
  normals: Float32Array;
  /** Three vertex ids per triangle, counter-clockwise when viewed from outside. */
  indices: Uint32Array;
  /** Unnormalized (area-weighted) normal per triangle, kept for partial updates. */
  faceNormals: Float32Array;
  /** Source quads (four ids each), if the mesh was built from quads. Kept for subdivision. */
  quads: Uint32Array | null;
  adjacency: Adjacency;
}

export function createMesh(
  positions: Float32Array,
  indices: Uint32Array,
  quads: Uint32Array | null = null,
): Mesh {
  const vertexCount = positions.length / 3;
  const triangleCount = indices.length / 3;
  const mesh: Mesh = {
    vertexCount,
    triangleCount,
    positions,
    normals: new Float32Array(vertexCount * 3),
    indices,
    faceNormals: new Float32Array(triangleCount * 3),
    quads,
    adjacency: buildAdjacency(vertexCount, indices),
  };
  computeAllNormals(mesh);
  return mesh;
}

export function buildAdjacency(vertexCount: number, indices: Uint32Array): Adjacency {
  const triCount = indices.length / 3;

  // Vertex -> triangle incidence (exact counts).
  const triOffsets = new Uint32Array(vertexCount + 1);
  for (let i = 0; i < indices.length; i++) triOffsets[indices[i] + 1]++;
  for (let v = 0; v < vertexCount; v++) triOffsets[v + 1] += triOffsets[v];
  const tris = new Uint32Array(indices.length);
  const cursor = triOffsets.slice(0, vertexCount);
  for (let t = 0; t < triCount; t++) {
    for (let c = 0; c < 3; c++) {
      const v = indices[t * 3 + c];
      tris[cursor[v]++] = t;
    }
  }

  // Vertex -> neighbor vertices. Each incident triangle contributes its two
  // other corners; duplicates (shared edges) are removed with a stamp array.
  const neighborOffsets = new Uint32Array(vertexCount + 1);
  const scratch = new Uint32Array(indices.length * 2);
  const stamp = new Int32Array(vertexCount).fill(-1);
  let n = 0;
  for (let v = 0; v < vertexCount; v++) {
    neighborOffsets[v] = n;
    for (let k = triOffsets[v]; k < triOffsets[v + 1]; k++) {
      const t = tris[k] * 3;
      for (let c = 0; c < 3; c++) {
        const u = indices[t + c];
        if (u !== v && stamp[u] !== v) {
          stamp[u] = v;
          scratch[n++] = u;
        }
      }
    }
  }
  neighborOffsets[vertexCount] = n;
  const neighbors = scratch.slice(0, n);

  return { neighborOffsets, neighbors, triOffsets, tris };
}

export interface Bounds {
  min: [number, number, number];
  max: [number, number, number];
  center: [number, number, number];
  radius: number;
}

export function computeBounds(positions: Float32Array, count = positions.length / 3): Bounds {
  let x0 = Infinity,
    y0 = Infinity,
    z0 = Infinity;
  let x1 = -Infinity,
    y1 = -Infinity,
    z1 = -Infinity;
  for (let i = 0; i < count * 3; i += 3) {
    const x = positions[i],
      y = positions[i + 1],
      z = positions[i + 2];
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (z < z0) z0 = z;
    if (x > x1) x1 = x;
    if (y > y1) y1 = y;
    if (z > z1) z1 = z;
  }
  const cx = (x0 + x1) / 2,
    cy = (y0 + y1) / 2,
    cz = (z0 + z1) / 2;
  let r2 = 0;
  for (let i = 0; i < count * 3; i += 3) {
    const dx = positions[i] - cx,
      dy = positions[i + 1] - cy,
      dz = positions[i + 2] - cz;
    const d = dx * dx + dy * dy + dz * dz;
    if (d > r2) r2 = d;
  }
  return { min: [x0, y0, z0], max: [x1, y1, z1], center: [cx, cy, cz], radius: Math.sqrt(r2) };
}

/** Longest edge length in the mesh. */
export function maxEdgeLength(mesh: Mesh): number {
  const { neighborOffsets, neighbors } = mesh.adjacency;
  const p = mesh.positions;
  let best = 0;
  for (let v = 0; v < mesh.vertexCount; v++) {
    const vx = p[v * 3],
      vy = p[v * 3 + 1],
      vz = p[v * 3 + 2];
    for (let k = neighborOffsets[v]; k < neighborOffsets[v + 1]; k++) {
      const u = neighbors[k];
      if (u < v) continue;
      const dx = p[u * 3] - vx,
        dy = p[u * 3 + 1] - vy,
        dz = p[u * 3 + 2] - vz;
      const d = dx * dx + dy * dy + dz * dz;
      if (d > best) best = d;
    }
  }
  return Math.sqrt(best);
}
