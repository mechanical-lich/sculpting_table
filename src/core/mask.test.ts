import { describe, expect, it } from 'vitest';
import { BrushEngine, type Dab } from './brush';
import { createMesh, type Mesh } from './mesh';
import { Multires } from './multires';
import { createQuadSphere } from './quadSphere';
import { SpatialGrid } from './spatialGrid';
import { quadTopology } from './subdivision';
import { applyEntry, StrokeRecorder } from './undo';

function setup(segments = 24) {
  const s = createQuadSphere(segments);
  const mesh = createMesh(s.positions, s.indices, s.quads);
  const grid = new SpatialGrid();
  grid.buildFromMesh(mesh);
  return { mesh, grid, engine: new BrushEngine(mesh.vertexCount) };
}

const dab = (over: Partial<Dab>): Dab => ({
  kind: 'sculpt',
  x: 0,
  y: 0,
  z: 1,
  radius: 0.5,
  strength: 1,
  falloff: 'flat',
  symmetryX: false,
  ...over,
});

const moved = (mesh: Mesh, before: Float32Array, v: number) =>
  Math.hypot(
    mesh.positions[v * 3] - before[v * 3],
    mesh.positions[v * 3 + 1] - before[v * 3 + 1],
    mesh.positions[v * 3 + 2] - before[v * 3 + 2],
  );

/** Masks every vertex with x > 0 (the right half of the +z cap). */
function maskRight(mesh: Mesh, value = 1) {
  for (let v = 0; v < mesh.vertexCount; v++) if (mesh.positions[v * 3] > 0) mesh.mask[v] = value;
}

describe('masking', () => {
  it.each(['sculpt', 'smooth', 'inflate', 'flatten'] as const)(
    '%s leaves masked vertices alone',
    (kind) => {
      const { mesh, grid, engine } = setup();
      // Roughen first so Smooth/Flatten have something to do.
      for (let v = 0; v < mesh.vertexCount; v++) {
        if (v % 3 === 0) for (let c = 0; c < 3; c++) mesh.positions[v * 3 + c] *= 1.02;
      }
      maskRight(mesh);
      const before = mesh.positions.slice();
      const touched = engine.applyDab(mesh, grid, dab({ kind }), null);
      let free = 0;
      for (const v of touched) {
        if (mesh.mask[v] === 1) expect(moved(mesh, before, v)).toBe(0);
        else free = Math.max(free, moved(mesh, before, v));
      }
      expect(free).toBeGreaterThan(0);
    },
  );

  it('scales the effect by the unmasked fraction', () => {
    const a = setup(),
      b = setup();
    b.mesh.mask.fill(0.5);
    const before = a.mesh.positions.slice();
    a.engine.applyDab(a.mesh, a.grid, dab({}), null);
    b.engine.applyDab(b.mesh, b.grid, dab({}), null);
    // The pole vertex sits at the center of the flat falloff.
    const pole = Array.from({ length: a.mesh.vertexCount }, (_, v) => v).find(
      (v) => before[v * 3 + 2] > 0.99999,
    )!;
    expect(moved(b.mesh, before, pole)).toBeCloseTo(moved(a.mesh, before, pole) / 2, 6);
  });

  it('stops Grab from moving masked vertices', () => {
    const { mesh, grid, engine } = setup();
    maskRight(mesh);
    const before = mesh.positions.slice();
    engine.beginGrab(mesh, grid, 0, 0, 1, 0.5, false, 'smooth', null);
    const grabbed = engine.dragGrab(mesh, grid, 0, 0.2, 0);
    let free = 0;
    for (const v of grabbed) {
      if (mesh.mask[v] === 1) expect(moved(mesh, before, v)).toBe(0);
      else free = Math.max(free, moved(mesh, before, v));
    }
    expect(free).toBeGreaterThan(0.1);
  });
});

describe('Mask brush', () => {
  it('paints mask, erases with negative strength, and never moves vertices', () => {
    const { mesh, grid, engine } = setup();
    const before = mesh.positions.slice();
    const touched = engine.applyDab(mesh, grid, dab({ kind: 'mask' }), null);
    expect(mesh.positions).toEqual(before);
    expect(Math.max(...Array.from(touched, (v) => mesh.mask[v]))).toBe(1);
    engine.applyDab(mesh, grid, dab({ kind: 'mask', strength: -1 }), null);
    expect(Math.max(...Array.from(touched, (v) => mesh.mask[v]))).toBe(0);
  });

  it('smooths a hard mask edge', () => {
    const { mesh, grid, engine } = setup();
    maskRight(mesh);
    const edge = (): number => {
      // Largest mask jump across an edge near the pole.
      const { neighborOffsets, neighbors } = mesh.adjacency;
      let jump = 0;
      for (let v = 0; v < mesh.vertexCount; v++) {
        if (mesh.positions[v * 3 + 2] < 0.95) continue;
        for (let k = neighborOffsets[v]; k < neighborOffsets[v + 1]; k++) {
          jump = Math.max(jump, Math.abs(mesh.mask[v] - mesh.mask[neighbors[k]]));
        }
      }
      return jump;
    };
    expect(edge()).toBe(1);
    for (let i = 0; i < 3; i++)
      engine.applyDab(mesh, grid, dab({ kind: 'mask', smoothMask: true }), null);
    expect(edge()).toBeLessThan(0.7);
  });

  it('paints a mirror-symmetric mask with X symmetry', () => {
    const { mesh, grid, engine } = setup(16);
    engine.applyDab(
      mesh,
      grid,
      dab({
        kind: 'mask',
        x: 0.4,
        y: 0.2,
        z: Math.sqrt(0.8),
        radius: 0.3,
        falloff: 'smooth',
        strength: 0.6,
        symmetryX: true,
      }),
      null,
    );
    const p = mesh.positions;
    const byPos = new Map<string, number>();
    const key = (x: number, y: number, z: number) =>
      `${x.toFixed(4)},${y.toFixed(4)},${z.toFixed(4)}`;
    for (let v = 0; v < mesh.vertexCount; v++)
      byPos.set(key(p[v * 3], p[v * 3 + 1], p[v * 3 + 2]), v);
    let painted = 0;
    for (let v = 0; v < mesh.vertexCount; v++) {
      const m = byPos.get(key(-p[v * 3], p[v * 3 + 1], p[v * 3 + 2]))!;
      expect(mesh.mask[m]).toBeCloseTo(mesh.mask[v], 6);
      if (mesh.mask[v] > 0) painted++;
    }
    expect(painted).toBeGreaterThan(10);
  });

  it('records mask strokes for undo (one value per vertex)', () => {
    const { mesh, grid, engine } = setup();
    const rec = new StrokeRecorder(mesh.vertexCount);
    rec.begin(mesh.mask, 1);
    engine.applyDab(mesh, grid, dab({ kind: 'mask' }), rec);
    const patch = rec.end()!;
    expect(patch.stride).toBe(1);
    const painted = mesh.mask.slice();
    applyEntry({ level: 0, mask: true, patches: [patch] }, 'before');
    expect(mesh.mask.every((m) => m === 0)).toBe(true);
    applyEntry({ level: 0, mask: true, patches: [patch] }, 'after');
    expect(mesh.mask).toEqual(painted);
  });
});

describe('mask across levels', () => {
  function multires() {
    const s = createQuadSphere(4);
    const m = new Multires(quadTopology(s.quads, s.positions.length / 3), s.positions);
    for (let i = 0; i < 3; i++) m.addLevel();
    return m;
  }

  it('carries a mask down exactly and up smoothly', () => {
    const m = multires();
    const top = m.levels[3];
    // Mask the +x half at the top level.
    for (let v = 0; v < top.mask.length; v++) top.mask[v] = top.positions[v * 3] > 0 ? 1 : 0;
    m.transferMask(3, 1);
    const l1 = m.levels[1];
    for (let v = 0; v < l1.mask.length; v++) expect(l1.mask[v]).toBe(top.mask[v]);

    m.transferMask(1, 3);
    // Interpolated, in range, and still 1 well inside and 0 well outside.
    for (let v = 0; v < top.mask.length; v++) {
      const x = top.positions[v * 3];
      expect(top.mask[v]).toBeGreaterThanOrEqual(0);
      expect(top.mask[v]).toBeLessThanOrEqual(1);
      if (x > 0.5) expect(top.mask[v]).toBeCloseTo(1, 6);
      if (x < -0.5) expect(top.mask[v]).toBeCloseTo(0, 6);
    }
  });

  it('gives a new level the mask of the level below', () => {
    const m = multires();
    m.levels[3].mask.fill(1);
    m.addLevel();
    expect(m.levels[4].mask.every((v) => Math.abs(v - 1) < 1e-6)).toBe(true);
  });

  it('shares the mask array with the level mesh', () => {
    const m = multires();
    expect(m.createLevelMesh(2).mask).toBe(m.levels[2].mask);
  });
});
