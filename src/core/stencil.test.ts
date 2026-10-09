import { describe, expect, it } from 'vitest';
import { BrushEngine, type Dab } from './brush';
import { createMesh } from './mesh';
import { NormalUpdater } from './normals';
import { createQuadSphere } from './quadSphere';
import { SpatialGrid } from './spatialGrid';
import type { Stamp } from './stamp';
import { screenToStencil, stencilAt, type DabStencil } from './stencil';

/** Identity view-projection: world x, y in [-1, 1] map straight to the screen. */
const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

/** Left half 1, right half 0. */
const leftHalf: Stamp = {
  width: 64,
  height: 2,
  data: Float32Array.from({ length: 128 }, (_, i) => (i % 64 < 32 ? 1 : 0)),
};
const white: Stamp = { width: 2, height: 2, data: new Float32Array([1, 1, 1, 1]) };

const stencil = (over: Partial<DabStencil> = {}): DabStencil => ({
  stamp: white,
  viewProj: identity,
  viewportWidth: 200,
  viewportHeight: 200,
  centerX: 100,
  centerY: 100,
  halfSize: 50,
  angle: 0,
  tile: false,
  ...over,
});

describe('stencil mapping', () => {
  it('centers on the stencil and scales by half its size', () => {
    const [u0, v0] = screenToStencil(stencil(), 100, 100);
    expect(u0).toBeCloseTo(0);
    expect(v0).toBeCloseTo(0);
    const [u, v] = screenToStencil(stencil(), 125, 75); // right and up on screen
    expect(u).toBeCloseTo(0.5);
    expect(v).toBeCloseTo(0.5);
  });

  it('rotates clockwise on screen', () => {
    // After a 90 degree clockwise turn, the stencil's +u axis points down the screen.
    const [u, v] = screenToStencil(stencil({ angle: Math.PI / 2 }), 100, 125);
    expect(u).toBeCloseTo(0.5);
    expect(v).toBeCloseTo(0);
  });

  it('projects world points through the view', () => {
    // World x = 0.25 -> screen x = 125 -> u = 0.5 (right half of leftHalf: 0).
    expect(stencilAt(stencil({ stamp: leftHalf }), 0.25, 0, 0)).toBe(0);
    expect(stencilAt(stencil({ stamp: leftHalf }), -0.25, 0, 0)).toBe(1);
  });

  it('is zero outside the square unless tiled', () => {
    expect(stencilAt(stencil(), 0.9, 0, 0)).toBe(0);
    // Tiled: u = 1.8 wraps to -0.2, inside the left (bright) half.
    expect(stencilAt(stencil({ stamp: leftHalf, tile: true }), 0.9, 0, 0)).toBe(1);
  });

  it('is zero behind the camera', () => {
    const behind = new Float32Array(identity);
    behind[15] = -1; // clip w < 0
    expect(stencilAt(stencil({ viewProj: behind }), 0, 0, 0)).toBe(0);
  });
});

function setup() {
  const s = createQuadSphere(32);
  const mesh = createMesh(s.positions, s.indices, s.quads);
  const grid = new SpatialGrid();
  grid.buildFromMesh(mesh);
  return {
    mesh,
    grid,
    engine: new BrushEngine(mesh.vertexCount),
    normals: new NormalUpdater(mesh),
  };
}

describe('stenciled dabs', () => {
  it('only sculpts through the bright part of the stencil', () => {
    const { mesh, grid, engine } = setup();
    const before = mesh.positions.slice();
    const dab: Dab = {
      kind: 'sculpt',
      x: 0,
      y: 0,
      z: 1,
      radius: 0.4,
      strength: 1,
      falloff: 'flat',
      symmetryX: false,
      stencil: stencil({ stamp: leftHalf, halfSize: 100 }),
    };
    const touched = engine.applyDab(mesh, grid, dab, null);
    let left = 0,
      right = 0;
    for (const v of touched) {
      const moved = Math.abs(mesh.positions[v * 3 + 2] - before[v * 3 + 2]);
      if (before[v * 3] < -0.1) left = Math.max(left, moved);
      if (before[v * 3] > 0.1) right = Math.max(right, moved);
    }
    expect(left).toBeGreaterThan(0.005);
    expect(right).toBe(0);
  });

  it('mirrors the stenciled pattern with X symmetry', () => {
    const { mesh, grid, engine, normals } = setup();
    // An off-center, rotated stencil, so the two sides see different screen regions.
    const st = stencil({
      stamp: leftHalf,
      centerX: 120,
      centerY: 90,
      halfSize: 30,
      angle: 0.4,
      tile: true,
    });
    for (const x of [0.35, 0.05]) {
      const dab: Dab = {
        kind: 'sculpt',
        x,
        y: 0.2,
        z: Math.sqrt(1 - x * x - 0.04),
        radius: 0.35,
        strength: 1,
        falloff: 'smooth',
        symmetryX: true,
        stencil: st,
      };
      normals.update(mesh, engine.applyDab(mesh, grid, dab, null));
    }
    const p = mesh.positions;
    const key = (x: number, y: number, z: number) =>
      `${Math.abs(x).toFixed(4)},${y.toFixed(4)},${z.toFixed(4)}`;
    const counts = new Map<string, number>();
    for (let v = 0; v < mesh.vertexCount; v++) {
      const k = key(p[v * 3], p[v * 3 + 1], p[v * 3 + 2]);
      counts.set(k, (counts.get(k) ?? 0) + (Math.abs(p[v * 3]) < 5e-5 ? 2 : 1));
    }
    expect([...counts.values()].filter((c) => c % 2 !== 0)).toEqual([]);
  });
});
