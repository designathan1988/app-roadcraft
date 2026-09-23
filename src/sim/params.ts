import { kmh, m } from '@world/units';

/**
 * Every tunable of the simulation, in world units and seconds.
 *
 * One unit system, one file. The V6 monolith spread magic numbers across ~120
 * functions and mixed scales inside single expressions, which is how the
 * downstream-storage formula came out negative for short links (defect 2.2).
 */

/** Fixed simulation step. Physics never depends on frame rate. */
export const DT = 1 / 60;
/** Cap on catch-up steps per frame, so a stall cannot spiral. */
export const MAX_SUBSTEPS = 5;
/** Wall-clock time is clamped to this before being accumulated. */
export const MAX_FRAME = 0.25;

/**
 * Mean sideways speed of a lane change, world units a second (1.1 m/s).
 *
 * This used to be a CONSTANT 3.4 m/s: the body started sliding at full speed
 * on the transfer tick and stopped dead in the new lane, so a lane change
 * read as a sideways jerk rather than a steered manoeuvre. The offset now
 * follows a minimum-jerk profile (`laneChangeOffset`): sideways speed builds
 * from zero, peaks at 1.875 times this mean and falls back to zero, and a
 * 3.4 m lane takes about three seconds, which is what drivers measure at.
 */
export const LANE_CHANGE_LATERAL_SPEED = m(1.1);
/** Bounds on the duration of one lane change, seconds. */
export const LANE_CHANGE_MIN_TIME = 2;
export const LANE_CHANGE_MAX_TIME = 4.5;

/** Seconds one lane change takes to slide out an offset of `start`. */
export const laneChangeDuration = (start: number): number =>
  Math.min(LANE_CHANGE_MAX_TIME,
    Math.max(LANE_CHANGE_MIN_TIME, Math.abs(start) / LANE_CHANGE_LATERAL_SPEED));

/** Offset still to slide after `elapsed` seconds (quintic minimum-jerk). */
export function laneChangeOffset(start: number, elapsed: number): number {
  const u = Math.min(1, Math.max(0, elapsed / laneChangeDuration(start)));
  const done = u * u * u * (10 - 15 * u + 6 * u * u);
  return u >= 1 ? 0 : start * (1 - done);
}

/** Bumper-to-bumper spacing at a standstill. */
export const JAM_GAP = m(2);
/** Longest vehicle in the fleet, used to size link capacity. */
export const MAX_VEHICLE_LENGTH = m(9.8);
/** Shortest link that can hold the largest vehicle plus its jam gap. */
export const L_MIN = MAX_VEHICLE_LENGTH + JAM_GAP + m(2);

/** A vehicle requests entry from this far back — generous by design. */
export const REQUEST_TIME = 3.0;
export const REQUEST_MIN_DISTANCE = m(8);

/**
 * Speed above which a vehicle counts as rolling rather than queueing.
 *
 * Used on both sides of the convoy test in `admission.ts`: the convoy already
 * inside the junction must be moving, and a follower joining it from behind
 * must be moving too. Anything at or below this is a standing queue, and a
 * standing queue may not take a claim it would then sit on.
 */
export const CONVOY_ROLLING = 0.5;

/** Critical gaps for yielding movements, in seconds. */
export const CRITICAL_GAP = {
  through: 4.5,
  right: 4.0,
  left: 5.5,
  uturn: 6.5,
} as const;

/** Waiting drivers accept smaller gaps, but never below the floor. */
export const IMPATIENCE_RATE = 0.06;
export const IMPATIENCE_MAX = 1.5;
export const CRITICAL_GAP_FLOOR = 3.0;

/**
 * Seconds a driver may wait for a gap before taking the next one offered.
 *
 * Impatience alone cannot guarantee this. It shortens the required gap by
 * `IMPATIENCE_RATE` per second up to `IMPATIENCE_MAX` and then stops, and the
 * gap can never fall below `CRITICAL_GAP_FLOOR` — so a stream that never
 * offers even the floor gap is waited out forever. That is a feedback loop, not
 * a queue: measured on an unsignalised node, four of nine vehicles were stopped
 * with the leader carrying `yield` indefinitely and three more piled behind it.
 *
 * A deadlock is a game failure, not realism. Twelve seconds is longer than any
 * real driver waits at a minor approach and short enough that a player never
 * sees the city seize. The ceiling waives only the COURTESY of a gap: the claim
 * table, the Banker safety check, downstream storage and the pedestrian
 * crossing all still have to allow the movement, so it cannot cause a
 * collision — it can only stop the polite driver from being polite forever.
 */
export const WAIT_CEILING = 12;

/** Signal timing, in seconds. */
export const SIGNAL = {
  minGreen: 6,
  // The widest built-in boulevard crossing is about 55 world units. At the
  // design walking speed it needs 22 s including start lag; 20 s of green plus
  // amber/all-red guarantees that full protected window.
  baseGreen: 20,
  maxGreen: 34,
  amber: 3.2,
  minAllRed: 1.2,
  /** A group red for longer than this many cycles is promoted. */
  starvationCycles: 1.5,
  /** Uncontrolled nodes hold a permanent green. */
  uncontrolledGreen: 3600,
} as const;

/** Pedestrian parameters. */
export const PED = {
  /** Design speed used to size clearance intervals. */
  designSpeed: m(1.0),
  meanSpeed: m(1.34),
  speedSd: m(0.2),
  minSpeed: m(0.8),
  maxSpeed: m(1.8),
  /** Reaction lag before stepping off the kerb. */
  startLag: 1.0,
  /** Following model. */
  jamGap: m(0.45),
  headway: 0.4,
  accel: m(1.2),
  /** Parallel walking files across a crossing. */
  files: 3,
  fileSpacing: m(0.7),
  criticalGap: 4.0,
  /** Probability a driver yields to a waiting pedestrian at an uncontrolled crossing. */
  courtesyYield: 0.35,
} as const;

/** Vehicle population target, per unit of total road length. */
export const TRAFFIC_DENSITY = 1 / m(45);
export const PED_DENSITY = 1 / m(90);

/**
 * Safety ceilings on the agent population. Runaway guards, not design targets.
 *
 * The fleet is meant to follow the city: build more road and more traffic uses
 * it. It did not. Both spawners ended in `Math.min(cap, byLength)` with `cap` a
 * bare 90 and 44, and on a nine-fold larger network — 84 roads to 760 — the
 * population did not move off 134. The `min` swallowed the whole city. Found
 * while measuring frame rate; it is a defect in the game, not in the renderer.
 *
 * These are set far above any density the length formula produces for a city
 * anyone would build, so what actually decides the number is the road network,
 * and the ceiling only exists so a pathological map cannot allocate without
 * bound.
 */
export const FLEET_CEILING = 3000;
export const PED_CEILING = 1500;

/**
 * Share of the ceiling allowed on a narrow screen.
 *
 * A phone has less to draw with and less to look at, so it gets a smaller
 * population — but proportionally, like everything else here. It used to be a
 * second bare constant, which meant a narrow screen was capped at 48 vehicles
 * whether it was showing four roads or four hundred.
 */
export const NARROW_SCREEN_SHARE = 0.5;

/** A claim holder immobile for this long is reported (diagnostic only). */
export const STUCK_SECONDS = 10;

/** Free-flow speed sampling. */
export const DRIVER_NOISE = { lo: 0.92, hi: 1.08 } as const;

/** Speed cap through curvature, expressed as lateral acceleration. */
export const MAX_LATERAL_ACCEL = m(2.5);

/** Nominal speed limits by class, mirrored here for readability. */
export const SPEED_REFERENCE = {
  local: kmh(30),
  urban: kmh(50),
  avenue: kmh(60),
  boulevard: kmh(60),
} as const;
