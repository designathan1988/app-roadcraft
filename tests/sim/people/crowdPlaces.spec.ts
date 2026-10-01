import { beforeAll, expect, it, vi } from 'vitest';
import { NavMeshQuery } from '@recast-navigation/core';
import { RoadDoc } from '@world/doc';
import { m } from '@world/units';
import { CROSSWALK_DEPTH } from '@world/approach';
import { Network } from '@world/network';
import { SimWorld } from '@sim/world';
import { step } from '@sim/pipeline';
import { DT } from '@sim/params';
import { AGENT_RADIUS, buildCrowdNav, WALK_FLAG } from '@sim/people/crowdNav';
import { addScriptedWalker, ASK_AT, createCrowdEngine, initCrowd, inspectCrowd, THINK_EVERY } from '@sim/people/crowd';
import { SCENARIOS } from '../../fixtures/crowdScenarios';

beforeAll(initCrowd);

it('bounds an exhausted waiting search independently of distant streets and retries without losing the waiter', () => {
  const sc = SCENARIOS.find(s => s.name === 'queue')!;
  const calls: number[] = [];
  // A body's diameter bounds the number of queue-lattice cells in the
  // existing crossing-request region. This limit contains no map extent.
  const maximumProbes = 1 + (Math.ceil(ASK_AT / (2 * AGENT_RADIUS)) + 2) *
    (Math.ceil((2 * ASK_AT + CROSSWALK_DEPTH) / (2 * AGENT_RADIUS)) + 2);
  for (const farMetres of [0, 3000]) {
    const doc = RoadDoc.fromJSON(sc.doc.toJSON());
    if (farMetres) {
      const a = doc.addNode({ x: m(farMetres), y: 0 });
      const b = doc.addNode({ x: m(farMetres + 10), y: 0 });
      doc.addSegment(a.id, b.id, 1);
    }
    const net = new Network(doc); net.rebuild();
    const sim = new SimWorld(doc, net, 0x5ce7); sim.rebuildTopology();
    sim.pedestrianIntensity = 0; sim.trafficIntensity = 0;
    sim.usePedestrianEngine(createCrowdEngine());
    step(sim, { traffic: false, pedestrians: true });
    addScriptedWalker(sim, sc.walkers(net)[0]!);
    const initial = inspectCrowd(sim)[0]!;
    let probes = 0, exhausted = true;
    const original = NavMeshQuery.prototype.findNearestPoly;
    const spy = vi.spyOn(NavMeshQuery.prototype, 'findNearestPoly').mockImplementation(function (this: NavMeshQuery, position, options) {
      // Exercise the worst-case no-candidate path. Agent insertion and the
      // actual WALK mesh remain real; only the allocator's capacity probes
      // report exhausted capacity, independent of how big the city is.
      if (options?.halfExtents?.x === m(0.1) && options.halfExtents.z === m(0.1)) {
        probes++;
        if (exhausted) expect(probes, 'one local request must not scan remote streets').toBeLessThanOrEqual(maximumProbes);
        if (exhausted) return { success: false, status: 0, nearestRef: 0, nearestPoint: position, isOverPoly: false };
      }
      return original.call(this, position, options);
    });
    try {
      step(sim, { traffic: false, pedestrians: true });
      const full = inspectCrowd(sim)[0]!;
      expect(full.mode).toBe('wait');
      expect(full.waitingPlace).toBeNull();
      expect(full.x).toBe(initial.x);
      expect(full.y).toBe(initial.y);
      const oneAttempt = probes;
      expect(oneAttempt).toBeGreaterThan(0);
      calls.push(oneAttempt);
      for (let i = 0; i < THINK_EVERY - 1; i++) step(sim, { traffic: false, pedestrians: true });
      expect(probes, 'a full region must not be rescanned every tick').toBe(oneAttempt);
      exhausted = false;
      for (let i = 0; i < THINK_EVERY; i++) step(sim, { traffic: false, pedestrians: true });
      const resumed = inspectCrowd(sim)[0]!;
      expect(probes - oneAttempt).toBeLessThanOrEqual(maximumProbes);
      expect(resumed.waitingPlace, 'capacity becoming available must wake the existing waiter').not.toBeNull();
      expect(resumed.goal).toEqual(initial.goal);
      expect(resumed.granted).toEqual(initial.granted);
    } finally { spy.mockRestore(); }
  }
  expect(calls[1]).toBe(calls[0]);
});

function crowd(name = 'crowd') {
  const sc = SCENARIOS.find(s => s.name === name)!;
  const net = new Network(sc.doc); net.rebuild();
  const sim = new SimWorld(sc.doc, net, 0x5ce7); sim.rebuildTopology();
  sim.pedestrianIntensity = 0; sim.trafficIntensity = 0;
  sim.usePedestrianEngine(createCrowdEngine());
  step(sim, { traffic: false, pedestrians: true });
  const ids: number[] = [];
  for (const p of sc.walkers(net)) ids.push(addScriptedWalker(sim, {
    ...p, ...(p.leader !== undefined ? { leader: ids[p.leader]! } : {}),
  })!);
  return { sim, ids };
}

it('does not send zebra waiters 19 and 29 to the same physical place', () => {
  const { sim, ids } = crowd();
  const goals = inspectCrowd(sim).map(p => p.goal);
  for (let tick = 0; tick <= Math.round(26.1 / DT); tick++) step(sim, { traffic: false, pedestrians: true });
  const people = inspectCrowd(sim);
  const a = people.find(p => p.id === ids[18])!;
  const b = people.find(p => p.id === ids[28])!;
  // The recorded defect is two distinct raw queue slots, 0.65 m apart,
  // projected onto the same (24.5, 15) point on the navmesh boundary.
  if (a.mode === 'wait' && b.mode === 'wait' && !a.aside && !b.aside && a.target && b.target) {
    expect(Math.hypot(a.target.x - b.target.x, a.target.y - b.target.y), 'distinct bodies need distinct waiting footprints')
      .toBeGreaterThanOrEqual(2 * AGENT_RADIUS - 1e-5);
  }
  expect(people).toHaveLength(40);
  expect(people.map(p => p.goal)).toEqual(goals);
});

it('gives a later queue member an approach clear of earlier reserved bodies', () => {
  const { sim } = crowd('queue');
  const nav = buildCrowdNav(sim)!;
  nav.query.defaultFilter.includeFlags = WALK_FLAG;
  try {
    for (let tick = 0; tick <= Math.round(4 / DT); tick++) step(sim, { traffic: false, pedestrians: true });
    const owners = inspectCrowd(sim).filter(p => p.waitingPlace);
    const fifth = owners.find(p => p.id === 5)!;
    expect(fifth, 'the fifth person must receive a physical queue place').toBeDefined();
    const at = fifth.waitingPlace!;
    const route = nav.query.computePath({ x: fifth.x, y: fifth.h, z: fifth.y },
      { x: at.x, y: nav.elevation.at(at.x, at.y), z: at.y });
    expect(route.success).toBe(true);
    for (const other of owners.filter(p => p.id < fifth.id)) {
      const occupied = other.waitingPlace!;
      for (let i = 1; i < route.path.length; i++) {
        const a = route.path[i - 1]!, b = route.path[i]!;
        const dx = b.x - a.x, dy = b.z - a.z;
        const t = Math.max(0, Math.min(1, ((occupied.x - a.x) * dx + (occupied.y - a.z) * dy) / (dx * dx + dy * dy)));
        const distance = Math.hypot(occupied.x - a.x - t * dx, occupied.y - a.z - t * dy);
        expect(distance, `the approach crosses owner ${other.id}'s waiting footprint`).toBeGreaterThanOrEqual(2 * AGENT_RADIUS - 1e-5);
      }
    }
  } finally {
    nav.query.destroy();
    nav.navMesh.destroy();
  }
});

it('reserves separated canonical waiting footprints on permitted pavement', () => {
  const { sim } = crowd();
  const nav = buildCrowdNav(sim)!;
  nav.query.defaultFilter.includeFlags = WALK_FLAG;
  const seen = new Set<string>();
  let peak = 0;
  let previous = '';
  try {
    for (let tick = 0; tick < 35 / DT; tick++) {
      step(sim, { traffic: false, pedestrians: true });
      const owners = inspectCrowd(sim).filter(p => p.waitingPlace);
      peak = Math.max(peak, owners.length);
      const signature = JSON.stringify(owners.map(p => [p.id, p.waitingPlace]));
      if (signature === previous) continue;
      previous = signature;
      for (let i = 0; i < owners.length; i++) {
        const a = owners[i]!.waitingPlace!;
        for (let j = i + 1; j < owners.length; j++) {
          const b = owners[j]!.waitingPlace!;
          expect(Math.hypot(a.x - b.x, a.y - b.y), `owners ${owners[i]!.id}/${owners[j]!.id} at tick ${tick}`)
            .toBeGreaterThanOrEqual(2 * AGENT_RADIUS - 1e-5);
        }
        const key = JSON.stringify(a);
        if (seen.has(key)) continue;
        seen.add(key);
        const hit = nav.query.findNearestPoly({ x: a.x, y: nav.elevation.at(a.x, a.y), z: a.y });
        expect(hit.success && hit.isOverPoly, 'a waiting body centre lies inside the eroded WALK mesh').toBe(true);
        expect(Math.hypot(hit.nearestPoint.x - a.x, hit.nearestPoint.z - a.y)).toBeLessThan(1e-4);
        expect(nav.navMesh.getPolyFlags(hit.nearestRef).flags & WALK_FLAG).toBe(WALK_FLAG);
        const zebra = nav.zebras.find(z => z.id === owners[i]!.zebra)!;
        expect(zebra, 'a zebra reservation keeps its crossing identity').toBeDefined();
        const dx = zebra.b.x - zebra.a.x, dy = zebra.b.y - zebra.a.y;
        const length = Math.hypot(dx, dy), ux = dx / length, uy = dy / length;
        const kerbDistance = (along: number) => {
          const x = zebra.a.x + ux * along, y = zebra.a.y + uy * along;
          const lateral = (a.x - x) * -uy + (a.y - y) * ux;
          const clamped = Math.max(-zebra.half, Math.min(zebra.half, lateral));
          return Math.hypot(a.x - x + uy * clamped, a.y - y - ux * clamped);
        };
        expect(Math.min(kerbDistance(zebra.kerb), kerbDistance(length - zebra.kerb)),
          'waiting capacity belongs to this crossing request region, not remote pavement').toBeLessThanOrEqual(ASK_AT + 1e-4);
      }
    }
    expect(peak, 'exercise a queue with more than one owner').toBeGreaterThan(2);
    expect(seen.size).toBeGreaterThan(2);
  } finally {
    nav.query.destroy();
    nav.navMesh.destroy();
  }
});
