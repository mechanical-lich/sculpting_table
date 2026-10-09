import { describe, expect, it } from 'vitest';
import { LINK_SCALE, pickTree } from './pick';
import { addChild, createTree } from './tree';

describe('pickTree', () => {
  const t = createTree(0, 0, 0, 1);
  const child = addChild(t, 0, 0, 4, 0, 1, false);

  it('hits the nearest sphere with its surface normal', () => {
    const hit = pickTree(t, 0, 0, 10, 0, 0, -1)!;
    expect(hit.kind).toBe('sphere');
    expect(hit.node).toBe(0);
    expect(hit.z).toBeCloseTo(1, 6);
    expect(hit.nz).toBeCloseTo(1, 6);
  });

  it('hits a link between spheres, reporting where along it', () => {
    const hit = pickTree(t, 0, 2, 10, 0, 0, -1)!;
    expect(hit.kind).toBe('link');
    expect(hit.node).toBe(child);
    expect(hit.s).toBeCloseTo(0.5, 2);
    expect(hit.z).toBeCloseTo(LINK_SCALE, 2);
  });

  it('misses empty space', () => {
    expect(pickTree(t, 5, 2, 10, 0, 0, -1)).toBeNull();
  });
});
