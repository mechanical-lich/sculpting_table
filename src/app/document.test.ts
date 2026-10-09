import { describe, expect, it } from 'vitest';
import { Multires } from '../core/multires';
import { createQuadSphere } from '../core/quadSphere';
import { quadTopology } from '../core/subdivision';
import { SculptDocument, type DocumentView } from './document';

function doc() {
  const s = createQuadSphere(4);
  const m = new Multires(quadTopology(s.quads, s.positions.length / 3), s.positions);
  for (let i = 0; i < 2; i++) m.addLevel();
  const d = new SculptDocument(m);
  const calls: string[] = [];
  const view: DocumentView = {
    setMesh: () => calls.push('setMesh'),
    meshEdited: () => calls.push('meshEdited'),
    maskEdited: () => calls.push('maskEdited'),
  };
  d.attach(view);
  return { d, m, calls };
}

describe('SculptDocument masks', () => {
  it('inverts, clears and fills the mask with undo and redo', () => {
    const { d, calls } = doc();
    const mask = d.mesh.mask;
    mask[0] = 0.25;
    d.maskCommand('invert');
    expect(mask[0]).toBeCloseTo(0.75);
    expect(mask[1]).toBe(1);
    d.maskCommand('clear');
    expect(mask.every((v) => v === 0)).toBe(true);
    d.maskCommand('all');
    expect(mask.every((v) => v === 1)).toBe(true);

    d.undo();
    d.undo();
    expect(mask[0]).toBeCloseTo(0.75);
    d.undo();
    expect(mask[0]).toBeCloseTo(0.25);
    d.redo();
    expect(mask[0]).toBeCloseTo(0.75);
    expect(calls.filter((c) => c === 'maskEdited').length).toBe(7);
    expect(calls).not.toContain('meshEdited');
  });

  it('keeps the mask when changing levels', () => {
    const { d } = doc();
    d.maskCommand('all');
    d.setLevel(0);
    expect(d.mesh.mask.every((v) => v === 1)).toBe(true);
    d.setLevel(2);
    expect(d.mesh.mask.every((v) => Math.abs(v - 1) < 1e-6)).toBe(true);
  });

  it('restores a mask exactly after visiting a lower level without editing', () => {
    const { d } = doc();
    // A hard-edged mask at the top level.
    const top = d.mesh;
    for (let v = 0; v < top.vertexCount; v++) top.mask[v] = top.positions[v * 3] > 0.1 ? 1 : 0;
    d.maskCommand('invert');
    d.maskCommand('invert');
    const painted = top.mask.slice();
    d.setLevel(0);
    d.setLevel(2);
    expect(d.mesh.mask).toEqual(painted);
  });

  it('does not mark higher levels stale for mask edits', () => {
    const { d, m } = doc();
    d.setLevel(1);
    d.maskCommand('all');
    d.undo();
    expect(m.levels[2].stale).toBe(false);
  });
});
