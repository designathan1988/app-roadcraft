import type { TurnKind } from '@world/lanelets';
import type { DriverParams } from '../vehicles/driver';
import { canStopComfortably } from '../vehicles/idm';
import type { SignalState } from './query';

/**
 * One shared yellow/red decision for both longitudinal braking and admission.
 *
 * If these two callers disagree, admission can grant a connector on the same
 * amber tick in which the vehicle decides to stop. The token then suppresses
 * the signal obstacle and lets it enter after the group is red. Keeping the
 * dilemma-zone decision here makes "stop" and "may acquire" inseparable.
 */
/**
 * Whether a right turn may be taken on red after a full stop.
 *
 * OFF, because this game's roads are Brazilian ones and Brazil does not have
 * the rule: a red light stops every movement unless a sign says otherwise. It
 * is a US and Canadian permission, and leaving it on meant cars crossing a
 * stop line on red - which a player reads, correctly, as the signal being
 * broken.
 *
 * It is kept as a switch rather than deleted because the mechanism behind it
 * is real and correct - a vehicle must come to a genuine stop for a second
 * before it earns the credit (`rorStopped` in `vehicles/integrate.ts`) - and
 * a per-junction "right turn permitted on red" plate is the natural way to
 * bring it back.
 */
const RIGHT_ON_RED_ALLOWED = false;

export function mustStopAtSignal(
  state: SignalState,
  turn: TurnKind,
  rightOnRedCredit: boolean,
  driver: DriverParams,
  speed: number,
  distanceToStop: number,
): boolean {
  if (state === 'red') {
    return !(RIGHT_ON_RED_ALLOWED && turn === 'right' && rightOnRedCredit);
  }
  if (state === 'amber') {
    return canStopComfortably(driver, speed, distanceToStop);
  }
  return false;
}
