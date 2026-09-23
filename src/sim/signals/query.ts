import type { CrossingId, GroupId } from './plan';
import type { SignalController } from './fsm';
import { PED } from '../params';

export type SignalState = 'green' | 'amber' | 'red';
export type WalkState = 'walk' | 'flash' | 'dont';

/**
 * Signal state for one approach group.
 *
 * PURE. No mutation, no lazy plan construction, no allocation.
 *
 * The V6 monolith's equivalent getter rebuilt the signal plan on a cache miss —
 * rewriting `cycle` and `phaseOffset` — and was called from the renderer to
 * draw each lamp. Phase and axis could therefore be evaluated against two
 * different plans inside one expression, producing frames where no approach
 * matched the current phase and every light read red (defect 3.3). Keeping the
 * query pure and the builder unreachable from here is what makes that
 * impossible; a test freezes a controller and calls this ten thousand times.
 */
export function signalStateFor(c: SignalController, group: GroupId): SignalState {
  const st = c.plan.stages[c.stageIndex];
  if (!st) return 'red';
  if (!st.greenGroups.includes(group)) return 'red';
  if (c.sub === 'GREEN') return 'green';
  if (c.sub === 'AMBER') return 'amber';
  return 'red';
}

/** True when at least one group at this junction currently has green. */
export function anyGreen(c: SignalController): boolean {
  return c.sub === 'GREEN' && (c.plan.stages[c.stageIndex]?.greenGroups.length ?? 0) > 0;
}

/**
 * Seconds for which the crossing stays protected from the traffic that would
 * otherwise use its leg. Counts the remaining green plus the whole clearance,
 * because vehicles are held for both.
 */
export function remainingProtectedTime(c: SignalController, crossing: CrossingId): number {
  const st = c.plan.stages[c.stageIndex];
  if (!st || !st.pedWalk.includes(crossing)) return 0;
  const clearance = st.amber + st.allRed;
  switch (c.sub) {
    case 'GREEN':
      // A green is never cut while somebody it released is still crossing
      // (`stepController`), so up to its maximum the window is guaranteed.
      // Measuring from the target instead lit WALK for about a second on a
      // boulevard crossing and held people through three cycles.
      return Math.max(0, Math.max(st.targetGreen, st.maxGreen) - c.elapsed) + clearance;
    case 'AMBER':
      return Math.max(0, st.amber - c.elapsed) + st.allRed;
    case 'ALL_RED':
      return Math.max(0, st.allRed - c.elapsed);
  }
}

/**
 * Walk indicator for one crossing.
 *
 * The simulation gates pedestrians on this same function, so the lamp and the
 * permission are one thing. The V6 monolith had two functions with exactly
 * opposite conditions — one driving the indicator, one driving the movement
 * (defect 4.4).
 */
export function pedestrianSignalState(
  c: SignalController,
  crossing: CrossingId,
  crossingLength: number,
): WalkState {
  const st = c.plan.stages[c.stageIndex];
  if (!st || !st.pedWalk.includes(crossing)) return 'dont';
  const need = crossingLength / PED.designSpeed + PED.startLag;
  if (remainingProtectedTime(c, crossing) < need) return 'flash';
  return c.sub === 'GREEN' ? 'walk' : 'flash';
}

/** Seconds a group has been red, for the starvation invariant. */
export function isServed(c: SignalController, group: GroupId): boolean {
  return signalStateFor(c, group) !== 'red';
}
