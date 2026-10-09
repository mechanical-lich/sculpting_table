import { sampleStamp, type Stamp } from './stamp';

/**
 * A stencil as seen by one dab: an image fixed in screen space that masks
 * brush strength. Screen units are CSS pixels from the viewport's top-left.
 */
export interface DabStencil {
  stamp: Stamp;
  /** World -> clip transform of the current view (column-major). */
  viewProj: Float32Array;
  viewportWidth: number;
  viewportHeight: number;
  /** Stencil center on screen. */
  centerX: number;
  centerY: number;
  /** Half the stencil's side length on screen. */
  halfSize: number;
  /** Clockwise rotation on screen, in radians. */
  angle: number;
  /** Repeat the image beyond its square instead of masking to zero. */
  tile: boolean;
}

/**
 * The stencil value (0..1) over world point (x, y, z): project to the
 * screen, then into the stencil's rotated square, where (u, v) span [-1, 1]
 * with v up, as for stamps. The overlay shader uses the same mapping.
 */
export function stencilAt(st: DabStencil, x: number, y: number, z: number): number {
  const m = st.viewProj;
  const cw = m[3] * x + m[7] * y + m[11] * z + m[15];
  if (cw <= 1e-9) return 0; // behind the camera
  const cx = (m[0] * x + m[4] * y + m[8] * z + m[12]) / cw;
  const cy = (m[1] * x + m[5] * y + m[9] * z + m[13]) / cw;
  const sx = ((cx + 1) / 2) * st.viewportWidth;
  const sy = ((1 - cy) / 2) * st.viewportHeight;
  const [u, v] = screenToStencil(st, sx, sy);
  return sampleStamp(st.stamp, st.tile ? wrap(u) : u, st.tile ? wrap(v) : v);
}

/** Screen point -> stencil (u, v), before tiling. */
export function screenToStencil(
  st: Pick<DabStencil, 'centerX' | 'centerY' | 'halfSize' | 'angle'>,
  sx: number,
  sy: number,
): [number, number] {
  const dx = sx - st.centerX,
    dy = sy - st.centerY;
  const c = Math.cos(st.angle),
    s = Math.sin(st.angle);
  // Undo the clockwise rotation (screen y points down).
  const lx = dx * c + dy * s;
  const ly = -dx * s + dy * c;
  return [lx / st.halfSize, -ly / st.halfSize];
}

/** Wraps into [-1, 1), period 2. */
function wrap(t: number): number {
  return ((((t + 1) % 2) + 2) % 2) - 1;
}
