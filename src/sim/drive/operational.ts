import { clamp } from '@core/scalar';
import { m } from '@world/units';
import type { DriverParams } from '../vehicles/driver';
import type { Obstacle } from '../vehicles/idm';

/**
 * DRIVE v2, OPERATIONAL: how hard to press the pedals this tick.
 *
 * The legacy model took the Intelligent Driver Model's acceleration against
 * every obstacle. IDM brakes as if the gap were an emergency whenever it is
 * shorter than the one it wants, even while the car ahead is pulling away:
 * after a merge or a lane change put a car 2 m ahead doing 7.6 m/s, a
 * follower doing 5.4 m/s braked at 6 m/s² - measured, 1 110 of the 1 176
 * hard brakes in 90 s of the saved map. That is the lurch a player sees.
 *
 * Here each obstacle is met with the Adaptive Cruise Control model (Treiber &
 * Kesting): the Improved IDM, blended with the Constant-Acceleration
 * Heuristic, which asks what braking the situation really needs if the car
 * ahead keeps doing what it is doing. A closing gap is still braked for
 * firmly; one that is already opening is not. The acceleration then changes
 * no faster than a driver's foot moves (jerk limits), and the Gipps safe
 * speed remains the floor that no comfort rule can override: the car can
 * always stop short of whatever is ahead, braking at its emergency rate.
 */

/** IDM acceleration exponent. */
const DELTA = 4;
/** Share of the heuristic in the blend (Treiber & Kesting use 0.99). */
const COOLNESS = 0.99;
/** Fastest a driver's acceleration rises (easing on), and falls (braking harder), u/s³. */
const JERK_UP = m(2.5);
const JERK_DOWN = m(8);
/**
 * Below this a driver lifts off at once. Held to the jerk limit, a car
 * creeping up to its standing gap kept accelerating a few ticks after the
 * model said to stop, met the safe-speed cap and was cut to zero - and then
 * crept again: a nudge-and-stop loop every 0.4 s, measured at a stop line.
 */
const CRAWL = m(1);

/** Improved IDM against one obstacle, and the free-road term. */
function iidm(p: DriverParams, v: number, v0: number, o: Obstacle | null): number {
  const v0s = Math.max(v0, 0.01);
  const free = v <= v0s
    ? p.a * (1 - Math.pow(v / v0s, DELTA))
    : -p.b * (1 - Math.pow(v0s / v, (p.a * DELTA) / p.b));
  if (!o) return free;
  const dv = v - o.speed;
  const sStar = p.s0 + Math.max(0, v * p.T + (v * dv) / (2 * Math.sqrt(p.a * p.b)));
  const z = sStar / Math.max(o.gap, 0.05);
  if (v <= v0s) return z >= 1 ? p.a * (1 - z * z) : free * (1 - Math.pow(z, (2 * p.a) / Math.max(free, 1e-6)));
  return z >= 1 ? free + p.a * (1 - z * z) : free;
}

/** The Constant-Acceleration Heuristic: braking needed if the obstacle keeps its acceleration. */
function cah(p: DriverParams, v: number, o: Obstacle): number {
  // What the car ahead is doing, as a driver can read it: never harder than
  // an emergency stop. Read raw, a leader cut to a stop by the safe-speed cap
  // passed a 60 m/s² "braking" down the queue behind it.
  const al = clamp(o.accel ?? 0, -p.bEmergency, p.a);
  const vl = o.speed;
  const s = Math.max(o.gap, 0.05);
  if (vl * (v - vl) <= -2 * s * al) return (v * v * al) / Math.max(vl * vl - 2 * s * al, 1e-6);
  const closing = Math.max(0, v - vl);
  return al - (closing * closing) / (2 * s);
}

/** Adaptive Cruise Control acceleration against one obstacle. */
export function accAccel(p: DriverParams, v: number, v0: number, o: Obstacle): number {
  const aIidm = iidm(p, v, v0, o);
  const aCah = cah(p, v, o);
  if (aIidm >= aCah) return aIidm;
  return (1 - COOLNESS) * aIidm + COOLNESS * (aCah + p.b * Math.tanh((aIidm - aCah) / p.b));
}

/**
 * The next speed and the acceleration that produced it.
 *
 * `lastAccel` is what the driver did last tick: the new acceleration moves
 * from it at a driver's pace, braking harder faster than easing on. The safe
 * physical controller applies the collision-free stopping cap separately.
 */
export function nextSpeed(p: DriverParams, v: number, v0: number, lastAccel: number,
  obstacles: readonly Obstacle[], dt: number): { v: number; a: number } {
  let target = iidm(p, v, v0, null);
  // Above the wanted speed (a slower stretch just entered, a turn), it is
  // shed at a comfortable deceleration, never in one tick as a hard cap at
  // the wanted speed did; what is physically ahead is the hard cap.
  const cap = Math.max(v0, v - p.b * dt);
  for (const o of obstacles) {
    target = Math.min(target, accAccel(p, v, v0, o));
  }
  target = clamp(target, -p.bEmergency, p.a);
  // From what the driver's foot was doing, which is never harder than an
  // emergency stop: a speed the safe-speed cap cut last tick is not a pedal
  // position, and starting the jerk window there kept a car braking at
  // 60 m/s² for a second after one sudden obstacle.
  const foot = clamp(lastAccel, -p.bEmergency, p.a);
  // Easing on, and ordinary braking, change at a driver's pace; braking
  // beyond comfortable is not held back: a jerk limit there only delayed
  // the response and then needed harder braking later.
  const a = target < -p.b || (v < CRAWL && target < foot) ? Math.min(target, foot + JERK_UP * dt)
    : clamp(target, foot - JERK_DOWN * dt, foot + JERK_UP * dt);
  const next = clamp(v + a * dt, 0, Math.max(0, cap));
  return { v: next, a: (next - v) / dt };
}
