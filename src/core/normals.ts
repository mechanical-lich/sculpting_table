import { IndexList, StampSet } from './lists';
import type { Mesh } from './mesh';

/** Writes the unnormalized (area-weighted) normal of triangle `t`. */
function computeFaceNormal(mesh: Mesh, t: number): void {
  const p = mesh.positions;
  const idx = mesh.indices;
  const a = idx[t * 3] * 3,
    b = idx[t * 3 + 1] * 3,
    c = idx[t * 3 + 2] * 3;
  const e1x = p[b] - p[a],
    e1y = p[b + 1] - p[a + 1],
    e1z = p[b + 2] - p[a + 2];
  const e2x = p[c] - p[a],
    e2y = p[c + 1] - p[a + 1],
    e2z = p[c + 2] - p[a + 2];
  const fn = mesh.faceNormals;
  fn[t * 3] = e1y * e2z - e1z * e2y;
  fn[t * 3 + 1] = e1z * e2x - e1x * e2z;
  fn[t * 3 + 2] = e1x * e2y - e1y * e2x;
}

/** Vertex normal = normalized sum of incident face normals (area-weighted). */
function computeVertexNormal(mesh: Mesh, v: number): void {
  const { triOffsets, tris } = mesh.adjacency;
  const fn = mesh.faceNormals;
  let x = 0,
    y = 0,
    z = 0;
  for (let k = triOffsets[v]; k < triOffsets[v + 1]; k++) {
    const t = tris[k] * 3;
    x += fn[t];
    y += fn[t + 1];
    z += fn[t + 2];
  }
  const len = Math.hypot(x, y, z);
  const n = mesh.normals;
  if (len > 0) {
    n[v * 3] = x / len;
    n[v * 3 + 1] = y / len;
    n[v * 3 + 2] = z / len;
  } else {
    n[v * 3] = 0;
    n[v * 3 + 1] = 1;
    n[v * 3 + 2] = 0;
  }
}

export function computeAllNormals(mesh: Mesh): void {
  for (let t = 0; t < mesh.triangleCount; t++) computeFaceNormal(mesh, t);
  for (let v = 0; v < mesh.vertexCount; v++) computeVertexNormal(mesh, v);
}

/**
 * Recomputes normals only around moved vertices: the faces incident to a
 * moved vertex, then every corner of those faces (the moved set's 1-ring).
 */
export class NormalUpdater {
  /** Vertices whose normals were rewritten by the last `update`. Superset of the moved set. */
  readonly changed = new IndexList(4096);
  private readonly faces = new IndexList(8192);
  private readonly faceSeen: StampSet;
  private readonly vertSeen: StampSet;

  constructor(mesh: Mesh) {
    this.faceSeen = new StampSet(mesh.triangleCount);
    this.vertSeen = new StampSet(mesh.vertexCount);
  }

  update(mesh: Mesh, moved: Uint32Array, count = moved.length): Uint32Array {
    const { triOffsets, tris } = mesh.adjacency;
    const idx = mesh.indices;
    this.faceSeen.next();
    this.vertSeen.next();
    this.faces.clear();
    this.changed.clear();

    for (let i = 0; i < count; i++) {
      const v = moved[i];
      for (let k = triOffsets[v]; k < triOffsets[v + 1]; k++) {
        const t = tris[k];
        if (this.faceSeen.add(t)) {
          computeFaceNormal(mesh, t);
          this.faces.push(t);
        }
      }
    }

    const faces = this.faces.data;
    for (let i = 0; i < this.faces.length; i++) {
      const t = faces[i] * 3;
      for (let c = 0; c < 3; c++) {
        const v = idx[t + c];
        if (this.vertSeen.add(v)) this.changed.push(v);
      }
    }

    const changed = this.changed.data;
    for (let i = 0; i < this.changed.length; i++) computeVertexNormal(mesh, changed[i]);
    return this.changed.view();
  }
}
