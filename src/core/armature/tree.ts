/**
 * Armature: spheres joined parent -> child. Plain typed arrays, see
 * docs/armature.md.
 *
 * Invariants (checked by `validateTree`):
 * - node 0 is the root (parent -1); every other node's parent has a lower
 *   index, so one forward pass visits parents before children
 * - `mirror` pairs nodes across x = 0: mirror[mirror[i]] === i. A node on the
 *   plane is its own partner; -1 means no partner (made without symmetry)
 */
export interface Armature {
  count: number;
  /** x, y, z, radius per node. Capacity may exceed `count`. */
  spheres: Float32Array;
  parent: Int32Array;
  mirror: Int32Array;
}

export const NO_MIRROR = -1;

/** A new node within this fraction of its radius from x = 0 snaps onto the plane. */
const PLANE_SNAP = 0.25;

export function createTree(x: number, y: number, z: number, r: number): Armature {
  const t: Armature = {
    count: 0,
    spheres: new Float32Array(16 * 4),
    parent: new Int32Array(16),
    mirror: new Int32Array(16),
  };
  const onPlane = Math.abs(x) < r * PLANE_SNAP;
  const i = rawAdd(t, -1, onPlane ? 0 : x, y, z, r);
  t.mirror[i] = onPlane ? i : NO_MIRROR;
  return t;
}

export function cloneTree(t: Armature): Armature {
  return {
    count: t.count,
    spheres: t.spheres.slice(0, t.count * 4),
    parent: t.parent.slice(0, t.count),
    mirror: t.mirror.slice(0, t.count),
  };
}

export function isOnPlane(t: Armature, i: number): boolean {
  return t.mirror[i] === i;
}

/** Nodes in i's subtree (i first), in index order. */
export function subtree(t: Armature, i: number): number[] {
  const inside = new Uint8Array(t.count);
  inside[i] = 1;
  const out = [i];
  for (let j = i + 1; j < t.count; j++) {
    if (t.parent[j] >= 0 && inside[t.parent[j]]) {
      inside[j] = 1;
      out.push(j);
    }
  }
  return out;
}

// --- edits -------------------------------------------------------------------

/**
 * Adds a child of `parent` at (x, y, z) with radius r. With symmetry, a
 * mirror child is added under the parent's partner; a child near the plane
 * of an on-plane parent snaps onto the plane instead. Returns the new node
 * (the one at the requested position).
 */
export function addChild(
  t: Armature,
  parent: number,
  x: number,
  y: number,
  z: number,
  r: number,
  symmetric: boolean,
): number {
  const pm = t.mirror[parent];
  if (!symmetric || pm === NO_MIRROR) {
    const i = rawAdd(t, parent, x, y, z, r);
    t.mirror[i] = NO_MIRROR;
    return i;
  }
  if (pm === parent && Math.abs(x) < r * PLANE_SNAP) {
    const i = rawAdd(t, parent, 0, y, z, r);
    t.mirror[i] = i;
    return i;
  }
  const i = rawAdd(t, parent, x, y, z, r);
  const j = rawAdd(t, pm, -x, y, z, r);
  t.mirror[i] = j;
  t.mirror[j] = i;
  return i;
}

/** Sets one node's sphere; with symmetry its partner (or the plane) follows. */
export function setSphere(
  t: Armature,
  i: number,
  x: number,
  y: number,
  z: number,
  r: number,
  symmetric: boolean,
): void {
  const s = t.spheres;
  s[i * 4] = x;
  s[i * 4 + 1] = y;
  s[i * 4 + 2] = z;
  s[i * 4 + 3] = r;
  if (symmetric) enforceSymmetry(t, [i]);
}

/** Moves the given nodes by (dx, dy, dz). */
export function translateNodes(
  t: Armature,
  nodes: readonly number[],
  dx: number,
  dy: number,
  dz: number,
  symmetric: boolean,
): void {
  const s = t.spheres;
  for (const i of nodes) {
    s[i * 4] += dx;
    s[i * 4 + 1] += dy;
    s[i * 4 + 2] += dz;
  }
  if (symmetric) enforceSymmetry(t, nodes);
}

/** Scales radii, and positions about `center`, by `factor`. */
export function scaleNodes(
  t: Armature,
  nodes: readonly number[],
  cx: number,
  cy: number,
  cz: number,
  factor: number,
  symmetric: boolean,
): void {
  const s = t.spheres;
  for (const i of nodes) {
    s[i * 4] = cx + (s[i * 4] - cx) * factor;
    s[i * 4 + 1] = cy + (s[i * 4 + 1] - cy) * factor;
    s[i * 4 + 2] = cz + (s[i * 4 + 2] - cz) * factor;
    s[i * 4 + 3] *= factor;
  }
  if (symmetric) enforceSymmetry(t, nodes);
}

/** Rotates node positions about `pivot` around the unit `axis` by `angle` (Rodrigues). */
export function rotateNodes(
  t: Armature,
  nodes: readonly number[],
  px: number,
  py: number,
  pz: number,
  ax: number,
  ay: number,
  az: number,
  angle: number,
  symmetric: boolean,
): void {
  const c = Math.cos(angle),
    sn = Math.sin(angle);
  const s = t.spheres;
  for (const i of nodes) {
    const vx = s[i * 4] - px,
      vy = s[i * 4 + 1] - py,
      vz = s[i * 4 + 2] - pz;
    const dot = vx * ax + vy * ay + vz * az;
    const cx = ay * vz - az * vy,
      cy = az * vx - ax * vz,
      cz = ax * vy - ay * vx;
    s[i * 4] = px + vx * c + cx * sn + ax * dot * (1 - c);
    s[i * 4 + 1] = py + vy * c + cy * sn + ay * dot * (1 - c);
    s[i * 4 + 2] = pz + vz * c + cz * sn + az * dot * (1 - c);
  }
  if (symmetric) enforceSymmetry(t, nodes);
}

/**
 * Deletes a node (and with symmetry its partner). Children re-attach to the
 * deleted node's parent. The root can't be deleted; returns false then.
 */
export function deleteNode(t: Armature, i: number, symmetric: boolean): boolean {
  if (i === 0) return false;
  const doomed = new Set([i]);
  const m = t.mirror[i];
  if (symmetric && m !== NO_MIRROR && m !== i && m !== 0) doomed.add(m);
  // Re-parent children, walking up past any doomed ancestors.
  for (let j = 0; j < t.count; j++) {
    let p = t.parent[j];
    while (p >= 0 && doomed.has(p)) p = t.parent[p];
    t.parent[j] = p;
  }
  // Partners of doomed nodes lose their partner.
  for (const d of doomed) {
    const pm = t.mirror[d];
    if (pm !== NO_MIRROR && !doomed.has(pm)) t.mirror[pm] = NO_MIRROR;
  }
  compact(t, (j) => !doomed.has(j));
  return true;
}

/**
 * Inserts a node on the link parent(child) -> child at fraction s (0 at the
 * parent), with radius interpolated. With symmetry, the partner link gets
 * one too. Returns the new node's index.
 */
export function insertOnLink(t: Armature, child: number, s: number, symmetric: boolean): number {
  const insertOne = (c: number): number => {
    const p = t.parent[c];
    const sp = t.spheres;
    const lerp = (k: number) => sp[p * 4 + k] + (sp[c * 4 + k] - sp[p * 4 + k]) * s;
    const n = rawAdd(t, p, lerp(0), lerp(1), lerp(2), lerp(3));
    t.parent[c] = n;
    return n;
  };
  const m = t.mirror[child];
  const a = insertOne(child);
  if (symmetric && m === child && isOnPlane(t, t.parent[a])) {
    t.mirror[a] = a;
    t.spheres[a * 4] = 0;
  } else if (symmetric && m !== NO_MIRROR && m !== child) {
    const b = insertOne(m);
    t.mirror[a] = b;
    t.mirror[b] = a;
    enforceSymmetry(t, [a]);
  } else {
    t.mirror[a] = NO_MIRROR;
  }
  // The new node got a higher index than its child: restore parent-first order.
  return normalizeOrder(t)[a];
}

// --- invariants --------------------------------------------------------------

/**
 * Makes the given nodes' partners exact mirror images, and puts plane nodes
 * on x = 0. When both nodes of a pair are listed, the lower index wins.
 */
export function enforceSymmetry(t: Armature, nodes: readonly number[]): void {
  const listed = new Set(nodes);
  const s = t.spheres;
  for (const i of nodes) {
    const m = t.mirror[i];
    if (m === NO_MIRROR) continue;
    if (m === i) {
      s[i * 4] = 0;
      continue;
    }
    if (listed.has(m) && m < i) continue;
    s[m * 4] = -s[i * 4];
    s[m * 4 + 1] = s[i * 4 + 1];
    s[m * 4 + 2] = s[i * 4 + 2];
    s[m * 4 + 3] = s[i * 4 + 3];
  }
}

/** Throws if an invariant is broken. For tests and debugging. */
export function validateTree(t: Armature, symmetric = false): void {
  if (t.count < 1 || t.parent[0] !== -1) throw new Error('node 0 must be the root');
  for (let i = 1; i < t.count; i++) {
    const p = t.parent[i];
    if (p < 0 || p >= i) throw new Error(`node ${i} has parent ${p}, not an earlier node`);
  }
  for (let i = 0; i < t.count; i++) {
    const m = t.mirror[i];
    if (m === NO_MIRROR) continue;
    if (m < 0 || m >= t.count || t.mirror[m] !== i)
      throw new Error(`mirror of ${i} is inconsistent`);
    if (!symmetric) continue;
    const s = t.spheres;
    const off =
      Math.abs(s[m * 4] + s[i * 4]) +
      Math.abs(s[m * 4 + 1] - s[i * 4 + 1]) +
      Math.abs(s[m * 4 + 2] - s[i * 4 + 2]) +
      Math.abs(s[m * 4 + 3] - s[i * 4 + 3]);
    if (off > 1e-5) throw new Error(`nodes ${i} and ${m} are not mirror images`);
  }
}

// --- internals ---------------------------------------------------------------

function rawAdd(t: Armature, parent: number, x: number, y: number, z: number, r: number): number {
  if (t.count === t.parent.length) grow(t, t.count * 2);
  const i = t.count++;
  t.spheres[i * 4] = x;
  t.spheres[i * 4 + 1] = y;
  t.spheres[i * 4 + 2] = z;
  t.spheres[i * 4 + 3] = r;
  t.parent[i] = parent;
  t.mirror[i] = NO_MIRROR;
  return i;
}

function grow(t: Armature, capacity: number): void {
  const s = new Float32Array(capacity * 4);
  s.set(t.spheres.subarray(0, t.count * 4));
  const p = new Int32Array(capacity);
  p.set(t.parent.subarray(0, t.count));
  const m = new Int32Array(capacity);
  m.set(t.mirror.subarray(0, t.count));
  t.spheres = s;
  t.parent = p;
  t.mirror = m;
}

/** Keeps nodes where `keep` is true, preserving order; remaps parent and mirror. */
function compact(t: Armature, keep: (i: number) => boolean): void {
  const remap = new Int32Array(t.count).fill(-1);
  let n = 0;
  for (let i = 0; i < t.count; i++) if (keep(i)) remap[i] = n++;
  const s = t.spheres;
  for (let i = 0; i < t.count; i++) {
    const j = remap[i];
    if (j < 0) continue;
    for (let k = 0; k < 4; k++) s[j * 4 + k] = s[i * 4 + k];
    t.parent[j] = t.parent[i] < 0 ? -1 : remap[t.parent[i]];
    t.mirror[j] = t.mirror[i] < 0 ? NO_MIRROR : remap[t.mirror[i]];
  }
  t.count = n;
}

/**
 * Reorders nodes breadth-first from the root so parents precede children.
 * Returns old index -> new index.
 */
function normalizeOrder(t: Armature): Int32Array {
  const n = t.count;
  const childStart = new Int32Array(n + 1);
  for (let i = 1; i < n; i++) childStart[t.parent[i] + 1]++;
  for (let i = 0; i < n; i++) childStart[i + 1] += childStart[i];
  const children = new Int32Array(Math.max(0, n - 1));
  const cursor = childStart.slice(0, n);
  for (let i = 1; i < n; i++) children[cursor[t.parent[i]]++] = i;

  const order = [0];
  for (let k = 0; k < order.length; k++) {
    const i = order[k];
    for (let c = childStart[i]; c < childStart[i + 1]; c++) order.push(children[c]);
  }
  const remap = new Int32Array(n);
  order.forEach((old, idx) => (remap[old] = idx));

  const s = t.spheres.slice(0, n * 4);
  const parent = t.parent.slice(0, n);
  const mirror = t.mirror.slice(0, n);
  for (let old = 0; old < n; old++) {
    const j = remap[old];
    for (let k = 0; k < 4; k++) t.spheres[j * 4 + k] = s[old * 4 + k];
    t.parent[j] = parent[old] < 0 ? -1 : remap[parent[old]];
    t.mirror[j] = mirror[old] < 0 ? NO_MIRROR : remap[mirror[old]];
  }
  return remap;
}
