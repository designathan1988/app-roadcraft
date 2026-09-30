import { describe, expect, it } from 'vitest';

import { commitRoadPath, joinSegments, splitSegment } from '@editor/commit';
import { RoadDoc, movementKey } from '@world/doc';
import { Network } from '@world/network';
import type { NodeId, SegmentId } from '@world/ids';

/** A T: the stem meets the through road at `centre`. */
function tee(): { doc: RoadDoc; net: Network; centre: NodeId; west: SegmentId; east: SegmentId; stem: SegmentId } {
  const doc = new RoadDoc();
  const w = doc.addNode({ x: -200, y: 0 });
  const c = doc.addNode({ x: 0, y: 0 });
  const e = doc.addNode({ x: 200, y: 0 });
  const s = doc.addNode({ x: 0, y: -200 });
  const west = doc.addSegment(w.id, c.id, 1)!.id;
  const east = doc.addSegment(c.id, e.id, 1)!.id;
  const stem = doc.addSegment(s.id, c.id, 1)!.id;
  const net = new Network(doc);
  net.rebuild();
  return { doc, net, centre: c.id, west, east, stem };
}

const bansAt = (doc: RoadDoc, node: NodeId): string[] => doc.node(node)!.blockedMovements;

/**
 * A turn ban names segment ids. Splitting a road - which happens every time a
 * new road crosses it - replaced the ids and left the ban naming a segment
 * that no longer existed: the player's junction control silently stopped
 * applying.
 */
describe('turn bans', () => {
  it('follow the road when a leg is split', () => {
    const { doc, net, centre, west, stem } = tee();
    doc.setMovementBlocked(centre, stem, west, true);
    const line = net.polylines.get(doc, west);
    splitSegment(doc, net, west, line.length / 2, line.sampleAt(line.length / 2).p);
    net.rebuild();
    // The west leg at the junction is now the piece whose far end lies west.
    const westLeg = doc.node(centre)!.incident.find((id) => {
      const seg = doc.segment(id)!;
      return doc.node(seg.a === centre ? seg.b : seg.a)!.x < 0;
    })!;
    expect(westLeg).not.toBe(west);
    expect(bansAt(doc, centre)).toEqual([movementKey(stem, westLeg)]);
  });

  it('follow the road when two pieces are joined back', () => {
    const { doc, net, centre, west, stem } = tee();
    const line = net.polylines.get(doc, west);
    const mid = splitSegment(doc, net, west, line.length / 2, line.sampleAt(line.length / 2).p)!;
    net.rebuild();
    const westLeg = (): SegmentId => doc.node(centre)!.incident.find((id) => {
      const seg = doc.segment(id)!;
      return doc.node(seg.a === centre ? seg.b : seg.a)!.x < 0;
    })!;
    doc.setMovementBlocked(centre, stem, westLeg(), true);
    expect(joinSegments(doc, mid)).toBe(true);
    expect(bansAt(doc, centre)).toEqual([movementKey(stem, westLeg())]);
  });

  it('are dropped with the road they name', () => {
    const { doc, centre, west, stem } = tee();
    doc.setMovementBlocked(centre, stem, west, true);
    doc.removeSegment(west);
    expect(bansAt(doc, centre)).toEqual([]);
  });
});

describe('a road drawn into a junction', () => {
  it('leaves the live network answering crossings like a fresh one', () => {
    const { doc, net, centre } = tee();
    // Ask once, so the cache holds the answer for the old junction.
    for (const id of doc.node(centre)!.incident) net.crosswalkDistanceAt(id, centre);
    const start = { kind: 'node' as const, at: { x: 0, y: 0 }, node: centre };
    const end = { kind: 'free' as const, at: { x: 0, y: 260 } };
    const result = commitRoadPath(doc, net, start, end, 4, [{
      start: { at: start.at, heightOffset: 0 }, end: { at: end.at, heightOffset: 0 }, curve: null,
    }]);
    expect(result.committed).toBe(true);
    const fresh = new Network(doc);
    fresh.rebuild();
    for (const id of doc.node(centre)!.incident) {
      expect(net.crosswalkDistanceAt(id, centre), `segment ${id}`).toBe(fresh.crosswalkDistanceAt(id, centre));
    }
  });
});
