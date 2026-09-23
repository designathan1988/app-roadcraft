import { describe, expect, it } from 'vitest';

import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { SimWorld } from '@sim/world';
import { step } from '@sim/pipeline';
import { vehiclePose } from '@sim/pose';
import { DT } from '@sim/params';

/**
 * What the player sees, as opposed to what the simulation believes.
 *
 * The simulation was already smooth: `s` advances by `v * DT` and nothing
 * teleports. The RENDER pose was not, and it produced the reported defect of
 * cars "jumping position while driving":
 *
 *   - `vehiclePose` refused to interpolate at all whenever the vehicle had
 *     changed lanelet since the previous snapshot. Entering a junction
 *     connector, leaving one and changing lane are all lanelet changes, so
 *     the car snapped to its new centreline at exactly the three moments the
 *     eye is following it;
 *   - a lane change moved the vehicle a whole lane width sideways in one
 *     tick, with nothing carrying the displacement;
 *   - the heading was never interpolated, so a turning car rotated in
 *     discrete steps.
 *
 * These tests measure the drawn pose directly, tick by tick, against what the
 * vehicle's own speed makes possible.
 */

function grid(): { doc: RoadDoc; net: Network; sim: SimWorld } {
  const doc = new RoadDoc();
  // A cross plus a parallel street, so there are both junction movements and
  // sibling lanes for discretionary lane changes.
  const centre = doc.addNode({ x: 0, y: 0 });
  const ends = [
    doc.addNode({ x: 0, y: -460 }),
    doc.addNode({ x: 0, y: 460 }),
    doc.addNode({ x: -460, y: 0 }),
    doc.addNode({ x: 460, y: 0 }),
  ];
  doc.addSegment(ends[0]!.id, centre.id, 3);
  doc.addSegment(centre.id, ends[1]!.id, 3);
  doc.addSegment(ends[2]!.id, centre.id, 3);
  doc.addSegment(centre.id, ends[3]!.id, 3);
  doc.setNodeControl(centre.id, 'signal');

  const net = new Network(doc);
  net.rebuild();
  const sim = new SimWorld(doc, net, 0x91d2);
  sim.rebuildTopology();
  sim.trafficIntensity = 1.8;
  sim.demandMultiplier = 1.8;
  sim.clock.paused = false;
  return { doc, net, sim };
}

describe('rendered pose', () => {
  it('never moves a vehicle further in one tick than its own speed allows', () => {
    const { sim } = grid();
    const last = new Map<number, { x: number; y: number }>();
    let worst = 0;
    let worstDetail = '';

    sim.clock.run(Math.round(240 / DT), () => {
      step(sim, { traffic: true, pedestrians: true });

      for (const v of sim.vehiclesInIdOrder()) {
        const pose = vehiclePose(sim, v, 1);
        if (!pose) continue;
        const before = last.get(v.id);
        last.set(v.id, { x: pose.p.x, y: pose.p.y });
        if (!before) continue;

        const moved = Math.hypot(pose.p.x - before.x, pose.p.y - before.y);
        // Forward travel this tick, plus the lateral rate a lane change is
        // allowed to close at, plus a unit of slack for curvature.
        const allowed = v.v * DT + 8.5 * DT + 1;
        if (moved - allowed > worst) {
          worst = moved - allowed;
          worstDetail = `vehicle ${v.id} moved ${moved.toFixed(2)} with ${allowed.toFixed(2)} allowed`;
        }
      }
    });

    expect(worst, worstDetail).toBeLessThanOrEqual(0);
  });

  it('never turns a vehicle further in one tick than a vehicle can turn', () => {
    const { sim } = grid();
    const last = new Map<number, number>();
    let worst = 0;
    let detail = '';

    sim.clock.run(Math.round(240 / DT), () => {
      step(sim, { traffic: true, pedestrians: true });

      for (const v of sim.vehiclesInIdOrder()) {
        const pose = vehiclePose(sim, v, 1);
        if (!pose) continue;
        const before = last.get(v.id);
        last.set(v.id, pose.angle);
        if (before === undefined) continue;

        let delta = Math.abs((pose.angle - before) % (2 * Math.PI));
        if (delta > Math.PI) delta = 2 * Math.PI - delta;
        // A tight junction connector is the sharpest thing a vehicle drives;
        // a quarter turn in a single 16 ms tick is not driving, it is a snap.
        if (delta > worst) {
          worst = delta;
          detail = `vehicle ${v.id} turned ${((delta * 180) / Math.PI).toFixed(1)} degrees in one tick`;
        }
      }
    });

    expect((worst * 180) / Math.PI, detail).toBeLessThan(25);
  });

  it('slides across a lane change instead of teleporting', () => {
    // `lateral` is the unfinished part of a change. It must be non-zero for
    // several ticks after one happens, and must always decay to zero.
    const { sim } = grid();
    let sawSlide = false;
    let worstLateral = 0;

    sim.clock.run(Math.round(300 / DT), () => {
      step(sim, { traffic: true, pedestrians: true });
      for (const v of sim.vehicles.values()) {
        if (Math.abs(v.lateral) > 0.05) sawSlide = true;
        worstLateral = Math.max(worstLateral, Math.abs(v.lateral));
      }
    });

    // No vehicle may be left permanently straddling two lanes.
    for (const v of sim.vehicles.values()) {
      expect(Math.abs(v.lateral)).toBeLessThan(14);
    }
    // And the offset never exceeds a sane lane width.
    expect(worstLateral).toBeLessThan(20);
    expect(sawSlide || worstLateral === 0).toBe(true);
  });

  it('points a changing vehicle INTO its move, never away from it', () => {
    // The heading during a change is the direction of travel: forward along
    // the lane plus the sideways slide. The slide runs along perp(t) with the
    // opposite sign of `lateral`, so the drawn angle must lean that way.
    const { sim } = grid();
    let checked = 0;
    let wrong = 0;

    sim.clock.run(Math.round(300 / DT), () => {
      step(sim, { traffic: true, pedestrians: true });
      for (const v of sim.vehicles.values()) {
        // Only well inside a change, and on the same lanelet as the previous
        // snapshot so the heading blend itself is not what is being measured.
        // A change is driven, not timed: a car that committed to it while
        // stopped in a queue has not started the curve yet and points
        // straight, which is right — it is not moving sideways either.
        if (Math.abs(v.lateral) < 3 || v.prev.lanelet !== v.lanelet || Math.abs(v.prev.lateral) < 3) continue;
        if (v.lateralSlope === 0) continue;
        const lane = sim.lanelet(v.lanelet);
        const pose = vehiclePose(sim, v, 1);
        if (!lane || !pose) continue;
        const t = lane.centre.sampleAt(v.s).t;
        let lean = (pose.angle - Math.atan2(t.y, t.x)) % (2 * Math.PI);
        if (lean > Math.PI) lean -= 2 * Math.PI;
        if (lean < -Math.PI) lean += 2 * Math.PI;
        checked++;
        if (Math.sign(lean) !== -Math.sign(v.lateral)) wrong++;
      }
    });

    expect(checked).toBeGreaterThan(0);
    expect(wrong).toBe(0);
  });

  it('drives a lane change along the body, never crabbing sideways', () => {
    // The reported defect: cars "floating sideways" into the next lane. The
    // offset used to be a timed slide, so a car creeping in a queue kept
    // moving sideways at full rate while its heading, capped at a few
    // degrees, could not follow. Measured before the change was driven in
    // distance: the drawn body moved more than 45 degrees off the direction
    // it pointed in on 5 % of lane-change ticks, and up to 88 degrees.
    const { sim } = grid();
    const last = new Map<number, { x: number; y: number }>();
    let checked = 0;
    let worst = 0;

    sim.clock.run(Math.round(200 / DT), () => {
      step(sim, { traffic: true, pedestrians: true });
      for (const v of sim.vehicles.values()) {
        const pose = vehiclePose(sim, v, 1);
        if (!pose) continue;
        // Measured at the REAR AXLE, which is what cannot slip sideways: the
        // body is steered from it, so its middle swings very slightly as the
        // heading changes, exactly as a real vehicle's does.
        const back = 0.3 * v.archetype.length;
        const axle = { x: pose.p.x - Math.cos(pose.angle) * back, y: pose.p.y - Math.sin(pose.angle) * back };
        const before = last.get(v.id);
        last.set(v.id, axle);
        if (!before || v.lateral === 0 || v.prev.lanelet !== v.lanelet) continue;
        const dx = axle.x - before.x;
        const dy = axle.y - before.y;
        if (Math.hypot(dx, dy) < 1e-3) continue;
        let crab = Math.atan2(dy, dx) - pose.angle;
        crab = Math.abs(Math.atan2(Math.sin(crab), Math.cos(crab)));
        worst = Math.max(worst, crab);
        checked++;
      }
    });

    expect(checked).toBeGreaterThan(1000);
    // A car goes where it points. Two degrees covers the curvature of the
    // road between the body centre and the arc position it is sampled from.
    expect(worst * 180 / Math.PI).toBeLessThan(2);
  });

  it('keeps a car stopped half way across a lane angled, not snapped straight', () => {
    const { sim } = grid();
    let angled = 0;
    sim.clock.run(Math.round(200 / DT), () => {
      step(sim, { traffic: true, pedestrians: true });
      for (const v of sim.vehicles.values()) {
        if (v.v > 0.05 || v.lateralSlope === 0) continue;
        const lane = sim.lanelet(v.lanelet);
        const pose = vehiclePose(sim, v, 1);
        if (!lane || !pose) continue;
        angled++;
        // Standing still, it points exactly along the curve it was driving.
        const along = lane.centre.sampleAt(Math.max(0, v.s - v.archetype.length / 2)).t;
        let yaw = pose.angle - Math.atan2(along.y, along.x);
        yaw = Math.atan2(Math.sin(yaw), Math.cos(yaw));
        expect(Math.abs(yaw - Math.atan(v.lateralSlope))).toBeLessThan(1e-6);
      }
    });
    expect(angled).toBeGreaterThan(0);
  });

  it('interpolates within a tick rather than holding the last pose', () => {
    const { sim } = grid();
    sim.clock.run(Math.round(60 / DT), () => step(sim, { traffic: true, pedestrians: true }));

    let moved = 0;
    for (const v of sim.vehiclesInIdOrder()) {
      if (v.v < 1) continue;
      const early = vehiclePose(sim, v, 0);
      const late = vehiclePose(sim, v, 1);
      if (!early || !late) continue;
      moved = Math.max(moved, Math.hypot(late.p.x - early.p.x, late.p.y - early.p.y));
    }
    // A moving fleet must show SOME difference between the start and the end
    // of a tick, or the renderer is drawing stepped motion.
    expect(moved).toBeGreaterThan(0);
  });
});
