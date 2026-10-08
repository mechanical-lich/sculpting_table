import { StampSet, type IndexList } from './lists';
import { computeBounds, maxEdgeLength, type Mesh } from './mesh';

/** Widest raycast neighborhood (in cells from center) tolerated before a rebuild. */
const MAX_NEIGHBORHOOD = 3;

/**
 * Uniform spatial hash over vertex positions. Cells are unbounded; each maps
 * to a hash bucket holding a doubly linked list of vertices, so a moved vertex
 * is re-binned in O(1) with `update`. Vertices are therefore always in the
 * cell of their current position and the grid never goes stale during a
 * stroke.
 *
 * Distinct cells can share a bucket. Queries dedupe buckets with a stamp set
 * and filter candidates by real distance, so collisions cost time, not
 * correctness.
 */
export class SpatialGrid {
  cellSize = 1;
  invCellSize = 1;

  /** Longest mesh edge seen (grown by `updateFromMesh`, never shrunk). 0 for bare points. */
  maxEdge = 0;
  /** Bounds of all vertices since the last build (grown, never shrunk). */
  minX = 0;
  minY = 0;
  minZ = 0;
  maxX = 0;
  maxY = 0;
  maxZ = 0;
  /** Set when a full rebuild is required (e.g. topology changed). */
  stale = true;
  /** Bucket visited-set, shared with `raycastMesh`. */
  readonly visited = new StampSet(0);

  private mask = 0;
  private head = new Int32Array(1);
  private next = new Int32Array(0);
  private prev = new Int32Array(0);
  private bucketOf = new Int32Array(0);
  private count = 0;

  get bucketCount(): number {
    return this.head.length;
  }

  /**
   * Builds from a mesh. Cells of ~3 edge lengths keep raycasts at a 3x3x3
   * neighborhood until edges stretch 3x, and measured fastest for brush
   * queries on the 500k starter sphere.
   */
  buildFromMesh(mesh: Mesh): void {
    const edge = maxEdgeLength(mesh);
    this.build(mesh.positions, mesh.vertexCount, edge * 3);
    this.maxEdge = edge;
  }

  build(positions: Float32Array, count: number, cellSize: number): void {
    const b = computeBounds(positions, count);
    // Keep cells from being absurdly small relative to the model.
    const extent = Math.max(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]);
    this.cellSize = Math.max(cellSize, extent / 1024, 1e-6);
    this.invCellSize = 1 / this.cellSize;
    [this.minX, this.minY, this.minZ] = b.min;
    [this.maxX, this.maxY, this.maxZ] = b.max;
    this.maxEdge = 0;
    this.stale = false;

    let buckets = 1;
    while (buckets < count * 2) buckets <<= 1;
    this.mask = buckets - 1;
    this.head = new Int32Array(buckets).fill(-1);
    this.next = new Int32Array(count);
    this.prev = new Int32Array(count);
    this.bucketOf = new Int32Array(count);
    this.count = count;
    this.visited.resize(buckets);

    for (let v = 0; v < count; v++) {
      this.insert(v, this.bucketAt(positions[v * 3], positions[v * 3 + 1], positions[v * 3 + 2]));
    }
  }

  /** Re-bins moved vertices and grows the bounds. */
  update(positions: Float32Array, vertices: Uint32Array, count = vertices.length): void {
    for (let i = 0; i < count; i++) {
      const v = vertices[i];
      const x = positions[v * 3],
        y = positions[v * 3 + 1],
        z = positions[v * 3 + 2];
      if (x < this.minX) this.minX = x;
      if (y < this.minY) this.minY = y;
      if (z < this.minZ) this.minZ = z;
      if (x > this.maxX) this.maxX = x;
      if (y > this.maxY) this.maxY = y;
      if (z > this.maxZ) this.maxZ = z;
      const b = this.bucketAt(x, y, z);
      if (b !== this.bucketOf[v]) {
        this.remove(v);
        this.insert(v, b);
      }
    }
  }

  /** `update`, plus growing `maxEdge` from the edges around the moved vertices. */
  updateFromMesh(mesh: Mesh, vertices: Uint32Array, count = vertices.length): void {
    this.update(mesh.positions, vertices, count);
    const { neighborOffsets, neighbors } = mesh.adjacency;
    const p = mesh.positions;
    let best = this.maxEdge * this.maxEdge;
    for (let i = 0; i < count; i++) {
      const v = vertices[i];
      const vx = p[v * 3],
        vy = p[v * 3 + 1],
        vz = p[v * 3 + 2];
      for (let k = neighborOffsets[v]; k < neighborOffsets[v + 1]; k++) {
        const u = neighbors[k] * 3;
        const dx = p[u] - vx,
          dy = p[u + 1] - vy,
          dz = p[u + 2] - vz;
        const d = dx * dx + dy * dy + dz * dz;
        if (d > best) best = d;
      }
    }
    this.maxEdge = Math.sqrt(best);
  }

  /**
   * How many cells out from a point a raycast must look to find a corner of
   * any triangle through that point: a point on a triangle is within the
   * longest edge of each corner.
   */
  raycastNeighborhood(): number {
    return Math.max(1, Math.ceil(this.maxEdge * this.invCellSize));
  }

  /** True when edges have stretched enough that raycasts get expensive, or topology changed. */
  needsRebuild(): boolean {
    return this.stale || this.raycastNeighborhood() > MAX_NEIGHBORHOOD;
  }

  cell(x: number): number {
    return Math.floor(x * this.invCellSize);
  }

  bucket(ix: number, iy: number, iz: number): number {
    return (
      (Math.imul(ix, 73856093) ^ Math.imul(iy, 19349663) ^ Math.imul(iz, 83492791)) & this.mask
    );
  }

  bucketAt(x: number, y: number, z: number): number {
    return this.bucket(this.cell(x), this.cell(y), this.cell(z));
  }

  /** First vertex in a bucket, or -1. */
  first(bucket: number): number {
    return this.head[bucket];
  }

  /** Next vertex in the same bucket, or -1. */
  after(v: number): number {
    return this.next[v];
  }

  /** Appends to `out` every vertex within `radius` of (cx, cy, cz). */
  queryRadius(
    positions: Float32Array,
    cx: number,
    cy: number,
    cz: number,
    radius: number,
    out: IndexList,
  ): void {
    const r2 = radius * radius;
    // Restrict the cell range to the occupied bounds.
    const x0 = this.cell(Math.max(cx - radius, this.minX)),
      x1 = this.cell(Math.min(cx + radius, this.maxX));
    const y0 = this.cell(Math.max(cy - radius, this.minY)),
      y1 = this.cell(Math.min(cy + radius, this.maxY));
    const z0 = this.cell(Math.max(cz - radius, this.minZ)),
      z1 = this.cell(Math.min(cz + radius, this.maxZ));
    if (x1 < x0 || y1 < y0 || z1 < z0) return;

    const cells = (x1 - x0 + 1) * (y1 - y0 + 1) * (z1 - z0 + 1);
    if (cells > this.count) {
      // Huge brush relative to cells: a linear scan is cheaper.
      for (let v = 0; v < this.count; v++) {
        const dx = positions[v * 3] - cx,
          dy = positions[v * 3 + 1] - cy,
          dz = positions[v * 3 + 2] - cz;
        if (dx * dx + dy * dy + dz * dz <= r2) out.push(v);
      }
      return;
    }

    this.visited.next();
    const head = this.head,
      next = this.next;
    for (let z = z0; z <= z1; z++) {
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const b = this.bucket(x, y, z);
          if (!this.visited.add(b)) continue;
          for (let v = head[b]; v >= 0; v = next[v]) {
            const dx = positions[v * 3] - cx,
              dy = positions[v * 3 + 1] - cy,
              dz = positions[v * 3 + 2] - cz;
            if (dx * dx + dy * dy + dz * dz <= r2) out.push(v);
          }
        }
      }
    }
  }

  private insert(v: number, b: number): void {
    const h = this.head[b];
    this.next[v] = h;
    this.prev[v] = -1;
    if (h >= 0) this.prev[h] = v;
    this.head[b] = v;
    this.bucketOf[v] = b;
  }

  private remove(v: number): void {
    const p = this.prev[v],
      n = this.next[v];
    if (p >= 0) this.next[p] = n;
    else this.head[this.bucketOf[v]] = n;
    if (n >= 0) this.prev[n] = p;
  }
}
