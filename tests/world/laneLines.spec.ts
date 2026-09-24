import { describe, expect, it } from 'vitest';

import { RoadDoc, type SegmentDirection } from '@world/doc';
import { Network } from '@world/network';
import { segmentMarkings } from '@world/markings';
import { EDGE_LINE_DARK, EDGE_LINE_LIGHT, LANE_LINE, roadType } from '@world/roadTypes';

/**
 * YELLOW MEANS ONCOMING TRAFFIC.
 *
 * Every lane divider was painted in the class's centre-line colour, which for
 * streets is yellow, so a one-way street carried a yellow dashed line down its
 * middle - the marking that tells a driver the other lane comes towards them.
 * A line between two lanes running the same way is white.
 */

function paint(type: number, direction: SegmentDirection) {
  const doc = new RoadDoc();
  const a = doc.addNode({ x: -300, y: 0 });
  const b = doc.addNode({ x: 300, y: 0 });
  const segment = doc.addSegment(a.id, b.id, type, null, 0, direction)!;
  const net = new Network(doc);
  net.rebuild();
  const ribbon = net.ribbons.get(segment.id)!;
  return segmentMarkings(ribbon, 0).filter((s) => s.color !== EDGE_LINE_LIGHT && s.color !== EDGE_LINE_DARK);
}

describe('lane lines', () => {
  it('paints a one-way street white, with no centre line', () => {
    const yellow = roadType(1).line;
    const lines = paint(1, 'aToB');
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.every((s) => s.color === LANE_LINE)).toBe(true);
    expect(lines.some((s) => s.color === yellow)).toBe(false);
  });

  it('keeps the yellow centre line of a two-way street', () => {
    const lines = paint(1, 'both');
    expect(lines.map((s) => s.color)).toEqual([roadType(1).line]);
  });

  it('separates an avenue\'s directions in its class colour and its lanes in white', () => {
    const lines = paint(2, 'both');
    const centre = lines.filter((s) => s.dash === null);
    const dividers = lines.filter((s) => s.dash !== null);
    expect(centre.map((s) => s.color)).toEqual([roadType(2).line]);
    expect(dividers.length).toBe(2);
    expect(dividers.every((s) => s.color === LANE_LINE)).toBe(true);
  });
});
