import { normalizeAngle } from '@core/scalar';
import { type Vec2, addScaled, angleOf, dist, fromAngle, normalize, sub } from '@core/vec2';
import type { NodeId, SegmentId } from '@world/ids';
import type { RoadDoc } from '@world/doc';
import type { Network } from '@world/network';
import { orientedPolyline } from '@world/geometry';
import { casingHalf, roadProfile } from '@world/roadTypes';
import { segSeg } from '@core/intersect';
import { roadStructure } from '@world/structures';

export type AnchorKind = 'node' | 'segment' | 'free';

export interface Anchor {
  readonly kind: AnchorKind;
  readonly at: Vec2;
  readonly node?: NodeId;
  readonly segment?: SegmentId;
  /** Arc position along the segment, for `segment` anchors. */
  readonly s?: number;
}

export interface SnapResult {
  readonly at: Vec2;
  /** What produced the snap, for the on-screen guide label. */
  readonly guide: 'network' | 'continue' | 'perpendicular' | 'orthogonal' | 'angle' | null;
  readonly angleDeg: number;
  readonly length: number;
}

/** Angular snap cone, in radians. */
const CONE = (7.5 * Math.PI) / 180;
/** Length quantum, in world units. */
const LENGTH_STEP = 10;
const LENGTH_TOLERANCE = 4.2;

/**
 * Finds what the pointer is over: an existing node, a point on an existing
 * road, or open ground.
 *
 * Radii are divided by zoom so that pick tolerance is constant in screen
 * pixels, and node candidates are biased so a junction wins over attaching
 * mid-segment — the same behaviour the V6 monolith had, kept deliberately.
 */
export function findAnchor(
  doc: RoadDoc,
  net: Network,
  p: Vec2,
  zoom: number,
  exclude?: ReadonlySet<NodeId>,
  targetHeightOffset?: number,
): Anchor {
  const nodeRadius = 30 / zoom;
  let best: Anchor = { kind: 'free', at: p };
  let bestScore = Infinity;

  for (const node of doc.nodes.values()) {
    if (exclude?.has(node.id)) continue;
    if (targetHeightOffset !== undefined &&
      Math.abs(node.heightOffset - targetHeightOffset) > 0.75) continue;
    const d = dist(p, { x: node.x, y: node.y });
    if (d > nodeRadius) continue;
    if (d < bestScore) {
      bestScore = d;
      best = { kind: 'node', at: { x: node.x, y: node.y }, node: node.id };
    }
  }

  // A node inside its pick radius owns the gesture. Comparing its distance
  // with a segment distance was not enough: at a shared endpoint, subpixel
  // screen-to-world rounding can make the node a few millionths away while
  // the projected segment is exactly zero away. The segment then stole the
  // click and the Move tool panned the camera instead of moving the junction.
  if (best.kind === 'node') return best;

  for (const [id, seg] of doc.segments) {
    // A pointer visibly inside a road must be able to attach to that road even
    // when zoomed in.  A screen-only radius shrank below the physical casing at
    // high zoom, creating endpoints that overlapped the rendered road while
    // remaining topologically disconnected.
    const segRadius = Math.max(
      26 / zoom,
      casingHalf(roadProfile(seg.type, seg.lanes, seg.direction)),
    );
    const pl = net.polylines.get(doc, id);
    // Reject by bounding box first. `closestPoint` walks every flattened point
    // of the polyline, and this ran on EVERY segment of the map for every
    // pointer move — so simply sliding the mouse across a large map cost a full
    // sweep of its geometry, which is felt as lag long before anything is
    // clicked. A segment whose box is further than the snap radius cannot hold
    // the closest point, and the box test is four comparisons.
    const bb = pl.bbox;
    if (
      p.x < bb.minX - segRadius ||
      p.x > bb.maxX + segRadius ||
      p.y < bb.minY - segRadius ||
      p.y > bb.maxY + segRadius
    ) {
      continue;
    }
    const hit = pl.closestPoint(p);
    if (hit.distance > segRadius) continue;
    if (targetHeightOffset !== undefined) {
      const fraction = hit.s / Math.max(1e-6, pl.length);
      const a = doc.node(seg.a)?.heightOffset ?? 0;
      const b = doc.node(seg.b)?.heightOffset ?? 0;
      const height = a + (b - a) * fraction + roadStructure(seg.structure).clearance;
      if (Math.abs(height - targetHeightOffset) > 0.75) continue;
    }
    if (hit.distance < bestScore) {
      bestScore = hit.distance;
      best = { kind: 'segment', at: hit.point, segment: id, s: hit.s };
    }
    void seg;
  }

  return best;
}

/** Free road drawing follows the pointer exactly, snapping only to compatible networks. */
export function snapRoadEndpoint(
  doc: RoadDoc, net: Network, start: Anchor, raw: Vec2, zoom: number, heightOffset: number,
): SnapResult {
  const anchor = findAnchor(doc, net, raw, zoom, undefined, heightOffset);
  const at = anchor.at;
  const v = sub(at, start.at);
  return {
    at,
    guide: anchor.kind === 'free' ? null : 'network',
    angleDeg: (angleOf(v) * 180) / Math.PI,
    length: dist(start.at, at),
  };
}

/**
 * Snaps a draft endpoint.
 *
 * Network snapping wins outright. Otherwise the heading is pulled to a
 * candidate angle — continuing or crossing an incident road at the start
 * anchor, or a world orthogonal — and the length is quantized.
 *
 * Angular snapping is not decoration. Junction quality depends on legs meeting
 * at sane angles: a fork of a few degrees forces an enormous separation setback
 * and produces a gore no corner solver can trace cleanly.
 */
/**
 * The heading a drag is allowed to take, and why.
 *
 * ONE definition, because two callers need the same answer: a road drawn into
 * open ground and a road drawn onto another road. It used to exist only inline
 * in the first case, so landing on an existing road accepted any angle at all —
 * the very shape the editor otherwise refuses.
 */
function snapHeading(
  doc: RoadDoc,
  start: Anchor,
  heading: number,
  landing?: number,
): { angle: number; guide: SnapResult['guide'] } {
  const candidates: { angle: number; guide: SnapResult['guide'] }[] = [];

  if (start.node !== undefined) {
    const node = doc.node(start.node);
    for (const segId of node?.incident ?? []) {
      const seg = doc.segment(segId);
      if (!seg) continue;
      const pl = orientedPolyline(doc, seg, start.node);
      const look = Math.min(12, Math.max(1, pl.length * 0.2));
      const outgoing = angleOf(normalize(sub(pl.sampleAt(look).p, pl.point(0))));
      candidates.push({ angle: outgoing + Math.PI, guide: 'continue' });
      candidates.push({ angle: outgoing + Math.PI / 2, guide: 'perpendicular' });
      candidates.push({ angle: outgoing - Math.PI / 2, guide: 'perpendicular' });
    }
  }

  if (landing !== undefined) {
    // Landing on a road, the angles that matter are the ones to THAT road:
    // square to it first, then every 15 degrees from its own direction. The
    // world grid used to be offered here as well, and against any road not
    // itself on that grid it won - a street drawn square onto an avenue at 21
    // degrees was pulled to 105, and onto a bend to the world axis rather than
    // the bend's normal: the new road visibly swung off where it was drawn.
    candidates.push({ angle: landing + Math.PI / 2, guide: 'perpendicular' });
    candidates.push({ angle: landing - Math.PI / 2, guide: 'perpendicular' });
    for (let i = 0; i < 24; i++) {
      candidates.push({ angle: landing + (i * Math.PI) / 12, guide: 'angle' });
    }
  } else {
    // World orthogonals plus 45s, which is the grid most street layouts follow.
    for (let i = 0; i < 8; i++) {
      candidates.push({ angle: (i * Math.PI) / 4, guide: 'orthogonal' });
    }
    // And every 15 degrees, as a coarser fallback.
    for (let i = 0; i < 24; i++) {
      candidates.push({ angle: (i * Math.PI) / 12, guide: 'angle' });
    }
  }

  let angle = heading;
  let guide: SnapResult['guide'] = null;
  let bestDiff = CONE;

  for (const c of candidates) {
    const diff = Math.abs(normalizeAngle(c.angle - heading));
    if (diff < bestDiff) {
      bestDiff = diff;
      angle = c.angle;
      guide = c.guide;
    }
  }

  return { angle, guide };
}

/**
 * Where a ray from `from` along `dir` first crosses a polyline, or `null`.
 *
 * Used to land a snapped heading on the road being drawn onto: the angle is
 * decided first and the contact point follows from it, instead of the contact
 * point being taken and the angle left to chance.
 */
function rayHitsPolyline(
  from: Vec2,
  dir: Vec2,
  points: readonly Vec2[],
  reach: number,
): Vec2 | null {
  const to = addScaled(from, dir, reach);
  let best: Vec2 | null = null;
  let bestT = Infinity;
  for (let i = 1; i < points.length; i++) {
    const hit = segSeg(from, to, points[i - 1] as Vec2, points[i] as Vec2);
    if (!hit) continue;
    if (hit.t < bestT) {
      bestT = hit.t;
      best = hit.point;
    }
  }
  return best;
}

export function snapEndpoint(
  doc: RoadDoc,
  net: Network,
  start: Anchor,
  raw: Vec2,
  zoom: number,
): SnapResult {
  const network = findAnchor(doc, net, raw, zoom, undefined);

  // LANDING ON A NODE takes the node, exactly, and no angle can be negotiated:
  // the whole point is that the two roads share that one point.
  if (network.kind === 'node') {
    const v = sub(network.at, start.at);
    return {
      at: network.at,
      guide: 'network',
      angleDeg: (angleOf(v) * 180) / Math.PI,
      length: dist(start.at, network.at),
    };
  }

  // LANDING ON A ROAD used to do the same, and that is why a road drawn into
  // open ground obeyed the angle snap while a road drawn onto another one could
  // be laid at any angle at all: this early return skipped the whole snap.
  //
  // A segment is a LINE, not a point. So the heading is snapped first, exactly
  // as it would be in open ground, and the snapped ray is then intersected with
  // the road being landed on. The result still lands on the road — the join is
  // as solid as before — and it arrives at an angle the editor is willing to
  // build.
  if (network.kind === 'segment' && network.segment !== undefined) {
    const target = net.polylines.get(doc, network.segment);
    const points = target.toPoints();
    const reach = dist(start.at, raw) * 2 + 1;
    const heading = angleOf(sub(raw, start.at));
    // The target's direction where the new road meets it. Taken at the contact
    // first, then once more where the snapped ray actually lands, which on a
    // bend is a little further along.
    const contact = { s: 0, distance: 0 };
    const tangentAt = (p: Vec2): number => {
      target.closestInto(p.x, p.y, contact);
      return angleOf(target.sampleAt(contact.s).t);
    };
    let snapped = snapHeading(doc, start, heading, tangentAt(network.at));
    let hit = rayHitsPolyline(start.at, fromAngle(snapped.angle), points, reach);
    if (hit) {
      const again = snapHeading(doc, start, heading, tangentAt(hit));
      const second = rayHitsPolyline(start.at, fromAngle(again.angle), points, reach);
      if (second) {
        snapped = again;
        hit = second;
      }
    }
    // The snapped landing has to be NEAR WHERE THE POINTER IS, or it is not a
    // snap, it is a different road.
    //
    // A ray locked to an angle can cross the target far from the contact the
    // user aimed at — around a bend, or near a junction at the other end. Taken
    // blindly, that cuts the target there instead, and a cut a few units from
    // an existing node leaves a stub shorter than the road is wide. Measured
    // after the first version of this: a 10.51-unit segment between two
    // junctions each asking for about 25 units of setback, which is a link that
    // cannot give either of them room and degenerates into the pale slivers
    // that appeared fanning across the asphalt.
    //
    // The allowance is the anchor's own reach with a little margin, so the snap
    // still bends the last few pixels of a drag and never relocates it.
    const reachable = 40 / zoom;
    if (hit && dist(hit, network.at) <= reachable) {
      return {
        at: hit,
        guide: snapped.guide ?? 'network',
        angleDeg: (snapped.angle * 180) / Math.PI,
        length: dist(start.at, hit),
      };
    }
    // The snapped ray misses the road entirely — the pointer is beside it
    // rather than across it. Taking the raw contact keeps the connection the
    // user is clearly asking for; refusing it would just feel broken.
    const v = sub(network.at, start.at);
    return {
      at: network.at,
      guide: 'network',
      angleDeg: (angleOf(v) * 180) / Math.PI,
      length: dist(start.at, network.at),
    };
  }

  let length = dist(start.at, raw);
  const snapped = snapHeading(doc, start, angleOf(sub(raw, start.at)));
  const angle = snapped.angle;
  const guide = snapped.guide;

  const quantized = Math.round(length / LENGTH_STEP) * LENGTH_STEP;
  if (Math.abs(quantized - length) < LENGTH_TOLERANCE) length = quantized;

  return {
    at: addScaled(start.at, fromAngle(angle), length),
    guide,
    angleDeg: (angle * 180) / Math.PI,
    length,
  };
}
