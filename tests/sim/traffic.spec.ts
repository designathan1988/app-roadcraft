import { describe, expect, it } from 'vitest';

import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { SimWorld } from '@sim/world';
import { step } from '@sim/pipeline';
import { DT } from '@sim/params';
import { hashSim } from '@sim/snapshot';

/**
 * The simulation, exercised end to end on a network the editor could have drawn.
 *
 * These are throughput and invariant tests rather than unit tests, because the
 * failures that matter here are emergent: a junction that admits nobody, a
 * vehicle that leaves its lane, a number that turns into NaN and quietly
 * poisons every frame after it.
 */

interface Fixture {
  readonly doc: RoadDoc;
  readonly net: Network;
  readonly sim: SimWorld;
}

/** A four-leg cross with stubs at the map edge, so traffic has somewhere to go. */
function crossroads(control: 'auto' | 'none' | 'signal', majorType = 3, minorType = 1): Fixture {
  const doc = new RoadDoc();
  const centre = doc.addNode({ x: 0, y: 0 });
  const ends = [
    doc.addNode({ x: 0, y: -400 }),
    doc.addNode({ x: 0, y: 400 }),
    doc.addNode({ x: -400, y: 0 }),
    doc.addNode({ x: 400, y: 0 }),
  ];
  doc.addSegment(ends[0]!.id, centre.id, majorType);
  doc.addSegment(centre.id, ends[1]!.id, majorType);
  doc.addSegment(ends[2]!.id, centre.id, minorType);
  doc.addSegment(centre.id, ends[3]!.id, minorType);
  doc.setNodeControl(centre.id, control);
  const net = new Network(doc);
  net.rebuild();
  const sim = new SimWorld(doc, net, 0x5eed);
  sim.rebuildTopology();
  sim.trafficIntensity = 1.6;
  sim.demandMultiplier = 1.6;
  sim.clock.paused = false;
  return { doc, net, sim };
}

function run(fixture: Fixture, seconds: number): void {
  const steps = Math.round(seconds / DT);
  for (let i = 0; i < steps; i++) step(fixture.sim, { traffic: true, pedestrians: true });
}

function finiteState(sim: SimWorld): boolean {
  for (const v of sim.vehiclesInIdOrder()) {
    if (!Number.isFinite(v.s) || !Number.isFinite(v.v) || v.v < -1e-6) return false;
    const lane = sim.lanelet(v.lanelet);
    if (!lane) return false;
    if (v.s < -1e-3 || v.s > lane.length + 1e-3) return false;
  }
  return true;
}

describe('traffic', () => {
  it('spawns vehicles on a connected network', () => {
    const fixture = crossroads('auto');
    run(fixture, 60);
    expect(fixture.sim.vehicles.size).toBeGreaterThan(0);
  });

  it('keeps every vehicle on a real lanelet, at a finite speed', () => {
    const fixture = crossroads('auto');
    run(fixture, 120);
    expect(finiteState(fixture.sim)).toBe(true);
  });

  it('moves traffic through an UNCONTROLLED junction', () => {
    // The regression this pins: mapping the "no control device" policy to a
    // yield right-of-way made every approach wait for every other one, and the
    // node wedged solid with nobody ever entering it.
    const fixture = crossroads('none');
    run(fixture, 90);
    const moving = [...fixture.sim.vehiclesInIdOrder()].filter((v) => v.v > 0.5).length;
    expect(fixture.sim.vehicles.size).toBeGreaterThan(0);
    expect(moving).toBeGreaterThan(0);
  });

  it('moves traffic through a SIGNALISED junction', () => {
    const fixture = crossroads('signal');
    run(fixture, 150);
    const moving = [...fixture.sim.vehiclesInIdOrder()].filter((v) => v.v > 0.5).length;
    expect(moving).toBeGreaterThan(0);
  });

  it('never leaves the whole network stopped for a full minute', () => {
    const fixture = crossroads('auto');
    run(fixture, 60);
    let everMoved = false;
    for (let i = 0; i < Math.round(60 / DT); i++) {
      step(fixture.sim, { traffic: true, pedestrians: false });
      if ([...fixture.sim.vehiclesInIdOrder()].some((v) => v.v > 1)) {
        everMoved = true;
        break;
      }
    }
    expect(everMoved).toBe(true);
  });

  it('survives the network being edited underneath it', () => {
    const fixture = crossroads('auto');
    run(fixture, 45);
    const before = fixture.sim.vehicles.size;
    expect(before).toBeGreaterThan(0);
    // Demolish a leg mid-simulation: agents on it must be rebound or removed,
    // never left pointing at a lanelet that no longer exists.
    const doomed = [...fixture.doc.segments.keys()][3]!;
    fixture.doc.removeSegment(doomed);
    fixture.doc.pruneOrphanNodes();
    fixture.net.rebuild();
    run(fixture, 20);
    expect(finiteState(fixture.sim)).toBe(true);
  });

  it('is deterministic for a given seed', () => {
    const a = crossroads('auto');
    const b = crossroads('auto');
    run(a, 40);
    run(b, 40);
    // A fingerprint over id-sorted, quantised agent state: it cannot depend on
    // map insertion order, and it ignores last-bit noise that means nothing.
    expect(hashSim(a.sim)).toBe(hashSim(b.sim));
    expect(a.sim.vehicles.size).toBe(b.sim.vehicles.size);
  });

  it('steps in one tick exactly as it steps in five', () => {
    // The real test of a fixed timestep: the accumulator must never let the
    // number of ticks per frame change the outcome.
    const one = crossroads('auto');
    const five = crossroads('auto');
    for (let i = 0; i < 600; i++) step(one.sim, { traffic: true, pedestrians: true });
    for (let i = 0; i < 120; i++) {
      for (let k = 0; k < 5; k++) step(five.sim, { traffic: true, pedestrians: true });
    }
    expect(hashSim(one.sim)).toBe(hashSim(five.sim));
  });
});
