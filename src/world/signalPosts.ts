import { addScaled, angleOf, perp } from '@core/vec2';
import { crosswalkDistance } from './approach';
import type { LaneletGraph } from './lanelets';
import type { Network } from './network';
import type { NodeId, SegmentId } from './ids';
import { roadProfile } from './roadTypes';
import { m } from './units';

/**
 * Where the traffic signal posts stand: one per approach of a signalised
 * junction, on the kerb side, two metres back from the zebra.
 *
 * ONE definition, read by the renderer that draws the posts
 * (`render/signals.ts`) and by the pedestrians who must walk round them
 * (`sim/peds/clearance.ts`). The position used to be worked out only in the
 * renderer, so the simulation never knew the posts were there: people queued
 * for the crossing standing inside them, exactly where the post is, and
 * walked through them along the footway.
 */

/** Clearance from the carriageway edge to the post's centre line. */
export const SIGNAL_POST_KERB = m(0.9);
/** Radius of the post as the pedestrians see it: the drawn pole, 0.165 m. */
export const SIGNAL_POST_RADIUS = m(0.17);

export interface SignalPost {
  readonly node: NodeId;
  readonly segment: SegmentId;
  readonly x: number;
  readonly y: number;
  /** Heading the arm points in, over the road (world angle). */
  readonly yaw: number;
}

/** The post of one approach, or null if the segment is gone. */
export function signalPostPlace(net: Network, node: NodeId, segmentId: SegmentId): SignalPost | null {
  const segment = net.doc.segment(segmentId);
  if (!segment) return null;
  const road = roadProfile(segment.type, segment.lanes, segment.direction, segment.section);
  const mouth = net.mouthDistance(segmentId, node);
  const polyline = net.polylines.get(net.doc, segmentId);
  // Sample outward from the node to find the kerb position, then reverse
  // that tangent: traffic on this approach travels TOWARD the node.
  const outward = segment.a === node ? polyline : polyline.reversed();
  const distance = Math.min(crosswalkDistance(mouth) + m(2), outward.length * 0.45);
  const frame = outward.sampleAt(distance);
  const travel = { x: -frame.t.x, y: -frame.t.y };
  const left = perp(travel);
  const right = { x: -left.x, y: -left.y };
  const position = addScaled(frame.p, right, road.width / 2 + SIGNAL_POST_KERB);
  return { node, segment: segmentId, x: position.x, y: position.y, yaw: angleOf({ x: -right.x, y: -right.y }) };
}

/** Every signal post on the map, in a deterministic order. */
export function signalPosts(net: Network, graph: LaneletGraph): SignalPost[] {
  const out: SignalPost[] = [];
  const nodes = [...graph.junctions.keys()].sort((a, b) => a - b);
  for (const node of nodes) {
    const junction = graph.junctions.get(node);
    if (!junction?.signalised) continue;
    const record = net.doc.node(node);
    if (!record) continue;
    for (const segmentId of record.incident) {
      if (!junction.groups.some((group) => group.segments.includes(segmentId))) continue;
      const post = signalPostPlace(net, node, segmentId);
      if (post) out.push(post);
    }
  }
  return out;
}
