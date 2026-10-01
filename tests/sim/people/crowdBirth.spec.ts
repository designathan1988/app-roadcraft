import { expect, it, vi } from 'vitest';
import { NavMeshQuery } from '@recast-navigation/core';
import { initCrowd, inspectCrowd } from '@sim/people/crowd';
import * as party from '@sim/people/party';
import { AGENT_HEIGHT, AGENT_RADIUS } from '@sim/people/crowdNav';
import { CITIES } from '../support/agentDefects';

it.each(['none', 'route'])('keeps city demand and whole groups when birth failure=%s', async (failure) => {
  await initCrowd();
  const previousEngine = process.env.AGENT_ENGINE;
  process.env.AGENT_ENGINE = 'crowd';
  const sim = CITIES.find(c => c.name === 'player-city')!.build();
  if (previousEngine === undefined) delete process.env.AGENT_ENGINE;
  else process.env.AGENT_ENGINE = previousEngine;
  const plans = vi.spyOn(party, 'planParty');
  const raycast = failure === 'route' ? vi.spyOn(NavMeshQuery.prototype, 'raycast').mockImplementation(() => ({
    success: true, status: 0, t: 0, hitNormal: { x: 0, y: 0, z: 0 }, hitEdgeIndex: -1, path: [], maxPath: 0, pathCost: 0,
  })) : null;
  try {
    sim.pedEngine.dispatch(sim, true);
    const people = inspectCrowd(sim);
    // Preserve demand. Relocated companions affect later source occupancy, so
    // subsequent accepted parties need not have the old random identities.
    expect(people).toHaveLength(334);
    const planned = new Map(plans.mock.calls.map((args, i) => [args[1], plans.mock.results[i]!.value as party.PartyPlan]));
    for (const leader of people.filter(p => p.leader === null)) {
      const group = people.filter(p => p.id === leader.id || p.leader === leader.id);
      expect(group.length, `missing companion of ${leader.id}`).toBe(planned.get(leader.id)!.size);
    }
    for (const p of people) {
      if (p.leader === null) continue;
      for (const q of people) {
        if (p.id === q.id || Math.abs(p.h - q.h) >= AGENT_HEIGHT) continue;
        expect(Math.hypot(p.x - q.x, p.y - q.y), `birth overlap ${p.id}/${q.id}`).toBeGreaterThanOrEqual(2 * AGENT_RADIUS - 1e-4);
      }
    }
  } finally { raycast?.mockRestore(); plans.mockRestore(); sim.pedEngine.reset(sim); }
}, 30000);
