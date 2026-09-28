import { describe, expect, it } from 'vitest';
import { spawnVehicle } from '@sim/vehicles/spawn';
import { reconsiderRoute } from '@sim/routing/router';
import { step } from '@sim/pipeline';
import { DT } from '@sim/params';
import { fixtureDoc, simOf } from './support/bodies';

describe('vehicle trips', () => {
  it('keeps a reachable destination through congestion-driven replanning', () => {
    const sim = simOf(fixtureDoc(), 0x511a, 1);
    expect(spawnVehicle(sim)).toBe(true);
    const vehicle = [...sim.vehicles.values()][0]!;
    expect(vehicle.destination).not.toBeNull();
    expect(vehicle.route[0]).toBe(vehicle.lanelet);
    expect(vehicle.route.at(-1)).toBe(vehicle.destination);
    for (let i = 0; i + 2 < vehicle.route.length; i += 2) {
      const from = vehicle.route[i]!;
      const connector = vehicle.route[i + 1]!;
      const to = vehicle.route[i + 2]!;
      expect(sim.graph.exitsOf(from)).toContain(connector);
      expect(sim.connector(connector)?.toLane).toBe(to);
    }
    const destination = vehicle.destination;
    vehicle.heldUp = vehicle.driver.patience;
    reconsiderRoute(sim, vehicle);
    expect(vehicle.destination).toBe(destination);
    expect(vehicle.route.at(-1)).toBe(destination);
  });

  it('assigns the same trip for the same authored map and seed', () => {
    const first = simOf(fixtureDoc(), 0x511a, 1);
    const second = simOf(fixtureDoc(), 0x511a, 1);
    expect(spawnVehicle(first)).toBe(true);
    expect(spawnVehicle(second)).toBe(true);
    expect([...first.vehicles.values()][0]!.destination).toBe([...second.vehicles.values()][0]!.destination);
    expect([...first.vehicles.values()][0]!.route).toEqual([...second.vehicles.values()][0]!.route);
  });

  it('lets a vehicle finish its chosen trip', () => {
    const sim = simOf(fixtureDoc(), 0x511a, 1);
    expect(spawnVehicle(sim)).toBe(true);
    sim.trafficIntensity = 0;
    sim.clock.run(Math.round(120 / DT), () => step(sim, { pedestrians: false }));
    expect(sim.completedTrips).toBeGreaterThan(0);
  });
});
