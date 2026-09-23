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

  /**
   * The test above asserts that SOME vehicle SOMEWHERE is moving, which is
   * satisfied by a junction with three of its four legs wedged solid. It
   * passed throughout the period when a freshly built signalised crossroads
   * froze in stage 0 for up to a minute and when cars sat at their own green
   * for over ninety seconds. The tests below measure the thing the player
   * actually sees: does MY approach get served, and how long do I wait.
   *
   * Two things are required to make them mean anything:
   *
   *   - the clock has to be DRIVEN (`clock.run`), because `clock.tick` and
   *     `clock.time` advance nowhere else, and every wedge detector, the FIFO
   *     fairness order and the signal starvation promotion are all keyed on
   *     them. Calling `step` directly leaves them frozen at zero and the
   *     whole diagnostic layer becomes unreachable;
   *   - the audit has to be ENABLED, because `runAudit` is gated on
   *     `auditEnabled` and nothing but `main.ts` ever set it. No test in this
   *     repository had ever run it.
   */
  describe('a signalised junction serves every approach', () => {
    const drive = (fixture: Fixture, seconds: number): void => {
      fixture.sim.clock.run(Math.round(seconds / DT), () =>
        step(fixture.sim, { traffic: true, pedestrians: true }),
      );
    };

    it('admits traffic from every leg, not just one', () => {
      const fixture = crossroads('signal');
      fixture.sim.auditEnabled = true;

      // Which inbound link each admission came from, counted over the run.
      const servedBySegment = new Map<number, number>();
      const seen = new Set<number>();

      fixture.sim.clock.run(Math.round(240 / DT), () => {
        step(fixture.sim, { traffic: true, pedestrians: true });
        for (const v of fixture.sim.vehicles.values()) {
          if (!v.admittedConnector || seen.has(v.id)) continue;
          const conn = fixture.sim.connector(v.admittedConnector);
          if (!conn) continue;
          seen.add(v.id);
          servedBySegment.set(conn.inSegment, (servedBySegment.get(conn.inSegment) ?? 0) + 1);
        }
      });

      // All four legs of the cross must have been admitted at least once.
      expect(servedBySegment.size).toBe(4);
      for (const [segment, count] of servedBySegment) {
        expect(count, `segment ${segment} was served ${count} times`).toBeGreaterThan(0);
      }
    });

    it('does not leave a vehicle sitting at its own green', () => {
      // `greenDenied` counts seconds spent at a green whose refusal was not
      // one of the by-design ones. It must stay well inside a single cycle;
      // the measured failure was 96 to 145 seconds.
      const fixture = crossroads('signal');
      fixture.sim.auditEnabled = true;
      drive(fixture, 240);

      let worst = 0;
      for (const v of fixture.sim.vehicles.values()) {
        worst = Math.max(worst, v.greenDenied);
      }

      const cycle = Math.max(
        ...[...fixture.sim.controllers.values()].map((c) => c.plan.cycle),
      );
      expect(worst).toBeLessThan(cycle);
    });

    it('runs its state machine from the first second, never freezing', () => {
      // The coordination offset used to be implemented by HOLDING the machine
      // still for the length of the offset: `stepController` returned early
      // while counting it down, so `elapsed` stayed at zero and every
      // approach but the first sat on a hard red for up to sixty seconds. An
      // offset is supposed to shift the PHASE, which is what it does now.
      const fixture = crossroads('signal');

      // `elapsed` restarts at every sub-phase boundary, so the instantaneous
      // value proves nothing. What the freeze did was pin it at exactly zero
      // for the whole offset, and never reach a boundary at all.
      let peakElapsed = 0;
      const phasesSeen = new Set<string>();
      fixture.sim.clock.run(Math.round(12 / DT), () => {
        step(fixture.sim, { traffic: true, pedestrians: true });
        for (const c of fixture.sim.controllers.values()) {
          peakElapsed = Math.max(peakElapsed, c.elapsed);
          phasesSeen.add(`${c.stageIndex}:${c.sub}`);
        }
      });

      expect(peakElapsed).toBeGreaterThan(1);
      expect(phasesSeen.size).toBeGreaterThan(0);
    });

    it('visits every stage of its plan within two cycles', () => {
      // Exclusive turn stages exist only to serve turns that are permissive
      // everywhere else, and run when those turns are queued. Every other
      // stage is served unconditionally; a gated one must run whenever its
      // turns have been waiting.
      const fixture = crossroads('signal');
      const seenStages = new Set<number>();
      let longestTurnWait = 0;

      fixture.sim.clock.run(Math.round(200 / DT), () => {
        step(fixture.sim, { traffic: true, pedestrians: true });
        for (const c of fixture.sim.controllers.values()) {
          seenStages.add(c.stageIndex);
          const gated = new Set(c.plan.stages.flatMap((s) => s.demandMovements ?? []));
          for (const lane of fixture.sim.graph.junctions.get(c.node)?.inbound ?? []) {
            const head = fixture.sim.laneHead(lane);
            if (head && gated.has(head.route[1] ?? '')) longestTurnWait = Math.max(longestTurnWait, head.waited);
          }
        }
      });

      const controller = [...fixture.sim.controllers.values()][0];
      const stages = controller?.plan.stages ?? [];
      expect(stages.length).toBeGreaterThan(0);
      stages.forEach((s, i) => {
        if (!s.demandMovements) expect(seenStages.has(i), `stage ${i}`).toBe(true);
      });
      // A turn only an exclusive stage protects never waits beyond the
      // starvation bound (1.5 cycles of the longest legal plan).
      const bound = 1.5 * stages.reduce((t, s) => t + s.maxGreen + s.amber + s.allRed, 0);
      expect(longestTurnWait).toBeLessThan(bound);
    });

    it('pairs opposing approaches instead of giving each its own stage', () => {
      // A four-leg cross has four approach groups. Serving them one at a time
      // is a 97.6 s cycle in which each leg is green for a fifth of the time.
      // Opposing approaches share a stage, as a real crossroads does, which
      // halves the cycle and doubles each approach's share of it.
      const fixture = crossroads('signal');
      const controller = [...fixture.sim.controllers.values()][0];
      expect(controller).toBeDefined();

      const vehicleStages = (controller?.plan.stages ?? []).filter(
        (s) => !s.exclusivePed && s.greenGroups.length > 0 && !s.demandMovements,
      );
      expect(controller?.plan.groups.length).toBe(4);
      expect(vehicleStages.length).toBe(2);
      for (const s of vehicleStages) expect(s.greenGroups.length).toBe(2);
      // Exclusive turn stages: one approach each, gated on its own turns.
      for (const s of controller?.plan.stages ?? []) {
        if (!s.demandMovements) continue;
        expect(s.greenGroups.length).toBe(1);
        expect(s.demandMovements.length).toBeGreaterThan(0);
      }
    });

    it('reports no wedge from the audit it now actually runs', () => {
      const fixture = crossroads('signal');
      fixture.sim.auditEnabled = true;
      drive(fixture, 240);

      const blocking = [...fixture.sim.issues].filter(
        (issue) =>
          issue.code === 'greenBlocked' ||
          issue.code === 'staleClaim' ||
          issue.code === 'groupStarved' ||
          issue.code === 'spillbackWedge',
      );
      expect(blocking.map((i) => `${i.code}`)).toEqual([]);
    });
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
