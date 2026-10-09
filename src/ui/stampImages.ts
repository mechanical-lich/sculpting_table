import { stampFromRGBA, type Stamp } from '../core/stamp';

/** Largest stamp side, in pixels. */
const MAX_SIZE = 256;

/**
 * Decodes an image file into a square grayscale stamp: center-cropped to a
 * square (stamps map onto the round brush) and scaled to at most 256 px.
 */
export async function loadStampImage(file: File): Promise<Stamp> {
  const bitmap = await createImageBitmap(file);
  try {
    const side = Math.min(bitmap.width, bitmap.height);
    const size = Math.max(1, Math.min(MAX_SIZE, side));
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('Canvas 2D is not available.');
    const sx = (bitmap.width - side) / 2,
      sy = (bitmap.height - side) / 2;
    ctx.drawImage(bitmap, sx, sy, side, side, 0, 0, size, size);
    return stampFromRGBA(size, size, ctx.getImageData(0, 0, size, size).data);
  } finally {
    bitmap.close();
  }
}

const thumbnails = new WeakMap<Stamp, string>();

/** A small grayscale preview of a stamp, as a data URL (cached per stamp). */
export function stampThumbnail(stamp: Stamp, size = 40): string {
  const cached = thumbnails.get(stamp);
  if (cached) return cached;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';
  const img = ctx.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const sx = Math.floor((x / size) * stamp.width),
        sy = Math.floor((y / size) * stamp.height);
      const g = Math.round(stamp.data[sy * stamp.width + sx] * 255);
      const o = (y * size + x) * 4;
      img.data[o] = img.data[o + 1] = img.data[o + 2] = g;
      img.data[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const url = canvas.toDataURL();
  thumbnails.set(stamp, url);
  return url;
}
