import { describe, expect, it } from 'vitest';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { BuildingTool, type ToolHost, type ToolView } from '@editor/buildingTool';
import { localToWorld } from '@world/buildings/geometry';
import { localFootprint } from '@world/buildings/footprints';

/**
 * A footprint shape dragged on the ground is built in the rectangle drawn.
 *
 * Beside a road it was snapped like a model - pulled onto the kerb and turned
 * to face it - and the cursor was read off the drawn world, which put the far
 * corner on the ghost's own roof as it grew: neither landed where dragged.
 */

function setup(): { tool: BuildingTool; doc: RoadDoc } {
  const doc = new RoadDoc();
  const a = doc.addNode({ x: -600, y: 0 });
  const b = doc.addNode({ x: 600, y: 0 });
  doc.addSegment(a.id, b.id, 1);
  const net = new Network(doc);
  const view: ToolView = {
    project: (x, y, z) => ({ x, y: y - z }),
    // The "screen" is the ground itself: a screen point IS its world point.
    planeAt: (s) => s,
    ray: () => ({ ox: -1000, oy: -1000, oz: 100, dx: 0, dy: 0, dz: -1 }),
    groundAt: () => 0, pickPixels: 5,
  };
  const host: ToolHost = {
    context: () => ({ doc, net, groundAt: () => 0 }),
    groundKey: () => '0',
    commit: (edit) => edit(),
    changed: () => {}, flash: () => {},
  };
  return { tool: new BuildingTool(view, host), doc };
}

describe('dragging a footprint shape', () => {
  it('builds the rectangle drawn beside a road, square to the screen', () => {
    const { tool, doc } = setup();
    const start = { x: 20, y: 40 }, end = { x: 70, y: 75 };
    tool.beginShapeDrag('rectangle', start, 'new', start);
    // The world the scene reports under the cursor is somewhere else (a roof):
    // the drag reads the ground under the screen point.
    tool.updateShapeDrag({ x: 30, y: 50 }, end);
    tool.endShapeDrag(false);
    expect(doc.buildings.size).toBe(1);
    const b = [...doc.buildings.all()][0]!;
    expect(b.rotation).toBeCloseTo(0, 6);
    const ring = localFootprint(b.volumes[0]!).map((p) => localToWorld(b, p.x, p.y));
    const xs = ring.map((p) => p.x), ys = ring.map((p) => p.y);
    expect(Math.min(...xs)).toBeCloseTo(start.x, 6);
    expect(Math.max(...xs)).toBeCloseTo(end.x, 6);
    expect(Math.min(...ys)).toBeCloseTo(start.y, 6);
    expect(Math.max(...ys)).toBeCloseTo(end.y, 6);
  });
});
