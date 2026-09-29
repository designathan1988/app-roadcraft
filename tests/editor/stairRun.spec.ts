import { describe, expect, it } from 'vitest';

import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { blueprintByKey } from '@world/buildings/blueprints';
import { levelElevation } from '@world/buildings/geometry';
import { type Building, type BuildingId } from '@world/buildings/types';
import { type BuildingContext, placeBuilding } from '@editor/buildings';
import { BuildingTool, type ToolHost, type ToolView } from '@editor/buildingTool';
import type { EditResult } from '@editor/buildings';

/**
 * A stair laid along a traced path: click the corners of the climb, finish,
 * and one flight lands per segment - turned with the trace, its rise spread
 * over the segments in proportion to their length, so the run lands exactly on
 * the floor above. This is what lets a stair wrap a corner or follow a wall.
 */

const flat = (): number => 0;

/** A simple oblique view looking north: screen x = world x, screen y = -world y - height. */
const view: ToolView = {
  project: (x, y, z) => ({ x, y: -y - z }),
  planeAt: (s, z) => ({ x: s.x, y: -s.y - z }),
  ray: (s) => ({ ox: s.x, oy: -s.y - 1000, oz: 1000, dx: 0, dy: Math.SQRT1_2, dz: -Math.SQRT1_2 }),
  groundAt: flat,
  pickPixels: 10,
};

function setup(): { t: BuildingTool; doc: RoadDoc; building: Building } {
  const doc = new RoadDoc();
  const a = doc.addNode({ x: -600, y: 0 });
  const b = doc.addNode({ x: 600, y: 0 });
  doc.addSegment(a.id, b.id, 1);
  const net = new Network(doc);
  net.rebuild();
  const ctx: BuildingContext = { doc, net, groundAt: flat };
  const placed = placeBuilding(ctx, blueprintByKey('house')!.body, { x: 0, y: 60 }, 0, 'house');
  expect(placed.ok, String(placed.problem)).toBe(true);
  const host: ToolHost = {
    context: () => ctx,
    groundKey: () => `${doc.revision}:${doc.terrainRevision}`,
    commit(edit: () => EditResult): EditResult {
      return edit();
    },
    changed: () => {},
    flash: () => {},
  };
  return { t: new BuildingTool(view, host), doc, building: doc.buildings.get(placed.id as BuildingId)! };
}

describe('a stair traced as a path', () => {
  it('lays one turned flight per segment and lands on the floor above', () => {
    const { t, doc, building } = setup();
    const volume = building.volumes[0]!;
    t.armModelTool('select');
    t.selection = { building: building.id, volume: volume.id, bay: null };
    t.setStoreys(2);
    const updated = doc.buildings.get(building.id)!;
    const v = updated.volumes[0]!;
    const rise = levelElevation(updated, 1) - levelElevation(updated, 0);
    expect(rise).toBeGreaterThan(0);

    t.startElementRun('stair');
    expect(t.planPoints).toEqual([]);
    // Two legs: down the lot, then a right angle along it.
    const c = Math.cos(updated.rotation);
    const s = Math.sin(updated.rotation);
    const world = (lx: number, ly: number): { x: number; y: number } => ({
      x: updated.x + lx * c - ly * s,
      y: updated.y + lx * s + ly * c,
    });
    for (const [lx, ly] of [
      [v.x - 6, v.y - 8],
      [v.x - 6, v.y - 24],
      [v.x + 10, v.y - 24],
    ] as const) {
      const p = world(lx, ly);
      t.planCursor = p;
      t.planPoints!.push(p);
    }
    t.finishPlan();

    const after = doc.buildings.get(building.id)!;
    const stairs = (after.elements ?? []).filter((e) => e.kind === 'stair');
    expect(stairs).toHaveLength(2);
    // The first flight starts at the ground floor and the second carries on
    // from where it ended: together they climb exactly one storey.
    const first = stairs[0]!;
    const second = stairs[1]!;
    expect(first.z).toBeCloseTo(levelElevation(after, 0), 6);
    expect(second.z).toBeCloseTo(first.z + first.h, 6);
    expect(first.h + second.h).toBeCloseTo(rise, 6);
    // Each leg is turned to the line it was drawn on: the two legs differ.
    expect(first.angle).toBeDefined();
    expect(second.angle).toBeDefined();
    expect(Math.abs((first.angle ?? 0) - (second.angle ?? 0))).toBeGreaterThan(1);
  });
});

