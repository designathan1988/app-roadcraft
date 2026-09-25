import { it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { generate } from '../support/runner';
import { applyOp, freshState } from '../support/ops';
import { Network } from '@world/network';
import { SimWorld } from '@sim/world';
import { step } from '@sim/pipeline';
import { DT } from '@sim/params';
import { collisions } from '../../sim/support/bodies';

it('sim probe', () => {
  const seed = Number(process.env['SEED']);
  const ops = generate(seed, Number(process.env['OPS'] ?? 25));
  const state = freshState();
  for (const op of ops) { try { applyOp(state, op); } catch { break; } }
  const net = new Network(state.doc); net.rebuild();
  const sim = new SimWorld(state.doc, net, 0x5eed);
  sim.rebuildTopology(); sim.trafficIntensity = 1.5; sim.demandMultiplier = 1.5; sim.clock.paused = false;
  const want = (process.env['PAIR'] ?? '').split('/').map(Number);
  const lines: string[] = [];
  const dump = (label: string) => {
    for (const id of want) {
      const v = sim.vehicles.get(id as never); if (!v) { lines.push(`${label} veh ${id} absent`); continue; }
      lines.push(`${label} veh ${id} ${v.archetype.id} len ${v.archetype.length.toFixed(1)} lane ${v.lanelet} s ${v.s.toFixed(2)} v ${v.v.toFixed(2)} lat ${v.lateral.toFixed(2)} age ${v.age.toFixed(1)} rear ${v.rearPath.slice(0,3).join(',')} shadow ${JSON.stringify(v.shadow)} adm ${v.admittedConnector} obst ${v.constraints.obstacles.map(o => o.kind + ':' + o.gap.toFixed(1)).join(',')}`);
    }
  };
  let found = false; let after = 0;
  sim.clock.run(Math.round(60 / DT), () => {
    if (found && after++ > 3) return;
    step(sim, { traffic: true, pedestrians: true });
    const t = sim.clock.tick * DT;
    if (!found && t > Number(process.env['FROM'] ?? 0) - 1.0 && want.every(id => sim.vehicles.has(id as never)) && sim.clock.tick % 10 === 0) dump(`t=${t.toFixed(2)}`);
    for (const hit of collisions(sim)) {
      if (want.includes(hit.a.id) && want.includes(hit.b.id) && !found) { found = true; dump(`HIT t=${t.toFixed(2)} ${hit.category}`); }
    }
    if (found) dump(`after t=${t.toFixed(2)}`);
  });
  writeFileSync(process.env['OUT']!, lines.slice(-24).join('\n') + '\n');
});
