import { describe, expect, it } from 'vitest';
import { BrushEngine, type Dab } from './brush';
import { createMesh } from './mesh';
import { NormalUpdater } from './normals';
import { createQuadSphere } from './quadSphere';
import { SpatialGrid } from './spatialGrid';
import { applyEntry, StrokeRecorder, UndoStack, type UndoEntry } from './undo';

function setup(segments = 16) {
  const s = createQuadSphere(segments);
  const mesh = createMesh(s.positions, s.indices, s.quads);
  const grid = new SpatialGrid();
  grid.buildFromMesh(mesh);
  return {
    mesh,
    grid,
    engine: new BrushEngine(mesh.vertexCount),
    normals: new NormalUpdater(mesh),
    recorder: new StrokeRecorder(mesh.vertexCount),
  };
}

const dab = (over: Partial<Dab>): Dab => ({
  kind: 'sculpt',
  x: 0.3,
  y: 0.2,
  z: Math.sqrt(1 - 0.13),
  radius: 0.4,
  strength: 1,
  falloff: 'smooth',
  symmetryX: false,
  ...over,
});

const asEntry = (stroke: UndoEntry['patches'][number]): UndoEntry => ({
  level: 0,
  patches: [stroke],
});

describe('undo', () => {
  it('round-trips a multi-dab stroke exactly', () => {
    const { mesh, grid, engine, normals, recorder } = setup();
    const stack = new UndoStack();
    const original = mesh.positions.slice();

    recorder.begin();
    for (let i = 0; i < 5; i++) {
      const touched = engine.applyDab(mesh, grid, dab({ x: 0.1 * i }), recorder);
      normals.update(mesh, touched);
    }
    const stroke = recorder.end(mesh)!;
    expect(stroke).not.toBeNull();
    stack.push(asEntry(stroke));
    const sculpted = mesh.positions.slice();
    expect(sculpted).not.toEqual(original);

    applyEntry(stack.undo()!, 'before');
    expect(mesh.positions).toEqual(original);
    expect(stack.canRedo).toBe(true);

    applyEntry(stack.redo()!, 'after');
    expect(mesh.positions).toEqual(sculpted);
  });

  it('drops redo history on a new push', () => {
    const { mesh, grid, engine, recorder } = setup(8);
    const stack = new UndoStack();
    for (let s = 0; s < 2; s++) {
      recorder.begin();
      engine.applyDab(mesh, grid, dab({}), recorder);
      stack.push(asEntry(recorder.end(mesh)!));
    }
    applyEntry(stack.undo()!, 'before');
    recorder.begin();
    engine.applyDab(mesh, grid, dab({ kind: 'smooth' }), recorder);
    stack.push(asEntry(recorder.end(mesh)!));
    expect(stack.canRedo).toBe(false);
  });

  it('returns null for an empty stroke', () => {
    const { mesh, recorder } = setup(4);
    recorder.begin();
    expect(recorder.end(mesh)).toBeNull();
  });
});

describe('BrushEngine', () => {
  it('sculpt pushes outward and inverted sculpt pushes inward', () => {
    const { mesh, grid, engine } = setup();
    const center = dab({ x: 0, y: 0, z: 1 });
    const touched = engine.applyDab(mesh, grid, center, null);
    expect(touched.length).toBeGreaterThan(0);
    let maxR = 0;
    for (const v of touched) {
      maxR = Math.max(maxR, Math.hypot(...mesh.positions.subarray(v * 3, v * 3 + 3)));
    }
    expect(maxR).toBeGreaterThan(1);

    const { mesh: m2, grid: g2, engine: e2 } = setup();
    e2.applyDab(m2, g2, { ...center, strength: -1 }, null);
    let minR = Infinity;
    for (const v of e2.touched.view()) {
      minR = Math.min(minR, Math.hypot(...m2.positions.subarray(v * 3, v * 3 + 3)));
    }
    expect(minR).toBeLessThan(1);
  });

  it('keeps the mesh symmetric with X symmetry, including dabs that overlap the plane', () => {
    const { mesh, grid, engine, normals } = setup();
    for (const x of [0.4, 0.05, -0.2]) {
      for (const kind of ['sculpt', 'smooth'] as const) {
        const z = Math.sqrt(1 - x * x - 0.04);
        normals.update(
          mesh,
          engine.applyDab(mesh, grid, dab({ kind, x, y: 0.2, z, symmetryX: true }), null),
        );
      }
    }
    const p = mesh.positions;
    const key = (x: number, y: number, z: number) =>
      `${y.toFixed(5)},${z.toFixed(5)},${Math.abs(x).toFixed(5)}`;
    const counts = new Map<string, number>();
    for (let v = 0; v < mesh.vertexCount; v++) {
      const k = key(p[v * 3], p[v * 3 + 1], p[v * 3 + 2]);
      counts.set(k, (counts.get(k) ?? 0) + (Math.abs(p[v * 3]) < 1e-6 ? 2 : 1));
    }
    for (const c of counts.values()) expect(c % 2).toBe(0);
  });

  it('smooth reduces roughness', () => {
    const { mesh, grid, engine, normals } = setup();
    // Roughen, then smooth over the same area.
    const center = dab({ x: 0, y: 0, z: 1, radius: 0.5 });
    const touched = engine.applyDab(mesh, grid, center, null).slice();
    for (let i = 0; i < touched.length; i++) {
      if (i % 2) for (let c = 0; c < 3; c++) mesh.positions[touched[i] * 3 + c] *= 1.05;
    }
    normals.update(mesh, touched);
    const roughness = () => {
      const { neighborOffsets, neighbors } = mesh.adjacency;
      let sum = 0;
      for (const v of touched) {
        for (let k = neighborOffsets[v]; k < neighborOffsets[v + 1]; k++) {
          const u = neighbors[k];
          sum += Math.hypot(
            mesh.positions[v * 3] - mesh.positions[u * 3],
            mesh.positions[v * 3 + 1] - mesh.positions[u * 3 + 1],
            mesh.positions[v * 3 + 2] - mesh.positions[u * 3 + 2],
          );
        }
      }
      return sum;
    };
    const before = roughness();
    engine.applyDab(mesh, grid, { ...center, kind: 'smooth' }, null);
    expect(roughness()).toBeLessThan(before);
  });
});
