import { FALLOFFS, type FalloffKind } from './falloff';
import { FloatList, IndexList, StampSet } from './lists';
import type { Mesh } from './mesh';
import type { SpatialGrid } from './spatialGrid';
import type { StrokeRecorder } from './undo';

export type BrushKind =
  | 'sculpt'
  | 'smooth'
  | 'grab'
  | 'pinch'
  | 'flatten'
  | 'crease'
  | 'inflate'
  | 'scrape'
  | 'knife'
  | 'wax';

export interface BrushDef {
  label: string;
  hint: string;
  defaultStrength: number;
  defaultFalloff: FalloffKind;
}

/** Brush catalogue, in tray order. */
export const BRUSHES: Record<BrushKind, BrushDef> = {
  sculpt: {
    label: 'Sculpt',
    hint: 'Push along the surface',
    defaultStrength: 0.5,
    defaultFalloff: 'smooth',
  },
  smooth: {
    label: 'Smooth',
    hint: 'Average out surface detail',
    defaultStrength: 0.5,
    defaultFalloff: 'smooth',
  },
  grab: {
    label: 'Grab',
    hint: 'Drag a region across the screen',
    defaultStrength: 1,
    defaultFalloff: 'smooth',
  },
  pinch: {
    label: 'Pinch',
    hint: 'Pull toward the stroke',
    defaultStrength: 0.5,
    defaultFalloff: 'smooth',
  },
  flatten: {
    label: 'Flatten',
    hint: 'Level onto a plane',
    defaultStrength: 0.5,
    defaultFalloff: 'smooth',
  },
  crease: {
    label: 'Crease',
    hint: 'Cut a pinched groove',
    defaultStrength: 0.5,
    defaultFalloff: 'sharp',
  },
  inflate: {
    label: 'Inflate',
    hint: 'Push along each vertex normal',
    defaultStrength: 0.5,
    defaultFalloff: 'smooth',
  },
  scrape: {
    label: 'Scrape',
    hint: 'Shave down peaks',
    defaultStrength: 0.5,
    defaultFalloff: 'smooth',
  },
  knife: {
    label: 'Knife',
    hint: 'Cut a thin, sharp line',
    defaultStrength: 0.5,
    defaultFalloff: 'needle',
  },
  wax: {
    label: 'Wax',
    hint: 'Build up, filling hollows first',
    defaultStrength: 0.5,
    defaultFalloff: 'smooth',
  },
};

export const BRUSH_ORDER = Object.keys(BRUSHES) as BrushKind[];

/** Brushes applied as dabs along the stroke (everything except Grab). */
export type DabBrushKind = Exclude<BrushKind, 'grab'>;

/** One brush application at a surface point. */
export interface Dab {
  kind: DabBrushKind;
  x: number;
  y: number;
  z: number;
  /** World-space radius. */
  radius: number;
  /** Strength, already scaled by pressure. Negative inverts (not used by Smooth). */
  strength: number;
  falloff: FalloffKind;
  /** Also apply mirrored across x = 0. */
  symmetryX: boolean;
}

// Per-dab rates at full strength. Steps are fractions of the radius; rates
// are fractions of the distance to the brush's target.
const SCULPT_STEP = 0.04;
const INFLATE_STEP = 0.03;
const WAX_STEP = 0.04;
const FLATTEN_RATE = 0.3;
const PINCH_RATE = 0.12;
const CREASE_DEPTH = 0.16;
const CREASE_PINCH = 0.15;
const KNIFE_DEPTH = 0.15;
const KNIFE_PINCH = 0.3;

/**
 * Applies dabs (and Grab drags) to a mesh. Holds per-vertex scratch so a dab
 * allocates nothing once warmed up.
 *
 * Symmetry: the primary and mirrored dabs are merged into one pass. Each
 * vertex has a falloff weight from each side (w, wm). Brushes compute a
 * displacement per side at unit weight (D1 from the dab's frame, D2 from its
 * mirror image) and the vertex moves by
 *
 *   (w·D1 + wm·D2) / (w + wm) · max(w, wm)
 *
 * That is exactly symmetric on a symmetric mesh, and where the two dabs
 * overlap near the plane it never doubles the strength.
 */
export class BrushEngine {
  /** Vertices modified by the last dab or drag. */
  readonly touched = new IndexList(8192);

  private readonly seen: StampSet;
  private weight: Float32Array;
  private weightMirror: Float32Array;
  private readonly scratch = new FloatList(8192 * 3);
  private readonly candidates = new IndexList(8192);
  private readonly d1 = new Float64Array(3);
  private readonly d2 = new Float64Array(3);

  // Grab state: the picked-up vertices, their (w, wm) weights and start positions.
  private grabIndices = new Uint32Array(0);
  private grabWeights = new Float32Array(0);
  private grabOrigin = new Float32Array(0);

  constructor(vertexCount: number) {
    this.seen = new StampSet(vertexCount);
    this.weight = new Float32Array(vertexCount);
    this.weightMirror = new Float32Array(vertexCount);
  }

  applyDab(mesh: Mesh, grid: SpatialGrid, dab: Dab, recorder: StrokeRecorder | null): Uint32Array {
    const touched = this.gatherBoth(
      mesh,
      grid,
      dab.x,
      dab.y,
      dab.z,
      dab.radius,
      dab.symmetryX,
      dab.falloff,
    );
    if (touched.length === 0) return touched;
    recorder?.capture(mesh, touched);

    if (dab.kind === 'smooth') this.smooth(mesh, dab, touched);
    else this.displace(mesh, dab, touched);

    grid.updateFromMesh(mesh, touched);
    return touched;
  }

  // --- Grab ------------------------------------------------------------------

  /** Picks up the vertices under the brush. Returns false if there are none. */
  beginGrab(
    mesh: Mesh,
    grid: SpatialGrid,
    x: number,
    y: number,
    z: number,
    radius: number,
    symmetryX: boolean,
    falloff: FalloffKind,
    recorder: StrokeRecorder | null,
  ): boolean {
    const touched = this.gatherBoth(mesh, grid, x, y, z, radius, symmetryX, falloff);
    const n = touched.length;
    this.grabIndices = touched.slice();
    this.grabWeights = new Float32Array(n * 2);
    this.grabOrigin = new Float32Array(n * 3);
    const p = mesh.positions;
    for (let i = 0; i < n; i++) {
      const v = touched[i];
      this.grabWeights[i * 2] = this.weight[v];
      this.grabWeights[i * 2 + 1] = this.weightMirror[v];
      this.grabOrigin[i * 3] = p[v * 3];
      this.grabOrigin[i * 3 + 1] = p[v * 3 + 1];
      this.grabOrigin[i * 3 + 2] = p[v * 3 + 2];
    }
    recorder?.capture(mesh, this.grabIndices);
    return n > 0;
  }

  /**
   * Places the grabbed vertices at origin + weight · offset, where offset is
   * the total world-space drag since `beginGrab` (mirrored on the far side).
   */
  dragGrab(mesh: Mesh, grid: SpatialGrid, ox: number, oy: number, oz: number): Uint32Array {
    const idx = this.grabIndices;
    const W = this.grabWeights,
      O = this.grabOrigin;
    const p = mesh.positions;
    for (let i = 0; i < idx.length; i++) {
      const f = W[i * 2],
        fm = W[i * 2 + 1];
      const sum = f + fm;
      if (sum <= 0) continue;
      const k = Math.max(f, fm) / sum;
      const v = idx[i] * 3;
      // Primary side moves by (ox, oy, oz); the mirror side by (-ox, oy, oz).
      p[v] = O[i * 3] + (f - fm) * ox * k;
      p[v + 1] = O[i * 3 + 1] + sum * oy * k;
      p[v + 2] = O[i * 3 + 2] + sum * oz * k;
    }
    grid.updateFromMesh(mesh, idx);
    return idx;
  }

  // --- gathering -------------------------------------------------------------

  private gatherBoth(
    mesh: Mesh,
    grid: SpatialGrid,
    x: number,
    y: number,
    z: number,
    radius: number,
    symmetryX: boolean,
    falloff: FalloffKind,
  ): Uint32Array {
    this.touched.clear();
    this.seen.next();
    this.gather(mesh, grid, x, y, z, radius, falloff, this.weight, this.weightMirror);
    if (symmetryX) {
      this.gather(mesh, grid, -x, y, z, radius, falloff, this.weightMirror, this.weight);
    }
    return this.touched.view();
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
    falloff: FalloffKind,
    w: Float32Array,
    other: Float32Array,
  ): void {
    const curve = FALLOFFS[falloff].fn;
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
      const f = curve(Math.sqrt(dx * dx + dy * dy + dz * dz) * inv);
      if (this.seen.add(v)) {
        this.touched.push(v);
        w[v] = f;
        other[v] = 0;
      } else {
        w[v] = f;
      }
    }
  }

  // --- dab brushes -----------------------------------------------------------

  /** Every dab brush except Smooth: a per-side displacement, blended by weight. */
  private displace(mesh: Mesh, dab: Dab, touched: Uint32Array): void {
    const p = mesh.positions;
    const n = mesh.normals;
    const w = this.weight;
    const wm = this.weightMirror;

    // Area normal and center of the primary side. Mirror-side contributions
    // are reflected back, so a dab caught only by its mirror still has a frame.
    let ax = 0,
      ay = 0,
      az = 0,
      cx = 0,
      cy = 0,
      cz = 0,
      total = 0;
    for (let i = 0; i < touched.length; i++) {
      const v = touched[i];
      const o = v * 3;
      const f = w[v],
        fm = wm[v];
      ax += (f - fm) * n[o];
      ay += (f + fm) * n[o + 1];
      az += (f + fm) * n[o + 2];
      cx += (f - fm) * p[o];
      cy += (f + fm) * p[o + 1];
      cz += (f + fm) * p[o + 2];
      total += f + fm;
    }
    const alen = Math.hypot(ax, ay, az);
    if (alen < 1e-12 || total <= 0) return;
    ax /= alen;
    ay /= alen;
    az /= alen;
    cx /= total;
    cy /= total;
    cz /= total;

    const { kind, strength: s, radius: r } = dab;
    const d1 = this.d1,
      d2 = this.d2;

    for (let i = 0; i < touched.length; i++) {
      const v = touched[i];
      const f = w[v],
        fm = wm[v];
      const sum = f + fm;
      if (sum <= 0) continue;
      const o = v * 3;
      const px = p[o],
        py = p[o + 1],
        pz = p[o + 2];
      d1[0] = d1[1] = d1[2] = d2[0] = d2[1] = d2[2] = 0;
      // Primary frame, then its mirror image (x components negated).
      if (f > 0) {
        sideDisplacement(
          kind,
          s,
          r,
          px,
          py,
          pz,
          n,
          o,
          cx,
          cy,
          cz,
          ax,
          ay,
          az,
          dab.x,
          dab.y,
          dab.z,
          d1,
        );
      }
      if (fm > 0) {
        sideDisplacement(
          kind,
          s,
          r,
          px,
          py,
          pz,
          n,
          o,
          -cx,
          cy,
          cz,
          -ax,
          ay,
          az,
          -dab.x,
          dab.y,
          dab.z,
          d2,
        );
      }
      const k = Math.max(f, fm) / sum;
      p[o] = px + (f * d1[0] + fm * d2[0]) * k;
      p[o + 1] = py + (f * d1[1] + fm * d2[1]) * k;
      p[o + 2] = pz + (f * d1[2] + fm * d2[2]) * k;
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
      p[v * 3] += (targets[i * 3] - p[v * 3]) * t;
      p[v * 3 + 1] += (targets[i * 3 + 1] - p[v * 3 + 1]) * t;
      p[v * 3 + 2] += (targets[i * 3 + 2] - p[v * 3 + 2]) * t;
    }
  }
}

/**
 * Unit-weight displacement of one vertex for one side of a dab, written to
 * `out`. (cx, cy, cz) is the side's area center, (ax, ay, az) its unit area
 * normal, (hx, hy, hz) its hit point. `s` is signed strength, `r` the radius.
 */
function sideDisplacement(
  kind: DabBrushKind,
  s: number,
  r: number,
  px: number,
  py: number,
  pz: number,
  normals: Float32Array,
  o: number,
  cx: number,
  cy: number,
  cz: number,
  ax: number,
  ay: number,
  az: number,
  hx: number,
  hy: number,
  hz: number,
  out: Float64Array,
): void {
  switch (kind) {
    case 'sculpt': {
      const d = s * r * SCULPT_STEP;
      out[0] = ax * d;
      out[1] = ay * d;
      out[2] = az * d;
      return;
    }
    case 'inflate': {
      const d = s * r * INFLATE_STEP;
      out[0] = normals[o] * d;
      out[1] = normals[o + 1] * d;
      out[2] = normals[o + 2] * d;
      return;
    }
    case 'flatten':
    case 'scrape': {
      // Toward the plane through the area center. Scrape only lowers what is
      // above it (inverted: only fills what is below). Inverted Flatten
      // pushes away from the plane.
      const h = (px - cx) * ax + (py - cy) * ay + (pz - cz) * az;
      if (kind === 'scrape' && (s >= 0 ? h <= 0 : h >= 0)) return;
      const rate = Math.min(1, Math.abs(s) * FLATTEN_RATE);
      const k = -h * rate * (kind === 'flatten' ? Math.sign(s) : 1);
      out[0] = ax * k;
      out[1] = ay * k;
      out[2] = az * k;
      return;
    }
    case 'wax': {
      // Raise toward a plane one step above the hit point. Vertices already
      // above it don't move, so hollows fill first. Inverted carves down.
      const step = Math.abs(s) * r * WAX_STEP;
      const h = (px - hx) * ax + (py - hy) * ay + (pz - hz) * az;
      let d = 0;
      if (s >= 0 && h < step) d = Math.min(step, step - h);
      else if (s < 0 && h > -step) d = -Math.min(step, h + step);
      out[0] = ax * d;
      out[1] = ay * d;
      out[2] = az * d;
      return;
    }
    case 'pinch':
    case 'crease':
    case 'knife': {
      // Pull toward the dab center within the surface plane, plus (Crease,
      // Knife) a push into the surface. Inverted pushes material apart and
      // raises a ridge.
      const pinch = kind === 'pinch' ? PINCH_RATE : kind === 'crease' ? CREASE_PINCH : KNIFE_PINCH;
      const depth = kind === 'pinch' ? 0 : kind === 'crease' ? CREASE_DEPTH : KNIFE_DEPTH;
      let tx = cx - px,
        ty = cy - py,
        tz = cz - pz;
      const along = tx * ax + ty * ay + tz * az;
      tx -= ax * along;
      ty -= ay * along;
      tz -= az * along;
      const k = Math.max(-1, Math.min(1, s)) * pinch;
      const d = -s * r * depth;
      out[0] = tx * k + ax * d;
      out[1] = ty * k + ay * d;
      out[2] = tz * k + az * d;
      return;
    }
    case 'smooth':
      return;
  }
}
