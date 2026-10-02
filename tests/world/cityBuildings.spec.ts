import { describe, expect, it } from 'vitest';
import { CITY_BUILDINGS } from '@world/buildings/cityBuildings';
import { instantiate } from '@world/buildings/blueprints';
import { structuralProblem } from '@world/buildings/validate';
import { BUILDING_FUNCTIONS, type Building, asBuildingId } from '@world/buildings/types';

/** Every building of the city's catalogue stands as it is placed, and every function has one. */
describe('city buildings', () => {
  it('has a model for every function', () => {
    const made = new Set(CITY_BUILDINGS.map((b) => b.fn));
    expect(BUILDING_FUNCTIONS.filter((fn) => !made.has(fn))).toEqual([]);
  });

  for (const model of CITY_BUILDINGS) {
    it(`${model.fn} stands`, () => {
      const b = { ...instantiate(model.body, { x: 0, y: 0 }, 0, model.fn), id: asBuildingId(1) } as Building;
      expect(structuralProblem(b)).toBeNull();
      expect(b.function).toBe(model.fn);
    });
  }
});
