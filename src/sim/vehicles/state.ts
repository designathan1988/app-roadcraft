import type { ConnectorId, LaneletId } from '@world/lanelets';
import type { Archetype } from './archetypes';
import type { Driver } from './driver';
import { type ConstraintSet, emptyConstraints } from './idm';

export type VehicleId = number;

export interface Kinematics {
  readonly lanelet: LaneletId;
  readonly s: number;
  readonly v: number;
  readonly lateral: number;
  /** Most recently left lanelets, needed to locate the body behind its front. */
  readonly rearPath: readonly LaneletId[];
}

export interface ConnectorClearance {
  /** Connector whose exit the front of the vehicle has already crossed. */
  readonly connector: ConnectorId;
  /** Distance travelled by the front beyond that connector's exit. */
  distanceBeyondExit: number;
}

export interface Vehicle {
  readonly id: VehicleId;
  /** The machine: dimensions, mass, palette. One object per class. */
  readonly archetype: Archetype;
  /**
   * The person driving it: acceleration, braking, headway, gap acceptance,
   * patience. One object per vehicle, which is the whole point — see
   * `driver.ts`. Anything about BEHAVIOUR reads this; anything about the
   * vehicle's physical size reads `archetype`.
   */
  readonly driver: Driver;
  readonly color: string;

  /** Current lanelet and arc position. Written ONLY by the integrator. */
  lanelet: LaneletId;
  s: number;
  v: number;
  /** Lateral render offset. Current lanelets keep this at zero. */
  lateral: number;

  /** Free-flow speed, already including this driver's personal factor. */
  v0: number;

  /** Planned lanelet sequence ahead, current lanelet first. */
  route: LaneletId[];
  /** Lanelets still occupied by the body after its front has crossed a boundary. */
  rearPath: LaneletId[];

  /** Conflict points currently held by this vehicle. */
  claims: number[];
  /**
   * Movement granted by the admission pass.  This is separate from
   * `claims`: a connector with no geometric conflict points still needs an
   * admission token, and the integrator must drive exactly this connector.
   */
  admittedConnector: ConnectorId | null;
  /**
   * Soft Banker's maximum claim at or ahead of the vehicle. The first item may
   * be the current red-light movement, declared before driving permission.
   *
   * A link shorter than the vehicle is not a storage refuge: entering it and
   * only then declaring the next junction creates hold-and-wait cycles across
   * a compact grid. Admission therefore declares the complete connector chain
   * up to the next real refuge. Only `admittedConnector` and `claims` are hard
   * ownership; each signal still decides when its connector may be entered.
   */
  reservedConnectors: ConnectorId[];
  /**
   * Earlier connectors still occupied by the rear of the vehicle.
   *
   * This is intentionally separate from `admittedConnector`: on a very short
   * block the front may need admission to the next junction while the rear is
   * still clearing the previous one.
   */
  clearingConnectors: ConnectorClearance[];
  /** Tick of the oldest request, retained across one compact compound box. */
  firstRequestTick: number | null;
  /** Tick at which it last moved a meaningful distance, for the watchdog. */
  lastMovedTick: number;
  /** Seconds spent stationary at a stop line, for gap-acceptance impatience. */
  waited: number;
  /** Set once the vehicle has come to a full stop, enabling right-on-red. */
  rorCredit: boolean;
  rorStopped: number;

  /** Ticks since spawn, used to fade in. */
  age: number;

  /**
   * Seconds spent stationary while the signal was green AND nothing was
   * physically in the way. Diagnostic only.
   *
   * It must be accumulated per tick rather than inferred from "how long since
   * this vehicle last moved", because the instant a long red turns green a
   * vehicle has not moved for thirty seconds yet is about to — inferring from
   * the last-moved tick flags it as wedged when it is merely starting.
   */
  greenStall: number;

  /**
   * Seconds stopped at a green, whatever the reason.
   *
   * `greenStall` above deliberately resets whenever something is in the way,
   * because a brief yield or conflict wait is ordinary traffic. This one does
   * not reset, because "ordinary" has to be bounded: a driver watching a whole
   * green go by does not care which internal predicate refused them. Without
   * it, a fifteen-second wait behind a conflict that never clears is invisible
   * to the audit and the status bar reads "sem alertas".
   */
  greenDenied: number;

  /**
   * Sibling lane this vehicle wants to be on before the next junction.
   *
   * Lane discipline makes each turn legal from exactly one lane, so a driver
   * whose route wants a turn its current lane cannot serve has to move across
   * first. Set once by `planFrom`, when the movement is chosen; held across
   * ticks while a gap is sought, and dropped when the room runs out.
   */
  desiredLane: LaneletId | null;
  /** Chosen next movement, retained while moving through adjacent lanes. */
  movementIntent: ConnectorId | null;

  /**
   * This vehicle's own age at its last lane change, in seconds.
   *
   * Overtaking needs a refractory period or a driver sitting exactly on the
   * MOBIL threshold flips between two lanes every tick.
   *
   * Measured against `age` rather than against the clock's tick, and that is
   * not a stylistic choice: `clock.tick` only advances inside `SimClock.advance`
   * and `SimClock.run`, so a harness that calls `step` directly — which every
   * test in this repository does — sees a frozen clock. Behaviour built on it
   * is behaviour that silently never happens under test. `age` is advanced by
   * the integrator, once per step, whoever called it.
   */
  lastLaneChangeAge: number;

  /** Seconds spent crawling, which is what makes a driver look for a way round. */
  heldUp: number;

  /**
   * A lane change cleared to execute THIS tick.
   *
   * The lane-change stage only decides; `integrate` performs the move, because
   * it is the only writer of `lanelet`.
   */
  laneChange: LaneletId | null;

  constraints: ConstraintSet;

  /** Previous kinematics, for render interpolation. */
  prev: Kinematics;
}

export function snapshot(v: Vehicle): Kinematics {
  return { lanelet: v.lanelet, s: v.s, v: v.v, lateral: v.lateral, rearPath: v.rearPath };
}

export function createVehicle(
  id: VehicleId,
  archetype: Archetype,
  driver: Driver,
  color: string,
  lanelet: LaneletId,
  v0: number,
  tick: number,
): Vehicle {
  const base: Kinematics = { lanelet, s: 0, v: 0, lateral: 0, rearPath: [] };
  return {
    id,
    archetype,
    driver,
    color,
    lanelet,
    s: 0,
    v: 0,
    lateral: 0,
    v0,
    route: [lanelet],
    rearPath: [],
    claims: [],
    admittedConnector: null,
    reservedConnectors: [],
    clearingConnectors: [],
    firstRequestTick: null,
    lastMovedTick: tick,
    waited: 0,
    rorCredit: false,
    rorStopped: 0,
    age: 0,
    greenStall: 0,
    greenDenied: 0,
    desiredLane: null,
    movementIntent: null,
    lastLaneChangeAge: 0,
    heldUp: 0,
    laneChange: null,
    constraints: emptyConstraints(),
    prev: base,
  };
}
