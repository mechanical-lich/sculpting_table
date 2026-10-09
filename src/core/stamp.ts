/**
 * A brush stamp: a grayscale image (0..1) that modulates dab strength across
 * the brush disk. Stamp coordinates (u, v) span [-1, 1] over the brush
 * radius, with v up; outside that square the stamp is 0.
 */
export interface Stamp {
  width: number;
  height: number;
  /** Row-major, top row first. */
  data: Float32Array;
}

/** Bilinear sample at stamp coordinates (u, v) in [-1, 1]. */
export function sampleStamp(s: Stamp, u: number, v: number): number {
  if (u < -1 || u > 1 || v < -1 || v > 1) return 0;
  const x = ((u + 1) / 2) * (s.width - 1);
  const y = ((1 - v) / 2) * (s.height - 1);
  const x0 = Math.floor(x),
    y0 = Math.floor(y);
  const x1 = Math.min(x0 + 1, s.width - 1),
    y1 = Math.min(y0 + 1, s.height - 1);
  const fx = x - x0,
    fy = y - y0;
  const d = s.data,
    w = s.width;
  const top = d[y0 * w + x0] * (1 - fx) + d[y0 * w + x1] * fx;
  const bottom = d[y1 * w + x0] * (1 - fx) + d[y1 * w + x1] * fx;
  return top * (1 - fy) + bottom * fy;
}

/** Builds a stamp from 8-bit RGBA pixels (e.g. canvas ImageData), using luminance. */
export function stampFromRGBA(width: number, height: number, rgba: Uint8ClampedArray): Stamp {
  const data = new Float32Array(width * height);
  for (let i = 0; i < data.length; i++) {
    const r = rgba[i * 4],
      g = rgba[i * 4 + 1],
      b = rgba[i * 4 + 2],
      a = rgba[i * 4 + 3];
    // Transparent pixels count as black, so PNG cutouts work as stamps.
    data[i] = ((0.2126 * r + 0.7152 * g + 0.0722 * b) / 255) * (a / 255);
  }
  return { width, height, data };
}

// --- built-in stamps (procedural, deterministic) -------------------------------

export type BuiltinStampId = 'noise' | 'dots' | 'scales';

export const BUILTIN_STAMPS: Record<BuiltinStampId, { label: string; make: () => Stamp }> = {
  noise: { label: 'Noise', make: () => noiseStamp(128) },
  dots: { label: 'Dots', make: () => dotsStamp(128, 5) },
  scales: { label: 'Scales', make: () => scalesStamp(128, 5) },
};

function makeStamp(size: number, f: (x: number, y: number) => number): Stamp {
  const data = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      data[y * size + x] = Math.min(1, Math.max(0, f(x / (size - 1), y / (size - 1))));
    }
  }
  return { width: size, height: size, data };
}

/** Integer hash -> [0, 1). */
function hash2(x: number, y: number, seed: number): number {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(seed, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function valueNoise(x: number, y: number, seed: number): number {
  const xi = Math.floor(x),
    yi = Math.floor(y);
  const fx = x - xi,
    fy = y - yi;
  const sx = fx * fx * (3 - 2 * fx),
    sy = fy * fy * (3 - 2 * fy);
  const a = hash2(xi, yi, seed),
    b = hash2(xi + 1, yi, seed),
    c = hash2(xi, yi + 1, seed),
    d = hash2(xi + 1, yi + 1, seed);
  return (a * (1 - sx) + b * sx) * (1 - sy) + (c * (1 - sx) + d * sx) * sy;
}

/** Fractal value noise: a skin-pore / rough-clay texture. */
function noiseStamp(size: number): Stamp {
  return makeStamp(size, (x, y) => {
    let v = 0,
      amp = 0.5,
      freq = 6;
    for (let o = 0; o < 4; o++) {
      v += valueNoise(x * freq, y * freq, 7 + o) * amp;
      amp *= 0.5;
      freq *= 2;
    }
    // Stretch contrast around the mean.
    return (v - 0.47) * 2.2 + 0.5;
  });
}

/** A grid of soft round bumps. */
function dotsStamp(size: number, cells: number): Stamp {
  return makeStamp(size, (x, y) => {
    const cx = x * cells,
      cy = y * cells;
    const dx = cx - Math.floor(cx) - 0.5,
      dy = cy - Math.floor(cy) - 0.5;
    const r = Math.hypot(dx, dy) / 0.4;
    return r >= 1 ? 0 : 1 - r * r * (3 - 2 * r);
  });
}

/** Overlapping half-discs in offset rows, like reptile scales. */
function scalesStamp(size: number, rows: number): Stamp {
  return makeStamp(size, (x, y) => {
    const ry = y * rows;
    const row = Math.floor(ry);
    const offset = row % 2 === 0 ? 0 : 0.5;
    const rx = x * rows + offset;
    const dx = rx - Math.floor(rx) - 0.5;
    // Each scale is brightest at its upper rim and fades toward the next row.
    const dy = ry - row;
    const edge = Math.hypot(dx * 1.1, dy - 0.05);
    return edge > 0.62 ? 0.15 : 1 - (edge / 0.62) * 0.85;
  });
}
