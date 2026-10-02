import { describe, expect, it } from 'vitest';
import { instantiate } from '@world/buildings/blueprints';
import { cityBuilding } from '@world/buildings/cityBuildings';
import { type Building, type BuildingFunction, asBuildingId } from '@world/buildings/types';
import { derivePopulation, residentsOf } from '@sim/city/population';
import { diaryOf } from '@sim/city/life';

const place = (fn: BuildingFunction, id: number): Building => {
  const model = cityBuilding(fn)!;
  return { ...instantiate(model.body, { x: id * 200, y: 0 }, 0, fn), id: asBuildingId(id), function: fn } as Building;
};

/** The residents are read from the buildings, the same every time, with days that make sense. */
describe('city life', () => {
  const town = [place('house', 1), place('apartments', 2), place('school', 3), place('office', 4), place('bakery', 5), place('park', 6)];

  it('houses people in homes only, and gives the jobs out', () => {
    const p = derivePopulation(town);
    expect(residentsOf(town[0]!)).toBeGreaterThan(0);
    expect(residentsOf(town[3]!)).toBe(0);
    expect(p.residents.length).toBe(residentsOf(town[0]!) + residentsOf(town[1]!));
    for (const r of p.residents) expect([1, 2]).toContain(r.home);
    for (const [, j] of p.jobs) expect(j.taken).toBeLessThanOrEqual(j.offered);
    // Children go to the school.
    for (const r of p.residents) if (r.ageClass === 'child' && r.work !== null) expect(r.work).toBe(3);
  });

  it('is the same city every time it is read', () => {
    expect(derivePopulation(town)).toEqual(derivePopulation([...town].reverse()));
  });

  it('gives every resident a day that goes out and comes home', () => {
    for (const r of derivePopulation(town).residents) {
      const days = diaryOf(r);
      let at = r.home;
      for (let i = 0; i < days.length; i++) {
        expect(days[i]!.from).toBe(at);
        if (i > 0) expect(days[i]!.at).toBeGreaterThanOrEqual(days[i - 1]!.at);
        at = days[i]!.to;
      }
      expect(at).toBe(r.home);
    }
  });
});
