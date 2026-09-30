import { describe, expect, it } from 'vitest';
import { buildNavMesh, FOOTWAY, NAV_RADIUS } from '@world/nav/navmesh';
import { findPath } from '@world/nav/path';

// An L of footway 4 u wide: along x from 0 to 40, then up y from 0 to 40.
const L = [[[[0, 0], [40, 0], [40, 40], [36, 40], [36, 4], [0, 4], [0, 0]]]];

describe('navmesh paths', () => {
  it('walks an L with one corner, at the inner corner, a body radius clear of it', () => {
    const mesh = buildNavMesh({ layers: [L], crossingLayers: [], road: [], crossings: [], obstacles: [], solids: [] });
    const s = { x: 2, y: 2 }, g = { x: 38, y: 38 };
    const path = findPath(mesh, s.x, s.y, mesh.locate(s.x, s.y), g.x, g.y, mesh.locate(g.x, g.y));
    expect(path).not.toBeNull();
    const corners = path!.corners;
    // Inner corner is (36, 4): the walker rounds it along the arc the mesh
    // keeps a body's radius from it (plus the corner offset into open
    // ground), and nowhere else turns.
    expect(corners.length).toBeGreaterThanOrEqual(2);
    for (const c of corners.slice(0, -1)) {
      const d = Math.hypot(c.x - 36, c.y - 4);
      expect(d).toBeGreaterThanOrEqual(NAV_RADIUS - 0.01);
      expect(d).toBeLessThanOrEqual(NAV_RADIUS + 0.21);
    }
    expect(corners.at(-1)).toMatchObject({ x: 38, y: 38 });
  });

  it('goes straight when the way is straight', () => {
    const mesh = buildNavMesh({ layers: [L], crossingLayers: [], road: [], crossings: [], obstacles: [], solids: [] });
    const path = findPath(mesh, 2, 2, mesh.locate(2, 2), 30, 2, mesh.locate(30, 2))!;
    expect(path.corners.length).toBe(1);
  });

  it('crosses the road only on the zebra, and joins it to both footways', () => {
    // Two footways 4 u wide, a road 12 u wide between, a zebra across at x = 20.
    const footway = [[[[0, 0], [40, 0], [40, 4], [0, 4], [0, 0]]], [[[0, 16], [40, 16], [40, 20], [0, 20], [0, 16]]]];
    const road = [[[[0, 4], [40, 4], [40, 16], [0, 16], [0, 4]]]];
    const mesh = buildNavMesh({
      layers: [footway], crossingLayers: [0], road,
      crossings: [{ id: 'z', ax: 20, ay: 2, bx: 20, by: 18, halfWidth: 2 }], obstacles: [], solids: [],
    });
    const path = findPath(mesh, 2, 2, mesh.locate(2, 2), 38, 18, mesh.locate(38, 18))!;
    expect(path).not.toBeNull();
    expect(path.tris.some((t) => mesh.region[t] === 0)).toBe(true);
    // No triangle of the route lies in the road outside the zebra.
    for (const t of path.tris) {
      const c = mesh.centroid(t);
      if (mesh.region[t] === FOOTWAY) expect(c.y < 4 || c.y > 16).toBe(true);
      else expect(Math.abs(c.x - 20)).toBeLessThan(2);
    }
  });
});
