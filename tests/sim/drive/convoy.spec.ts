import { describe, expect, it } from 'vitest';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { laneletId } from '@world/lanelets';
import { SimWorld } from '@sim/world';
import { ARCHETYPES } from '@sim/vehicles/archetypes';
import { makeDriver } from '@sim/vehicles/driver';
import { createVehicle } from '@sim/vehicles/state';
import { planFrom } from '@sim/routing/router';
import { step } from '@sim/pipeline';

/**
 * P1-21: a movement with no conflict point - the way on at a bend, a right
 * turn crossing nothing - is admitted as a `movement:` token. Two cars one
 * behind the other both hold it, and the deadlock test counted that as two
 * owners of one resource and refused the second: the queue went through one
 * car at a time, each stopping at the line until the one ahead had cleared.
 */
describe('a convoy through a movement that crosses nothing', () => {
  for (const model of ['v1', 'v2'] as const) {
    it(`does not stop the car behind at the line (${model})`, () => {
      const doc = new RoadDoc();
      const a = doc.addNode({ x: 0, y: 0 });
      const b = doc.addNode({ x: 400, y: 0 });
      const c = doc.addNode({ x: 700, y: 180 });
      const first = doc.addSegment(a.id, b.id, 2)!;
      doc.addSegment(b.id, c.id, 2);
      const net = new Network(doc);
      net.rebuild();
      const sim = new SimWorld(doc, net, 0x21);
      sim.driveModel = model;
      sim.rebuildTopology();
      sim.trafficIntensity = 0;
      sim.pedestrianIntensity = 0;

      const lane = laneletId(first.id, a.id, b.id, 0);
      const link = sim.lanelet(lane)!;
      const archetype = ARCHETYPES.find((candidate) => candidate.id === 'hatch')!;
      const cars = [0, 1].map((i) => {
        const v = createVehicle(i + 1, archetype, makeDriver(archetype, () => 0.5), '#fff', lane, link.speedLimit, 0);
        v.s = link.length - 60 - i * 28;
        v.v = link.speedLimit * 0.7;
        sim.vehicles.set(v.id, v);
        sim.enterLanelet(v, lane);
        planFrom(sim, v);
        return v;
      });
      const follower = cars[1]!;
      let slowest = Infinity;
      for (let tick = 0; tick < 60 * 12; tick++) {
        step(sim, { pedestrians: false });
        if (follower.lanelet === lane && link.length - follower.s < 40) slowest = Math.min(slowest, follower.v);
      }
      // Following, not queueing: the car behind keeps rolling through.
      expect(slowest).toBeGreaterThan(link.speedLimit * 0.3);
    });
  }
});
