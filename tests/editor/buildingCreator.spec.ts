import { describe, expect, it } from 'vitest';
import { asBuildingId, componentAt, type Building } from '@world/buildings/types';
import { shapeBody, addPlanMass, addShapedUpperMass, cutPlanMass } from '@editor/buildingPlans';
import { opAddSetback } from '@editor/buildings';
import { applyFacadePattern, updateFacadeGeometry } from '@editor/buildingFacade';
import { addRoofDetail, removeRoofDetail, updateRoofDetail } from '@editor/buildingRoofs';
import { migrateBuilding } from '@world/buildings/serialize';
import { applyMaterial, wallMaterial } from '@world/buildings/materials';
import { structuralProblem } from '@world/buildings/validate';
import { baysOn, levelElevation } from '@world/buildings/geometry';
import { m, METERS_PER_UNIT } from '@world/units';

const building = (): Building => ({ ...shapeBody('l', 50, 40, 2), id: asBuildingId(1), x: 0, y: 0, rotation: 0 });

describe('complete building creation grammar', () => {
  it('honours exact upper-mass dimensions with the matched footprint', () => {
    const b = { ...shapeBody('rectangle', m(12), m(9), 2), id: asBuildingId(3),
      x: 0, y: 0, rotation: 0 } as Building;
    const id = addShapedUpperMass(b, 1, 'match', m(1), 3,
      { width: m(5), depth: m(4), offsetX: m(1) });
    const top = b.volumes.find((v) => v.id === id)!;
    expect(top.w).toBeCloseTo(m(5), 6);
    expect(top.d).toBeCloseTo(m(4), 6);
    expect(top.storeys).toHaveLength(3);
    expect(structuralProblem(b)).toBeNull();
    expect(migrateBuilding(JSON.parse(JSON.stringify(b)))?.volumes.find((v) => v.id === id)?.w).toBeCloseTo(m(5), 6);
  });
  it('assembles a 35-floor stepped landmark from editable masses, flank blocks and a glazed lookout', () => {
    const b = { ...shapeBody('rectangle', m(26), m(28), 2), id: asBuildingId(20),
      x: 0, y: 0, rotation: 0 } as Building;
    b.storeyHeight = m(4.3);
    const podium = b.volumes[0]!;
    const shaft = opAddSetback(b, podium.id, m(3), 20)!;
    const shoulder = opAddSetback(b, shaft, m(3), 9)!;
    const crown = addShapedUpperMass(b, shoulder, 'rectangle', m(1), 2)!;
    const lookout = addShapedUpperMass(b, crown, 'circle', m(1), 2)!;
    expect([shaft, shoulder, crown, lookout].every(Number.isInteger)).toBe(true);
    expect(addShapedUpperMass(b, shaft, 'rectangle', 0, 5,
      { width: m(2), depth: m(10), offsetX: m(9) })).not.toBeNull();
    expect(addShapedUpperMass(b, shaft, 'rectangle', 0, 5,
      { width: m(2), depth: m(10), offsetX: m(-9) })).not.toBeNull();
    const top = b.volumes.find((v) => v.id === lookout)!;
    expect(addRoofDetail(b, lookout, 'spire', { x: top.x + top.w / 2, y: top.y + top.d / 2 })).toBe(1);
    expect(updateRoofDetail(b, lookout, 1, { flag: 'saoPaulo' })).toBe(true);
    expect(applyFacadePattern(b, { scope: 'building' }, 'artDeco')).toBe(true);
    expect(applyFacadePattern(b, { scope: 'volume', volume: shoulder }, 'artDecoCrown')).toBe(true);
    expect(applyFacadePattern(b, { scope: 'volume', volume: lookout }, 'observation')).toBe(true);
    expect(structuralProblem(b)).toBeNull();
    expect(top.base + top.storeys.length).toBe(35);
    const metres = (levelElevation(b, 35) + top.roofDetails![0]!.h!) * METERS_PER_UNIT;
    expect(metres).toBeGreaterThan(160);
    expect(metres).toBeLessThan(163);
    const ground = podium.storeys[0]!.facade;
    expect(Array.from({ length: baysOn(b, podium, 0) }, (_, index) => componentAt(ground, 0, index)).filter((c) => c === 'door')).toHaveLength(1);
    const loaded = migrateBuilding(JSON.parse(JSON.stringify(b)))!;
    expect(loaded.volumes.find((v) => v.id === lookout)?.facadePattern).toBe('observation');
    expect(loaded.volumes.find((v) => v.id === lookout)?.roofDetails?.[0]?.h).toBe(m(11.7));
    expect(loaded.volumes.find((v) => v.id === lookout)?.roofDetails?.[0]?.flag).toBe('saoPaulo');
  });
  it('composes ground and upper masses, then cuts a notch without corrupting support', () => {
    const b = building();
    const first = b.volumes[0]!;
    expect(addRoofDetail(b, first.id, 'solar', { x: 10, y: 8 })).toBe(1);
    const ground = addPlanMass(b, first.id,
      [{ x: 50, y: 0 }, { x: 70, y: 0 }, { x: 70, y: 16 }, { x: 50, y: 16 }], 0, 1);
    expect(ground).not.toBeNull();
    const top = addPlanMass(b, first.id,
      [{ x: 6, y: 4 }, { x: 30, y: 4 }, { x: 30, y: 15 }, { x: 6, y: 15 }], 2, 3);
    expect(top).not.toBeNull();
    expect(first.roofDetails).toHaveLength(0);
    expect(structuralProblem(b)).toBeNull();
    expect(cutPlanMass(b, ground!, [{ x: 58, y: -2 }, { x: 72, y: -2 }, { x: 72, y: 6 }, { x: 58, y: 6 }])).toBe(true);
    expect(structuralProblem(b)).toBeNull();
    expect(migrateBuilding(JSON.parse(JSON.stringify(b)))?.volumes).toHaveLength(3);
  });

  it('applies building, face and floor compositions while preserving individual overrides', () => {
    const b = building(), v = b.volumes[0]!;
    expect(applyFacadePattern(b, { scope: 'building' }, 'industrial')).toBe(true);
    expect(b.use).toBe('industrial');
    expect(componentAt(v.storeys[0]!.facade, 0, 0)).toBe('loadingDoor');
    expect(applyFacadePattern(b, { scope: 'face', volume: v.id, face: 4 }, 'storefront')).toBe(true);
    expect(v.storeys[0]!.facade.sides?.[4]).toBe('shopfront');
    expect(componentAt(v.storeys[0]!.facade, 0, 0)).toBe('loadingDoor');
    expect(applyFacadePattern(b, { scope: 'floor', volume: v.id, floor: 1 }, 'office')).toBe(true);
    expect(v.storeys[1]!.facade.sides?.[4]).toBe('wideWindow');
    expect(migrateBuilding(JSON.parse(JSON.stringify(b)))?.volumes[0]?.facadePattern).toBe('industrial');
  });

  it('lets each face have a measured bay rhythm and preserves painted bays when it changes', () => {
    const b = building(), v = b.volumes[0]!;
    const before = baysOn(b, v, 0);
    v.storeys[1]!.facade.bays = { [`0:${before - 1}`]: 'door' };
    v.reliefs = [{ side: 0, bay0: before - 2, bay1: before - 1, storey0: 1, storey1: 1, depth: m(.5) }];
    expect(updateFacadeGeometry(b, v.id, 0, { bays: 12, windowWidth: .5,
      windowHeight: .55, sill: m(.9), pierWidth: m(.45), pierDepth: m(.6), pierEvery: 2 })).toBe(true);
    expect(baysOn(b, v, 0)).toBe(12);
    expect(baysOn(b, v, 1)).not.toBe(12);
    expect(Object.values(v.storeys[1]!.facade.bays ?? {})).toContain('door');
    expect(v.reliefs?.[0]?.bay1).toBe(11);
    expect(structuralProblem(b)).toBeNull();
    expect(migrateBuilding(JSON.parse(JSON.stringify(b)))?.volumes[0]?.facadeGeometry?.[0]?.pierDepth).toBe(m(.6));
  });

  it('places, moves, rotates, removes and reloads real roof parts', () => {
    const b = building(), v = b.volumes[0]!;
    const id = addRoofDetail(b, v.id, 'solar', { x: 10, y: 8 });
    expect(id).toBe(1);
    expect(addRoofDetail(b, v.id, 'vent', { x: 12, y: 10 })).toBe(2);
    expect(updateRoofDetail(b, v.id, id!, { x: 12, rotation: Math.PI / 2 })).toBe(true);
    expect(updateRoofDetail(b, v.id, id!, { x: 1000 })).toBe(false);
    expect(migrateBuilding(JSON.parse(JSON.stringify(b)))?.volumes[0]?.roofDetails).toHaveLength(2);
    expect(removeRoofDetail(b, v.id, id!)).toBe(true);
    expect(v.roofDetails).toHaveLength(1);
  });

  it('paints one floor without changing the floor below, and saves its finish', () => {
    const b = building(), v = b.volumes[0]!;
    const ground = wallMaterial(b, v, 0, 0);
    const brick = { finish: 'brick' as const, colour: 0x985d42 };
    expect(applyMaterial(b, { scope: 'floor', volume: v.id, floor: 1, face: 0 }, brick)).toBe(true);
    expect(wallMaterial(b, v, 0, 1)).toEqual(brick);
    expect(wallMaterial(b, v, 0, 0)).toEqual(ground);
    const loaded = migrateBuilding(JSON.parse(JSON.stringify(b)))!;
    expect(wallMaterial(loaded, loaded.volumes[0]!, 0, 1)).toEqual(brick);
  });
});
