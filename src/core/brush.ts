import { FALLOFFS, type FalloffKind } from './falloff';
import { FloatList, IndexList, StampSet } from './lists';
import { sampleStamp, type Stamp } from './stamp';
import { stencilAt, type DabStencil } from './stencil';
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
  | 'wax'
  | 'mask';

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
  mask: {
    label: 'Mask',
    hint: 'Freeze areas so other brushes leave them alone',
    defaultStrength: 1,
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
  /** Optional stamp modulating strength across the brush. */
  stamp?: DabStamp | null;
  /** Optional screen-space stencil masking strength. */
  stencil?: DabStencil | null;
  /** Mask brush only: smooth the mask's edges instead of painting it. */
  smoothMask?: boolean;
  /** Also apply mirrored across x = 0. */
  symmetryX: boolean;
}

/** How a stamp sits on one dab. */
export interface DabStamp {
  stamp: Stamp;
  /**
   * World direction for the stamp's +u axis (e.g. the stroke direction, or
   * screen right). It is projected into the surface plane under the brush.
   */
  dirX: number;
  dirY: number;
  dirZ: number;
  /** Extra rotation about the surface normal, in radians. */
  angle: number;
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
    recorder?.capture(touched);
    if (dab.stamp) this.applyStamp(mesh, dab, dab.stamp, touched);
    if (dab.stencil) this.applyStencil(mesh, dab.stencil, touched);
    if (dab.kind === 'mask') {
      this.paintMask(mesh, dab, touched);
      return touched;
    }
    this.applyMask(mesh, touched);

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
    this.applyMask(mesh, touched);
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
    recorder?.capture(this.grabIndices);
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

  // --- stamps ----------------------------------------------------------------

  /**
   * Multiplies each vertex's falloff weights by the stamp, mapped onto the
   * plane under the brush: u along the projected stamp direction, v along
   * normal × u, both scaled so the radius spans [-1, 1]. The mirror side uses
   * the mirrored frame and hit point, so a vertex and its mirror image sample
   * the same stamp value.
   */
  private applyStamp(mesh: Mesh, dab: Dab, st: DabStamp, touched: Uint32Array): void {
    const p = mesh.positions;
    const n = mesh.normals;
    const w = this.weight;
    const wm = this.weightMirror;

    let nx = 0,
      ny = 0,
      nz = 0;
    for (let i = 0; i < touched.length; i++) {
      const v = touched[i];
      const f = w[v],
        fm = wm[v];
      nx += (f - fm) * n[v * 3];
      ny += (f + fm) * n[v * 3 + 1];
      nz += (f + fm) * n[v * 3 + 2];
    }
    const nl = Math.hypot(nx, ny, nz);
    if (nl < 1e-12) return;
    nx /= nl;
    ny /= nl;
    nz /= nl;

    // u axis: stamp direction projected into the tangent plane, then rotated.
    let tx = st.dirX,
      ty = st.dirY,
      tz = st.dirZ;
    const along = tx * nx + ty * ny + tz * nz;
    tx -= nx * along;
    ty -= ny * along;
    tz -= nz * along;
    let tl = Math.hypot(tx, ty, tz);
    if (tl < 1e-9) {
      // Direction along the normal: any tangent will do.
      tx = Math.abs(nx) < 0.9 ? 0 : -nz;
      ty = Math.abs(nx) < 0.9 ? -nz : 0;
      tz = Math.abs(nx) < 0.9 ? ny : nx;
      tl = Math.hypot(tx, ty, tz);
    }
    tx /= tl;
    ty /= tl;
    tz /= tl;
    // b = n × t; then rotate (t, b) by the angle.
    const bx0 = ny * tz - nz * ty,
      by0 = nz * tx - nx * tz,
      bz0 = nx * ty - ny * tx;
    const c = Math.cos(st.angle),
      sn = Math.sin(st.angle);
    const ux = tx * c + bx0 * sn,
      uy = ty * c + by0 * sn,
      uz = tz * c + bz0 * sn;
    const vx = bx0 * c - tx * sn,
      vy = by0 * c - ty * sn,
      vz = bz0 * c - tz * sn;

    const inv = 1 / dab.radius;
    const hx = dab.x,
      hy = dab.y,
      hz = dab.z;
    for (let i = 0; i < touched.length; i++) {
      const v = touched[i];
      const o = v * 3;
      if (w[v] > 0) {
        const dx = p[o] - hx,
          dy = p[o + 1] - hy,
          dz = p[o + 2] - hz;
        w[v] *= sampleStamp(
          st.stamp,
          (dx * ux + dy * uy + dz * uz) * inv,
          (dx * vx + dy * vy + dz * vz) * inv,
        );
      }
      if (wm[v] > 0) {
        // Mirror frame: hit (-hx, hy, hz), axes with x negated.
        const dx = p[o] + hx,
          dy = p[o + 1] - hy,
          dz = p[o + 2] - hz;
        wm[v] *= sampleStamp(
          st.stamp,
          (-dx * ux + dy * uy + dz * uz) * inv,
          (-dx * vx + dy * vy + dz * vz) * inv,
        );
      }
    }
  }

  /**
   * Multiplies weights by the stencil at each vertex's screen position. The
   * mirror-side weight of v uses the stencil at mirror(v), so the pattern
   * pressed on one side is reproduced exactly on the other.
   */
  private applyStencil(mesh: Mesh, st: DabStencil, touched: Uint32Array): void {
    const p = mesh.positions;
    const w = this.weight;
    const wm = this.weightMirror;
    for (let i = 0; i < touched.length; i++) {
      const v = touched[i];
      const o = v * 3;
      if (w[v] > 0) w[v] *= stencilAt(st, p[o], p[o + 1], p[o + 2]);
      if (wm[v] > 0) wm[v] *= stencilAt(st, -p[o], p[o + 1], p[o + 2]);
    }
  }

  // --- masking ---------------------------------------------------------------

  /** Scales both side weights by how unmasked each vertex is. */
  private applyMask(mesh: Mesh, touched: Uint32Array): void {
    const m = mesh.mask;
    const w = this.weight;
    const wm = this.weightMirror;
    for (let i = 0; i < touched.length; i++) {
      const v = touched[i];
      const free = 1 - m[v];
      if (free < 1) {
        w[v] *= free;
        wm[v] *= free;
      }
    }
  }

  /**
   * The Mask brush: adds (or, with negative strength, removes) mask under
   * the brush, or smooths it toward the neighbor average.
   */
  private paintMask(mesh: Mesh, dab: Dab, touched: Uint32Array): void {
    const m = mesh.mask;
    const w = this.weight;
    const wm = this.weightMirror;
    if (dab.smoothMask) {
      const { neighborOffsets, neighbors } = mesh.adjacency;
      const strength = Math.min(1, Math.abs(dab.strength));
      // Jacobi: all targets from the mask before this dab.
      this.scratch.clear();
      for (let i = 0; i < touched.length; i++) {
        const v = touched[i];
        const s0 = neighborOffsets[v],
          s1 = neighborOffsets[v + 1];
        let sum = 0;
        for (let k = s0; k < s1; k++) sum += m[neighbors[k]];
        this.scratch.push(s1 > s0 ? sum / (s1 - s0) : m[v]);
      }
      const targets = this.scratch.data;
      for (let i = 0; i < touched.length; i++) {
        const v = touched[i];
        m[v] += (targets[i] - m[v]) * Math.max(w[v], wm[v]) * strength;
      }
      return;
    }
    for (let i = 0; i < touched.length; i++) {
      const v = touched[i];
      const next = m[v] + dab.strength * Math.max(w[v], wm[v]);
      m[v] = next < 0 ? 0 : next > 1 ? 1 : next;
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
    case 'mask':
      return;
  }
}
