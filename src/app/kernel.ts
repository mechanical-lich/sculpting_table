import type { SkinOptions, SkinResult } from '../core/armature/skin';
import type { Armature } from '../core/armature/tree';
import type { KernelRequest, KernelResponse } from '../workers/protocol';

export type SkinOutcome =
  { ok: true; result: SkinResult; ms: number } | { ok: false; error: string };

interface Queued {
  job: KernelRequest;
  resolve: (outcome: SkinOutcome | null) => void;
}

/**
 * Client for the kernel worker. Two lanes: `preview` keeps only the newest
 * request (older ones resolve to null), so fast edits never pile up work;
 * `final` requests always run, in order.
 */
export class Kernel {
  private readonly worker = new Worker(new URL('../workers/kernel.worker.ts', import.meta.url), {
    type: 'module',
  });
  private nextId = 1;
  private running: Queued | null = null;
  private preview: Queued | null = null;
  private readonly finals: Queued[] = [];

  constructor() {
    this.worker.onmessage = (e: MessageEvent<KernelResponse>) => {
      const done = this.running;
      this.running = null;
      if (done && done.job.id === e.data.id) {
        const r = e.data;
        done.resolve(
          r.ok ? { ok: true, result: r.result, ms: r.ms } : { ok: false, error: r.error },
        );
      }
      this.pump();
    };
    this.worker.onerror = (e) => {
      const done = this.running;
      this.running = null;
      done?.resolve({ ok: false, error: `The worker failed: ${e.message}` });
      this.pump();
    };
  }

  skin(
    tree: Armature,
    options: SkinOptions,
    lane: 'preview' | 'final',
  ): Promise<SkinOutcome | null> {
    const job: KernelRequest = {
      id: this.nextId++,
      type: 'skin',
      count: tree.count,
      spheres: tree.spheres.slice(0, tree.count * 4),
      parent: tree.parent.slice(0, tree.count),
      mirror: tree.mirror.slice(0, tree.count),
      options,
    };
    return new Promise((resolve) => {
      const queued = { job, resolve };
      if (lane === 'final') this.finals.push(queued);
      else {
        this.preview?.resolve(null);
        this.preview = queued;
      }
      this.pump();
    });
  }

  destroy(): void {
    this.worker.terminate();
  }

  private pump(): void {
    if (this.running) return;
    const next = this.finals.shift() ?? this.preview;
    if (!next) return;
    if (next === this.preview) this.preview = null;
    this.running = next;
    const j = next.job;
    this.worker.postMessage(j, [j.spheres.buffer, j.parent.buffer, j.mirror.buffer]);
  }
}
