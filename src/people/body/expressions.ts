import metaUrl from '../../../public/models/people/faceunits.json?url';
import binaryUrl from '../../../public/models/people/faceunits.bin?url';
import type { MacroParams } from './macro';

/**
 * The face's blendshapes: the 52 of Apple's ARKit face tracking (the
 * industry's common set - Rocketbox/HeadBox, MetaHuman Live Link, VRM and
 * Ready Player Me all speak it), sculpted on the MakeHuman base mesh by the
 * MakeHuman community (faceunits01, CC0; `scripts/import-faceunits.mjs`).
 * They share the body's stable vertex numbering.
 */
interface FaceunitMeta {
  vertexCount: number; entryCount: number; deltaOffset: number;
  targets: { name: string; start: number; count: number; scale: number }[];
}
let loading: Promise<{ meta: FaceunitMeta; indices: Uint16Array; deltas: Int16Array }> | undefined;

export async function expressionShapes(_body?: MacroParams): Promise<Record<string, Float32Array>> {
  loading ??= Promise.all([fetch(metaUrl).then(r => r.json() as Promise<FaceunitMeta>),
    fetch(binaryUrl).then(r => r.arrayBuffer())]).then(([meta, binary]) => ({
    meta, indices: new Uint16Array(binary, 0, meta.entryCount), deltas: new Int16Array(binary, meta.deltaOffset, meta.entryCount * 3),
  }));
  const { meta, indices, deltas } = await loading;
  const shapes: Record<string, Float32Array> = {};
  for (const target of meta.targets) {
    const shape = shapes[target.name] = new Float32Array(meta.vertexCount * 3);
    for (let i = target.start; i < target.start + target.count; i++) {
      const vertex = indices[i]! * 3;
      for (let k = 0; k < 3; k++) shape[vertex + k] = deltas[i * 3 + k]! * target.scale;
    }
  }
  return shapes;
}
