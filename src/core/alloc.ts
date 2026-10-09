/**
 * Typed-array allocation for large mesh data. When the page is cross-origin
 * isolated, arrays are backed by SharedArrayBuffer so Workers can later read
 * and write them without copying; otherwise they are plain arrays.
 */
const useShared =
  typeof SharedArrayBuffer !== 'undefined' &&
  (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated === true;

export function allocFloat32(length: number): Float32Array {
  return useShared ? new Float32Array(new SharedArrayBuffer(length * 4)) : new Float32Array(length);
}

export function allocUint32(length: number): Uint32Array {
  return useShared ? new Uint32Array(new SharedArrayBuffer(length * 4)) : new Uint32Array(length);
}

export function allocInt32(length: number): Int32Array {
  return useShared ? new Int32Array(new SharedArrayBuffer(length * 4)) : new Int32Array(length);
}

export const sharedMemory = useShared;
