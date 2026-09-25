import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { describe, expect, it } from 'vitest';

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
});
