import { describe, expect, it } from 'vitest';

import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { BLUEPRINTS, generateBody } from '@world/buildings/blueprints';
import { MAX_PLINTH, PLINTH_MIN, floorHeight, flightRun, foundationOf } from '@world/buildings/foundation';
import {
  buildingHeight,
  facadeBays,
  footprintRects,
  levelElevation,
  localToWorld,
  occupancy,
  worldToLocal,
} from '@world/buildings/geometry';
import { buildingHandles } from '@world/buildings/handles';
import { PALETTE_MATERIALS, applyMaterial, roofMaterial, wallMaterial } from '@world/buildings/materials';
import { pickBuilding } from '@world/buildings/pick';
import { migrateBuilding } from '@world/buildings/serialize';
import { deriveSpaces, floorArea } from '@world/buildings/spaces';
import { convexOverlap, structuralProblem, validateBuilding } from '@world/buildings/validate';
import { type Building, asBuildingId, componentAt } from '@world/buildings/types';
import { isSerializedDoc } from '@editor/persistence';

/**
 * The modular building model (docs/buildings.md): a building is data, and
 * every question about it - what is an outside wall, where the floor is on a
 * slope, whether it may stand here - is answered from that data.
 */

const flat = (): number => 0;

function building(overrides: Partial<Building> = {}): Building {
  return {
    ...generateBody('residential', 4, 3, 3),
    id: asBuildingId(1),
    x: 100,
    y: 100,
    rotation: 0,
    ...overrides,
  } as Building;
}

describe('building geometry', () => {
  it('round-trips points through the local frame at any rotation', () => {
    for (const rotation of [0, 0.3, Math.PI / 2, -2.1]) {
      const b = building({ rotation });
      const w = localToWorld(b, 12.5, -7);
      const l = worldToLocal(b, w);
      expect(l.x).toBeCloseTo(12.5, 9);
      expect(l.y).toBeCloseTo(-7, 9);
    }
  });

  it('stacks levels: ground height, then storey height, with overrides', () => {
    const b = building({ groundHeight: 10, storeyHeight: 8 });
    expect(levelElevation(b, 0)).toBe(0);
    expect(levelElevation(b, 1)).toBe(10);
    expect(levelElevation(b, 3)).toBe(26);
    b.levels = [null, 12];
    expect(levelElevation(b, 3)).toBe(30);
  });

  it('puts a facade bay on every outside wall of every storey', () => {
    const b = building();
    const bays = facadeBays(b);
    // 4x3 cells: 2*(4+3) = 14 bays a storey, three storeys.
    expect(bays.length).toBe(14 * 3);
    expect(bays.filter((bay) => bay.component === 'door')).toHaveLength(1);
  });

  it('builds no facade where two volumes share a wall', () => {
    const b = building();
    b.volumes.push({ ...JSON.parse(JSON.stringify(b.volumes[0])), id: 2, x: 4 });
    const bays = facadeBays(b);
    // Two 4x3 blocks side by side: 2*(8+3) exposed bays a storey.
    expect(bays.length).toBe(22 * 3);
    expect(occupancy(b).clashes).toHaveLength(0);
  });

  it('resolves a facade bay, then side, then fill', () => {
    const facade = { fill: 'window' as const, sides: { 1: 'wall' as const }, bays: { '1:0': 'door' as const } };
    expect(componentAt(facade, 0, 0)).toBe('window');
    expect(componentAt(facade, 1, 1)).toBe('wall');
    expect(componentAt(facade, 1, 0)).toBe('door');
  });

  it('measures the tallest point including the roof', () => {
    const b = building();
    b.volumes[0]!.roof = 'flat';
    const flatHeight = buildingHeight(b);
    b.volumes[0]!.roof = 'gable';
    expect(buildingHeight(b)).toBeGreaterThan(flatHeight);
  });

  it('places the edit handles around the selected volume', () => {
    const b = building();
    const handles = buildingHandles(b, 1, 5);
    expect(handles.filter((h) => h.kind === 'side')).toHaveLength(4);
    const up = handles.find((h) => h.kind === 'storeys')!;
    expect(up.z).toBeGreaterThan(5 + levelElevation(b, 3));
  });
});

describe('foundations', () => {
  it('stands the floor above the highest ground and buries the plinth below the lowest', () => {
    const b = building();
    // A slope rising 0.1 per unit east.
    const slope = (x: number): number => (x - 100) * 0.1;
    const f = foundationOf(b, slope);
    const width = 4 * b.module;
    expect(f.highest).toBeCloseTo(width * 0.1, 6);
    expect(f.lowest).toBeCloseTo(0, 6);
    expect(f.floor).toBeCloseTo(f.highest + PLINTH_MIN, 6);
    expect(f.bottom).toBeLessThan(f.lowest);
  });

  it('gives an entrance on a slope a flight of steps down to the street', () => {
    const b = building();
    // Ground falls towards the front (-y).
    const f = foundationOf(b, (_x, y) => (y - 100) * 0.25);
    const door = f.entrances.find((e) => e.component === 'door')!;
    expect(door).toBeDefined();
    expect(door.steps).toBeGreaterThan(0);
    const level = foundationOf(b, flat).entrances.find((e) => e.component === 'door')!;
    expect(level.steps).toBe(0);
  });

  // The front of `building()` is the line y = 100, facing -y.
  const doorOf = (f: ReturnType<typeof foundationOf>) => f.entrances.find((e) => e.component === 'door')!;
  /** Paving at height `h` from `edge` units in front of the facade outwards. */
  const pavingFrom = (edge: number, h = 0) => (_x: number, y: number): number => (y < 100 - edge ? h : NaN);

  it('never runs a flight of steps across the paving in front of it', () => {
    const b = building();
    // The land under the building a little higher than in front of it.
    const land = (_x: number, y: number): number => (y >= 100 ? 0.5 : 0);
    const roomy = doorOf(foundationOf(b, land, undefined, pavingFrom(5)));
    expect(roomy.steps).toBeGreaterThan(0);
    expect(roomy.recess).toBe(0);
    expect(flightRun(roomy.steps)).toBeLessThanOrEqual(5);
    // On the back of a footway there is no room at all: the flight is set
    // into the building, starting on the ground at the facade.
    const tight = doorOf(foundationOf(b, land, undefined, pavingFrom(0.3)));
    expect(tight.steps).toBeGreaterThan(0);
    expect(tight.recess).toBeCloseTo(flightRun(tight.steps), 9);
    expect(tight.recess).toBeLessThan(3 * b.module);
    expect(tight.ground).toBe(0);
  });

  it('starts a recessed flight on the footway, not in the verge beside it', () => {
    const b = building();
    // Half a unit of verge between the facade and the footway, shaped down
    // with the road well below the paving.
    const land = (_x: number, y: number): number => (y >= 100 ? 1 : -2);
    const door = doorOf(foundationOf(b, land, undefined, pavingFrom(0.5)));
    expect(door.recess).toBeGreaterThan(0);
    expect(door.ground).toBe(0);
    expect(door.threshold).toBeGreaterThan(0.4);
    expect(door.threshold).toBeLessThanOrEqual(0.5);
  });

  it('reads the footway an entrance opens onto, not the land shaped under it', () => {
    const b = building();
    // The land falls away under the road in front; the footway stays up.
    const land = (_x: number, y: number): number => (y >= 100 ? 0 : -4);
    expect(doorOf(foundationOf(b, land)).steps).toBeGreaterThan(5);
    const door = doorOf(foundationOf(b, land, undefined, pavingFrom(0.3, 0.1)));
    expect(door.ground).toBeCloseTo(0.1, 9);
    expect(door.steps).toBe(0);
  });

  it('never stands a door below the paving it opens onto', () => {
    const b = building();
    const raised = pavingFrom(0.3, 2);
    const f = foundationOf(b, flat, undefined, raised);
    expect(f.floor).toBeCloseTo(2 + PLINTH_MIN, 9);
    expect(floorHeight(b, flat, raised)).toBeCloseTo(f.floor, 9);
    expect(doorOf(f).steps).toBe(0);
  });

  it('refuses a site steeper than the plinth can take', () => {
    const doc = new RoadDoc();
    const b = building();
    const steep = (x: number): number => (x - 100) * (MAX_PLINTH / 10);
    expect(validateBuilding({ doc, net: null, groundAt: steep }, b)).toBe('slope');
    expect(validateBuilding({ doc, net: null, groundAt: flat }, b)).toBeNull();
  });
});

describe('validation', () => {
  it('rejects overlapping volumes and volumes over nothing', () => {
    const b = building();
    b.volumes.push({ ...JSON.parse(JSON.stringify(b.volumes[0])), id: 2, x: 2 });
    expect(structuralProblem(b)).toBe('overlap');
    const c = building();
    c.volumes.push({ ...JSON.parse(JSON.stringify(c.volumes[0])), id: 2, x: 3, base: 3, w: 3 });
    expect(structuralProblem(c)).toBe('support');
  });

  it('rejects a building on a road, and one on another building, but allows a terrace', () => {
    const doc = new RoadDoc();
    const a = doc.addNode({ x: -300, y: 0 });
    const z = doc.addNode({ x: 300, y: 0 });
    doc.addSegment(a.id, z.id, 1);
    const net = new Network(doc);
    net.rebuild();
    const ctx = { doc, net, groundAt: flat };
    expect(validateBuilding(ctx, building({ x: -10, y: -5 }))).toBe('road');
    const first = building({ x: 0, y: 40 });
    expect(validateBuilding(ctx, first)).toBeNull();
    doc.buildings.add(first);
    expect(validateBuilding(ctx, building({ id: asBuildingId(9), x: 10, y: 45 }))).toBe('building');
    // Flush against it: a terrace, which must be allowed.
    const terrace = building({ id: asBuildingId(9), x: 4 * first.module, y: 40 });
    expect(validateBuilding(ctx, terrace)).toBeNull();
  });

  it('rejects a building off the map', () => {
    const doc = new RoadDoc();
    expect(validateBuilding({ doc, net: null, groundAt: null }, building({ x: 2395, y: 0 }))).toBe('bounds');
  });

  it('treats touching rectangles as not overlapping', () => {
    const a = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }];
    const b = a.map((p) => ({ x: p.x + 10, y: p.y }));
    const c = a.map((p) => ({ x: p.x + 9, y: p.y + 3 }));
    expect(convexOverlap(a, b)).toBe(false);
    expect(convexOverlap(a, c)).toBe(true);
  });

  it('keeps every built-in preset valid on flat open ground', () => {
    const doc = new RoadDoc();
    for (const bp of BLUEPRINTS) {
      const b = { ...bp.body, id: asBuildingId(1), x: 0, y: 0, rotation: 0.4 } as Building;
      expect(validateBuilding({ doc, net: null, groundAt: flat }, b), bp.key).toBeNull();
    }
  });
});

describe('picking', () => {
  it('hits the facade bay and storey under a ray', () => {
    const b = building({ x: 0, y: 0 });
    // Looking north (+y) at the front face, level 1, bay 2.
    const bayX = 2.5 * b.module;
    const z = levelElevation(b, 1) + 2;
    const hit = pickBuilding([b], { ox: bayX, oy: -100, oz: z, dx: 0, dy: 1, dz: 0 }, () => 0)!;
    expect(hit).not.toBeNull();
    expect(hit.face).toBe(0);
    expect(hit.index).toBe(2);
    expect(hit.level).toBe(1);
    // From above: the roof.
    const top = pickBuilding([b], { ox: 5, oy: 5, oz: 500, dx: 0, dy: 0, dz: -1 }, () => 0)!;
    expect(top.face).toBe('top');
  });
});

describe('serialisation', () => {
  it('writes no buildings key for a map without buildings', () => {
    const doc = new RoadDoc();
    doc.addNode({ x: 0, y: 0 });
    expect('buildings' in doc.toJSON()).toBe(false);
  });

  it('round-trips every building field through the document', () => {
    const doc = new RoadDoc();
    for (const bp of BLUEPRINTS) doc.buildings.add({ ...bp.body, x: 10, y: 20, rotation: 0.5 } as Building);
    const json = JSON.parse(JSON.stringify(doc.toJSON()));
    expect(isSerializedDoc(json)).toBe(true);
    const back = RoadDoc.fromJSON(json);
    expect(back.toJSON().buildings).toEqual(doc.toJSON().buildings);
    // The allocator survives: a new building does not reuse an id.
    const next = back.buildings.add({ ...generateBody('commercial', 2, 2, 1), x: 0, y: 0, rotation: 0 } as Building);
    expect(next.id).toBe(BLUEPRINTS.length + 1);
  });

  it('loads a map saved before buildings existed', () => {
    const old = { version: 1, nodes: [{ id: 1, x: 0, y: 0 }, { id: 2, x: 100, y: 0 }], segments: [{ id: 1, a: 1, b: 2, type: 1, curve: null }] };
    expect(isSerializedDoc(old)).toBe(true);
    const doc = RoadDoc.fromJSON(old as never);
    expect(doc.buildings.size).toBe(0);
    expect(doc.segments.size).toBe(1);
  });

  it('repairs a damaged building and drops an unreadable one, keeping the map', () => {
    const good = { ...generateBody('residential', 3, 3, 2), id: 1, x: 0, y: 0, rotation: 0 };
    const damaged = {
      ...generateBody('commercial', 3, 3, 2),
      id: 2, x: 50, y: 0, rotation: 0,
      module: 999, use: 'castle', palette: -4,
      future: { keep: true },
    } as Record<string, unknown>;
    (damaged.volumes as Record<string, unknown>[])[0]!.roof = 'dome';
    const doc = RoadDoc.fromJSON({ version: 1, nodes: [], segments: [], buildings: [good, damaged, { id: 3 }, 'x'] } as never);
    expect(doc.buildings.size).toBe(2);
    const repaired = doc.buildings.get(asBuildingId(2))!;
    expect(repaired.use).toBe('residential');
    expect(repaired.volumes[0]!.roof).toBe('flat');
    expect(repaired.palette).toBe(0);
    expect(structuralProblem(repaired)).toBeNull();
    // A field this build does not know survives the round trip.
    expect((repaired as unknown as Record<string, unknown>).future).toEqual({ keep: true });
  });

  it('migrates a storey with unknown components to its fill', () => {
    const raw = { ...generateBody('residential', 2, 2, 1), id: 4, x: 0, y: 0 } as Record<string, unknown>;
    const v = (raw.volumes as Record<string, unknown>[])[0]!;
    v.storeys = [{ facade: { fill: 'hologram', bays: { '0:0': 'door', '9:1': 'door', '0:1': 'lava' } } }];
    const b = migrateBuilding(raw)!;
    expect(b.volumes[0]!.storeys[0]!.facade).toEqual({ fill: 'window', bays: { '0:0': 'door' } });
  });

  it('keeps the buildings revision still when a road-only replace leaves them equal', () => {
    const doc = new RoadDoc();
    doc.buildings.add({ ...generateBody('residential', 3, 3, 2), x: 0, y: 0, rotation: 0 } as Building);
    const before = doc.buildings.revision;
    const clone = doc.clone();
    clone.addNode({ x: 500, y: 500 });
    doc.replaceWith(clone);
    expect(doc.buildings.revision).toBe(before);
  });
});

describe('extension points', () => {
  it('derives default spaces and floor area from the volumes', () => {
    const b = building();
    const spaces = deriveSpaces(b);
    expect(spaces).toHaveLength(3);
    expect(spaces[0]!.spaces.length).toBeGreaterThan(0);
    expect(floorArea(b)).toBeCloseTo(4 * 3 * 3 * b.module * b.module, 6);
  });

  it('has a footprint for every ground volume', () => {
    expect(footprintRects(building())).toHaveLength(1);
  });
});

describe('materials', () => {
  const brick = { finish: 'brick', colour: 0xa4563f } as const;
  const glass = { finish: 'glass', colour: 0x9fb8c4 } as const;

  it('resolves a wall from the side, the volume, the building, then the palette', () => {
    const b = building();
    const v = b.volumes[0]!;
    expect(wallMaterial(b, v, 0)).toEqual(PALETTE_MATERIALS[b.palette]!.wall);
    applyMaterial(b, { scope: 'building', slot: 'wall' }, brick);
    expect(wallMaterial(b, v, 0)).toEqual(brick);
    applyMaterial(b, { scope: 'side', volume: v.id, side: 1 }, glass);
    expect(wallMaterial(b, v, 1)).toEqual(glass);
    expect(wallMaterial(b, v, 0)).toEqual(brick);
    // A wider scope repaints everything under it.
    applyMaterial(b, { scope: 'building', slot: 'wall' }, { finish: 'plaster', colour: 0xffffff });
    expect(wallMaterial(b, v, 1).finish).toBe('plaster');
    expect(v.materials).toBeUndefined();
  });

  it('gives a flat roof a slab and a pitched one the palette tiles until told otherwise', () => {
    const b = building();
    const v = b.volumes[0]!;
    v.roof = 'flat';
    expect(roofMaterial(b, v).finish).toBe('concrete');
    v.roof = 'gable';
    expect(roofMaterial(b, v)).toEqual(PALETTE_MATERIALS[b.palette]!.roof);
    expect(applyMaterial(b, { scope: 'volume', volume: v.id, slot: 'roof' }, { finish: 'metal', colour: 0x333333 })).toBe(true);
    expect(roofMaterial(b, v).finish).toBe('metal');
    expect(applyMaterial(b, { scope: 'volume', volume: v.id, slot: 'roof' }, { finish: 'metal', colour: 0x333333 })).toBe(false);
  });

  it('keeps valid materials through a round trip and drops broken ones', () => {
    const b = building();
    applyMaterial(b, { scope: 'building', slot: 'trim' }, glass);
    applyMaterial(b, { scope: 'side', volume: b.volumes[0]!.id, side: 2 }, brick);
    const back = migrateBuilding(JSON.parse(JSON.stringify(b)))!;
    expect(back.materials?.trim).toEqual(glass);
    expect(back.volumes[0]!.materials?.sides?.[2]).toEqual(brick);
    const broken = migrateBuilding({ ...JSON.parse(JSON.stringify(b)), materials: { wall: { finish: 'cheese', colour: 1 }, roof: { finish: 'tile', colour: -5 } } })!;
    expect(broken.materials).toBeUndefined();
  });
});
