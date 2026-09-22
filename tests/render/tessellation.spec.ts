import { describe, expect, it } from 'vitest';
import { MeshBasicMaterial } from 'three';

import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { bands, surfaces } from '@world/surfaces';
import type { MultiPoly } from '@core/clipper';
import { buildSurfaceMesh } from '@render/mesh/surfaceMesh';

/**
 * Cost, measured rather than hoped for.
 *
 * Ear clipping a long thin band fans, and refining a fan is exponential. Both
 * defects are invisible in a correctness test — the mesh is valid either way —
 * and show up only as a number: one straight road once cost 1 026 232 triangles
 * and 900 ms. These ceilings are the measured values with head-room, so they can
 * only ever come down.
 */

const MAX_EDGE = 8;

function mesh(polygons: MultiPoly) {
  return buildSurfaceMesh({
    name: 'cost',
    polygons,
    top: () => 1,
    material: new MeshBasicMaterial(),
    maxEdge: MAX_EDGE,
    uv: (x, y, out) => {
      out[0] = x;
      out[1] = y;
    },
  });
}

function longestEdge(built: NonNullable<ReturnType<typeof mesh>>): number {
  const index = built.geometry.getIndex()!;
  const position = built.geometry.getAttribute('position');
  let worst = 0;
  for (let i = 0; i < index.count; i += 3) {
    for (let k = 0; k < 3; k++) {
      const a = index.getX(i + k);
      const b = index.getX(i + ((k + 1) % 3));
      worst = Math.max(
        worst,
        Math.hypot(position.getX(a) - position.getX(b), position.getZ(a) - position.getZ(b)),
      );
    }
  }
  return worst;
}

const triangles = (built: NonNullable<ReturnType<typeof mesh>>): number =>
  (built.geometry.getIndex()?.count ?? 0) / 3;

describe('tessellation cost', () => {
  it('meshes a long thin band in triangles proportional to its area', () => {
    const strip: MultiPoly = [[[[0, 0], [1400, 0], [1400, 1.5], [0, 1.5]]]];
    const built = mesh(strip)!;
    expect(longestEdge(built)).toBeLessThanOrEqual(MAX_EDGE + 1e-6);
    // 2 100 square units at an 8-unit edge is a few hundred triangles. The
    // ceiling is ten times that, and still four hundred times under the fan.
    expect(triangles(built)).toBeLessThan(4_000);
  });

  it('meshes a wide band without exploding either', () => {
    const slab: MultiPoly = [[[[0, 0], [1400, 0], [1400, 60], [0, 60]]]];
    const built = mesh(slab)!;
    expect(longestEdge(built)).toBeLessThanOrEqual(MAX_EDGE + 1e-6);
    expect(triangles(built)).toBeLessThan(20_000);
  });

  it('keeps a whole city grid inside the frame budget', () => {
    const doc = new RoadDoc();
    const xs = [-600, -300, 0, 300, 600];
    const ys = [-420, -140, 140, 420];
    const grid = ys.map((y) => xs.map((x) => doc.addNode({ x, y })));
    for (let r = 0; r < grid.length; r++) {
      for (let k = 0; k < xs.length - 1; k++) {
        doc.addSegment(grid[r]![k]!.id, grid[r]![k + 1]!.id, r === 1 ? 3 : 1);
      }
    }
    for (let k = 0; k < xs.length; k++) {
      for (let r = 0; r < grid.length - 1; r++) {
        doc.addSegment(grid[r]![k]!.id, grid[r + 1]![k]!.id, k === 2 ? 2 : 1);
      }
    }
    const net = new Network(doc);
    net.rebuild();
    const layer = bands(surfaces(net));

    const started = Date.now();
    let total = 0;
    for (const polygons of Object.values(layer)) {
      const built = mesh(polygons);
      if (!built) continue;
      total += triangles(built);
      expect(longestEdge(built)).toBeLessThanOrEqual(MAX_EDGE + 1e-6);
    }
    expect(total).toBeLessThan(200_000);
    // Generous, because a cold JIT on a shared runner is not a frame budget;
    // it is here to catch a regression of the kind that took 2.7 seconds.
    expect(Date.now() - started).toBeLessThan(4_000);
  });
});
