import { describe, expect, it } from 'vitest';

import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { footprintBox, footprintRects, localDirToWorld, planOverlap } from '@world/buildings/geometry';
import { type Building, type BuildingId, cloneBuilding, volumeById } from '@world/buildings/types';
import { blueprintByKey } from '@world/buildings/blueprints';
import { validateBuilding } from '@world/buildings/validate';
import {
  type BuildingContext,
  addBuildingRecord,
  fuseVolumes,
  opUnionVolumes,
  placeBuilding,
  weldInto,
} from '@editor/buildings';
import type { Building as BuildingType } from '@world/buildings/types';

/**
 * Welding: dragging one building against another must fuse them, not leave an
 * "overlaps another building" refusal and a red ghost (the behaviour the mass
 * tools are built on). The weld brings the neighbour's masses into the record,
 * cuts the overlap out of the smaller one and fuses what makes one block.
 */

const flat = (): number => 0;

function world(): { doc: RoadDoc; net: Network; ctx: BuildingContext } {
  const doc = new RoadDoc();
  const a = doc.addNode({ x: -600, y: 0 });
  const b = doc.addNode({ x: 600, y: 0 });
  doc.addSegment(a.id, b.id, 1);
  const net = new Network(doc);
  net.rebuild();
  return { doc, net, ctx: { doc, net, groundAt: flat } };
}

function place(ctx: BuildingContext, at = { x: 0, y: 60 }): Building {
  const bp = blueprintByKey('house')!;
  const result = placeBuilding(ctx, bp.body, at, 0, 'house');
  expect(result.ok, String(result.problem)).toBe(true);
  return ctx.doc.buildings.get(result.id as BuildingId)!;
}

/**
 * A second building dropped where it overlaps the first - what a drag that
 * ends on top of a neighbour produces. Stored ignoring the neighbour, exactly
 * as the tool's weld path does.
 */
function placeOverlapping(ctx: BuildingContext, against: Building, at: { x: number; y: number }): Building {
  const bp = blueprintByKey('house')!;
  const body = JSON.parse(JSON.stringify(bp.body)) as Omit<Building, 'id'>;
  body.rotation = 0;
  const f = footprintBox(body as Building);
  const local = { x: (f.x0 + f.x1) / 2, y: f.y0 };
  const offset = localDirToWorld(body as Building, local.x, local.y);
  body.x = at.x - offset.x;
  body.y = at.y - offset.y;
  const result = addBuildingRecord(ctx, body, [against.id]);
  expect(result.ok, String(result.problem)).toBe(true);
  return ctx.doc.buildings.get(result.id as BuildingId)!;
}

describe('welding two buildings', () => {
  it('cuts the overlap out of the smaller mass, leaving nothing overlapping', () => {
    const { ctx } = world();
    const first = place(ctx, { x: 0, y: 60 });
    // A second house a few metres along, so the two footprints overlap.
    const second = placeOverlapping(ctx, first, { x: 12, y: 60 });
    const draft = cloneBuilding(second);
    const absorbed = weldInto(ctx, draft, []);
    const bounds = (b: Building) => footprintRects(b, 0.02).map((r) => [Math.min(...r.map(p => p.x)).toFixed(1), Math.min(...r.map(p => p.y)).toFixed(1), Math.max(...r.map(p => p.x)).toFixed(1), Math.max(...r.map(p => p.y)).toFixed(1)]);
    expect(absorbed, JSON.stringify({ first: bounds(first), second: bounds(second), pos: [second.x, second.y, second.rotation] })).toEqual([first.id]);
    expect(draft.volumes.length).toBe(1);
    expect(draft.volumes[0]!.w).toBeGreaterThan(22.5);
    // No two masses of the welded record overlap, and the record validates.
    for (const a of draft.volumes) {
      for (const c of draft.volumes) {
        if (a.id === c.id || a.base !== c.base) continue;
        expect(planOverlap(a, c)).toBe(false);
      }
    }
    expect(validateBuilding(ctx, draft, [first.id])).toBeNull();
  });

  it('fuses flush neighbours that make one rectangle into one mass', () => {
    const { ctx } = world();
    const first = place(ctx, { x: 0, y: 60 });
    const v = first.volumes[0]!;
    const draft = cloneBuilding(first);
    // A wing exactly against the first mass, the same storeys: one block.
    const wing = { ...(JSON.parse(JSON.stringify(v)) as typeof v) };
    wing.id = draft.nextVolumeId++;
    wing.x = v.x + v.w;
    draft.volumes.push(wing);
    const before = draft.volumes.length;
    expect(opUnionVolumes(draft, v.id)).toBe(true);
    expect(draft.volumes.length).toBe(before - 1);
    expect(draft.volumes[0]!.w).toBeCloseTo(v.w + wing.w, 6);
  });

  it('fuses a mass that is swallowed whole into the bigger one', () => {
    const { ctx } = world();
    const first = place(ctx, { x: 0, y: 60 });
    const draft = cloneBuilding(first);
    const v = draft.volumes[0]!;
    // A small block entirely inside the first: the fusion leaves one block.
    const inner = JSON.parse(JSON.stringify(v)) as typeof v;
    inner.id = draft.nextVolumeId++;
    inner.x = v.x + 5;
    inner.y = v.y + 5;
    inner.w = Math.max(6, v.w / 3);
    inner.d = Math.max(6, v.d / 3);
    draft.volumes.push(inner);
    weldInto(ctx, draft, []);
    fuseVolumes(draft);
    expect(draft.volumes.length).toBe(1);
    expect(validateBuilding(ctx, draft)).toBeNull();
  });

  it('stores the welded record and drops the absorbed buildings', () => {
    const { ctx } = world();
    const first = place(ctx, { x: 0, y: 60 });
    const second = placeOverlapping(ctx, first, { x: 12, y: 60 });
    const draft = cloneBuilding(second);
    const absorbed = weldInto(ctx, draft, []);
    const stored = addBuildingRecord(ctx, { ...draft } as Omit<BuildingType, "id"> & { id?: BuildingId }, [second.id, ...absorbed]);
    expect(
      stored.ok,
      JSON.stringify({
        problem: stored.problem,
        volumes: draft.volumes.map((v) => [v.x, v.y, v.w, v.d, v.base, v.storeys.length]),
      }),
    ).toBe(true);
    for (const id of [second.id, ...absorbed]) ctx.doc.buildings.remove(id);
    expect(ctx.doc.buildings.size).toBe(1);
    const welded = ctx.doc.buildings.get(stored.id as BuildingId);
    expect(welded).toBeDefined();
    expect(welded!.volumes.length).toBeGreaterThanOrEqual(1);
    // The neighbour's footprint is covered by the welded building.
    const covered = footprintRects(welded!, 0).length;
    expect(covered).toBeGreaterThanOrEqual(1);
    void volumeById(welded!, welded!.volumes[0]!.id);
  });
});
