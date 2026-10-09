import { buildEdgeTables, quadTopology } from '../subdivision';
import type { Armature } from './tree';

/**
 * Skinning: armature -> watertight, manifold, all-quad mesh. See
 * docs/armature.md ("Skinning").
 *
 * 1. Field: smooth union of round cones (one per link).
 * 2. Surface: manifold surface nets on a uniform grid.
 * 3. Relax along the surface, then project back onto it.
 * 4. With symmetry, the grid is centered on x = 0 so the result is exactly
 *    mirror-symmetric with an edge loop on the plane.
 */

export interface SkinOptions {
  /** Most cells along any axis. */
  maxCells: number;
  /** Fewest cells across the model's largest extent (keeps big blobs detailed). */
  minCells?: number;
  /** Joint softness: smooth-union width as a fraction of the thinner radius. */
  blend: number;
  symmetric: boolean;
  relaxIterations?: number;
}

export interface SkinResult {
  positions: Float32Array;
  quads: Uint32Array;
  cellSize: number;
  /** Nodes thinner than ~1.5 cells, which may skin poorly. */
  thinNodes: Int32Array;
  /** Extraction attempts used (more than 1 when it had to refine the grid). */
  attempts: number;
}

export class SkinError extends Error {}

const MAX_ATTEMPTS = 3;
const BLOCK = 8;

// --- field -------------------------------------------------------------------

/** Round cones with precomputed shape terms (Inigo Quilez, sdRoundCone). */
interface Field {
  count: number;
  /** Per primitive: ax ay az r1 bx by bz r2 */
  geom: Float64Array;
  /** Per primitive: l2, rr, a2, il2, k (blend width); l2 = 0 marks a plain sphere. */
  terms: Float64Array;
  kMax: number;
}

function buildField(tree: Armature, blend: number): Field {
  const s = tree.spheres;
  const n = tree.count;
  // One primitive per link; a lone root becomes a sphere.
  const count = n === 1 ? 1 : n - 1;
  const geom = new Float64Array(count * 8);
  const terms = new Float64Array(count * 5);
  let kMax = 0;
  for (let p = 0; p < count; p++) {
    const b = n === 1 ? 0 : p + 1;
    const a = n === 1 ? 0 : tree.parent[b];
    const r1 = s[a * 4 + 3],
      r2 = s[b * 4 + 3];
    const dx = s[b * 4] - s[a * 4],
      dy = s[b * 4 + 1] - s[a * 4 + 1],
      dz = s[b * 4 + 2] - s[a * 4 + 2];
    const l2 = dx * dx + dy * dy + dz * dz;
    const rr = r1 - r2;
    // When one sphere contains the other, the cone is just the bigger sphere,
    // stored as the first end.
    const sphere = n === 1 || l2 - rr * rr <= 1e-12;
    const big = sphere && r2 > r1 ? b : a;
    const small = big === a ? b : a;
    const [ax, ay, az] = [s[big * 4], s[big * 4 + 1], s[big * 4 + 2]];
    const [bx, by, bz] = [s[small * 4], s[small * 4 + 1], s[small * 4 + 2]];
    const ra = big === a ? r1 : r2;
    const rb = big === a ? r2 : r1;
    geom.set([ax, ay, az, ra, bx, by, bz, rb], p * 8);
    const k = blend * Math.min(r1, r2);
    kMax = Math.max(kMax, k);
    if (sphere) {
      terms.set([0, 0, 0, 0, k], p * 5);
    } else {
      terms.set([l2, rr, l2 - rr * rr, 1 / l2, k], p * 5);
    }
  }
  return { count, geom, terms, kMax };
}

function primDistance(f: Field, p: number, x: number, y: number, z: number): number {
  const g = f.geom,
    t = f.terms;
  const o = p * 8;
  const ax = g[o],
    ay = g[o + 1],
    az = g[o + 2],
    r1 = g[o + 3];
  const l2 = t[p * 5];
  const pax = x - ax,
    pay = y - ay,
    paz = z - az;
  if (l2 === 0) return Math.sqrt(pax * pax + pay * pay + paz * paz) - r1;
  const r2 = g[o + 7];
  const bax = g[o + 4] - ax,
    bay = g[o + 5] - ay,
    baz = g[o + 6] - az;
  const rr = t[p * 5 + 1],
    a2 = t[p * 5 + 2],
    il2 = t[p * 5 + 3];
  const yv = pax * bax + pay * bay + paz * baz;
  const zv = yv - l2;
  const qx = pax * l2 - bax * yv,
    qy = pay * l2 - bay * yv,
    qz = paz * l2 - baz * yv;
  const x2 = qx * qx + qy * qy + qz * qz;
  const y2 = yv * yv * l2;
  const z2 = zv * zv * l2;
  const k = Math.sign(rr) * rr * rr * x2;
  if (Math.sign(zv) * a2 * z2 > k) return Math.sqrt(x2 + z2) * il2 - r2;
  if (Math.sign(yv) * a2 * y2 < k) return Math.sqrt(x2 + y2) * il2 - r1;
  return (Math.sqrt(x2 * a2 * il2) + yv * rr) * il2 - r1;
}

/** Quadratic smooth minimum (width k); plain min when k <= 0. */
function smin(a: number, b: number, k: number): number {
  if (k <= 0) return a < b ? a : b;
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
}

/** The field at (x, y, z) using only primitives `prims` (or all). */
function fieldAt(f: Field, x: number, y: number, z: number, prims: Int32Array | null): number {
  const n = prims ? prims.length : f.count;
  let acc = Infinity;
  for (let i = 0; i < n; i++) {
    const p = prims ? prims[i] : i;
    const d = primDistance(f, p, x, y, z);
    acc = acc === Infinity ? d : smin(acc, d, f.terms[p * 5 + 4]);
  }
  return acc;
}

// --- surface nets component table ------------------------------------------------

// Corners: c = x | y << 1 | z << 2. Edges: 0-3 along x, 4-7 along y, 8-11 along z.
const EDGE_CORNERS = [
  [0, 1],
  [2, 3],
  [4, 5],
  [6, 7],
  [0, 2],
  [1, 3],
  [4, 6],
  [5, 7],
  [0, 4],
  [1, 5],
  [2, 6],
  [3, 7],
];
/** The four corners of each cube face, in cyclic order. */
const FACES = [
  [0, 2, 6, 4],
  [1, 3, 7, 5],
  [0, 1, 5, 4],
  [2, 3, 7, 6],
  [0, 1, 3, 2],
  [4, 5, 7, 6],
];
/** Edge index under the x-mirror (corner c -> c ^ 1). */
const MIRROR_EDGE = [0, 1, 2, 3, 5, 4, 7, 6, 9, 8, 11, 10];

function edgeOf(a: number, b: number): number {
  for (let e = 0; e < 12; e++) {
    const [p, q] = EDGE_CORNERS[e];
    if ((p === a && q === b) || (p === b && q === a)) return e;
  }
  return -1;
}

/**
 * For each of the 256 inside-corner masks: the component (surface patch) of
 * each crossing edge, or -1. On each face the contour joins crossing edges in
 * pairs; on an ambiguous face (two diagonal inside corners) each inside
 * corner is cut off on its own. A face's pairing depends only on that face,
 * so neighboring cells agree. Patches are the cycles of this pairing.
 */
export const EDGE_COMPONENT: Int8Array = (() => {
  const table = new Int8Array(256 * 12).fill(-1);
  for (let mask = 0; mask < 256; mask++) {
    const inside = (c: number) => (mask >> c) & 1;
    const crossing = (e: number) => inside(EDGE_CORNERS[e][0]) !== inside(EDGE_CORNERS[e][1]);
    const links: number[][] = Array.from({ length: 12 }, () => []);
    for (const face of FACES) {
      const fe = [0, 1, 2, 3].map((i) => edgeOf(face[i], face[(i + 1) % 4]));
      const cross = fe.filter(crossing);
      if (cross.length === 2) {
        links[cross[0]].push(cross[1]);
        links[cross[1]].push(cross[0]);
      } else if (cross.length === 4) {
        // Ambiguous: pair the two edges around each inside corner.
        for (let i = 0; i < 4; i++) {
          if (!inside(face[i])) continue;
          const a = fe[(i + 3) % 4],
            b = fe[i];
          links[a].push(b);
          links[b].push(a);
        }
      }
    }
    let comp = 0;
    for (let e = 0; e < 12; e++) {
      if (!crossing(e) || table[mask * 12 + e] >= 0) continue;
      const stack = [e];
      while (stack.length) {
        const x = stack.pop()!;
        if (table[mask * 12 + x] >= 0) continue;
        table[mask * 12 + x] = comp;
        for (const y of links[x]) if (table[mask * 12 + y] < 0) stack.push(y);
      }
      comp++;
    }
  }
  return table;
})();

// --- skinning ------------------------------------------------------------------

export function skinTree(tree: Armature, options: SkinOptions): SkinResult {
  const field = buildField(tree, options.blend);
  const s = tree.spheres;
  let rMin = Infinity;
  let x0 = Infinity,
    y0 = Infinity,
    z0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity,
    z1 = -Infinity;
  for (let i = 0; i < tree.count; i++) {
    const r = s[i * 4 + 3];
    rMin = Math.min(rMin, r);
    x0 = Math.min(x0, s[i * 4] - r);
    y0 = Math.min(y0, s[i * 4 + 1] - r);
    z0 = Math.min(z0, s[i * 4 + 2] - r);
    x1 = Math.max(x1, s[i * 4] + r);
    y1 = Math.max(y1, s[i * 4 + 1] + r);
    z1 = Math.max(z1, s[i * 4 + 2] + r);
  }
  const extent = Math.max(x1 - x0, y1 - y0, z1 - z0);
  const minCells = options.minCells ?? 48;
  let h = Math.max(extent / options.maxCells, Math.min(0.35 * rMin, extent / minCells));

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const result = extract(field, options, h, [x0, y0, z0, x1, y1, z1]);
    if (result) {
      const thin: number[] = [];
      for (let i = 0; i < tree.count; i++) if (s[i * 4 + 3] < 1.5 * h) thin.push(i);
      return { ...result, cellSize: h, thinNodes: Int32Array.from(thin), attempts: attempt };
    }
    h *= 0.85;
  }
  throw new SkinError(
    'Some parts are too close together to skin cleanly. Move them apart a little.',
  );
}

/** One extraction at cell size h. Returns null if the mesh came out non-manifold. */
function extract(
  field: Field,
  options: SkinOptions,
  h: number,
  bounds: number[],
): { positions: Float32Array; quads: Uint32Array } | null {
  const symmetric = options.symmetric;
  const margin = field.kMax + 2 * h;
  let [x0, y0, z0, x1, y1, z1] = bounds;
  x0 -= margin;
  y0 -= margin;
  z0 -= margin;
  x1 += margin;
  y1 += margin;
  z1 += margin;
  if (symmetric) {
    const xm = Math.max(-x0, x1);
    x0 = -xm;
    x1 = xm;
  }
  let nx = Math.ceil((x1 - x0) / h);
  // Symmetric grids have an odd cell count, centered so x = 0 runs through cell centers.
  if (symmetric && nx % 2 === 0) nx++;
  const ny = Math.ceil((y1 - y0) / h);
  const nz = Math.ceil((z1 - z0) / h);
  if (symmetric) x0 = -(nx * h) / 2;
  const cx = nx + 1,
    cy = ny + 1;
  const corner = (i: number, j: number, k: number) => (k * cy + j) * cx + i;
  const values = new Float32Array(cx * cy * (nz + 1));

  // Field values, block by block: blocks the surface can't reach get a
  // sign-correct bound; the rest get exact values from nearby primitives.
  const bx = Math.ceil(nx / BLOCK),
    by = Math.ceil(ny / BLOCK),
    bz = Math.ceil(nz / BLOCK);
  const halfDiag = (Math.sqrt(3) * BLOCK * h) / 2;
  const active: { i0: number; j0: number; k0: number; prims: Int32Array }[] = [];
  const blockPrims = new Map<number, Int32Array>();
  const dist = new Float64Array(field.count);
  for (let kb = 0; kb < bz; kb++) {
    for (let jb = 0; jb < by; jb++) {
      for (let ib = 0; ib < bx; ib++) {
        const i0 = ib * BLOCK,
          j0 = jb * BLOCK,
          k0 = kb * BLOCK;
        const i1 = Math.min(i0 + BLOCK, nx),
          j1 = Math.min(j0 + BLOCK, ny),
          k1 = Math.min(k0 + BLOCK, nz);
        const px = x0 + ((i0 + i1) / 2) * h,
          py = y0 + ((j0 + j1) / 2) * h,
          pz = z0 + ((k0 + k1) / 2) * h;
        let dmin = Infinity;
        for (let p = 0; p < field.count; p++) {
          dist[p] = primDistance(field, p, px, py, pz);
          dmin = Math.min(dmin, dist[p]);
        }
        const fc = fieldAt(field, px, py, pz, null);
        if (Math.abs(fc) > halfDiag) {
          const fill = Math.sign(fc) * (Math.abs(fc) - halfDiag);
          for (let k = k0; k <= k1; k++)
            for (let j = j0; j <= j1; j++)
              for (let i = i0; i <= i1; i++) values[corner(i, j, k)] = fill;
        } else {
          const near: number[] = [];
          const reach = dmin + 2 * halfDiag + field.kMax;
          for (let p = 0; p < field.count; p++) if (dist[p] <= reach) near.push(p);
          const prims = Int32Array.from(near);
          active.push({ i0, j0, k0, prims });
          blockPrims.set((kb * by + jb) * bx + ib, prims);
        }
      }
    }
  }
  for (const b of active) {
    const i1 = Math.min(b.i0 + BLOCK, nx),
      j1 = Math.min(b.j0 + BLOCK, ny),
      k1 = Math.min(b.k0 + BLOCK, nz);
    for (let k = b.k0; k <= k1; k++)
      for (let j = b.j0; j <= j1; j++)
        for (let i = b.i0; i <= i1; i++) {
          values[corner(i, j, k)] = fieldAt(field, x0 + i * h, y0 + j * h, z0 + k * h, b.prims);
        }
  }
  if (symmetric) {
    // Copy the x < 0 half onto the x > 0 half, so signs and values are exact mirrors.
    for (let k = 0; k <= nz; k++)
      for (let j = 0; j <= ny; j++)
        for (let i = 0; i < cx / 2; i++) values[corner(nx - i, j, k)] = values[corner(i, j, k)];
  }

  // Vertices: one per (cell, patch).
  const cellCount = nx * ny * nz;
  const cellIndex = (i: number, j: number, k: number) => (k * ny + j) * nx + i;
  const cellFirst = new Int32Array(cellCount).fill(-1);
  const cellMask = new Uint8Array(cellCount);
  const pos: number[] = [];
  const vertCell: number[] = [];
  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        let mask = 0;
        for (let c = 0; c < 8; c++) {
          if (values[corner(i + (c & 1), j + ((c >> 1) & 1), k + ((c >> 2) & 1))] < 0)
            mask |= 1 << c;
        }
        if (mask === 0 || mask === 255) continue;
        const ci = cellIndex(i, j, k);
        cellMask[ci] = mask;
        let comps = 0;
        for (let e = 0; e < 12; e++) comps = Math.max(comps, EDGE_COMPONENT[mask * 12 + e] + 1);
        cellFirst[ci] = vertCell.length;
        const sums = new Float64Array(comps * 4);
        for (let e = 0; e < 12; e++) {
          const comp = EDGE_COMPONENT[mask * 12 + e];
          if (comp < 0) continue;
          const [ca, cb] = EDGE_CORNERS[e];
          const ia = i + (ca & 1),
            ja = j + ((ca >> 1) & 1),
            ka = k + ((ca >> 2) & 1);
          const ib = i + (cb & 1),
            jb = j + ((cb >> 1) & 1),
            kb = k + ((cb >> 2) & 1);
          const fa = values[corner(ia, ja, ka)],
            fb = values[corner(ib, jb, kb)];
          const t = fa / (fa - fb);
          sums[comp * 4] += x0 + (ia + (ib - ia) * t) * h;
          sums[comp * 4 + 1] += y0 + (ja + (jb - ja) * t) * h;
          sums[comp * 4 + 2] += z0 + (ka + (kb - ka) * t) * h;
          sums[comp * 4 + 3]++;
        }
        for (let c = 0; c < comps; c++) {
          const w = sums[c * 4 + 3];
          pos.push(sums[c * 4] / w, sums[c * 4 + 1] / w, sums[c * 4 + 2] / w);
          vertCell.push(ci);
        }
      }
    }
  }
  const vertexOf = (ci: number, localEdge: number) =>
    cellFirst[ci] + EDGE_COMPONENT[cellMask[ci] * 12 + localEdge];

  // Quads: one per crossing grid edge, from the patches of its four cells.
  const quads: number[] = [];
  const emit = (a: number, b: number, c: number, d: number, flip: boolean) => {
    if (flip) quads.push(a, d, c, b);
    else quads.push(a, b, c, d);
  };
  for (let k = 0; k <= nz; k++) {
    for (let j = 0; j <= ny; j++) {
      for (let i = 0; i <= nx; i++) {
        const f0 = values[corner(i, j, k)];
        // +x edge: cells around it in (y, z); local edge index ly + 2 lz.
        if (i < nx && j > 0 && j < ny && k > 0 && k < nz) {
          const f1 = values[corner(i + 1, j, k)];
          if (f0 < 0 !== f1 < 0) {
            emit(
              vertexOf(cellIndex(i, j - 1, k - 1), 3),
              vertexOf(cellIndex(i, j, k - 1), 2),
              vertexOf(cellIndex(i, j, k), 0),
              vertexOf(cellIndex(i, j - 1, k), 1),
              f0 > 0,
            );
          }
        }
        // +y edge: cells around it in (z, x); local edge index 4 + lx + 2 lz.
        if (j < ny && i > 0 && i < nx && k > 0 && k < nz) {
          const f1 = values[corner(i, j + 1, k)];
          if (f0 < 0 !== f1 < 0) {
            emit(
              vertexOf(cellIndex(i - 1, j, k - 1), 7),
              vertexOf(cellIndex(i - 1, j, k), 5),
              vertexOf(cellIndex(i, j, k), 4),
              vertexOf(cellIndex(i, j, k - 1), 6),
              f0 > 0,
            );
          }
        }
        // +z edge: cells around it in (x, y); local edge index 8 + lx + 2 ly.
        if (k < nz && i > 0 && i < nx && j > 0 && j < ny) {
          const f1 = values[corner(i, j, k + 1)];
          if (f0 < 0 !== f1 < 0) {
            emit(
              vertexOf(cellIndex(i - 1, j - 1, k), 11),
              vertexOf(cellIndex(i, j - 1, k), 10),
              vertexOf(cellIndex(i, j, k), 8),
              vertexOf(cellIndex(i - 1, j, k), 9),
              f0 > 0,
            );
          }
        }
      }
    }
  }

  const V = vertCell.length;
  const quadArr = Uint32Array.from(quads);
  if (!isClosedManifold(quadArr, V)) return null;

  // Mirror partners: same patch, mirrored cell and edge.
  let partner: Int32Array | null = null;
  if (symmetric) {
    partner = new Int32Array(V);
    for (let v = 0; v < V; v++) {
      const ci = vertCell[v];
      const mask = cellMask[ci];
      const comp = v - cellFirst[ci];
      let e = 0;
      while (EDGE_COMPONENT[mask * 12 + e] !== comp) e++;
      const i = ci % nx,
        jk = Math.floor(ci / nx);
      partner[v] = vertexOf(jk * nx + (nx - 1 - i), MIRROR_EDGE[e]);
    }
  }

  const positions = Float64Array.from(pos);
  if (partner) symmetrize(positions, partner);
  relaxAndProject(
    positions,
    quadArr,
    field,
    blockPrims,
    { x0, y0, z0, h, bx, by, bz },
    options.relaxIterations ?? 5,
    partner,
  );
  return { positions: Float32Array.from(positions), quads: quadArr };
}

/** True when every edge is shared by exactly two quads. */
function isClosedManifold(quads: Uint32Array, vertexCount: number): boolean {
  if (quads.length === 0) return false;
  try {
    const et = buildEdgeTables(quadTopology(quads, vertexCount));
    for (let e = 0; e < et.edgeCount; e++) if (et.edgeFaces[e * 2 + 1] < 0) return false;
    return true;
  } catch {
    return false;
  }
}

/** Makes partner pairs exact mirrors (averaging), and plane vertices x = 0. */
function symmetrize(p: Float64Array, partner: Int32Array): void {
  for (let v = 0; v < partner.length; v++) {
    const m = partner[v];
    if (m === v) {
      p[v * 3] = 0;
    } else if (v < m) {
      const x = (p[v * 3] - p[m * 3]) / 2,
        y = (p[v * 3 + 1] + p[m * 3 + 1]) / 2,
        z = (p[v * 3 + 2] + p[m * 3 + 2]) / 2;
      p[v * 3] = x;
      p[v * 3 + 1] = y;
      p[v * 3 + 2] = z;
      p[m * 3] = -x;
      p[m * 3 + 1] = y;
      p[m * 3 + 2] = z;
    }
  }
}

interface GridInfo {
  x0: number;
  y0: number;
  z0: number;
  h: number;
  bx: number;
  by: number;
  bz: number;
}

/**
 * Tangential Laplacian relaxation (even quad sizes without losing volume),
 * each round followed by a Newton step back onto the zero surface.
 */
function relaxAndProject(
  p: Float64Array,
  quads: Uint32Array,
  field: Field,
  blockPrims: Map<number, Int32Array>,
  g: GridInfo,
  iterations: number,
  partner: Int32Array | null,
): void {
  const V = p.length / 3;
  // Quad-edge adjacency (no diagonals).
  const deg = new Int32Array(V + 1);
  for (let q = 0; q < quads.length; q += 4) for (let c = 0; c < 4; c++) deg[quads[q + c] + 1] += 2;
  for (let v = 0; v < V; v++) deg[v + 1] += deg[v];
  const nbr = new Int32Array(deg[V]);
  const fill = deg.slice(0, V);
  for (let q = 0; q < quads.length; q += 4) {
    for (let c = 0; c < 4; c++) {
      const a = quads[q + c],
        b = quads[q + ((c + 1) % 4)];
      nbr[fill[a]++] = b;
      nbr[fill[b]++] = a;
    }
  }

  const primsNear = (x: number, y: number, z: number): Int32Array | null => {
    const ib = Math.min(g.bx - 1, Math.max(0, Math.floor((x - g.x0) / (g.h * BLOCK))));
    const jb = Math.min(g.by - 1, Math.max(0, Math.floor((y - g.y0) / (g.h * BLOCK))));
    const kb = Math.min(g.bz - 1, Math.max(0, Math.floor((z - g.z0) / (g.h * BLOCK))));
    return blockPrims.get((kb * g.by + jb) * g.bx + ib) ?? null;
  };
  const eps = g.h * 0.25;
  const grad = new Float64Array(4);
  const sample = (x: number, y: number, z: number) => {
    const prims = primsNear(x, y, z);
    const f = fieldAt(field, x, y, z, prims);
    grad[0] =
      (fieldAt(field, x + eps, y, z, prims) - fieldAt(field, x - eps, y, z, prims)) / (2 * eps);
    grad[1] =
      (fieldAt(field, x, y + eps, z, prims) - fieldAt(field, x, y - eps, z, prims)) / (2 * eps);
    grad[2] =
      (fieldAt(field, x, y, z + eps, prims) - fieldAt(field, x, y, z - eps, prims)) / (2 * eps);
    grad[3] = f;
  };

  const next = new Float64Array(p.length);
  for (let it = 0; it <= iterations; it++) {
    const relax = it < iterations;
    for (let v = 0; v < V; v++) {
      let x = p[v * 3],
        y = p[v * 3 + 1],
        z = p[v * 3 + 2];
      sample(x, y, z);
      const gl2 = grad[0] * grad[0] + grad[1] * grad[1] + grad[2] * grad[2] || 1;
      if (relax) {
        let ax = 0,
          ay = 0,
          az = 0;
        const n0 = deg[v],
          n1 = deg[v + 1];
        for (let k = n0; k < n1; k++) {
          const u = nbr[k];
          ax += p[u * 3];
          ay += p[u * 3 + 1];
          az += p[u * 3 + 2];
        }
        const inv = 1 / (n1 - n0);
        let dx = ax * inv - x,
          dy = ay * inv - y,
          dz = az * inv - z;
        const along = (dx * grad[0] + dy * grad[1] + dz * grad[2]) / gl2;
        dx -= grad[0] * along;
        dy -= grad[1] * along;
        dz -= grad[2] * along;
        x += dx * 0.5;
        y += dy * 0.5;
        z += dz * 0.5;
        sample(x, y, z);
      }
      // Newton step onto f = 0.
      const gl = grad[0] * grad[0] + grad[1] * grad[1] + grad[2] * grad[2] || 1;
      const step = grad[3] / gl;
      next[v * 3] = x - grad[0] * step;
      next[v * 3 + 1] = y - grad[1] * step;
      next[v * 3 + 2] = z - grad[2] * step;
    }
    p.set(next);
    if (partner) symmetrize(p, partner);
  }
}

/** Signed distance from p to the round cone joining spheres (a, r1) and (b, r2). */
export function roundConeDistance(
  px: number,
  py: number,
  pz: number,
  ax: number,
  ay: number,
  az: number,
  r1: number,
  bx: number,
  by: number,
  bz: number,
  r2: number,
): number {
  const tree = {
    count: 2,
    spheres: new Float32Array([ax, ay, az, r1, bx, by, bz, r2]),
    parent: new Int32Array([-1, 0]),
    mirror: new Int32Array([-1, -1]),
  };
  return primDistance(buildField(tree, 0), 0, px, py, pz);
}
