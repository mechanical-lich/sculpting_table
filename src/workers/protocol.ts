import type { SkinOptions, SkinResult } from '../core/armature/skin';

/** Messages between the app and the kernel worker. */
export interface SkinJob {
  id: number;
  type: 'skin';
  spheres: Float32Array;
  parent: Int32Array;
  mirror: Int32Array;
  count: number;
  options: SkinOptions;
}

export type KernelRequest = SkinJob;

export type KernelResponse =
  | { id: number; ok: true; result: SkinResult; ms: number }
  | { id: number; ok: false; error: string };
