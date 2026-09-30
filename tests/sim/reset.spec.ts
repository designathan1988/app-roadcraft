import { describe, expect, it } from 'vitest';

import { rebindAgents, step } from '@sim/pipeline';
import { m } from '@world/units';
import { DT } from '@sim/params';
import { fixtureDoc, simOf } from './support/bodies';

/**
 * Loading a different map starts a clean simulation. Lanelet and footway ids
 * coincide between maps, so the old rebind-after-load kept vehicles of the
 * previous map - with their routes and claims - on unrelated roads.
 */
describe('a simulation reset', () => {
  it('forgets every agent and everything learned about the old map, and runs on', () => {
    const sim = simOf(fixtureDoc(), 0x5eed, 2);
    for (let i = 0; i < Math.round(40 / DT); i++) step(sim, { traffic: true, pedestrians: true });
    expect(sim.vehicles.size).toBeGreaterThan(0);
    expect(sim.peds.size).toBeGreaterThan(0);

    sim.reset();
    expect(sim.vehicles.size).toBe(0);
    expect(sim.peds.size).toBe(0);
    expect(sim.runtime.size).toBe(0);
    expect(sim.segmentVolume.size).toBe(0);
    expect(sim.issues.length).toBe(0);
    expect(sim.completedTrips).toBe(0);

    // The next step rebuilds the topology and the city fills again.
    for (let i = 0; i < Math.round(20 / DT); i++) step(sim, { traffic: true, pedestrians: true });
    expect(sim.vehicles.size).toBeGreaterThan(0);
    for (const v of sim.vehicles.values()) expect(sim.lanelet(v.lanelet)).toBeDefined();
  });
});

describe('pedestrians on a demolished footway', () => {
  it('go to the nearest surviving footway, not all to one spot', () => {
    const sim = simOf(fixtureDoc(), 0x5eed, 2);
    for (let i = 0; i < Math.round(60 / DT); i++) step(sim, { traffic: true, pedestrians: true });
    // The segment whose footways carry the most people.
    const count = new Map<number, number>();
    for (const p of sim.peds.values()) {
      const segment = sim.sidewalks.edges.get(p.edge)?.segment;
      if (segment !== undefined) count.set(segment, (count.get(segment) ?? 0) + 1);
    }
    const [target, onIt] = [...count].sort((a, b) => b[1] - a[1])[0]!;
    expect(onIt).toBeGreaterThan(1);
    const before = new Map([...sim.peds.values()].map((p) => [p.id, { x: p.x, y: p.y, edge: p.edge }]));

    sim.doc.removeSegment(target as never);
    sim.net.rebuild();
    sim.rebuildTopology();
    const orphans = [...sim.peds.values()].filter((p) => !sim.sidewalks.edges.has(p.edge)).map((p) => p.id);
    expect(orphans.length).toBeGreaterThan(1);
    rebindAgents(sim);

    const placed: { x: number; y: number }[] = [];
    for (const id of orphans) {
      const p = sim.peds.get(id);
      if (!p) continue; // nobody within reach: removed cleanly
      const edge = sim.sidewalks.edges.get(p.edge);
      expect(edge, `ped ${id}`).toBeDefined();
      const was = before.get(id)!;
      // Put on a footway near where it stood, not carried across the map.
      expect(edge!.path.closestPoint({ x: was.x, y: was.y }).distance).toBeLessThan(m(15) + 1e-6);
      expect(Math.hypot(p.x - was.x, p.y - was.y)).toBeLessThan(m(15) + 1e-6);
      placed.push({ x: p.x, y: p.y });
    }
    expect(placed.length).toBeGreaterThan(0);
    // Not stacked: the old fallback put every orphan at s = 0 of one edge.
    for (let i = 0; i < placed.length; i++) {
      for (let j = i + 1; j < placed.length; j++) {
        expect(Math.hypot(placed[i]!.x - placed[j]!.x, placed[i]!.y - placed[j]!.y)).toBeGreaterThan(m(0.3));
      }
    }
  });
});
