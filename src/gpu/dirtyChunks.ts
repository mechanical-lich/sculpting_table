/**
 * Tracks which fixed-size chunks of a vertex buffer need re-uploading, and
 * coalesces them into contiguous ranges at flush time. Symmetric strokes touch
 * two distant index ranges; chunking keeps both uploads small.
 */
export class DirtyChunks {
  private readonly flags: Uint8Array;
  private readonly list: number[] = [];

  constructor(
    elementCount: number,
    readonly chunkSize = 2048,
  ) {
    this.flags = new Uint8Array(Math.ceil(elementCount / chunkSize));
  }

  mark(indices: Uint32Array): void {
    const shift = Math.log2(this.chunkSize);
    for (let i = 0; i < indices.length; i++) {
      const c = indices[i] >>> shift;
      if (this.flags[c] === 0) {
        this.flags[c] = 1;
        this.list.push(c);
      }
    }
  }

  markAll(): void {
    this.list.length = 0;
    for (let c = 0; c < this.flags.length; c++) {
      this.flags[c] = 1;
      this.list.push(c);
    }
  }

  get isEmpty(): boolean {
    return this.list.length === 0;
  }

  /** Calls `upload(firstElement, elementCount)` for each merged range, then clears. */
  flush(totalElements: number, upload: (first: number, count: number) => void): void {
    if (this.list.length === 0) return;
    this.list.sort((a, b) => a - b);
    let runStart = this.list[0];
    let prev = runStart;
    const emit = (from: number, to: number) => {
      const first = from * this.chunkSize;
      const end = Math.min((to + 1) * this.chunkSize, totalElements);
      upload(first, end - first);
    };
    for (let i = 1; i < this.list.length; i++) {
      const c = this.list[i];
      if (c !== prev + 1) {
        emit(runStart, prev);
        runStart = c;
      }
      prev = c;
    }
    emit(runStart, prev);
    for (const c of this.list) this.flags[c] = 0;
    this.list.length = 0;
  }
}
