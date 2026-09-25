import { it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { generate } from '../support/runner';
import { applyOp, freshState } from '../support/ops';
import { checkSim } from '../support/simCheck';
import { Network } from '@world/network';
import { LaneletGraph } from '@world/lanelets';

/** A connector whose path swings back towards where it has been: more than 200 degrees of turning in total. */
function hooks(points: { x: number; y: number }[]): boolean {
  let total = 0; let last: number | null = null;
  for (let i = 1; i < points.length; i++) {
    const a = Math.atan2(points[i]!.y - points[i - 1]!.y, points[i]!.x - points[i - 1]!.x);
    if (last !== null) { let d = a - last; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; total += Math.abs(d); }
    last = a;
  }
  return total > (200 * Math.PI) / 180;
}

it('overlap causes', () => {
  const lines: string[] = [];
  for (const seed of (process.env["SEEDS"] ?? "1-20").includes("-") ? Array.from({length: 20}, (_, i) => i + 1) : process.env["SEEDS"]!.split(",").map(Number)) {
    const ops = generate(seed, 25); const state = freshState();
    for (const op of ops) { try { applyOp(state, op); } catch { break; } }
    const net = new Network(state.doc); net.rebuild(); const graph = new LaneletGraph(); graph.build(state.doc, net);
    for (const d of checkSim(state.doc, { seconds: 45, seed: 0x5eed, intensity: 1.5 })) {
      if (!d.category.includes('bodyOverlap') && !d.category.includes('BodyOverlap')) continue;
      const lanes = d.detail.split(' ').filter(w => w.includes('>'));
      const hooked = lanes.map(id => { const l = graph.lanelets.get(id); return l?.kind === 'connector' ? `${l.turn}${hooks(l.centre.toPoints()) ? '+HOOK' : ''}` : 'link'; });
      lines.push(`seed ${seed} ${d.category} ${d.subject} ${d.detail} [${hooked.join(' / ')}]`);
    }
  }
  writeFileSync(process.env['OUT']!, lines.join('\n') + '\n');
});
