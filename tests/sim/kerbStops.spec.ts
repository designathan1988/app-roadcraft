import { describe, expect, it } from 'vitest';

import { step } from '@sim/pipeline';
import { DT } from '@sim/params';
import { m } from '@world/units';
import { collisions, fixtureDoc, simOf } from './support/bodies';

/**
 * PEOPLE GET IN AND OUT OF CARS AT THE KERB.
 *
 * Before this nobody ever got in or out of a vehicle and no door ever moved.
 * These tests run the saved player map and follow every kerb stop: the car
 * stops in the kerb lane, a kerb-side door opens only once it has stopped and
 * nobody is in the way of it, the passenger moves across, the door shuts, and
 * a dropped-off passenger is a pedestrian on the footway afterwards.
 */
describe('kerb stops', () => {
  it('stop, open the door only when stopped and clear, move somebody across, and shut it', () => {
    const sim = simOf(fixtureDoc(), 0x51de, 2);
    const phaseOf = new Map<number, string>();
    let drops = 0;
    let picks = 0;
    let movingWithDoorOpen = 0;
    let openedIntoSomebody = 0;
    let overlaps = 0;
    let droppedOnFootway = 0;

    for (let i = 0; i < Math.round(300 / DT); i++) {
      const before = new Set(sim.peds.keys());
      step(sim, { traffic: true, pedestrians: true });
      if (i % 10 === 0) overlaps += collisions(sim).length;
      for (const v of sim.vehicles.values()) {
        const stop = v.kerbStop;
        const key = stop ? `${stop.kind}:${stop.phase}` : '';
        const prev = phaseOf.get(v.id) ?? '';
        if (v.doors.some((d) => d > 0) && v.v > 0.05) movingWithDoorOpen++;
        if (stop && key !== prev && stop.phase === 'open') {
          // The door starts to open: nobody inside its swing.
          const lane = sim.lanelet(v.lanelet)!;
          const f = lane.centre.sampleAt(Math.max(0, v.s - v.archetype.length * 0.5));
          for (const p of sim.peds.values()) {
            if (p.id === stop.pedId) continue;
            if (Math.hypot(p.x - f.p.x, p.y - f.p.y) < v.archetype.width / 2 + m(0.3)) openedIntoSomebody++;
          }
        }
        if (prev.endsWith('transfer') && key.endsWith('close')) {
          if (prev.startsWith('drop')) drops++;
          else picks++;
        }
        phaseOf.set(v.id, key);
      }
      for (const p of sim.peds.values()) {
        if (before.has(p.id)) continue;
        // A new pedestrian next to a car with a door open is a passenger out.
        const near = [...sim.vehicles.values()].some((v) => v.kerbStop?.kind === 'drop' &&
          (v.kerbStop.phase === 'transfer' || v.kerbStop.phase === 'close'));
        if (near && sim.sidewalks.edges.get(p.edge)?.kind === 'walk') droppedOnFootway++;
      }
    }

    expect(drops).toBeGreaterThan(2);
    expect(picks).toBeGreaterThan(0);
    expect(droppedOnFootway).toBeGreaterThanOrEqual(drops);
    expect(movingWithDoorOpen).toBe(0);
    expect(openedIntoSomebody).toBe(0);
    expect(overlaps).toBe(0);
  }, 180_000);
});
