import { describe, expect, it } from 'vitest';

import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { Level, halfWidth } from '@world/roadTypes';
import { junctionDetail, transitionMarkings } from '@world/markings';
import { LaneletGraph } from '@world/lanelets';
import { TAPER_RATIO, widthStep } from '@world/junction/transition';
import { levelPolygons } from '@world/surfaces';
import { pointInPolygon } from '@core/polygon';

/**
 * A road that simply carries on at another width: the urban street running
 * into a boulevard or an avenue that the player photographed as a boxy plate
 * with notched kerbs and a zebra and a stop line on both legs.
 */
function join(from: number, to: number, bendDegrees = 0) {
  const doc = new RoadDoc();
  const west = doc.addNode({ x: -500, y: 0 });
  const middle = doc.addNode({ x: 0, y: 0 });
  const t = (bendDegrees * Math.PI) / 180;
  const east = doc.addNode({ x: Math.cos(t) * 500, y: Math.sin(t) * 500 });
  const street = doc.addSegment(west.id, middle.id, from)!;
  const wide = doc.addSegment(middle.id, east.id, to)!;
  const net = new Network(doc);
  net.rebuild();
  return { doc, net, node: middle.id, street: street.id, wide: wide.id };
}

describe('a road carrying on at another width', () => {
  it('is a taper, not a junction: no zebra, no stop line, lanes run to the mouth', () => {
    for (const [to, bend] of [[2, 0], [3, 0], [2, 10], [3, 10]] as const) {
      const { net, node, street, wide } = join(1, to, bend);
      expect(net.transitions.has(node)).toBe(true);
      expect(net.continues(node)).toBe(true);
      for (const segment of [street, wide]) {
        expect(net.crosswalkDistanceAt(segment, node)).toBe(0);
        expect(net.stopLineDistance(segment, node)).toBeCloseTo(net.mouthDistance(segment, node), 9);
      }
      const detail = junctionDetail(net);
      expect(detail.zebras).toHaveLength(0);
      expect(detail.stops).toHaveLength(0);
    }
  });

  it('widens smoothly, over a length set by how far the kerb moves', () => {
    const { net, node, street, wide } = join(1, 3);
    const junction = net.junctions.get(node)!.get(Level.Asphalt)!;
    // One outline, no carriageway rectangles run back to the node: the tongue
    // of the wide leg is what made the width step at the node.
    expect(junction.tongues).toHaveLength(0);
    expect(junction.rings).toHaveLength(1);
    const total = net.mouthDistance(street, node) + net.mouthDistance(wide, node);
    const road = (id: number) => junction.legs.find((leg) => leg.seg === id)!.road;
    expect(total).toBeCloseTo(widthStep(road(wide), road(street)) * TAPER_RATIO, 6);
    // The footway moves further than the kerb, and it sets the length.
    expect(widthStep(road(wide), road(street))).toBeCloseTo(
      halfWidth(road(wide), Level.Sidewalk) - halfWidth(road(street), Level.Sidewalk), 9);
    // The kerb line never turns more sharply than the smoothstep's peak.
    const ring = junction.ring.flatten();
    let steepest = 0;
    for (let i = 1; i < ring.length; i++) {
      const a = ring[i - 1]!;
      const b = ring[i]!;
      const along = Math.abs(b.x - a.x);
      if (along < 0.5) continue;
      steepest = Math.max(steepest, Math.abs(b.y - a.y) / along);
    }
    expect(steepest).toBeLessThan((1.5 / TAPER_RATIO) * 1.05);
  });

  it('keeps every surface level nested through the taper', () => {
    const { net } = join(1, 3);
    const casing = levelPolygons(net, Level.Casing);
    const asphalt = levelPolygons(net, Level.Asphalt);
    for (let x = -80; x <= 80; x += 4) {
      for (const y of [-20, -10, 0, 10, 20]) {
        const p = { x, y };
        const inAsphalt = asphalt.some((poly) => pointInPolygon(p, poly[0]!.map(([px, py]) => ({ x: px!, y: py! }))));
        if (!inAsphalt) continue;
        expect(casing.some((poly) => pointInPolygon(p, poly[0]!.map(([px, py]) => ({ x: px!, y: py! }))))).toBe(true);
      }
    }
  });

  it('paints its centre line and shared lanes straight through', () => {
    const { net, node } = join(2, 3);
    const strokes = transitionMarkings(net, node);
    // Two lines parting round the reservation, and the one lane divider per
    // direction the avenue and the boulevard share. (No painted edge lines:
    // the asphalt's concrete gutter marks the edge.)
    expect(strokes.length).toBe(4);
    for (const stroke of strokes) expect(stroke.points.length).toBeGreaterThan(8);
  });

  it('carries every lane on, and merges the one that ends', () => {
    const { doc, net, node, street, wide } = join(1, 3);
    const graph = new LaneletGraph();
    graph.build(doc, net);
    const into = [...graph.connectors.values()].filter((c) => c.node === node);
    // Street to boulevard: the street's lane carries on in the boulevard's inner lane.
    expect(into.some((c) => c.inSegment === street && c.outSegment === wide)).toBe(true);
    // Boulevard to street: both boulevard lanes have a way on.
    const lanes = [...graph.lanelets.values()].filter((l) => l.kind === 'link' && l.segment === wide && l.to === node);
    expect(lanes).toHaveLength(2);
    for (const lane of lanes) expect(graph.exitsOf(lane.id).length).toBeGreaterThan(0);
    // The links run right up to the taper: no approach zone left in front of it.
    const end = lanes[0]!.centre.sampleAt(lanes[0]!.length).p;
    expect(Math.hypot(end.x, end.y)).toBeLessThan(net.mouthDistance(wide, node) + 1);
  });

  it('keeps a corner a corner, zebras and all', () => {
    const { net, node } = join(1, 3, 60);
    expect(net.transitions.has(node)).toBe(false);
    expect(net.continues(node)).toBe(false);
    expect(junctionDetail(net).zebras.length).toBeGreaterThan(0);
  });
});
