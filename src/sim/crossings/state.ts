import type { CrossingId } from '../signals/plan';

/**
 * What the rest of the simulation may know about the people at one crossing.
 *
 * Vehicles (admission, the stop before a zebra), the signal controllers and
 * the audit used to read the pedestrian model's internals - its edges, its
 * `entry`/`s` along a crossing edge, its FSM states, `stuck` - so no other
 * pedestrian model could ever be put behind them. This is the whole contract
 * now (docs/design/agency-architecture.md, step P0): whichever engine moves
 * the people publishes one of these per crossing at the end of its stage, and
 * nothing outside that engine reads a pedestrian again.
 *
 * Positions are measured along the crossing from its `from` kerb (the end the
 * crossing's walk edge starts at), in world units.
 */
export interface CrossingOccupant {
  readonly id: number;
  /** Distance from the `from` kerb. */
  readonly s: number;
  /** Walking from the `from` kerb towards the `to` kerb. */
  readonly forward: boolean;
  /** Walking speed, world units a second. */
  readonly v: number;
  /**
   * Standing still on the crossing, waiting for something - very often for
   * the very vehicle asking - rather than arriving.
   */
  readonly held: boolean;
}

export interface CrossingState {
  /** Kerb to kerb, world units. */
  readonly length: number;
  /** Everybody on the crossing, in the order they stepped on. */
  readonly occupants: CrossingOccupant[];
  /** People waiting at each kerb to cross. */
  waitingFrom: number;
  waitingTo: number;
  /** Anybody at, or walking up to, a kerb meaning to cross here. */
  demand: boolean;
  /** Longest time anybody has waited at a kerb for this crossing, seconds. */
  longestWait: number;
}

export type CrossingStates = Map<CrossingId, CrossingState>;

/** An empty state for a crossing of this length. */
export function emptyCrossingState(length: number): CrossingState {
  return { length, occupants: [], waitingFrom: 0, waitingTo: 0, demand: false, longestWait: 0 };
}
