import { describe, expect, it } from 'vitest';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { laneletId } from '@world/lanelets';
import { SimWorld } from '@sim/world';
import { ARCHETYPES } from '@sim/vehicles/archetypes';
import { makeDriver } from '@sim/vehicles/driver';
import { createVehicle } from '@sim/vehicles/state';
import { step } from '@sim/pipeline';

/**
 * P1-46: a route that ends on a link too short to stop on. Admission asks for
 * the movement beyond it, the route has none, and the car used to wait at the
 * stop line for ever.
 */
describe('a route ending on a short link', () => {
  for (const model of ['v1', 'v2'] as const) {
    it(`is grown past it, and the car goes on (${model})`, () => {
      const doc = new RoadDoc();
      const a = doc.addNode({ x: 0, y: 0 });
      const b = doc.addNode({ x: 300, y: 0 });
      const c = doc.addNode({ x: 300, y: 12 });
      const d = doc.addNode({ x: 600, y: 12 });
      const first = doc.addSegment(a.id, b.id, 2)!;
      const short = doc.addSegment(b.id, c.id, 2)!;
      const last = doc.addSegment(c.id, d.id, 2)!;
      const net = new Network(doc);
      net.rebuild();
      const sim = new SimWorld(doc, net, 0x46);
      sim.driveModel = model;
      sim.rebuildTopology();
      sim.trafficIntensity = 0;
      sim.pedestrianIntensity = 0;

      const from = laneletId(first.id, a.id, b.id, 0);
      const mid = laneletId(short.id, b.id, c.id, 0);
      const end = laneletId(last.id, c.id, d.id, 0);
      const midLane = sim.lanelet(mid)!;
      const archetype = ARCHETYPES.find((candidate) => candidate.id === 'hatch')!;
      expect(midLane.length).toBeLessThan(archetype.length + 4);
      const into = sim.graph.exitsOf(from).find((id) => sim.connector(id)?.toLane === mid)!;
      expect(into).toBeDefined();

      const link = sim.lanelet(from)!;
      const v = createVehicle(1, archetype, makeDriver(archetype, () => 0.5), '#fff', from, link.speedLimit, 0);
      v.s = link.length - 80;
      v.v = link.speedLimit * 0.5;
      sim.vehicles.set(v.id, v);
      sim.enterLanelet(v, from);
      v.route = [from, into, mid];

      let reached = false;
      for (let tick = 0; tick < 60 * 30 && !reached; tick++) {
        step(sim, { pedestrians: false });
        reached = v.lanelet === end;
      }
      expect(reached).toBe(true);
    });
  }
});
