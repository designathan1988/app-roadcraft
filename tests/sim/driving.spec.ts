import { describe, expect, it } from 'vitest';

import { step } from '@sim/pipeline';
import { DT } from '@sim/params';
import { vehiclePose } from '@sim/pose';
import { indicatorSide } from '@render/vehicleSignals';
import { collisions, fixtureDoc, simOf } from './support/bodies';

/**
 * HOW THE FLEET DRIVES, measured on the saved player map.
 *
 * Each figure here was measured wrong before the fix it guards:
 *
 *   - the indicator came on as a car was already moving across: 16 of 196
 *     lane changes had shown it for a second beforehand;
 *   - a car pulled out of its turning lane by the keep-to-the-kerb bias was
 *     pulled straight back by its route, lane after lane;
 *   - bodies turned in steps at every vertex of a path, measured as yaw rates
 *     of up to 13 rad/s;
 *   - the queue-release response applied to every car following another, so
 *     the whole fleet cruised at a median of 0.6 s bumper to bumper.
 */
describe('driving', () => {
  it('signals, changes lane without oscillating, turns smoothly and keeps its distance', () => {
    const sim = simOf(fixtureDoc(), 0x51de, 2);
    const last = new Map<number, { lane: string; segment: number | undefined; index: number | undefined; angle: number;
      signalled: number; changes: { age: number; from: number; to: number }[] }>();
    let changes = 0;
    let signalledFirst = 0;
    let flipBacks = 0;
    let overlaps = 0;
    let worstYaw = 0;
    const headways: number[] = [];
    const cruise = new Map<string, number[]>();

    for (let i = 0; i < Math.round(240 / DT); i++) {
      step(sim, { traffic: true, pedestrians: false });
      if (i % 10 === 0) overlaps += collisions(sim).length;
      for (const v of sim.vehicles.values()) {
        const lane = sim.lanelet(v.lanelet);
        if (!lane) continue;
        const pose = vehiclePose(sim, v, 1);
        const prev = last.get(v.id);
        const rec = prev ?? { lane: v.lanelet, segment: undefined, index: undefined, angle: pose?.angle ?? 0, signalled: 0, changes: [] };
        if (prev && pose && v.v > 1) {
          const d = Math.atan2(Math.sin(pose.angle - prev.angle), Math.cos(pose.angle - prev.angle));
          worstYaw = Math.max(worstYaw, Math.abs(d) / DT);
        }
        const changed = prev && prev.lane !== v.lanelet && lane.kind === 'link' &&
          sim.lanelet(prev.lane)?.kind === 'link' && prev.segment === lane.segment &&
          prev.index !== undefined && lane.laneIndex !== undefined && prev.index !== lane.laneIndex;
        if (changed) {
          changes++;
          if (rec.signalled >= 1.0) signalledFirst++;
          if (rec.changes.some((c) => c.from === lane.laneIndex && c.to === prev.index && v.age - c.age < 10)) {
            flipBacks++;
          }
          rec.changes.push({ age: v.age, from: prev.index!, to: lane.laneIndex! });
          rec.signalled = 0;
        }
        const side = indicatorSide(sim, v);
        rec.signalled = side !== 0 && Math.abs(v.lateral) < 0.02 ? rec.signalled + DT : rec.signalled * (Math.abs(v.lateral) > 0.02 ? 1 : 0);
        rec.lane = v.lanelet;
        rec.segment = lane.segment;
        rec.index = lane.laneIndex;
        rec.angle = pose?.angle ?? rec.angle;
        last.set(v.id, rec);

        const lead = v.constraints.obstacles.find((o) => o.kind === 'vehicle');
        if (lead && v.v > 5 && Math.abs(lead.speed - v.v) < 1) headways.push(lead.gap / v.v);
        if (lane.kind === 'link' && v.constraints.obstacles.every((o) => o.gap > 60) && v.v > 0.5 * lane.speedLimit) {
          const list = cruise.get(v.archetype.id) ?? [];
          list.push(v.v / lane.speedLimit);
          cruise.set(v.archetype.id, list);
        }
      }
    }

    expect(overlaps).toBe(0);
    expect(changes).toBeGreaterThan(30);
    // Nearly every change is signalled for a second first; the few that are
    // not are mandatory changes in a crawling queue (0.8 s lead).
    expect(signalledFirst / changes).toBeGreaterThan(0.75);
    expect(flipBacks / changes).toBeLessThan(0.08);
    expect(worstYaw).toBeLessThan(2.5);
    headways.sort((a, b) => a - b);
    const median = headways[Math.floor(headways.length / 2)]!;
    expect(median).toBeGreaterThan(1.0);
    expect(median).toBeLessThan(2.5);
    // Drivers and vehicle classes cruise at different speeds.
    const means = [...cruise.entries()].filter(([, xs]) => xs.length > 200)
      .map(([id, xs]) => [id, xs.reduce((a, b) => a + b, 0) / xs.length] as const);
    const cars = cruise.get('sedan') ?? [];
    const spread = Math.sqrt(cars.reduce((a, x) => a + (x - cars.reduce((p, q) => p + q, 0) / cars.length) ** 2, 0) / cars.length);
    expect(spread).toBeGreaterThan(0.02);
    const byId = Object.fromEntries(means);
    if (byId['bicycle'] !== undefined && byId['sedan'] !== undefined) expect(byId['bicycle']).toBeLessThan(byId['sedan']);
  }, 180_000);
});
