/**
 * Brush falloff curves. Input is normalized distance from the brush center
 * (0 at center, 1 at the radius); output is a weight in [0, 1]. Every curve
 * is 1 at the center, 0 at and beyond the radius, and non-increasing.
 */
export type Falloff = (t: number) => number;

export type FalloffKind = 'smooth' | 'linear' | 'sharp' | 'needle' | 'flat';

/** Smooth bell: zero slope at both ends. */
export const smoothFalloff: Falloff = (t) => {
  if (t <= 0) return 1;
  if (t >= 1) return 0;
  return 1 - t * t * (3 - 2 * t);
};

/** Where the Flat preset's plateau ends. */
const FLAT_PLATEAU = 0.6;

export const FALLOFFS: Record<FalloffKind, { label: string; fn: Falloff }> = {
  smooth: { label: 'Smooth', fn: smoothFalloff },
  linear: { label: 'Linear', fn: (t) => (t <= 0 ? 1 : t >= 1 ? 0 : 1 - t) },
  // Peaked center, for crisp grooves and ridges.
  sharp: {
    label: 'Sharp',
    fn: (t) => {
      if (t <= 0) return 1;
      if (t >= 1) return 0;
      const u = 1 - t;
      return u * u * u;
    },
  },
  // Narrower still: most of the effect stays near the center.
  needle: {
    label: 'Needle',
    fn: (t) => {
      if (t <= 0) return 1;
      if (t >= 1) return 0;
      const u = 1 - t;
      const u2 = u * u;
      return u2 * u2 * u;
    },
  },
  // Full strength over most of the brush, then a smooth edge.
  flat: {
    label: 'Flat',
    fn: (t) => (t <= FLAT_PLATEAU ? 1 : smoothFalloff((t - FLAT_PLATEAU) / (1 - FLAT_PLATEAU))),
  },
};

export const FALLOFF_ORDER = Object.keys(FALLOFFS) as FalloffKind[];
