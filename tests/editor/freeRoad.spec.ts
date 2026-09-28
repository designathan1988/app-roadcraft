import { describe, expect, it } from 'vitest';

import { controlPoint } from '@core/bezier';
import { RoadDoc } from '@world/doc';
import { buildRoadElevation } from '@world/elevation';
import { Level } from '@world/roadTypes';
import { surfaceMode } from '@world/junction/build';
import { Network } from '@world/network';
import { commitRoadPath } from '@editor/commit';
import { restoreInto } from '@editor/history';
import { roadPathFromGesture, type RoadPathPoint } from '@editor/roadPath';

const point = (x: number, y: number, heightOffset = 0): RoadPathPoint =>
  ({ at: { x, y }, heightOffset });

function empty(): { doc: RoadDoc; net: Network } {
  const doc = new RoadDoc();
  const net = new Network(doc);
  net.rebuild();
  return { doc, net };
}

describe('free road gesture', () => {
  it('closes a loop back onto its own start', () => {
    const { doc, net } = empty();
    const start = point(-100, 0);
    const pieces = roadPathFromGesture([
      point(-50, -100), point(50, -100), point(100, 0),
      point(50, 100), point(-50, 100),
    ], start, start);
    expect(pieces.length).toBeGreaterThan(2);
    expect(commitRoadPath(doc, net, { kind: 'free', at: start.at },
      { kind: 'free', at: start.at }, 1, pieces).committed).toBe(true);
    expect([...doc.nodes.values()].every((node) => node.incident.length === 2)).toBe(true);
  });

  it('turns a bent stroke into continuous quadratic pieces without junctions at its controls', () => {
    const { doc, net } = empty();
    const start = point(-180, 0);
    const end = point(180, 0);
    const pieces = roadPathFromGesture([
      point(-130, -55), point(-70, -90), point(0, -95),
      point(70, -65), point(130, -15),
    ], start, end);
    expect(pieces.length).toBeGreaterThan(1);
    expect(commitRoadPath(doc, net, { kind: 'free', at: start.at },
      { kind: 'free', at: end.at }, 1, pieces).committed).toBe(true);
    expect(doc.segments.size).toBe(pieces.length);
    for (const node of doc.nodes.values()) {
      if (!node.smooth) continue;
      expect(node.incident).toHaveLength(2);
      const mode = surfaceMode(doc, net.polylines, node.id);
      if (mode === 'junction') {
        expect(net.junctions.get(node.id)?.get(Level.Asphalt)?.transition).toBe(true);
      }
    }
    for (let i = 1; i < pieces.length; i++) {
      const before = pieces[i - 1]!;
      const after = pieces[i]!;
      const cb = controlPoint(before.start.at, before.end.at, before.curve!);
      const ca = controlPoint(after.start.at, after.end.at, after.curve!);
      const endTangent = { x: before.end.at.x - cb.x, y: before.end.at.y - cb.y };
      const startTangent = { x: ca.x - after.start.at.x, y: ca.y - after.start.at.y };
      const cross = endTangent.x * startTangent.y - endTangent.y * startTangent.x;
      expect(Math.abs(cross)).toBeLessThan(1e-5);
    }
  });

  it('keeps a road over another road disconnected and joins a crossing at the same height', () => {
    const { doc, net } = empty();
    const west = doc.addNode({ x: -180, y: 0 }, 25);
    const east = doc.addNode({ x: 180, y: 0 }, 25);
    doc.addSegment(west.id, east.id, 1);
    net.rebuild();
    const lowStart = point(0, -180);
    const lowEnd = point(0, 180);
    const low = roadPathFromGesture([], lowStart, lowEnd);
    expect(commitRoadPath(doc, net, { kind: 'free', at: lowStart.at },
      { kind: 'free', at: lowEnd.at }, 1, low).committed).toBe(true);
    expect(doc.segments.size).toBe(2);
    expect([...doc.nodes.values()].some((node) => Math.hypot(node.x, node.y) < 1)).toBe(false);

    const sameStart = point(-120, -180, 25);
    const sameEnd = point(-120, 180, 25);
    const same = roadPathFromGesture([], sameStart, sameEnd);
    expect(commitRoadPath(doc, net, { kind: 'free', at: sameStart.at },
      { kind: 'free', at: sameEnd.at }, 1, same).committed).toBe(true);
    expect([...doc.nodes.values()].some((node) => Math.abs(node.x + 120) < 1 && Math.abs(node.y) < 1)).toBe(true);
  });

  it('does not reconnect a grade-separated endpoint while restoring a saved map', () => {
    const { doc } = empty();
    const west = doc.addNode({ x: -180, y: 0 });
    const east = doc.addNode({ x: 180, y: 0 });
    const north = doc.addNode({ x: 0, y: -150 }, 25);
    const above = doc.addNode({ x: 0, y: 0 }, 25);
    doc.addSegment(west.id, east.id, 1);
    doc.addSegment(north.id, above.id, 1);
    const restored = empty();
    restoreInto(restored.doc, doc.toJSON(), restored.net);
    expect(restored.doc.segments.size).toBe(2);
    expect(restored.doc.nodes.size).toBe(4);
  });

  it('carries authored height through the span and preserves separate same-position nodes on save', () => {
    const { doc, net } = empty();
    const a = doc.addNode({ x: -180, y: 0 }, 25);
    const b = doc.addNode({ x: 180, y: 0 }, 25);
    const segment = doc.addSegment(a.id, b.id, 1)!;
    doc.addNode({ x: 0, y: 0 }, 0);
    doc.addNode({ x: 0, y: 0 }, 25);
    net.rebuild();
    const field = buildRoadElevation(net, () => 0);
    expect(field.onSegment(segment.id, 0, 0)).toBeGreaterThan(20);
    const restored = RoadDoc.fromJSON(doc.toJSON());
    expect([...restored.nodes.values()].filter((node) => node.x === 0 && node.y === 0)).toHaveLength(2);
    expect(restored.node(a.id)?.heightOffset).toBe(25);
  });

  it('builds an access ramp as a one-way road with the same continuous elevation controls', () => {
    const { doc, net } = empty();
    const start = point(-160, 0);
    const end = point(160, 0, 12.5);
    const result = commitRoadPath(doc, net, { kind: 'free', at: start.at },
      { kind: 'free', at: end.at }, 5, roadPathFromGesture([], start, end));
    expect(result.committed).toBe(true);
    expect([...doc.segments.values()][0]?.direction).toBe('aToB');
    expect([...doc.nodes.values()].some((node) => node.heightOffset > 0)).toBe(true);
  });

  it('keeps adjoining grade and raised pieces at the same node height', () => {
    const { doc, net } = empty();
    const a = doc.addNode({ x: -300, y: 0 });
    const b = doc.addNode({ x: 0, y: 0 }, 20);
    const c = doc.addNode({ x: 300, y: 0 }, 20);
    const first = doc.addSegment(a.id, b.id, 1)!;
    const second = doc.addSegment(b.id, c.id, 1)!;
    net.rebuild();
    const elevation = buildRoadElevation(net, () => 0);
    expect(elevation.onSegment(first.id, 0, 0)).toBeCloseTo(elevation.nodeHeight(b.id), 6);
    expect(elevation.onSegment(second.id, 0, 0)).toBeCloseTo(elevation.nodeHeight(b.id), 6);
    for (let x = -295; x < -5; x += 5) {
      const grade = Math.abs(elevation.onSegment(first.id, x + 5, 0) -
        elevation.onSegment(first.id, x, 0)) / 5;
      expect(grade).toBeLessThan(0.17);
    }
  });
});
