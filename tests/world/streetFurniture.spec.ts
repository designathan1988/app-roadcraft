import { describe, expect, it } from 'vitest';

import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { Level, halfWidth } from '@world/roadTypes';
import { TREE_PIT, blocksPedestrians, streetFurniture } from '@world/streetFurniture';
import { roadProfile } from '@world/roadTypes';
import { sectionOf } from '@world/section';

/**
 * The street furniture layout is read by two layers - the renderer draws it and
 * the pedestrians walk around it - so its guarantees are stated here once:
 * deterministic, a street tree only where a footway can take one, and every
 * tree pit wholly on the footway it belongs to.
 */

function crossroads(): Network {
  const doc = new RoadDoc();
  const centre = doc.addNode({ x: 0, y: 0 });
  const north = doc.addNode({ x: 0, y: -520 });
  const south = doc.addNode({ x: 0, y: 520 });
  const west = doc.addNode({ x: -520, y: 0 });
  const east = doc.addNode({ x: 520, y: 0 });
  doc.addSegment(north.id, centre.id, 3);
  doc.addSegment(centre.id, south.id, 2);
  doc.addSegment(west.id, centre.id, 1);
  doc.addSegment(centre.id, east.id, 0);
  const net = new Network(doc);
  net.rebuild();
  return net;
}

describe('street furniture', () => {
  it('stands wholly in the furnishing zone beside the kerb: never in the through zone, never off the footway (P1-16)', () => {
    const net = crossroads();
    const items = streetFurniture(net).filter((item) => item.on === 'footway');
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      const seg = net.doc.requireSegment(item.segment);
      const zone = sectionOf(roadProfile(seg.type, seg.lanes, seg.direction), seg.direction).side.furnishing;
      const centre = net.ribbons.get(item.segment)!.full;
      const across = centre.distanceTo({ x: item.x, y: item.y });
      // Its footprint across the road: a bench's half depth, anything else's radius.
      const half = item.halfWidth ?? item.radius;
      expect(across - half, `${item.kind} on segment ${item.segment}`).toBeGreaterThanOrEqual(zone.inner - 1e-6);
      expect(across + half, `${item.kind} on segment ${item.segment}`).toBeLessThanOrEqual(zone.outer + 1e-6);
    }
  });

  it('is the same list on every call', () => {
    const net = crossroads();
    expect(streetFurniture(net)).toEqual(streetFurniture(net));
  });

  it('plants street trees only on footways wide enough to keep a walking width', () => {
    const net = crossroads();
    const items = streetFurniture(net);
    const trees = items.filter((item) => item.kind === 'streetTree');
    expect(trees.length).toBeGreaterThan(0);
    for (const tree of trees) {
      const road = net.ribbons.get(tree.segment)?.road;
      expect(road).toBeDefined();
      expect(road?.sidewalk ?? 0).toBeGreaterThanOrEqual(6);
    }
  });

  it('keeps every tree pit between the kerb and the back of the footway', () => {
    const net = crossroads();
    for (const tree of streetFurniture(net).filter((item) => item.kind === 'streetTree')) {
      const ribbon = net.ribbons.get(tree.segment);
      if (!ribbon) throw new Error('tree on a missing segment');
      const across = ribbon.full.closestPoint(tree).distance;
      expect(across - TREE_PIT / 2).toBeGreaterThanOrEqual(halfWidth(ribbon.road, Level.Curb) - 1e-6);
      expect(across + TREE_PIT / 2).toBeLessThanOrEqual(halfWidth(ribbon.road, Level.Sidewalk) + 1e-6);
    }
  });

  it('puts shrubs down a planted median and nowhere else, out of the pedestrians’ way', () => {
    const net = crossroads();
    const shrubs = streetFurniture(net).filter((item) => item.kind === 'medianShrub');
    expect(shrubs.length).toBeGreaterThan(0);
    for (const shrub of shrubs) {
      expect(net.ribbons.get(shrub.segment)?.road.median ?? 0).toBeGreaterThan(0);
      expect(blocksPedestrians(shrub)).toBe(false);
    }
  });

  it('gives every item a finite position and a unit outward normal', () => {
    for (const item of streetFurniture(crossroads())) {
      expect(Number.isFinite(item.x) && Number.isFinite(item.y)).toBe(true);
      expect(Math.hypot(item.outward.x, item.outward.y)).toBeCloseTo(1, 6);
      expect(item.seed).toBeGreaterThanOrEqual(0);
      expect(item.seed).toBeLessThan(1);
    }
  });
});
