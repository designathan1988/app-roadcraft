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

/**
 * `mustStopAtSignal` for one vehicle and connector, with the amber decision
 * held once it is made.
 *
 * Asked afresh every tick, "can I still stop comfortably?" changes its answer
 * as the car closes on the line. A driver who decided at the start of the
 * amber to stop, and eased off gently to do it, found a few ticks later that
 * the same question now said "no": the stop obstacle vanished, admission
 * granted the movement, and the car crossed the line on red. Drivers do not
 * change their mind like that. The decision to stop is kept until the
 * movement's next green; the decision to go is not kept, and is asked again,
 * so a car that can stop still does.
 *
 * Braking, admission and the revocation of stale grants all ask here, so the
 * three always agree.
 */
export function signalHolds(
  v: { amberStop: string | null; rorCredit: boolean; driver: DriverParams; v: number },
  connector: string,
  state: SignalState,
  turn: TurnKind,
  distanceToStop: number,
): boolean {
  if (state === 'green') {
    if (v.amberStop === connector) v.amberStop = null;
    return false;
  }
  if (state === 'amber' && v.amberStop === connector) return true;
  const stop = mustStopAtSignal(state, turn, v.rorCredit, v.driver, v.v, distanceToStop);
  if (stop && state === 'amber') v.amberStop = connector;
  return stop;
}

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
