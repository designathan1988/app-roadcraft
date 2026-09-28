import { describe, expect, it } from 'vitest';
import { RoadDoc } from '@world/doc';
import { generateBlock } from '@world/buildings/blueprints';
import { asBuildingId, type Building } from '@world/buildings/types';
import { localFootprint, overlapArea } from '@world/buildings/footprints';
import { facadeBays, footprintRects, isSupported } from '@world/buildings/geometry';
import { migrateBuilding } from '@world/buildings/serialize';
import { validateBuilding } from '@world/buildings/validate';
import { pickBuilding } from '@world/buildings/pick';
import { shapePoints, shapeBody, setVolumePlan, movePlanVertex, changePlanVertex } from '@editor/buildingPlans';
import { opAddSetback, opAddWing, opMirror } from '@editor/buildings';

const building = (shape: 'rectangle' | 'l' | 'u' | 'circle' | 'hexagon' | 'octagon'): Building =>
  ({ ...shapeBody(shape, 40, 30, 2), id: asBuildingId(1), x: 100, y: 100, rotation: 0 });

describe('free building plans', () => {
  it('validates, saves and exposes bays along every polygon edge', () => {
    for (const shape of ['l', 'u', 'circle', 'hexagon', 'octagon'] as const) {
      const b = building(shape);
      expect(validateBuilding({ doc: new RoadDoc(), net: null, groundAt: () => 0 }, b)).toBeNull();
      expect(facadeBays(b).some((bay) => bay.side >= 4)).toBe(true);
      const loaded = migrateBuilding(JSON.parse(JSON.stringify(b)))!;
      expect(loaded.volumes[0]!.outline).toEqual(shapePoints(shape));
    }
  });

  it('leaves the empty part of an L free for another building', () => {
    const b = building('l');
    const ring = footprintRects(b)[0]!;
    const notch = [{ x: 132, y: 116 }, { x: 138, y: 116 }, { x: 138, y: 127 }, { x: 132, y: 127 }];
    expect(overlapArea(ring, notch)).toBe(0);
    const touching = [{ x: 100, y: 100 }, { x: 110, y: 100 }, { x: 110, y: 110 }, { x: 100, y: 110 }];
    expect(overlapArea(ring, touching)).toBeGreaterThan(0);
  });

  it('refuses a self-crossing vertex and keeps a stacked volume supported', () => {
    const b = building('l');
    const first = b.volumes[0]!;
    const original = localFootprint(first);
    expect(movePlanVertex(b, first.id, 3, { x: first.x - 10, y: first.y + 20 })).toBe(false);
    expect(localFootprint(first)).toEqual(original);
    const top = structuredClone(first);
    top.id = 2;
    top.base = 2;
    top.storeys = [top.storeys[0]!];
    b.volumes.push(top);
    expect(isSupported(b, top)).toBe(true);
    delete top.outline;
    expect(isSupported(b, top)).toBe(false);
  });

  it('supports adding and removing contour points and rejects a bowtie', () => {
    const b = building('hexagon');
    const v = b.volumes[0]!;
    v.storeys[0]!.facade.sides = { 0: 'shopfront', 2: 'door' };
    v.storeys[0]!.facade.bays = { '2:0': 'loadingDoor' };
    expect(changePlanVertex(b, v.id, 0, false)).toBe(true);
    expect(v.outline).toHaveLength(7);
    expect(v.storeys[0]!.facade.sides?.[3]).toBe('door');
    expect(v.storeys[0]!.facade.bays?.['3:0']).toBe('loadingDoor');
    expect(changePlanVertex(b, v.id, 1, true)).toBe(true);
    expect(v.outline).toHaveLength(6);
    const raw = generateBlock(30, 30, 2).volumes[0]!;
    expect(setVolumePlan(raw, [{ x: 0, y: 0 }, { x: 30, y: 30 }, { x: 30, y: 0 }, { x: 0, y: 30 }])).toBe(false);
  });

  it('picks walls and roofs but leaves the open notch unselectable', () => {
    const b = building('l');
    const vertical = (x: number, y: number) => ({ ox: x, oy: y, oz: 200, dx: 0, dy: 0, dz: -1 });
    expect(pickBuilding([b], vertical(135, 125), () => 0)).toBeNull();
    expect(pickBuilding([b], vertical(106, 105), () => 0)?.face).toBe('top');
    const wall = pickBuilding([b], { ox: 100, oy: 80, oz: 10, dx: 0, dy: 1, dz: 0 }, () => 0);
    expect(wall?.face).toBe(0);
  });

  it('round-trips finishes, openings and relief on later polygon edges', () => {
    const b = building('u');
    const v = b.volumes[0]!;
    v.storeys[0]!.facade.sides = { 5: 'shopfront' };
    v.storeys[0]!.facade.bays = { '5:0': 'door' };
    v.materials = { sides: { 5: { finish: 'brick', colour: 0x873c29 } } };
    v.reliefs = [{ side: 5, bay0: 0, bay1: 0, storey0: 0, storey1: 0, depth: .25 }];
    const saved = migrateBuilding(JSON.parse(JSON.stringify(b)))!;
    expect(saved.volumes[0]!.storeys[0]!.facade.sides?.[5]).toBe('shopfront');
    expect(saved.volumes[0]!.storeys[0]!.facade.bays?.['5:0']).toBe('door');
    expect(saved.volumes[0]!.materials?.sides?.[5]?.colour).toBe(0x873c29);
    expect(saved.volumes[0]!.reliefs?.[0]?.side).toBe(5);
  });

  it('grows a wing from an inner edge and stacks a supported terrace', () => {
    const b = building('l');
    const origin = b.volumes[0]!;
    const setback = opAddSetback(b, origin.id);
    expect(setback).not.toBeNull();
    expect(isSupported(b, b.volumes.find((v) => v.id === setback)!)).toBe(true);
    const wing = opAddWing(b, origin.id, 4);
    expect(wing).not.toBeNull();
    expect(validateBuilding({ doc: new RoadDoc(), net: null, groundAt: () => 0 }, b)).toBeNull();
  });

  it('mirrors irregular massing and keeps face-specific styles attached', () => {
    const b = building('u'), v = b.volumes[0]!;
    const original = localFootprint(v);
    v.storeys[0]!.facade.sides = { 5: 'door' };
    opMirror(b);
    expect(v.storeys[0]!.facade.sides?.[1]).toBe('door');
    opMirror(b);
    for (const [i, p] of localFootprint(v).entries()) {
      expect(p.x).toBeCloseTo(original[i]!.x);
      expect(p.y).toBeCloseTo(original[i]!.y);
    }
    expect(v.storeys[0]!.facade.sides?.[5]).toBe('door');
  });
});
