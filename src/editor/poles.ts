import { normalizeAngle } from '@core/scalar';
import { type Vec2, addScaled, angleOf, dist, fromAngle, sub } from '@core/vec2';
import type { PoleId } from '@world/ids';
import type { RoadDoc } from '@world/doc';
import type { Network } from '@world/network';
import { DEFAULT_POLE_SPACING, poleCarriesLamp, polePositions } from '@world/utilities';
import type { UtilityPole } from '@world/utilities';

/**
 * Where a pole may be put, and what it will attach to.
 *
 * The pole tool used to have none of this. It took the two raw ends of a drag,
 * dropped poles along the straight line between them and strung wire. Nothing
 * snapped, so a run beside a street was beside it only as accurately as the
 * hand that drew it; a run meant to continue an existing line joined it only
 * if a pole happened to land within the pick radius; and the angles had none
 * of the discipline the road tool enforces on itself.
 *
 * This file is the missing half. It answers one question — "if the run ended
 * here, where would it actually go?" — and both the preview and the commit ask
 * it, so what is drawn under the pointer is what is built on release. That is
 * the whole reason it lives in `editor` rather than in `main.ts`: a preview
 * that is computed separately from the commit is a preview that eventually
 * disagrees with it.
 */

/** Pick radius for an existing pole, in screen pixels. */
export const POLE_PICK_PIXELS = 34;

/**
 * How far from the furniture line a point may be and still be pulled onto it,
 * as a fraction of the footway width.
 *
 * Generous, because the footway is a narrow target in an isometric view and
 * the alternative — a pole a metre into the carriageway or a metre into the
 * grass — is exactly what the player complained about.
 */
const FOOTWAY_CATCH = 1.6;

/**
 * Where a pole stands across the footway, as a fraction of its width out from
 * the kerb.
 *
 * The same furniture line the lamp columns and bins use in
 * `render/scenery.ts`: poles, lamps and bins all belong on one line, out of
 * the walking width, and a pole placed anywhere else reads as dropped rather
 * than installed.
 */
const FURNITURE_FRACTION = 0.55;

/** Angular snap cone for a free run, in radians. */
const CONE = (7.5 * Math.PI) / 180;

export type PoleSnapKind = 'pole' | 'footway' | 'free';

export interface PoleSnap {
  readonly at: Vec2;
  readonly kind: PoleSnapKind;
  /** The existing pole this snapped onto, when `kind` is `pole`. */
  readonly pole?: PoleId;
  /**
   * Direction of the footway the point was pulled onto, when `kind` is
   * `footway`. A run along a street should follow the street.
   */
  readonly along?: Vec2;
}

export interface PlannedPole {
  readonly at: Vec2;
  /** The pole already standing here, which the run will reuse. */
  readonly existing: PoleId | null;
  readonly lamp: boolean;
}

export interface PoleRunPlan {
  readonly from: PoleSnap;
  readonly to: PoleSnap;
  readonly poles: readonly PlannedPole[];
}

/**
 * Snaps one end of a pole run.
 *
 * The order is the same as the road tool's, and for the same reason: an
 * EXISTING pole wins outright, because joining a line is the commonest thing
 * anyone does and a run that misses by two units builds a second mast beside
 * the first instead of a span between them. Failing that, the footway of the
 * nearest road, which is where poles actually go. Failing that, open ground,
 * which is legal — a line has to be able to cross a field.
 */
export function snapPole(doc: RoadDoc, net: Network, at: Vec2, reach: number): PoleSnap {
  const hit = doc.poleNear(at, reach);
  if (hit) return { at: { x: hit.x, y: hit.y }, kind: 'pole', pole: hit.id };

  const footway = nearestFootway(net, at);
  if (footway) return footway;

  return { at: { x: at.x, y: at.y }, kind: 'free' };
}

/**
 * The point on the furniture line of the nearest road, if the raw point is
 * close enough to it to have meant it.
 *
 * Searched over the ribbons rather than over the document's segments so the
 * line follows the road's real geometry — its curve, and the offset its own
 * class gives it — instead of the straight line between its two nodes.
 */
function nearestFootway(net: Network, at: Vec2): PoleSnap | null {
  let best: PoleSnap | null = null;
  let bestDistance = Infinity;

  for (const ribbon of net.ribbons.values()) {
    const road = ribbon.road;
    const out = road.width / 2 + road.sidewalk * FURNITURE_FRACTION;
    const catchRadius = road.sidewalk * FOOTWAY_CATCH;

    const box = ribbon.full.bbox;
    const reach = out + catchRadius;
    if (
      at.x < box.minX - reach ||
      at.x > box.maxX + reach ||
      at.y < box.minY - reach ||
      at.y > box.maxY + reach
    ) {
      continue;
    }

    const hit = ribbon.full.closestPoint(at);
    const frame = ribbon.full.sampleAt(hit.s);
    // Which side of the road the pointer is on. The normal is the left one, so
    // a positive projection is the left footway.
    const side = (at.x - frame.p.x) * frame.n.x + (at.y - frame.p.y) * frame.n.y >= 0 ? 1 : -1;
    const on = addScaled(frame.p, frame.n, out * side);
    const offset = Math.abs(hit.distance - out);
    if (offset > catchRadius || offset >= bestDistance) continue;

    bestDistance = offset;
    best = { at: on, kind: 'footway', along: { x: frame.t.x, y: frame.t.y } };
  }

  return best;
}

/**
 * The heading a free run is allowed to take.
 *
 * The same 15-degree discipline the road tool applies, plus the direction of
 * whatever the start snapped to. A line leaving a footway should run along
 * that footway, and a line leaving a pole should be able to continue straight
 * on, because those are the two shapes a real distribution line has.
 */
function snapHeading(from: PoleSnap, heading: number): number {
  const candidates: number[] = [];

  if (from.along) {
    const along = angleOf(from.along);
    candidates.push(along, along + Math.PI);
  }
  for (let i = 0; i < 24; i++) candidates.push((i * Math.PI) / 12);

  let angle = heading;
  let bestDiff = CONE;
  for (const candidate of candidates) {
    const diff = Math.abs(normalizeAngle(candidate - heading));
    if (diff < bestDiff) {
      bestDiff = diff;
      angle = candidate;
    }
  }
  return angle;
}

/**
 * Everything the run WOULD build, from the two raw ends of the gesture.
 *
 * Called by the preview on every pointer move and by the commit once, so the
 * two cannot disagree. Nothing here mutates the document.
 */
export function planPoleRun(
  doc: RoadDoc,
  net: Network,
  rawFrom: Vec2,
  rawTo: Vec2,
  reach: number,
  spacing = DEFAULT_POLE_SPACING,
): PoleRunPlan {
  const from = snapPole(doc, net, rawFrom, reach);

  let to = snapPole(doc, net, rawTo, reach);
  if (to.kind === 'free') {
    // Open ground takes the angle snap. A run landing on a pole or on a
    // footway does not: it has already been told exactly where to end, and
    // bending it to the nearest 15 degrees would pull it back off again.
    const raw = sub(to.at, from.at);
    const length = Math.hypot(raw.x, raw.y);
    if (length > 0) {
      const angle = snapHeading(from, angleOf(raw));
      to = { at: addScaled(from.at, fromAngle(angle), length), kind: 'free' };
    }
  }

  const positions = polePositions(from.at, to.at, spacing);
  const poles: PlannedPole[] = positions.map((at, index) => {
    const existing = existingAt(doc, at, from, to, reach);
    return {
      at: existing ? { x: existing.x, y: existing.y } : at,
      existing: existing?.id ?? null,
      // A pole that already exists keeps the lamp it already has; only the
      // new ones take the every-other-one rule, and they take it from their
      // position in this run.
      lamp: existing ? existing.lamp : poleCarriesLamp(index),
    };
  });

  return { from, to, poles };
}

/**
 * The pole an interior position of the run should reuse, if any.
 *
 * The ends are handled by the snap and are authoritative — an end that snapped
 * onto a pole must reuse THAT pole, whatever else is nearby. Interior
 * positions look around themselves, which is what lets a new run cross an old
 * one and tie into it instead of building a second mast alongside.
 */
function existingAt(
  doc: RoadDoc,
  at: Vec2,
  from: PoleSnap,
  to: PoleSnap,
  reach: number,
): UtilityPole | null {
  for (const end of [from, to]) {
    if (end.pole === undefined) continue;
    if (dist(at, end.at) > 1e-6) continue;
    return doc.pole(end.pole) ?? null;
  }
  return doc.poleNear(at, reach);
}

/**
 * Applies a plan to the document. Returns whether anything was built.
 *
 * Separated from `planPoleRun` so that the preview can never mutate, and so
 * that a test can assert on the plan without a document to write into.
 */
export function commitPoleRun(doc: RoadDoc, plan: PoleRunPlan): boolean {
  if (plan.poles.length < 2) return false;

  const ids: PoleId[] = plan.poles.map(
    (pole) => pole.existing ?? doc.addPole(pole.at, pole.lamp).id,
  );

  let built = false;
  for (let i = 1; i < ids.length; i++) {
    const a = ids[i - 1];
    const b = ids[i];
    if (a === undefined || b === undefined) continue;
    if (doc.addPoleSpan(a, b)) built = true;
  }
  return built;
}
