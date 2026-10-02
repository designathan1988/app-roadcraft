import { Matrix4, type Object3D } from 'three';

import { type ClipFrames, rigData } from './citizenBake';
import type { BakedClip } from './citizenBake.worker';
import type { WalkSex } from './citizenWalk';

/**
 * The bake workers: a body's core clips baked on the other cores while the
 * loading screen is up, as engines spread animation work over their threads.
 * One fewer than the cores (the main thread builds the bodies meanwhile), at
 * most six. Where there are no workers (tests), or one fails, the answer is
 * null and the caller bakes on the main thread instead: never a hang.
 */
type Result = (ClipFrames | undefined)[] | null;

const SIZE = Math.max(1, Math.min(6, (typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 4 : 4) - 1));

let started = false;
let usable = false;
const idle: Worker[] = [];
const queue: (() => void)[] = [];
/** The job each worker has in hand, to answer it should the worker fail. */
const busy = new Map<Worker, (result: Result) => void>();

function free(worker: Worker): void {
  busy.delete(worker);
  idle.push(worker);
  queue.shift()?.();
}

function start(): boolean {
  if (started) return usable;
  started = true;
  if (typeof Worker === 'undefined') return false;
  try {
    for (let i = 0; i < SIZE; i++) {
      const worker = new Worker(new URL('./citizenBake.worker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = (e: MessageEvent<{ id: number; clips?: (BakedClip | null)[]; error?: string }>) => {
        const answer = busy.get(worker);
        free(worker);
        if (!answer) return;
        if (!e.data.clips) { answer(null); return; }
        answer(e.data.clips.map((c) => (c ? { ...c, ...(c.head ? { head: new Matrix4().fromArray(c.head) } : {}) } as ClipFrames : undefined)));
      };
      worker.onerror = (event) => {
        event.preventDefault();
        const answer = busy.get(worker);
        free(worker);
        answer?.(null);
      };
      idle.push(worker);
    }
    usable = true;
  } catch {
    usable = false;
  }
  return usable;
}

/**
 * The core clips of the body whose rig is `scene`, baked in a worker; null
 * when no worker can (the caller bakes them itself). Deferred slots are
 * undefined.
 */
export function bakeInWorker(scene: Object3D, sex: WalkSex): Promise<Result> {
  if (!start()) return Promise.resolve(null);
  const { nodes, transfer } = rigData(scene);
  return new Promise((resolve) => {
    const send = (): void => {
      const worker = idle.pop()!;
      busy.set(worker, resolve);
      worker.postMessage({ id: 0, nodes, sex }, transfer);
    };
    if (idle.length) send();
    else queue.push(send);
  });
}
