import { describe, expect, it } from 'vitest';

import { GRID, MIN_SIZE } from '@world/buildings/geometry';

import { DEFAULT_MODULE } from '@world/buildings/types';

import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { BLUEPRINTS, blueprintByKey, generateBody } from '@world/buildings/blueprints';
import { facadeBays, footprintRects, levelElevation, volumeHeight } from '@world/buildings/geometry';
import { touchesRoad } from '@world/buildings/validate';
import { type Building, type BuildingId, componentAt, volumeById } from '@world/buildings/types';
import {
  type BuildingContext,
  type EditResult,
  clearBuildingsOnRoads,
  duplicateBuilding,
  editBuilding,
  opAddSetback,
  opAddWing,
  opRemoveVolume,
  opResize,
  opRotate,
  opSetComponent,
  opSetStoreys,
  opSetUse,
  placeBuilding,
  removeVolume,
} from '@editor/buildings';
import { footprintSize, snapPlacement } from '@editor/buildingSnap';
import { BuildingTool, type ToolHost, type ToolView } from '@editor/buildingTool';
import { History, restoreInto } from '@editor/history';
import { commitDraft } from '@editor/commit';

/** `n` default modules, world units. */
const bays = (n: number): number => n * DEFAULT_MODULE;

/**
 * The building commands and the tool that drives them (docs/buildings.md
 * section 4). Every command is validated before it is stored, every one is a
 * single undo step, and a road drawn over a building demolishes it.
 */

const flat = (): number => 0;

function world(withRoad = true): { doc: RoadDoc; net: Network; ctx: BuildingContext } {
  const doc = new RoadDoc();
  if (withRoad) {
    const a = doc.addNode({ x: -600, y: 0 });
    const b = doc.addNode({ x: 600, y: 0 });
    doc.addSegment(a.id, b.id, 1);
  }
  const net = new Network(doc);
  net.rebuild();
  return { doc, net, ctx: { doc, net, groundAt: flat } };
}

function place(ctx: BuildingContext, key = 'house', at = { x: 0, y: 60 }, rotation = 0): Building {
  const bp = blueprintByKey(key)!;
  const result = placeBuilding(ctx, bp.body, at, rotation, key);
  expect(result.ok, String(result.problem)).toBe(true);
  return ctx.doc.buildings.get(result.id as BuildingId)!;
}

describe('building operations', () => {
  it('pulls storeys up and down, carrying the tower that stands on the podium', () => {
    const tower = { ...blueprintByKey('tower')!.body, id: 1, x: 0, y: 0, rotation: 0 } as unknown as Building;
    const podium = tower.volumes[0]!;
    const top = tower.volumes[1]!;
    expect(top.base).toBe(2);
    expect(opSetStoreys(tower, podium.id, 4)).toBe(true);
    expect(podium.storeys).toHaveLength(4);
    expect(top.base).toBe(4);
    expect(opSetStoreys(tower, podium.id, 1)).toBe(true);
    expect(top.base).toBe(1);
    // A pull to the same count changes nothing.
    expect(opSetStoreys(tower, podium.id, 1)).toBe(false);
  });

  it('copies the upper storey up, not the ground floor with its door', () => {
    const b = { ...generateBody('residential', bays(3), bays(3), 1), id: 1, x: 0, y: 0, rotation: 0 } as unknown as Building;
    opSetStoreys(b, 1, 3);
    const doors = facadeBays(b).filter((bay) => bay.component === 'door');
    expect(doors).toHaveLength(1);
    expect(doors[0]!.level).toBe(0);
  });

  it('grows a volume on its negative side and keeps each bay override on its bay', () => {
    const b = { ...generateBody('residential', bays(3), bays(3), 1), id: 1, x: 0, y: 0, rotation: 0 } as unknown as Building;
    const v = b.volumes[0]!;
    const doorBefore = facadeBays(b).find((bay) => bay.component === 'door')!;
    expect(opResize(b, 1, 3, bays(2))).toBe(true);
    expect(v.x).toBe(-bays(2));
    expect(v.w).toBe(bays(5));
    const doorAfter = facadeBays(b).find((bay) => bay.component === 'door')!;
    expect(doorAfter.x).toBeCloseTo(doorBefore.x, 9);
    // It never shrinks below one cell.
    opResize(b, 1, 1, -bays(20));
    expect(v.w).toBe(MIN_SIZE);
  });

  it('adds a wing that shares a wall, and a setback that stands on a terrace', () => {
    const b = { ...generateBody('commercial', bays(6), bays(4), 3), id: 1, x: 0, y: 0, rotation: 0 } as unknown as Building;
    const wing = opAddWing(b, 1, 1, bays(3))!;
    const w = volumeById(b, wing)!;
    expect(w.x).toBe(bays(6));
    expect(w.storeys).toHaveLength(3);
    const setback = opAddSetback(b, 1)!;
    const s = volumeById(b, setback)!;
    expect(s.base).toBe(3);
    expect(s.w).toBe(bays(4));
    expect(volumeById(b, 1)!.roof).toBe('terrace');
    // Removing the podium takes the setback with it, but leaves the wing.
    expect(opRemoveVolume(b, 1)).toBe(true);
    expect(b.volumes.map((v) => v.id)).toEqual([wing]);
  });

  it('replaces a facade component by bay, storey, side and volume', () => {
    const b = { ...generateBody('residential', bays(4), bays(3), 3), id: 1, x: 0, y: 0, rotation: 0 } as unknown as Building;
    const v = b.volumes[0]!;
    opSetComponent(b, 1, 1, 1, 2, 'balcony', 'bay');
    expect(componentAt(v.storeys[1]!.facade, 1, 2)).toBe('balcony');
    expect(componentAt(v.storeys[1]!.facade, 1, 1)).toBe('window');
    opSetComponent(b, 1, 2, 0, 0, 'wideWindow', 'storey');
    expect(componentAt(v.storeys[2]!.facade, 3, 1)).toBe('wideWindow');
    opSetComponent(b, 1, 0, 1, 0, 'pillar', 'side');
    for (const storey of v.storeys) expect(componentAt(storey.facade, 1, 2)).toBe('pillar');
    opSetComponent(b, 1, 0, 0, 0, 'wall', 'volume');
    expect(facadeBays(b).every((bay) => bay.component === 'wall')).toBe(true);
  });

  it('regenerates the facades for a change of use', () => {
    const b = { ...generateBody('residential', bays(4), bays(3), 2), id: 1, x: 0, y: 0, rotation: 0 } as unknown as Building;
    opSetUse(b, 'commercial');
    expect(facadeBays(b).some((bay) => bay.component === 'shopfront')).toBe(true);
  });

  it('rotates about the footprint centre', () => {
    const b = { ...generateBody('residential', bays(4), bays(2), 1), id: 1, x: 0, y: 0, rotation: 0 } as unknown as Building;
    const centre = (x: Building): { x: number; y: number } => {
      const r = footprintRects(x)[0]!;
      return { x: (r[0]!.x + r[2]!.x) / 2, y: (r[0]!.y + r[2]!.y) / 2 };
    };
    const before = centre(b);
    opRotate(b, Math.PI / 2);
    const after = centre(b);
    expect(after.x).toBeCloseTo(before.x, 9);
    expect(after.y).toBeCloseTo(before.y, 9);
  });
});

describe('building commands', () => {
  it('places every preset beside a road and refuses one on it', () => {
    const { ctx } = world();
    let x = -500;
    for (const bp of BLUEPRINTS) {
      const size = footprintSize(bp.body);
      const r = placeBuilding(ctx, bp.body, { x: x + size.width / 2, y: 30 }, 0, bp.key);
      expect(r.ok, `${bp.key}: ${r.problem}`).toBe(true);
      x += size.width + 30;
    }
    expect(placeBuilding(ctx, blueprintByKey('house')!.body, { x: 0, y: -5 }, 0).problem).toBe('road');
  });

  it('never stores an invalid edit', () => {
    const { ctx, doc } = world();
    const b = place(ctx);
    const before = JSON.stringify(doc.toJSON());
    // Grow the front out over the road.
    const r = editBuilding(ctx, b.id, (draft) => opResize(draft, 1, 0, bays(40)));
    expect(r.ok).toBe(false);
    expect(r.problem).toBe('road');
    expect(JSON.stringify(doc.toJSON())).toBe(before);
  });

  it('duplicates flush beside the original', () => {
    const { ctx, doc } = world();
    const b = place(ctx, 'rowhouse');
    const r = duplicateBuilding(ctx, b.id);
    expect(r.ok).toBe(true);
    expect(doc.buildings.size).toBe(2);
  });

  it('removes the last volume by removing the building', () => {
    const { ctx, doc } = world();
    const b = place(ctx);
    expect(removeVolume(ctx, b.id, 1).ok).toBe(true);
    expect(doc.buildings.size).toBe(0);
  });

  it('undoes and redoes a building edit without moving the road revision', () => {
    const { ctx, doc, net } = world();
    const history = new History();
    const b = place(ctx, 'apartments');
    const roads = doc.revision;
    history.record(doc);
    expect(editBuilding(ctx, b.id, (draft) => opSetStoreys(draft, 1, 9)).ok).toBe(true);
    expect(doc.revision).toBe(roads);
    expect(doc.buildings.get(b.id)!.volumes[0]!.storeys).toHaveLength(9);
    restoreInto(doc, history.undo(doc)!, net);
    expect(doc.buildings.get(b.id)!.volumes[0]!.storeys).toHaveLength(5);
    restoreInto(doc, history.redo(doc)!, net);
    expect(doc.buildings.get(b.id)!.volumes[0]!.storeys).toHaveLength(9);
  });

  it('demolishes a building a new road is drawn over, and an undo brings both back', () => {
    const { ctx, doc, net } = world();
    const b = place(ctx, 'house', { x: 0, y: 60 });
    const history = new History();
    history.record(doc);
    const result = commitDraft(doc, net, { kind: 'free', at: { x: 20, y: -200 } }, { kind: 'free', at: { x: 20, y: 300 } }, 1, null, 'ground');
    expect(result.committed).toBe(true);
    net.rebuild();
    expect(footprintRects(doc.buildings.get(b.id)!).some((r) => touchesRoad(net, r))).toBe(true);
    expect(clearBuildingsOnRoads(ctx)).toBe(1);
    expect(doc.buildings.size).toBe(0);
    restoreInto(doc, history.undo(doc)!, net);
    expect(doc.buildings.size).toBe(1);
  });
});

describe('snapping', () => {
  it('faces a road and lays the front along the back of the footway', () => {
    const { doc, net } = world();
    const size = footprintSize(blueprintByKey('house')!.body);
    const snap = snapPlacement(doc, net, size, { x: 13, y: 35 }, 0.7);
    expect(snap.kind).toBe('road');
    // North of an east-west road the front (local -y) faces south: rotation 0.
    expect(Math.abs(snap.rotation)).toBeLessThan(1e-9);
    const south = snapPlacement(doc, net, size, { x: 13, y: -35 }, 0.7);
    expect(Math.abs(Math.abs(south.rotation) - Math.PI)).toBeLessThan(1e-9);
  });

  it('snaps flush to a neighbour on the same frontage', () => {
    const { doc, net, ctx } = world();
    const first = place(ctx, 'rowhouse', { x: 0, y: 30 }, 0);
    const size = footprintSize(first);
    const snap = snapPlacement(doc, net, size, { x: size.width + 1.2, y: 30 }, 0);
    const second = placeBuilding(ctx, blueprintByKey('rowhouse')!.body, snap.anchor, snap.rotation);
    expect(second.ok, String(second.problem)).toBe(true);
    const a = footprintRects(first)[0]!.map((p) => p.x);
    const b = footprintRects(doc.buildings.get(second.id!)!)[0]!.map((p) => p.x);
    const touching = Math.min(Math.abs(Math.min(...a) - Math.max(...b)), Math.abs(Math.max(...a) - Math.min(...b)));
    expect(touching).toBeLessThan(1e-6);
  });

  it('takes a nearby building\'s bearing away from roads, and the grid otherwise', () => {
    const { doc, net, ctx } = world(false);
    place(ctx, 'house', { x: 0, y: 0 }, 0.5);
    const size = footprintSize(blueprintByKey('house')!.body);
    expect(snapPlacement(doc, net, size, { x: 30, y: 10 }, 0).kind).toBe('building');
    const far = snapPlacement(doc, net, size, { x: 800, y: 800 }, 0);
    expect(far.kind).toBe('grid');
  });
});

describe('the tool', () => {
  /** A simple oblique view looking north: screen x = world x, screen y = -(world y) - height. */
  const view: ToolView = {
    project: (x, y, z) => ({ x, y: -y - z }),
    planeAt: (s, z) => ({ x: s.x, y: -s.y - z }),
    ray: (s) => ({ ox: s.x, oy: -s.y - 1000, oz: 1000, dx: 0, dy: Math.SQRT1_2, dz: -Math.SQRT1_2 }),
    groundAt: flat,
    pickPixels: 10,
  };

  function tool(): { t: BuildingTool; doc: RoadDoc; history: History; net: Network } {
    const { doc, net, ctx } = world(false);
    const history = new History();
    const host: ToolHost = {
      context: () => ctx,
      groundKey: () => `${doc.revision}:${doc.terrainRevision}`,
      commit(edit: () => EditResult): EditResult {
        const before = RoadDoc.fromJSON(doc.toJSON());
        const r = edit();
        if (r.ok) history.record(before);
        return r;
      },
      changed: () => {},
      flash: () => {},
    };
    return { t: new BuildingTool(view, host), doc, history, net };
  }

  it('places on click, then pulls storeys with the roof handle', () => {
    const { t, doc } = tool();
    t.chooseBlueprint('apartments');
    t.pointerMove({ x: 0, y: 0 }, { x: 0, y: 0 }, false);
    expect(t.preview?.valid).toBe(true);
    t.pointerDown({ x: 0, y: 0 }, { x: 0, y: 0 }, false);
    t.pointerUp(false);
    expect(doc.buildings.size).toBe(1);
    expect(t.mode).toBe('edit');
    const b = t.selected()!;
    const handle = t.handles().find((h) => h.kind === 'storeys')!;
    const at = view.project(handle.x, handle.y, handle.z);
    t.pointerDown(at, { x: 0, y: 0 }, false);
    const perStorey = levelElevation(b, 2) - levelElevation(b, 1);
    t.pointerMove({ x: at.x, y: at.y - perStorey * 3 }, { x: 0, y: 0 }, false);
    expect(t.preview?.building.volumes[0]!.storeys).toHaveLength(8);
    t.pointerUp(false);
    expect(t.selected()!.volumes[0]!.storeys).toHaveLength(8);
    expect(volumeHeight(t.selected()!, t.selected()!.volumes[0]!)).toBeGreaterThan(volumeHeight(b, b.volumes[0]!));
  });

  it('grows a side by dragging its handle, and a wing with Shift', () => {
    const { t, doc } = tool();
    t.chooseBlueprint('house');
    t.pointerMove({ x: 0, y: 0 }, { x: 0, y: 0 }, false);
    t.pointerDown({ x: 0, y: 0 }, { x: 0, y: 0 }, false);
    t.pointerUp(false);
    const id = t.selection!.building;
    const right = t.handles().find((h) => h.kind === 'side' && h.dx > 0.5)!;
    const at = view.project(right.x, right.y, right.z);
    const module = doc.buildings.get(id)!.module;
    t.pointerDown(at, { x: 0, y: 0 }, false);
    t.pointerMove({ x: at.x + module * 2, y: at.y }, { x: 0, y: 0 }, false);
    t.pointerUp(false);
    expect(doc.buildings.get(id)!.volumes[0]!.w).toBe(bays(5));
    const again = t.handles().find((h) => h.kind === 'side' && h.dx > 0.5)!;
    const at2 = view.project(again.x, again.y, again.z);
    t.pointerDown(at2, { x: 0, y: 0 }, true);
    t.pointerMove({ x: at2.x + module * 3, y: at2.y }, { x: 0, y: 0 }, true);
    t.pointerUp(false);
    expect(doc.buildings.get(id)!.volumes).toHaveLength(2);
  });

  it('applies an armed component to the clicked bay', () => {
    const { t, doc } = tool();
    t.chooseBlueprint('office');
    t.pointerMove({ x: 0, y: 0 }, { x: 0, y: 0 }, false);
    t.pointerDown({ x: 0, y: 0 }, { x: 0, y: 0 }, false);
    t.pointerUp(false);
    const b = t.selected()!;
    t.armComponent('balcony');
    // The front face of the office faces -y at rotation 0: aim at level 3.
    const bay = facadeBays(b).find((x) => x.side === 0 && x.level === 3 && x.index === 2)!;
    const z = bay.z + bay.height / 2 + t.floorOf(b);
    const screen = view.project(bay.x, bay.y - 0.01, z);
    t.pointerDown(screen, { x: 0, y: 0 }, false);
    t.pointerUp(false);
    const after = doc.buildings.get(b.id)!;
    expect(componentAt(after.volumes[0]!.storeys[3]!.facade, 0, 2)).toBe('balcony');
  });

  it('copies, pastes, rotates and deletes with the keyboard', () => {
    const { t, doc } = tool();
    t.chooseBlueprint('shop');
    t.pointerMove({ x: 0, y: 0 }, { x: 0, y: 0 }, false);
    t.pointerDown({ x: 0, y: 0 }, { x: 0, y: 0 }, false);
    t.pointerUp(false);
    const id = t.selection!.building;
    const before = doc.buildings.get(id)!.rotation;
    expect(t.key('r', false, false)).toBe(true);
    expect(doc.buildings.get(id)!.rotation).not.toBe(before);
    expect(t.key('c', true, false)).toBe(true);
    expect(t.key('v', true, false)).toBe(true);
    expect(t.mode).toBe('place');
    t.pointerMove({ x: 200, y: 200 }, { x: 200, y: 200 }, false);
    t.pointerDown({ x: 200, y: 200 }, { x: 200, y: 200 }, false);
    t.pointerUp(false);
    expect(doc.buildings.size).toBe(2);
    expect(t.key('Delete', false, false)).toBe(true);
    expect(doc.buildings.size).toBe(1);
  });
});

describe('free dimensions', () => {
  it('pushes and pulls a side by any length, snapped to the grid', () => {
    const b = { ...generateBody('residential', bays(4), bays(3), 1), id: 1, x: 0, y: 0, rotation: 0 } as unknown as Building;
    const v = b.volumes[0]!;
    expect(opResize(b, 1, 1, 3.1)).toBe(true);
    expect(v.w).toBeCloseTo(bays(4) + 2 * GRID, 9);
    expect(opResize(b, 1, 0, -0.2)).toBe(false);
    // A wing of any depth, snapped too.
    const wing = volumeById(b, opAddWing(b, 1, 2, 7.4)!)!;
    expect(wing.d).toBeCloseTo(6 * GRID, 9);
  });
});
