import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { describe, expect, it } from 'vitest';
import { CastingRegistry, CROWD, compatible, type CitizenModel } from '@render/citizenCasting';

/**
 * ONE DOOR INTO THE ROSTER. The street had a footballer, a pilot and a man in
 * a suit walking as one party because four code paths each picked bodies from
 * the whole roster. Now only `citizenCasting.ts` reads the reviewed manifest
 * and the catalog of shipped models; every figure the game draws - walker,
 * party member, driver, passenger, rider, somebody at the kerb - is cast by
 * its `pickCitizenModel`. Any other module reaching for the roster fails here.
 */
const SRC = join(process.cwd(), 'src');
const ALLOWED = new Set(['render/citizenCasting.ts', 'render/citizenCatalog.ts']);
const ROSTER = /citizens\.manifest|citizenCatalog|CITIZEN_CATALOG|CITIZEN_MODELS/;

function tsFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...tsFilesUnder(path));
    else if (entry.endsWith('.ts')) out.push(path);
  }
  return out;
}

const code = (source: string): string => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

describe('citizen casting', () => {
  it('is the only module that reads the roster', () => {
    const offenders = tsFilesUnder(SRC)
      .map((file) => relative(SRC, file).split(sep).join('/'))
      .filter((file) => !ALLOWED.has(file) && ROSTER.test(code(readFileSync(join(SRC, file), 'utf8'))));
    expect(offenders).toEqual([]);
  });

  it('casts every child as a child body even when nearby child models are already worn', () => {
    const casting = new CastingRegistry();
    casting.beginFrame();
    for (let seed = 1; seed <= 40; seed++) {
      const body = casting.pickCitizenModel({
        seed, gender: seed % 2 ? 'f' : 'm', ageClass: 'child',
        company: 'family', companyId: Math.ceil(seed / 4), hasChild: true,
        x: 0, y: 0,
      });
      expect(body, `child ${seed}`).not.toBeNull();
      expect(CROWD[body!.index]!.ageBand, `child ${seed}`).toBe('child');
      expect(body!.size, `child ${seed}`).toBe(1);
    }
  });

  it('keeps a picked-up walker recognizable while recasting incompatible car occupants', () => {
    const roster: CitizenModel[] = [
      { id: 'smart', wardrobe: 'smart-casual', ageBand: 'adult', gender: 'f' },
      { id: 'sport', wardrobe: 'sport-casual', ageBand: 'adult', gender: 'f' },
      { id: 'casual', wardrobe: 'casual', ageBand: 'adult', gender: 'f' },
    ];
    let checked = false;
    for (let vehicleId = 1; vehicleId <= 100 && !checked; vehicleId++) {
      const casting = new CastingRegistry(roster);
      const walker = { seed: 7, gender: 'f' as const, ageClass: 'adult' as const,
        company: 'colleagues' as const, companyId: 700, x: 0, y: 0 };
      const car = { ...walker, seed: 10_000 + vehicleId, company: 'car' as const, companyId: vehicleId };
      const beforeWalker = casting.pickCitizenModel(walker)!;
      const beforeCar = casting.pickCitizenModel(car)!;
      if (roster[beforeCar.index]?.wardrobe !== 'sport-casual') continue;
      const boarded = casting.pickCitizenModel({ ...walker, company: 'car', companyId: vehicleId })!;
      const afterCar = casting.pickCitizenModel(car)!;
      expect(boarded.index).toBe(beforeWalker.index);
      expect(compatible(roster[boarded.index]!.wardrobe, roster[afterCar.index]!.wardrobe)).toBe(true);
      checked = true;
    }
    expect(checked).toBe(true);
  });
});
