import { describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';

import { step } from '@sim/pipeline';
import { DT } from '@sim/params';
import { spawnVehicle } from '@sim/vehicles/spawn';
import { stepLaneChange } from '@sim/vehicles/laneChange';
import { integrateAll } from '@sim/vehicles/integrate';
import { snapshot } from '@sim/vehicles/state';
import { createPed } from '@sim/peds/state';
import { vehiclePose } from '@sim/pose';
import { findLeader } from '@sim/vehicles/leaderIndex';
import { BODY_CLASSES, BODY_ENVELOPE, bodyClassOf } from '@world/conflictPoints';
import { ARCHETYPES } from '@sim/vehicles/archetypes';
import { LAYOUTS, bodiesOverlap, bodyOf, collisions, fixtureDoc, layoutDoc, simOf } from './support/bodies';

/**
 * TWO CARS NEVER OCCUPY THE SAME PIECE OF ROAD.
 *
 * Every other safety check in this suite asks a proxy question: is the conflict
 * zone claimed, is the arc gap positive, is the lane order monotone. A
 * collision is none of those. It is two rectangles — at the real length, width
 * and DRAWN angle of the vehicles — overlapping, and that is what this measures.
 *
 * It found 120 overlapping pairs across seven seeded scenarios when the
 * conflict index was still the intersection of two centrelines: bodies grazing
 * on opposing left turns, a bus swinging over the turn beside it, a follower
 * driving into the tail of a leader that had taken the other movement out of
 * the same lane, and — the largest group — a vehicle driving into one that had
 * "already" changed lane while its body was still across the old one.
 */

const SECONDS = 150;

describe('vehicle bodies', () => {
  it('never overlap, in any junction shape', () => {
    const scenarios = [
      ...LAYOUTS.map((layout) => ({ name: layout.name, doc: layoutDoc(layout).doc })),
      { name: 'player-grid', doc: fixtureDoc() },
    ];

    const offences: unknown[] = [];
    let ticks = 0;
    let bodies = 0;

    for (const scenario of scenarios) {
      const sim = simOf(scenario.doc, 0x51de, 2);
      sim.clock.run(Math.round(SECONDS / DT), () => {
        step(sim, { traffic: true, pedestrians: true });
        ticks++;
        bodies += sim.vehicles.size;
        for (const hit of collisions(sim)) {
          if (offences.length >= 10) return;
          offences.push({
            scenario: scenario.name,
            tick: sim.clock.tick,
            category: hit.category,
            a: { id: hit.a.id, archetype: hit.a.archetype.id, lanelet: hit.a.lanelet,
              s: +hit.a.s.toFixed(2), lateral: +hit.a.lateral.toFixed(2) },
            b: { id: hit.b.id, archetype: hit.b.archetype.id, lanelet: hit.b.lanelet,
              s: +hit.b.s.toFixed(2), lateral: +hit.b.lateral.toFixed(2) },
          });
        }
      });
    }

    if (process.env['ROADCRAFT_RECORD_COLLISIONS'] === '1') {
      writeFileSync('docs/audit/vehicle-collisions.json',
        JSON.stringify({ ticks, bodies, offences }, null, 2) + '\n');
    }
    expect(ticks).toBeGreaterThan(50_000);
    expect(bodies).toBeGreaterThan(500_000);
    expect(offences).toEqual([]);
    // Seven scenarios of 150 s each: about 30 s bare, and over 100 s under
    // `npm run check`'s coverage instrumentation, past the 60 s default.
  }, 240_000);

  it('keep the vehicle in BOTH lanes while it slides between them', () => {
    // The transfer moves the occupancy index at once; the body takes about a
    // second to follow. `Vehicle.shadow` is what keeps it visible in the lane
    // it is leaving, and this checks the shadow against the drawn body rather
    // than against its own bookkeeping.
    const sim = simOf(layoutDoc(LAYOUTS[0]!).doc, 0x51de, 2);
    let changes = 0;
    let shadowed = 0;
    let overlapping = 0;

    sim.clock.run(Math.round(120 / DT), () => {
      const before = new Map([...sim.vehicles.values()].map((v) => [v.id, v.lanelet]));
      step(sim, { traffic: true, pedestrians: true });

      for (const v of sim.vehicles.values()) {
        const was = before.get(v.id);
        const lane = sim.lanelet(v.lanelet);
        if (was === undefined || was === v.lanelet) continue;
        if (lane?.kind !== 'link' || sim.lanelet(was)?.segment !== lane.segment) continue;
        changes++;
        expect(v.shadow?.lanelet, `vehicle ${v.id} left ${was} with no shadow`).toBe(was);
      }

      for (const v of sim.vehicles.values()) {
        if (!v.shadow) continue;
        shadowed++;
        const body = bodyOf(sim, v);
        const old = sim.lanelet(v.shadow.lanelet);
        if (!body || !old) continue;
        // The shadow's arc position must be where the body actually is.
        const frame = old.centre.sampleAt(
          Math.max(0, Math.min(old.length, v.s + v.shadow.offset - v.archetype.length / 2)),
        );
        const dx = body.c.x - frame.p.x;
        const dy = body.c.y - frame.p.y;
        // Along the lane it is leaving, the shadow is within a body length.
        expect(Math.abs(dx * frame.t.x + dy * frame.t.y)).toBeLessThan(v.archetype.length);
        if (Math.abs(dx * -frame.t.y + dy * frame.t.x) < (v.archetype.width +
          (BODY_ENVELOPE[2]?.width ?? 0)) / 2) overlapping++;
      }
    });

    expect(changes).toBeGreaterThan(5);
    expect(shadowed).toBeGreaterThan(changes);
    // A shadow that never overlaps the old lane would be pure cost.
    expect(overlapping).toBeGreaterThan(0);
  });

  it('is never driven into by a vehicle entering the lane it is leaving', () => {
    // The direct reproduction: a vehicle mid-change is an obstacle for
    // whoever is behind it in the OLD lane, not only in the new one.
    const sim = simOf(layoutDoc(LAYOUTS[0]!).doc, 0x9e1);
    expect(spawnVehicle(sim)).toBe(true);
    const mover = sim.vehicles.get(1)!;
    const lane = sim.lanelet(mover.lanelet)!;
    const sibling = [...sim.graph.siblingLanes(lane.id)]
      .map((id) => sim.lanelet(id)!)
      .find((l) => Math.abs((l.laneIndex ?? 0) - (lane.laneIndex ?? 0)) === 1)!;

    mover.s = 120;
    mover.v = 12;
    mover.prev = snapshot(mover);
    sim.exitLanelet(mover, mover.lanelet);
    sim.enterLanelet(mover, lane.id, false);
    mover.laneChange = sibling.id;
    integrateAll(sim);
    expect(mover.lanelet).toBe(sibling.id);
    expect(mover.shadow?.lanelet).toBe(lane.id);

    // Anybody behind it in the lane it left must still see it.
    expect(spawnVehicle(sim)).toBe(true);
    const follower = [...sim.vehicles.values()].find((v) => v.id !== mover.id)!;
    sim.exitLanelet(follower, follower.lanelet);
    follower.lanelet = lane.id;
    follower.s = 100;
    follower.v = 20;
    follower.prev = snapshot(follower);
    sim.enterLanelet(follower, lane.id, false);

    const seen = sim.bodiesIn(lane.id).find((b) => b.vehicle.id === mover.id);
    expect(seen, 'the sliding body is invisible in the lane it is leaving').toBeTruthy();

    // Its leader is the sliding body, at the body's real position.
    const leader = findLeader(sim, follower)!;
    const rear = seen!.s - mover.archetype.length;
    expect(leader.gap).toBeCloseTo(rear - follower.s, 6);

    // And nothing closes that gap into a collision while the slide lasts.
    for (let i = 0; i < 120; i++) {
      stepLaneChange(sim);
      step(sim, { traffic: true, pedestrians: false });
      const a = bodyOf(sim, mover);
      const b = bodyOf(sim, follower);
      expect(a && b && bodiesOverlap(a, b)).toBe(false);
    }
  });

  it('measure every archetype against the size class its conflicts use', () => {
    // The conflict index is built in `world`, which knows nothing about the
    // fleet, so its envelopes must contain every archetype `sim` can spawn.
    for (const archetype of ARCHETYPES) {
      const cls = bodyClassOf(archetype.length, archetype.width);
      const envelope = BODY_ENVELOPE[cls]!;
      expect(archetype.length, archetype.id).toBeLessThanOrEqual(envelope.length);
      expect(archetype.width, archetype.id).toBeLessThanOrEqual(envelope.width);
    }
    // Every class must be reachable, or a class is dead weight in the table.
    const used = new Set(ARCHETYPES.map((a) => bodyClassOf(a.length, a.width)));
    for (const cls of BODY_CLASSES) expect(used.has(cls), `class ${cls} unused`).toBe(true);
  });
});

/** The pose used by every check here is the one the renderer draws. */
it('measures the drawn pose, not the arc position', () => {
  const sim = simOf(layoutDoc(LAYOUTS[0]!).doc, 0x77);
  expect(spawnVehicle(sim)).toBe(true);
  const v = sim.vehicles.get(1)!;
  const pose = vehiclePose(sim, v, 1)!;
  const body = bodyOf(sim, v)!;
  expect(body.c.x).toBeCloseTo(pose.p.x, 9);
  expect(body.c.y).toBeCloseTo(pose.p.y, 9);
});

describe('zones reaching back over a stop line', () => {
  it('keep a heavy turn and a vehicle at the next stop line out of each other', () => {
    const { doc, centre } = layoutDoc(LAYOUTS[1]!);
    // Uncontrolled, so only the swept zone can be what holds the bus.
    doc.setNodeControl(centre, 'none');
    const sim = simOf(doc, 0x4b);
    const intrusion = sim.conflicts.queueIntrusions.find((q) => q.mine === 1 && q.theirs === 2);
    expect(intrusion, 'mixed-T has a heavy turn sweeping a car at its stop line').toBeTruthy();
    const waiting = sim.connector(intrusion!.a)!;
    const turning = sim.connector(intrusion!.b)!;

    const place = (lane: string, connector: string, archetype: string) => {
      expect(spawnVehicle(sim)).toBe(true);
      const v = [...sim.vehicles.values()].at(-1)!;
      sim.exitLanelet(v, v.lanelet);
      const link = sim.lanelet(lane)!;
      Object.assign(v, { archetype: ARCHETYPES.find((a) => a.id === archetype)! });
      v.s = link.length - 0.2;
      v.v = 0;
      v.route = [lane, connector, sim.connector(connector)!.toLane];
      v.prev = snapshot(v);
      sim.enterLanelet(v, lane, false);
      return v;
    };
    const car = place(waiting.fromLane, waiting.id, 'sedan');
    const bus = place(turning.fromLane, turning.id, 'bus');
    // The car is waiting for a pedestrian standing in its path on the crossing
    // it is about to drive over, which leaves it at its line, not admitted.
    expect(waiting.outSegment).not.toBe(turning.outSegment);
    const crossingId = `${centre}:${waiting.outSegment}`;
    const zebra = sim.sidewalks.edges.get(sim.sidewalks.crossings.get(crossingId)!)!;
    const span = sim.crossingSpans.span(waiting.id, crossingId)!;
    expect(span).toBeTruthy();
    const walker = createPed({ id: 999, color: '#fff', speed: 0, file: 0,
      ageClass: 'adult', gender: 'f',
      party: { id: 999, size: 1, pace: 0, hasChild: false }, rank: 0, edge: zebra.id, entry: zebra.from,
      s: (span.s0 + span.s1) / 2, lat: 0, tick: 0 });
    walker.state = 'Crossing';
    sim.peds.set(walker.id, walker);
    sim.pedOccupancy.set(crossingId, [walker.id]);

    step(sim, { traffic: true, pedestrians: false });
    expect(car.admittedConnector).toBeNull();
    expect(bus.admittedConnector, 'bus admitted over a waiting car').toBeNull();
    expect(bodiesOverlap(bodyOf(sim, car)!, bodyOf(sim, bus)!)).toBe(false);

    sim.removeVehicle(car);
    for (let i = 0; i < 30 && !bus.admittedConnector; i++) step(sim, { traffic: true, pedestrians: false });
    expect(bus.admittedConnector).toBe(turning.id);

    // The other order: a vehicle arriving while the bus holds the zone is
    // told to stop short of it, not at its own stop line inside the sweep.
    const late = place(waiting.fromLane, waiting.id, 'bus');
    const approach = sim.lanelet(waiting.fromLane)!;
    late.s = approach.length - 20;
    late.v = 8;
    late.prev = snapshot(late);
    sim.sortLane(sim.rt(waiting.fromLane));
    let shortStops = 0;
    for (let i = 0; i < 600; i++) {
      step(sim, { traffic: true, pedestrians: false });
      const toLine = approach.length - late.s;
      if (late.lanelet === approach.id && late.constraints.obstacles.some((o) =>
        o.kind === 'conflict' && o.gap < toLine - 0.5)) shortStops++;
      const a = bodyOf(sim, late);
      const b = bodyOf(sim, bus);
      if (!a || !b) break;
      expect(bodiesOverlap(a, b), `tick ${i}`).toBe(false);
    }
    expect(shortStops).toBeGreaterThan(0);
  });
});
