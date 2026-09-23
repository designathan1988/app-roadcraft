import type { SimWorld } from '@sim/world';
import type { Vehicle } from '@sim/vehicles/state';
import { DT } from '@sim/params';
import { m } from '@world/units';

/**
 * What a vehicle is signalling and how its wheels sit, read straight off the
 * simulation. The lamps and the steering are functions of the state the
 * simulation already keeps, so a paused frame shows the same lamps and wheels
 * every time it is drawn; only the wheels' rolling angle needs a running total
 * (`WheelOdometer`).
 */

/** +1 indicating left, -1 right, 0 none — in the vehicle's own frame. */
export type IndicatorSide = -1 | 0 | 1;

/** Offset of a lane change under which the manoeuvre is treated as finished. */
const LANE_CHANGE_DONE = 0.15;
/** A driver signals a turn this long, or this far, before the stop line. */
const TURN_SIGNAL_TIME = 4;
const TURN_SIGNAL_MIN = m(25);
/** And keeps signalling until this share of the turn is driven. */
const TURN_SIGNAL_UNTIL = 0.6;
/** Flash rate of an indicator, Hz, and the share of each flash that is lit. */
export const BLINK_HZ = 1.5;
const BLINK_DUTY = 0.55;
/** Largest front-wheel steering angle drawn, radians. */
export const MAX_STEER = 0.6;

/**
 * Which way a vehicle is signalling.
 *
 * The indicator used to be lit only DURING a lane change, from the leftover
 * offset of the slide - so drivers signalled after they had already started
 * moving across, and never at all for a turn at a junction, which is when a
 * real driver signals most. Three reasons now light it, first match wins:
 *
 *   1. a lane change under way: towards the lane being entered;
 *   2. a lane change wanted but not yet started (`desiredLane`): the driver
 *      is looking for a gap and signals while doing so;
 *   3. a left or right turn ahead at the next junction, from a few seconds
 *      before the stop line until most of the turn has been driven.
 */
export function indicatorSide(w: SimWorld, v: Vehicle): IndicatorSide {
  if (Math.abs(v.lateral) > LANE_CHANGE_DONE) return v.lateral > 0 ? -1 : 1;

  const here = w.lanelet(v.lanelet);
  if (!here) return 0;

  if (v.desiredLane && v.desiredLane !== v.lanelet) {
    const target = w.lanelet(v.desiredLane);
    if (target && here.kind === 'link') {
      const frame = here.centre.sampleAt(Math.min(Math.max(0, v.s), here.length));
      const hit = target.centre.closestPoint(frame.p);
      const at = target.centre.sampleAt(hit.s).p;
      const leftward = (at.x - frame.p.x) * -frame.t.y + (at.y - frame.p.y) * frame.t.x;
      if (Math.abs(leftward) > 1e-6) return leftward > 0 ? 1 : -1;
    }
  }

  if (here.kind === 'connector') {
    if (v.s / Math.max(here.length, 1e-6) < TURN_SIGNAL_UNTIL) return turnSide(here.turn);
    return 0;
  }

  const toLine = here.length - v.s;
  if (toLine > Math.max(TURN_SIGNAL_MIN, v.v * TURN_SIGNAL_TIME)) return 0;
  for (const id of v.route) {
    if (id === v.lanelet) continue;
    const next = w.lanelet(id);
    if (!next) break;
    if (next.kind === 'connector') return turnSide(next.turn);
    break;
  }
  return 0;
}

function turnSide(turn: string | undefined): IndicatorSide {
  if (turn === 'left' || turn === 'uturn') return 1;
  if (turn === 'right') return -1;
  return 0;
}

/**
 * Whether a flashing indicator is lit at this moment of the vehicle's life.
 *
 * Keyed on the vehicle's own age and a per-vehicle phase, so a queue of
 * turning cars does not flash in lockstep, and a frame drawn twice at the
 * same simulation time shows the same lamp.
 */
export function blinkOn(age: number, id: number): boolean {
  const phase = ((id * 0.618034) % 1 + age * BLINK_HZ) % 1;
  return phase < BLINK_DUTY;
}

/**
 * Front-wheel steering angle, radians, positive to the left.
 *
 * A bicycle model: the wheels point at `atan(wheelbase * curvature)`, where
 * the curvature is that of the path the vehicle is driving - the lanelet's
 * own bend under the front axle, plus the change in heading of a lane change
 * over the last step (`lateralSlope` is the tangent of that heading).
 */
export function steerAngle(w: SimWorld, v: Vehicle, wheelbase: number): number {
  const lane = w.lanelet(v.lanelet);
  if (!lane || wheelbase <= 0) return 0;
  const span = Math.min(m(2), lane.length / 2);
  const s = Math.min(Math.max(v.s, span), lane.length - span);
  let curvature = 0;
  if (span > 1e-3) {
    const a = lane.centre.sampleAt(s - span).t;
    const b = lane.centre.sampleAt(s + span).t;
    const turn = Math.atan2(a.x * b.y - a.y * b.x, a.x * b.x + a.y * b.y);
    curvature = turn / (2 * span);
  }
  const travelled = v.s - (v.prev.lanelet === v.lanelet ? v.prev.s : v.s);
  if (travelled > 1e-4) {
    curvature += (Math.atan(v.lateralSlope) - Math.atan(v.prev.lateralSlope)) / travelled;
  }
  const angle = Math.atan(wheelbase * curvature);
  return Math.max(-MAX_STEER, Math.min(MAX_STEER, angle));
}

/**
 * Distance each vehicle has driven, for the rolling angle of its wheels.
 *
 * The arc position restarts on every lanelet, so a spin derived from it would
 * snap the hub round at each junction and lane change. This keeps a running
 * total per vehicle instead, advanced by the change in arc position within a
 * lanelet and by one step of travel across a lanelet boundary. It is the only
 * state here, it lives only as long as the vehicle object does, and it is
 * purely cosmetic: nothing in the simulation reads it.
 */
export class WheelOdometer {
  private readonly seen = new WeakMap<Vehicle, { lanelet: string; s: number; total: number }>();

  /** Total distance driven so far, in world units. */
  advance(v: Vehicle): number {
    const last = this.seen.get(v);
    if (!last) {
      this.seen.set(v, { lanelet: v.lanelet, s: v.s, total: 0 });
      return 0;
    }
    const ds = last.lanelet === v.lanelet ? v.s - last.s : Math.max(0, v.v) * DT;
    last.total += Math.max(0, ds);
    last.lanelet = v.lanelet;
    last.s = v.s;
    return last.total;
  }
}
