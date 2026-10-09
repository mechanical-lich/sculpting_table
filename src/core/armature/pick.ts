import { roundConeDistance } from './skin';
import type { Armature } from './tree';

/** Links are drawn (and picked) at this fraction of their end radii. */
export const LINK_SCALE = 0.35;

export interface TreeHit {
  kind: 'sphere' | 'link';
  /** The sphere's node, or for a link its child node. */
  node: number;
  /** Ray parameter (distance along the unit ray). */
  t: number;
  x: number;
  y: number;
  z: number;
  /** Surface normal at the hit (spheres; approximate for links). */
  nx: number;
  ny: number;
  nz: number;
  /** Links: position along the link, 0 at the parent. */
  s: number;
}

/** Nearest sphere or link hit by the ray (unit direction), or null. */
export function pickTree(
  tree: Armature,
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
): TreeHit | null {
  const s = tree.spheres;
  let best: TreeHit | null = null;

  for (let i = 0; i < tree.count; i++) {
    const cx = s[i * 4],
      cy = s[i * 4 + 1],
      cz = s[i * 4 + 2],
      r = s[i * 4 + 3];
    const lx = ox - cx,
      ly = oy - cy,
      lz = oz - cz;
    const b = lx * dx + ly * dy + lz * dz;
    const c = lx * lx + ly * ly + lz * lz - r * r;
    const disc = b * b - c;
    if (disc < 0) continue;
    const sq = Math.sqrt(disc);
    const t = -b - sq >= 0 ? -b - sq : -b + sq;
    if (t < 0 || (best && t >= best.t)) continue;
    const x = ox + dx * t,
      y = oy + dy * t,
      z = oz + dz * t;
    best = {
      kind: 'sphere',
      node: i,
      t,
      x,
      y,
      z,
      nx: (x - cx) / r,
      ny: (y - cy) / r,
      nz: (z - cz) / r,
      s: 0,
    };
  }

  for (let i = 1; i < tree.count; i++) {
    const p = tree.parent[i];
    const ax = s[p * 4],
      ay = s[p * 4 + 1],
      az = s[p * 4 + 2],
      r1 = s[p * 4 + 3] * LINK_SCALE;
    const bx = s[i * 4],
      by = s[i * 4 + 1],
      bz = s[i * 4 + 2],
      r2 = s[i * 4 + 3] * LINK_SCALE;
    // Bounding sphere of the link, to skip most rays cheaply.
    const mx = (ax + bx) / 2,
      my = (ay + by) / 2,
      mz = (az + bz) / 2;
    const br = Math.hypot(bx - ax, by - ay, bz - az) / 2 + Math.max(r1, r2);
    const lx = ox - mx,
      ly = oy - my,
      lz = oz - mz;
    const b = lx * dx + ly * dy + lz * dz;
    const disc = b * b - (lx * lx + ly * ly + lz * lz - br * br);
    if (disc < 0) continue;
    let t = Math.max(0, -b - Math.sqrt(disc));
    const tEnd = -b + Math.sqrt(disc);
    // Sphere tracing.
    for (let step = 0; step < 64 && t <= tEnd; step++) {
      const x = ox + dx * t,
        y = oy + dy * t,
        z = oz + dz * t;
      const d = roundConeDistance(x, y, z, ax, ay, az, r1, bx, by, bz, r2);
      if (d < 1e-4 * br) {
        if (best && t >= best.t) break;
        const ex = bx - ax,
          ey = by - ay,
          ez = bz - az;
        const along = Math.min(
          1,
          Math.max(
            0,
            ((x - ax) * ex + (y - ay) * ey + (z - az) * ez) / (ex * ex + ey * ey + ez * ez || 1),
          ),
        );
        const qx = ax + ex * along,
          qy = ay + ey * along,
          qz = az + ez * along;
        const nl = Math.hypot(x - qx, y - qy, z - qz) || 1;
        best = {
          kind: 'link',
          node: i,
          t,
          x,
          y,
          z,
          nx: (x - qx) / nl,
          ny: (y - qy) / nl,
          nz: (z - qz) / nl,
          s: along,
        };
        break;
      }
      t += d;
    }
  }
  return best;
}
