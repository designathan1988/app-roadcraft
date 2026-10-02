import { shapeFromControl } from '@core/bezier';
import type { Vec2 } from '@core/vec2';
import { insideMap, MAP_MARGIN } from '@world/bounds';
import type { RoadDoc } from '@world/doc';
import type { NodeId, SegmentId } from '@world/ids';
import { Network } from '@world/network';
import { casingHalf, ROAD_TYPES, roadProfile } from '@world/roadTypes';

export const ROUNDABOUT_MIN_RADIUS = 80;
export const ROUNDABOUT_MAX_RADIUS = 320;
export const ROUNDABOUT_APPROACH_LENGTH = 100;

export type RoundaboutResult =
  | { readonly committed: true; readonly ring: readonly SegmentId[]; readonly entrances: readonly SegmentId[] }
  | { readonly committed: false; readonly reason: 'size' | 'bounds' | 'occupied' | 'geometry' };

/**
 * Places a single-lane roundabout on vacant ground. The four two-way arms are
 * ordinary roads: extend their outer nodes with the road tool to join the city.
 * The caller records history once, before this atomic command, like commitDraft.
 * A quadrant uses two tangent-continuous quadratic arcs, rather than straight
 * chords; the same stored curves feed road meshes, lanelets and driving.
 */
export function commitRoundabout(
  doc: RoadDoc,
  net: Network,
  centre: Vec2,
  radius = 100,
  type = 0,
): RoundaboutResult {
  if (!Number.isFinite(radius) || radius < ROUNDABOUT_MIN_RADIUS || radius > ROUNDABOUT_MAX_RADIUS ||
    !Number.isFinite(centre.x) || !Number.isFinite(centre.y) || !Number.isInteger(type) || !ROAD_TYPES[type]) {
    return { committed: false, reason: 'size' };
  }
  const reach = radius + ROUNDABOUT_APPROACH_LENGTH;
  if (!insideMap({ x: centre.x - reach, y: centre.y - reach }, MAP_MARGIN) ||
      !insideMap({ x: centre.x + reach, y: centre.y + reach }, MAP_MARGIN)) {
    return { committed: false, reason: 'bounds' };
  }
  // Refuse instead of silently burying existing roads or leaving unconnected
  // geometric crossings. Connecting existing junctions is a separate operation.
  const width = casingHalf(roadProfile(type, 2, 'both'));
  for (const segment of doc.segments.values()) {
    const otherWidth = casingHalf(roadProfile(segment.type, segment.lanes, segment.direction, segment.section));
    if (net.polylines.get(doc, segment.id).distanceTo(centre) < reach + width + otherWidth) {
      return { committed: false, reason: 'occupied' };
    }
  }

  const work = doc.clone();
  const nodes: NodeId[] = [];
  const ring: SegmentId[] = [];
  const entrances: SegmentId[] = [];
  const step = Math.PI / 4;
  const point = (angle: number, distance: number): Vec2 => ({
    x: centre.x + Math.cos(angle) * distance,
    y: centre.y + Math.sin(angle) * distance,
  });
  for (let i = 0; i < 8; i++) {
    const node = work.addNode(point(i * step, radius), 0, i % 2 !== 0);
    nodes.push(node.id);
    // `yield` on a node would stop the circulating stream as well. Priority
    // policy uses the tangent-continuous ring as the main road; incoming arms
    // yield through the existing connector right-of-way classification.
    if (i % 2 === 0) work.setNodeControl(node.id, 'priority');
  }
  for (let i = 0; i < 8; i++) {
    const a = work.requireNode(nodes[i]!);
    const b = work.requireNode(nodes[(i + 1) % 8]!);
    const control = point((i + 0.5) * step, radius / Math.cos(step / 2));
    const segment = work.addSegment(a.id, b.id, type, shapeFromControl(a, b, control),
      i * step * radius, 'aToB', 1);
    if (!segment) return { committed: false, reason: 'geometry' };
    ring.push(segment.id);
  }
  for (let i = 0; i < 8; i += 2) {
    const outer = work.addNode(point(i * step, reach));
    const segment = work.addSegment(outer.id, nodes[i]!, type, null, 0, 'both', 2);
    if (!segment) return { committed: false, reason: 'geometry' };
    entrances.push(segment.id);
  }
  const workNet = new Network(work);
  workNet.rebuild();
  if (nodes.some((id) => workNet.impossible.has(id))) return { committed: false, reason: 'geometry' };
  doc.replaceWith(work);
  net.adopt(workNet);
  return { committed: true, ring, entrances };
}
