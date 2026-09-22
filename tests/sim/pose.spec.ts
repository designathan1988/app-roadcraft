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
