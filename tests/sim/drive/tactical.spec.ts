import { describe, expect, it } from 'vitest';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { laneletId, type LaneletId } from '@world/lanelets';
import { SimWorld } from '@sim/world';
import { ARCHETYPES } from '@sim/vehicles/archetypes';
import { makeDriver } from '@sim/vehicles/driver';
import { createVehicle } from '@sim/vehicles/state';
import { planFrom } from '@sim/routing/router';
import { planTrip } from '@sim/drive/tactical';
import { step } from '@sim/pipeline';

/**
 * P1-19: a car with a destination, in the wrong lane for its turn. The legacy
 * planner searched from the car's own lane over connectors only, found the
 * turn unreachable, and sent it round the block or into a U-turn. Drive v2
 * plans the lane change as part of the trip.
 */
function crossroads() {
  const doc = new RoadDoc();
  const centre = doc.addNode({ x: 0, y: 0 });
  const south = doc.addNode({ x: 0, y: -620 });
  // A four-lane-each-way approach: the turns are legal from one lane each.
  const source = doc.addSegment(south.id, centre.id, 3, null, 0, 'both', 8)!;
  for (const point of [{ x: 620, y: 0 }, { x: -620, y: 0 }, { x: 0, y: 620 }]) {
    const node = doc.addNode(point);
    doc.addSegment(centre.id, node.id, 3);
  }
  const net = new Network(doc);
  net.rebuild();
  const sim = new SimWorld(doc, net, 0x4812);
  sim.driveModel = 'v2';
  sim.rebuildTopology();
  const lane = (index: number): LaneletId => laneletId(source.id, south.id, centre.id, index);
  return { sim, lane };
}

function carIn(sim: SimWorld, lane: LaneletId, destination: LaneletId) {
  const archetype = ARCHETYPES.find((candidate) => candidate.id === 'hatch')!;
  const link = sim.lanelet(lane)!;
  const vehicle = createVehicle(1, archetype, makeDriver(archetype, () => 0.5), '#ffffff', lane, link.speedLimit, 0);
  vehicle.s = archetype.length + 1;
  vehicle.v = link.speedLimit * 0.6;
  vehicle.destination = destination;
  sim.vehicles.set(vehicle.id, vehicle);
  sim.enterLanelet(vehicle, lane);
  return vehicle;
}

describe('Drive v2 tactical layer: the lane a trip is driven in', () => {
  it('plans the lane change a turn needs instead of a detour', () => {
    const { sim, lane } = crossroads();
    const right = sim.graph.exitsOf(lane(3)).map((id) => sim.connector(id)).find((c) => c?.turn === 'right')!;
    expect(right).toBeDefined();
    // From the innermost lane the right turn is not legal at all.
    expect(sim.graph.exitsOf(lane(0)).some((id) => sim.connector(id)?.turn === 'right')).toBe(false);

    const plan = planTrip(sim, lane(0), 10, right.toLane, 1)!;
    expect(plan).not.toBeNull();
    expect(plan.changeTo).toBe(lane(3));
    expect(plan.intent).toBe(right.id);

    // Already in the lane it needs: no change.
    const direct = planTrip(sim, lane(3), 10, right.toLane, 1)!;
    expect(direct.changeTo).toBeNull();
    expect(direct.route).toEqual([lane(3), right.id, right.toLane]);
  });

  it('publishes the change to the car and then makes the turn, without a U-turn', () => {
    const { sim, lane } = crossroads();
    const right = sim.graph.exitsOf(lane(3)).map((id) => sim.connector(id)).find((c) => c?.turn === 'right')!;
    const vehicle = carIn(sim, lane(0), right.toLane);
    planFrom(sim, vehicle);
    expect(vehicle.desiredLane).toBe(lane(3));
    expect(vehicle.movementIntent).toBe(right.id);

    sim.trafficIntensity = 0;
    sim.pedestrianIntensity = 0;
    const visited: LaneletId[] = [];
    for (let tick = 0; tick < 60 * 60 && sim.vehicles.has(vehicle.id); tick++) {
      step(sim, { pedestrians: false });
      if (visited.at(-1) !== vehicle.lanelet) visited.push(vehicle.lanelet);
    }
    // Every connector it drove through, in order.
    const turns = visited.map((id) => sim.connector(id)).filter((c) => c !== undefined).map((c) => c!.id);
    expect(turns).toEqual([right.id]);
    expect(visited).toContain(lane(3));
    expect(visited).toContain(right.toLane);
  });

  it('reaches, as a trip end, what only another lane of the carriageway leads to', () => {
    const { sim, lane } = crossroads();
    const right = sim.graph.exitsOf(lane(3)).map((id) => sim.connector(id)).find((c) => c?.turn === 'right')!;
    const vehicle = carIn(sim, lane(0), right.toLane);
    vehicle.v = 0;
    vehicle.s = sim.lanelet(lane(0))!.length - 2;
    // No room left to cross three lanes: the plan keeps to what this lane can drive.
    const plan = planTrip(sim, lane(0), vehicle.s, right.toLane, 1);
    expect(plan === null || plan.changeTo === null).toBe(true);
  });
});
