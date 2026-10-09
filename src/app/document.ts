import type { Mesh } from '../core/mesh';
import type { Multires } from '../core/multires';
import { applyEntry, UndoStack, type ArrayPatch, type UndoEntry } from '../core/undo';
import { Emitter } from '../tools/emitter';

/** Largest model `addLevel` will create (the plan's budget). */
export const MAX_TRIANGLES = 5_000_000;

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
}

/** What the document drives when the active mesh changes. */
export interface DocumentView {
  /** A new active mesh (level switch). */
  setMesh(mesh: Mesh): void;
  /** Vertices of the active mesh changed outside a stroke (undo, redo). */
  meshEdited(vertices: Uint32Array): void;
}

/**
 * The sculpt being edited: a multires model, the active level, and undo
 * history. Strokes on the active level arrive via `commitStroke`.
 */
export class SculptDocument {
  readonly events = new Emitter<DocumentEvents>();
  private readonly history = new UndoStack();
  private view: DocumentView | null = null;
  private active: number;
  private activeMesh: Mesh;

  constructor(
    readonly multires: Multires,
    level = multires.top,
  ) {
    this.active = level;
    multires.ensureCurrent(level);
    this.activeMesh = multires.createLevelMesh(level);
  }

  get mesh(): Mesh {
    return this.activeMesh;
  }

  get level(): number {
    return this.active;
  }

  attach(view: DocumentView): void {
    this.view = view;
  }

  levelInfo(): LevelInfo {
    const m = this.multires;
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
    k = Math.max(0, Math.min(this.multires.top, k));
    if (k === this.active) return;
    this.multires.ensureCurrent(k);
    this.active = k;
    this.activeMesh = this.multires.createLevelMesh(k);
    this.view?.setMesh(this.activeMesh);
    this.events.emit('level', this.levelInfo());
  }

  stepLevel(direction: 1 | -1): void {
    this.setLevel(this.active + direction);
  }

  /** Adds a level above the top and switches to it. Returns false if over budget. */
  addLevel(): boolean {
    if (this.levelInfo().nextTriangles === null) return false;
    this.multires.addLevel();
    this.setLevel(this.multires.top);
    return true;
  }

  commitStroke(stroke: ArrayPatch): void {
    this.history.push(this.multires.commit(this.active, stroke));
    this.emitHistory();
    this.events.emit('edited', undefined);
  }

  undo(): boolean {
    return this.step(this.history.peekUndo(), () => this.history.undo(), 'before');
  }

  redo(): boolean {
    return this.step(this.history.peekRedo(), () => this.history.redo(), 'after');
  }

  /** Mudbox behavior: undo/redo first switches to the level the stroke was made on. */
  private step(next: UndoEntry | null, pop: () => void, side: 'before' | 'after'): boolean {
    if (!next) return false;
    this.setLevel(next.level);
    pop();
    applyEntry(next, side);
    this.multires.invalidateAbove(next.level);
    // The first patch is always the stroke on the level's own positions.
    this.view?.meshEdited(next.patches[0].indices);
    this.emitHistory();
    this.events.emit('edited', undefined);
    return true;
  }

  private emitHistory(): void {
    this.events.emit('history', {
      canUndo: this.history.canUndo,
      canRedo: this.history.canRedo,
    });
  }
}
