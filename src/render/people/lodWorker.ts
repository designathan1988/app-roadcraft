import { MeshoptSimplifier } from 'meshoptimizer';

/**
 * The coarser levels of a person, simplified off the main thread: building
 * them there took a quarter of every frame while people came into view, and
 * the game stuttered each time a new kind of person appeared.
 *
 * In: positions, colours, the index, its material ranges and the levels
 * (share kept, error allowed). Out: per level, the index and its ranges.
 */
export interface LodRequest {
  readonly id: number;
  readonly positions: Float32Array;
  readonly colours: Float32Array;
  readonly index: Uint32Array;
  readonly ranges: readonly { start: number; count: number }[];
  readonly levels: readonly (readonly [number, number])[];
}

export interface LodLevel {
  readonly index: Uint32Array;
  readonly groups: { start: number; count: number; materialIndex: number }[];
}

export function simplifyLevels(req: Omit<LodRequest, 'id'>): LodLevel[] {
  const out: LodLevel[] = [];
  for (const [ratio, error] of req.levels) {
    const kept: number[] = [];
    const groups: { start: number; count: number; materialIndex: number }[] = [];
    req.ranges.forEach((range, materialIndex) => {
      const start = kept.length;
      if (range.count >= 3) {
        const part = req.index.slice(range.start, range.start + range.count);
        const target = Math.max(3, Math.floor((range.count * ratio) / 3) * 3);
        const [indices] = MeshoptSimplifier.simplifyWithAttributes(part, req.positions, 3, req.colours, 3, [0.6, 0.6, 0.6], null, target, error, ['LockBorder', 'Sparse']);
        for (let i = 0; i < indices.length; i++) kept.push(indices[i]!);
      }
      groups.push({ start, count: kept.length - start, materialIndex });
    });
    out.push({ index: Uint32Array.from(kept), groups });
  }
  return out;
}

// In a worker: answer each request.
const scope = globalThis as unknown as { onmessage: ((e: MessageEvent<LodRequest>) => void) | null; postMessage?: (m: unknown, t: Transferable[]) => void; document?: unknown };
if (typeof scope.document === 'undefined' && typeof scope.postMessage === 'function' && typeof (globalThis as { WorkerGlobalScope?: unknown }).WorkerGlobalScope !== 'undefined') {
  scope.onmessage = async (e) => {
    await MeshoptSimplifier.ready;
    const levels = simplifyLevels(e.data);
    scope.postMessage!({ id: e.data.id, levels }, levels.map((l) => l.index.buffer));
  };
}
