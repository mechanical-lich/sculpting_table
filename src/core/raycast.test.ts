import { describe, expect, it } from 'vitest';
import { BrushEngine } from './brush';
import { createMesh, type Mesh } from './mesh';
import { NormalUpdater } from './normals';
import { createQuadSphere } from './quadSphere';
import { RaycastScratch, raycastMesh } from './raycast';
import { SpatialGrid } from './spatialGrid';

function bruteRay(mesh: Mesh, o: number[], d: number[]): number {
  const p = mesh.positions;
  let best = Infinity;
  for (let t = 0; t < mesh.triangleCount; t++) {
    const [a, b, c] = [0, 1, 2].map((k) => mesh.indices[t * 3 + k] * 3);
    const e1 = [p[b] - p[a], p[b + 1] - p[a + 1], p[b + 2] - p[a + 2]];
    const e2 = [p[c] - p[a], p[c + 1] - p[a + 1], p[c + 2] - p[a + 2]];
    const pv = [
      d[1] * e2[2] - d[2] * e2[1],
      d[2] * e2[0] - d[0] * e2[2],
      d[0] * e2[1] - d[1] * e2[0],
    ];
    const det = e1[0] * pv[0] + e1[1] * pv[1] + e1[2] * pv[2];
    if (Math.abs(det) < 1e-20) continue;
    const s = [o[0] - p[a], o[1] - p[a + 1], o[2] - p[a + 2]];
    const u = (s[0] * pv[0] + s[1] * pv[1] + s[2] * pv[2]) / det;
    if (u < 0 || u > 1) continue;
    const q = [
      s[1] * e1[2] - s[2] * e1[1],
      s[2] * e1[0] - s[0] * e1[2],
      s[0] * e1[1] - s[1] * e1[0],
    ];
    const v = (d[0] * q[0] + d[1] * q[1] + d[2] * q[2]) / det;
    if (v < 0 || u + v > 1) continue;
    const tt = (e2[0] * q[0] + e2[1] * q[1] + e2[2] * q[2]) / det;
    if (tt > 0 && tt < best) best = tt;
  }
  return best;
}

describe('raycastMesh', () => {
  const s = createQuadSphere(12);
  const mesh = createMesh(s.positions, s.indices);
  const grid = new SpatialGrid();
  grid.buildFromMesh(mesh);
  const scratch = new RaycastScratch();

  it('hits the near side of a sphere along an axis', () => {
    const hit = raycastMesh(mesh, grid, scratch, 0, 0, 5, 0, 0, -1);
    expect(hit).not.toBeNull();
    expect(hit!.z).toBeGreaterThan(0.99);
    expect(hit!.nz).toBeGreaterThan(0.99);
  });

  it('misses when aimed away', () => {
    expect(raycastMesh(mesh, grid, scratch, 0, 0, 5, 0, 0, 1)).toBeNull();
    expect(raycastMesh(mesh, grid, scratch, 0, 3, 5, 0, 0, -1)).toBeNull();
  });

  it('agrees with brute force for random rays', () => {
    let seed = 7;
    const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 0x100000000) * 2 - 1;
    for (let i = 0; i < 300; i++) {
      const o = [rand() * 3, rand() * 3, rand() * 3];
      const target = [rand() * 0.9, rand() * 0.9, rand() * 0.9];
      const d = [target[0] - o[0], target[1] - o[1], target[2] - o[2]];
      const expected = bruteRay(mesh, o, d);
      const hit = raycastMesh(mesh, grid, scratch, o[0], o[1], o[2], d[0], d[1], d[2]);
      if (expected === Infinity) expect(hit).toBeNull();
      else expect(hit!.t).toBeCloseTo(expected, 6);
    }
  });

  it('works from inside the mesh', () => {
    const hit = raycastMesh(mesh, grid, scratch, 0, 0, 0, 1, 0, 0);
    expect(hit!.x).toBeCloseTo(1, 2);
  });
});

describe('raycastMesh after edits', () => {
  const compare = (mesh: Mesh, grid: SpatialGrid, seed: number) => {
    const scratch = new RaycastScratch();
    const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 0x100000000) * 2 - 1;
    for (let r = 0; r < 300; r++) {
      const o = [rand() * 4, rand() * 4, rand() * 4];
      const d = [rand() * 0.9 - o[0], rand() * 0.9 - o[1], rand() * 0.9 - o[2]];
      const expected = bruteRay(mesh, o, d);
      const hit = raycastMesh(mesh, grid, scratch, o[0], o[1], o[2], d[0], d[1], d[2]);
      if (expected === Infinity) expect(hit).toBeNull();
      else expect(hit!.t).toBeCloseTo(expected, 6);
    }
  };

  it('agrees with brute force after heavy sculpting, without a rebuild', () => {
    const s = createQuadSphere(24);
    const mesh = createMesh(s.positions, s.indices);
    const grid = new SpatialGrid();
    grid.buildFromMesh(mesh);
    const engine = new BrushEngine(mesh.vertexCount);
    const normals = new NormalUpdater(mesh);
    for (let i = 0; i < 300; i++) {
      const a = i * 0.05;
      const dab = {
        kind: 'sculpt' as const,
        x: Math.sin(a) * 0.5,
        y: 0.3,
        z: Math.cos(a) * 0.8,
        radius: 0.3,
        strength: 1,
        falloff: 'smooth' as const,
        symmetryX: false,
      };
      normals.update(mesh, engine.applyDab(mesh, grid, dab, null));
    }
    expect(grid.needsRebuild()).toBe(false);
    compare(mesh, grid, 11);
  });

  it('widens the neighborhood when edges stretch', () => {
    const s = createQuadSphere(12);
    const mesh = createMesh(s.positions, s.indices);
    const grid = new SpatialGrid();
    grid.buildFromMesh(mesh);
    expect(grid.raycastNeighborhood()).toBe(1);
    // Scale the mesh 4x without rebuilding: every edge quadruples.
    for (let i = 0; i < mesh.positions.length; i++) mesh.positions[i] *= 4;
    const all = new Uint32Array(mesh.vertexCount).map((_, i) => i);
    grid.updateFromMesh(mesh, all);
    expect(grid.raycastNeighborhood()).toBe(2);
    compare(mesh, grid, 5);
  });
});
