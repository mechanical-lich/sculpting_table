import { allocFloat32 } from './alloc';
import { IndexList, StampSet } from './lists';
import { createMesh, type Mesh } from './mesh';
import {
  buildEdgeTables,
  buildVertexFaces,
  childStencil,
  isAllQuads,
  refineTopology,
  Stencil,
  subdividePositions,
  triangulate,
  type EdgeTables,
  type PolyTopology,
} from './subdivision';
import { gather, type ArrayPatch, type UndoEntry } from './undo';

/**
 * One subdivision level. See docs/multires.md.
 *
 * Invariant (I1), for every level k >= 1 that is not `stale`:
 *   P_k = Q_k + F(Q_k) · D_k,  where Q_k = S(P_{k-1})
 */
export interface Level {
  topology: PolyTopology;
  /** Triangulation, fixed when the level is created so it stays mirror-symmetric. */
  triangles: Uint32Array;
  vertexFaceOffsets: Uint32Array;
  vertexFaces: Uint32Array;
  /** Refinement tables toward the level above; null on the top level. */
  edges: EdgeTables | null;
  /** Per vertex: total stencil weight it contributes to the level above. */
  restrictionWeights: Float32Array | null;
  /** Position cache P (level 0: the source of truth). */
  positions: Float32Array;
  /** Tangent-space displacement D (x = tangent, y = bitangent, z = normal); null at level 0. */
  displacement: Float32Array | null;
  /** True when `positions` is out of date with respect to the levels below. */
  stale: boolean;
  /**
   * Mask for this level (0 free .. 1 frozen). Only the active level's mask is
   * authoritative; `transferMask` carries it to another level on a switch.
   */
  mask: Float32Array;
}

function makeLevel(
  topology: PolyTopology,
  positions: Float32Array,
  displacement: Float32Array | null,
): Level {
  const { vertexFaceOffsets, vertexFaces } = buildVertexFaces(topology);
  return {
    topology,
    triangles: triangulate(topology, positions),
    vertexFaceOffsets,
    vertexFaces,
    edges: null,
    restrictionWeights: null,
    positions,
    displacement,
    stale: false,
    mask: allocFloat32(topology.vertexCount),
  };
}

/** Growable Float32 scratch. */
function ensureLength(a: Float32Array, n: number): Float32Array {
  return a.length >= n ? a : new Float32Array(Math.max(n, a.length * 2));
}

/**
 * A multires model: a base mesh plus Catmull-Clark levels with tangent-space
 * displacements. Kernel only: callers decide which level is active and
 * refresh their views after `ensureCurrent`, `commit` and undo.
 */
export class Multires {
  readonly levels: Level[] = [];

  private readonly stencil = new Stencil();
  /** Frame scratch: tangent, bitangent, normal. */
  private readonly frame = new Float64Array(9);
  private q: Float32Array = new Float32Array(0);
  private n = new Float64Array(0);
  private acc = new Float64Array(0);
  private readonly qSeen = new StampSet(0);
  private readonly parentSeen = new StampSet(0);
  private readonly regionSeen = new StampSet(0);
  private readonly dependentSeen = new StampSet(0);
  private readonly parentIds = new IndexList(4096);
  private readonly dependents = new IndexList(4096);
  private readonly region = new IndexList(4096);

  constructor(base: PolyTopology, positions: Float32Array) {
    this.levels.push(makeLevel(base, positions, null));
  }

  get top(): number {
    return this.levels.length - 1;
  }

  /** Adds a level above the top, with zero displacement. Returns its index. */
  addLevel(): number {
    this.ensureCurrent(this.top);
    const parent = this.levels[this.top];
    const et = buildEdgeTables(parent.topology);
    parent.edges = et;
    // Share the identical CSR built with the edge tables.
    parent.vertexFaceOffsets = et.vertexFaceOffsets;
    parent.vertexFaces = et.vertexFaces;
    parent.restrictionWeights = this.computeRestrictionWeights(parent);

    const topology = refineTopology(parent.topology, et);
    const positions = subdividePositions(parent.topology, et, parent.positions);
    this.levels.push(makeLevel(topology, positions, allocFloat32(topology.vertexCount * 3)));
    this.transferMask(this.top - 1, this.top);
    return this.top;
  }

  /** Drops every level above `k`. */
  removeLevelsAbove(k: number): void {
    this.levels.length = k + 1;
    const lvl = this.levels[k];
    lvl.edges = null;
    lvl.restrictionWeights = null;
  }

  /** Brings levels 1..k up to date (I1), rebuilding stale ones from below. */
  ensureCurrent(k: number): void {
    for (let j = 1; j <= k; j++) if (this.levels[j].stale) this.rebuild(j);
  }

  /** A sculptable mesh over level k's position cache (shares the array). */
  createLevelMesh(k: number): Mesh {
    const lvl = this.levels[k];
    const quads = isAllQuads(lvl.topology) ? lvl.topology.faceVerts : null;
    return createMesh(lvl.positions, lvl.triangles, quads, lvl.mask);
  }

  /**
   * Copies level `from`'s mask onto level `to`, one step at a time. Going
   * down, each vertex takes its vertex child's value (child v = parent v), so
   * the result is exact. Going up, children interpolate their parents with
   * the subdivision stencils, so mask edges come out smooth.
   */
  transferMask(from: number, to: number): void {
    for (let j = from; j > to; j--) {
      const coarse = this.levels[j - 1].mask;
      coarse.set(this.levels[j].mask.subarray(0, coarse.length));
    }
    for (let j = from; j < to; j++) {
      const parent = this.levels[j];
      const fine = this.levels[j + 1].mask;
      const pm = parent.mask;
      if (!pm.some((v) => v !== 0)) {
        fine.fill(0);
        continue;
      }
      for (let c = 0; c < fine.length; c++) {
        childStencil(parent.topology, parent.edges!, c, this.stencil);
        const ids = this.stencil.ids.data,
          ws = this.stencil.weights.data;
        let v = 0;
        for (let s = 0; s < this.stencil.ids.length; s++) v += ws[s] * pm[ids[s]];
        fine[c] = v < 0 ? 0 : v > 1 ? 1 : v;
      }
    }
  }

  /**
   * Commits a stroke made on level k (a patch on level k's positions):
   * restricts the change down to every lower level, re-derives their
   * displacements so the sculpted level stays exactly as sculpted, and marks
   * the levels above stale. Returns everything changed, for undo.
   */
  commit(k: number, stroke: ArrayPatch): UndoEntry {
    const patches: ArrayPatch[] = [stroke];
    for (let j = k + 1; j < this.levels.length; j++) this.levels[j].stale = true;

    let ids = stroke.indices;
    let delta = new Float32Array(stroke.after.length);
    for (let i = 0; i < delta.length; i++) delta[i] = stroke.after[i] - stroke.before[i];

    for (let j = k; j >= 1; j--) {
      const parent = this.levels[j - 1];
      const lvl = this.levels[j];
      const pt = parent.topology,
        pe = parent.edges!;

      // 1. Restrict: normalized transpose of the stencils.
      this.acc =
        this.acc.length >= pt.vertexCount * 3 ? this.acc : new Float64Array(pt.vertexCount * 3);
      const acc = this.acc;
      this.parentSeen.resize(pt.vertexCount);
      this.parentSeen.next();
      this.parentIds.clear();
      for (let i = 0; i < ids.length; i++) {
        const dx = delta[i * 3],
          dy = delta[i * 3 + 1],
          dz = delta[i * 3 + 2];
        if (dx === 0 && dy === 0 && dz === 0) continue;
        childStencil(pt, pe, ids[i], this.stencil);
        const sIds = this.stencil.ids.data,
          sW = this.stencil.weights.data;
        for (let s = 0; s < this.stencil.ids.length; s++) {
          const v = sIds[s],
            w = sW[s];
          if (this.parentSeen.add(v)) {
            this.parentIds.push(v);
            acc[v * 3] = acc[v * 3 + 1] = acc[v * 3 + 2] = 0;
          }
          acc[v * 3] += w * dx;
          acc[v * 3 + 1] += w * dy;
          acc[v * 3 + 2] += w * dz;
        }
      }

      const pIds = this.parentIds.view().slice();
      const W = parent.restrictionWeights!;
      const pp = parent.positions;
      const before = gather(pp, pIds);
      const nextDelta = new Float32Array(pIds.length * 3);
      for (let i = 0; i < pIds.length; i++) {
        const v = pIds[i];
        const inv = 1 / W[v];
        for (let c = 0; c < 3; c++) {
          const d = acc[v * 3 + c] * inv;
          pp[v * 3 + c] += d;
          nextDelta[i * 3 + c] = d;
        }
      }
      patches.push({ target: pp, stride: 3, indices: pIds, before, after: gather(pp, pIds) });

      // 2. Re-displace level j where P, Q or the frame changed; P_j stays fixed.
      const region = this.redisplaceRegion(j, ids, pIds);
      const D = lvl.displacement!;
      const dBefore = gather(D, region);
      this.redisplace(j, region);
      patches.push({
        target: D,
        stride: 3,
        indices: region,
        before: dBefore,
        after: gather(D, region),
      });

      ids = pIds;
      delta = nextDelta;
    }
    return { level: k, patches };
  }

  /** Marks the levels above an undone/redone entry stale. */
  invalidateAbove(k: number): void {
    for (let j = k + 1; j < this.levels.length; j++) this.levels[j].stale = true;
  }

  /** Largest |P_k - (Q_k + F D_k)| over level k. For tests and debugging. */
  invariantError(k: number): number {
    const lvl = this.levels[k];
    const before = lvl.positions.slice();
    this.rebuild(k);
    let err = 0;
    for (let i = 0; i < before.length; i++)
      err = Math.max(err, Math.abs(before[i] - lvl.positions[i]));
    lvl.positions.set(before);
    return err;
  }

  // --- internals -------------------------------------------------------------

  /** Full rebuild of level j's positions from level j - 1 (which must be current). */
  private rebuild(j: number): void {
    const parent = this.levels[j - 1];
    const lvl = this.levels[j];
    const count = lvl.topology.vertexCount;
    this.q = ensureLength(this.q, count * 3);
    if (this.n.length < count * 3) this.n = new Float64Array(count * 3);
    const Q = this.q,
      N = this.n;
    subdividePositions(parent.topology, parent.edges!, parent.positions, Q);

    N.fill(0, 0, count * 3);
    const quads = lvl.topology.faceVerts;
    for (let f = 0; f < lvl.topology.faceCount; f++) {
      const a = quads[f * 4] * 3,
        b = quads[f * 4 + 1] * 3,
        c = quads[f * 4 + 2] * 3,
        d = quads[f * 4 + 3] * 3;
      const ux = Q[c] - Q[a],
        uy = Q[c + 1] - Q[a + 1],
        uz = Q[c + 2] - Q[a + 2];
      const vx = Q[d] - Q[b],
        vy = Q[d + 1] - Q[b + 1],
        vz = Q[d + 2] - Q[b + 2];
      const nx = uy * vz - uz * vy,
        ny = uz * vx - ux * vz,
        nz = ux * vy - uy * vx;
      N[a] += nx;
      N[a + 1] += ny;
      N[a + 2] += nz;
      N[b] += nx;
      N[b + 1] += ny;
      N[b + 2] += nz;
      N[c] += nx;
      N[c + 1] += ny;
      N[c + 2] += nz;
      N[d] += nx;
      N[d + 1] += ny;
      N[d + 2] += nz;
    }

    const P = lvl.positions,
      D = lvl.displacement!;
    const F = this.frame;
    for (let v = 0; v < count; v++) {
      const o = v * 3;
      this.makeFrame(Q, v, this.frameReference(j, v), N[o], N[o + 1], N[o + 2]);
      const dx = D[o],
        dy = D[o + 1],
        dz = D[o + 2];
      P[o] = Q[o] + F[0] * dx + F[3] * dy + F[6] * dz;
      P[o + 1] = Q[o + 1] + F[1] * dx + F[4] * dy + F[7] * dz;
      P[o + 2] = Q[o + 2] + F[2] * dx + F[5] * dy + F[8] * dz;
    }
    lvl.stale = false;
  }

  /**
   * Level-j vertices whose D must be recomputed: those whose P changed, those
   * whose Q depends on a changed parent, and the face ring around the latter
   * (their frames read neighboring Q).
   */
  private redisplaceRegion(
    j: number,
    changedP: Uint32Array,
    changedParents: Uint32Array,
  ): Uint32Array {
    const parent = this.levels[j - 1];
    const lvl = this.levels[j];
    const pt = parent.topology,
      pe = parent.edges!;
    const V = pt.vertexCount,
      E = pe.edgeCount;
    this.regionSeen.resize(lvl.topology.vertexCount);
    this.regionSeen.next();
    this.region.clear();
    this.dependents.clear();
    const add = (c: number) => {
      if (this.regionSeen.add(c)) this.region.push(c);
    };

    for (let i = 0; i < changedP.length; i++) add(changedP[i]);

    // Children whose stencils touch a changed parent: everything on the parent's faces.
    const depSeen = this.dependentSeen;
    depSeen.resize(lvl.topology.vertexCount);
    depSeen.next();
    for (let i = 0; i < changedParents.length; i++) {
      const v = changedParents[i];
      for (let k = parent.vertexFaceOffsets[v]; k < parent.vertexFaceOffsets[v + 1]; k++) {
        const f = parent.vertexFaces[k];
        if (depSeen.add(V + E + f)) this.dependents.push(V + E + f);
        for (let s = pt.faceOffsets[f]; s < pt.faceOffsets[f + 1]; s++) {
          const ec = V + pe.sideEdges[s];
          const vc = pt.faceVerts[s];
          if (depSeen.add(ec)) this.dependents.push(ec);
          if (depSeen.add(vc)) this.dependents.push(vc);
        }
      }
    }

    // Dependents plus every vertex sharing a face with one.
    const quads = lvl.topology.faceVerts;
    const dep = this.dependents.data;
    for (let i = 0; i < this.dependents.length; i++) {
      const c = dep[i];
      add(c);
      for (let k = lvl.vertexFaceOffsets[c]; k < lvl.vertexFaceOffsets[c + 1]; k++) {
        const f = lvl.vertexFaces[k];
        for (let s = 0; s < 4; s++) add(quads[f * 4 + s]);
      }
    }
    return this.region.view().slice();
  }

  /** Recomputes D_j = F(Q)^T (P - Q) for `region`, evaluating Q locally. */
  private redisplace(j: number, region: Uint32Array): void {
    const parent = this.levels[j - 1];
    const lvl = this.levels[j];
    const count = lvl.topology.vertexCount;
    this.q = ensureLength(this.q, count * 3);
    this.qSeen.resize(count);
    this.qSeen.next();
    const Q = this.q;
    const quads = lvl.topology.faceVerts;
    const P = lvl.positions,
      D = lvl.displacement!;
    const F = this.frame;

    for (let i = 0; i < region.length; i++) {
      const c = region[i];
      let nx = 0,
        ny = 0,
        nz = 0;
      for (let k = lvl.vertexFaceOffsets[c]; k < lvl.vertexFaceOffsets[c + 1]; k++) {
        const f = lvl.vertexFaces[k] * 4;
        const a = this.localQ(parent, quads[f]),
          b = this.localQ(parent, quads[f + 1]),
          cc = this.localQ(parent, quads[f + 2]),
          d = this.localQ(parent, quads[f + 3]);
        const ux = Q[cc] - Q[a],
          uy = Q[cc + 1] - Q[a + 1],
          uz = Q[cc + 2] - Q[a + 2];
        const vx = Q[d] - Q[b],
          vy = Q[d + 1] - Q[b + 1],
          vz = Q[d + 2] - Q[b + 2];
        nx += uy * vz - uz * vy;
        ny += uz * vx - ux * vz;
        nz += ux * vy - uy * vx;
      }
      const o = this.localQ(parent, c);
      const ref = this.frameReference(j, c);
      if (ref >= 0) this.localQ(parent, ref);
      this.makeFrame(Q, c, ref, nx, ny, nz);
      const px = P[o] - Q[o],
        py = P[o + 1] - Q[o + 1],
        pz = P[o + 2] - Q[o + 2];
      D[o] = F[0] * px + F[1] * py + F[2] * pz;
      D[o + 1] = F[3] * px + F[4] * py + F[5] * pz;
      D[o + 2] = F[6] * px + F[7] * py + F[8] * pz;
    }
  }

  /** Ensures the Q scratch holds child c's smooth position; returns its offset. */
  private localQ(parent: Level, c: number): number {
    const o = c * 3;
    if (!this.qSeen.add(c)) return o;
    childStencil(parent.topology, parent.edges!, c, this.stencil);
    const p = parent.positions;
    const ids = this.stencil.ids.data,
      ws = this.stencil.weights.data;
    let x = 0,
      y = 0,
      z = 0;
    for (let s = 0; s < this.stencil.ids.length; s++) {
      const v = ids[s] * 3,
        w = ws[s];
      x += w * p[v];
      y += w * p[v + 1];
      z += w * p[v + 2];
    }
    this.q[o] = x;
    this.q[o + 1] = y;
    this.q[o + 2] = z;
    return o;
  }

  /**
   * The fixed neighbor that orients child c's tangent, from the child
   * numbering: vertex child -> its first edge's child, edge child -> its
   * first endpoint, face child -> its first side's edge child.
   */
  private frameReference(j: number, c: number): number {
    const parent = this.levels[j - 1];
    const pt = parent.topology,
      pe = parent.edges!;
    const V = pt.vertexCount,
      E = pe.edgeCount;
    if (c < V) {
      const k = pe.vertexEdgeOffsets[c];
      return k < pe.vertexEdgeOffsets[c + 1] ? V + pe.vertexEdges[k] : -1;
    }
    if (c < V + E) return pe.edges[(c - V) * 2];
    return V + pe.sideEdges[pt.faceOffsets[c - V - E]];
  }

  /** Writes the orthonormal frame (t, b, n) at c into `this.frame`. */
  private makeFrame(
    Q: Float32Array,
    c: number,
    ref: number,
    nx: number,
    ny: number,
    nz: number,
  ): void {
    const F = this.frame;
    let len = Math.hypot(nx, ny, nz);
    if (len < 1e-30) {
      nx = 0;
      ny = 0;
      nz = 1;
      len = 1;
    }
    nx /= len;
    ny /= len;
    nz /= len;

    let tx = 0,
      ty = 0,
      tz = 0,
      tl = 0,
      rl = 0;
    if (ref >= 0) {
      const rx = Q[ref * 3] - Q[c * 3],
        ry = Q[ref * 3 + 1] - Q[c * 3 + 1],
        rz = Q[ref * 3 + 2] - Q[c * 3 + 2];
      const dot = rx * nx + ry * ny + rz * nz;
      tx = rx - nx * dot;
      ty = ry - ny * dot;
      tz = rz - nz * dot;
      tl = Math.hypot(tx, ty, tz);
      rl = Math.hypot(rx, ry, rz);
    }
    if (tl <= 1e-6 * rl || tl === 0) {
      // Degenerate reference: any axis not parallel to n.
      const ax = Math.abs(nx) < 0.9 ? 1 : 0,
        ay = ax ? 0 : 1;
      tx = ay * nz;
      ty = -ax * nz;
      tz = ax * ny - ay * nx;
      tl = Math.hypot(tx, ty, tz);
    }
    tx /= tl;
    ty /= tl;
    tz /= tl;
    F[0] = tx;
    F[1] = ty;
    F[2] = tz;
    F[3] = ny * tz - nz * ty;
    F[4] = nz * tx - nx * tz;
    F[5] = nx * ty - ny * tx;
    F[6] = nx;
    F[7] = ny;
    F[8] = nz;
  }

  private computeRestrictionWeights(lvl: Level): Float32Array {
    const t = lvl.topology,
      et = lvl.edges!;
    const W = allocFloat32(t.vertexCount);
    const children = t.vertexCount + et.edgeCount + t.faceCount;
    for (let c = 0; c < children; c++) {
      childStencil(t, et, c, this.stencil);
      const ids = this.stencil.ids.data,
        ws = this.stencil.weights.data;
      for (let s = 0; s < this.stencil.ids.length; s++) W[ids[s]] += ws[s];
    }
    return W;
  }
}
