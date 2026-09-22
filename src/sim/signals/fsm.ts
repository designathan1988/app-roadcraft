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
  /** Coordination offset, counted down once at creation. */
  offsetRemaining: number;
  /** Set when a plan failed validation and a fallback was substituted. */
  degraded: boolean;
}

export interface SignalDeps {
  readonly tick: () => number;
  readonly connectorsOf: (id: string) => Connector | undefined;
  /** Pedestrians still inside a crossing that this stage released. */
  readonly pedestriansCrossing: (node: NodeId, crossings: readonly CrossingId[]) => boolean;
  /** Whether any vehicle is waiting on the given groups. */
  readonly demandOn: (node: NodeId, groups: readonly GroupId[]) => boolean;
  /** Whether a pedestrian is waiting to start one of these crossings. */
  readonly pedestrianDemandOn: (node: NodeId, crossings: readonly CrossingId[]) => boolean;
  /** Whether a physical compact-box holder needs this group next. */
  readonly reservationDemandOn: (node: NodeId, groups: readonly GroupId[]) => boolean;
}

export function createController(
  junction: JunctionTopology,
  crossings: readonly CrossingId[],
  deps: SignalDeps,
  offsetSeed: number,
): SignalController {
  const { plan, degraded } = safePlan(junction, crossings, deps);
  return {
    node: junction.node,
    plan,
    stageIndex: 0,
    sub: 'GREEN',
    elapsed: 0,
    lastServed: new Map(plan.groups.map((g) => [g, deps.tick()])),
    // Neighbouring junctions start out of phase so platoons do not all stop
    // together. The V6 monolith seeded this modulo 23 against a 34 second
    // cycle, so a third of the offset range was unreachable.
    offsetRemaining: offsetSeed % Math.max(1, plan.cycle),
    degraded,
  };
}

function safePlan(
  junction: JunctionTopology,
  crossings: readonly CrossingId[],
  deps: SignalDeps,
): { plan: SignalPlan; degraded: boolean } {
  try {
    return { plan: buildSignalPlan(junction, crossings, deps.connectorsOf), degraded: false };
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
export function stepController(c: SignalController, deps: SignalDeps): void {
  if (c.offsetRemaining > 0) {
    c.offsetRemaining -= DT;
    return;
  }

  c.elapsed += DT;
  const st = c.plan.stages[c.stageIndex];
  if (!st) {
    c.stageIndex = 0;
    return;
  }

  switch (c.sub) {
    case 'GREEN': {
      const pedestriansInside = deps.pedestriansCrossing(c.node, st.pedWalk);
      const mayEnd = c.elapsed >= st.minGreen && !pedestriansInside;
      const reservedHere = deps.reservationDemandOn(c.node, st.greenGroups);
      const reservedElsewhere = c.plan.groups.some(
        (group) =>
          !st.greenGroups.includes(group) &&
          deps.reservationDemandOn(c.node, [group]),
      );
      const competingDemand = c.plan.groups.some(
        (group) =>
          !st.greenGroups.includes(group) &&
          (deps.reservationDemandOn(c.node, [group]) || deps.demandOn(c.node, [group])),
      ) || c.plan.stages.some(
        (candidate, index) => index !== c.stageIndex && deps.pedestrianDemandOn(c.node, candidate.pedWalk),
      );
      // A physical compact-box holder can depend on the next signal to release
      // its rear from the previous junction. Cut a conflicting green after its
      // guaranteed minimum, and keep the needed green alive to its target. The
      // soft future claim itself owns no connector and blocks no admission.
      const currentDemand = reservedHere || deps.demandOn(c.node, st.greenGroups);
      const gapOut = mayEnd && !currentDemand;
      const yieldAtTarget = mayEnd && competingDemand && c.elapsed >= st.targetGreen;
      if (gapOut || (mayEnd && reservedElsewhere) || yieldAtTarget) {
        for (const g of st.greenGroups) c.lastServed.set(g, deps.tick());
        c.sub = 'AMBER';
        c.elapsed = 0;
      } else if (c.elapsed >= st.maxGreen) {
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
    const age = stageAge(c, stage.greenGroups, now);
    const hasDemand =
      deps.reservationDemandOn(c.node, stage.greenGroups) ||
      deps.demandOn(c.node, stage.greenGroups) ||
      deps.pedestrianDemandOn(c.node, stage.pedWalk);

    // A stage with no live demand may be bypassed, but never indefinitely.
    // This preserves signal-plan coverage and gives a newly busy approach a
    // bounded wait even if the detector missed its first frame.
    if (stage.greenGroups.length && age >= deadline &&
      betterCandidate(index, age, overdue, overdueAge, sequential, stages.length)) {
      overdue = index;
      overdueAge = age;
    }
    if (hasDemand && betterCandidate(index, age, demanded, demandedAge, sequential, stages.length)) {
      demanded = index;
      demandedAge = age;
    }
  }

  return overdue >= 0 ? overdue : demanded >= 0 ? demanded : sequential;
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
  for (const g of [...c.lastServed.keys()]) {
    if (!plan.groups.includes(g)) c.lastServed.delete(g);
  }
}

export function currentGreenGroups(c: SignalController): readonly GroupId[] {
  if (c.sub !== 'GREEN') return [];
  return c.plan.stages[c.stageIndex]?.greenGroups ?? [];
}
