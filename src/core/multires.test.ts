import { describe, expect, it } from 'vitest';
import { BrushEngine } from './brush';
import { Multires } from './multires';
import { createQuadSphere } from './quadSphere';
import { SpatialGrid } from './spatialGrid';
import { quadTopology } from './subdivision';
import { applyEntry, StrokeRecorder, type ArrayPatch } from './undo';

function sphere(segments = 4, levels = 3): Multires {
  const s = createQuadSphere(segments);
  const m = new Multires(quadTopology(s.quads, s.positions.length / 3), s.positions);
  for (let i = 0; i < levels; i++) m.addLevel();
  return m;
}

/** Sculpts one dab at level k and returns the stroke patch (not yet committed). */
function sculpt(
  m: Multires,
  k: number,
  x: number,
  y: number,
  z: number,
  radius: number,
  strength = 1,
): ArrayPatch {
  const mesh = m.createLevelMesh(k);
  const grid = new SpatialGrid();
  grid.buildFromMesh(mesh);
  const engine = new BrushEngine(mesh.vertexCount);
  const rec = new StrokeRecorder(mesh.vertexCount);
  rec.begin(mesh.positions);
  for (let i = 0; i < 3; i++) {
    engine.applyDab(
      mesh,
      grid,
      { kind: 'sculpt', x, y, z, radius, strength, falloff: 'smooth', symmetryX: false },
      rec,
    );
  }
  return rec.end()!;
}

/** Largest distance from the origin minus 1, over a level. */
function maxBulge(m: Multires, k: number): number {
  const p = m.levels[k].positions;
  let best = -Infinity;
  for (let i = 0; i < p.length; i += 3) best = Math.max(best, Math.hypot(p[i], p[i + 1], p[i + 2]));
  return best;
}

/** Random displacement on every level, then a rebuild. */
function addRandomDetail(m: Multires, scale: number): void {
  let seed = 3;
  const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 0x100000000 - 0.5) * scale;
  for (let j = 1; j <= m.top; j++) {
    const d = m.levels[j].displacement!;
    for (let i = 0; i < d.length; i++) d[i] = rand();
  }
  m.invalidateAbove(0);
  m.ensureCurrent(m.top);
}

function snapshot(m: Multires) {
  return m.levels.map((l) => ({ p: l.positions.slice(), d: l.displacement?.slice() ?? null }));
}

describe('Multires', () => {
  it('builds levels that satisfy the invariant', () => {
    const m = sphere();
    expect(m.levels.map((l) => l.topology.faceCount)).toEqual([96, 384, 1536, 6144]);
    for (let j = 1; j <= m.top; j++) expect(m.invariantError(j)).toBeLessThan(1e-6);
  });

  it('rebuilds stale levels from random displacements', () => {
    const m = sphere();
    addRandomDetail(m, 0.02);
    for (let j = 1; j <= m.top; j++) {
      expect(m.levels[j].stale).toBe(false);
      expect(m.invariantError(j)).toBeLessThan(1e-5);
    }
  });

  it('commit keeps the sculpted level exact and the invariant below it', () => {
    const m = sphere();
    // Give every level real detail, so frame changes show up in the invariant.
    addRandomDetail(m, 0.05);
    const stroke = sculpt(m, 2, 0, 0, 1, 0.5);
    const sculpted = m.levels[2].positions.slice();
    const entry = m.commit(2, stroke);
    expect(entry.level).toBe(2);
    expect(m.levels[2].positions).toEqual(sculpted);
    expect(m.invariantError(1)).toBeLessThan(2e-6);
    expect(m.invariantError(2)).toBeLessThan(2e-6);
    expect(m.levels[3].stale).toBe(true);

    m.ensureCurrent(3);
    expect(m.invariantError(3)).toBeLessThan(2e-6);
  });

  it('shows a smoothed copy of a high-level edit on lower levels (Mudbox)', () => {
    const m = sphere(4, 3);
    const base = [0, 1, 2, 3].map((k) => maxBulge(m, k));
    m.commit(3, sculpt(m, 3, 0, 0, 1, 0.6));
    const bump = [0, 1, 2, 3].map((k, i) => maxBulge(m, k) - base[i]);
    expect(bump[3]).toBeGreaterThan(0.01);
    for (let k = 0; k < 3; k++) {
      expect(bump[k]).toBeGreaterThan(0);
      expect(bump[k]).toBeLessThan(bump[3] * 1.0001);
    }
  });

  it('undo and redo restore every array', () => {
    const m = sphere();
    m.commit(3, sculpt(m, 3, 0.3, 0.2, 0.93, 0.5)); // something to sit on top of
    const start = snapshot(m);
    const entry = m.commit(2, sculpt(m, 2, 0, 0.7, 0.7, 0.6));
    const end = snapshot(m);

    applyEntry(entry, 'before');
    m.invalidateAbove(entry.level);
    for (let k = 0; k <= 2; k++) {
      expect(m.levels[k].positions).toEqual(start[k].p);
      if (k > 0) expect(m.levels[k].displacement).toEqual(start[k].d);
    }
    m.ensureCurrent(3);
    for (let i = 0; i < start[3].p.length; i++) {
      expect(m.levels[3].positions[i]).toBeCloseTo(start[3].p[i], 5);
    }

    applyEntry(entry, 'after');
    m.invalidateAbove(entry.level);
    for (let k = 0; k <= 2; k++) {
      expect(m.levels[k].positions).toEqual(end[k].p);
      if (k > 0) expect(m.levels[k].displacement).toEqual(end[k].d);
    }
  });

  it('carries high-level detail along when a lower level rotates', () => {
    const m = sphere();
    m.commit(3, sculpt(m, 3, 0.5, 0.3, 0.81, 0.4));
    const detailed = m.levels[3].positions.slice();

    // Rotate all of level 1 by 90 degrees about y, as one "stroke".
    const p1 = m.levels[1].positions;
    const n = p1.length / 3;
    const indices = new Uint32Array(n).map((_, i) => i);
    const before = p1.slice();
    for (let i = 0; i < n; i++) {
      const x = p1[i * 3],
        z = p1[i * 3 + 2];
      p1[i * 3] = z;
      p1[i * 3 + 2] = -x;
    }
    m.commit(1, { target: p1, stride: 3, indices, before, after: p1.slice() });
    m.ensureCurrent(3);

    const p3 = m.levels[3].positions;
    for (let i = 0; i < p3.length; i += 3) {
      expect(p3[i]).toBeCloseTo(detailed[i + 2], 4);
      expect(p3[i + 1]).toBeCloseTo(detailed[i + 1], 4);
      expect(p3[i + 2]).toBeCloseTo(-detailed[i], 4);
    }
  });

  it('commit at level 0 just marks the levels above stale', () => {
    const m = sphere(4, 2);
    const entry = m.commit(0, sculpt(m, 0, 0, 0, 1, 0.8));
    expect(entry.patches).toHaveLength(1);
    expect(m.levels[1].stale && m.levels[2].stale).toBe(true);
    m.ensureCurrent(2);
    expect(m.invariantError(2)).toBeLessThan(1e-5);
  });
});
