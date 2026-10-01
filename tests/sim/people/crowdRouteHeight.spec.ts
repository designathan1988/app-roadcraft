import { it, expect } from 'vitest';
import { initCrowd, inspectCrowd } from '@sim/people/crowd';
import { step } from '@sim/pipeline';
import { DT } from '@sim/params';
import { m } from '@world/units';
import { CITIES } from '../support/agentDefects';

it('does not strand the elevated crossing walker at a false partial-path end', async () => {
  await initCrowd();
  const previous = process.env.AGENT_ENGINE;
  process.env.AGENT_ENGINE = 'crowd';
  const sim = CITIES.find(c => c.name === 'player-city')!.build();
  if (previous === undefined) delete process.env.AGENT_ENGINE; else process.env.AGENT_ENGINE = previous;
  let stalled = 0, longest = 0, seen = false;
  try {
    for (let i = 0; i < 60 / DT; i++) {
      step(sim, { traffic: true, pedestrians: true });
      const p = inspectCrowd(sim).find(p => p.id === 212);
      if (!p) continue;
      seen = true;
      const v = sim.pedViewById.get(p.id)!;
      const speed = Math.hypot(p.x - v.prev.x, p.y - v.prev.y) / DT;
      const wantsTrip = Math.hypot(p.goal.x - p.x, p.goal.y - p.y) > m(2);
      stalled = wantsTrip && p.mode === 'walk' && !p.holding && !p.aside && speed < m(.05) ? stalled + DT : 0;
      longest = Math.max(longest, stalled);
    }
    expect(seen).toBe(true);
    expect(longest).toBeLessThan(5);
  } finally { sim.pedEngine.reset(sim); }
},115000);
