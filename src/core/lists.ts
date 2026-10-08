/** Growable Uint32 list. Reused across frames to avoid allocation in hot paths. */
export class IndexList {
  data: Uint32Array;
  length = 0;

  constructor(capacity = 1024) {
    this.data = new Uint32Array(capacity);
  }

  push(value: number): void {
    if (this.length === this.data.length) this.grow(this.length + 1);
    this.data[this.length++] = value;
  }

  clear(): void {
    this.length = 0;
  }

  /** A view over the live elements. Invalidated by the next push that grows. */
  view(): Uint32Array {
    return this.data.subarray(0, this.length);
  }

  private grow(min: number): void {
    const next = new Uint32Array(Math.max(min, this.data.length * 2));
    next.set(this.data.subarray(0, this.length));
    this.data = next;
  }
}

/** Growable Float32 list. */
export class FloatList {
  data: Float32Array;
  length = 0;

  constructor(capacity = 1024) {
    this.data = new Float32Array(capacity);
  }

  push3(x: number, y: number, z: number): void {
    if (this.length + 3 > this.data.length) this.grow(this.length + 3);
    const d = this.data;
    d[this.length] = x;
    d[this.length + 1] = y;
    d[this.length + 2] = z;
    this.length += 3;
  }

  clear(): void {
    this.length = 0;
  }

  view(): Float32Array {
    return this.data.subarray(0, this.length);
  }

  private grow(min: number): void {
    const next = new Float32Array(Math.max(min, this.data.length * 2));
    next.set(this.data.subarray(0, this.length));
    this.data = next;
  }
}

/**
 * Epoch-stamped visited set over a dense id range. `next()` clears the set in
 * O(1) by bumping the epoch; the backing array is only wiped on wraparound.
 */
export class StampSet {
  private stamps: Uint32Array;
  private epoch = 0;

  constructor(size: number) {
    this.stamps = new Uint32Array(size);
  }

  next(): void {
    if (this.epoch === 0xffffffff) {
      this.stamps.fill(0);
      this.epoch = 0;
    }
    this.epoch++;
  }

  has(id: number): boolean {
    return this.stamps[id] === this.epoch;
  }

  /** Marks `id`; returns true if it was not already marked this epoch. */
  add(id: number): boolean {
    if (this.stamps[id] === this.epoch) return false;
    this.stamps[id] = this.epoch;
    return true;
  }

  resize(size: number): void {
    if (size > this.stamps.length) {
      this.stamps = new Uint32Array(size);
      this.epoch = 0;
    }
  }
}
