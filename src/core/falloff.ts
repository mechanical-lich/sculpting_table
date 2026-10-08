/**
 * Brush falloff curves. Input is normalized distance from the brush center
 * (0 at center, 1 at the radius); output is a weight in [0, 1].
 */
export type Falloff = (t: number) => number;

/** Smooth bell: 1 at center, 0 at the edge, zero slope at both ends. */
export const smoothFalloff: Falloff = (t) => {
  if (t <= 0) return 1;
  if (t >= 1) return 0;
  return 1 - t * t * (3 - 2 * t);
};
