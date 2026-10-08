export interface StrokeSample {
  /** CSS pixels relative to the viewport. */
  x: number;
  y: number;
  /** 0..1. */
  pressure: number;
  tiltX: number;
  tiltY: number;
  time: number;
}

/**
 * Turns raw pointer samples into evenly spaced dab positions: exponential
 * smoothing on the input, then a dab every `spacingPx` along the smoothed
 * path, with pressure interpolated between samples.
 */
export class StrokeSampler {
  /** Pending dabs as flat (x, y, pressure) triples. Consumed by the tool. */
  readonly dabs: number[] = [];
  /** 0 = raw input, approaching 1 = heavy lag. */
  smoothing = 0.35;

  private sx = 0;
  private sy = 0;
  private sp = 0;
  private lastX = 0;
  private lastY = 0;
  private lastP = 0;
  /** Distance travelled since the last dab. */
  private carry = 0;

  begin(s: StrokeSample): void {
    this.dabs.length = 0;
    this.sx = this.lastX = s.x;
    this.sy = this.lastY = s.y;
    this.sp = this.lastP = s.pressure;
    this.carry = 0;
    this.dabs.push(s.x, s.y, s.pressure);
  }

  add(s: StrokeSample, spacingPx: number): void {
    const k = 1 - this.smoothing;
    this.sx += (s.x - this.sx) * k;
    this.sy += (s.y - this.sy) * k;
    this.sp += (s.pressure - this.sp) * k;
    this.walkTo(this.sx, this.sy, this.sp, spacingPx);
  }

  /** Catches up to the raw pointer position at stroke end, so the stroke reaches where the pen lifted. */
  end(s: StrokeSample, spacingPx: number): void {
    this.walkTo(s.x, s.y, this.sp, spacingPx);
  }

  private walkTo(x: number, y: number, p: number, spacing: number): void {
    const step = Math.max(1, spacing);
    const dx = x - this.lastX,
      dy = y - this.lastY;
    const len = Math.hypot(dx, dy);
    if (len === 0) return;
    let d = step - this.carry;
    while (d <= len) {
      const t = d / len;
      this.dabs.push(this.lastX + dx * t, this.lastY + dy * t, this.lastP + (p - this.lastP) * t);
      d += step;
    }
    this.carry = len - (d - step);
    this.lastX = x;
    this.lastY = y;
    this.lastP = p;
  }
}
