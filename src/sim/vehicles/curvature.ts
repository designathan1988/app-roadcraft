import { m } from '@world/units';
import type { Lanelet } from '@world/lanelets';
import { HEAVY, bodyClassOf } from '@world/conflictPoints';
import { LATERAL_ACCEL_FALL, MAX_LATERAL_ACCEL, MIN_LATERAL_ACCEL } from '../params';
import type { SimWorld } from '../world';
import type { Vehicle } from './state';

/**
 * How fast a driver is willing to take the road ahead, from its curvature.
 *
 * Nothing used to slow a vehicle for a bend. Turns through a junction took a
 * fixed share of the limit (`turnSpeedFactor`), and a curved road took none
 * at all: measured on a single bend of an urban street, vehicles pulled up to
 * 10 m/s² sideways, and on the saved player map 1 % of all vehicle samples
 * exceeded 1 g. The cap here is the one a driver actually applies - a
 * lateral acceleration they are comfortable with, `v = sqrt(a / curvature)`
 * at every point ahead, reached by braking comfortably from where they are.
 *
 * Curvature is measured over a chord a few metres long rather than at a
 * single vertex, so the kink between two segments of a flattened polyline is
 * not mistaken for a hairpin. Each lanelet's profile is computed once and
 * cached against the lanelet object, so it is rebuilt exactly when the
 * topology is.
 */

/** Spacing of the curvature profile along a lanelet. */
const SAMPLE = m(2);
/** Half-length of the chord the curvature is measured over. */
const CHORD = m(3);
/** Share of the comfortable lateral acceleration a heavy vehicle uses. */
const HEAVY_SHARE = 0.7;
/** Spread of comfortable lateral acceleration across drivers, per unit of aggression. */
const AGGRESSION_SPREAD = 0.2;
/** Look-ahead beyond the braking distance, seconds of travel plus a margin. */
const LOOK_TIME = 1.5;
const LOOK_MARGIN = m(10);

const profiles = new WeakMap<Lanelet, Float32Array>();

/** Curvature, per world unit, at each `SAMPLE` along the lanelet. */
function profileOf(lane: Lanelet): Float32Array {
  const cached = profiles.get(lane);
  if (cached) return cached;
  const n = Math.max(1, Math.ceil(lane.length / SAMPLE) + 1);
  const out = new Float32Array(n);
  const h = Math.min(CHORD, lane.length / 2);
  if (h > 1e-3) {
    for (let i = 0; i < n; i++) {
      const s = Math.min(Math.max(i * SAMPLE, h), lane.length - h);
      const a = lane.centre.sampleAt(s - h).t;
      const b = lane.centre.sampleAt(s + h).t;
      out[i] = Math.abs(Math.atan2(a.x * b.y - a.y * b.x, a.x * b.x + a.y * b.y)) / (2 * h);
    }
  }
  profiles.set(lane, out);
  return out;
}

/** Share of the fleet-wide figure this driver accepts: personality and vehicle. */
function lateralShare(v: Vehicle): number {
  const heavy = bodyClassOf(v.archetype.length, v.archetype.width) === HEAVY;
  return (1 + AGGRESSION_SPREAD * v.driver.aggression) * (heavy ? HEAVY_SHARE : 1);
}

/**
 * The lateral acceleration this driver is comfortable with at `speed`, world
 * units per second squared. Higher at a crawl than at speed (see
 * `MAX_LATERAL_ACCEL`).
 */
export function comfortableLateral(v: Vehicle, speed = 0): number {
  return lateralShare(v) * Math.max(MIN_LATERAL_ACCEL, MAX_LATERAL_ACCEL - LATERAL_ACCEL_FALL * speed);
}

/**
 * Fastest speed at which a bend of curvature `k` is taken within the driver's
 * speed-dependent comfort: the root of `k v^2 = share * (a0 - c v)`, or of the
 * floor once the falling figure has reached it.
 */
function bendSpeed(share: number, k: number): number {
  const a0 = share * MAX_LATERAL_ACCEL;
  const c = share * LATERAL_ACCEL_FALL;
  const v = (-c + Math.sqrt(c * c + 4 * k * a0)) / (2 * k);
  const floor = Math.sqrt((share * MIN_LATERAL_ACCEL) / k);
  return Math.max(v, floor);
}

/**
 * The speed this vehicle takes the sharpest bend of a lanelet at, within its
 * comfort. `Infinity` for a straight one.
 */
export function slowestBend(v: Vehicle, lane: Lanelet): number {
  const share = lateralShare(v);
  let slowest = Infinity;
  for (const k of profileOf(lane)) {
    if (k < 1e-6) continue;
    slowest = Math.min(slowest, bendSpeed(share, k));
  }
  return slowest;
}

/**
 * Highest speed at which this vehicle can drive on now and still take every
 * bend within its look-ahead at a comfortable lateral acceleration, braking
 * no harder than its comfortable deceleration. `Infinity` on a straight road.
 */
export function curveSpeedCap(w: SimWorld, v: Vehicle): number {
  const share = lateralShare(v);
  const brake = Math.max(v.driver.b, 1e-3);
  const horizon = (v.v * v.v) / (2 * brake) + v.v * LOOK_TIME + LOOK_MARGIN;
  let cap = Infinity;

  // The body itself, from its middle to its front at distance 0, then ahead of
  // the front along the planned route. From the middle rather than the rear:
  // a driver unwinds the wheel and accelerates as the car straightens, not
  // once the rear bumper has left the curve - measured from the rear, a bus
  // held its lowest speed for twelve metres past the apex.
  let lane = w.lanelet(v.lanelet);
  let from = v.s - v.archetype.length / 2;
  let ahead = -v.s; // distance from the front to the start of `lane`
  let next = 0;
  while (lane && ahead < horizon) {
    const profile = profileOf(lane);
    const start = Math.max(0, Math.floor(Math.max(0, from) / SAMPLE));
    for (let i = start; i < profile.length; i++) {
      const s = i * SAMPLE;
      const d = Math.max(0, ahead + s);
      if (d > horizon) break;
      const k = profile[i]!;
      if (k < 1e-6) continue;
      const safe = bendSpeed(share, k);
      cap = Math.min(cap, Math.sqrt(safe * safe + 2 * brake * d));
    }
    ahead += lane.length;
    from = 0;
    // The route lists the current lanelet first.
    let id = v.route[++next];
    while (id === lane.id) id = v.route[++next];
    lane = id ? w.lanelet(id) : undefined;
  }
  return cap;
}
