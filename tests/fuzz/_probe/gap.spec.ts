import { it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { generate, replay } from '../support/runner';
import { Level } from '@world/roadTypes';

it('gap probe', () => {
  const seed = Number(process.env['SEED']);
  const ops = generate(seed, Number(process.env['OPS'] ?? 40));
  const out = replay(ops, null, 'surfaceGap');
  const { doc, net } = out.state;
  const d = out.defects[0]!;
  const segId = Number(d.subject.split(' ')[1]);
  const seg = doc.segment(segId as never)!;
  const ribbon = net.ribbons.get(segId as never)!;
  const lines = [`step ${out.step} op ${JSON.stringify(ops[out.step])}`, `${d.subject} ${d.detail}`,
    `seg ${segId} ${seg.a}(deg ${doc.degree(seg.a)}) -> ${seg.b}(deg ${doc.degree(seg.b)}) type ${seg.type} lanes ${seg.lanes} ${seg.direction} ${seg.structure} curve ${JSON.stringify(seg.curve)} trims ${JSON.stringify(net.trims.get(segId as never))}`,
    `full len ${ribbon.full.length.toFixed(1)} centre4 len ${ribbon.centre[Level.Asphalt]?.length.toFixed(1)}`,
    `centre4 ${JSON.stringify(ribbon.centre[Level.Asphalt]?.toPoints().map(p => [+p.x.toFixed(1), +p.y.toFixed(1)]))}`,
    `ring4 ${JSON.stringify(ribbon.rings[Level.Asphalt]?.flatten().map(p => [+p.x.toFixed(1), +p.y.toFixed(1)]))}`];
  for (const n of [seg.a, seg.b]) for (const [lvl, j] of net.junctions.get(n) ?? []) if (lvl === Level.Asphalt) lines.push(`junction ${n} ${JSON.stringify(j.rings.map(r => r.flatten().map(p => [+p.x.toFixed(1), +p.y.toFixed(1)])))}`);
  writeFileSync(process.env['OUT']!, lines.join('\n') + '\n');
});
