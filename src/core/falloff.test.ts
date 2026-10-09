import { describe, expect, it } from 'vitest';
import { FALLOFF_ORDER, FALLOFFS, smoothFalloff } from './falloff';

describe.each(FALLOFF_ORDER)('%s falloff', (kind) => {
  const fn = FALLOFFS[kind].fn;

  it('is 1 at the center and 0 at and beyond the radius', () => {
    expect(fn(0)).toBe(1);
    expect(fn(-0.5)).toBe(1);
    expect(fn(1)).toBe(0);
    expect(fn(2)).toBe(0);
  });

  it('is non-increasing and stays in [0, 1]', () => {
    let prev = 1;
    for (let i = 0; i <= 1000; i++) {
      const f = fn(i / 1000);
      expect(f).toBeLessThanOrEqual(prev + 1e-12);
      expect(f).toBeGreaterThanOrEqual(0);
      expect(f).toBeLessThanOrEqual(1);
      prev = f;
    }
  });
});

describe('falloff shapes', () => {
  it('smooth is 0.5 at half radius and flat at both ends', () => {
    expect(smoothFalloff(0.5)).toBeCloseTo(0.5, 10);
    const h = 1e-4;
    expect((smoothFalloff(h) - smoothFalloff(0)) / h).toBeCloseTo(0, 3);
    expect((smoothFalloff(1) - smoothFalloff(1 - h)) / h).toBeCloseTo(0, 3);
  });

  it('linear is exactly linear', () => {
    for (const t of [0.1, 0.25, 0.5, 0.9]) expect(FALLOFFS.linear.fn(t)).toBeCloseTo(1 - t, 12);
  });

  it('flat holds full strength over its plateau', () => {
    expect(FALLOFFS.flat.fn(0.3)).toBe(1);
    expect(FALLOFFS.flat.fn(0.6)).toBe(1);
    expect(FALLOFFS.flat.fn(0.8)).toBeLessThan(1);
  });

  it('orders by sharpness: flat > smooth > sharp > needle inside the brush', () => {
    for (const t of [0.3, 0.5, 0.7]) {
      const f = (k: (typeof FALLOFF_ORDER)[number]) => FALLOFFS[k].fn(t);
      expect(f('flat')).toBeGreaterThan(f('smooth'));
      expect(f('smooth')).toBeGreaterThan(f('sharp'));
      expect(f('sharp')).toBeGreaterThan(f('needle'));
    }
  });
});
