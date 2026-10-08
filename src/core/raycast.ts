import { StampSet } from './lists';
import type { Mesh } from './mesh';
import type { SpatialGrid } from './spatialGrid';

export interface RayHit {
  t: number;
  triangle: number;
  x: number;
  y: number;
  z: number;
  /** Interpolated, unit-length vertex normal at the hit. */
  nx: number;
  ny: number;
  nz: number;
}

/** Reusable triangle visited-set for `raycastMesh`. */
export class RaycastScratch {
  readonly tris = new StampSet(0);
}

const EPS = 1e-9;

/**
 * Nearest ray/mesh intersection, using the vertex grid. Walks the cells along
 * the ray (3D DDA) and tests triangles incident to vertices in each cell's
 * neighborhood: 3x3x3 normally, wider if edges have stretched (see
 * `SpatialGrid.raycastNeighborhood`).
 *
 * The direction need not be normalized; `t` is in units of its length.
 */
export function raycastMesh(
  mesh: Mesh,
  grid: SpatialGrid,
  scratch: RaycastScratch,
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
): RayHit | null {
  // Clip the ray to the vertex bounds (the surface lies within them), padded a cell.
  const size = grid.cellSize;
  const minX = grid.minX - size,
    minY = grid.minY - size,
    minZ = grid.minZ - size;
  const maxX = grid.maxX + size,
    maxY = grid.maxY + size,
    maxZ = grid.maxZ + size;
  let t0 = 0,
    t1 = Infinity;
  const slab = (o: number, d: number, lo: number, hi: number): boolean => {
    if (Math.abs(d) < EPS) return o >= lo && o <= hi;
    let a = (lo - o) / d,
      b = (hi - o) / d;
    if (a > b) [a, b] = [b, a];
    if (a > t0) t0 = a;
    if (b < t1) t1 = b;
    return t0 <= t1;
  };
  if (!slab(ox, dx, minX, maxX) || !slab(oy, dy, minY, maxY) || !slab(oz, dz, minZ, maxZ)) {
    return null;
  }

  scratch.tris.resize(mesh.triangleCount);
  scratch.tris.next();
  grid.visited.next();

  // DDA setup at the entry point.
  const tEntry = t0;
  let ix = grid.cell(ox + dx * tEntry),
    iy = grid.cell(oy + dy * tEntry),
    iz = grid.cell(oz + dz * tEntry);
  const stepX = dx > 0 ? 1 : -1,
    stepY = dy > 0 ? 1 : -1,
    stepZ = dz > 0 ? 1 : -1;
  const next = (i: number, step: number, o: number, d: number): number => {
    if (Math.abs(d) < EPS) return Infinity;
    return ((step > 0 ? i + 1 : i) * size - o) / d;
  };
  let tMaxX = next(ix, stepX, ox, dx),
    tMaxY = next(iy, stepY, oy, dy),
    tMaxZ = next(iz, stepZ, oz, dz);
  const tDeltaX = Math.abs(dx) < EPS ? Infinity : size / Math.abs(dx),
    tDeltaY = Math.abs(dy) < EPS ? Infinity : size / Math.abs(dy),
    tDeltaZ = Math.abs(dz) < EPS ? Infinity : size / Math.abs(dz);

  const p = mesh.positions;
  const idx = mesh.indices;
  const { triOffsets, tris } = mesh.adjacency;
  const k = grid.raycastNeighborhood();

  let bestT = Infinity;
  let bestTri = -1;
  let bestU = 0,
    bestV = 0;

  for (;;) {
    for (let z = iz - k; z <= iz + k; z++) {
      for (let y = iy - k; y <= iy + k; y++) {
        for (let x = ix - k; x <= ix + k; x++) {
          const bucket = grid.bucket(x, y, z);
          if (!grid.visited.add(bucket)) continue;
          for (let v = grid.first(bucket); v >= 0; v = grid.after(v)) {
            for (let m = triOffsets[v]; m < triOffsets[v + 1]; m++) {
              const tri = tris[m];
              if (!scratch.tris.add(tri)) continue;

              // Moller-Trumbore, two-sided.
              const a = idx[tri * 3] * 3,
                b = idx[tri * 3 + 1] * 3,
                cc = idx[tri * 3 + 2] * 3;
              const e1x = p[b] - p[a],
                e1y = p[b + 1] - p[a + 1],
                e1z = p[b + 2] - p[a + 2];
              const e2x = p[cc] - p[a],
                e2y = p[cc + 1] - p[a + 1],
                e2z = p[cc + 2] - p[a + 2];
              const px = dy * e2z - dz * e2y,
                py = dz * e2x - dx * e2z,
                pz = dx * e2y - dy * e2x;
              const det = e1x * px + e1y * py + e1z * pz;
              if (Math.abs(det) < 1e-20) continue;
              const inv = 1 / det;
              const sx = ox - p[a],
                sy = oy - p[a + 1],
                sz = oz - p[a + 2];
              const u = (sx * px + sy * py + sz * pz) * inv;
              if (u < 0 || u > 1) continue;
              const qx = sy * e1z - sz * e1y,
                qy = sz * e1x - sx * e1z,
                qz = sx * e1y - sy * e1x;
              const w = (dx * qx + dy * qy + dz * qz) * inv;
              if (w < 0 || u + w > 1) continue;
              const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
              if (t > 0 && t < bestT) {
                bestT = t;
                bestTri = tri;
                bestU = u;
                bestV = w;
              }
            }
          }
        }
      }
    }

    // Any hit before this cell's exit has been seen; stop.
    const tExit = Math.min(tMaxX, tMaxY, tMaxZ);
    if (bestT <= tExit || tExit > t1) break;

    if (tMaxX <= tMaxY && tMaxX <= tMaxZ) {
      ix += stepX;
      tMaxX += tDeltaX;
    } else if (tMaxY <= tMaxZ) {
      iy += stepY;
      tMaxY += tDeltaY;
    } else {
      iz += stepZ;
      tMaxZ += tDeltaZ;
    }
  }

  if (bestTri < 0) return null;

  const n = mesh.normals;
  const a = idx[bestTri * 3] * 3,
    b = idx[bestTri * 3 + 1] * 3,
    c = idx[bestTri * 3 + 2] * 3;
  const w0 = 1 - bestU - bestV;
  let nx_ = n[a] * w0 + n[b] * bestU + n[c] * bestV;
  let ny_ = n[a + 1] * w0 + n[b + 1] * bestU + n[c + 1] * bestV;
  let nz_ = n[a + 2] * w0 + n[b + 2] * bestU + n[c + 2] * bestV;
  const len = Math.hypot(nx_, ny_, nz_) || 1;
  nx_ /= len;
  ny_ /= len;
  nz_ /= len;

  return {
    t: bestT,
    triangle: bestTri,
    x: ox + dx * bestT,
    y: oy + dy * bestT,
    z: oz + dz * bestT,
    nx: nx_,
    ny: ny_,
    nz: nz_,
  };
}
