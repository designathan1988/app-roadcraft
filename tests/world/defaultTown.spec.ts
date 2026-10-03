import { describe, expect, it } from 'vitest';
import { RoadDoc } from '@world/doc';
import { buildDefaultTown, townBlocks } from '@world/defaultTown';
import { footprintRects } from '@world/buildings/geometry';
import { structuralProblem, validateBuilding } from '@world/buildings/validate';
import { Network } from '@world/network';

import { MAX_TERRAIN_STAMPS, TERRAIN_MAX_HEIGHT, TERRAIN_MIN_HEIGHT, sampleTerrainHeight } from '@world/terrain';

/**
 * The town the game opens on: a planned street grid, commerce on the avenue,
 * residential blocks behind it, the works by the water - every building where
 * it may stand, nothing on a road or on a neighbour, and the land it sits on
 * inside what the terrain field allows.
 */
describe('the default town', () => {
  const doc = new RoadDoc();
  const count = buildDefaultTown(doc);
  const all = [...doc.buildings.all()];
  const boxes = all.map((b) => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const r of footprintRects(b)) for (const p of r) {
      x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y);
      x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y);
    }
    return { b, x0, y0, x1, y1 };
  });

  it('builds a whole town', () => {
    expect(count).toBeGreaterThan(150);
    expect(count).toBe(all.length);
    const fns = new Set(all.map((b) => b.function));
    // The avenue's commerce, the civic heart, the works and the houses: if a
    // district is missing, its own buildings say so.
    for (const fn of ['shop', 'bank', 'hotel', 'cityHall', 'church', 'factory', 'warehouse',
      'supermarket', 'school', 'house', 'townhouse', 'apartments', 'gasStation', 'park', 'square']) {
      expect(fns.has(fn as never), fn).toBe(true);
    }
  });

  it('leaves no block empty: every block the streets enclose is built on or laid out', () => {
    // A 4-unit grid over each block; what a footprint (built or open) does not
    // cover is the walks between buildings - never a whole empty plot. The
    // blocks between the grid and the works stood at 0% before they were
    // given their streets, the school block at 14%.
    for (const block of townBlocks()) {
      const { x0, y0, x1, y1 } = block.box;
      let inside = 0;
      let covered = 0;
      for (let x = x0 + 2; x < x1; x += 4) {
        for (let y = y0 + 2; y < y1; y += 4) {
          inside++;
          if (boxes.some((r) => x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1)) covered++;
        }
      }
      expect(covered / inside, block.name).toBeGreaterThan(0.75);
    }
  });

  it('puts nothing on a neighbour and nothing a building may not stand on', () => {
    for (const a of boxes) {
      expect(structuralProblem(a.b), String(a.b.function)).toBeNull();
      for (const c of boxes) {
        if (c === a) continue;
        // Footprints may TOUCH (terraces stand shoulder to shoulder) but not
        // share any real area.
        const overlapX = Math.min(a.x1, c.x1) - Math.max(a.x0, c.x0);
        const overlapY = Math.min(a.y1, c.y1) - Math.max(a.y0, c.y0);
        const shared = overlapX > 0.6 && overlapY > 0.6 ? overlapX * overlapY : 0;
        expect(shared, `${a.b.function} on ${c.b.function}`).toBe(0);
      }
    }
    const net = new Network(doc);
    net.rebuild();
    for (const a of boxes) expect(validateBuilding({ doc, net, groundAt: null }, a.b, a.b.id), String(a.b.function)).toBeNull();
  });

  it('lays one street network: every node reachable, and only the roads out end', () => {
    const degree = new Map<number, number>();
    for (const seg of doc.segments.values()) {
      degree.set(seg.a, (degree.get(seg.a) ?? 0) + 1);
      degree.set(seg.b, (degree.get(seg.b) ?? 0) + 1);
    }
    const ends = [];
    const seen = new Set<number>();
    const first = [...doc.nodes.keys()][0] as number;
    const stack = [first];
    while (stack.length) {
      const at = stack.pop() as number;
      if (seen.has(at)) continue;
      seen.add(at);
      for (const seg of doc.segments.values()) {
        if (seg.a === at) stack.push(seg.b);
        else if (seg.b === at) stack.push(seg.a);
      }
    }
    for (const [id, n] of doc.nodes) {
      if (seen.has(id) && (degree.get(id) ?? 0) === 1) ends.push([Math.round(n.x), Math.round(n.y)]);
    }
    expect(seen.size).toBe(doc.nodes.size);       // one connected town
    expect(ends.length).toBe(2);                  // the road in and the road out
  });

  it('keeps the land inside the field the brush can make', () => {
    expect(doc.terrainStamps.length).toBeLessThan(MAX_TERRAIN_STAMPS);
    let low = Infinity;
    let high = -Infinity;
    for (const [id, n] of doc.nodes) {
      void id;
      const h = sampleTerrainHeight(doc.terrainStamps, n.x, n.y);
      low = Math.min(low, h);
      high = Math.max(high, h);
    }
    expect(high).toBeLessThanOrEqual(TERRAIN_MAX_HEIGHT);
    expect(low).toBeGreaterThanOrEqual(TERRAIN_MIN_HEIGHT);
    // The relief the town was planned on is real: hundreds of units of range
    // across the map, not a garden terrace.
    let mapLow = Infinity;
    let mapHigh = -Infinity;
    for (let i = 0; i < 40; i++) {
      for (let j = 0; j < 40; j++) {
        const h = sampleTerrainHeight(doc.terrainStamps, -2_300 + i * 118, -2_300 + j * 118);
        mapLow = Math.min(mapLow, h);
        mapHigh = Math.max(mapHigh, h);
      }
    }
    expect(mapHigh - mapLow).toBeGreaterThan(300);
  });

});
