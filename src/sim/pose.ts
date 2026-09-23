import { clamp, lerp } from '@core/scalar';
import { type Vec2, addScaled, angleOf, dist, lerpVec, perp } from '@core/vec2';
import type { Frame } from '@core/polyline';
import type { SimWorld } from '@sim/world';
import type { Kinematics, Vehicle } from '@sim/vehicles/state';
import type { Ped } from '@sim/peds/state';

export interface Pose {
  readonly p: Vec2;
  readonly angle: number;
}

/**
 * Largest gap, in world units, that two consecutive poses may be apart before
 * the interpolation is abandoned.
 *
 * A topology rebuild can move a vehicle to a lanelet somewhere else entirely,
 * and lerping across that would draw a car sliding over open ground. Ordinary
 * motion is at most `v * DT` plus a lane width, so this is generous enough
 * never to fire on a real step and tight enough to catch a re-seat.
 */
const POSE_JUMP_LIMIT = 60;

/**
 * Largest angle a lane change may turn a vehicle by, in radians.
 *
 * A car changing lane points slightly into the move - that is what makes it
 * read as being DRIVEN across rather than sliding sideways on ice. About six
 * degrees is what a deliberate motorway lane change actually looks like, and
 * more than that reads as a swerve.
 */
const MAX_LANE_CHANGE_YAW = 0.11;


/**
 * Angle a vehicle points into its own lane change: along its actual velocity,
 * forward speed plus the sideways speed of the slide.
 *
 * The slide is eased (`laneChangeOffset`), so its sideways speed is zero at
 * both ends and the body turns into the move and straightens out of it
 * smoothly. The simulation computes the rate once per step; taking the
 * difference of two snapshots here would be wrong on the transfer tick, where
 * `lateral` jumps by a lane width while the car itself barely moves.
 */
function laneChangeYaw(lateralRate: number, speed: number): number {
  if (lateralRate === 0) return 0;
  return clamp(Math.atan2(lateralRate, Math.max(speed, 0.5)), -MAX_LANE_CHANGE_YAW, MAX_LANE_CHANGE_YAW);
}

/**
 * Pose of a vehicle, interpolated between the last two simulation steps.
 *
 * Two things here were making the traffic look mechanical, and both were
 * reported as cars "jumping" or "bugging out" while driving.
 *
 * THE POSITION. This used to return the current pose outright whenever the
 * vehicle had changed lanelet since the last snapshot, on the grounds that
 * there is nothing meaningful to interpolate between two different lanes. But
 * a lanelet change is not a discontinuity: entering a connector, leaving one,
 * or transferring to a sibling lane all leave the vehicle within a metre or
 * two of where it was. Refusing to interpolate meant that at every junction
 * entry, every junction exit and every lane change - the three moments the eye
 * is actually following - the car was drawn snapping to its new centreline.
 * It now interpolates from wherever it actually was, and only gives up if the
 * two poses are implausibly far apart, which means the topology was rebuilt
 * underneath it.
 *
 * THE HEADING. The angle was never interpolated at all: it was read from the
 * tangent at the current arc position, which only changes when the simulation
 * steps. Between two ticks it is constant, so a turning car rotated in
 * sixty-per-second increments rather than sweeping, and at 2x or 4x speed the
 * stepping is plainly visible. It is now interpolated the short way round,
 * which is the only way to interpolate an angle without a car occasionally
 * spinning the long way through 359 degrees.
 */
export function vehiclePose(w: SimWorld, v: Vehicle, alpha: number): Pose | null {
  const frame = bodyFrame(w, v, v.archetype.length / 2);
  if (!frame) return null;
  const t = clamp(alpha, 0, 1);

  // Simulation arc position is the FRONT of the vehicle. The visible body
  // centre can still be on the previous lanelet after the front enters a turn.
  // `lateral` is the unfinished part of a lane change: the simulation has
  // already moved the vehicle onto the new centreline, and this is how far it
  // still has to slide across to get there visually.
  const at = addScaled(frame.p, perp(frame.t), v.lateral);
  const heading = angleOf(frame.t);
  const here: Pose = { p: at, angle: heading };

  const before = bodyFrame(w, v.prev, v.archetype.length / 2);
  if (!before) return here;
  const beforeAt = addScaled(before.p, perp(before.t), v.prev.lateral);
  if (dist(beforeAt, at) > POSE_JUMP_LIMIT) return here;

  // Point into the change, blended across the tick like everything else.
  const yaw = lerp(laneChangeYaw(v.prev.lateralRate, v.prev.v), laneChangeYaw(v.lateralRate, v.v), t);

  return {
    p: lerpVec(beforeAt, at, t),
    angle: lerpAngle(angleOf(before.t), heading, t) + yaw,
  };
}

function bodyFrame(w: SimWorld, kinematics: Kinematics, behindFront: number): Frame | null {
  let lane = w.lanelet(kinematics.lanelet);
  if (!lane) return null;
  let s = kinematics.s - behindFront;
  if (s >= 0) return lane.centre.sampleAt(s);
  for (const id of kinematics.rearPath) {
    lane = w.lanelet(id);
    if (!lane) return null;
    s += lane.length;
    if (s >= 0) return lane.centre.sampleAt(s);
  }
  return null;
}

/** Interpolates two headings the short way round. */
function lerpAngle(from: number, to: number, t: number): number {
  let delta = (to - from) % (2 * Math.PI);
  if (delta > Math.PI) delta -= 2 * Math.PI;
  if (delta < -Math.PI) delta += 2 * Math.PI;
  return from + delta * t;
}

/**
 * Pose of a pedestrian, interpolated between the last two steps in WORLD
 * space.
 *
 * It used to be rebuilt from the edge and arc position each frame, which made
 * every change of footway edge a hard cut to the new edge's centreline frame,
 * and read the heading from the path tangent plus the tick-to-tick sideways
 * step — 42,885 heading snaps of more than 8.6 degrees in one tick in two
 * minutes on the saved player map, and a visible pop at every corner. The
 * simulation now owns a world position and a heading turned at a human rate
 * (`settlePose`), and this only blends them.
 */
export function pedPose(w: SimWorld, p: Ped, alpha: number): Pose | null {
  if (!w.sidewalks.edges.has(p.edge)) return null;
  const t = clamp(alpha, 0, 1);
  const now = { x: p.x, y: p.y };
  const before = { x: p.prev.x, y: p.prev.y };
  if (dist(before, now) > POSE_JUMP_LIMIT) return { p: now, angle: p.heading };
  return { p: lerpVec(before, now, t), angle: lerpAngle(p.prev.heading, p.heading, t) };
}
