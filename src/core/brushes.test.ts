import { describe, expect, it } from 'vitest';
import { BRUSH_ORDER, BRUSHES, BrushEngine, type Dab, type DabBrushKind } from './brush';
import { createMesh, type Mesh } from './mesh';
import { NormalUpdater } from './normals';
import { createQuadSphere } from './quadSphere';
import { SpatialGrid } from './spatialGrid';
import { StrokeRecorder } from './undo';

function setup(segments = 24) {
  const s = createQuadSphere(segments);
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

type Setup = ReturnType<typeof setup>;

/** Applies `count` dabs at the +z pole and returns the vertices touched by the first. */
function dabs(ctx: Setup, kind: DabBrushKind, strength = 1, count = 1, radius = 0.4): Uint32Array {
  let first: Uint32Array | null = null;
  for (let i = 0; i < count; i++) {
    const falloff = BRUSHES[kind].defaultFalloff;
    const dab: Dab = { kind, x: 0, y: 0, z: 1, radius, strength, falloff, symmetryX: false };
    const touched = ctx.engine.applyDab(ctx.mesh, ctx.grid, dab, null);
    first ??= touched.slice();
    ctx.normals.update(ctx.mesh, touched);
  }
  return first!;
}

const radiusOf = (m: Mesh, v: number) =>
  Math.hypot(m.positions[v * 3], m.positions[v * 3 + 1], m.positions[v * 3 + 2]);
/** Distance from the z axis: what Pinch-like brushes pull in. */
const axial = (m: Mesh, v: number) => Math.hypot(m.positions[v * 3], m.positions[v * 3 + 1]);
const sum = (vs: Uint32Array, f: (v: number) => number) => vs.reduce((a, v) => a + f(v), 0);

describe('brushes', () => {
  it.each(['sculpt', 'inflate', 'wax'] as const)('%s raises, and inverted lowers', (kind) => {
    const up = setup();
    const t = dabs(up, kind, 1, 3);
    expect(Math.max(...Array.from(t, (v) => radiusOf(up.mesh, v)))).toBeGreaterThan(1.001);
    const down = setup();
    const t2 = dabs(down, kind, -1, 3);
    expect(Math.min(...Array.from(t2, (v) => radiusOf(down.mesh, v)))).toBeLessThan(0.999);
  });

  it('wax never lowers a vertex, and scrape never raises one', () => {
    for (const [kind, sign] of [
      ['wax', 1],
      ['scrape', -1],
    ] as const) {
      const ctx = setup();
      const before = ctx.mesh.positions.slice();
      const t = dabs(ctx, kind, 1, 5);
      let moved = 0;
      for (const v of t) {
        const r0 = Math.hypot(before[v * 3], before[v * 3 + 1], before[v * 3 + 2]);
        const d = (radiusOf(ctx.mesh, v) - r0) * sign;
        expect(d).toBeGreaterThanOrEqual(-1e-6);
        if (Math.abs(d) > 1e-5) moved++;
      }
      expect(moved).toBeGreaterThan(0);
    }
  });

  it('flatten levels the area under the brush', () => {
    const ctx = setup(32);
    // The inner half of the brush, where falloff weights are high.
    const t = dabs(ctx, 'flatten', 0, 1).filter((v) => axial(ctx.mesh, v) < 0.2);
    const spread = () => {
      const zs = Array.from(t, (v) => ctx.mesh.positions[v * 3 + 2]);
      return Math.max(...zs) - Math.min(...zs);
    };
    const s0 = spread();
    dabs(ctx, 'flatten', 1, 10);
    expect(spread()).toBeLessThan(s0 * 0.5);
  });

  it.each(['pinch', 'crease', 'knife'] as const)('%s pulls toward the stroke', (kind) => {
    const ctx = setup();
    const t = dabs(ctx, kind, 0, 1); // zero strength: just find the vertices
    const before = sum(t, (v) => axial(ctx.mesh, v));
    dabs(ctx, kind, 1, 3);
    expect(sum(t, (v) => axial(ctx.mesh, v))).toBeLessThan(before);
  });

  it('crease cuts in, and inverted raises a ridge', () => {
    const cut = setup();
    const t = dabs(cut, 'crease', 1, 3);
    expect(Math.min(...Array.from(t, (v) => radiusOf(cut.mesh, v)))).toBeLessThan(0.999);
    const ridge = setup();
    const t2 = dabs(ridge, 'crease', -1, 3);
    expect(Math.max(...Array.from(t2, (v) => radiusOf(ridge.mesh, v)))).toBeGreaterThan(1.001);
  });

  it('knife has a sharper profile than crease', () => {
    const profile = (kind: 'crease' | 'knife') => {
      const ctx = setup(48);
      const t = dabs(ctx, kind, 1, 1);
      // Depth at the pole vs. depth around half the radius.
      let center = 0,
        mid = 0,
        midCount = 0;
      for (const v of t) {
        const depth = 1 - radiusOf(ctx.mesh, v);
        const a = axial(ctx.mesh, v);
        if (a < 0.02) center = Math.max(center, depth);
        else if (Math.abs(a - 0.2) < 0.03) {
          mid += depth;
          midCount++;
        }
      }
      return mid / midCount / center;
    };
    expect(profile('knife')).toBeLessThan(profile('crease') * 0.6);
  });

  it.each(BRUSH_ORDER.filter((k) => k !== 'grab') as DabBrushKind[])(
    '%s stays mirror-symmetric with X symmetry',
    (kind) => {
      const ctx = setup(16);
      for (const x of [0.4, 0.05, -0.2]) {
        const z = Math.sqrt(1 - x * x - 0.04);
        const dab: Dab = {
          kind,
          x,
          y: 0.2,
          z,
          radius: 0.35,
          strength: 0.8,
          falloff: BRUSHES[kind].defaultFalloff,
          symmetryX: true,
        };
        ctx.normals.update(ctx.mesh, ctx.engine.applyDab(ctx.mesh, ctx.grid, dab, null));
      }
      expectSymmetric(ctx.mesh);
    },
  );
});

describe('grab', () => {
  it('drags the center by the full offset and leaves the outside alone', () => {
    const ctx = setup();
    const before = ctx.mesh.positions.slice();
    const rec = new StrokeRecorder(ctx.mesh.vertexCount);
    rec.begin();
    expect(ctx.engine.beginGrab(ctx.mesh, ctx.grid, 0, 0, 1, 0.3, false, 'smooth', rec)).toBe(true);
    const moved = ctx.engine.dragGrab(ctx.mesh, ctx.grid, 0.1, 0.2, 0.05);

    // The quad sphere has a vertex exactly at the pole (weight 1).
    const pole = Array.from(moved).find(
      (v) => axial(ctx.mesh, v) < 1e-6 || before[v * 3 + 2] > 0.99999,
    )!;
    expect(ctx.mesh.positions[pole * 3]).toBeCloseTo(before[pole * 3] + 0.1, 5);
    expect(ctx.mesh.positions[pole * 3 + 1]).toBeCloseTo(before[pole * 3 + 1] + 0.2, 5);

    const inside = new Set(moved);
    for (let v = 0; v < ctx.mesh.vertexCount; v++) {
      if (!inside.has(v))
        expect(ctx.mesh.positions.subarray(v * 3, v * 3 + 3)).toEqual(
          before.subarray(v * 3, v * 3 + 3),
        );
    }

    // Dragging back to zero restores the start exactly, and the recorder has it all.
    ctx.engine.dragGrab(ctx.mesh, ctx.grid, 0, 0, 0);
    expect(ctx.mesh.positions).toEqual(before);
    const stroke = rec.end(ctx.mesh)!;
    expect(stroke.indices.length).toBe(moved.length);
  });

  it('mirrors the drag with X symmetry', () => {
    const ctx = setup(16);
    ctx.engine.beginGrab(
      ctx.mesh,
      ctx.grid,
      0.3,
      0.2,
      Math.sqrt(1 - 0.13),
      0.35,
      true,
      'smooth',
      null,
    );
    ctx.engine.dragGrab(ctx.mesh, ctx.grid, 0.15, -0.1, 0.05);
    expectSymmetric(ctx.mesh);
  });

  it('returns false when nothing is under the brush', () => {
    const ctx = setup(8);
    expect(ctx.engine.beginGrab(ctx.mesh, ctx.grid, 5, 5, 5, 0.1, false, 'smooth', null)).toBe(
      false,
    );
  });
});

/** Every vertex has a mirror partner across x = 0 (within float tolerance). */
function expectSymmetric(mesh: Mesh): void {
  const p = mesh.positions;
  const key = (x: number, y: number, z: number) =>
    `${Math.abs(x).toFixed(4)},${y.toFixed(4)},${z.toFixed(4)}`;
  const counts = new Map<string, number>();
  for (let v = 0; v < mesh.vertexCount; v++) {
    const k = key(p[v * 3], p[v * 3 + 1], p[v * 3 + 2]);
    // Vertices on the plane are their own partner.
    counts.set(k, (counts.get(k) ?? 0) + (Math.abs(p[v * 3]) < 5e-5 ? 2 : 1));
  }
  const odd = [...counts.entries()].filter(([, c]) => c % 2 !== 0);
  expect(odd).toEqual([]);
}

describe('falloff presets in dabs', () => {
  it('flat moves the plateau as much as the center; smooth does not', () => {
    const lift = (falloff: Dab['falloff']) => {
      const ctx = setup(48);
      const before = ctx.mesh.positions.slice();
      const dab: Dab = {
        kind: 'sculpt',
        x: 0,
        y: 0,
        z: 1,
        radius: 0.4,
        strength: 1,
        falloff,
        symmetryX: false,
      };
      const touched = ctx.engine.applyDab(ctx.mesh, ctx.grid, dab, null);
      // Displacement near the center vs. at ~half radius.
      let center = 0,
        half = 0,
        n = 0;
      for (const v of touched) {
        const d = Math.hypot(
          ctx.mesh.positions[v * 3] - before[v * 3],
          ctx.mesh.positions[v * 3 + 1] - before[v * 3 + 1],
          ctx.mesh.positions[v * 3 + 2] - before[v * 3 + 2],
        );
        const dist = Math.hypot(before[v * 3], before[v * 3 + 1], before[v * 3 + 2] - 1);
        if (dist < 0.02) center = Math.max(center, d);
        else if (Math.abs(dist - 0.2) < 0.02) {
          half += d;
          n++;
        }
      }
      return half / n / center;
    };
    expect(lift('flat')).toBeCloseTo(1, 3);
    expect(lift('smooth')).toBeLessThan(0.6);
  });
});
