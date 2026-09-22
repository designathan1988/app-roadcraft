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
export function mustStopAtSignal(
  state: SignalState,
  turn: TurnKind,
  rightOnRedCredit: boolean,
  driver: DriverParams,
  speed: number,
  distanceToStop: number,
): boolean {
  if (state === 'red') return !(turn === 'right' && rightOnRedCredit);
  if (state === 'amber') {
    return canStopComfortably(driver, speed, distanceToStop);
  }
  return false;
}
