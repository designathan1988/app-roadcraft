import { it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { generate, replay } from '../support/runner';

it('probe', () => {
  const seed = Number(process.env['SEED'] ?? 1);
  const cat = process.env['CAT'] ?? 'turnOffSurface';
  const ops = generate(seed, Number(process.env['OPS'] ?? 40));
  const out = replay(ops, null, cat);
  const doc = out.state.doc;
  const lines = [`step ${out.step} op ${JSON.stringify(ops[out.step])}`];
  for (const d of out.defects.slice(0, 12)) lines.push(`${d.subject} ${d.detail}`);
  lines.push(`nodes ${doc.nodes.size} segs ${doc.segments.size}`);
  for (const s of doc.segments.values()) {
    const a = doc.node(s.a)!; const b = doc.node(s.b)!;
    lines.push(`seg ${s.id} ${s.a}(${a.x.toFixed(1)},${a.y.toFixed(1)}) deg${doc.degree(s.a)} -> ${s.b}(${b.x.toFixed(1)},${b.y.toFixed(1)}) deg${doc.degree(s.b)} type ${s.type} lanes ${s.lanes} dir ${s.direction} ${s.structure} curve ${JSON.stringify(s.curve)} len ${out.state.net.polylines.get(doc, s.id).length.toFixed(1)} trims ${JSON.stringify(out.state.net.trims.get(s.id))}`);
  }
  const net = out.state.net;
  for (const [n, by] of net.junctions) lines.push(`junction ${n} levels ${[...by.keys()].join(',')} asphalt ring ${JSON.stringify(by.get(4)?.rings.map(r => r.flatten().map(p => [+p.x.toFixed(1), +p.y.toFixed(1)])))}`);
  writeFileSync(process.env['OUT'] ?? 'probe.txt', lines.join('\n') + '\n');
});
