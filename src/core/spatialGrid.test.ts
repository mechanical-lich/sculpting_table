import { describe, expect, it } from 'vitest';
import { IndexList } from './lists';
import { createMesh } from './mesh';
import { createQuadSphere } from './quadSphere';
import { SpatialGrid } from './spatialGrid';

/** Deterministic PRNG so failures reproduce. */
function rng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0x100000000;
  };
}

function brute(p: Float32Array, cx: number, cy: number, cz: number, r: number): number[] {
  const out: number[] = [];
  for (let v = 0; v < p.length / 3; v++) {
    const d = Math.hypot(p[v * 3] - cx, p[v * 3 + 1] - cy, p[v * 3 + 2] - cz);
    if (d <= r) out.push(v);
  }
  return out;
}

function sorted(list: IndexList): number[] {
  return Array.from(list.view()).sort((a, b) => a - b);
}

describe('SpatialGrid.queryRadius', () => {
  it('matches brute force on random points', () => {
    const rand = rng(1);
    const count = 5000;
    const p = new Float32Array(count * 3);
    for (let i = 0; i < p.length; i++) p[i] = rand() * 4 - 2;
    const grid = new SpatialGrid();
    grid.build(p, count, 0.2);
    const out = new IndexList();
    for (let q = 0; q < 200; q++) {
      const cx = rand() * 5 - 2.5,
        cy = rand() * 5 - 2.5,
        cz = rand() * 5 - 2.5,
        r = rand() * 0.8;
      out.clear();
      grid.queryRadius(p, cx, cy, cz, r, out);
      expect(sorted(out)).toEqual(brute(p, cx, cy, cz, r));
    }
  });

  it('stays correct after points move and are re-binned with update()', () => {
    const rand = rng(2);
    const count = 2000;
    const p = new Float32Array(count * 3);
    for (let i = 0; i < p.length; i++) p[i] = rand();
    const grid = new SpatialGrid();
    grid.build(p, count, 0.1);
    // Move half the points, some far outside the original bounds.
    const moved: number[] = [];
    for (let v = 0; v < count; v += 2) {
      for (let c = 0; c < 3; c++) p[v * 3 + c] += (rand() * 2 - 1) * 1.5;
      moved.push(v);
    }
    grid.update(p, new Uint32Array(moved));
    const out = new IndexList();
    for (let q = 0; q < 200; q++) {
      const cx = rand() * 5 - 2,
        cy = rand() * 5 - 2,
        cz = rand() * 5 - 2,
        r = rand() * 0.8;
      out.clear();
      grid.queryRadius(p, cx, cy, cz, r, out);
      expect(sorted(out)).toEqual(brute(p, cx, cy, cz, r));
    }
  });

  it('falls back to a linear scan for huge radii without duplicates', () => {
    const s = createQuadSphere(16);
    const mesh = createMesh(s.positions, s.indices);
    const grid = new SpatialGrid();
    grid.buildFromMesh(mesh);
    const out = new IndexList();
    grid.queryRadius(mesh.positions, 0, 0, 0, 5, out);
    expect(sorted(out)).toEqual(brute(mesh.positions, 0, 0, 0, 5));
  });

  it('never returns duplicates when cells collide in a small table', () => {
    const rand = rng(3);
    const count = 64;
    const p = new Float32Array(count * 3);
    for (let i = 0; i < p.length; i++) p[i] = rand() * 10;
    const grid = new SpatialGrid();
    // 128 buckets for a 10x10x10-cell domain: many collisions.
    grid.build(p, count, 1);
    const out = new IndexList();
    for (let q = 0; q < 50; q++) {
      const cx = rand() * 10,
        cy = rand() * 10,
        cz = rand() * 10;
      out.clear();
      grid.queryRadius(p, cx, cy, cz, 3, out);
      expect(sorted(out)).toEqual(brute(p, cx, cy, cz, 3));
    }
  });
});
