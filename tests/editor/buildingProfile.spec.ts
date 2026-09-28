import { describe, expect, it } from 'vitest';
import { shapeBody } from '@editor/buildingPlans';
import { splitVolumeAtFloor, reshapeTier } from '@editor/buildingProfile';
import { opSetParameters, opSetLevelHeight } from '@editor/buildings';
import { addRoofDetail } from '@editor/buildingRoofs';
import { levelElevation } from '@world/buildings/geometry';
import { migrateBuilding } from '@world/buildings/serialize';
import { structuralProblem } from '@world/buildings/validate';
import { asBuildingId, type Building } from '@world/buildings/types';
import { m } from '@world/units';

const building = (): Building => ({ ...shapeBody('l', m(30), m(28), 20),
  id: asBuildingId(1), x: 0, y: 0, rotation: 0 });

describe('architectural floor profile', () => {
  it('splits a tier without changing height, support, details or face reliefs', () => {
    const b = building(), lower = b.volumes[0]!;
    lower.roof = 'gable';
    lower.reliefs = [{ side: 0, bay0: 0, bay1: 1, storey0: 2, storey1: 7, depth: m(.5) }];
    expect(addRoofDetail(b, lower.id, 'spire', { x: m(4), y: m(4) })).toBe(1);
    const before = levelElevation(b, 20);
    const id = splitVolumeAtFloor(b, lower.id, 5);
    const upper = b.volumes.find((v) => v.id === id)!;
    expect(lower.storeys).toHaveLength(5);
    expect(upper.storeys).toHaveLength(15);
    expect(upper.base).toBe(5);
    expect(lower.roof).toBe('terrace');
    expect(upper.roof).toBe('gable');
    expect(lower.roofDetails).toBeUndefined();
    expect(upper.roofDetails?.[0]?.kind).toBe('spire');
    expect(lower.reliefs?.[0]).toMatchObject({ storey0: 2, storey1: 4 });
    expect(upper.reliefs?.[0]).toMatchObject({ storey0: 0, storey1: 2 });
    expect(levelElevation(b, 20)).toBe(before);
    expect(structuralProblem(b)).toBeNull();
    expect(migrateBuilding(JSON.parse(JSON.stringify(b)))?.volumes).toHaveLength(2);
    expect(splitVolumeAtFloor(b, lower.id, 0)).toBeNull();
  });

  it('supports a monumental hall and one independently taller level', () => {
    const b = building();
    expect(opSetParameters(b, { groundHeight: m(16), storeyHeight: m(3.9) })).toBe(true);
    expect(opSetLevelHeight(b, 5, m(5.5))).toBe(true);
    expect(structuralProblem(b)).toBeNull();
    expect(levelElevation(b, 6)).toBeCloseTo(m(16 + 4 * 3.9 + 5.5));
    const loaded = migrateBuilding(JSON.parse(JSON.stringify(b)))!;
    expect(loaded.groundHeight).toBe(m(16));
    expect(loaded.levels?.[5]).toBe(m(5.5));
  });

  it('reshapes a top tier into an editable lantern without discarding facade direction', () => {
    const b = { ...shapeBody('rectangle', m(20), m(20), 6), id: asBuildingId(3),
      x: 0, y: 0, rotation: 0 } as Building;
    const upperId = splitVolumeAtFloor(b, 1, 4)!;
    const upper = b.volumes.find((v) => v.id === upperId)!;
    upper.facadeGeometry = { 0: { bays: 5, pierDepth: m(.4) } };
    upper.storeys[0]!.facade.patterns = { 0: 'artDeco' };
    expect(reshapeTier(b, upperId, 'circle')).toBe(true);
    expect(upper.outline).toHaveLength(24);
    expect(structuralProblem(b)).toBeNull();
    expect(Object.values(upper.facadeGeometry ?? {}).some((item) => item?.pierDepth === m(.4))).toBe(true);
    expect(Object.values(upper.storeys[0]!.facade.patterns ?? {})).toContain('artDeco');
    expect(migrateBuilding(JSON.parse(JSON.stringify(b)))?.volumes.find((v) => v.id === upperId)?.outline).toHaveLength(24);
  });
});
