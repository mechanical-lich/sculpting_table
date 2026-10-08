import { describe, expect, it } from 'vitest';
import { createMesh } from './mesh';
import { computeAllNormals, NormalUpdater } from './normals';
import { createQuadSphere } from './quadSphere';

describe('NormalUpdater', () => {
  it('produces the same normals as a full recompute after a local edit', () => {
    const s = createQuadSphere(10);
    const mesh = createMesh(s.positions, s.indices);
    const moved = new Uint32Array([5, 17, 40, 41]);
    for (const v of moved) {
      mesh.positions[v * 3] *= 1.2;
      mesh.positions[v * 3 + 1] *= 0.9;
    }
    const updater = new NormalUpdater(mesh);
    const changed = updater.update(mesh, moved);
    for (const v of moved) expect(Array.from(changed)).toContain(v);

    const partial = mesh.normals.slice();
    computeAllNormals(mesh);
    for (let i = 0; i < partial.length; i++) expect(partial[i]).toBeCloseTo(mesh.normals[i], 6);
  });
});
