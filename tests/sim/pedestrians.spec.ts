import { describe, expect, it } from 'vitest';

import { pointInPolygon } from '@core/polygon';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { Level } from '@world/roadTypes';
import { SimWorld } from '@sim/world';
import { step } from '@sim/pipeline';
import { DT, PED } from '@sim/params';
import { hashSim } from '@sim/snapshot';
import { pedPose } from '@sim/pose';
import { PED_BEHAVIOUR } from '@sim/peds/behaviour';
import type { Ped } from '@sim/peds/state';

/**
 * The crowd, exercised on a network the editor could have drawn.
 *
 * These are property tests, not example tests. What matters about a pedestrian
 * is not where they are after five thousand ticks — it is that they never walked
 * backwards, never stood in a carriageway, never slid sideways faster than a
 * person can step, and did not walk at exactly the same speed as everybody
 * else. Each of those is checked over every pedestrian of a whole run, because
 * the ones that matter are emergent: a party that stretches across a block, a
 * steering term that fights itself into a jitter, a destination nobody reaches.
 */

interface Fixture {
  readonly doc: RoadDoc;
  readonly net: Network;
  readonly sim: SimWorld;
}

/**
 * A four-leg cross with stubs at the map edge, so the crowd has somewhere to go.
 *
 * `reach` sets how long the legs are, which is really a choice about what the
 * run can observe: long legs hold a crowd on one footway, short ones put people
 * through junctions and over crossings often enough to watch them arrive
 * somewhere.
 */
function crossroads(control: 'auto' | 'none' | 'signal' = 'auto', reach = 400): Fixture {
  const doc = new RoadDoc();
  const centre = doc.addNode({ x: 0, y: 0 });
  const ends = [
    doc.addNode({ x: 0, y: -reach }),
    doc.addNode({ x: 0, y: reach }),
    doc.addNode({ x: -reach, y: 0 }),
    doc.addNode({ x: reach, y: 0 }),
  ];
  doc.addSegment(ends[0]!.id, centre.id, 3);
  doc.addSegment(centre.id, ends[1]!.id, 3);
  doc.addSegment(ends[2]!.id, centre.id, 1);
  doc.addSegment(centre.id, ends[3]!.id, 1);
  doc.setNodeControl(centre.id, control);
  const net = new Network(doc);
  net.rebuild();
  const sim = new SimWorld(doc, net, 0x5eed);
  sim.rebuildTopology();
  sim.trafficIntensity = 1.4;
  sim.pedestrianIntensity = 3;
  sim.demandMultiplier = 1.6;
  sim.clock.paused = false;
  return { doc, net, sim };
}

/** Runs the fixture, calling `watch` after every tick. */
function run(fixture: Fixture, seconds: number, watch?: (sim: SimWorld) => void): void {
  const steps = Math.round(seconds / DT);
  for (let i = 0; i < steps; i++) {
    step(fixture.sim, { traffic: true, pedestrians: true });
    watch?.(fixture.sim);
  }
}

const usableHalfWidth = (sim: SimWorld, p: Ped): number => {
  const edge = sim.sidewalks.edges.get(p.edge);
  if (!edge) return 0;
  return Math.max(0, edge.halfWidth - PED_BEHAVIOUR.lateralMargin);
};

/** Fingerprint over the state `hashSim` does not cover: pace and lateral place. */
function hashCrowd(sim: SimWorld): number {
  let h = 2166136261;
  const mix = (n: number): void => {
    h = Math.imul(h ^ (Math.round(n * 1000) | 0), 16777619) >>> 0;
  };
  for (const p of sim.pedsInIdOrder()) {
    mix(p.id);
    mix(p.lat);
    mix(p.v);
    mix(p.party.id);
    mix(p.party.pace);
    mix(p.rank);
    mix(p.trip);
    mix(p.trailing ?? -1);
  }
  return h >>> 0;
}

describe('pedestrians', () => {
  it('fills the footways and uses the crossings', () => {
    const fixture = crossroads();
    let everCrossed = false;
    run(fixture, 90, (sim) => {
      for (const p of sim.peds.values()) if (p.state === 'Crossing') everCrossed = true;
    });
    expect(fixture.sim.peds.size).toBeGreaterThan(10);
    expect(everCrossed).toBe(true);
  });

  it('is deterministic for a given seed, pace and lateral place included', () => {
    const a = crossroads();
    const b = crossroads();
    run(a, 45);
    run(b, 45);
    expect(hashSim(a.sim)).toBe(hashSim(b.sim));
    expect(hashCrowd(a.sim)).toBe(hashCrowd(b.sim));
    expect(a.sim.peds.size).toBe(b.sim.peds.size);
  });

  it('never walks anybody backwards along an edge', () => {
    const fixture = crossroads();
    // Keyed on the traversal, not on the edge: somebody who walks back down a
    // footway they have just left enters it from the other end, where `s` is
    // measured from the other end too and starts from zero again.
    const seen = new Map<number, { edge: string; entry: string; s: number }>();
    let worst = 0;
    run(fixture, 90, (sim) => {
      for (const p of sim.pedsInIdOrder()) {
        const last = seen.get(p.id);
        if (last && last.edge === p.edge && last.entry === p.entry) {
          worst = Math.min(worst, p.s - last.s);
        }
        seen.set(p.id, { edge: p.edge, entry: p.entry, s: p.s });
      }
    });
    // Monotone non-decreasing to the last bit. There is no anti-stall shove
    // here and nothing else may move `s` down either.
    expect(worst).toBe(0);
  });

  it('never puts anybody in a carriageway off a crossing', () => {
    const fixture = crossroads();
    const surfaces = [...fixture.doc.nodes.keys()]
      .map((node) => fixture.net.junctionAt(node, Level.Asphalt))
      .filter((junction) => !!junction)
      .flatMap((junction) => junction.rings.map((ring) => ring.flatten()));
    expect(surfaces.length).toBeGreaterThan(0);

    let intrusions = 0;
    let breaches = 0;
    run(fixture, 90, (sim) => {
      for (const p of sim.pedsInIdOrder()) {
        const edge = sim.sidewalks.edges.get(p.edge);
        if (!edge) continue;

        // Being anywhere along a zebra means being in the `Crossing` state.
        // Standing on the kerb node the zebra starts from does not.
        if (edge.kind === 'crossing' && p.state !== 'Crossing' && p.s > 1e-9) breaches++;

        // Footways only. A corner edge is the straight chord between two kerbs
        // around a junction island and may graze the asphalt the chord cuts
        // across; what must never happen is somebody walking a footway
        // standing in the road, which is what the steering clamp guarantees.
        if (edge.kind !== 'walk') continue;
        const pose = pedPose(sim, p, 1);
        if (pose && surfaces.some((poly) => pointInPolygon(pose.p, poly))) intrusions++;
      }
    });
    expect(breaches).toBe(0);
    expect(intrusions).toBe(0);
  });

  it('holds every lateral offset inside the footway, and steps rather than jumps', () => {
    const fixture = crossroads();
    const seen = new Map<number, { edge: string; lat: number }>();
    let worstOutside = -Infinity;
    let worstJump = 0;
    run(fixture, 90, (sim) => {
      for (const p of sim.pedsInIdOrder()) {
        worstOutside = Math.max(worstOutside, Math.abs(p.lat) - usableHalfWidth(sim, p));
        const last = seen.get(p.id);
        if (last && last.edge === p.edge) {
          worstJump = Math.max(worstJump, Math.abs(p.lat - last.lat));
        }
        seen.set(p.id, { edge: p.edge, lat: p.lat });
      }
    });
    expect(worstOutside).toBeLessThanOrEqual(1e-9);
    // One tick of the steering rate and not a fraction more: a bigger step is
    // a pedestrian teleporting sideways.
    expect(worstJump).toBeLessThanOrEqual(PED_BEHAVIOUR.lateralRate * DT + 1e-9);
    expect(worstJump).toBeGreaterThan(0);
  });

  it('spreads the crowd across the footway rather than along one line', () => {
    const fixture = crossroads();
    run(fixture, 90);
    const byEdge = new Map<string, number[]>();
    for (const p of fixture.sim.pedsInIdOrder()) {
      const list = byEdge.get(p.edge);
      if (list) list.push(p.lat);
      else byEdge.set(p.edge, [p.lat]);
    }
    const crowded = [...byEdge.values()].filter((list) => list.length >= 4);
    expect(crowded.length).toBeGreaterThan(0);
    for (const list of crowded) {
      // Everybody on one centreline is the defect this replaces; a metre of
      // spread across a footway several metres wide is a crowd.
      expect(Math.max(...list) - Math.min(...list)).toBeGreaterThan(PED.fileSpacing);
    }
  });

  it('spreads pace between people and within one person', () => {
    const fixture = crossroads();
    const walked = new Map<number, { min: number; max: number }>();
    run(fixture, 90, (sim) => {
      for (const p of sim.peds.values()) {
        if (p.state !== 'Walking' || p.v <= 0) continue;
        const seen = walked.get(p.id);
        if (!seen) walked.set(p.id, { min: p.v, max: p.v });
        else {
          seen.min = Math.min(seen.min, p.v);
          seen.max = Math.max(seen.max, p.v);
        }
      }
    });
    expect(walked.size).toBeGreaterThan(20);

    // Between people: the free speeds must not collapse onto one number.
    const free = [...fixture.sim.peds.values()].map((p) => p.speed);
    const mean = free.reduce((a, b) => a + b, 0) / free.length;
    const sd = Math.sqrt(free.reduce((a, b) => a + (b - mean) ** 2, 0) / free.length);
    expect(sd).toBeGreaterThan(PED.speedSd * 0.4);

    // Within one person: most of them vary their own pace over a minute and a
    // half rather than holding one number until something blocks them. This is
    // the part a per-pedestrian speed draw alone does not give.
    const varied = [...walked.values()].filter((r) => r.max - r.min > PED.meanSpeed * 0.05);
    expect(varied.length).toBeGreaterThan(walked.size * 0.6);
  });

  it('does not leave anybody frozen at a kerb', () => {
    const fixture = crossroads('signal');
    const seen = new Map<number, number>();
    let waiters = 0;
    let stirred = 0;
    run(fixture, 120, (sim) => {
      for (const p of sim.pedsInIdOrder()) {
        if (p.state !== 'WaitAtKerb') {
          seen.delete(p.id);
          continue;
        }
        const last = seen.get(p.id);
        if (last !== undefined) {
          waiters++;
          if (Math.abs(p.lat - last) > 0) stirred++;
        }
        seen.set(p.id, p.lat);
      }
    });
    expect(waiters).toBeGreaterThan(100);
    // The renderer freezes the gait at zero speed, which is right. What stops
    // that reading as a mannequin is that the figure is still shifting its
    // weight, so nearly every waiting tick must move somebody.
    expect(stirred).toBeGreaterThan(waiters * 0.9);
  });

  it('keeps a party together while it is one party', () => {
    const fixture = crossroads();
    // A lag is observed one tick before the pacing rule can see it, so the
    // sample is only fair if the link is still there on the next tick: that is
    // exactly the claim, that a party which has NOT broken up is short.
    const pending = new Map<number, { link: number; lag: number }>();
    let worst = 0;
    let samples = 0;
    run(fixture, 90, (sim) => {
      for (const p of sim.pedsInIdOrder()) {
        const held = pending.get(p.id);
        if (held && p.trailing === held.link) {
          worst = Math.max(worst, held.lag);
          samples++;
        }
        pending.delete(p.id);
        if (p.trailing === null) continue;
        const mate = sim.peds.get(p.trailing);
        if (!mate || mate.edge !== p.edge || mate.entry !== p.entry) continue;
        if (p.state !== 'Walking' || mate.state !== 'Walking') continue;
        pending.set(p.id, { link: p.trailing, lag: p.s - mate.s });
      }
    });
    expect(samples).toBeGreaterThan(1000);
    expect(worst).toBeGreaterThan(0);
    expect(worst).toBeLessThanOrEqual(PED_BEHAVIOUR.cohesionBreak);
  });

  it('spawns parties of more than one, paced to their slowest member', () => {
    const fixture = crossroads();
    run(fixture, 60);
    const parties = new Map<number, Ped[]>();
    for (const p of fixture.sim.pedsInIdOrder()) {
      const list = parties.get(p.party.id);
      if (list) list.push(p);
      else parties.set(p.party.id, [p]);
    }
    const groups = [...parties.values()].filter((list) => (list[0] as Ped).party.size > 1);
    expect(groups.length).toBeGreaterThan(0);

    for (const list of groups) {
      const party = (list[0] as Ped).party;
      for (const member of list) {
        // One party object, shared by reference, so no member can disagree
        // with another about the pace or about who the pacer is.
        expect(member.party).toBe(party);
        expect(party.pace).toBeLessThanOrEqual(member.speed + 1e-9);
      }
      // Distinct ranks are what keep a line abreast a line.
      expect(new Set(list.map((m) => m.rank)).size).toBe(list.length);
    }
  });

  it('gives everybody a destination rather than a coin toss', () => {
    const fixture = crossroads('auto', 220);
    const persisted = new Map<number, number>();
    run(fixture, 120, (sim) => {
      for (const p of sim.pedsInIdOrder()) {
        if (p.goal === null) continue;
        persisted.set(p.id, (persisted.get(p.id) ?? 0) + 1);
      }
    });
    const peds = fixture.sim.pedsInIdOrder();
    expect(peds.length).toBeGreaterThan(5);

    const goals = new Set<string>();
    for (const p of peds) {
      if (p.goal === null) continue;
      expect(fixture.sim.sidewalks.nodes.has(p.goal)).toBe(true);
      goals.add(p.goal);
    }
    // A destination is held for a long walk, not re-rolled at every corner...
    expect(Math.max(...persisted.values())).toBeGreaterThan(600);
    // ...it is not the same destination for the whole city...
    expect(goals.size).toBeGreaterThan(1);
    // ...and it is somewhere people arrive, rather than somewhere they orbit.
    expect(peds.some((p) => p.trip > 0)).toBe(true);
  });

  it('keeps every number finite through a live edit', () => {
    const fixture = crossroads();
    run(fixture, 45);
    expect(fixture.sim.peds.size).toBeGreaterThan(0);
    const doomed = [...fixture.doc.segments.keys()][3]!;
    fixture.doc.removeSegment(doomed);
    fixture.doc.pruneOrphanNodes();
    fixture.net.rebuild();
    run(fixture, 20);
    for (const p of fixture.sim.pedsInIdOrder()) {
      expect(Number.isFinite(p.s)).toBe(true);
      expect(Number.isFinite(p.v)).toBe(true);
      expect(Number.isFinite(p.lat)).toBe(true);
      expect(p.v).toBeGreaterThanOrEqual(0);
      expect(Math.abs(p.lat)).toBeLessThanOrEqual(usableHalfWidth(fixture.sim, p) + 1e-9);
    }
  });
});
