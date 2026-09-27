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
 * A lane change is a PATH, not a slide.
 *
 * The offset used to follow a minimum-jerk profile in TIME: about three
 * seconds a lane whatever the car was doing. At speed that is fine, but a car
 * creeping in a queue kept moving sideways at the same rate while hardly
 * moving forward, and the heading it points along, the direction of its real
 * velocity, could not keep up: the body crabbed across, reported as cars
 * "floating sideways" instead of steering into the lane. A car can only move
 * sideways by driving forwards at an angle, so the offset is now a function
 * of the DISTANCE driven since the transfer: stopped mid-change, it stays
 * where it is, angled, and the body always points along the curve it traces.
 *
 * The length of that curve is set by the steering angle a driver uses: sharp
 * at a crawl, where a lane is taken in little more than two car lengths, and
 * shallow at speed, where the same lane takes four or five seconds. A long
 * vehicle is steered more gently still: the curve is never shorter than a few
 * of its own lengths, or a truck would pivot across the line like a car.
 */
export const LANE_CHANGE_HEADING_SLOW = 0.42;
export const LANE_CHANGE_HEADING_FAST = 0.1;
/** Speed at which the shallow heading is reached, world units a second. */
export const LANE_CHANGE_FAST_SPEED = kmh(45);
/** Never quicker than this at any speed, seconds. */
export const LANE_CHANGE_MIN_TIME = 2;
/** Shortest curve, in body lengths of the vehicle driving it. */
const LANE_CHANGE_MIN_BODIES = 2.5;
/** Peak slope of the quintic profile, as a multiple of its mean slope. */
const PROFILE_PEAK = 1.875;

/** Road length over which a lane change of offset `start` is driven at `speed`. */
export function laneChangeLength(start: number, speed: number, bodyLength: number): number {
  const t = Math.min(1, Math.max(0, speed / LANE_CHANGE_FAST_SPEED));
  const heading = LANE_CHANGE_HEADING_SLOW + (LANE_CHANGE_HEADING_FAST - LANE_CHANGE_HEADING_SLOW) * t;
  return Math.max(PROFILE_PEAK * Math.abs(start) / Math.tan(heading),
    Math.max(0, speed) * LANE_CHANGE_MIN_TIME, bodyLength * LANE_CHANGE_MIN_BODIES, 1e-6);
}

/** Offset still to cover after driving `travelled` of a `length` change (quintic). */
export function laneChangeOffset(start: number, travelled: number, length: number): number {
  const u = Math.min(1, Math.max(0, travelled / length));
  const done = u * u * u * (10 - 15 * u + 6 * u * u);
  return u >= 1 ? 0 : start * (1 - done);
}

/** Sideways offset gained per unit of road driven: the tangent of the body's heading. */
export function laneChangeSlope(start: number, travelled: number, length: number): number {
  const u = Math.min(1, Math.max(0, travelled / length));
  if (u >= 1) return 0;
  return (-start * 30 * u * u * (1 - u) * (1 - u)) / length;
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
  /** Target green of an exclusive stage serving turns that are otherwise permissive. */
  exclusiveGreen: 10,
  amber: 3.2,
  minAllRed: 1.2,
  /** A group red for longer than this many cycles is promoted. */
  starvationCycles: 1.5,
  /** Uncontrolled nodes hold a permanent green. */
  uncontrolledGreen: 3600,
} as const;

/**
 * Pedestrians walk as agents that perceive and choose a velocity
 * (`sim/peds/agent.ts`); false is the older gate-and-nudge walker, kept for
 * comparison in the lab until the agent wins on every measure.
 */
export const PED_AGENT = { on: true, crossings: false };

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
//
// They are ALSO what the renderer sizes its instance buffers from
// (`render/agents.ts`), so the simulation can never hold an agent the screen
// cannot draw. They used to be 3000 and 1500 against buffers of 1200 and 1000:
// past those, agents existed, took road space and held claims, invisibly.
export const FLEET_CEILING = 1200;
export const PED_CEILING = 1000;

/**
 * Share of the ceiling allowed on a narrow screen.
 *
 * A phone has less to draw with and less to look at, so it gets a smaller
 * population — but proportionally, like everything else here. It used to be a
 * second bare constant, which meant a narrow screen was capped at 48 vehicles
 * whether it was showing four roads or four hundred.
 */
export const NARROW_SCREEN_SHARE = 0.5;
/** Viewport width, CSS pixels, under which a screen counts as narrow. */
export const NARROW_SCREEN_WIDTH = 800;

/** A claim holder immobile for this long is reported (diagnostic only). */
export const STUCK_SECONDS = 10;

/** Free-flow speed sampling. */
export const DRIVER_NOISE = { lo: 0.92, hi: 1.08 } as const;

/**
 * Speed cap through curvature, expressed as the lateral acceleration a driver
 * accepts, which FALLS with speed.
 *
 * It was one number, 2.5 m/s², at every speed. That is a fair figure for a
 * motorway curve and far below what anybody accepts turning a street corner:
 * observed intersection turns run at 3.5 to 4.5 m/s² at 15 to 25 km/h, and
 * the comfortable figure falls towards 2 m/s² by motorway speeds. With the old
 * constant a right turn of 7 m radius was taken at 15 km/h and a left of 14 m
 * at 21 km/h - the "extremely slow" turns players reported.
 *
 * `MAX_LATERAL_ACCEL` is the figure at a crawl; each world unit per second of
 * speed takes `LATERAL_ACCEL_FALL` off it, down to `MIN_LATERAL_ACCEL`.
 */
export const MAX_LATERAL_ACCEL = m(4.0);
/** Reduction of the accepted lateral acceleration per unit of speed, per second. */
export const LATERAL_ACCEL_FALL = 0.09;
export const MIN_LATERAL_ACCEL = m(1.8);
