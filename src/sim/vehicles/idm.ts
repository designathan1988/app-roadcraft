import { clamp } from '@core/scalar';
import { m } from '@world/units';
import type { DriverParams } from './driver';

/**
 * Anything a vehicle must not run into: a leader, a red signal, a held
 * conflict point, a pedestrian in the crossing, a full lane ahead, the end of a
 * route.
 *
 * The unification is the point. The V6 monolith had six serial boolean gates
 * where the first `false` won regardless of severity, and no later gate could
 * soften an earlier one (defect 2). Here every restriction is the same shape,
 * they are combined with `min`, and `min` is commutative — so the order in
 * which stages contribute constraints cannot change the outcome.
 */
export interface Obstacle {
  /** Bumper-to-bumper distance ahead. May be clamped to a small positive. */
  readonly gap: number;
  /** Speed of the obstacle; zero for anything stationary. */
  readonly speed: number;
  readonly kind: ObstacleKind;
  /** Excluded from the hard safe-speed cap when false. */
  readonly hard?: boolean;
}

export type ObstacleKind =
  | 'vehicle'
  | 'signal'
  | 'conflict'
  | 'pedestrian'
  | 'spillback'
  | 'yield'
  | 'endOfRoute'
  | 'curvature'
  | 'kerbStop';

export interface ConstraintSet {
  obstacles: Obstacle[];
}

export const emptyConstraints = (): ConstraintSet => ({ obstacles: [] });

/** Follower speed by which the queue-release response has faded out, world units a second. */
const RELEASE_FADE = m(4);
const smooth = (x: number): number => {
  const t = clamp(x, 0, 1);
  return t * t * (3 - 2 * t);
};

/**
 * Intelligent Driver Model acceleration for one obstacle.
 */
export function idmAccel(p: DriverParams, v: number, v0: number, o: Obstacle): number {
  const dv = v - o.speed;
  // A stopped queue needs a small release response once its direct leader is
  // moving. Keeping the full standstill target here makes each driver wait for
  // the preceding car to open several extra metres, which turns a green into
  // one vehicle every four or five seconds. `safeSpeed` still uses the full
  // `s0`, so this only improves the start wave and never reduces clearance.
  //
  // ONLY while starting off. The test used to be "the leader is moving and I
  // am not much faster", which is also every car following another at a
  // steady speed: the whole fleet cruised at 0.4 of its own headway, measured
  // at a median of 0.6 s bumper to bumper where urban drivers keep 1.2 to 2 s.
  // The release now fades out as the follower gets going, and is gone by
  // `RELEASE_FADE`, a little over a walking-pace crawl.
  const releasing = o.kind === 'vehicle' && o.speed > 0.25 && v < o.speed + 2
    ? 1 - smooth(v / RELEASE_FADE)
    : 0;
  const standstill = p.s0 * (1 - 0.6 * releasing);
  const headway = p.T * (1 - 0.6 * releasing);
  const sStar = standstill + Math.max(0, v * headway + (v * dv) / (2 * Math.sqrt(p.a * p.b)));
  const s = Math.max(o.gap, 0.05);
  return p.a * (1 - Math.pow(v / Math.max(v0, 0.01), 4) - (sStar / s) ** 2);
}

/**
 * Highest speed from which this vehicle can still stop short of the obstacle,
 * allowing for one reaction step and for the obstacle braking at its own rate.
 *
 * IDM alone is collision-free only in the continuous limit. This Gipps-style
 * cap is what makes the discrete step safe, and it is what replaces the V6
 * monolith's `enforceVehicleSeparation`, which repaired overlaps AFTER
 * integration by teleporting followers backwards (defect 5.5).
 */
export function safeSpeed(p: DriverParams, o: Obstacle, dt: number): number {
  const b = p.bEmergency;
  const leadStopping = o.speed > 0 ? (o.speed * o.speed) / (2 * b) : 0;
  const room = Math.max(0, o.gap - p.s0 + leadStopping);
  return Math.max(0, -b * dt + Math.sqrt(b * b * dt * dt + 2 * b * room));
}

/**
 * Resolves every constraint into the next speed.
 *
 * Comfort comes from IDM; safety comes from the cap. Overlap is prevented
 * BEFORE it happens rather than repaired afterwards.
 */
export function resolveSpeed(
  p: DriverParams,
  v: number,
  v0: number,
  obstacles: readonly Obstacle[],
  dt: number,
): number {
  let a = p.a * (1 - Math.pow(v / Math.max(v0, 0.01), 4));
  let cap = v0;

  for (const o of obstacles) {
    a = Math.min(a, idmAccel(p, v, v0, o));
    if (o.hard !== false) cap = Math.min(cap, safeSpeed(p, o, dt));
  }

  a = clamp(a, -p.bEmergency, p.a);
  return clamp(v + a * dt, 0, Math.max(0, cap));
}

/** True when the vehicle can still stop before `d` without harsh braking. */
export const canStopComfortably = (p: DriverParams, v: number, d: number): boolean =>
  (v * v) / (2 * p.b) <= d;
