import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { DEFAULT_MACRO, ageFromYears, macroTargetWeights, yearsFromAge, type MacroParams } from '@people/body/macro';
import { Morpher, bodyHeight, type PeoplePacks } from '@people/body/morph';

const DIR = join(__dirname, '..', '..', 'public', 'models', 'people');
const buf = (f: string): ArrayBuffer => {
  const b = readFileSync(join(DIR, f));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
};
const json = <T>(f: string): T => JSON.parse(readFileSync(join(DIR, f), 'utf8')) as T;
const packs: PeoplePacks = {
  base: json('base.json'), baseBin: buf('base.bin'),
  macro: json('targets-macro-pca.json'), macroBin: buf('targets-macro-pca.bin'),
  local: json('targets-local.json'), localBin: buf('targets-local.bin'),
  modifiers: json('modifiers.json'),
};
const morpher = new Morpher(packs);
const body = packs.base.vertexGroups['body']!;
/** Metres: the packs are in decimetres. */
const heightOf = (p: Partial<MacroParams>): number => bodyHeight(morpher.shape({ ...DEFAULT_MACRO, ...p }), body) / 10;

describe('person model: macro weights', () => {
  it('splits each combination\'s weight of one between its targets', () => {
    const names = packs.macro.targets.map((t) => t.name);
    for (const params of [DEFAULT_MACRO, { ...DEFAULT_MACRO, gender: 0.8, age: 0.3, muscle: 0.9, weight: 0.1 }]) {
      const w = macroTargetWeights(packs.modifiers.macro, names, params);
      const sum = (prefix: RegExp): number => [...w].filter(([n]) => prefix.test(n)).reduce((s, [, v]) => s + v, 0);
      expect(sum(/\/universal-/)).toBeCloseTo(1, 6);
      expect(sum(/\/(african|asian|caucasian)-/)).toBeCloseTo(1, 6);
      // Height and proportions at their neutral move nothing.
      expect(sum(/\/height\//)).toBeCloseTo(0, 6);
    }
  });

  it('reads years on MakeHuman\'s age scale and back', () => {
    for (const years of [1, 5, 11, 18, 25, 40, 70, 90]) expect(yearsFromAge(ageFromYears(years))).toBeCloseTo(years, 6);
    expect(ageFromYears(25)).toBeCloseTo(0.5, 6);
  });
});

describe('person model: bodies', () => {
  it('builds adults, children and babies of believable heights', () => {
    const woman = heightOf({ gender: 0, age: ageFromYears(30) });
    const man = heightOf({ gender: 1, age: ageFromYears(30) });
    const child = heightOf({ gender: 0.5, age: ageFromYears(8) });
    const baby = heightOf({ gender: 0.5, age: ageFromYears(1) });
    expect(woman).toBeGreaterThan(1.5);
    expect(woman).toBeLessThan(1.8);
    expect(man).toBeGreaterThan(woman);
    expect(man).toBeLessThan(1.95);
    expect(child).toBeGreaterThan(1.0);
    expect(child).toBeLessThan(woman);
    expect(baby).toBeGreaterThan(0.5);
    expect(baby).toBeLessThan(child);
  });

  it('grows with the height slider, and is unchanged by sliders at neutral', () => {
    const short = heightOf({ height: 0 });
    const mid = heightOf({});
    const tall = heightOf({ height: 1 });
    expect(short).toBeLessThan(mid - 0.05);
    expect(tall).toBeGreaterThan(mid + 0.05);
  });

  it('moves only the nose for a nose slider', () => {
    const plain = morpher.shape(DEFAULT_MACRO);
    const nosed = morpher.shape(DEFAULT_MACRO, { 'nose-flaring-decr-incr': 1 });
    let moved = 0;
    let highest = Infinity;
    for (let v = 0; v < morpher.vertexCount; v++) {
      const d = Math.hypot(nosed[v * 3]! - plain[v * 3]!, nosed[v * 3 + 1]! - plain[v * 3 + 1]!, nosed[v * 3 + 2]! - plain[v * 3 + 2]!);
      if (d > 1e-4) {
        moved++;
        highest = Math.min(highest, plain[v * 3 + 1]!);
      }
    }
    expect(moved).toBeGreaterThan(10);
    expect(moved).toBeLessThan(2000);
    // All of it on the head, well above the shoulders of a 1.7 m body.
    expect(highest / 10).toBeGreaterThan(0.6);
  });

  it('morphs a whole body in a few milliseconds', () => {
    const out = new Float32Array(morpher.vertexCount * 3);
    morpher.shape(DEFAULT_MACRO, {}, out);
    const t0 = performance.now();
    for (let i = 0; i < 5; i++) morpher.shape({ ...DEFAULT_MACRO, gender: i / 4, age: 0.2 + i * 0.15 }, {}, out);
    const each = (performance.now() - t0) / 5;
    expect(each).toBeLessThan(200);
    console.log(`morph ${each.toFixed(1)} ms per body`);
  });
});
