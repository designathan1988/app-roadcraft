import { describe, expect, it } from 'vitest';

import { controlPoint } from '@core/bezier';
import { RoadDoc } from '@world/doc';
import { buildRoadElevation } from '@world/elevation';
import { Level } from '@world/roadTypes';
import { surfaceMode } from '@world/junction/build';
import { Network } from '@world/network';
import { roadStructure } from '@world/structures';
import { commitRoadPath, splitSegment } from '@editor/commit';
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
  it('joins a road at its height, passes over it with clearance, and refuses anything between', () => {
    const across = (height: number) => {
      const { doc, net } = empty();
      const a = doc.addNode({ x: 0, y: -150 }), b = doc.addNode({ x: 0, y: 150 });
      doc.addSegment(a.id, b.id, 1);
      net.rebuild();
      const start = point(-200, 0, height), end = point(200, 0, height);
      const result = commitRoadPath(doc, net, { kind: 'free', at: start.at }, { kind: 'free', at: end.at }, 1,
        [{ start, end, curve: null }]);
      return { result, junction: [...doc.nodes.values()].some((node) => node.incident.length === 4) };
    };
    expect(across(0)).toMatchObject({ result: { committed: true }, junction: true });
    expect(across(5).result).toMatchObject({ committed: false, reason: 'clearance' });
    expect(across(roadStructure('elevated').clearance + 5)).toMatchObject({ result: { committed: true }, junction: false });
  });

  it('raises the road mid-drag without leaving a gap or a stub', () => {
    // Page Up pressed with the pointer still: samples at almost one place
    // with rising heights, then the stroke goes on. It was committed with a
    // gap where the heights changed.
    const { doc, net } = empty();
    const start = point(0, 0), end = point(300, 0, 15);
    const samples = [point(40, 0), point(80, 0), point(82, 0, 2.5), point(83, 0, 5), point(84, 0, 7.5),
      point(130, 0, 7.5), point(180, 0, 10), point(230, 0, 12.5), point(270, 0, 15)];
    const pieces = roadPathFromGesture(samples, start, end);
    for (const piece of pieces) expect(Math.hypot(piece.end.at.x - piece.start.at.x, piece.end.at.y - piece.start.at.y)).toBeGreaterThan(9);
    expect(commitRoadPath(doc, net, { kind: 'free', at: start.at }, { kind: 'free', at: end.at }, 1, pieces).committed).toBe(true);
    // One continuous road: two ends, every other node joins two pieces.
    const degrees = [...doc.nodes.values()].map((node) => node.incident.length).sort();
    expect(degrees.filter((d) => d === 1)).toHaveLength(2);
    expect(degrees.every((d) => d === 1 || d === 2)).toBe(true);
  });

  it('folds a piece too short to be a road into the next one', () => {
    const { doc, net } = empty();
    const a = point(0, 0), b = point(60, 0, 5), c = point(64, 0, 6), d = point(140, 0, 10);
    const pieces = [{ start: a, end: b, curve: null }, { start: b, end: c, curve: null }, { start: c, end: d, curve: null }];
    expect(commitRoadPath(doc, net, { kind: 'free', at: a.at }, { kind: 'free', at: d.at }, 1, pieces).committed).toBe(true);
    expect(doc.segments.size).toBe(2);
    const degrees = [...doc.nodes.values()].map((node) => node.incident.length).sort();
    expect(degrees).toEqual([1, 1, 2]);
  });

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

  it('keeps an inserted height point editable and continuous after save and load', () => {
    const { doc, net } = empty();
    const west = doc.addNode({ x: -400, y: 0 });
    const east = doc.addNode({ x: 400, y: 0 });
    const segment = doc.addSegment(west.id, east.id, 1)!;
    net.rebuild();
    const middle = splitSegment(doc, net, segment.id, 400, { x: 0, y: 0 });
    expect(middle).not.toBeNull();
    doc.requireNode(middle!).smooth = true;
    doc.setNodeHeightOffset(middle!, 25);
    net.rebuild();

    const elevation = buildRoadElevation(net, () => 0);
    const left = [...doc.segments.values()].find((piece) => piece.b === middle);
    const right = [...doc.segments.values()].find((piece) => piece.a === middle);
    expect(left).toBeDefined();
    expect(right).toBeDefined();
    expect(elevation.onSegment(left!.id, 0, 0)).toBeCloseTo(elevation.onSegment(right!.id, 0, 0), 5);
    expect(elevation.onSegment(left!.id, 0, 0)).toBeGreaterThan(elevation.onSegment(left!.id, -100, 0));
    expect(elevation.onSegment(right!.id, 0, 0)).toBeGreaterThan(elevation.onSegment(right!.id, 100, 0));

    const restored = RoadDoc.fromJSON(doc.toJSON());
    expect(restored.node(middle!)?.smooth).toBe(true);
    expect(restored.node(middle!)?.heightOffset).toBe(25);
    expect(restored.segments.size).toBe(2);
  });
});

describe('a road laid over a mountain', () => {
  const over = (peak: number) => {
    const { doc, net } = empty();
    // One stroke per 40 units of height, a 300-wide brush.
    for (let k = 0; k < peak / 40; k++) doc.addTerrainStamp({ x: 0, y: 0, radius: 300, strength: 40, mode: 'raise', stroke: k + 1 });
    net.rebuild();
    const start = point(-450, 0), end = point(450, 0);
    expect(commitRoadPath(doc, net, { kind: 'free', at: start.at }, { kind: 'free', at: end.at }, 1, [{ start, end, curve: null }]).committed).toBe(true);
    return [...doc.segments.values()].map((seg) => seg.structure);
  };

  it('is bored as a tunnel where a cutting would be deeper than eighteen metres', () => {
    // Held to its grade, the road ran 80 m under the summit of a 240-unit
    // mountain in a slot cut to its own width, and vanished into it.
    expect(over(240)).toContain('tunnel');
  });

  it('stays an open road over a hill a cutting can take', () => {
    expect(over(40)).not.toContain('tunnel');
  });
});

