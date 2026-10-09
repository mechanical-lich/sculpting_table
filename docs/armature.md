# Armature — Design

Status: phases 1–4 implemented (see "Implementation notes" at the end). Phase 5, posing, is next.

Naming: this is called the **armature**, after the wire frame a sculptor
builds clay on.

The armature lets you block out a figure as a tree of spheres joined by links,
turn that tree into a watertight all-quad mesh, sculpt it with the Milestone 1
and 2 tools, and later pose the sculpt using the same tree as a skeleton.

## Goals and non-goals

Goals

- Build a sphere tree in the viewport: add, move, scale, rotate and delete
  spheres, with X symmetry.
- A live, low-resolution preview of the skinned mesh while editing.
- "Make mesh": a watertight, manifold, **all-quad** base mesh that becomes
  level 0 of a multires model (docs/multires.md).
- Posing: rotate joints of the tree to pose the sculpt, keeping the sculpted
  detail.
- Skinning runs in a Worker, so a large tree never freezes the page. This is
  where the Worker setup gets built.

Non-goals for now

- Edge loops that follow the limbs (classic ring-loop skinning, which builds
  rings of quads around each link). The base mesh is grid-like; see
  "Topology choice" below.
- Re-skinning a model after it has been sculpted. The tree is a starting point
  and a skeleton, not a live modifier.
- Inverse kinematics, constraints, dual-quaternion skinning. Possible later.
- Animation. Poses are applied to the sculpt, not keyframed.

## Overview

```
 tree editor ──▶ SDF (blended round cones) ──▶ manifold surface nets ──▶ relax + project
     ▲                                                                        │
     │                                                       all-quad base mesh (level 0)
     │                                                                        ▼
  skeleton ◀──────────────── kept with the model ◀──────────── Multires + sculpting
     │
     └──▶ pose mode: skin weights ──▶ deform active level ──▶ commit like a stroke
```

## Data model

`core/armature/tree.ts`, plain typed arrays like the rest of `core/`:

```ts
interface Armature {
  count: number;
  /** x, y, z, radius per node. */
  spheres: Float32Array;
  /** Parent index per node; -1 for the root. Node 0 is always the root. */
  parent: Int32Array;
  /** Mirror partner across x = 0; a node on the plane is its own partner. */
  mirror: Int32Array;
}
```

- Arrays grow by doubling. Deleting a node compacts the arrays and remaps the
  indices, so node indices are dense and parents always come before their
  children. Skinning and posing can then walk the tree in a single pass.
- **Symmetry is part of the data.** With X symmetry on:
  - adding a child also adds its mirror child, under the parent's partner
  - moving a node moves its partner to the mirrored position
  - nodes whose center is within a small tolerance of the plane snap to
    x = 0 and are their own partner
- A **link** is the parent→child pair, so there are `count - 1` links. Links
  are both what gets skinned and the bones used for posing.
- Undo stores a snapshot of the tree per operation. Trees have hundreds of
  nodes, so a copy is a few KB. `UndoEntry` gets a `tree` variant next to the
  existing patch lists.

## Editing

Armature editing is its own document mode, next to Sculpt (and later Pose). It
has its own tray, the same way the brushes do.

| Tool       | Drag on a sphere                                                | Drag on a link               |
| ---------- | --------------------------------------------------------------- | ---------------------------- |
| **Draw**   | Adds a child at the click point on the surface; drag sizes it   | Inserts a node at that point |
| **Move**   | Moves the node; **Shift** moves its whole subtree               | Moves both end nodes         |
| **Scale**  | Drag right/up to grow; **Shift** scales the whole subtree       | —                            |
| **Rotate** | Rotates the subtree about the node's parent                     | —                            |
| **Delete** | Click to delete the node (its children re-attach to its parent) | —                            |

- **Alt stays camera-only**, as everywhere else. That's why Delete is a tool
  rather than a modifier + click. The `Delete` key also deletes the hovered
  node.
- **Picking:** exact ray-sphere and ray-round-cone tests on the CPU. Trees are
  small, so this is microseconds.
- **Dragging** moves nodes in the screen plane at their depth, like Grab.
- **A new child** starts at 70% of its parent's radius, centered on the
  parent's surface at the click point. Dragging outward moves it along the
  surface normal; dragging sideways resizes it.
- **Hotkey:** `A` toggles the skin preview. It's not browser-reserved.

### Rendering the tree

- **Spheres:** one instanced icosphere draw, with a vec4 (center, radius) and
  a state color (normal, hovered, selected, on the mirror plane) per
  instance.
- **Links:** one instanced tapered cylinder per parent→child pair, thinner
  than the spheres so the joints read clearly.
- **Preview skin:** drawn translucent over the tree while editing; `A` turns it
  on and off.
- **Pose mode:** the tree is drawn see-through over the sculpt, ignoring
  depth, so joints stay visible.

## Skinning

### 1. Field: blended round cones

Each link is a **round cone**: the convex hull of its two spheres. It has a
cheap, exact signed distance function (Inigo Quilez's `sdRoundCone`). Every
node is also included as a plain sphere, so a lone root or a leaf has volume.

The links are combined with a **smooth minimum** so joints flow into each
other instead of creasing:

```
f(p) = smin_k(d_1(p), d_2(p), ...),   k = blend · min(r_a, r_b) for each joined pair
```

Scaling the blend by the smaller radius stops thin limbs from swelling where
they meet a big torso. `blend` is a user setting ("Joint softness"), default
0.5.

**Speed:** each grid point only needs the links near it. Link bounding boxes
(grown by the blend radius) are binned into a coarse uniform grid. Points that
are no link's neighbor get a cheap upper bound and skip exact evaluation.

### 2. Surface: manifold surface nets

Sample `f` on a uniform grid and extract the zero surface with **surface
nets**, a dual method:

- one vertex per grid cell that the surface crosses
- one **quad** per grid edge that the surface crosses, joining the four cells
  around that edge

So the output is all quads, which is what Catmull-Clark and multires want.

Plain surface nets can produce non-manifold vertices where two separate
sheets pass through one cell (near-touching limbs). The fix is the **manifold
variant**:

- **Split cells into components.** For each of the 256 corner-sign cases,
  work out which crossing edges belong to the same surface patch, and give
  each patch its own vertex.
- **One fixed convention for ambiguous faces.** On a face with two diagonal
  inside corners, the contour cuts each inside corner off. A face's contour
  then depends only on that face, so the two cells sharing it always agree,
  and every cell vertex stands for one disk-shaped patch. That rules out
  non-manifold vertices.
- **The rare leftover case:** a patch can cross the same face twice in both
  neighboring cells when two surfaces nearly touch within one cell. That
  produces a non-manifold edge. It's detected after extraction, and the
  extraction retries on a finer grid (up to 3 times) before reporting the
  parts as too close together.
- **The table is derived at startup.** It's built by flood-filling corners
  for each case, so there's no hand-typed 256-entry table to get wrong.

Vertex placement: the average of the component's edge crossings, where each
crossing is linearly interpolated from `f` at the edge's two ends.

### 3. Quality: relax and project

Grid-based vertices are lumpy, so the mesh gets a few rounds of smoothing:

- **Relax:** move each vertex toward its neighbor average, keeping only the
  part of the move that slides along the surface (perpendicular to `∇f`), so
  volume isn't lost.
- **Project:** a Newton step `p ← p − f(p) ∇f / |∇f|²` back onto the surface.

About 5 rounds evens out the quad sizes and keeps the surface on the real
shape.

### 4. Resolution

- **Cell size:** `h = min(0.35 · smallest radius, extent / maxCells)`, with
  `maxCells` = 160 per axis by default. The thinnest limb then gets about 6
  cells across, enough to stay watertight. The UI warns if a sphere is
  thinner than about 3 cells.
- **Speed:** the field is evaluated on a coarse grid first (4h), and cells are
  refined only where `|f|` is small enough for the surface to be nearby. Work
  stays proportional to surface area, not volume.
- **Base size:** typically 2k–20k quads. "Make mesh" then adds multires levels
  until the model reaches about 800k triangles, like the current starter.

### 5. Symmetry

With X symmetry the result must be exactly mirror-symmetric, like every other
mesh here:

- **Grid alignment:** the grid has an odd number of cells across x, centered
  so that x = 0 runs through cell centers. Cells on the plane are their own
  mirror images.
- **The seam:** vertices of plane cells are snapped to x = 0. The seam is then
  an edge loop, so multires's mirror-safe triangulation applies at every
  level. No quad straddles the plane.
- **Exact pairs:** mirrored cells are paired by index, (i, j, k) ↔ (n−1−i, j,
  k). After relaxing, each pair is made exactly mirrored by setting
  `p_mirror = (−p.x, p.y, p.z)`. Float rounding can't break symmetry.

### Topology choice

The plan offered marching cubes or dual contouring followed by a quad remesh.
Manifold surface nets is the dual-contouring family, and it skips the remesh
step entirely because it outputs quads directly:

- **Marching cubes:** triangles, so it would need a quad remesher, which is a
  project of its own.
- **Manifold surface nets (chosen):** all quads, watertight, simple, and fast
  enough for a live preview. The quads follow the grid, not the limbs.
- **Classic ring-loop skinning:** edge loops follow the limbs, but it's hard
  to make watertight at branches. The plan already rules it out.

Grid-like topology is fine for sculpting and for multires; voxel-style
remeshing in other sculpting tools produces the same kind. A limb-aligned quad remesher
(Instant Meshes style) could be added later as an optional step, without
changing anything else.

## Worker

Skinning is the first real Worker job, so this milestone builds the shared
pieces:

- **`workers/kernel.worker.ts`:** a module Worker that runs pure `core/`
  functions. It's started with
  `new Worker(new URL('../workers/kernel.worker.ts', import.meta.url), { type: 'module' })`.
- **`app/kernel.ts`:** typed request/response on the main thread. Each job
  gets an id, and results are moved, not copied, using transferable typed
  arrays.
- **Stale jobs:** each job type keeps only its latest request, and older
  results are dropped. Dragging a sphere quickly can't pile up preview
  skinning work.
- **Shared memory:** where it helps, the allocation helper (`core/alloc.ts`)
  already makes SharedArrayBuffer-backed arrays locally. Skinning doesn't need
  it, because inputs are small and outputs are moved over once.

Skinning request and result:

```ts
interface SkinRequest {
  spheres: Float32Array; // from Armature
  parent: Int32Array;
  mirror: Int32Array;
  maxCells: number;
  blend: number;
  symmetric: boolean;
}
interface SkinResult {
  positions: Float32Array;
  quads: Uint32Array;
  cellSize: number;
  /** Nodes thinner than ~3 cells, for the UI warning. */
  thinNodes: Int32Array;
}
```

- **Preview while editing:** `maxCells` of about 64, rerun shortly after each
  edit. The target is under 50 ms for a typical figure.
- **"Make mesh":** full resolution.

Later, the level-5 pen-up commit and very large brushes can move to the same
Worker setup.

## Making the mesh

"Make mesh" (Armature mode → Sculpt mode):

1. Skin at full resolution in the Worker.
2. Build `Multires(quadTopology(quads), positions)`, then add levels up to
   about 800k triangles.
3. Replace the document's model. This is undoable: the undo entry keeps the
   previous model and the tree.
4. Keep the tree with the model as its skeleton, in the same world space.

After conversion, editing the tree changes the skeleton only, never the mesh.
To start over from the tree, there's a "Back to Armature" action, which
discards the sculpt after a confirmation.

## Posing

Pose mode works on the sculpted model, using the tree as the skeleton. A pose
is applied to the sculpt, which matches the plan's "sculpt mode freezes the
pose".

### Skin weights

The weights are computed when you enter Pose mode, against the current mesh
and tree:

1. **On the base mesh first.** For each level-0 vertex, measure the distance
   to each bone's round cone. The weight falls off smoothly with
   `distance − bone radius`. Keep the 4 strongest bones and normalize to
   sum 1.
2. **Smooth.** A few Laplacian smoothing rounds on level 0, so weights don't
   jump where two bones meet.
3. **Carry up to the active level** with the subdivision stencils, the same
   way the mask goes up. Weights stay smooth at every level.

If bone distance proves too crude (for example an arm close to the body),
upgrade to heat diffusion (Baran & Popović). That's a sparse solve on the
base mesh's few thousand vertices, so it's affordable.

### Interaction

- **Select** a node by clicking it in the see-through tree.
- **Rotate** (the default): rotates the node's subtree about its parent joint,
  in the screen plane. **Shift** twists it around the bone's own axis instead.
- **Move the root** to translate the whole figure.
- **Pose symmetry is off by default.** Poses are rarely symmetric.

### Deforming

- **While dragging:** linear blend skinning on the active level,
  `p' = Σ wᵢ Tᵢ p`, where each Tᵢ is a bone's rigid transform. Only the
  vertices the moving bones affect are recomputed, and the result streams to
  the GPU through the usual dirty chunks.
- **On release:** the deformed active level is committed exactly like a sculpt
  stroke covering those vertices (`multires.commit`). Lower levels get the
  smoothed copy, higher levels are rebuilt, and tangent-space detail rides
  along. What you see while dragging is what you get.
- **One undo step per pose drag.** Committing a whole level costs around
  200–300 ms at level 4, which is acceptable once per drag, and a candidate
  for the Worker.

### Known limitations

- **Linear blend skinning** pinches at strongly twisted joints (the "candy
  wrapper" effect). Dual-quaternion skinning is the upgrade path.
- **Masks don't apply to posing.** Partially masking a deformation tears the
  surface.

## Implementation phases

1. **Tree** (`core/armature/tree.ts`): add, move, scale, rotate and delete
   with symmetry, and compaction. Tests: mirror invariants after random
   edits, index compaction, parents before children.
2. **Editor:** Armature mode, its tray, picking, the sphere and link rendering,
   tree undo, and a starter tree (a root sphere). Verified in the browser.
3. **Skinning** (`core/armature/skin.ts`): field, manifold surface nets,
   relax and project, symmetry. Tests:
   - manifold: `buildEdgeTables` accepts the result, every edge has two faces
   - watertight genus 0 for simple trees (V − E + F = 2)
   - all quads
   - exactly mirror-symmetric
   - vertices within 0.05h of the zero surface after projection
   - the 256-case component table is consistent between neighboring cells
4. **Worker + preview + Make mesh:** the Worker setup and stale-job dropping,
   the live preview, conversion to multires. Measure preview time on a
   ~60-node humanoid.
5. **Pose mode:** weights, joint rotation, commit through multires, undo.
   Tests: weights sum to 1; a rigid rotation of a whole-mesh bone moves every
   vertex rigidly; undo restores.

## Decisions (2026-10-08)

- **Topology:** grid-like quads from manifold surface nets for v1.
- **Posing model:** apply the pose to the sculpt (commit like a stroke).
- **Deleting:** a Delete tool plus the `Delete` key on the hovered sphere.
- **New documents** open with a start dialog: Sphere (sculpt a subdivided
  sphere right away) or Armature (build from a single root sphere). Updated at
  the user's request after the original "start in Armature mode" decision.

## Implementation notes (2026-10-08)

- **Code:**
  - `core/armature/tree.ts`, `skin.ts`, `pick.ts`
  - `workers/kernel.worker.ts` and `app/kernel.ts` (the Worker and its client)
  - `tools/armatureTool.ts`
  - `gpu/armatureLayer.ts` and `armature.wgsl`
  - Armature mode in `app/document.ts`, `app/controller.ts` and the UI
- **Preview:** `A` (or the panel checkbox) shows the skin, with the tree drawn
  see-through on top. Editing still works while the preview is on, and each
  edit re-skins in the Worker; only the newest request runs.
- **Draw** sizes the new sphere by drag distance, so its radius equals how far
  you drag in the screen plane. A plain click keeps 70% of the parent's
  radius.
- **Grid size:**
  `h = max(extent / maxCells, min(0.35 · smallest radius, extent / 48))`. The
  48-cell floor keeps a single big sphere from coming out as a handful of
  quads.
- **Make mesh** subdivides to the level closest to 800k triangles (anything up
  to 2x above it).
- **Undo:** tree edits and model swaps (Make mesh, Back to Armature) share the
  stroke history. `UndoStack` is now generic over entry types.
- **Measured** (browser pane, M-series Mac):

  | Operation                                 | Time                |
  | ----------------------------------------- | ------------------- |
  | Preview skin, 11-sphere figure (64 cells) | ~117 ms, in Worker  |
  | Make mesh, 6-link figure → 805k triangles | ~250 ms end to end  |
  | Skin, 19 nodes, 160 cells (Node)          | ~380 ms, ~40k quads |

  The preview misses the 50 ms target, but it runs off the main thread and
  only the newest request runs, so editing stays smooth. Narrow-band
  evaluation inside active blocks is the next speedup if it's needed.

- **Robustness:** 40 random symmetric trees all skinned closed and manifold
  on the first attempt. The finer-grid retry exists but wasn't needed in
  testing.
