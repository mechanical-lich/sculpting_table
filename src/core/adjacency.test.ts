import { describe, expect, it } from 'vitest';
import { buildAdjacency, createMesh } from './mesh';
import { createQuadSphere } from './quadSphere';

function neighborsOf(adj: ReturnType<typeof buildAdjacency>, v: number): number[] {
  return Array.from(
    adj.neighbors.subarray(adj.neighborOffsets[v], adj.neighborOffsets[v + 1]),
  ).sort((a, b) => a - b);
}

describe('buildAdjacency', () => {
  it('builds exact neighbors and incident triangles for a tetrahedron', () => {
    const indices = new Uint32Array([0, 2, 1, 0, 1, 3, 1, 2, 3, 2, 0, 3]);
    const adj = buildAdjacency(4, indices);
    expect(neighborsOf(adj, 0)).toEqual([1, 2, 3]);
    expect(neighborsOf(adj, 3)).toEqual([0, 1, 2]);
    for (let v = 0; v < 4; v++) {
      expect(adj.triOffsets[v + 1] - adj.triOffsets[v]).toBe(3);
      for (let k = adj.triOffsets[v]; k < adj.triOffsets[v + 1]; k++) {
        const t = adj.tris[k];
        expect(Array.from(indices.subarray(t * 3, t * 3 + 3))).toContain(v);
      }
    }
  });

  it('handles an isolated vertex', () => {
    const adj = buildAdjacency(4, new Uint32Array([0, 1, 2]));
    expect(neighborsOf(adj, 3)).toEqual([]);
    expect(adj.triOffsets[4] - adj.triOffsets[3]).toBe(0);
  });

  it('is symmetric and matches Euler characteristic on a quad sphere', () => {
    const s = createQuadSphere(8);
    const mesh = createMesh(s.positions, s.indices, s.quads);
    const adj = mesh.adjacency;
    const V = mesh.vertexCount;
    const F = mesh.triangleCount;
    const E = adj.neighbors.length / 2;
    expect(V - E + F).toBe(2);

    for (let v = 0; v < V; v++) {
      for (let k = adj.neighborOffsets[v]; k < adj.neighborOffsets[v + 1]; k++) {
        const u = adj.neighbors[k];
        expect(u).not.toBe(v);
        expect(neighborsOf(adj, u)).toContain(v);
      }
    }
  });
});
