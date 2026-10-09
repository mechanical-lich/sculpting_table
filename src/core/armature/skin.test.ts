import { describe, expect, it } from 'vitest';
import { Multires } from '../multires';
import { buildEdgeTables, quadTopology } from '../subdivision';
import { EDGE_COMPONENT, skinTree, type SkinResult } from './skin';
import { addChild, createTree, type Armature } from './tree';

function stats(r: SkinResult) {
  const V = r.positions.length / 3;
  const F = r.quads.length / 4;
  const et = buildEdgeTables(quadTopology(r.quads, V));
  let open = 0;
  for (let e = 0; e < et.edgeCount; e++) if (et.edgeFaces[e * 2 + 1] < 0) open++;
  return { V, E: et.edgeCount, F, euler: V - et.edgeCount + F, open };
}

/** Quad normal (from diagonals) points away from `center`. */
function outward(r: SkinResult, center: (p: number[]) => number[]) {
  const p = r.positions;
  let bad = 0;
  for (let q = 0; q < r.quads.length; q += 4) {
    const [a, b, c, d] = [0, 1, 2, 3].map((k) => r.quads[q + k] * 3);
    const u = [p[c] - p[a], p[c + 1] - p[a + 1], p[c + 2] - p[a + 2]];
    const v = [p[d] - p[b], p[d + 1] - p[b + 1], p[d + 2] - p[b + 2]];
    const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const m = [0, 1, 2].map((k) => (p[a + k] + p[b + k] + p[c + k] + p[d + k]) / 4);
    const o = center(m);
    if (n[0] * (m[0] - o[0]) + n[1] * (m[1] - o[1]) + n[2] * (m[2] - o[2]) <= 0) bad++;
  }
  return bad;
}

function figure(): Armature {
  const t = createTree(0, 0, 0, 0.5);
  const chest = addChild(t, 0, 0, 0.8, 0, 0.45, true);
  addChild(t, chest, 0, 1.4, 0, 0.3, true);
  const arm = addChild(t, chest, 0.7, 0.85, 0, 0.18, true);
  addChild(t, arm, 1.3, 0.6, 0.1, 0.15, true);
  const leg = addChild(t, 0, 0.3, -0.7, 0, 0.22, true);
  addChild(t, leg, 0.32, -1.4, 0.05, 0.16, true);
  return t;
}

const opts = { maxCells: 64, blend: 0.5, symmetric: true };

describe('surface nets component table', () => {
  const comps = (mask: number) => {
    let n = 0;
    for (let e = 0; e < 12; e++) n = Math.max(n, EDGE_COMPONENT[mask * 12 + e] + 1);
    return n;
  };
  it('has one patch around a single inside corner', () => {
    expect(comps(1)).toBe(1);
    expect(comps(0xfe)).toBe(1);
  });
  it('separates diagonal inside corners, on a face and through the body', () => {
    expect(comps((1 << 0) | (1 << 3))).toBe(2); // face diagonal
    expect(comps((1 << 0) | (1 << 7))).toBe(2); // body diagonal
  });
  it('assigns every crossing edge and only crossing edges', () => {
    for (let mask = 1; mask < 255; mask++) {
      for (let e = 0; e < 12; e++) {
        const [a, b] = [
          [0, 1],
          [2, 3],
          [4, 5],
          [6, 7],
          [0, 2],
          [1, 3],
          [4, 6],
          [5, 7],
          [0, 4],
          [1, 5],
          [2, 6],
          [3, 7],
        ][e];
        const crossing = ((mask >> a) & 1) !== ((mask >> b) & 1);
        expect(EDGE_COMPONENT[mask * 12 + e] >= 0).toBe(crossing);
      }
    }
  });
});

describe('skinTree', () => {
  it('skins a single sphere into a closed all-quad sphere on its surface', () => {
    const r = skinTree(createTree(0, 0, 0, 1), opts);
    const s = stats(r);
    expect(s.open).toBe(0);
    expect(s.euler).toBe(2);
    for (let i = 0; i < r.positions.length; i += 3) {
      const len = Math.hypot(r.positions[i], r.positions[i + 1], r.positions[i + 2]);
      expect(Math.abs(len - 1)).toBeLessThan(0.05 * r.cellSize);
    }
    expect(outward(r, () => [0, 0, 0])).toBe(0);
  });

  it('skins a branching figure into a closed genus-0 surface', () => {
    const t = figure();
    const r = skinTree(t, opts);
    const s = stats(r);
    expect(s.open).toBe(0);
    expect(s.euler).toBe(2);
    expect(r.thinNodes.length).toBe(0);
    // Every quad faces away from the nearest node center.
    const s4 = t.spheres;
    const nearest = (m: number[]) => {
      let best = 0,
        bd = Infinity;
      for (let i = 0; i < t.count; i++) {
        const d =
          Math.hypot(m[0] - s4[i * 4], m[1] - s4[i * 4 + 1], m[2] - s4[i * 4 + 2]) - s4[i * 4 + 3];
        if (d < bd) {
          bd = d;
          best = i;
        }
      }
      return [s4[best * 4], s4[best * 4 + 1], s4[best * 4 + 2]];
    };
    expect(outward(r, nearest)).toBeLessThan(r.quads.length / 4 / 100);
  });

  it('is exactly mirror-symmetric, with the seam on x = 0', () => {
    const r = skinTree(figure(), opts);
    const p = r.positions;
    const key = (x: number, y: number, z: number) => `${x},${y},${z}`;
    const all = new Set<string>();
    for (let i = 0; i < p.length; i += 3) all.add(key(p[i], p[i + 1], p[i + 2]));
    let seam = 0;
    for (let i = 0; i < p.length; i += 3) {
      expect(all.has(key(-p[i], p[i + 1], p[i + 2]))).toBe(true);
      if (p[i] === 0) seam++;
    }
    expect(seam).toBeGreaterThan(10);
  });

  it('becomes level 0 of a multires model', () => {
    const r = skinTree(figure(), opts);
    const m = new Multires(quadTopology(r.quads, r.positions.length / 3), r.positions);
    m.addLevel();
    expect(m.levels[1].topology.faceCount).toBe(r.quads.length);
    expect(m.invariantError(1)).toBeLessThan(1e-6);
  });

  it('either skins near-touching parts cleanly or reports them', () => {
    const t = createTree(0, 0, 0, 0.4);
    // Two arms reaching toward each other in front, almost touching.
    const a = addChild(t, 0, 0.5, 0, 0.4, 0.15, true);
    addChild(t, a, 0.06, 0, 0.9, 0.12, true);
    try {
      const r = skinTree(t, opts);
      expect(stats(r).open).toBe(0);
    } catch (e) {
      expect((e as Error).message).toMatch(/too close/);
    }
  });
});
