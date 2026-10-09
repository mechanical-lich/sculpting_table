import { FloatList, IndexList } from './lists';
import { allocFloat32, allocInt32, allocUint32 } from './alloc';

/**
 * Polygon topology in CSR form: face f's corners are
 * `faceVerts[faceOffsets[f] .. faceOffsets[f + 1])`, counter-clockwise from
 * outside. Corner slot s (an index into `faceVerts`) is also "side s": the
 * edge from that corner to the next one in the face.
 *
 * Level 0 can hold any polygons; every level above it is all quads.
 */
export interface PolyTopology {
  vertexCount: number;
  faceCount: number;
  faceOffsets: Uint32Array;
  faceVerts: Uint32Array;
}

/**
 * Edge incidence needed by Catmull-Clark. Built for every level that has a
 * level above it.
 */
export interface EdgeTables {
  edgeCount: number;
  /** Two vertex ids per edge, lower id first. */
  edges: Uint32Array;
  /** Edge id for each side, parallel to `faceVerts`. */
  sideEdges: Uint32Array;
  /** Two face ids per edge; the second is -1 on a boundary. */
  edgeFaces: Int32Array;
  /** Vertex -> incident edges (CSR). */
  vertexEdgeOffsets: Uint32Array;
  vertexEdges: Uint32Array;
  /** Vertex -> incident faces (CSR). */
  vertexFaceOffsets: Uint32Array;
  vertexFaces: Uint32Array;
}

export function quadTopology(quads: Uint32Array, vertexCount: number): PolyTopology {
  const faceCount = quads.length / 4;
  const faceOffsets = allocUint32(faceCount + 1);
  for (let f = 0; f <= faceCount; f++) faceOffsets[f] = f * 4;
  return { vertexCount, faceCount, faceOffsets, faceVerts: quads };
}

export function isAllQuads(t: PolyTopology): boolean {
  return t.faceVerts.length === t.faceCount * 4;
}

/**
 * Finds edges by grouping sides under their lower vertex id; each group is
 * small (the vertex valence), so a linear scan dedupes it. Throws on edges
 * shared by more than two faces.
 */
export function buildEdgeTables(t: PolyTopology): EdgeTables {
  const V = t.vertexCount;
  const { faceOffsets, faceVerts } = t;
  const S = faceVerts.length;

  const sideFace = new Uint32Array(S);
  const sideNext = new Uint32Array(S);
  for (let f = 0; f < t.faceCount; f++) {
    const s0 = faceOffsets[f],
      s1 = faceOffsets[f + 1];
    for (let s = s0; s < s1; s++) {
      sideFace[s] = f;
      sideNext[s] = s + 1 < s1 ? s + 1 : s0;
    }
  }

  // Group sides by their lower endpoint.
  const groupOffsets = new Uint32Array(V + 1);
  for (let s = 0; s < S; s++) {
    const a = faceVerts[s],
      b = faceVerts[sideNext[s]];
    groupOffsets[(a < b ? a : b) + 1]++;
  }
  for (let v = 0; v < V; v++) groupOffsets[v + 1] += groupOffsets[v];
  const groupSides = new Uint32Array(S);
  const cursor = groupOffsets.slice(0, V);
  for (let s = 0; s < S; s++) {
    const a = faceVerts[s],
      b = faceVerts[sideNext[s]];
    groupSides[cursor[a < b ? a : b]++] = s;
  }

  const sideEdges = allocUint32(S);
  const edgesTmp = new Uint32Array(S * 2);
  const edgeFacesTmp = new Int32Array(S * 2).fill(-1);
  let E = 0;
  for (let lo = 0; lo < V; lo++) {
    const g0 = groupOffsets[lo],
      g1 = groupOffsets[lo + 1];
    for (let k = g0; k < g1; k++) {
      const s = groupSides[k];
      const a = faceVerts[s],
        b = faceVerts[sideNext[s]];
      const hi = a < b ? b : a;
      let e = -1;
      for (let k2 = g0; k2 < k; k2++) {
        const s2 = groupSides[k2];
        const a2 = faceVerts[s2],
          b2 = faceVerts[sideNext[s2]];
        if ((a2 < b2 ? b2 : a2) === hi) {
          e = sideEdges[s2];
          break;
        }
      }
      if (e < 0) {
        e = E++;
        edgesTmp[e * 2] = lo;
        edgesTmp[e * 2 + 1] = hi;
        edgeFacesTmp[e * 2] = sideFace[s];
      } else {
        if (edgeFacesTmp[e * 2 + 1] !== -1) {
          throw new Error(`Non-manifold edge ${lo}-${hi}: shared by more than two faces`);
        }
        edgeFacesTmp[e * 2 + 1] = sideFace[s];
      }
      sideEdges[s] = e;
    }
  }

  const edges = allocUint32(E * 2);
  edges.set(edgesTmp.subarray(0, E * 2));
  const edgeFaces = allocInt32(E * 2);
  edgeFaces.set(edgeFacesTmp.subarray(0, E * 2));

  // Vertex -> edges.
  const vertexEdgeOffsets = allocUint32(V + 1);
  for (let i = 0; i < E * 2; i++) vertexEdgeOffsets[edges[i] + 1]++;
  for (let v = 0; v < V; v++) vertexEdgeOffsets[v + 1] += vertexEdgeOffsets[v];
  const vertexEdges = allocUint32(E * 2);
  const ec = vertexEdgeOffsets.slice(0, V);
  for (let e = 0; e < E; e++) {
    vertexEdges[ec[edges[e * 2]]++] = e;
    vertexEdges[ec[edges[e * 2 + 1]]++] = e;
  }

  const { vertexFaceOffsets, vertexFaces } = buildVertexFaces(t);

  return {
    edgeCount: E,
    edges,
    sideEdges,
    edgeFaces,
    vertexEdgeOffsets,
    vertexEdges,
    vertexFaceOffsets,
    vertexFaces,
  };
}

/** Vertex -> incident faces, in CSR form. */
export function buildVertexFaces(t: PolyTopology): {
  vertexFaceOffsets: Uint32Array;
  vertexFaces: Uint32Array;
} {
  const V = t.vertexCount;
  const { faceOffsets, faceVerts } = t;
  const vertexFaceOffsets = allocUint32(V + 1);
  for (let s = 0; s < faceVerts.length; s++) vertexFaceOffsets[faceVerts[s] + 1]++;
  for (let v = 0; v < V; v++) vertexFaceOffsets[v + 1] += vertexFaceOffsets[v];
  const vertexFaces = allocUint32(faceVerts.length);
  const cursor = vertexFaceOffsets.slice(0, V);
  for (let f = 0; f < t.faceCount; f++) {
    for (let s = faceOffsets[f]; s < faceOffsets[f + 1]; s++)
      vertexFaces[cursor[faceVerts[s]]++] = f;
  }
  return { vertexFaceOffsets, vertexFaces };
}

/**
 * Topology of the next level. Children are numbered
 * [vertex children | edge children | face children], so child v is parent
 * vertex v, child V + e is parent edge e, child V + E + f is parent face f.
 * Face f's corner i becomes the quad (v_i, e_i, f, e_{i-1}).
 */
export function refineTopology(t: PolyTopology, et: EdgeTables): PolyTopology {
  const V = t.vertexCount,
    E = et.edgeCount;
  const { faceOffsets, faceVerts } = t;
  const S = faceVerts.length;
  const quads = allocUint32(S * 4);
  for (let f = 0; f < t.faceCount; f++) {
    const s0 = faceOffsets[f],
      s1 = faceOffsets[f + 1];
    const facePoint = V + E + f;
    for (let s = s0; s < s1; s++) {
      const prev = s > s0 ? s - 1 : s1 - 1;
      const q = s * 4;
      quads[q] = faceVerts[s];
      quads[q + 1] = V + et.sideEdges[s];
      quads[q + 2] = facePoint;
      quads[q + 3] = V + et.sideEdges[prev];
    }
  }
  return quadTopology(quads, V + E + t.faceCount);
}

/**
 * One Catmull-Clark step on positions: returns positions for the refined
 * level (numbered as in `refineTopology`). Boundary edges use midpoints and
 * boundary vertices use (b0 + 6P + b1) / 8; boundary vertices with other than
 * two boundary edges are kept fixed.
 */
export function subdividePositions(
  t: PolyTopology,
  et: EdgeTables,
  p: Float32Array,
  out: Float32Array = allocFloat32((t.vertexCount + et.edgeCount + t.faceCount) * 3),
): Float32Array {
  const V = t.vertexCount,
    E = et.edgeCount;
  const { faceOffsets, faceVerts } = t;
  const { edges, edgeFaces } = et;
  const facePointBase = (V + E) * 3;

  // Face points: corner averages.
  for (let f = 0; f < t.faceCount; f++) {
    const s0 = faceOffsets[f],
      s1 = faceOffsets[f + 1];
    let x = 0,
      y = 0,
      z = 0;
    for (let s = s0; s < s1; s++) {
      const v = faceVerts[s] * 3;
      x += p[v];
      y += p[v + 1];
      z += p[v + 2];
    }
    const inv = 1 / (s1 - s0);
    const o = facePointBase + f * 3;
    out[o] = x * inv;
    out[o + 1] = y * inv;
    out[o + 2] = z * inv;
  }

  // Edge points.
  for (let e = 0; e < E; e++) {
    const a = edges[e * 2] * 3,
      b = edges[e * 2 + 1] * 3;
    const f0 = edgeFaces[e * 2],
      f1 = edgeFaces[e * 2 + 1];
    const o = (V + e) * 3;
    if (f1 < 0) {
      out[o] = (p[a] + p[b]) * 0.5;
      out[o + 1] = (p[a + 1] + p[b + 1]) * 0.5;
      out[o + 2] = (p[a + 2] + p[b + 2]) * 0.5;
    } else {
      const c0 = facePointBase + f0 * 3,
        c1 = facePointBase + f1 * 3;
      out[o] = (p[a] + p[b] + out[c0] + out[c1]) * 0.25;
      out[o + 1] = (p[a + 1] + p[b + 1] + out[c0 + 1] + out[c1 + 1]) * 0.25;
      out[o + 2] = (p[a + 2] + p[b + 2] + out[c0 + 2] + out[c1 + 2]) * 0.25;
    }
  }

  // Vertex points.
  const { vertexEdgeOffsets, vertexEdges, vertexFaceOffsets, vertexFaces } = et;
  for (let v = 0; v < V; v++) {
    const o = v * 3;
    const px = p[o],
      py = p[o + 1],
      pz = p[o + 2];
    const e0 = vertexEdgeOffsets[v],
      e1 = vertexEdgeOffsets[v + 1];
    const n = e1 - e0;

    // Boundary check, and the other ends of boundary edges.
    let boundary = 0;
    let bx = 0,
      by = 0,
      bz = 0;
    for (let k = e0; k < e1; k++) {
      const e = vertexEdges[k];
      if (edgeFaces[e * 2 + 1] < 0) {
        boundary++;
        const u = (edges[e * 2] === v ? edges[e * 2 + 1] : edges[e * 2]) * 3;
        bx += p[u];
        by += p[u + 1];
        bz += p[u + 2];
      }
    }

    if (n === 0 || (boundary > 0 && boundary !== 2)) {
      out[o] = px;
      out[o + 1] = py;
      out[o + 2] = pz;
    } else if (boundary === 2) {
      out[o] = (bx + 6 * px) / 8;
      out[o + 1] = (by + 6 * py) / 8;
      out[o + 2] = (bz + 6 * pz) / 8;
    } else {
      // (F + 2R + (n - 3)P) / n
      let fx = 0,
        fy = 0,
        fz = 0;
      const f0 = vertexFaceOffsets[v],
        f1 = vertexFaceOffsets[v + 1];
      for (let k = f0; k < f1; k++) {
        const c = facePointBase + vertexFaces[k] * 3;
        fx += out[c];
        fy += out[c + 1];
        fz += out[c + 2];
      }
      const invF = 1 / (f1 - f0);
      let rx = 0,
        ry = 0,
        rz = 0;
      for (let k = e0; k < e1; k++) {
        const e = vertexEdges[k];
        const a = edges[e * 2] * 3,
          b = edges[e * 2 + 1] * 3;
        rx += (p[a] + p[b]) * 0.5;
        ry += (p[a + 1] + p[b + 1]) * 0.5;
        rz += (p[a + 2] + p[b + 2]) * 0.5;
      }
      const invN = 1 / n;
      out[o] = (fx * invF + 2 * rx * invN + (n - 3) * px) * invN;
      out[o + 1] = (fy * invF + 2 * ry * invN + (n - 3) * py) * invN;
      out[o + 2] = (fz * invF + 2 * rz * invN + (n - 3) * pz) * invN;
    }
  }
  return out;
}

/**
 * Triangulates faces as fans from the corner with the smallest
 * (|x|, y, z) key, compared with a tolerance. The key is mirror-invariant,
 * so a mirror-symmetric mesh gets a mirror-symmetric triangulation even when
 * mirrored positions differ by rounding.
 */
export function triangulate(t: PolyTopology, p: Float32Array): Uint32Array {
  const { faceOffsets, faceVerts } = t;
  let triCount = 0;
  for (let f = 0; f < t.faceCount; f++) triCount += faceOffsets[f + 1] - faceOffsets[f] - 2;

  let extent = 0;
  for (let i = 0; i < p.length; i++) extent = Math.max(extent, Math.abs(p[i]));
  const eps = Math.max(extent, 1e-12) * 1e-5;

  const less = (a: number, b: number): boolean => {
    const ax = Math.abs(p[a * 3]),
      bx = Math.abs(p[b * 3]);
    if (Math.abs(ax - bx) > eps) return ax < bx;
    const ay = p[a * 3 + 1],
      by = p[b * 3 + 1];
    if (Math.abs(ay - by) > eps) return ay < by;
    return p[a * 3 + 2] < p[b * 3 + 2];
  };

  const tris = allocUint32(triCount * 3);
  let o = 0;
  for (let f = 0; f < t.faceCount; f++) {
    const s0 = faceOffsets[f],
      n = faceOffsets[f + 1] - s0;
    let c = 0;
    for (let i = 1; i < n; i++) if (less(faceVerts[s0 + i], faceVerts[s0 + c])) c = i;
    const apex = faceVerts[s0 + c];
    for (let i = 1; i < n - 1; i++) {
      tris[o++] = apex;
      tris[o++] = faceVerts[s0 + ((c + i) % n)];
      tris[o++] = faceVerts[s0 + ((c + i + 1) % n)];
    }
  }
  return tris;
}

/** A child's subdivision stencil: parent vertex ids and weights (ids may repeat). */
export class Stencil {
  readonly ids = new IndexList(64);
  readonly weights = new FloatList(64);

  clear(): void {
    this.ids.clear();
    this.weights.clear();
  }

  add(id: number, w: number): void {
    this.ids.push(id);
    this.weights.push(w);
  }
}

/**
 * Writes the stencil of child `c` (numbered as in `refineTopology`): the
 * parent vertices and weights whose weighted sum is the child's position.
 * Mirrors `subdividePositions` rule for rule.
 */
export function childStencil(t: PolyTopology, et: EdgeTables, c: number, out: Stencil): void {
  out.clear();
  const V = t.vertexCount,
    E = et.edgeCount;
  const { faceOffsets, faceVerts } = t;
  const { edges, edgeFaces } = et;

  const addFace = (f: number, scale: number) => {
    const s0 = faceOffsets[f],
      s1 = faceOffsets[f + 1];
    const w = scale / (s1 - s0);
    for (let s = s0; s < s1; s++) out.add(faceVerts[s], w);
  };

  if (c >= V + E) {
    addFace(c - V - E, 1);
    return;
  }

  if (c >= V) {
    const e = c - V;
    const a = edges[e * 2],
      b = edges[e * 2 + 1];
    const f1 = edgeFaces[e * 2 + 1];
    if (f1 < 0) {
      out.add(a, 0.5);
      out.add(b, 0.5);
    } else {
      out.add(a, 0.25);
      out.add(b, 0.25);
      addFace(edgeFaces[e * 2], 0.25);
      addFace(f1, 0.25);
    }
    return;
  }

  const v = c;
  const { vertexEdgeOffsets, vertexEdges, vertexFaceOffsets, vertexFaces } = et;
  const e0 = vertexEdgeOffsets[v],
    e1 = vertexEdgeOffsets[v + 1];
  const n = e1 - e0;
  let boundary = 0;
  for (let k = e0; k < e1; k++) if (edgeFaces[vertexEdges[k] * 2 + 1] < 0) boundary++;

  if (n === 0 || (boundary > 0 && boundary !== 2)) {
    out.add(v, 1);
  } else if (boundary === 2) {
    out.add(v, 6 / 8);
    for (let k = e0; k < e1; k++) {
      const e = vertexEdges[k];
      if (edgeFaces[e * 2 + 1] < 0)
        out.add(edges[e * 2] === v ? edges[e * 2 + 1] : edges[e * 2], 1 / 8);
    }
  } else {
    // (F + 2R + (n - 3)P) / n, expanded into parent vertices.
    out.add(v, (n - 3) / n);
    const f0 = vertexFaceOffsets[v],
      f1 = vertexFaceOffsets[v + 1];
    const faceScale = 1 / (n * (f1 - f0));
    for (let k = f0; k < f1; k++) addFace(vertexFaces[k], faceScale);
    const edgeW = 1 / (n * n);
    for (let k = e0; k < e1; k++) {
      const e = vertexEdges[k];
      out.add(edges[e * 2], edgeW);
      out.add(edges[e * 2 + 1], edgeW);
    }
  }
}
