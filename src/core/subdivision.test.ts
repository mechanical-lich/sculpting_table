import { describe, expect, it } from 'vitest';
import { createMesh } from './mesh';
import { createQuadSphere } from './quadSphere';
import {
  buildEdgeTables,
  childStencil,
  isAllQuads,
  quadTopology,
  refineTopology,
  Stencil,
  subdividePositions,
  triangulate,
  type PolyTopology,
} from './subdivision';

/** [-1, 1]^3 cube, quads counter-clockwise from outside. */
function cube(): { positions: Float32Array; topo: PolyTopology } {
  const positions = new Float32Array([
    -1, -1, -1, 1, -1, -1, 1, 1, -1, -1, 1, -1, -1, -1, 1, 1, -1, 1, 1, 1, 1, -1, 1, 1,
  ]);
  const quads = new Uint32Array([
    0,
    3,
    2,
    1, // -z
    4,
    5,
    6,
    7, // +z
    0,
    1,
    5,
    4, // -y
    3,
    7,
    6,
    2, // +y
    0,
    4,
    7,
    3, // -x
    1,
    2,
    6,
    5, // +x
  ]);
  return { positions, topo: quadTopology(quads, 8) };
}

function polyTopology(faces: number[][], vertexCount: number): PolyTopology {
  const faceOffsets = new Uint32Array(faces.length + 1);
  faces.forEach((f, i) => (faceOffsets[i + 1] = faceOffsets[i] + f.length));
  return {
    vertexCount,
    faceCount: faces.length,
    faceOffsets,
    faceVerts: new Uint32Array(faces.flat()),
  };
}

function vertexAt(p: Float32Array, v: number): number[] {
  return [p[v * 3], p[v * 3 + 1], p[v * 3 + 2]];
}

function subdivide(topo: PolyTopology, p: Float32Array) {
  const et = buildEdgeTables(topo);
  return { et, topo: refineTopology(topo, et), positions: subdividePositions(topo, et, p) };
}

describe('buildEdgeTables', () => {
  it('finds the 12 edges of a cube with two faces each', () => {
    const { topo } = cube();
    const et = buildEdgeTables(topo);
    expect(et.edgeCount).toBe(12);
    for (let e = 0; e < 12; e++) {
      expect(et.edgeFaces[e * 2 + 1]).toBeGreaterThanOrEqual(0);
      expect(et.edges[e * 2]).toBeLessThan(et.edges[e * 2 + 1]);
    }
    for (let v = 0; v < 8; v++) {
      expect(et.vertexEdgeOffsets[v + 1] - et.vertexEdgeOffsets[v]).toBe(3);
      expect(et.vertexFaceOffsets[v + 1] - et.vertexFaceOffsets[v]).toBe(3);
    }
  });

  it('maps every side to the edge joining its endpoints', () => {
    const { topo } = cube();
    const et = buildEdgeTables(topo);
    for (let f = 0; f < topo.faceCount; f++) {
      for (let i = 0; i < 4; i++) {
        const a = topo.faceVerts[f * 4 + i],
          b = topo.faceVerts[f * 4 + ((i + 1) % 4)];
        const e = et.sideEdges[f * 4 + i];
        expect([et.edges[e * 2], et.edges[e * 2 + 1]]).toEqual([Math.min(a, b), Math.max(a, b)]);
      }
    }
  });

  it('marks boundary edges on an open mesh', () => {
    const et = buildEdgeTables(quadTopology(new Uint32Array([0, 1, 2, 3]), 4));
    expect(et.edgeCount).toBe(4);
    for (let e = 0; e < 4; e++) expect(et.edgeFaces[e * 2 + 1]).toBe(-1);
  });

  it('rejects non-manifold edges', () => {
    const t = polyTopology(
      [
        [0, 1, 2],
        [1, 0, 3],
        [0, 1, 4],
      ],
      5,
    );
    expect(() => buildEdgeTables(t)).toThrow(/Non-manifold/);
  });
});

describe('Catmull-Clark', () => {
  it('matches known values on a cube', () => {
    const { positions, topo } = cube();
    const { et, positions: p1 } = subdivide(topo, positions);
    // Corner (1, 1, 1) -> (5/9, 5/9, 5/9).
    for (const c of vertexAt(p1, 6)) expect(c).toBeCloseTo(5 / 9, 6);
    // Edge (1, 1, 1)-(1, 1, -1) -> (3/4, 3/4, 0).
    let found = false;
    for (let e = 0; e < et.edgeCount; e++) {
      if (et.edges[e * 2] === 2 && et.edges[e * 2 + 1] === 6) {
        const [x, y, z] = vertexAt(p1, 8 + e);
        expect([x, y, z].map((c) => +c.toFixed(6))).toEqual([0.75, 0.75, 0]);
        found = true;
      }
    }
    expect(found).toBe(true);
    // Face points are face centers; +x face is face 5.
    const [x, y, z] = vertexAt(p1, 8 + 12 + 5);
    expect([x, y, z].map((c) => +c.toFixed(6))).toEqual([1, 0, 0]);
  });

  it('gives V + E + F children and keeps Euler characteristic over several levels', () => {
    let { positions, topo } = cube();
    for (let level = 0; level < 4; level++) {
      const et = buildEdgeTables(topo);
      const next = refineTopology(topo, et);
      expect(next.vertexCount).toBe(topo.vertexCount + et.edgeCount + topo.faceCount);
      expect(isAllQuads(next)).toBe(true);
      positions = subdividePositions(topo, et, positions);
      topo = next;
      const e2 = buildEdgeTables(topo);
      expect(topo.vertexCount - e2.edgeCount + topo.faceCount).toBe(2);
    }
  });

  it('keeps outward winding', () => {
    let { positions, topo } = cube();
    for (let i = 0; i < 2; i++) ({ topo, positions } = subdivide(topo, positions));
    const mesh = createMesh(positions, triangulate(topo, positions));
    for (let t = 0; t < mesh.triangleCount; t++) {
      const a = mesh.indices[t * 3] * 3;
      const dot =
        mesh.faceNormals[t * 3] * positions[a] +
        mesh.faceNormals[t * 3 + 1] * positions[a + 1] +
        mesh.faceNormals[t * 3 + 2] * positions[a + 2];
      expect(dot).toBeGreaterThan(0);
    }
  });

  it('turns n-gons into quads (pentagonal prism)', () => {
    const p: number[] = [];
    for (const z of [-1, 1]) {
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * Math.PI * 2;
        p.push(Math.cos(a), Math.sin(a), z);
      }
    }
    const faces = [
      [4, 3, 2, 1, 0],
      [5, 6, 7, 8, 9],
    ];
    for (let i = 0; i < 5; i++) faces.push([i, (i + 1) % 5, 5 + ((i + 1) % 5), 5 + i]);
    const topo = polyTopology(faces, 10);
    const { topo: t1, et } = subdivide(topo, new Float32Array(p));
    expect(isAllQuads(t1)).toBe(true);
    expect(t1.faceCount).toBe(5 + 5 + 5 * 4);
    expect(t1.vertexCount).toBe(10 + et.edgeCount + 7);
    const e1 = buildEdgeTables(t1);
    expect(t1.vertexCount - e1.edgeCount + t1.faceCount).toBe(2);
  });

  it('keeps an open planar quad planar with its corners fixed', () => {
    const topo = quadTopology(new Uint32Array([0, 1, 2, 3]), 4);
    const p0 = new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]);
    let { topo: t, positions } = subdivide(topo, p0);
    ({ topo: t, positions } = subdivide(t, positions));
    expect(t.vertexCount).toBe(25);
    for (let v = 0; v < t.vertexCount; v++) expect(positions[v * 3 + 2]).toBe(0);
    // Valence-2 boundary corners have two boundary edges: (b0 + 6P + b1) / 8 pulls them in.
    expect(vertexAt(positions, 0).every((c) => c >= 0 && c < 0.2)).toBe(true);
  });
});

describe('mirror symmetry across levels', () => {
  it('keeps positions and triangulation mirror-symmetric', () => {
    const s = createQuadSphere(4);
    let topo = quadTopology(s.quads, s.positions.length / 3);
    let positions = s.positions;
    for (let i = 0; i < 3; i++) ({ topo, positions } = subdivide(topo, positions));

    const V = topo.vertexCount;
    const key = (x: number, y: number, z: number) =>
      `${x.toFixed(4)},${y.toFixed(4)},${z.toFixed(4)}`;
    const byPos = new Map<string, number>();
    for (let v = 0; v < V; v++)
      byPos.set(key(...(vertexAt(positions, v) as [number, number, number])), v);
    const mirror = new Uint32Array(V);
    for (let v = 0; v < V; v++) {
      const [x, y, z] = vertexAt(positions, v);
      const m = byPos.get(key(-x, y, z));
      expect(m).toBeDefined();
      mirror[v] = m!;
    }

    const tris = triangulate(topo, positions);
    const set = new Set<string>();
    const tk = (a: number, b: number, c: number) => [a, b, c].sort((x, y) => x - y).join(',');
    for (let t = 0; t < tris.length; t += 3) set.add(tk(tris[t], tris[t + 1], tris[t + 2]));
    for (let t = 0; t < tris.length; t += 3) {
      expect(set.has(tk(mirror[tris[t]], mirror[tris[t + 1]], mirror[tris[t + 2]]))).toBe(true);
    }
  });
});

describe('childStencil', () => {
  function check(topo: PolyTopology, p: Float32Array) {
    const et = buildEdgeTables(topo);
    const out = subdividePositions(topo, et, p);
    const st = new Stencil();
    const count = topo.vertexCount + et.edgeCount + topo.faceCount;
    for (let c = 0; c < count; c++) {
      childStencil(topo, et, c, st);
      let w = 0;
      const sum = [0, 0, 0];
      for (let i = 0; i < st.ids.length; i++) {
        const id = st.ids.data[i],
          wi = st.weights.data[i];
        w += wi;
        for (let k = 0; k < 3; k++) sum[k] += wi * p[id * 3 + k];
      }
      expect(w).toBeCloseTo(1, 6);
      for (let k = 0; k < 3; k++) expect(sum[k]).toBeCloseTo(out[c * 3 + k], 5);
    }
  }

  it('reproduces subdividePositions on a closed quad mesh', () => {
    const { positions, topo } = cube();
    check(topo, positions);
    const s = subdivide(topo, positions);
    check(s.topo, s.positions);
  });

  it('reproduces subdividePositions on open and n-gon meshes', () => {
    check(
      quadTopology(new Uint32Array([0, 1, 2, 3, 1, 4, 5, 2]), 6),
      new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 2, 0, 0.3, 2, 1, 0.1]),
    );
    const faces = [
      [0, 1, 2],
      [0, 2, 3],
      [0, 3, 1],
      [1, 3, 2],
    ];
    check(
      polyTopology(faces, 4),
      new Float32Array([0, 0, 1, 1, 0, -0.5, -0.5, 0.8, -0.5, -0.5, -0.8, -0.5]),
    );
  });
});
