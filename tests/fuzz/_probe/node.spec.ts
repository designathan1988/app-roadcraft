import { it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { generate } from '../support/runner';
import { applyOp, freshState } from '../support/ops';
import { LaneletGraph } from '@world/lanelets';

it('node probe', () => {
  const seed = Number(process.env['SEED']); const nodeId = Number(process.env['NID']);
  const ops = generate(seed, Number(process.env['OPS'] ?? 30));
  const state = freshState();
  for (const op of ops) { try { applyOp(state, op); } catch { break; } }
  const { doc, net } = state;
  const node = doc.node(nodeId as never);
  if (!node) { writeFileSync(process.env['OUT']!, 'nodes ' + [...doc.nodes.keys()].join(',') + ' segs ' + [...doc.segments.keys()].join(',')); return; }
  const lines = [`node ${nodeId} (${node.x.toFixed(1)},${node.y.toFixed(1)}) deg ${node.incident.length} continues ${net.continues(nodeId as never)} transition ${net.transitions.has(nodeId as never)} junction ${net.junctions.has(nodeId as never)}`];
  for (const id of node.incident) {
    const s = doc.segment(id)!; const other = doc.node(s.a === nodeId ? s.b : s.a)!;
    lines.push(`seg ${id} ${s.a}->${s.b} other(${other.x.toFixed(1)},${other.y.toFixed(1)}) type ${s.type} lanes ${s.lanes} dir ${s.direction} ${s.structure} curve ${JSON.stringify(s.curve)} len ${net.polylines.get(doc, id).length.toFixed(1)} mouth ${net.mouthDistance(id, nodeId as never).toFixed(2)} stop ${net.stopLineDistance(id, nodeId as never).toFixed(2)} ribbon ${net.ribbons.has(id)} width ${net.ribbons.get(id)?.road.width}`);
  }
  const graph = new LaneletGraph(); graph.build(doc, net);
  for (const c of graph.connectors.values()) if (c.node === nodeId) {
    const l = graph.lanelets.get(c.lanelet)!;
    lines.push(`conn ${c.id} ${c.turn} len ${l.length.toFixed(1)} pts ${JSON.stringify(l.centre.toPoints().filter((_, i, a) => i % Math.ceil(a.length / 6) === 0 || i === a.length - 1).map(p => [+p.x.toFixed(1), +p.y.toFixed(1)]))}`);
  }
  for (const [lvl, j] of net.junctions.get(nodeId as never) ?? []) if (lvl === 4) lines.push(`asphalt ${JSON.stringify(j.rings.map(r => r.flatten().map(p => [+p.x.toFixed(1), +p.y.toFixed(1)])))}`);
  writeFileSync(process.env['OUT']!, lines.join('\n') + '\n');
});
