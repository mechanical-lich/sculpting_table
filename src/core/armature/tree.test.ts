import { describe, expect, it } from 'vitest';
import {
  addChild,
  cloneTree,
  createTree,
  deleteNode,
  insertOnLink,
  isOnPlane,
  NO_MIRROR,
  rotateNodes,
  scaleNodes,
  subtree,
  translateNodes,
  validateTree,
  type Armature,
} from './tree';

const sphere = (t: Armature, i: number) => Array.from(t.spheres.subarray(i * 4, i * 4 + 4));

describe('Armature basics', () => {
  it('starts with a root on the plane', () => {
    const t = createTree(0.01, 0, 0, 1);
    expect(t.count).toBe(1);
    expect(isOnPlane(t, 0)).toBe(true);
    expect(t.spheres[0]).toBe(0);
    validateTree(t, true);
  });

  it('adds mirrored children with symmetry, single ones without', () => {
    const t = createTree(0, 0, 0, 1);
    const a = addChild(t, 0, 1, 0.5, 0, 0.5, true);
    expect(t.count).toBe(3);
    const m = t.mirror[a];
    expect(sphere(t, m)).toEqual([-1, 0.5, 0, 0.5]);
    expect(t.parent[m]).toBe(0);
    const b = addChild(t, a, 2, 0.5, 0, 0.3, false);
    expect(t.mirror[b]).toBe(NO_MIRROR);
    validateTree(t, false);
  });

  it('snaps a child near the plane onto it', () => {
    const t = createTree(0, 0, 0, 1);
    const c = addChild(t, 0, 0.05, 1, 0, 0.5, true);
    expect(t.count).toBe(2);
    expect(isOnPlane(t, c)).toBe(true);
    expect(t.spheres[c * 4]).toBe(0);
  });

  it('collects subtrees in index order', () => {
    const t = createTree(0, 0, 0, 1);
    const a = addChild(t, 0, 0, 1, 0, 0.5, false);
    const b = addChild(t, a, 0, 2, 0, 0.4, false);
    addChild(t, 0, 0, -1, 0, 0.5, false);
    const c = addChild(t, b, 0, 3, 0, 0.3, false);
    expect(subtree(t, a)).toEqual([a, b, c]);
  });
});

describe('Armature edits keep symmetry', () => {
  /** A small symmetric figure: spine on the plane, arms and legs mirrored. */
  function figure(): Armature {
    const t = createTree(0, 0, 0, 1);
    const chest = addChild(t, 0, 0, 1.5, 0, 0.8, true);
    addChild(t, chest, 0, 2.5, 0, 0.5, true); // head
    const arm = addChild(t, chest, 1.2, 1.6, 0, 0.35, true);
    addChild(t, arm, 2.2, 1.4, 0, 0.3, true);
    const leg = addChild(t, 0, 0.5, -1.2, 0, 0.4, true);
    addChild(t, leg, 0.5, -2.4, 0, 0.3, true);
    validateTree(t, true);
    return t;
  }

  it('moving, scaling and rotating a side subtree mirrors it', () => {
    const t = figure();
    const arm = 3; // first arm node (by construction above)
    expect(t.mirror[arm]).not.toBe(arm);
    const nodes = subtree(t, arm);
    translateNodes(t, nodes, 0.2, -0.1, 0.3, true);
    scaleNodes(t, nodes, 1, 1, 0, 1.3, true);
    rotateNodes(t, nodes, 0, 1.5, 0, 0, 0, 1, 0.4, true);
    validateTree(t, true);
  });

  it('keeps plane nodes on the plane when moved', () => {
    const t = figure();
    translateNodes(t, [1], 0.7, 0.2, 0, true);
    expect(t.spheres[4]).toBe(0);
    validateTree(t, true);
  });

  it('deletes a node and its partner, re-attaching children', () => {
    const t = figure();
    const arm = 3;
    const hand = subtree(t, arm)[1];
    const handPos = sphere(t, hand);
    expect(deleteNode(t, arm, true)).toBe(true);
    expect(t.count).toBe(figure().count - 2);
    validateTree(t, true);
    // The hand survives, now attached to the chest.
    let found = -1;
    for (let i = 0; i < t.count; i++) if (sphere(t, i).every((v, k) => v === handPos[k])) found = i;
    expect(found).toBeGreaterThan(0);
    expect(t.parent[found]).toBe(1);
  });

  it('refuses to delete the root', () => {
    const t = figure();
    expect(deleteNode(t, 0, true)).toBe(false);
  });

  it('inserts on mirrored links and on plane links', () => {
    const t = figure();
    const before = t.count;
    const hand = subtree(t, 3)[1];
    const n = insertOnLink(t, hand, 0.5, true); // on the arm -> hand link
    expect(t.count).toBe(before + 2);
    validateTree(t, true);
    expect(t.spheres[n * 4 + 3]).toBeCloseTo((0.35 + 0.3) / 2, 6);

    // Inserting reorders nodes, so find the head by position.
    let head = -1;
    for (let i = 0; i < t.count; i++) if (t.spheres[i * 4 + 1] === 2.5) head = i;
    const m = insertOnLink(t, head, 0.5, true); // on the spine
    expect(isOnPlane(t, m)).toBe(true);
    validateTree(t, true);
  });

  it('survives a random sequence of symmetric edits', () => {
    let seed = 42;
    const rand = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 0x100000000;
    const t = figure();
    for (let step = 0; step < 300; step++) {
      const i = Math.floor(rand() * t.count);
      const op = Math.floor(rand() * 5);
      if (op === 0)
        addChild(t, i, rand() * 4 - 2, rand() * 4 - 2, rand() - 0.5, 0.1 + rand() * 0.4, true);
      else if (op === 1)
        translateNodes(t, subtree(t, i), rand() - 0.5, rand() - 0.5, rand() - 0.5, true);
      else if (op === 2) scaleNodes(t, subtree(t, i), 0, 0, 0, 0.8 + rand() * 0.4, true);
      else if (op === 3 && t.count > 3) deleteNode(t, i, true);
      else if (i > 0) insertOnLink(t, i, rand(), true);
      validateTree(t, true);
    }
    expect(t.count).toBeGreaterThan(3);
  });

  it('clones independently', () => {
    const t = figure();
    const c = cloneTree(t);
    translateNodes(t, [3], 1, 0, 0, true);
    expect(sphere(c, 3)).not.toEqual(sphere(t, 3));
    validateTree(c, true);
  });
});
