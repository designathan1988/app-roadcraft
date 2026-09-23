import { describe, expect, it } from 'vitest';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { laneletId } from '@world/lanelets';
import { SimWorld } from '@sim/world';
import { ARCHETYPES } from '@sim/vehicles/archetypes';
import { makeDriver } from '@sim/vehicles/driver';
import { integrateAll } from '@sim/vehicles/integrate';
import { stepLaneChange } from '@sim/vehicles/laneChange';
import { createVehicle } from '@sim/vehicles/state';
import { planFrom } from '@sim/routing/router';

describe('mandatory lane-change intent', () => {
  it('moves across an eight-lane road one adjacent lane at a time while keeping its chosen turn', () => {
    const doc = new RoadDoc();
    const centre = doc.addNode({ x: 0, y: 0 });
    const south = doc.addNode({ x: 0, y: -620 });
    const source = doc.addSegment(south.id, centre.id, 3, null, 0, 'both', 8)!;
    for (const point of [{ x: 620, y: 0 }, { x: -620, y: 0 }, { x: 0, y: 620 }]) {
      const node = doc.addNode(point);
      doc.addSegment(centre.id, node.id, 3);
    }
    const net = new Network(doc); net.rebuild();
    const sim = new SimWorld(doc, net, 0x4812); sim.rebuildTopology();
    const inner = laneletId(source.id, south.id, centre.id, 0);
    const outer = laneletId(source.id, south.id, centre.id, 3);
    const right = sim.graph.exitsOf(outer).map(id => sim.connector(id)).find(connector => connector?.turn === 'right')!;
    expect(right).toBeDefined();
    const archetype = ARCHETYPES.find(candidate => candidate.id === 'hatch')!;
    const lane = sim.lanelet(inner)!;
    const driver = makeDriver(archetype, () => 0.5);
    const vehicle = createVehicle(1, archetype, driver, '#ffffff', inner, lane.speedLimit, 0);
    vehicle.s = archetype.length + 1;
    vehicle.v = lane.speedLimit * 0.65;
    vehicle.desiredLane = outer;
    vehicle.movementIntent = right.id;
    sim.vehicles.set(vehicle.id, vehicle);
    sim.enterLanelet(vehicle, inner);
    planFrom(sim, vehicle);

    let priorIndex = 0;
    let transfers = 0;
    // Three eased transfers (~2 s of slide each, `laneChangeDuration`) plus
    // travel between them comfortably fit inside 1200 ticks (20 s).
    for (let tick = 0; tick < 1200 && vehicle.lanelet !== outer; tick++) {
      stepLaneChange(sim);
      integrateAll(sim);
      const current = sim.lanelet(vehicle.lanelet)!;
      if (current.laneIndex !== priorIndex) {
        expect(current.laneIndex).toBe(priorIndex + 1);
        priorIndex = current.laneIndex!;
        transfers++;
      }
      expect(vehicle.movementIntent).toBe(right.id);
      expect(vehicle.s).toBeLessThan(current.length);
    }
    expect(transfers).toBe(3);
    expect(vehicle.lanelet).toBe(outer);
    expect(vehicle.desiredLane).toBeNull();
    expect(vehicle.route[1]).toBe(right.id);
  });
});
