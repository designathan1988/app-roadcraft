import { DT, L_MIN, SIGNAL, STUCK_SECONDS } from './params';
import type { SimWorld } from './world';
import { type AuditIssue, issue } from './audit';
import { anyGreen, signalStateFor } from './signals/query';
import type { SignalController } from './signals/fsm';
import { COARSE_EPS } from '@core/scalar';
import { pedestrianAffectsSpan, reservationCoversCrossing } from './intersections/crossingSpans';

/**
 * Runtime invariant checks.
 *
 * `full` runs every tick in tests with `SIM_STRICT=1`; `cheap` runs
 * periodically in the app to feed a diagnostics readout. Several of these
 * detect conditions that should now be unrepresentable — they are kept as
 * sentinels precisely so that a regression announces itself instead of
 * degrading quietly.
 */
export function runAudit(w: SimWorld, level: 'cheap' | 'full'): AuditIssue[] {
  const out: AuditIssue[] = [];
  const tick = w.clock.tick;
  const signalDeps = w.signalDeps();

  // ---- signals ----------------------------------------------------------
  const maxDark = SIGNAL.amber + SIGNAL.minAllRed + 0.5;
  for (const c of w.controllers.values()) {
    if (c.degraded) {
      out.push(issue('degradedPlan', tick, c.node, 'plan failed validation'));
    }
    const currentStage = c.plan.stages[c.stageIndex];
    if (!anyGreen(c) && c.sub === 'GREEN' && !currentStage?.exclusivePed) {
      out.push(issue('planCoverageGap', tick, c.node, 'green stage serves no group'));
    }
    if (c.sub !== 'GREEN' && c.elapsed > maxDark) {
      out.push(
        issue('allRedTooLong', tick, c.node, `${c.sub} for ${c.elapsed.toFixed(1)}s`),
      );
    }
    // A busy stage is allowed to extend from its target to maxGreen. Measure
    // starvation against that legal worst-case cycle, not the nominal target
    // cycle, otherwise a healthy long platoon falsely starves later demand.
    const limit = SIGNAL.starvationCycles * maxSignalCycle(c) + maxDark;
    for (const g of c.plan.groups) {
      const last = c.lastServed.get(g);
      if (last === undefined) continue;
      const red = (tick - last) * DT;
      const demanded =
        signalDeps.demandOn(c.node, [g]) ||
        signalDeps.reservationDemandOn(c.node, [g]);
      if (demanded && red > limit && signalStateFor(c, g) === 'red') {
        out.push(issue('groupStarved', tick, `${c.node}/${g}`, `red for ${red.toFixed(1)}s`));
      }
    }
  }

  // ---- vehicles ---------------------------------------------------------
  for (const v of w.vehicles.values()) {
    const lane = w.lanelet(v.lanelet);
    if (!lane) {
      out.push(issue('routeless', tick, v.id, 'vehicle on a missing lanelet'));
      continue;
    }

    if (v.s < v.prev.s - COARSE_EPS && v.lanelet === v.prev.lanelet) {
      out.push(
        issue('nonMonotoneS', tick, v.id, `s went ${v.prev.s.toFixed(3)} -> ${v.s.toFixed(3)}`),
      );
    }

    if (v.route.length === 0) {
      out.push(issue('routeless', tick, v.id, 'empty route'));
    }

    // Standing still on a green with nothing in the way: the exact symptom the
    // rewrite exists to eliminate. The counter is integrated per tick by the
    // pipeline, not inferred from "time since it last moved" — that would flag
    // every vehicle at the instant a long red turns green.
    if (v.greenStall > 5) {
      out.push(issue('greenBlocked', tick, v.id, `${v.greenStall.toFixed(1)}s stalled on green`));
    }

    // `greenStall` above is the UNEXPLAINED stall: it resets whenever something
    // is in the way, so it fires only when a vehicle stands at a green with an
    // empty obstacle list. `greenDenied` is the complement — it counts seconds
    // held at a green for any reason at all, legitimate ones included.
    //
    // Each individual denial can be perfectly correct and the outcome still be
    // a failure: a driver who watches an entire signal cycle go by from the
    // stop line has not been served, whatever the internal predicate that
    // refused them. So the threshold is the junction's own worst-case cycle,
    // not a fixed number of seconds. Below it, waiting is traffic; above it,
    // the junction is not delivering the movement it advertises.
    //
    // This is why the threshold is derived and not tuned: measured on a 4x4
    // grid of four-lane avenues the longest legitimate wait is 14.3 s, all of
    // it turning traffic yielding to pedestrians on a permissive green, and the
    // cycle is far longer than that. Anything reaching a full cycle is real.
    if (lane.kind === 'link' && lane.controlled && lane.to !== undefined) {
      const controller = w.controller(lane.to);
      if (controller && v.greenDenied > maxSignalCycle(controller)) {
        out.push(
          issue(
            'greenBlocked',
            tick,
            v.id,
            `${v.greenDenied.toFixed(1)}s held at green, longer than the whole cycle`,
          ),
        );
      }
    }

    if (lane.kind === 'link' && lane.controlled && v.v < 0.1) {
      const stalled = w.clock.since(v.lastMovedTick);
      const wedgeLimit = 2 * maxCycle(w);

      // Being held out of a full lane is correct behaviour — it is what stops
      // the network gridlocking — and under heavy demand a queue can hold a
      // vehicle for cycles on end. That is congestion, not a wedge.
      //
      // The two are distinguished by whether the queue AHEAD is moving. If the
      // downstream lane is discharging, this vehicle's turn is coming. If it
      // has been frozen just as long, nothing is draining and that is a wedge.
      if (
        stalled > wedgeLimit &&
        v.constraints.obstacles.some((o) => o.kind === 'spillback')
      ) {
        if (junctionIsStuck(w, lane.to, wedgeLimit)) {
          out.push(
            issue('spillbackWedge', tick, v.id, `held ${stalled.toFixed(0)}s at a stalled junction`),
          );
        }
      }

      // Cross-node compact reservations can keep one access blocked while the
      // same junction continues serving other directions. Track this request,
      // not aggregate node throughput, or directional starvation is invisible.
      const requestWait =
        v.firstRequestTick === null ? 0 : w.clock.since(v.firstRequestTick);
      const ownsCompoundAllocation =
        v.reservedConnectors.length > 0 &&
        (v.admittedConnector !== null ||
          v.clearingConnectors.length > 0);
      // `firstRequestTick` deliberately spans the complete compact-box
      // transaction so admission can preserve FIFO priority between nodes.
      // It therefore cannot, by itself, mean that the current access has been
      // motionless for that whole time. Combine it with actual lack of motion,
      // and only diagnose vehicles that already hold physical box resources;
      // an ordinary saturated approach is queueing, not a cross-node wedge.
      const currentAccessWait = Math.min(
        requestWait,
        w.clock.since(v.lastMovedTick),
      );
      if (
        ownsCompoundAllocation &&
        currentAccessWait > wedgeLimit &&
        v.constraints.obstacles.some(
          (o) => o.kind === 'yield' || o.kind === 'conflict' || o.kind === 'pedestrian',
        )
      ) {
        out.push(
          issue(
            'greenBlocked',
            tick,
            v.id,
            `access arbitration unresolved ${currentAccessWait.toFixed(0)}s`,
          ),
        );
      }
    }
  }

  if (level === 'cheap') return out;

  // ---- full checks ------------------------------------------------------

  // Overlap: bumper-to-bumper gaps must never go negative.
  for (const rt of w.runtime.values()) {
    for (let i = 0; i + 1 < rt.order.length; i++) {
      const aId = rt.order[i];
      const bId = rt.order[i + 1];
      const a = aId === undefined ? undefined : w.veh(aId);
      const b = bId === undefined ? undefined : w.veh(bId);
      if (!a || !b) continue;
      const gap = b.s - b.archetype.length - a.s;
      if (gap < -0.01) {
        out.push(issue('overlap', tick, `${a.id}/${b.id}`, `gap ${gap.toFixed(3)}`));
      }
    }
  }

  // Claims must belong to a live vehicle. A short block can make one vehicle
  // hold points from both its admitted and rear-clearing connectors.
  for (const v of w.vehicles.values()) {
    for (const p of v.claims) {
      if (!w.claims.holds(v.id, p)) {
        out.push(issue('orphanClaim', tick, v.id, `point ${p}`));
      }
    }
    if (v.admittedConnector && w.clock.since(v.lastMovedTick) > STUCK_SECONDS) {
      out.push(issue('staleClaim', tick, v.id, 'holder immobile'));
    }
  }

  // Link lanelets should be able to hold the largest vehicle.
  for (const lane of w.graph.lanelets.values()) {
    if (lane.kind !== 'link') continue;
    if (lane.length <= 0) {
      out.push(issue('degenerateGeometry', tick, lane.id, 'zero length'));
    } else if (lane.length < L_MIN) {
      out.push(issue('shortLink', tick, lane.id, `length ${lane.length.toFixed(1)} < ${L_MIN.toFixed(1)}`));
    }
  }

  // ---- pedestrians ------------------------------------------------------
  for (const p of w.peds.values()) {
    const edge = w.sidewalks.edges.get(p.edge);
    if (!edge) continue;

    if (p.state === 'Crossing' && w.clock.since(p.lastMovedTick) > 3) {
      out.push(issue('pedInRoadStalled', tick, p.id, 'no progress while crossing'));
    }

    if (p.state === 'WaitAtKerb' && p.waited > 2 * maxCycle(w)) {
      out.push(issue('pedFrozen', tick, p.id, `waited ${p.waited.toFixed(1)}s`));
    }

    // A pedestrian may only be inside a junction while on a crossing edge.
    if (edge.kind !== 'crossing' && p.state === 'Crossing') {
      out.push(issue('pedOutsideSidewalk', tick, p.id, 'crossing state off a crossing edge'));
    }

    if (p.occupying) {
      const split = p.occupying.indexOf(':');
      const node = Number(p.occupying.slice(0, split));
      const segment = Number(p.occupying.slice(split + 1));
      for (const v of w.vehicles.values()) {
        const lane = w.lanelet(v.lanelet);
        const connectorIds = new Set(v.clearingConnectors.map((token) => token.connector));
        if (v.admittedConnector) connectorIds.add(v.admittedConnector);
        if (lane?.kind === 'connector') connectorIds.add(lane.id);
        for (const connectorId of connectorIds) {
          const connector = w.connector(connectorId);
          if (connector?.node === node) {
            const span = w.crossingSpans.span(connector.id, p.occupying);
            if (span === null || (span && !pedestrianAffectsSpan(p, edge, span))) continue;
            if (!reservationCoversCrossing(w, v, connector, segment, span)) continue;
            out.push(
              issue(
                'pedSignalContradiction',
                tick,
                `${p.id}/${v.id}`,
                `crossing ${p.occupying} overlaps reserved connector ${connector.id}`,
              ),
            );
          }
        }
      }
    }
  }

  return out;
}

/** True when a junction has admitted nobody for longer than `limit` seconds. */
function junctionIsStuck(w: SimWorld, node: number | undefined, limit: number): boolean {
  if (node === undefined) return false;
  const last = w.lastAdmission.get(node as never);
  if (last === undefined) return w.clock.time > limit;
  return w.clock.since(last) > limit;
}

function maxCycle(w: SimWorld): number {
  let max = 30;
  for (const c of w.controllers.values()) max = Math.max(max, c.plan.cycle);
  return Math.min(max, 200);
}

function maxSignalCycle(c: SignalController): number {
  return c.plan.stages.reduce(
    (total, stage) => total + stage.maxGreen + stage.amber + stage.allRed,
    0,
  );
}
