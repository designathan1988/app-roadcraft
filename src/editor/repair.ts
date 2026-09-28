import type { RoadDoc } from '@world/doc';
import type { NodeId, SegmentId } from '@world/ids';
import type { Network } from '@world/network';
import { casingHalf, roadProfile } from '@world/roadTypes';
import { roadStructure } from '@world/structures';
import { splitSegment } from './commit';

interface Candidate {
  readonly node: NodeId;
  readonly segment: SegmentId;
  readonly s: number;
  readonly at: { readonly x: number; readonly y: number };
  readonly distance: number;
}

/**
 * Repairs a legacy endpoint that visibly ends inside another road but was saved
 * as a disconnected node.  Only degree-one endpoints and roads on the same
 * structure are considered, so an overpass is never turned into a junction.
 */
export function repairNearConnections(doc: RoadDoc, net: Network): number {
  let repaired = 0;
  const rejected = new Set<string>();

  // Every split changes segment ids and cached polylines. Rebuild after one
  // repair and search again from authoritative geometry.
  for (let attempt = 0; attempt < 64; attempt++) {
    net.rebuild();
    const candidate = nearestCandidate(doc, net, rejected);
    if (!candidate) break;
    const junction = splitSegment(doc, net, candidate.segment, candidate.s, candidate.at);
    if (junction === null || !doc.mergeNodes(junction, candidate.node)) {
      rejected.add(`${candidate.node}:${candidate.segment}`);
      continue;
    }
    repaired++;
  }
  if (repaired) net.rebuild();
  return repaired;
}

function nearestCandidate(doc: RoadDoc, net: Network, rejected: ReadonlySet<string>): Candidate | null {
  let best: Candidate | null = null;
  for (const node of doc.nodes.values()) {
    if (node.incident.length !== 1) continue;
    const sourceId = node.incident[0];
    if (sourceId === undefined) continue;
    const source = doc.segment(sourceId);
    if (!source) continue;

    for (const [targetId, target] of doc.segments) {
      if (targetId === sourceId || target.a === node.id || target.b === node.id) continue;
      if (target.structure !== source.structure) continue;
      if (rejected.has(`${node.id}:${targetId}`)) continue;
      const line = net.polylines.get(doc, targetId);
      const hit = line.closestPoint({ x: node.x, y: node.y });
      const t = hit.s / Math.max(1e-6, line.length);
      const targetOffset = (doc.node(target.a)?.heightOffset ?? 0) * (1 - t) +
        (doc.node(target.b)?.heightOffset ?? 0) * t +
        roadStructure(target.structure).clearance;
      const sourceOffset = node.heightOffset + roadStructure(source.structure).clearance;
      if (Math.abs(sourceOffset - targetOffset) > 0.75) continue;
      const reach = casingHalf(roadProfile(target.type, target.lanes, target.direction));
      if (hit.distance > reach || (best && hit.distance >= best.distance)) continue;
      best = { node: node.id, segment: targetId, s: hit.s, at: hit.point, distance: hit.distance };
    }
  }
  return best;
}

