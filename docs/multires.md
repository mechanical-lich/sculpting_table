# Multires — Design

Status: phases 1–3 implemented (see "Implementation notes" at the end).
Phases 4–5 are open.

Multires keeps one model at several subdivision levels and lets the user
sculpt on any of them. Big forms go on low levels, fine detail on high ones,
and editing a low level carries the high-level detail along with it.

## Goals and non-goals

Goals

- Catmull-Clark levels 0..L on a quad-dominant base mesh, up to ~5M triangles
  at the top level (the plan's budget).
- Sculpt on any level with the existing Milestone 1 brush pipeline, unchanged.
- Edits propagate both ways:
  - down: lower levels show a smoothed version of high-level edits.
  - up: higher levels keep their detail on top of low-level edits.
- Detail follows the surface when lower levels bend (tangent-space storage).
- Sparse, exact undo across levels.
- A data layout that sculpt layers (Milestone 4) and Workers can build on.

Non-goals for now

- Limit-surface evaluation, creases and sharp edges, adaptive subdivision.
- Rebuilding lower levels for a mesh that has none (needs retopology).
- OpenSubdiv or other WASM libraries. Plain TypeScript first, as in `core/`.

## Model

Notation: `P_k` = vertex positions at level k, `S` = one Catmull-Clark step,
`F(q)` = the tangent frame at a vertex of the smooth surface `q`.

Source of truth: the base positions `P_0` and one displacement array per
level, `D_1 .. D_L` (xyz per vertex, in tangent space).

Every level is derived from the one below:

```
Q_k = S(P_{k-1})            smooth positions: what subdivision alone gives
P_k = Q_k + F(Q_k) · D_k    actual positions: smooth surface plus stored detail
```

This relation (call it **I1**) must hold for every level after every
operation. `P_k` and `Q_k` are caches: they can always be rebuilt from `P_0`
and the `D`s. All tests check I1.

```
 P_0 ──S──▶ Q_1 ──(+D_1)──▶ P_1 ──S──▶ Q_2 ──(+D_2)──▶ P_2 ──▶ … P_L
 base        smooth          L1         smooth          L2
```

Only the active level is displayed, as in Mudbox. Other levels can be out of
date until the user switches to them (see Propagation up).

## Topology

### Per-level tables

Level 0 may hold n-gons: ZSphere skinning (Milestone 3) gives a quad-dominant
mesh, and imports can contain triangles. After one Catmull-Clark step every
face is a quad. So:

- Level 0: polygon faces in CSR form (`faceOffsets`, `faceVerts`).
- Levels ≥ 1: `quads: Uint32Array` (4 per face, CCW from outside).

For every level that has a level above it, build refinement tables:

| Array        | Per  | Contents                                     |
| ------------ | ---- | -------------------------------------------- |
| `edges`      | edge | 2 vertex ids                                 |
| `faceEdges`  | face | edge id per side; side i joins v_i → v_{i+1} |
| `edgeFaces`  | edge | 2 face ids, -1 on a boundary                 |
| vertex→edges | CSR  | incident edges, with valence and boundary    |
| vertex→faces | CSR  | incident faces                               |

Edges are found once per level by sorting `(min, max)` vertex pairs. This
answers the open question about half-edge vs CSR: **CSR plus edge tables is
enough**, and we don't need a full half-edge structure. Catmull-Clark only
asks about face↔edge↔vertex incidence, and never needs to walk around a face
or vertex in order.

### Child numbering

Children of level k are numbered implicitly, so we never store a
parent/child map:

```
[0, V)            vertex children   (child v = parent vertex v)
[V, V + E)        edge children     (child V + e = parent edge e)
[V + E, V + E + F) face children    (child V + E + f = parent face f)
```

Child quads of parent face f, for each corner i, with `e_i` joining
`v_i → v_{i+1}`:

```
(v_i,  V + e_i,  V + E + f,  V + e_{i-1})
```

This keeps CCW winding. Counts: `V' = V + E + F`, `F' = Σ sides(f)`,
`E' = 2E + Σ sides(f)`.

### Stencils

Standard Catmull-Clark. On a closed mesh only the interior rules apply; the
boundary rules are there for imported open meshes.

- Face point: average of the face's vertices.
- Edge point: `(v0 + v1 + f0 + f1) / 4`. Boundary: `(v0 + v1) / 2`.
- Vertex point, valence n: `(F + 2R + (n - 3)P) / n`, where F is the average
  of adjacent face points and R is the average of adjacent edge midpoints.
  Boundary: `(b0 + 6P + b1) / 8`.

### Triangulation for rendering and brushes

Each level's `Mesh` (Milestone 1 type) is built from its quads, with two
triangles per quad. The diagonal uses the same mirror-invariant rule as
`createQuadSphere`, generalized from lattice coordinates to positions at the
moment the level is created: it passes through the corner with the smallest
`(|x|, y, z)` key. With a symmetric base and an even segment count, the x = 0
seam stays an edge loop at every level, because Catmull-Clark preserves edge
loops. No quad straddles the plane, so every level stays exactly
mirror-symmetric.

## Tangent frames

`F(Q_k)` at vertex c, computed from the smooth positions `Q_k`:

- **Normal:** the area-weighted vertex normal of `Q_k` over c's level-k faces.
- **Tangent:** the direction to a fixed reference neighbor, projected into the
  tangent plane and normalized. The reference is chosen from the child
  numbering, so it never changes:
  - vertex child: the edge child of its first incident edge
  - edge child: the vertex child of the edge's first endpoint
  - face child: the edge child of the face's first side
- **Bitangent:** `n × t`.
- **Degenerate case** (reference edge parallel to n): fall back to the next
  neighbor.

Converting between world and tangent space uses the same frame both ways, so
any consistent choice of frame reproduces `P_k` exactly. The frame only
decides how detail moves when the surface under it deforms. Mirrored vertices
don't necessarily pick mirrored reference neighbors. Under rigid bending
that's harmless, and under strong shear it can cause a tiny asymmetry. If that
turns out to be visible, make the reference choice mirror-aware.

## Sculpting on level k

The brush pipeline doesn't change. `SculptTool` drives the level-k `Mesh`, so
its positions are the `P_k` cache. Multires does nothing during the stroke,
so there's no cost per dab.

At stroke end, `StrokeRecorder.end` already returns the touched vertices with
their before and after positions. That's exactly `ΔP_k`. Multires then
commits the stroke:

1. **Restrict down.** For k−1 down to 0, turn `ΔP_j` into `ΔP_{j-1}`. Use the
   transpose of the subdivision stencils, normalized:

   ```
   ΔP_{j-1}[v] = Σ_c w(c, v) · ΔP_j[c]  /  Σ_c w(c, v)
   ```

   `w(c, v)` is v's coefficient in child c's stencil. The children c are v's
   vertex child plus the edge children and face children around v, so this
   stays local. The numerator is a scatter over only the changed children. The
   denominator sums over **all** of v's children, and depends only on topology
   (precompute it per level). Normalizing over all children means one touched
   child moves v only a fraction of the way, which is what makes the result a
   smoothed copy. A uniform translation passes through unchanged, because
   Catmull-Clark is affine-invariant.

2. **Update the caches.** Add `ΔP_{j-1}` to the `P_{j-1}` cache, and to `P_0`
   when j−1 = 0.

3. **Re-displace.** Level j's positions are fixed: they are what the user
   sculpted, or what the step above already settled. Their smooth parent
   moved, so recompute `Q_j` and `D_j = F(Q_j)⁻¹ (P_j − Q_j)`. Do this for
   every child whose stencil includes a moved parent, plus one more ring,
   because frames depend on neighboring `Q`. That restores I1 at level j,
   with `P_j` unchanged.

4. **Mark dirty.** Mark levels above k dirty from the changed region of
   level k.

The sculpted level ends up exactly as the user left it. Each level below
holds a progressively smoother copy of the edit, and the high frequencies end
up in the `D`s. Each step down touches about a quarter as many vertices, so
the whole commit costs about 1⅓ times the stroke's own vertex count.

Sculpting on level 0 skips steps 1–3.

## Propagation up (switching levels)

Switching from level k to level m > k rebuilds `P_{k+1} .. P_m` with I1:
`Q = S(P)`, frame, add `D`.

- **Phase 1:** a full recompute of each dirty level on switch. Simple and
  obviously correct. Measure it, with a target of < 150 ms to reach the top
  level.
- **Phase 2, only if Phase 1 is too slow:** recompute only the dirty region.
  Each level keeps a dirty-vertex list, and the region grows by the stencil
  support at each step up.

Switching down needs no work, because commits keep lower levels current.

On switch, the active level's `Mesh` gets triangle indices, adjacency and
normals (built from its quads; the CSR build took about 24 ms at 500k
triangles). `SculptTool` gets a `setMesh` that rebuilds its grid, engine,
normal updater and recorder, and the renderer gets the new mesh. Inactive
levels drop their `Mesh` extras to save memory.

## Adding and removing levels

- **Add level (Mudbox: Shift+D):** build the refinement tables for the
  current top level, set `P_{L+1} = S(P_L)`, `D_{L+1} = 0`, and switch to it.
  Show the resulting triangle count beforehand, and refuse past the memory
  budget.
- **Delete higher levels:** drop the arrays. Lower levels are already
  current.
- **Step level:** Page Up / Page Down, as in Mudbox.

## Undo

A commit modifies several arrays, so `UndoEntry` becomes a list of sparse
patches:

```ts
interface ArrayPatch {
  target: Float32Array; // P_j cache, D_j, or P_0
  indices: Uint32Array;
  before: Float32Array;
  after: Float32Array;
}
interface UndoEntry {
  level: number; // level the stroke was made on
  patches: ArrayPatch[];
}
```

Recording these is exact and simple. Replaying the commit backwards would be
neither, because frames are non-linear. Undo and redo write the patches, mark
levels above `level` dirty, and switch to `level` if needed (Mudbox behavior).
The patches for lower levels add about a third to the size of each stroke's
undo data. `UndoStack` stays the same apart from the entry type and its byte
count.

## Starter mesh

The Milestone 1 sphere (204 segments) is too dense to be a base, because one
step up is already 2M triangles. Replace it with a 16-segment quad sphere
(1,536 quads) plus subdivision levels:

| Level | Quads     | Triangles | Vertices  |
| ----- | --------- | --------- | --------- |
| 0     | 1,536     | 3,072     | 1,538     |
| 1     | 6,144     | 12,288    | 6,146     |
| 2     | 24,576    | 49,152    | 24,578    |
| 3     | 98,304    | 196,608   | 98,306    |
| 4     | 393,216   | 786,432   | 393,218   |
| 5     | 1,572,864 | 3,145,728 | 1,572,866 |

Start at level 4 with levels 0–4 built. Level 5 is one Shift+D away. Level 6
(12.6M triangles) exceeds the budget.

## Memory

Approximate bytes per vertex:

- **Active level, about 150 B:** positions, normals, `D`, triangle indices,
  face normals, CSR adjacency, quads.
- **Inactive level, about 40 B:** `P` cache, `D`, quads.
- **Refinement tables, about 50 B more** on every level that has one above it.

Sculpting at level 5 of the starter: ~240 MB for level 5, plus ~35 MB for
level 4, plus small change, so ~280 MB before undo history. A 5M-triangle top
level would be ~400 MB. That's fine on desktop Chrome, but undo's 512 MB
budget should probably become a fraction of what's left. If memory gets
tight, drop face normals first: they're a speed cache for normal updates.

## Workers and SharedArrayBuffer

Heavy work that should leave the main thread:

- adding a level
- upward propagation on switch
- later, applying large dabs (the Milestone 1 gap: a 250 px brush costs
  ~25 ms per dab)

Options:

1. **SharedArrayBuffer.** Workers and the main thread share the level arrays
   with no copying. It needs cross-origin isolation (COOP/COEP response
   headers) from both the dev server and the eventual host.
2. **Transferable ArrayBuffers.** Ownership ping-pongs between threads. No
   headers are needed, but the main thread can't read an array while a worker
   has it.

Recommendation: plan for SharedArrayBuffer, phase it in.

- Allocate every multires array through one `allocFloat32` / `allocUint32`
  helper. It returns SAB-backed arrays when `crossOriginIsolated` is true and
  plain ones otherwise.
- Phase 1 runs on the main thread.
- Moving work to Workers later is then a scheduling change, not a data
  change.
- Add the COOP/COEP headers to the Vite config now. Nothing we load is
  cross-origin, so they break nothing.

## Implementation phases

1. **Topology + subdivision** (`core/subdivision.ts`): tables, child
   numbering, stencils with boundary rules, triangulation. Tests:
   - counts and Euler characteristic preserved
   - known cube values: the corner of a [-1, 1]³ cube goes to
     `(5/9, 5/9, 5/9)`, the edge between (1,1,1) and (1,1,−1) goes to
     `(3/4, 3/4, 0)`, and face points are face centers
   - mirror symmetry preserved across levels
   - n-gon and boundary bases
2. **Multires container** (`core/multires.ts`): levels, I1, frames, add
   level, full upward rebuild, `setActive`. `SculptTool.setMesh`, renderer
   switch, level hotkeys, a level indicator in the UI. New starter mesh.
   Tests: I1 holds after build and after random edits to `D`.
3. **Stroke commit and undo:** restriction, re-displace, patch-based undo.
   Tests:
   - a sculpt at level k leaves `P_k` exactly as sculpted
   - I1 holds at every level after random strokes at random levels
   - a bump at level k shows at k−1 with smaller, nonzero amplitude
   - undo/redo round-trips every array across levels
4. **Measure and optimize:** level-switch time at level 5, commit time for
   large strokes. Incremental upward propagation if needed.
5. **Workers:** move adding a level and upward propagation to a Worker,
   behind the allocation helper.

The brushes (Grab, Pinch, Flatten, etc.) can start alongside phase 2, because
they only touch `BrushEngine`.

## Decisions (2026-10-08)

- **Hosting:** DigitalOcean eventually, but for now only local testing
  matters. The Vite dev and preview servers send COOP/COEP, so
  SharedArrayBuffer is available locally. Check DigitalOcean's header support
  before deploying; the allocation helper keeps a plain-ArrayBuffer fallback
  either way.
- **Starter mesh:** level 4 of a 16-segment base (786k triangles) replaces the
  500k sphere.
- **Stepping down after high-level sculpting:** follow Mudbox. Lower levels
  show a smoothed copy of the edit (the restriction step above).

## Implementation notes (2026-10-08)

Where the code differs from the design above, and what was measured.

- **Code:** `core/subdivision.ts` (topology, stencils, triangulation),
  `core/multires.ts` (levels, frames, rebuild, commit), `core/alloc.ts`,
  `app/document.ts` (active level, undo, level switching). `UndoEntry` is now
  a list of patches, as designed.
- **Topology:** every level uses the CSR face form, including all-quad levels,
  so one code path serves both. It costs 4 B per face.
- **Every level keeps vertex→face CSR**, not just levels with a level above.
  Frames and the re-displace region need it on the level being sculpted.
- **Triangulations are cached per level** at creation (≈24 B/vertex), so a
  level's triangles, and its mirror symmetry, don't change after sculpting.
- **Tests that guard the subtle parts:** `childStencil` must reproduce
  `subdividePositions` exactly. The invariant must hold to 2e-6 after a
  commit on a mesh with random detail on every level. Deliberately breaking
  the re-displace ring, the dependents set, or the restriction normalization
  each fails at least one test.
- **Measured** (16-segment base; Node for build, browser pane for the rest):

  | Operation                             | Time        |
  | ------------------------------------- | ----------- |
  | Build base + levels 1–4               | ~85 ms      |
  | Add level 5 (3.1M triangles)          | ~440 ms     |
  | Switch up from level 1 to 4           | ~110 ms     |
  | Switch down                           | 2–30 ms     |
  | Commit at stroke end, level 4         | ~13 ms      |
  | Commit at stroke end, level 5         | 30–65 ms    |
  | CPU per frame at level 5, 60 px brush | ≤ 13 ms p95 |

  The level-5 commit is a single dropped frame at pen-up. It's the first
  thing to move to a Worker in phase 5.

- **Local only for now:** Vite sends COOP/COEP, and arrays are
  SharedArrayBuffer-backed when `crossOriginIsolated`. Not yet tried on
  DigitalOcean.
