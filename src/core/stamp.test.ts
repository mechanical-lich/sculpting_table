import { describe, expect, it } from 'vitest';
import { BrushEngine, type Dab } from './brush';
import { createMesh } from './mesh';
import { NormalUpdater } from './normals';
import { createQuadSphere } from './quadSphere';
import { SpatialGrid } from './spatialGrid';
import { BUILTIN_STAMPS, sampleStamp, stampFromRGBA, type Stamp } from './stamp';

/** Left half 1, right half 0, with a one-pixel edge (bilinear blurs only that). */
const leftHalf: Stamp = {
  width: 64,
  height: 2,
  data: Float32Array.from({ length: 128 }, (_, i) => (i % 64 < 32 ? 1 : 0)),
};

describe('sampleStamp', () => {
  it('maps u = -1..1 across the image and v up', () => {
    const s: Stamp = { width: 2, height: 2, data: new Float32Array([0.1, 0.2, 0.3, 0.4]) };
    expect(sampleStamp(s, -1, 1)).toBeCloseTo(0.1); // top left
    expect(sampleStamp(s, 1, 1)).toBeCloseTo(0.2); // top right
    expect(sampleStamp(s, -1, -1)).toBeCloseTo(0.3); // bottom left
    expect(sampleStamp(s, 1, -1)).toBeCloseTo(0.4);
    expect(sampleStamp(s, 0, 0)).toBeCloseTo(0.25); // bilinear center
  });

  it('is zero outside the square', () => {
    expect(sampleStamp(leftHalf, -1.01, 0)).toBe(0);
    expect(sampleStamp(leftHalf, -0.5, 1.5)).toBe(0);
    expect(sampleStamp(leftHalf, -0.5, 0)).toBe(1);
  });

  it('builds from RGBA by luminance, with alpha as a mask', () => {
    const s = stampFromRGBA(2, 1, new Uint8ClampedArray([255, 255, 255, 255, 255, 255, 255, 0]));
    expect(Array.from(s.data)).toEqual([1, 0]);
  });
});

describe('built-in stamps', () => {
  it.each(Object.keys(BUILTIN_STAMPS) as (keyof typeof BUILTIN_STAMPS)[])(
    '%s is deterministic, in range and not flat',
    (id) => {
      const a = BUILTIN_STAMPS[id].make();
      const b = BUILTIN_STAMPS[id].make();
      expect(a.data).toEqual(b.data);
      let min = 1,
        max = 0;
      for (const v of a.data) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
        min = Math.min(min, v);
        max = Math.max(max, v);
      }
      expect(max - min).toBeGreaterThan(0.5);
    },
  );
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

describe('stamped dabs', () => {
  it('only moves vertices where the stamp is bright', () => {
    const { mesh, grid, engine } = setup();
    const before = mesh.positions.slice();
    // At the +z pole with u along +x, the left (bright) half is x < 0.
    const dab: Dab = {
      kind: 'sculpt',
      x: 0,
      y: 0,
      z: 1,
      radius: 0.4,
      strength: 1,
      falloff: 'flat',
      symmetryX: false,
      stamp: { stamp: leftHalf, dirX: 1, dirY: 0, dirZ: 0, angle: 0 },
    };
    const touched = engine.applyDab(mesh, grid, dab, null);
    let left = 0,
      right = 0;
    for (const v of touched) {
      const moved = Math.hypot(
        mesh.positions[v * 3] - before[v * 3],
        mesh.positions[v * 3 + 1] - before[v * 3 + 1],
        mesh.positions[v * 3 + 2] - before[v * 3 + 2],
      );
      const x = before[v * 3];
      if (x < -0.15) left = Math.max(left, moved);
      if (x > 0.15) right = Math.max(right, moved);
    }
    expect(left).toBeGreaterThan(0.005);
    expect(right).toBe(0);
  });

  it('rotates with the angle', () => {
    const { mesh, grid, engine } = setup();
    const before = mesh.positions.slice();
    // Rotating 90 degrees puts the bright half at y < 0 (u axis turns to +y).
    const dab: Dab = {
      kind: 'sculpt',
      x: 0,
      y: 0,
      z: 1,
      radius: 0.4,
      strength: 1,
      falloff: 'flat',
      symmetryX: false,
      stamp: { stamp: leftHalf, dirX: 1, dirY: 0, dirZ: 0, angle: Math.PI / 2 },
    };
    engine.applyDab(mesh, grid, dab, null);
    const movedAt = (wantY: number) => {
      let best = 0;
      for (let v = 0; v < mesh.vertexCount; v++) {
        if (Math.abs(before[v * 3]) < 0.05 && Math.abs(before[v * 3 + 1] - wantY) < 0.05) {
          best = Math.max(best, Math.abs(mesh.positions[v * 3 + 2] - before[v * 3 + 2]));
        }
      }
      return best;
    };
    expect(movedAt(-0.25)).toBeGreaterThan(0.002);
    expect(movedAt(0.25)).toBe(0);
  });

  it('stays mirror-symmetric with an asymmetric stamp', () => {
    const { mesh, grid, engine, normals } = setup();
    for (const x of [0.35, 0.05]) {
      const z = Math.sqrt(1 - x * x - 0.04);
      const dab: Dab = {
        kind: 'sculpt',
        x,
        y: 0.2,
        z,
        radius: 0.35,
        strength: 1,
        falloff: 'smooth',
        symmetryX: true,
        stamp: { stamp: leftHalf, dirX: 0.3, dirY: 1, dirZ: 0.1, angle: 0.7 },
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
