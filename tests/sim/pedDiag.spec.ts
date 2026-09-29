import { appendFileSync, writeFileSync } from 'node:fs';
import { describe, it } from 'vitest';

import { step } from '@sim/pipeline';
import { DT } from '@sim/params';
import { m } from '@world/units';
import { labCrossroads } from './support/pedLab';
import { PED_TRACE } from '@sim/peds/crossingFsm';
import { AGENT_TRACE } from '@sim/peds/agent';

const OUT = 'coverage/pedDiag.txt';
writeFileSync(OUT, '');
const say = (...parts: unknown[]): void => {
  appendFileSync(OUT, parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join(' ') + '\n');
};

describe('pedestrian freeze trace', () => {
  it('records the ticks a walker spends creeping at a closed kerb', () => {
    const sim = labCrossroads(3);
    const streak = new Map<number, number>();
    let dumped = 0;
    PED_TRACE.id = -1;
    AGENT_TRACE.id = -1;
    for (let t = 0; t < Math.round(300 / DT) && dumped < 2; t++) {
      // The walker most nearly parked right now is the one to record.
      let worstId = -1;
      let worst = 0;
      for (const [id, n] of streak) if (n > worst && sim.peds.has(id)) { worst = n; worstId = id; }
      PED_TRACE.id = worst > Math.round(0.8 / DT) ? worstId : -1;
      AGENT_TRACE.id = PED_TRACE.id;
      PED_TRACE.log.length = 0;
      AGENT_TRACE.log.length = 0;

      step(sim, { traffic: true, pedestrians: true });
      sim.clock.tick++;

      for (const p of sim.peds.values()) {
        const moved = Math.hypot(p.x - p.prev.x, p.y - p.prev.y);
        const edge = sim.sidewalks.edges.get(p.edge);
        const next = p.route[0] ? sim.sidewalks.edges.get(p.route[0]) : undefined;
        const watching = p.state === 'Walking' && p.activity === null && edge?.kind === 'walk' &&
          next?.kind === 'crossing' && moved / DT < m(0.06);
        streak.set(p.id, watching ? (streak.get(p.id) ?? 0) + 1 : 0);
      }

      if (PED_TRACE.id >= 0 && PED_TRACE.log.length) {
        const p = sim.peds.get(PED_TRACE.id);
        if (p && (streak.get(p.id) ?? 0) > Math.round(3 / DT)) {
          say(`--- t=${(t * DT).toFixed(1)}s ped ${p.id} edge=${p.edge} s=${p.s.toFixed(2)}/${sim.sidewalks.edges.get(p.edge)!.length.toFixed(2)}` +
            ` lat=${p.lat.toFixed(2)} v=${p.v.toFixed(3)} stuck=${p.stuck.toFixed(1)} waited=${p.waited.toFixed(1)}`);
          say(PED_TRACE.log.join('\n'));
          say(AGENT_TRACE.log.join('\n'));
          dumped++;
          streak.set(p.id, 0);
        }
      }
    }
  });
});
