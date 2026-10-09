import { SkinError, skinTree } from '../core/armature/skin';
import type { KernelRequest, KernelResponse } from './protocol';

/** Runs pure core/ functions off the main thread. One job at a time. */
const ctx = self as unknown as {
  onmessage: ((e: MessageEvent<KernelRequest>) => void) | null;
  postMessage(message: KernelResponse, transfer: Transferable[]): void;
};

ctx.onmessage = (e) => {
  const job = e.data;
  const start = performance.now();
  try {
    const result = skinTree(
      { count: job.count, spheres: job.spheres, parent: job.parent, mirror: job.mirror },
      job.options,
    );
    ctx.postMessage({ id: job.id, ok: true, result, ms: performance.now() - start }, [
      result.positions.buffer,
      result.quads.buffer,
      result.thinNodes.buffer,
    ]);
  } catch (err) {
    const error =
      err instanceof SkinError ? err.message : `Skinning failed: ${(err as Error).message ?? err}`;
    ctx.postMessage({ id: job.id, ok: false, error }, []);
  }
};
