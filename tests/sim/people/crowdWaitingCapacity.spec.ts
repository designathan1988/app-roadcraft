import { beforeAll, expect, it, vi } from 'vitest';
import { NavMeshQuery } from '@recast-navigation/core';
import { Network } from '@world/network';
import { SimWorld } from '@sim/world';
import { step } from '@sim/pipeline';
import { m } from '@world/units';
import { AGENT_HEIGHT } from '@sim/people/crowdNav';
import { addScriptedWalker, createCrowdEngine, initCrowd, inspectCrowd, THINK_EVERY } from '@sim/people/crowd';
import { SCENARIOS } from '../../fixtures/crowdScenarios';

beforeAll(initCrowd);

it('rejects a partial approach that reaches the right plan position on the wrong deck', () => {
  const sc = SCENARIOS.find(s => s.name === 'queue')!;
  const net = new Network(sc.doc); net.rebuild();
  const sim = new SimWorld(sc.doc, net, 0x5ce7); sim.rebuildTopology();
  sim.pedestrianIntensity = 0; sim.trafficIntensity = 0;
  sim.usePedestrianEngine(createCrowdEngine());
  step(sim, { traffic: false, pedestrians: true });
  addScriptedWalker(sim, sc.walkers(net)[0]!);
  const original = NavMeshQuery.prototype.computePath;
  let partial = 0;
  const spy = vi.spyOn(NavMeshQuery.prototype, 'computePath').mockImplementation(function (this: NavMeshQuery, start, end, options) {
    if (options?.filter) {
      partial++;
      return { success: true, path: [start, { ...end, y: end.y + 2 * AGENT_HEIGHT }] };
    }
    return original.call(this, start, end, options);
  });
  try {
    step(sim, { traffic: false, pedestrians: true });
    expect(partial).toBeGreaterThan(0);
    expect(inspectCrowd(sim)[0]!.waitingPlace, 'matching x/z is not arrival on the target deck').toBeNull();
  } finally { spy.mockRestore(); sim.pedEngine.reset(sim); }
});

it('does not let one unreachable waiter repeatedly suppress a reachable peer', () => {
  const sc = SCENARIOS.find(s => s.name === 'queue')!;
  const net = new Network(sc.doc); net.rebuild();
  const sim = new SimWorld(sc.doc, net, 0x5ce7); sim.rebuildTopology();
  sim.pedestrianIntensity = 0; sim.trafficIntensity = 0;
  sim.usePedestrianEngine(createCrowdEngine());
  step(sim, { traffic: false, pedestrians: true });
  const placements = sc.walkers(net);
  const first = addScriptedWalker(sim, placements[0]!)!;
  // Put both independent bodies inside the request region, with a physical
  // 0.8 m gap; the second starts nearer the same kerb than the blocked first.
  const second = addScriptedWalker(sim, { ...placements[1]!, x: placements[0]!.x - m(0.8), y: placements[0]!.y })!;
  const byId = new Map(inspectCrowd(sim).map(p => [p.id, p]));
  const anchor = { x: byId.get(first)!.x, y: byId.get(first)!.y };
  let denied = 0, peerQueries = 0;
  const original = NavMeshQuery.prototype.computePath;
  const spy = vi.spyOn(NavMeshQuery.prototype, 'computePath').mockImplementation(function (this: NavMeshQuery, start, end, options) {
    // The allocator alone supplies an explicit filter. This creates an
    // agent-specific access failure, while preserving geometry and the
    // other waiter's real paths; it does not fake a globally full pavement.
    if (options?.filter) {
      if (Math.hypot(start.x - anchor.x, start.z - anchor.y) < m(0.1)) {
        denied++;
        return { success: false, error: { name: 'Review: first approach is unavailable', status: 0 }, path: [] };
      }
      peerQueries++;
    }
    return original.call(this, start, end, options);
  });
  try {
    for (let tick = 0; tick < 4 * THINK_EVERY; tick++) step(sim, { traffic: false, pedestrians: true });
    const people = inspectCrowd(sim);
    const peer = people.find(p => p.id === second)!;
    expect(denied, 'the first waiter must exercise a real agent-specific rejection').toBeGreaterThan(0);
    expect(peerQueries, 'a global no-room cache must not starve the other approach').toBeGreaterThan(0);
    expect(peer.waitingPlace, 'a reachable peer must be allowed to acquire physical capacity').not.toBeNull();
  } finally {
    spy.mockRestore();
    sim.pedEngine.reset(sim);
  }
});
