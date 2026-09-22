import { DIV_EPS, clamp } from '@core/scalar';
import { type Vec2, addScaled, angleOf, lerpVec, perp } from '@core/vec2';
import type { SimWorld } from '@sim/world';
import type { Vehicle } from '@sim/vehicles/state';
import type { Ped } from '@sim/peds/state';

export interface Pose {
  readonly p: Vec2;
  readonly angle: number;
}

/**
 * Pose of a vehicle, interpolated between the last two simulation steps.
 *
 * When the vehicle changed lanelet between the two snapshots there is no
 * meaningful world-space interpolation, so the current pose is used directly —
 * lerping between two disconnected positions would cut corners visibly.
 */
export function vehiclePose(w: SimWorld, v: Vehicle, alpha: number): Pose | null {
  const lane = w.lanelet(v.lanelet);
  if (!lane) return null;
  const frame = lane.centre.sampleAt(v.s);
  const here: Pose = { p: frame.p, angle: angleOf(frame.t) };

  if (v.prev.lanelet !== v.lanelet) return here;
  const prevLane = w.lanelet(v.prev.lanelet);
  if (!prevLane) return here;
  const before = prevLane.centre.sampleAt(v.prev.s);

  return {
    p: lerpVec(before.p, frame.p, clamp(alpha, 0, 1)),
    angle: angleOf(frame.t),
  };
}

/**
 * Largest angle a sidestep may turn a pedestrian by.
 *
 * Heading comes from the ratio of sideways to forward movement, which goes to a
 * right angle as forward movement goes to zero — so somebody shifting their
 * weight at a kerb would face across the footway. The cap, and the forward term
 * below it, are what keep a step aside a step aside.
 */
const MAX_SIDESTEP = 0.42;

export function pedPose(w: SimWorld, p: Ped, alpha: number): Pose | null {
  const edge = w.sidewalks.edges.get(p.edge);
  if (!edge) return null;
  const path = w.sidewalks.orientedPath(edge, p.entry);
  const frame = path.sampleAt(p.s);
  const t = clamp(alpha, 0, 1);

  // People do not walk on a centreline. The offset is the simulation's, held
  // and steered there; this only projects it, so a step aside is continuous
  // here because it was continuous where it was decided.
  const at = addScaled(frame.p, perp(frame.t), p.lat);

  if (p.prev.edge !== p.edge) return { p: at, angle: angleOf(frame.t) };

  const before = path.sampleAt(p.prev.s);
  const forward = p.s - p.prev.s;
  const sideways = p.lat - p.prev.lat;
  const turn =
    forward > DIV_EPS ? clamp(Math.atan2(sideways, forward), -MAX_SIDESTEP, MAX_SIDESTEP) : 0;

  return {
    p: lerpVec(addScaled(before.p, perp(frame.t), p.prev.lat), at, t),
    angle: angleOf(frame.t) + turn,
  };
}
