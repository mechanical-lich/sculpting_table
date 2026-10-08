import { describe, expect, it } from 'vitest';
import { smoothFalloff } from './falloff';

describe('smoothFalloff', () => {
  it('is 1 at the center and 0 at and beyond the radius', () => {
    expect(smoothFalloff(0)).toBe(1);
    expect(smoothFalloff(-0.5)).toBe(1);
    expect(smoothFalloff(1)).toBe(0);
    expect(smoothFalloff(2)).toBe(0);
  });

  it('is monotonically decreasing and stays in [0, 1]', () => {
    let prev = 1;
    for (let i = 0; i <= 1000; i++) {
      const f = smoothFalloff(i / 1000);
      expect(f).toBeLessThanOrEqual(prev);
      expect(f).toBeGreaterThanOrEqual(0);
      expect(f).toBeLessThanOrEqual(1);
      prev = f;
    }
  });

  it('is 0.5 at half radius and flat at both ends', () => {
    expect(smoothFalloff(0.5)).toBeCloseTo(0.5, 10);
    const h = 1e-4;
    expect((smoothFalloff(h) - smoothFalloff(0)) / h).toBeCloseTo(0, 3);
    expect((smoothFalloff(1) - smoothFalloff(1 - h)) / h).toBeCloseTo(0, 3);
  });
});
