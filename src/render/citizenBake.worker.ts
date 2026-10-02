/**
 * A bake worker: a body's core clips baked off the main thread
 * (`citizenBake.ts`, `bakePool.ts`). In: the rig as data and the body's sex.
 * Out: the clips baked (the deferred ones left out, null), their buffers
 * transferred, matrices as their elements.
 */
import { type ClipFrames, type RigNode, bake, rigFromData, setSliceMs } from './citizenBake';
import { loadRocketboxLibrary, type WalkSex } from './citizenWalk';

/** Nothing to yield to here: a bake runs to its end. */
setSliceMs(Infinity);

interface Job { readonly id: number; readonly nodes: RigNode[]; readonly sex: WalkSex }

export type BakedClip = Omit<ClipFrames, 'head'> & { head?: number[] };

const scope = globalThis as unknown as {
  onmessage: ((e: MessageEvent<Job>) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
};

scope.onmessage = async (e) => {
  const { id, nodes, sex } = e.data;
  try {
    const library = await loadRocketboxLibrary();
    const { clips, deferred } = await bake(rigFromData(nodes), sex, library);
    const transfer = new Set<ArrayBuffer>();
    const out = clips.map((clip, at): BakedClip | null => {
      if (!clip || deferred.has(at)) return null;
      for (const array of [clip.data, clip.travel, clip.yaw, clip.hands]) if (array) transfer.add(array.buffer as ArrayBuffer);
      const { head, ...rest } = clip;
      return head ? { ...rest, head: [...head.elements] } : rest;
    });
    scope.postMessage({ id, clips: out }, [...transfer]);
  } catch (error) {
    scope.postMessage({ id, error: String(error) });
  }
};
