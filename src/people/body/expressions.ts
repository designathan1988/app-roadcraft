import metaUrl from '../../../public/models/people/expressions.json?url';
import binaryUrl from '../../../public/models/people/expressions.bin?url';
import type { MacroParams } from './macro';

interface ExpressionMeta {
  vertexCount: number; entryCount: number; deltaOffset: number;
  targets: { name: string; start: number; count: number; scale: number }[];
}
let loading: Promise<{ meta: ExpressionMeta; indices: Uint16Array; deltas: Int16Array }> | undefined;

/** CC0 expression units share the body's stable vertex numbering. */
export async function expressionShapes(body: MacroParams): Promise<Record<string, Float32Array>> {
  loading ??= Promise.all([fetch(metaUrl).then(r => r.json() as Promise<ExpressionMeta>),
    fetch(binaryUrl).then(r => r.arrayBuffer())]).then(([meta, binary]) => ({
    meta, indices: new Uint16Array(binary, 0, meta.entryCount), deltas: new Int16Array(binary, meta.deltaOffset, meta.entryCount * 3),
  }));
  const { meta, indices, deltas } = await loading;
  const sum = body.african + body.asian + body.caucasian || 1;
  const weights: Record<string, number> = { african: body.african / sum, asian: body.asian / sum, caucasian: body.caucasian / sum };
  const shapes: Record<string, Float32Array> = {};
  for (const target of meta.targets) {
    const [origin, name] = target.name.split('/');
    const shape = shapes[name!] ??= new Float32Array(meta.vertexCount * 3);
    const scale = target.scale * weights[origin!]!;
    for (let i = target.start; i < target.start + target.count; i++) {
      const vertex = indices[i]! * 3;
      for (let k = 0; k < 3; k++) shape[vertex + k] = shape[vertex + k]! + deltas[i * 3 + k]! * scale;
    }
  }
  return shapes;
}
