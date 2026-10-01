import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RoadDoc } from '@world/doc';
import { step } from '@sim/pipeline';
import { DT } from '@sim/params';
import { createPeopleEngine } from '@sim/people/people';
import { simOf } from './support/bodies';

/**
 * The player's own city (saved from the game on 2026-10-01), run with the
 * engines the game runs - People and Drive v2 - for ten minutes. Reported: the
 * central crossroads locked with people standing on its zebras and every
 * approach queued.
 */
function playerSim() {
  const raw = JSON.parse(readFileSync(join(process.cwd(), 'tests', 'fixtures', 'player-city.json'), 'utf8')) as { document: unknown };
  const sim = simOf(RoadDoc.fromJSON(raw.document as never), 0x2026, 1);
  sim.usePedestrianEngine(createPeopleEngine());
  sim.driveModel = 'v2';
  return sim;
}

describe("the player's city", () => {
  it('never locks a junction, nor leaves people standing on a zebra', () => {
    const sim = playerSim();
    const lastEntry = new Map<number, number>();
    const onZebra = new Map<number, number>();
    let worstJunction = 0;
    let worstZebra = 0;
    const where = new Map<number, string>();
    for (let i = 0; i < Math.round(600 / DT); i++) {
      step(sim, { traffic: true, pedestrians: true });
      const t = i * DT;
      for (const v of sim.vehicles.values()) {
        const lane = sim.lanelet(v.lanelet);
        if (lane?.kind === 'connector' && where.get(v.id) !== v.lanelet) lastEntry.set(lane.node!, t);
        where.set(v.id, v.lanelet);
      }
      if (i % 60 !== 0) continue;
      for (const [node, junction] of sim.graph.junctions) {
        const queued = junction.inbound.some((l) => { const h = sim.laneHead(l); return h && h.v < 0.1 && sim.lanelet(l)!.length - h.s < 20; });
        if (queued) worstJunction = Math.max(worstJunction, t - (lastEntry.get(node) ?? 0));
        else lastEntry.set(node, t);
      }
      const seen = new Set<number>();
      for (const [, st] of sim.crossingStates) for (const p of st.occupants) {
        seen.add(p.id);
        if (p.v < 0.05) onZebra.set(p.id, (onZebra.get(p.id) ?? 0) + 1);
        worstZebra = Math.max(worstZebra, onZebra.get(p.id) ?? 0);
      }
      for (const id of [...onZebra.keys()]) if (!seen.has(id)) onZebra.delete(id);
    }
    const line = `PLAYER 600 s: worst junction without an entry ${worstJunction.toFixed(0)} s, longest standing on a zebra ${worstZebra} s`;
    console.log(line);
    if (process.env.AGENT_REPORT) appendFileSync(process.env.AGENT_REPORT, line + String.fromCharCode(10));
    expect(worstJunction).toBeLessThan(60);
    expect(worstZebra).toBeLessThan(10);
  }, 900_000);
});
