import { describe, expect, it } from 'vitest';
import { createMesh } from './mesh';
import { createQuadSphere } from './quadSphere';

describe('createQuadSphere', () => {
  it('has the expected counts and lies on the sphere', () => {
    const n = 10;
    const s = createQuadSphere(n, 2);
    expect(s.positions.length / 3).toBe(6 * n * n + 2);
    expect(s.indices.length / 3).toBe(12 * n * n);
    for (let i = 0; i < s.positions.length; i += 3) {
      const r = Math.hypot(s.positions[i], s.positions[i + 1], s.positions[i + 2]);
      expect(r).toBeCloseTo(2, 5);
    }
  });

  it('winds triangles outward', () => {
    const mesh = createMesh(...(Object.values(createQuadSphere(6)) as [Float32Array, Uint32Array]));
    const p = mesh.positions;
    for (let t = 0; t < mesh.triangleCount; t++) {
      const a = mesh.indices[t * 3] * 3;
      const dot =
        mesh.faceNormals[t * 3] * p[a] +
        mesh.faceNormals[t * 3 + 1] * p[a + 1] +
        mesh.faceNormals[t * 3 + 2] * p[a + 2];
      expect(dot).toBeGreaterThan(0);
    }
  });

  it('is mirror-symmetric across x = 0, including triangulation', () => {
    const s = createQuadSphere(8);
    const key = (x: number, y: number, z: number) =>
      `${x.toFixed(6)},${y.toFixed(6)},${z.toFixed(6)}`;
    const byPos = new Map<string, number>();
    const V = s.positions.length / 3;
    for (let v = 0; v < V; v++) {
      byPos.set(key(s.positions[v * 3], s.positions[v * 3 + 1], s.positions[v * 3 + 2]), v);
    }
    const mirror = new Uint32Array(V);
    for (let v = 0; v < V; v++) {
      const m = byPos.get(key(-s.positions[v * 3], s.positions[v * 3 + 1], s.positions[v * 3 + 2]));
      expect(m).toBeDefined();
      mirror[v] = m!;
    }
    const tris = new Set<string>();
    const triKey = (a: number, b: number, c: number) => [a, b, c].sort((x, y) => x - y).join(',');
    for (let t = 0; t < s.indices.length; t += 3) {
      tris.add(triKey(s.indices[t], s.indices[t + 1], s.indices[t + 2]));
    }
    for (let t = 0; t < s.indices.length; t += 3) {
      const m = triKey(mirror[s.indices[t]], mirror[s.indices[t + 1]], mirror[s.indices[t + 2]]);
      expect(tris.has(m)).toBe(true);
    }
  });
});
