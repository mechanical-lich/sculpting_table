import { FloatList, IndexList, StampSet } from './lists';

/** Values per vertex in a patched array: 3 for positions, 1 for masks. */
export type Stride = 1 | 3;

/** Sparse before/after values for some vertices of one array. */
export interface ArrayPatch {
  target: Float32Array;
  stride: Stride;
  indices: Uint32Array;
  before: Float32Array;
  after: Float32Array;
}

/** One undoable action, with every array it changed. */
export interface UndoEntry {
  /** Subdivision level it was made on. */
  level: number;
  /** A mask edit (no positions changed). */
  mask?: boolean;
  patches: ArrayPatch[];
}

/**
 * Captures the first-seen values of every vertex a stroke touches in one
 * array (positions, or a mask). Call `capture` before modifying vertices, and
 * `end` once the stroke is done.
 */
export class StrokeRecorder {
  private readonly seen: StampSet;
  private readonly indices = new IndexList(4096);
  private readonly before = new FloatList(4096 * 3);
  private target: Float32Array | null = null;
  private stride: Stride = 3;

  constructor(vertexCount: number) {
    this.seen = new StampSet(vertexCount);
  }

  begin(target: Float32Array, stride: Stride = 3): void {
    this.seen.next();
    this.indices.clear();
    this.before.clear();
    this.target = target;
    this.stride = stride;
  }

  capture(vertices: Uint32Array, count = vertices.length): void {
    const t = this.target;
    if (!t) return;
    for (let i = 0; i < count; i++) {
      const v = vertices[i];
      if (!this.seen.add(v)) continue;
      this.indices.push(v);
      if (this.stride === 3) this.before.push3(t[v * 3], t[v * 3 + 1], t[v * 3 + 2]);
      else this.before.push(t[v]);
    }
  }

  /** Finishes the stroke as a patch on the target array. Returns null if it touched nothing. */
  end(): ArrayPatch | null {
    const target = this.target;
    this.target = null;
    if (!target || this.indices.length === 0) return null;
    const indices = this.indices.view().slice();
    const before = this.before.view().slice();
    const stride = this.stride;
    return { target, stride, indices, before, after: gather(target, indices, stride) };
  }
}

/** Copies the values at `indices` out of `source`. */
export function gather(
  source: Float32Array,
  indices: Uint32Array,
  stride: Stride = 3,
): Float32Array {
  const out = new Float32Array(indices.length * stride);
  for (let i = 0; i < indices.length; i++) {
    const v = indices[i] * stride;
    for (let c = 0; c < stride; c++) out[i * stride + c] = source[v + c];
  }
  return out;
}

/** A patch over every vertex of `target`, for whole-array edits (e.g. invert mask). */
export function wholeArrayPatch(
  target: Float32Array,
  stride: Stride,
  before: Float32Array,
): ArrayPatch {
  const n = target.length / stride;
  const indices = new Uint32Array(n);
  for (let i = 0; i < n; i++) indices[i] = i;
  return { target, stride, indices, before, after: target.slice() };
}

/** Writes one side of every patch. Patches are applied in reverse for `before`. */
export function applyEntry(entry: UndoEntry, side: 'before' | 'after'): void {
  const n = entry.patches.length;
  for (let k = 0; k < n; k++) {
    const patch = entry.patches[side === 'before' ? n - 1 - k : k];
    const values = patch[side];
    const { target: t, indices: idx, stride } = patch;
    for (let i = 0; i < idx.length; i++) {
      const v = idx[i] * stride;
      for (let c = 0; c < stride; c++) t[v + c] = values[i * stride + c];
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
