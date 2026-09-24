import { describe, expect, it } from 'vitest';
import { step } from '@sim/pipeline';
import { DT } from '@sim/params';
import { m } from '@world/units';
import { streetFurniture } from '@world/streetFurniture';
import { PED_BEHAVIOUR } from '@sim/peds/behaviour';
import type { SimWorld } from '@sim/world';
import { fixtureDoc, simOf } from './support/bodies';

/**
 * How people move and what they do, measured on the saved player map.
 *
 * Before these existed, on the same map and seed:
 *   - the body reversed its direction of turn 5.9 times a minute of walking,
 *     every sidestep swinging it towards the side and back: the zigzag;
 *   - people standing still turned through 105 degrees a minute on the spot,
 *     a sideways shuffle of millimetres read as a direction to face;
 *   - nobody ever sat on a bench, stopped to look, or stood talking.
 */
const wrap = (a: number): number => Math.atan2(Math.sin(a), Math.cos(a));

interface Run {
  sim: SimWorld;
  walkSeconds: number;
  pedSeconds: number;
  turnFlips: number;
  standingTurn: number;
  fastestSidestep: number;
  kinds: Map<string, number>;
  phases: Map<number, string[]>;
  sharedSeat: boolean;
  seatedAway: number;
  nearestLamp: number;
  stopsInFlow: number;
  holds: number;
}

function measure(seconds: number): Run {
  const sim = simOf(fixtureDoc(), 0x51de, 1);
  const run: Run = { sim, walkSeconds: 0, pedSeconds: 0, turnFlips: 0, standingTurn: 0, fastestSidestep: 0,
    kinds: new Map(), phases: new Map(), sharedSeat: false, seatedAway: 0, nearestLamp: Infinity, stopsInFlow: 0, holds: 0 };
  const seats = streetFurniture(sim.net).filter((i) => i.kind === 'bench');
  const lamps = streetFurniture(sim.net).filter((i) => i.kind === 'lamp');
  const last = new Map<number, { heading: number; rate: number; activity: unknown }>();
  sim.clock.run(Math.round(seconds / DT), () => {
    step(sim, { traffic: true, pedestrians: true });
    const taken = new Map<string, number>();
    for (const p of sim.peds.values()) {
      const prev = last.get(p.id);
      const rate = prev ? wrap(p.heading - prev.heading) / DT : 0;
      run.pedSeconds += DT;
      if (prev) {
        if (p.state === 'Walking' && p.v > 0.5 && !p.activity) {
          run.walkSeconds += DT;
          if (Math.abs(rate) > 0.3 && Math.abs(prev.rate) > 0.3 && Math.sign(rate) !== Math.sign(prev.rate)) run.turnFlips++;
          run.fastestSidestep = Math.max(run.fastestSidestep, Math.abs(p.latV));
        }
        if (p.v < 0.25 && !p.activity && p.state === 'Walking') run.standingTurn += Math.abs(rate) * DT;
      }
      const a = p.activity;
      if (a && prev?.activity !== a) run.kinds.set(a.kind, (run.kinds.get(a.kind) ?? 0) + 1);
      if (a?.kind === 'bench') {
        const seen = run.phases.get(p.id) ?? [];
        if (seen[seen.length - 1] !== a.phase || prev?.activity !== a) seen.push(a.phase);
        run.phases.set(p.id, seen);
        // Stepping between the footway and the seat passes the lamp column
        // that stands behind every bench: never through it.
        for (const lamp of lamps) run.nearestLamp = Math.min(run.nearestLamp, Math.hypot(lamp.x - p.x, lamp.y - p.y));
        if (a.seat) {
          if (taken.has(a.seat)) run.sharedSeat = true;
          taken.set(a.seat, p.id);
        }
        if (a.phase === 'seated') {
          // The body stands in front of the seat and the clip lowers it back
          // onto it: that spot is always within a stride of a bench.
          const nearest = Math.min(...seats.map((b) => Math.hypot(b.x - p.x, b.y - p.y)));
          run.seatedAway = Math.max(run.seatedAway, nearest);
        }
      }
      if (a && (a.kind === 'look' || a.kind === 'phone') && a.phase === 'hold' && a.side !== 0) {
        run.holds++;
        const edge = sim.sidewalks.edges.get(p.edge)!;
        const usable = edge.halfWidth - PED_BEHAVIOUR.lateralMargin;
        // Out of the way: on its chosen side of the footway, not in the middle.
        if (p.lat * a.side < usable * 0.4) run.stopsInFlow++;
      }
      last.set(p.id, { heading: p.heading, rate, activity: a });
    }
  });
  return run;
}

describe('pedestrian movement and activities', () => {
  const run = measure(240);

  it('walks without zigzagging: the body does not swing with every sidestep', () => {
    expect(run.walkSeconds).toBeGreaterThan(600);
    expect(run.turnFlips / (run.walkSeconds / 60)).toBeLessThan(0.5);
    // A step aside is a step, not a lunge at walking pace.
    expect(run.fastestSidestep).toBeLessThanOrEqual(PED_BEHAVIOUR.lateralRate + 1e-6);
  });

  it('does not spin on the spot while simply standing', () => {
    expect(run.standingTurn * (180 / Math.PI) / (run.pedSeconds / 60)).toBeLessThan(30);
  });

  it('sits on benches, one person to a seat, going through every step in order', () => {
    expect(run.kinds.get('bench') ?? 0).toBeGreaterThan(0);
    expect(run.sharedSeat).toBe(false);
    const order = ['approach', 'step', 'turn', 'sitDown', 'seated', 'standUp', 'leave'];
    let completed = 0;
    for (const phases of run.phases.values()) {
      // One person may sit on several benches in a run; each visit starts
      // with an approach, and whatever part of a visit the run saw, it saw in
      // order.
      const visits: string[][] = [];
      for (const phase of phases) {
        if (phase === 'approach' || !visits.length) visits.push([]);
        visits[visits.length - 1]!.push(phase);
      }
      for (const visit of visits) {
        const at = visit.map((ph) => order.indexOf(ph));
        for (let i = 1; i < at.length; i++) expect(at[i]).toBeGreaterThan(at[i - 1]!);
        if (visit.includes('seated') && visit.includes('leave')) completed++;
      }
    }
    expect(completed).toBeGreaterThan(0);
    expect(run.seatedAway).toBeLessThan(m(1.2));
    expect(run.nearestLamp).toBeGreaterThanOrEqual(m(0.43));
  });

  it('stops at the side of the footway, out of the way, and talks in parties', () => {
    expect((run.kinds.get('look') ?? 0) + (run.kinds.get('phone') ?? 0)).toBeGreaterThan(0);
    expect(run.kinds.get('talk') ?? 0).toBeGreaterThan(0);
    expect(run.holds).toBeGreaterThan(0);
    expect(run.stopsInFlow).toBe(0);
  });
});
