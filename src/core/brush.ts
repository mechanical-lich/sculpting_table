import { smoothFalloff, type Falloff } from './falloff';
import { FloatList, IndexList, StampSet } from './lists';
import type { Mesh } from './mesh';
import type { SpatialGrid } from './spatialGrid';
import type { StrokeRecorder } from './undo';

export type BrushKind = 'sculpt' | 'smooth';

/** One brush application at a surface point. */
export interface Dab {
  kind: BrushKind;
  x: number;
  y: number;
  z: number;
  /** World-space radius. */
  radius: number;
  /** Signed strength, already scaled by pressure. Negative inverts (sculpt only). */
  strength: number;
  /** Also apply mirrored across x = 0. */
  symmetryX: boolean;
}

/** Sculpt displacement per dab at full strength, as a fraction of the radius. */
const SCULPT_STEP = 0.04;

/**
 * Applies dabs to a mesh. Holds per-vertex scratch so a dab allocates
 * nothing once warmed up.
 *
 * Symmetry: the primary and mirrored dabs are merged into one pass. Each
 * vertex gets weight max(w, w_mirror), and sculpt direction blends the dab's
 * area normal with its mirror image by those weights. That keeps the result
 * exactly symmetric on a symmetric mesh and avoids double strength where the
 * two dabs overlap near the plane.
 */
export class BrushEngine {
  /** Vertices modified by the last dab. */
  readonly touched = new IndexList(8192);

  private readonly seen: StampSet;
  private weight: Float32Array;
  private weightMirror: Float32Array;
  private readonly scratch = new FloatList(8192 * 3);
  private readonly candidates = new IndexList(8192);

  constructor(
    vertexCount: number,
    private readonly falloff: Falloff = smoothFalloff,
  ) {
    this.seen = new StampSet(vertexCount);
    this.weight = new Float32Array(vertexCount);
    this.weightMirror = new Float32Array(vertexCount);
  }

  applyDab(mesh: Mesh, grid: SpatialGrid, dab: Dab, recorder: StrokeRecorder | null): Uint32Array {
    this.touched.clear();
    this.seen.next();

    this.gather(mesh, grid, dab.x, dab.y, dab.z, dab.radius, this.weight, this.weightMirror);
    if (dab.symmetryX) {
      this.gather(mesh, grid, -dab.x, dab.y, dab.z, dab.radius, this.weightMirror, this.weight);
    }

    const touched = this.touched.view();
    if (touched.length === 0) return touched;
    recorder?.capture(mesh, touched);

    if (dab.kind === 'sculpt') this.sculpt(mesh, dab, touched);
    else this.smooth(mesh, dab, touched);

    grid.updateFromMesh(mesh, touched);
    return touched;
  }

  /**
   * Collects vertices within the radius into `touched` and writes their
   * falloff into `w`. `other` is zeroed for newly seen vertices so stale
   * weights from earlier dabs never leak in.
   */
  private gather(
    mesh: Mesh,
    grid: SpatialGrid,
    cx: number,
    cy: number,
    cz: number,
    radius: number,
    w: Float32Array,
    other: Float32Array,
  ): void {
    this.candidates.clear();
    grid.queryRadius(mesh.positions, cx, cy, cz, radius, this.candidates);
    const p = mesh.positions;
    const cand = this.candidates.data;
    const inv = 1 / radius;
    for (let i = 0; i < this.candidates.length; i++) {
      const v = cand[i];
      const dx = p[v * 3] - cx,
        dy = p[v * 3 + 1] - cy,
        dz = p[v * 3 + 2] - cz;
      const f = this.falloff(Math.sqrt(dx * dx + dy * dy + dz * dz) * inv);
      if (this.seen.add(v)) {
        this.touched.push(v);
        w[v] = f;
        other[v] = 0;
      } else {
        w[v] = f;
      }
    }
  }

  /** Pushes vertices along the dab's weighted average normal. */
  private sculpt(mesh: Mesh, dab: Dab, touched: Uint32Array): void {
    const p = mesh.positions;
    const n = mesh.normals;
    const w = this.weight;
    const wm = this.weightMirror;

    // Area normal of the primary dab; its mirror image serves the other side.
    let ax = 0,
      ay = 0,
      az = 0;
    for (let i = 0; i < touched.length; i++) {
      const v = touched[i];
      const f = w[v];
      ax += n[v * 3] * f;
      ay += n[v * 3 + 1] * f;
      az += n[v * 3 + 2] * f;
    }
    if (dab.symmetryX) {
      // If only the mirror side caught vertices, derive the primary from it.
      for (let i = 0; i < touched.length; i++) {
        const v = touched[i];
        const f = wm[v];
        ax -= n[v * 3] * f;
        ay += n[v * 3 + 1] * f;
        az += n[v * 3 + 2] * f;
      }
    }
    const alen = Math.hypot(ax, ay, az);
    if (alen < 1e-12) return;
    ax /= alen;
    ay /= alen;
    az /= alen;

    const amount = dab.strength * dab.radius * SCULPT_STEP;
    for (let i = 0; i < touched.length; i++) {
      const v = touched[i];
      const f = w[v],
        fm = wm[v];
      // Blend primary normal (ax, ay, az) and mirrored (-ax, ay, az).
      let dx = ax * (f - fm),
        dy = ay * (f + fm),
        dz = az * (f + fm);
      const len = Math.hypot(dx, dy, dz);
      if (len < 1e-12) continue;
      const s = (amount * Math.max(f, fm)) / len;
      dx *= s;
      dy *= s;
      dz *= s;
      p[v * 3] += dx;
      p[v * 3 + 1] += dy;
      p[v * 3 + 2] += dz;
    }
  }

  /** Moves vertices toward their neighbor average (Jacobi: all targets from pre-dab positions). */
  private smooth(mesh: Mesh, dab: Dab, touched: Uint32Array): void {
    const p = mesh.positions;
    const { neighborOffsets, neighbors } = mesh.adjacency;
    const w = this.weight;
    const wm = this.weightMirror;
    const strength = Math.min(1, Math.abs(dab.strength));

    this.scratch.clear();
    for (let i = 0; i < touched.length; i++) {
      const v = touched[i];
      const s = neighborOffsets[v],
        e = neighborOffsets[v + 1];
      let x = 0,
        y = 0,
        z = 0;
      for (let k = s; k < e; k++) {
        const u = neighbors[k] * 3;
        x += p[u];
        y += p[u + 1];
        z += p[u + 2];
      }
      const inv = e > s ? 1 / (e - s) : 0;
      this.scratch.push3(x * inv, y * inv, z * inv);
    }

    const targets = this.scratch.data;
    for (let i = 0; i < touched.length; i++) {
      const v = touched[i];
      if (neighborOffsets[v + 1] === neighborOffsets[v]) continue;
      const t = Math.max(w[v], wm[v]) * strength;
      const dx = (targets[i * 3] - p[v * 3]) * t,
        dy = (targets[i * 3 + 1] - p[v * 3 + 1]) * t,
        dz = (targets[i * 3 + 2] - p[v * 3 + 2]) * t;
      p[v * 3] += dx;
      p[v * 3 + 1] += dy;
      p[v * 3 + 2] += dz;
    }
  }
}
