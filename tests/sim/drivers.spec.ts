import { describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';

import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { SimWorld } from '@sim/world';
import { step } from '@sim/pipeline';
import { DT } from '@sim/params';
import { ARCHETYPES, archetypeById } from '@sim/vehicles/archetypes';
import { desiredSpeed, makeDriver } from '@sim/vehicles/driver';
import { Rng } from '@core/rng';

/**
 * The driver, as distinct from the vehicle.
 *
 * These are the properties the "traffic looks robotic" complaint actually names:
 * that two cars of the same class behave differently, that one of them is
 * willing to pull out and pass, and that neither of those costs the safety the
 * rest of the engine depends on.
 */

function fleetOfDrivers(n: number) {
  const rng = new Rng(0x51ce);
  const sedan = archetypeById('sedan');
  return Array.from({ length: n }, () => makeDriver(sedan, () => rng.float()));
}

const spread = (values: readonly number[]): number => {
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance =
    values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance) / Math.abs(mean);
};

describe('driver variation', () => {
  it('gives two drivers of the same class different comfort parameters', () => {
    const drivers = fleetOfDrivers(400);
    expect(spread(drivers.map((d) => d.a))).toBeGreaterThan(0.08);
    expect(spread(drivers.map((d) => d.T))).toBeGreaterThan(0.08);
    expect(spread(drivers.map((d) => d.s0))).toBeGreaterThan(0.03);
    expect(spread(drivers.map((d) => d.gapFactor))).toBeGreaterThan(0.08);
  });

  it('barely varies the emergency brake', () => {
    // The safe-speed cap sizes every following distance from `bEmergency`. A
    // driver who cannot brake as hard as the cap assumed can be driven into the
    // car in front by arithmetic, so this one is deliberately almost constant.
    const drivers = fleetOfDrivers(400);
    expect(spread(drivers.map((d) => d.bEmergency))).toBeLessThan(0.02);
    const sedan = archetypeById('sedan');
    for (const driver of drivers) {
      expect(driver.bEmergency).toBeGreaterThan(sedan.bEmergency * 0.97);
      expect(driver.bEmergency).toBeLessThan(sedan.bEmergency * 1.03);
    }
  });

  it('keeps one driver internally consistent', () => {
    // Drawing each parameter independently gives a population that is varied
    // and individually incoherent: someone who tailgates and then refuses a
    // forty-metre gap reads as a bug rather than as a person.
    for (const driver of fleetOfDrivers(200)) {
      const sedan = archetypeById('sedan');
      const quick = driver.a > sedan.a;
      expect(driver.T < sedan.T).toBe(quick);
      expect(driver.gapFactor < 1).toBe(quick);
      expect(driver.laneThreshold < 0.35).toBe(quick);
    }
  });

  it('holds every archetype inside sane bounds', () => {
    const rng = new Rng(0x7a11);
    for (const archetype of ARCHETYPES) {
      for (let i = 0; i < 60; i++) {
        const driver = makeDriver(archetype, () => rng.float());
        expect(driver.a).toBeGreaterThan(0);
        expect(driver.b).toBeGreaterThan(0);
        expect(driver.T).toBeGreaterThan(0.3);
        expect(driver.s0).toBeGreaterThan(0);
        expect(driver.politeness).toBeGreaterThanOrEqual(0.05);
        expect(driver.patience).toBeGreaterThan(2);
        expect(Number.isFinite(driver.driftPhase)).toBe(true);
      }
    }
  });

  it('wanders the target speed continuously and within bounds', () => {
    const rng = new Rng(0x2b1a);
    const driver = makeDriver(archetypeById('hatch'), () => rng.float());
    let previous = desiredSpeed(driver, 40, 0);
    let worst = 0;
    for (let t = DT; t < 600; t += DT) {
      const now = desiredSpeed(driver, 40, t);
      worst = Math.max(worst, Math.abs(now - previous));
      expect(now).toBeGreaterThan(40 * 0.9);
      expect(now).toBeLessThan(40 * 1.1);
      previous = now;
    }
    // Continuous: a target that jumps makes the free-flow term of IDM jump.
    expect(worst).toBeLessThan(0.02);
  });

  it('is reproducible from the same seed', () => {
    expect(fleetOfDrivers(50).map((d) => d.aggression)).toEqual(
      fleetOfDrivers(50).map((d) => d.aggression),
    );
  });
});

/** A straight four-lane avenue with a dead end at each side, so traffic enters. */
function avenue() {
  const doc = new RoadDoc();
  const a = doc.addNode({ x: -900, y: 0 });
  const b = doc.addNode({ x: 900, y: 0 });
  const segment = doc.addSegment(a.id, b.id, 3);
  if (!segment) throw new Error('the fixture failed to build its avenue');
  const net = new Network(doc);
  net.rebuild();
  const sim = new SimWorld(doc, net, 0x1d1a);
  sim.rebuildTopology();
  sim.trafficIntensity = 1.8;
  sim.demandMultiplier = 1.8;
  sim.clock.paused = false;
  return { doc, net, sim, segment: segment.id };
}

function run(sim: SimWorld, seconds: number): void {
  for (let i = 0; i < Math.round(seconds / DT); i++) {
    step(sim, { traffic: true, pedestrians: false });
  }
}

describe('overtaking', () => {
  it('lets faster vehicles pass slower ones instead of queueing behind them', () => {
    // Without a discretionary change every vehicle inherits the speed of the
    // slowest one ahead of it for the length of the block, which is why a
    // bicycle on an avenue used to gather a silent procession behind it.
    //
    // The measurement is an actual OVERTAKE: a pair that swaps order along the
    // road while travelling the same way. Counting lane changes alone would
    // pass on a fleet that shuffled sideways and got nowhere.
    const { sim } = avenue();
    run(sim, 120);

    const direction = (id: string): string => id.slice(0, id.lastIndexOf(':'));
    const before = new Map<number, { s: number; dir: string }>();
    for (const v of sim.vehiclesInIdOrder()) {
      before.set(v.id, { s: v.s, dir: direction(v.lanelet) });
    }

    // Short enough that the pairs sampled above are still on the road: the
    // avenue is 1800 units and a free-flowing car covers that in about a minute.
    let attemptedChanges = 0;
    if (process.env['ROADCRAFT_RECORD_OVERTAKES'] === '1') {
      for (let tick = 0; tick < Math.round(25 / DT); tick++) {
        step(sim, { traffic: true, pedestrians: false });
        for (const vehicle of sim.vehicles.values()) {
          if (vehicle.prev.lanelet !== vehicle.lanelet &&
              sim.lanelet(vehicle.lanelet)?.kind === 'link') attemptedChanges++;
        }
      }
    } else run(sim, 25);

    let olderOvertakes = 0;
    let youngerOvertakes = 0;
    const after = [...sim.vehiclesInIdOrder()];
    for (const a of after) {
      const wasA = before.get(a.id);
      if (!wasA || wasA.dir !== direction(a.lanelet)) continue;
      for (const b of after) {
        if (b.id <= a.id) continue;
        const wasB = before.get(b.id);
        if (!wasB || wasB.dir !== wasA.dir || direction(b.lanelet) !== wasA.dir) continue;
        if (wasA.s < wasB.s && a.s > b.s) olderOvertakes++;
        if (wasA.s > wasB.s && a.s < b.s) youngerOvertakes++;
      }
    }
    if (process.env['ROADCRAFT_RECORD_OVERTAKES'] === '1') {
      writeFileSync('docs/audit/overtaking-baseline.json', JSON.stringify({
        before: before.size, after: after.length, attemptedChanges,
        olderOvertakes, youngerOvertakes, overtakes: olderOvertakes + youngerOvertakes,
        vehicles: after.map(vehicle => ({ id: vehicle.id, type: vehicle.archetype.id,
          s: vehicle.s, speed: vehicle.v, lanelet: vehicle.lanelet, lateral: vehicle.lateral,
          age: vehicle.age })),
      }, null, 2) + '\n');
    }
    // IDs order spawn time, not driving order. A newly spawned faster car can
    // pass an older slow one; both directions of an actual order swap count.
    expect(olderOvertakes + youngerOvertakes).toBeGreaterThan(0);

    // And the fleet is mixed, so the speeds on an open road must be mixed too.
    const rolling = after.filter((v) => v.age > 20);
    expect(rolling.length).toBeGreaterThan(6);
    expect(spread(rolling.map((v) => v.v))).toBeGreaterThan(0.1);
  });

  it('does not let the fleet accumulate in the inner lane', () => {
    // MOBIL is perfectly reversible without an asymmetry, so a fleet that drifts
    // inward stays there. The keep-to-the-kerb bias is what drains it back, and
    // this is the number that says whether it does.
    const { sim } = avenue();
    run(sim, 240);
    const byIndex = new Map<number, number>();
    for (const v of sim.vehiclesInIdOrder()) {
      const index = sim.lanelet(v.lanelet)?.laneIndex;
      if (index === undefined) continue;
      byIndex.set(index, (byIndex.get(index) ?? 0) + 1);
    }
    const counts = [...byIndex.values()];
    expect(counts.length).toBeGreaterThan(1);
    const total = counts.reduce((sum, n) => sum + n, 0);
    for (const n of counts) expect(n / total).toBeGreaterThan(0.2);
  });

  it('does not weave: discretionary changes are rare per driver', () => {
    // MOBIL without a refractory period flips a driver sitting exactly on the
    // threshold between two lanes every tick. This is what pins the guard.
    const { sim } = avenue();
    run(sim, 60);
    const changes = new Map<number, number>();
    const lane = new Map<number, string>();
    const seconds = 120;
    for (let i = 0; i < Math.round(seconds / DT); i++) {
      step(sim, { traffic: true, pedestrians: false });
      for (const v of sim.vehiclesInIdOrder()) {
        const was = lane.get(v.id);
        if (was !== undefined && was !== v.lanelet) {
          changes.set(v.id, (changes.get(v.id) ?? 0) + 1);
        }
        lane.set(v.id, v.lanelet);
      }
    }
    for (const [, count] of changes) {
      // A lane change every four seconds is the hard floor the cooldown sets;
      // anything near it over two minutes would be a vehicle weaving.
      expect(count).toBeLessThan(seconds / 4);
    }
  });

  it('keeps every vehicle on a real lanelet at a finite speed while doing it', () => {
    const { sim } = avenue();
    run(sim, 300);
    for (const v of sim.vehiclesInIdOrder()) {
      expect(Number.isFinite(v.s)).toBe(true);
      expect(Number.isFinite(v.v)).toBe(true);
      expect(v.v).toBeGreaterThanOrEqual(-1e-6);
      const lane = sim.lanelet(v.lanelet);
      expect(lane).toBeDefined();
      expect(v.s).toBeGreaterThan(-1e-3);
      expect(v.s).toBeLessThan((lane?.length ?? 0) + 1e-3);
    }
  });

  it('never overlaps two vehicles in one lane', () => {
    // The change is decided here and performed by the integrator; a gap test
    // that passed on stale positions would show up as two bodies in one place.
    const { sim } = avenue();
    run(sim, 300);
    const byLane = new Map<string, { s: number; length: number }[]>();
    for (const v of sim.vehiclesInIdOrder()) {
      const list = byLane.get(v.lanelet) ?? [];
      list.push({ s: v.s, length: v.archetype.length });
      byLane.set(v.lanelet, list);
    }
    for (const [, list] of byLane) {
      list.sort((x, y) => x.s - y.s);
      for (let i = 1; i < list.length; i++) {
        const ahead = list[i] as { s: number; length: number };
        const behind = list[i - 1] as { s: number; length: number };
        expect(ahead.s - ahead.length).toBeGreaterThan(behind.s - 0.5);
      }
    }
  });
});
