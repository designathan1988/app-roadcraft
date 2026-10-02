import { describe, expect, it } from 'vitest';
import { instantiate } from '@world/buildings/blueprints';
import { cityBuilding } from '@world/buildings/cityBuildings';
import { LAMP_KINDS, furnishingOf, interiorAt } from '@world/buildings/interior';
import { migrateBuilding } from '@world/buildings/serialize';
import { type Building, asBuildingId } from '@world/buildings/types';

/** Furniture and lights as the player arranges them: stored per floor, saved, and lit. */
describe('furnishing', () => {
  const model = cityBuilding('apartments')!;
  const b = { ...instantiate(model.body, { x: 0, y: 0 }, 0, 'apartments'), id: asBuildingId(3), function: 'apartments' } as Building;

  it('furnishes a floor for its function with a light in every room', () => {
    const floor = interiorAt(b, 2).furniture;
    expect(floor.some((f) => f.kind === 'sofa')).toBe(true);
    expect(floor.filter((f) => LAMP_KINDS.has(f.kind)).length).toBeGreaterThan(0);
  });

  it('lays upper floors out as rooms between the windows, every desk with its chair', () => {
    const cases: [string, string, string][] = [['office', 'desk', 'officeChair'], ['school', 'desk', 'chair'], ['hotel', 'bed', 'tv'], ['hospital', 'wardBed', 'chair']];
    for (const [fn, piece, partner] of cases) {
      const model = cityBuilding(fn)!;
      const body = { ...instantiate(model.body, { x: 0, y: 0 }, 0, fn), id: asBuildingId(5), function: fn } as Building;
      const floor = interiorAt(body, 1);
      expect(floor.partitions.length, fn).toBeGreaterThan(2);
      const a = floor.furniture.filter((f) => f.kind === piece).length;
      const b2 = floor.furniture.filter((f) => f.kind === partner).length;
      expect(a, fn).toBeGreaterThan(1);
      // A desk without its chair (or a bed without its TV) means the room was laid out too tight.
      // (A classroom's teacher has a desk and no chair: one per board.)
      const teachers = floor.furniture.filter((f) => f.kind === 'blackboard').length;
      expect(b2, fn).toBeGreaterThanOrEqual(a - teachers);
    }
  });

  it('uses the arrangement the player made, and keeps it when saved', () => {
    const mine = furnishingOf(b, 2).filter((f) => f.kind !== 'tv');
    mine.push({ kind: 'floorLamp', x: 10, y: 10, angle: 0 });
    const edited: Building = { ...b, furnishing: { '2': mine } };
    const floor = interiorAt(edited, 2).furniture;
    expect(floor.some((f) => f.kind === 'tv')).toBe(false);
    expect(floor.some((f) => f.kind === 'floorLamp' && f.x === 10)).toBe(true);
    // Other floors are still furnished for the function.
    expect(interiorAt(edited, 3).furniture.some((f) => f.kind === 'tv')).toBe(true);
    const loaded = migrateBuilding(JSON.parse(JSON.stringify(edited)))!;
    expect(loaded.furnishing?.['2']).toEqual(mine);
  });
});
