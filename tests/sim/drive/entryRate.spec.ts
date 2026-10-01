import { describe, expect, it } from 'vitest';
import { step } from '@sim/pipeline';
import { DT } from '@sim/params';
import { fixtureDoc, simOf } from '../support/bodies';

/** P1-20: traffic at 0 % for a while, then back up: cars arrive again at once. */
describe('the traffic slider', () => {
  it('brings traffic back within seconds after being at zero', () => {
    const sim = simOf(fixtureDoc(), 0x20, 1);
    sim.trafficIntensity = 0;
    for (let i = 0; i < Math.round(30 / DT); i++) step(sim, { traffic: true, pedestrians: false });
    const before = sim.nextVehicleId;
    sim.trafficIntensity = 1;
    for (let i = 0; i < Math.round(20 / DT); i++) step(sim, { traffic: true, pedestrians: false });
    expect(sim.nextVehicleId - before).toBeGreaterThan(5);
  });
});
