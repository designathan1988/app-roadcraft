import type { ConnectorId, LaneletId } from '@world/lanelets';
import type { Archetype } from './archetypes';
import type { Driver } from './driver';
import { type ConstraintSet, emptyConstraints } from './idm';
import type { ErrandKind, KerbStop } from './kerbStops';
import type { PersonAgeClass } from '../people/view';

export type VehicleId = number;

export interface Kinematics {
  readonly lanelet: LaneletId;
  readonly s: number;
  readonly v: number;
  readonly lateral: number;
  /** Rate of change of `lateral`, world units a second. */
  /** Sideways offset per unit of road driven: the tangent of the lane-change heading. */
  readonly lateralSlope: number;
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
  /** Acceleration applied last tick, u/s². Written only by the integrator. */
  accel: number;
  /** Lateral render offset. Current lanelets keep this at zero. */
  lateral: number;
  /**
   * The offset is that of the REAR AXLE, which is what follows the curve; the
   * body is steered from it (`vehiclePose`).
   *
   * `lateral` at the transfer, road driven since, and the length of road the
   * change is driven over (`laneChangeLength`): the profile's inputs.
   */
  lateralStart: number;
  lateralTravelled: number;
  lateralLength: number;
  /** d(lateral)/ds, for the heading the body points along (`laneChangeSlope`). */
  lateralSlope: number;

  /** Free-flow speed, already including this driver's personal factor. */
  v0: number;

  /** Planned lanelet sequence ahead, current lanelet first. */
  route: LaneletId[];
  /** Stable trip endpoint; congestion may change the route, not the goal. */
  destination: LaneletId | null;
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
  /**
   * The connector whose amber this driver has decided to stop for, until its
   * next green. Written only through `signalHolds` (`signals/permission.ts`).
   */
  amberStop: string | null;

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

  /**
   * The lane this driver is signalling towards, and their age when they began.
   *
   * A change used to be decided and started in the same tick, so the
   * indicator came on as the car was already moving across - measured, 16 of
   * 196 changes had shown the indicator for a second beforehand. A driver
   * signals first, checks the gap again, and only then moves
   * (`SIGNAL_LEAD` in `laneChange.ts`).
   */
  laneIntent: LaneletId | null;
  laneIntentSince: number;

  /**
   * How far each door is open, 0 shut to 1 fully open, indexed as the body
   * model numbers them (driver's side first, front to back). Written by the
   * kerb-stop stage when somebody gets in or out; empty while all are shut.
   */
  doors: number[];

  /** Seats taken, one bit per seat in the body model's order; bit 0 is the driver. */
  seats: number;
  /** Pedestrian ids of people picked up, by seat; others are `seatPerson`'s default. */
  people: number[];
  /** Age class of the people in `people`, by seat. */
  peopleAge: PersonAgeClass[];
  /** What this trip stops for at a kerb, if anything (`kerbStops.ts`). */
  errand: ErrandKind | null;
  /** The kerb stop under way, from choosing the place to pulling away. */
  kerbStop: KerbStop | null;
  /** Further tasks of the same stop: the next passenger of a bus, the mate's return. */
  kerbQueue: KerbStop[];
  /** Own age at the last bus stop served. */
  lastServiceAge: number;

  /**
   * The lane this vehicle is sliding OUT of, while its body still overlaps it.
   *
   * The transfer to the new lane is instantaneous in the occupancy index but
   * not on the road: `lateral` slides the body across over the next second.
   * Until the body has cleared the old lane, the vehicle is an obstacle in
   * BOTH lanes. `offset` converts its arc position on the new lane to the old
   * one. `clearAt` is where the line between the two lanes lies, as an offset
   * from the new lane's centre; the shadow is dropped once the whole body,
   * angled as it is, lies inside it.
   */
  shadow: { readonly lanelet: LaneletId; readonly offset: number; readonly clearAt: number } | null;

  constraints: ConstraintSet;

  /** Previous kinematics, for render interpolation. */
  prev: Kinematics;
}

export function snapshot(v: Vehicle): Kinematics {
  return { lanelet: v.lanelet, s: v.s, v: v.v, lateral: v.lateral, lateralSlope: v.lateralSlope, rearPath: v.rearPath };
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
  const base: Kinematics = { lanelet, s: 0, v: 0, lateral: 0, lateralSlope: 0, rearPath: [] };
  return {
    id,
    archetype,
    driver,
    color,
    lanelet,
    s: 0,
    v: 0,
    accel: 0,
    lateral: 0,
    lateralStart: 0,
    lateralTravelled: 0,
    lateralLength: 1,
    lateralSlope: 0,
    v0,
    route: [lanelet],
    destination: null,
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
    amberStop: null,
    age: 0,
    greenStall: 0,
    greenDenied: 0,
    desiredLane: null,
    movementIntent: null,
    lastLaneChangeAge: 0,
    heldUp: 0,
    laneChange: null,
    laneIntent: null,
    laneIntentSince: 0,
    doors: [],
    seats: 1,
    people: [],
    peopleAge: [],
    errand: null,
    kerbStop: null,
    kerbQueue: [],
    lastServiceAge: 0,
    shadow: null,
    constraints: emptyConstraints(),
    prev: base,
  };
}
