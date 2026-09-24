import type { NodeId } from '@world/ids';
import type { Connector, JunctionTopology } from '@world/lanelets';
import { DT, SIGNAL } from '../params';
import { EPS } from '@core/scalar';
import {
  type CrossingId,
  type GroupId,
  type SignalPlan,
  PlanValidationError,
  buildSignalPlan,
  roundRobinPlan,
} from './plan';

export type SubPhase = 'GREEN' | 'AMBER' | 'ALL_RED';

/**
 * Per-junction signal state.
 *
 * Phase is an OWNED integer plus an owned timer, advanced by `dt` in exactly
 * one place. It is emphatically not `(simTime + offset) % cycle` evaluated
 * against a lazily rebuilt plan, which is what the V6 monolith did — and which
 * meant any change to the plan teleported every light at the node, and a getter
 * called from the renderer could rewrite `cycle` and `phaseOffset` halfway
 * through evaluating a single expression (defects 3.3 and 3.4).
 */
export interface SignalController {
  readonly node: NodeId;
  plan: SignalPlan;
  stageIndex: number;
  sub: SubPhase;
  /** Seconds spent in the current sub-phase. */
  elapsed: number;
  /** Tick at which each group last received green. */
  lastServed: Map<GroupId, number>;
  /**
   * Tick at which each stage last ended its green. A demand-gated exclusive
   * stage shares its group with a paired stage, so the group's service time
   * says nothing about how long the stage's own turns have waited.
   */
  stageServed: Map<number, number>;
  /**
   * Coordination offset ALREADY APPLIED, in seconds. Diagnostics only.
   *
   * This used to be a countdown that `stepController` decremented while
   * returning early, which did not shift the phase at all — it FROZE the
   * junction. With a four-leg cycle of ~98 s and a seed of `node * 7.317 % 60`
   * the modulo never bit, so a freshly drawn signalised crossroads sat in
   * stage 0 with three legs on a hard red for up to a full minute. That is the
   * "the light is green and nothing moves" report, and it recurred every time
   * the player drew another junction.
   *
   * The offset is now applied by SEEKING the plan to that point in its cycle,
   * which is what a coordination offset means.
   */
  readonly offsetApplied: number;
  /** Set when a plan failed validation and a fallback was substituted. */
  degraded: boolean;
}

export interface SignalDeps {
  readonly tick: () => number;
  readonly connectorsOf: (id: string) => Connector | undefined;
  /** Movements that physically conflict with a connector (swept zones). */
  readonly conflictsOf?: (id: string) => readonly string[];
  /** Pedestrians still inside a crossing that this stage released. */
  readonly pedestriansCrossing: (node: NodeId, crossings: readonly CrossingId[]) => boolean;
  /** Whether any vehicle is waiting on the given groups (and movements). */
  readonly demandOn: (node: NodeId, groups: readonly GroupId[], movements?: readonly string[]) => boolean;
  /** Weighted demand; see `SimWorld.signalDemand`. */
  readonly demand?: (node: NodeId, groups: readonly GroupId[], movements?: readonly string[]) => { active: number; score: number };
  /** Longest time anybody has waited at a kerb for one of these crossings, seconds. */
  readonly pedestrianWait?: (node: NodeId, crossings: readonly CrossingId[]) => number;
  /** Whether a pedestrian is waiting to start one of these crossings. */
  readonly pedestrianDemandOn: (node: NodeId, crossings: readonly CrossingId[]) => boolean;
  /** Whether a physical compact-box holder needs this group next. */
  readonly reservationDemandOn: (node: NodeId, groups: readonly GroupId[]) => boolean;
}

export function createController(
  junction: JunctionTopology,
  crossings: readonly CrossingId[],
  deps: SignalDeps,
  offset: number,
): SignalController {
  const { plan, degraded } = safePlan(junction, crossings, deps);
  return {
    node: junction.node,
    plan,
    // stageIndex / sub / elapsed come from the phase seek below.
    ...seekPhase(plan, offset),
    lastServed: new Map(plan.groups.map((g) => [g, deps.tick()])),
    stageServed: new Map(plan.stages.map((_, i) => [i, deps.tick()])),
    // Neighbouring junctions start out of phase so platoons do not all stop
    // together. The V6 monolith seeded this modulo 23 against a 34 second
    // cycle, so a third of the offset range was unreachable.
    offsetApplied: offset,
    degraded,
  };
}

/**
 * Where in its own cycle a plan sits `seconds` after the start of stage 0.
 *
 * A coordination offset shifts the PHASE. Holding the machine still for the
 * length of the offset does the opposite of that: every junction still starts
 * at stage 0, it just starts later, and in the meantime every approach except
 * the first is held at red for the whole offset.
 */
function seekPhase(
  plan: SignalPlan,
  seconds: number,
): { stageIndex: number; sub: SubPhase; elapsed: number } {
  const total = plan.stages.reduce(
    (sum, s) => sum + s.targetGreen + s.amber + s.allRed,
    0,
  );
  if (!(total > 0) || !Number.isFinite(seconds) || seconds <= 0) {
    return { stageIndex: 0, sub: 'GREEN', elapsed: 0 };
  }

  let left = seconds % total;
  for (let index = 0; index < plan.stages.length; index++) {
    const stage = plan.stages[index];
    if (!stage) break;
    for (const [sub, span] of [
      ['GREEN', stage.targetGreen],
      ['AMBER', stage.amber],
      ['ALL_RED', stage.allRed],
    ] as const) {
      if (left < span) return { stageIndex: index, sub, elapsed: left };
      left -= span;
    }
  }
  return { stageIndex: 0, sub: 'GREEN', elapsed: 0 };
}

function safePlan(
  junction: JunctionTopology,
  crossings: readonly CrossingId[],
  deps: SignalDeps,
): { plan: SignalPlan; degraded: boolean } {
  try {
    return { plan: buildSignalPlan(junction, crossings, deps.connectorsOf, deps.conflictsOf), degraded: false };
  } catch (err) {
    if (!(err instanceof PlanValidationError)) throw err;
    if (isStrict()) throw err;
    // Never leave a group dark: fall back to plain round-robin coverage.
    return {
      plan: roundRobinPlan(
        junction.groups.map((g) => g.id),
        crossings,
      ),
      degraded: true,
    };
  }
}

const isStrict = (): boolean =>
  typeof process !== 'undefined' && process.env?.['SIM_STRICT'] === '1';

/**
 * Advances one controller. This is the ONLY function permitted to mutate
 * `stageIndex`, `sub` or `elapsed`.
 */
/**
 * Longest a green is held past its maximum for people still on its crossings,
 * seconds.
 *
 * A green is never cut over somebody it released, on the grounds that walkers
 * always finish. They do not always: two people met face to face at a kerb,
 * one on the zebra and one on the footway, and each waited for the other for
 * good. The stage that had released the one on the zebra held green for
 * minutes and every other approach starved (`groupStarved`, hundreds of times
 * in five minutes). Anybody who stepped on at the last WALK finishes well
 * inside this, so it bounds only the case where nobody is actually crossing.
 */
const PED_HOLD_LIMIT = 30;

export function stepController(c: SignalController, deps: SignalDeps): void {
  c.elapsed += DT;
  const st = c.plan.stages[c.stageIndex];
  if (!st) {
    c.stageIndex = 0;
    return;
  }

  switch (c.sub) {
    case 'GREEN': {
      // Bounded: see `PED_HOLD_LIMIT`.
      const pedestriansInside = c.elapsed < st.maxGreen + PED_HOLD_LIMIT &&
        deps.pedestriansCrossing(c.node, st.pedWalk);
      const mayEnd = c.elapsed >= st.minGreen && !pedestriansInside;
      const reservedHere = deps.reservationDemandOn(c.node, st.greenGroups);
      const reservedElsewhere = c.plan.groups.some(
        (group) =>
          !st.greenGroups.includes(group) &&
          deps.reservationDemandOn(c.node, [group]),
      );
      const competingDemand = c.plan.stages.some(
        (candidate, index) => index !== c.stageIndex && stageHasDemand(c, candidate, deps),
      );
      // A physical compact-box holder can depend on the next signal to release
      // its rear from the previous junction. Cut a conflicting green after its
      // guaranteed minimum, and keep the needed green alive to its target. The
      // soft future claim itself owns no connector and blocks no admission.
      //
      // Otherwise the green stays alive only while somebody can USE it: a head
      // at the line or arriving within the passage time, with room to leave.
      // That is the gap-out that ends a green the moment its queue has gone,
      // instead of running every stage to its target whatever the traffic.
      const currentDemand = reservedHere || (deps.demand
        ? deps.demand(c.node, st.greenGroups, st.demandMovements).active > 0
        : deps.demandOn(c.node, st.greenGroups));
      const gapOut = mayEnd && !currentDemand;
      const yieldAtTarget = mayEnd && competingDemand && c.elapsed >= st.targetGreen;
      if (gapOut || (mayEnd && reservedElsewhere) || yieldAtTarget) {
        for (const g of st.greenGroups) c.lastServed.set(g, deps.tick());
        c.stageServed.set(c.stageIndex, deps.tick());
        c.sub = 'AMBER';
        c.elapsed = 0;
      } else if (c.elapsed >= st.maxGreen && !pedestriansInside) {
        c.stageServed.set(c.stageIndex, deps.tick());
        // Never cut a green over people still on its crossings. The next stage
        // gives protected green to movements that drive over those crossings,
        // and a walker caught there held every one of them at a green light:
        // measured on a four-way of avenues, the pedestrian obstacle was the
        // commonest reason a queue head stood still at green. Walkers always
        // finish, so the extension is bounded.
        for (const g of st.greenGroups) c.lastServed.set(g, deps.tick());
        c.sub = 'AMBER';
        c.elapsed = 0;
      }
      break;
    }
    case 'AMBER':
      if (c.elapsed >= st.amber) {
        c.sub = 'ALL_RED';
        c.elapsed = 0;
      }
      break;
    case 'ALL_RED':
      // Clearance is purely time based. An all-red conditioned on the box being
      // empty is exactly the kind of gate a single stuck vehicle holds open
      // forever; the box is instead guaranteed to drain because vehicles inside
      // are never held and never enter without room to leave.
      if (c.elapsed >= st.allRed) {
        c.stageIndex = pickNextStage(c, deps);
        c.sub = 'GREEN';
        c.elapsed = 0;
      }
      break;
  }
}

/** Chooses the next stage without skipping any vehicle or pedestrian service. */
export function pickNextStage(c: SignalController, deps: SignalDeps): number {
  const stages = c.plan.stages;
  if (stages.length <= 1) return 0;
  const sequential = (c.stageIndex + 1) % stages.length;
  const now = deps.tick();
  // `lastServed` is recorded in simulation ticks, not seconds.
  const deadline = (c.plan.cycle * SIGNAL.starvationCycles) / DT;

  let overdue = -1;
  let overdueAge = -Infinity;
  let demanded = -1;
  let demandedAge = -Infinity;

  for (let index = 0; index < stages.length; index++) {
    // Do not immediately reopen the phase that just completed its clearance.
    // A real change of right-of-way is needed for amber to protect an
    // approaching driver and to give another movement its minimum service.
    if (index === c.stageIndex) continue;
    const stage = stages[index]!;
    const hasDemand = stageHasDemand(c, stage, deps);
    // Age weighted by what is waiting: the longest-unserved stage still wins
    // eventually, but a stage with a long queue is not made to wait behind one
    // with a single car. An exclusive turn stage only ever runs on demand.
    const waited = stage.demandMovements
      ? now - (c.stageServed.get(index) ?? now)
      : stageAge(c, stage.greenGroups, now);
    const age = waited * (1 + stageScore(c, stage, deps) / DEMAND_PRIORITY);

    // A stage with no live demand may be bypassed, but never indefinitely.
    // This preserves signal-plan coverage and gives a newly busy approach a
    // bounded wait even if the detector missed its first frame.
    if (stage.greenGroups.length && waited >= deadline && (!stage.demandMovements || hasDemand) &&
      betterCandidate(index, age, overdue, overdueAge, sequential, stages.length)) {
      overdue = index;
      overdueAge = age;
    }
    if (hasDemand && betterCandidate(index, age, demanded, demandedAge, sequential, stages.length)) {
      demanded = index;
      demandedAge = age;
    }
  }

  if (overdue >= 0) return overdue;

  // Somebody who has stood at a kerb for PED_WAIT_LIMIT is served next, ahead
  // of vehicle demand: measured before this, walkers waited nearly two
  // minutes at five-leg junctions while every vehicle stage won on queue size.
  let walkers = -1;
  let longest = PED_WAIT_LIMIT;
  for (let index = 0; index < stages.length; index++) {
    if (index === c.stageIndex) continue;
    const wait = deps.pedestrianWait?.(c.node, stages[index]!.pedWalk) ?? 0;
    if (wait >= longest) {
      longest = wait;
      walkers = index;
    }
  }
  if (walkers >= 0) return walkers;
  return demanded >= 0 ? demanded : sequential;
}

/** Kerb wait after which a crossing's stage is served next, seconds. */
const PED_WAIT_LIMIT = 45;

/** Queued vehicles that double a stage's claim to run next. */
const DEMAND_PRIORITY = 6;

function stageHasDemand(c: SignalController, stage: SignalPlan['stages'][number], deps: SignalDeps): boolean {
  if (stage.demandMovements) {
    return deps.demandOn(c.node, stage.greenGroups, stage.demandMovements);
  }
  return deps.reservationDemandOn(c.node, stage.greenGroups) ||
    deps.demandOn(c.node, stage.greenGroups) ||
    deps.pedestrianDemandOn(c.node, stage.pedWalk);
}

function stageScore(c: SignalController, stage: SignalPlan['stages'][number], deps: SignalDeps): number {
  return deps.demand?.(c.node, stage.greenGroups, stage.demandMovements).score ?? 0;
}

function stageAge(c: SignalController, groups: readonly GroupId[], now: number): number {
  if (!groups.length) return 0;
  return Math.max(...groups.map((group) => now - (c.lastServed.get(group) ?? now)));
}

/** Oldest wait wins; circular order breaks exact ties deterministically. */
function betterCandidate(
  index: number,
  age: number,
  current: number,
  currentAge: number,
  sequential: number,
  count: number,
): boolean {
  if (current < 0 || age > currentAge + EPS) return true;
  if (age < currentAge - EPS) return false;
  return circularDistance(index, sequential, count) < circularDistance(current, sequential, count);
}

const circularDistance = (index: number, start: number, count: number): number =>
  (index - start + count) % count;

/**
 * Rebuilds a controller's plan after the network changed, carrying state over.
 *
 * The stage with the greatest overlap with what is currently green is chosen,
 * so the junction does not visibly jump. New groups are timestamped at the
 * rebuild and then served by the same finite sequential cycle as every other
 * stage; diagnostics therefore measure their real wait instead of reporting a
 * synthetic near-starvation immediately after an edit.
 */
export function rebuildController(
  c: SignalController,
  junction: JunctionTopology,
  crossings: readonly CrossingId[],
  deps: SignalDeps,
): void {
  const wasGreen = new Set(currentGreenGroups(c));
  const { plan, degraded } = safePlan(junction, crossings, deps);

  let best = 0;
  let bestScore = -1;
  plan.stages.forEach((s, i) => {
    const score = s.greenGroups.filter((g) => wasGreen.has(g)).length;
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  });

  c.plan = plan;
  c.degraded = degraded;
  c.stageIndex = best;

  if (bestScore > 0 && c.sub === 'GREEN') {
    c.elapsed = Math.min(c.elapsed, plan.stages[best]?.maxGreen ?? SIGNAL.maxGreen);
  } else {
    // What was green no longer exists, or we were mid-transition. Take the full
    // clearance rather than switching a green on top of vehicles in the box.
    c.sub = 'ALL_RED';
    c.elapsed = 0;
  }

  const now = deps.tick();
  for (const g of plan.groups) {
    if (!c.lastServed.has(g)) c.lastServed.set(g, now);
  }
  c.stageServed = new Map(plan.stages.map((_, i) => [i, now]));
  for (const g of [...c.lastServed.keys()]) {
    if (!plan.groups.includes(g)) c.lastServed.delete(g);
  }
}

export function currentGreenGroups(c: SignalController): readonly GroupId[] {
  if (c.sub !== 'GREEN') return [];
  return c.plan.stages[c.stageIndex]?.greenGroups ?? [];
}
