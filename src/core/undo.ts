import { FloatList, IndexList, StampSet } from './lists';
import type { Mesh } from './mesh';

/** Sparse record of one stroke: the vertices it moved, before and after. */
export interface UndoEntry {
  indices: Uint32Array;
  before: Float32Array;
  after: Float32Array;
}

/**
 * Captures the first-seen position of every vertex a stroke touches. Call
 * `capture` before modifying vertices, and `end` once the stroke is done.
 */
export class StrokeRecorder {
  private readonly seen: StampSet;
  private readonly indices = new IndexList(4096);
  private readonly before = new FloatList(4096 * 3);
  private active = false;

  constructor(vertexCount: number) {
    this.seen = new StampSet(vertexCount);
  }

  begin(): void {
    this.seen.next();
    this.indices.clear();
    this.before.clear();
    this.active = true;
  }

  capture(mesh: Mesh, vertices: Uint32Array, count = vertices.length): void {
    if (!this.active) return;
    const p = mesh.positions;
    for (let i = 0; i < count; i++) {
      const v = vertices[i];
      if (this.seen.add(v)) {
        this.indices.push(v);
        this.before.push3(p[v * 3], p[v * 3 + 1], p[v * 3 + 2]);
      }
    }
  }

  /** Finishes the stroke. Returns null if it touched nothing. */
  end(mesh: Mesh): UndoEntry | null {
    this.active = false;
    if (this.indices.length === 0) return null;
    const indices = this.indices.view().slice();
    const before = this.before.view().slice();
    const after = new Float32Array(before.length);
    const p = mesh.positions;
    for (let i = 0; i < indices.length; i++) {
      const v = indices[i] * 3;
      after[i * 3] = p[v];
      after[i * 3 + 1] = p[v + 1];
      after[i * 3 + 2] = p[v + 2];
    }
    return { indices, before, after };
  }
}

function writePositions(mesh: Mesh, indices: Uint32Array, values: Float32Array): void {
  const p = mesh.positions;
  for (let i = 0; i < indices.length; i++) {
    const v = indices[i] * 3;
    p[v] = values[i * 3];
    p[v + 1] = values[i * 3 + 1];
    p[v + 2] = values[i * 3 + 2];
  }
}

function entryBytes(e: UndoEntry): number {
  return e.indices.byteLength + e.before.byteLength + e.after.byteLength;
}

/**
 * Per-stroke undo history with a memory budget; the oldest entries are
 * dropped when it is exceeded. `undo`/`redo` write positions only and return
 * the affected vertex ids so the caller can refresh normals and GPU buffers.
 */
export class UndoStack {
  private readonly done: UndoEntry[] = [];
  private readonly undone: UndoEntry[] = [];
  private bytes = 0;

  constructor(private readonly budgetBytes = 512 * 1024 * 1024) {}

  get canUndo(): boolean {
    return this.done.length > 0;
  }

  get canRedo(): boolean {
    return this.undone.length > 0;
  }

  push(entry: UndoEntry): void {
    this.done.push(entry);
    this.bytes += entryBytes(entry);
    for (const e of this.undone) this.bytes -= entryBytes(e);
    this.undone.length = 0;
    while (this.bytes > this.budgetBytes && this.done.length > 1) {
      this.bytes -= entryBytes(this.done.shift()!);
    }
  }

  undo(mesh: Mesh): Uint32Array | null {
    const e = this.done.pop();
    if (!e) return null;
    writePositions(mesh, e.indices, e.before);
    this.undone.push(e);
    return e.indices;
  }

  redo(mesh: Mesh): Uint32Array | null {
    const e = this.undone.pop();
    if (!e) return null;
    writePositions(mesh, e.indices, e.after);
    this.done.push(e);
    return e.indices;
  }

  clear(): void {
    this.done.length = 0;
    this.undone.length = 0;
    this.bytes = 0;
  }
}
