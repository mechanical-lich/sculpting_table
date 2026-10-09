import type { Mesh } from '../core/mesh';
import { Multires } from '../core/multires';
import { quadTopology } from '../core/subdivision';
import {
  applyEntry,
  entryBytes,
  UndoStack,
  wholeArrayPatch,
  type ArrayPatch,
  type UndoEntry,
} from '../core/undo';
import { cloneTree, createTree, type Armature } from '../core/armature/tree';
import { Emitter } from '../tools/emitter';

/** Largest model `addLevel` will create (the plan's budget). */
export const MAX_TRIANGLES = 5_000_000;
/** "Make mesh" subdivides the skinned base until it has about this many triangles. */
export const MAKE_MESH_TRIANGLES = 800_000;

/** Armature: building the tree. Sculpt: sculpting the mesh made from it. */
export type DocumentMode = 'armature' | 'sculpt';

export interface LevelInfo {
  level: number;
  top: number;
  triangles: number;
  vertices: number;
  /** Triangles a new level would have, or null if it would exceed the budget. */
  nextTriangles: number | null;
}

export interface DocumentEvents extends Record<string, unknown> {
  level: LevelInfo;
  history: { canUndo: boolean; canRedo: boolean };
  /** The model changed (stroke, undo, redo). */
  edited: undefined;
  mode: DocumentMode;
  /** The tree object was replaced (undo/redo of a tree edit). */
  tree: undefined;
}

/** What the document drives when the active mesh changes. */
export interface DocumentView {
  /** A new active mesh (level switch, or a new model). */
  setMesh(mesh: Mesh): void;
  /** Vertices of the active mesh changed outside a stroke (undo, redo). */
  meshEdited(vertices: Uint32Array): void;
  /** Mask values of the active mesh changed outside a stroke. */
  maskEdited(vertices: Uint32Array): void;
}

export type MaskCommand = 'invert' | 'clear' | 'all';

/** Everything "Make mesh" and "Back to Armature" swap, for undo. */
interface ModelState {
  multires: Multires;
  level: number;
  maskLevel: number;
  mode: DocumentMode;
}

type HistoryEntry =
  | { kind: 'patch'; entry: UndoEntry }
  | { kind: 'tree'; before: Armature; after: Armature }
  | { kind: 'model'; before: ModelState; after: ModelState };

function historyBytes(e: HistoryEntry): number {
  if (e.kind === 'patch') return entryBytes(e.entry);
  if (e.kind === 'tree') return (e.before.count + e.after.count) * 24;
  // Count the model kept for undo, so old models are dropped first.
  const levels = e.before.multires.levels;
  return levels.reduce((n, l) => n + l.topology.vertexCount * 40, 0);
}

/**
 * The sculpt being edited: an armature, the multires model made from it,
 * the active level, and one undo history for all of it.
 */
export class SculptDocument {
  readonly events = new Emitter<DocumentEvents>();
  private readonly history = new UndoStack<HistoryEntry>(historyBytes);
  private view: DocumentView | null = null;
  private model: Multires;
  private active: number;
  private activeMesh: Mesh;
  private currentMode: DocumentMode;
  private currentTree: Armature;
  /**
   * The level whose mask is authoritative: where it was last edited. Other
   * levels get their mask carried from here on a switch, so visiting a lower
   * level and coming back doesn't blur a mask painted at a higher one.
   */
  private maskLevel: number;

  constructor(
    multires: Multires,
    options: { level?: number; mode?: DocumentMode; tree?: Armature } = {},
  ) {
    this.model = multires;
    this.active = options.level ?? multires.top;
    this.maskLevel = this.active;
    this.currentMode = options.mode ?? 'sculpt';
    this.currentTree = options.tree ?? createTree(0, 0, 0, 0.6);
    multires.ensureCurrent(this.active);
    this.activeMesh = multires.createLevelMesh(this.active);
  }

  get multires(): Multires {
    return this.model;
  }

  get mesh(): Mesh {
    return this.activeMesh;
  }

  get level(): number {
    return this.active;
  }

  get mode(): DocumentMode {
    return this.currentMode;
  }

  get tree(): Armature {
    return this.currentTree;
  }

  attach(view: DocumentView): void {
    this.view = view;
  }

  levelInfo(): LevelInfo {
    const m = this.model;
    const topFaces = m.levels[m.top].topology.faceVerts.length;
    // Every side of every face becomes a quad, i.e. two triangles.
    const next = topFaces * 2;
    return {
      level: this.active,
      top: m.top,
      triangles: this.activeMesh.triangleCount,
      vertices: this.activeMesh.vertexCount,
      nextTriangles: next <= MAX_TRIANGLES ? next : null,
    };
  }

  setLevel(k: number): void {
    k = Math.max(0, Math.min(this.model.top, k));
    if (k === this.active) return;
    this.model.ensureCurrent(k);
    // The mask follows you between levels.
    this.model.transferMask(this.maskLevel, k);
    this.active = k;
    this.activeMesh = this.model.createLevelMesh(k);
    this.view?.setMesh(this.activeMesh);
    this.events.emit('level', this.levelInfo());
  }

  stepLevel(direction: 1 | -1): void {
    this.setLevel(this.active + direction);
  }

  /** Adds a level above the top and switches to it. Returns false if over budget. */
  addLevel(): boolean {
    if (this.levelInfo().nextTriangles === null) return false;
    this.model.addLevel();
    this.setLevel(this.model.top);
    return true;
  }

  // --- sculpting -----------------------------------------------------------------

  /** A finished stroke on the active level: a sculpt (positions) or a mask stroke. */
  commitStroke(stroke: ArrayPatch, kind: 'sculpt' | 'mask' = 'sculpt'): void {
    if (kind === 'mask') {
      this.push({ kind: 'patch', entry: { level: this.active, mask: true, patches: [stroke] } });
      this.maskLevel = this.active;
    } else {
      this.push({ kind: 'patch', entry: this.model.commit(this.active, stroke) });
    }
  }

  /** Whole-mask edits on the active level, undoable. */
  maskCommand(cmd: MaskCommand): void {
    const mask = this.activeMesh.mask;
    const before = mask.slice();
    if (cmd === 'clear') mask.fill(0);
    else if (cmd === 'all') mask.fill(1);
    else for (let i = 0; i < mask.length; i++) mask[i] = 1 - mask[i];
    const patch = wholeArrayPatch(mask, 1, before);
    this.maskLevel = this.active;
    this.view?.maskEdited(patch.indices);
    this.push({ kind: 'patch', entry: { level: this.active, mask: true, patches: [patch] } });
  }

  // --- Armature ------------------------------------------------------------------

  /** Records a tree edit (the tree has already changed in place). */
  commitTree(before: Armature): void {
    this.push({ kind: 'tree', before, after: cloneTree(this.currentTree) });
  }

  /**
   * Replaces the model with a multires built from a skinned base mesh,
   * subdivided to about `MAKE_MESH_TRIANGLES`, and switches to Sculpt mode.
   */
  makeMesh(positions: Float32Array, quads: Uint32Array): void {
    const multires = new Multires(quadTopology(quads, positions.length / 3), positions);
    let triangles = quads.length / 2;
    // Stop at the level closest to the target (on a log scale: within 2x above it).
    while (triangles * 4 <= MAKE_MESH_TRIANGLES * 2 && triangles * 4 <= MAX_TRIANGLES) {
      multires.addLevel();
      triangles *= 4;
    }
    const before = this.modelState();
    const after: ModelState = {
      multires,
      level: multires.top,
      maskLevel: multires.top,
      mode: 'sculpt',
    };
    this.applyModel(after);
    this.push({ kind: 'model', before, after });
  }

  /** Back to editing the tree. Undoable; the sculpt is kept in the history. */
  backToArmature(): void {
    if (this.currentMode === 'armature') return;
    const before = this.modelState();
    const after = { ...before, mode: 'armature' as const };
    this.applyModel(after);
    this.push({ kind: 'model', before, after });
  }

  // --- history -------------------------------------------------------------------

  undo(): boolean {
    return this.step(this.history.peekUndo(), () => this.history.undo(), 'before');
  }

  redo(): boolean {
    return this.step(this.history.peekRedo(), () => this.history.redo(), 'after');
  }

  private step(next: HistoryEntry | null, pop: () => void, side: 'before' | 'after'): boolean {
    if (!next) return false;
    if (next.kind === 'tree') {
      pop();
      this.currentTree = cloneTree(side === 'before' ? next.before : next.after);
      this.events.emit('tree', undefined);
    } else if (next.kind === 'model') {
      pop();
      this.applyModel(side === 'before' ? next.before : next.after);
    } else {
      // Mudbox behavior: first switch to the level the stroke was made on.
      const e = next.entry;
      this.setLevel(e.level);
      pop();
      applyEntry(e, side);
      if (e.mask) {
        this.maskLevel = e.level;
        this.view?.maskEdited(e.patches[0].indices);
      } else {
        this.model.invalidateAbove(e.level);
        // The first patch is always the stroke on the level's own positions.
        this.view?.meshEdited(e.patches[0].indices);
      }
    }
    this.emitHistory();
    this.events.emit('edited', undefined);
    return true;
  }

  private push(e: HistoryEntry): void {
    this.history.push(e);
    this.emitHistory();
    this.events.emit('edited', undefined);
  }

  private modelState(): ModelState {
    return {
      multires: this.model,
      level: this.active,
      maskLevel: this.maskLevel,
      mode: this.currentMode,
    };
  }

  private applyModel(s: ModelState): void {
    const changedModel = s.multires !== this.model || s.level !== this.active;
    this.model = s.multires;
    this.active = s.level;
    this.maskLevel = s.maskLevel;
    if (changedModel) {
      this.model.ensureCurrent(s.level);
      this.activeMesh = this.model.createLevelMesh(s.level);
      this.view?.setMesh(this.activeMesh);
      this.events.emit('level', this.levelInfo());
    }
    if (s.mode !== this.currentMode) {
      this.currentMode = s.mode;
      this.events.emit('mode', s.mode);
    }
  }

  private emitHistory(): void {
    this.events.emit('history', {
      canUndo: this.history.canUndo,
      canRedo: this.history.canRedo,
    });
  }
}
