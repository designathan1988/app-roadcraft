import { describe, expect, it } from 'vitest';

import { step } from '@sim/pipeline';
import { DT } from '@sim/params';
import { signalStateFor } from '@sim/signals/query';
import { METERS_PER_UNIT } from '@world/units';
import type { SimWorld } from '@sim/world';
import { bodyOf, collisions, layoutDoc, simOf, type Layout } from './support/bodies';

/**
 * A CROSSROADS OF FOUR STREETS, RUN AS A PLAYER SEES IT.
 *
 * Reported: two opposing lights green together, a car turning left across the
 * stream the other light had released, and that stream not stopping for it.
 * The plan put both movements on green; whether the gap logic then held was
 * luck. Signal stages are now built from the conflict matrix, and this file
 * checks the result the way it is seen: vehicles going straight on and
 * turning at the same time, queues at red, people on the crossings, and how
 * fast a free car actually takes a corner.
 */

const LAYOUTS: readonly Layout[] = [
  { name: 'avenues', bearings: [0, 90, 180, 270], types: [3, 3, 3, 3] },
  { name: 'streets', bearings: [0, 90, 180, 270], types: [2, 2, 2, 2] },
  { name: 'locals', bearings: [0, 90, 180, 270], types: [1, 1, 1, 1] },
  { name: 'avenue-by-street', bearings: [0, 90, 180, 270], types: [3, 2, 3, 2] },
];

const SECONDS = 240;
const kmh = (u: number): number => u * METERS_PER_UNIT * 3.6;

interface RunReport {
  overlaps: number;
  /** Connector entries while the movement's own light was red. */
  redEntries: number;
  /** Vehicles on crossing movements from different approaches, both inside their shared zone. */
  zoneViolations: number;
  /** Ticks with a through and a turn from the same approach both in the box. */
  throughWithTurn: number;
  /** Movement kinds that entered the box, per approach segment. */
  served: Map<number, Set<string>>;
  /** Longest queue measured at any stop line, vehicles. */
  longestQueue: number;
  /** Unadmitted fronts found past their own stop line at red. */
  pastLineAtRed: number;
  /** A vehicle body over a person on a crossing. */
  pedestrianHits: number;
}

function inZone(sim: SimWorld, id: number, connector: string, point: number): boolean {
  const v = sim.veh(id);
  const p = sim.conflicts.points[point];
  if (!v || !p) return false;
  const cls = v.archetype.length > 15 ? 2 : v.archetype.length > 6 ? 1 : 0;
  const z = p.zone(connector, cls as 0 | 1 | 2, 1);
  if (!z) return false;
  const centre = v.lanelet === connector ? v.s - v.archetype.length / 2 : Number.NaN;
  return centre >= z.enter && centre <= z.exit;
}

function run(layout: Layout, seconds = SECONDS): RunReport {
  const { doc } = layoutDoc(layout);
  const sim = simOf(doc, 0x4a11, 2);
  const report: RunReport = {
    overlaps: 0, redEntries: 0, zoneViolations: 0, throughWithTurn: 0,
    served: new Map(), longestQueue: 0, pastLineAtRed: 0, pedestrianHits: 0,
  };
  const where = new Map<number, string>();
  for (let i = 0; i < Math.round(seconds / DT); i++) {
    step(sim, { traffic: true, pedestrians: true });
    report.overlaps += collisions(sim).length;

    const inBox = [...sim.vehicles.values()].filter((v) => sim.lanelet(v.lanelet)?.kind === 'connector');
    for (const v of inBox) {
      const c = sim.connector(v.lanelet)!;
      if (where.get(v.id) !== v.lanelet) {
        // Just entered: the light must not have been red for it.
        const ctl = sim.controller(c.node)!;
        if (signalStateFor(ctl, c.group) === 'red' && v.s < 1.5) report.redEntries++;
        let kinds = report.served.get(c.inSegment);
        if (!kinds) report.served.set(c.inSegment, (kinds = new Set()));
        kinds.add(c.turn);
      }
    }
    for (const v of sim.vehicles.values()) where.set(v.id, v.lanelet);

    // Two bodies from different approaches inside the same conflict zone.
    for (const a of inBox) {
      for (const b of inBox) {
        if (a.id >= b.id) continue;
        const ca = sim.connector(a.lanelet)!;
        const cb = sim.connector(b.lanelet)!;
        if (ca.inSegment === cb.inSegment) continue;
        for (const ref of sim.conflicts.refs(ca.id)) {
          if (ref.other !== cb.id) continue;
          if (inZone(sim, a.id, ca.id, ref.point) && inZone(sim, b.id, cb.id, ref.point)) report.zoneViolations++;
        }
      }
    }

    // Straight on and turning from one approach at the same time.
    const bySegment = new Map<number, Set<string>>();
    for (const v of inBox) {
      const c = sim.connector(v.lanelet)!;
      let kinds = bySegment.get(c.inSegment);
      if (!kinds) bySegment.set(c.inSegment, (kinds = new Set()));
      kinds.add(c.turn);
    }
    for (const kinds of bySegment.values()) {
      if (kinds.has('through') && (kinds.has('left') || kinds.has('right'))) report.throughWithTurn++;
    }

    // Queues at the line, and nobody unadmitted past it at red.
    const junction = [...sim.graph.junctions.values()][0]!;
    for (const laneId of junction.inbound) {
      const lane = sim.lanelet(laneId)!;
      const order = sim.rt(laneId).order;
      let queued = 0;
      for (const id of order) {
        const v = sim.veh(id);
        if (v && v.v < 0.5 && lane.length - v.s < 80) queued++;
      }
      report.longestQueue = Math.max(report.longestQueue, queued);
      const head = sim.laneHead(laneId);
      const next = head?.route[1] ? sim.connector(head.route[1]) : undefined;
      if (head && next && !head.admittedConnector &&
          signalStateFor(sim.controller(next.node)!, next.group) === 'red' && head.s > lane.length + 1e-6) {
        report.pastLineAtRed++;
      }
    }

    // A vehicle body over somebody walking on a crossing.
    for (const p of sim.peds.values()) {
      if (sim.sidewalks.edges.get(p.edge)?.kind !== 'crossing') continue;
      for (const v of inBox) {
        const body = bodyOf(sim, v);
        if (!body) continue;
        const dx = p.x - body.c.x;
        const dy = p.y - body.c.y;
        const along = Math.abs(dx * body.u.x + dy * body.u.y);
        const across = Math.abs(-dx * body.u.y + dy * body.u.x);
        if (along < body.halfLength && across < body.halfWidth) report.pedestrianHits++;
      }
    }
  }
  return report;
}

describe('four-way signalised crossroads', () => {
  for (const layout of LAYOUTS) {
    it(`${layout.name}: straight on and turning together, safely`, () => {
      const r = run(layout);
      expect(r.overlaps, 'vehicle bodies overlapping').toBe(0);
      expect(r.redEntries, 'entries on red').toBe(0);
      expect(r.zoneViolations, 'two approaches inside one conflict zone').toBe(0);
      expect(r.pastLineAtRed, 'unadmitted front past its stop line at red').toBe(0);
      expect(r.pedestrianHits, 'vehicle body over a person on a crossing').toBe(0);
      // Through and turning traffic from the same approach share the green.
      expect(r.throughWithTurn).toBeGreaterThan(0);
      // Every approach gets through AND turns served.
      expect(r.served.size).toBe(4);
      for (const kinds of r.served.values()) {
        expect(kinds.has('through')).toBe(true);
        expect(kinds.has('left') || kinds.has('right')).toBe(true);
      }
      // Queues form at red and are discharged, never growing without bound.
      expect(r.longestQueue).toBeGreaterThan(0);
      expect(r.longestQueue).toBeLessThan(20);
    }, 120_000);
  }

  it('never shows green to two movements whose cars could meet', () => {
    for (const layout of LAYOUTS) {
      const { doc, centre } = layoutDoc(layout);
      const sim = simOf(doc, 1, 0);
      const plan = sim.controller(centre)!.plan;
      const connectors = [...sim.graph.connectors.values()].filter((c) => c.node === centre);
      for (const stage of plan.stages) {
        const green = connectors.filter((c) => stage.greenGroups.includes(c.group));
        for (const a of green) {
          for (const b of green) {
            if (a.inSegment === b.inSegment || a.id >= b.id) continue;
            const meet = sim.conflicts.refs(a.id).filter((ref) => ref.other === b.id)
              .some((ref) => sim.conflicts.points[ref.point]?.zone(a.id, 1, 1));
            expect(meet, `${layout.name}: ${a.turn} ${a.id} with ${b.turn} ${b.id}`).toBe(false);
          }
        }
      }
    }
  });
});

describe('turning speed', () => {
  /**
   * A free car - nothing ahead, a green light - takes a corner at a speed set
   * by its radius and a comfortable sideways pull, not at a crawl. Measured
   * before the rounder turn paths and the speed-dependent comfort figure:
   * 12 km/h round a right turn and 14 km/h round a left on these avenues.
   */
  it('takes a free corner at a realistic speed and never stops in it', () => {
    const { doc } = layoutDoc({ name: 'avenues', bearings: [0, 90, 180, 270], types: [3, 3, 3, 3] });
    const sim = simOf(doc, 0x7e57, 1);
    // A trace starts on the approach and ends on the exit. It is free when the
    // car arrived at speed - not discharging from a queue - and nothing but
    // the bend itself slowed it: no vehicle, light or crossing ahead of it.
    const traces = new Map<number, { turn: string; min: number; free: boolean; inBox: boolean }>();
    const done: { turn: string; min: number }[] = [];
    for (let i = 0; i < Math.round(1500 / DT); i++) {
      step(sim, { traffic: true, pedestrians: false });
      for (const v of sim.vehicles.values()) {
        const lane = sim.lanelet(v.lanelet);
        if (!lane) continue;
        let t = traces.get(v.id);
        if (lane.kind === 'link' && !t) {
          const next = v.route[1] ? sim.connector(v.route[1]) : undefined;
          if (!next || next.turn === 'through' || lane.length - v.s > 60) continue;
          t = { turn: next.turn, min: Infinity, free: kmh(v.v) > 35, inBox: false };
          traces.set(v.id, t);
        }
        if (!t) continue;
        if (lane.kind === 'connector') t.inBox = true;
        else if (t.inBox) {
          if (t.free) done.push({ turn: t.turn, min: t.min });
          traces.delete(v.id);
          continue;
        }
        t.min = Math.min(t.min, v.v);
        if (v.constraints.obstacles.some((o) => o.gap < 40)) t.free = false;
        if (['bus', 'truck', 'bicycle'].includes(v.archetype.id)) t.free = false;
      }
    }
    const lefts = done.filter((d) => d.turn === 'left').map((d) => kmh(d.min));
    const rights = done.filter((d) => d.turn === 'right').map((d) => kmh(d.min));
    expect(lefts.length).toBeGreaterThanOrEqual(2);
    expect(rights.length).toBeGreaterThan(2);
    const median = (xs: number[]) => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
    expect(median(rights)).toBeGreaterThan(17);
    expect(median(lefts)).toBeGreaterThan(22);
    // Nor so fast a real driver would not: 35 and 45 km/h are the limits.
    expect(Math.max(...rights)).toBeLessThan(35);
    expect(Math.max(...lefts)).toBeLessThan(45);
    expect(Math.min(...rights, ...lefts)).toBeGreaterThan(8);
  }, 120_000);
});
