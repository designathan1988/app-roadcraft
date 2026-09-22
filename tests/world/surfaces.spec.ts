import { describe, expect, it } from 'vitest';

import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { bands, surfaces } from '@world/surfaces';
import { Level, ROAD_TYPES, casingHalf, halfWidth, roadProfile, travelLanes } from '@world/roadTypes';
import { ROAD_STRUCTURES, isRaised, isRoadStructure, roadStructure } from '@world/structures';
import type { MultiPoly } from '@core/clipper';

function area(polygons: MultiPoly): number {
  let total = 0;
  for (const polygon of polygons) {
    polygon.forEach((ring, index) => {
      let sum = 0;
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i] as readonly number[];
        const b = ring[(i + 1) % ring.length] as readonly number[];
        sum += (a[0] as number) * (b[1] as number) - (b[0] as number) * (a[1] as number);
      }
      total += index === 0 ? Math.abs(sum) / 2 : -Math.abs(sum) / 2;
    });
  }
  return total;
}

function cross(): Network {
  const doc = new RoadDoc();
  const centre = doc.addNode({ x: 0, y: 0 });
  const north = doc.addNode({ x: 0, y: -260 });
  const south = doc.addNode({ x: 0, y: 260 });
  const west = doc.addNode({ x: -260, y: 0 });
  const east = doc.addNode({ x: 260, y: 0 });
  doc.addSegment(north.id, centre.id, 3);
  doc.addSegment(centre.id, south.id, 3);
  doc.addSegment(west.id, centre.id, 2);
  doc.addSegment(centre.id, east.id, 2);
  const net = new Network(doc);
  net.rebuild();
  return net;
}

describe('road classes', () => {
  it('nest strictly from casing inwards', () => {
    for (const type of ROAD_TYPES) {
      expect(halfWidth(type, Level.Casing)).toBeGreaterThan(halfWidth(type, Level.Sidewalk));
      expect(halfWidth(type, Level.Sidewalk)).toBeGreaterThan(halfWidth(type, Level.Curb));
      expect(halfWidth(type, Level.Curb)).toBeGreaterThan(halfWidth(type, Level.Asphalt));
    }
  });

  it('grow monotonically with the class index', () => {
    for (let i = 1; i < ROAD_TYPES.length; i++) {
      expect(casingHalf(ROAD_TYPES[i]!)).toBeGreaterThan(casingHalf(ROAD_TYPES[i - 1]!));
    }
  });

  it('describe an overridden profile with a key, never a sentence', () => {
    const wide = roadProfile(1, 6, 'both');
    expect(wide.lanes).toBe(6);
    expect(wide.subKey).toMatch(/^road\.sub\.custom\./);
    expect(wide.subLanes).toBe(6);
    expect(wide.subOneWay).toBe(false);
    expect(ROAD_TYPES[1]!.subLanes).toBeNull();
  });

  it('splits a two-way lane count evenly', () => {
    const road = roadProfile(2, 6, 'both');
    expect(travelLanes(road, 'both')).toBe(3);
  });
});

describe('structures', () => {
  it('order by clearance, with the ground at zero', () => {
    expect(roadStructure('ground').clearance).toBe(0);
    expect(roadStructure('bridge').clearance).toBeGreaterThan(0);
    expect(roadStructure('tunnel').clearance).toBeLessThan(0);
  });

  it('classify raised structures', () => {
    expect(ROAD_STRUCTURES.filter((s) => isRaised(s.id)).map((s) => s.id)).toEqual([
      'elevated',
      'viaduct',
      'bridge',
    ]);
  });

  it('validate ids', () => {
    expect(isRoadStructure('viaduct')).toBe(true);
    expect(isRoadStructure('flyover')).toBe(false);
  });

  it('carry a translation key rather than a name', () => {
    for (const spec of ROAD_STRUCTURES) expect(spec.key).toMatch(/^structure\./);
  });
});

describe('surface bands', () => {
  const net = cross();
  const layer = surfaces(net);
  const band = bands(layer);

  it('nest: each level is contained in the one outside it', () => {
    expect(area(layer.casing)).toBeGreaterThan(area(layer.sidewalk));
    expect(area(layer.sidewalk)).toBeGreaterThan(area(layer.curb));
    expect(area(layer.curb)).toBeGreaterThan(area(layer.asphalt));
  });

  it('partition the casing exactly, with no overlap and no gap', () => {
    const total =
      area(band.casing) + area(band.footway) + area(band.kerb) + area(band.carriageway);
    // Clipper works on a fixed-point grid, so the sum agrees to its rounding
    // and no closer. A relative tolerance is the honest bound; an absolute one
    // would simply encode the size of this fixture.
    expect(Math.abs(total - area(layer.casing)) / area(layer.casing)).toBeLessThan(1e-5);
  });

  it('produce one connected carriageway for a connected network', () => {
    expect(band.carriageway.length).toBe(1);
  });

  it('builds a ribbon for every segment and a junction at the crossing', () => {
    expect(net.ribbons.size).toBe(4);
    expect(net.junctionNodes()).toHaveLength(1);
  });
});
