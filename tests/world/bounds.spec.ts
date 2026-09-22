import { describe, expect, it } from 'vitest';

import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { MAP_HALF, MAP_MARGIN, clampToMap, insideMap } from '@world/bounds';
import { casingHalf, roadProfile } from '@world/roadTypes';

/**
 * NOTHING LEAVES THE MAP.
 *
 * The ground is a finite 4800-unit plate, and anything built past its rim
 * stands on nothing: a road hanging in the void, its footway with it, and the
 * lamps, bins and poles that hang off the road going too.
 *
 * The vegetation was contained already — it was scattered around the network
 * centre with no reference to the plate, and that was fixed when it was caught
 * planting trees off the end of the world. Everything the PLAYER authors was
 * not: a node could be dropped anywhere the camera could reach.
 *
 * The containment is in `RoadDoc`, at the two points a position enters the
 * document, because a node is what roads, junctions, footways, lanelets and
 * street furniture are all derived from. Holding the node holds all of them,
 * and no later pass has to remember to check.
 */

describe('the map edge', () => {
  it('holds a node inside the plate wherever it is asked for', () => {
    const doc = new RoadDoc();
    const far = doc.addNode({ x: MAP_HALF * 4, y: -MAP_HALF * 9 });

    expect(insideMap({ x: far.x, y: far.y })).toBe(true);
    expect(far.x).toBeCloseTo(MAP_HALF - MAP_MARGIN, 6);
    expect(far.y).toBeCloseTo(-MAP_HALF + MAP_MARGIN, 6);
  });

  it('leaves a node that is already on the map exactly where it was asked for', () => {
    const doc = new RoadDoc();
    const node = doc.addNode({ x: 123.5, y: -67.25 });
    expect(node.x).toBe(123.5);
    expect(node.y).toBe(-67.25);
  });

  it('holds a node being dragged off the edge', () => {
    const doc = new RoadDoc();
    const a = doc.addNode({ x: 0, y: 0 });
    const b = doc.addNode({ x: 300, y: 0 });
    doc.addSegment(a.id, b.id, 1);

    doc.moveNode(b.id, { x: MAP_HALF * 3, y: 0 });
    const moved = doc.node(b.id);
    expect(moved).toBeDefined();
    expect(insideMap({ x: moved!.x, y: moved!.y })).toBe(true);
  });

  it('holds a pole run that is drawn off the edge', () => {
    const doc = new RoadDoc();
    const pole = doc.addPole({ x: -MAP_HALF * 2, y: MAP_HALF * 2 });
    expect(insideMap({ x: pole.x, y: pole.y })).toBe(true);
  });

  it('keeps the whole WIDTH of a road on the plate, not only its centreline', () => {
    // A centreline exactly on the rim still puts half a carriageway, a footway
    // and a casing over the void. The margin exists for that, and this is the
    // test that says so with the real widths rather than with a guess.
    const doc = new RoadDoc();
    const widest = 3;
    const a = doc.addNode({ x: MAP_HALF * 2, y: -MAP_HALF * 2 });
    const b = doc.addNode({ x: MAP_HALF * 2, y: MAP_HALF * 2 });
    doc.addSegment(a.id, b.id, widest);

    const net = new Network(doc);
    net.rebuild();

    const half = casingHalf(roadProfile(widest, undefined, 'both'));
    expect(MAP_MARGIN).toBeGreaterThan(half);

    for (const ribbon of net.ribbons.values()) {
      const box = ribbon.full.bbox;
      const reach = casingHalf(ribbon.road);
      expect(box.minX - reach).toBeGreaterThanOrEqual(-MAP_HALF);
      expect(box.maxX + reach).toBeLessThanOrEqual(MAP_HALF);
      expect(box.minY - reach).toBeGreaterThanOrEqual(-MAP_HALF);
      expect(box.maxY + reach).toBeLessThanOrEqual(MAP_HALF);
    }
  });

  it('survives a round trip through the save format', () => {
    const doc = new RoadDoc();
    doc.addNode({ x: MAP_HALF * 5, y: 0 });
    doc.addPole({ x: 0, y: MAP_HALF * 5 });

    const restored = RoadDoc.fromJSON(doc.toJSON());
    for (const node of restored.nodes.values()) {
      expect(insideMap({ x: node.x, y: node.y })).toBe(true);
    }
    for (const pole of restored.poles.values()) {
      expect(insideMap({ x: pole.x, y: pole.y })).toBe(true);
    }
  });

  it('clamps to the nearest point rather than to a corner', () => {
    // A drag that runs off ONE edge should build up to that edge, keeping the
    // other coordinate. Clamping both would drag the road sideways.
    const at = clampToMap({ x: MAP_HALF * 3, y: 100 });
    expect(at.y).toBe(100);
    expect(at.x).toBe(MAP_HALF - MAP_MARGIN);
  });
});
