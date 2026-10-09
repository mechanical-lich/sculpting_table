import { FloatList, IndexList, StampSet } from './lists';
import type { Mesh } from './mesh';

/** Sparse before/after values for xyz triples in one array. */
export interface ArrayPatch {
  target: Float32Array;
  indices: Uint32Array;
  before: Float32Array;
  after: Float32Array;
}

/** One undoable action: a stroke, with every array it changed. */
export interface UndoEntry {
  /** Subdivision level the stroke was made on. */
  level: number;
  patches: ArrayPatch[];
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

  /** Finishes the stroke as a patch on the mesh positions. Returns null if it touched nothing. */
  end(mesh: Mesh): ArrayPatch | null {
    this.active = false;
    if (this.indices.length === 0) return null;
    const indices = this.indices.view().slice();
    const before = this.before.view().slice();
    return { target: mesh.positions, indices, before, after: gather(mesh.positions, indices) };
  }
}

/** Copies the xyz triples at `indices` out of `source`. */
export function gather(source: Float32Array, indices: Uint32Array): Float32Array {
  const out = new Float32Array(indices.length * 3);
  for (let i = 0; i < indices.length; i++) {
    const v = indices[i] * 3;
    out[i * 3] = source[v];
    out[i * 3 + 1] = source[v + 1];
    out[i * 3 + 2] = source[v + 2];
  }
  return out;
}

/** Writes one side of every patch. Patches are applied in reverse for `before`. */
export function applyEntry(entry: UndoEntry, side: 'before' | 'after'): void {
  const n = entry.patches.length;
  for (let k = 0; k < n; k++) {
    const patch = entry.patches[side === 'before' ? n - 1 - k : k];
    const values = patch[side];
    const t = patch.target;
    const idx = patch.indices;
    for (let i = 0; i < idx.length; i++) {
      const v = idx[i] * 3;
      t[v] = values[i * 3];
      t[v + 1] = values[i * 3 + 1];
      t[v + 2] = values[i * 3 + 2];
    }
  }
}

function entryBytes(e: UndoEntry): number {
  let bytes = 0;
  for (const p of e.patches)
    bytes += p.indices.byteLength + p.before.byteLength + p.after.byteLength;
  return bytes;
}

/**
 * Undo history with a memory budget; the oldest entries are dropped when it
 * is exceeded. `undo`/`redo` only move entries between stacks: the caller
 * applies them (see `applyEntry`) and refreshes whatever depends on them.
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

  /** The entry `undo` would return, without popping it. */
  peekUndo(): UndoEntry | null {
    return this.done[this.done.length - 1] ?? null;
  }

  peekRedo(): UndoEntry | null {
    return this.undone[this.undone.length - 1] ?? null;
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

  undo(): UndoEntry | null {
    const e = this.done.pop();
    if (e) this.undone.push(e);
    return e ?? null;
  }

  redo(): UndoEntry | null {
    const e = this.undone.pop();
    if (e) this.done.push(e);
    return e ?? null;
  }

  clear(): void {
    this.done.length = 0;
    this.undone.length = 0;
    this.bytes = 0;
  }
}
