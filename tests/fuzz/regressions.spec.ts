import { describe, expect, it } from 'vitest';
import { loadFixtures, replay } from './support/runner';

/**
 * Every defect the fuzzer ever shrank, replayed for ever.
 *
 * A fixture with `open` is a defect that is recorded but not fixed: it runs
 * as `it.fails`, so the day it is fixed the suite says so and the flag must
 * be removed. The name says what broke; `detail` is what it looked like.
 */
describe('fuzz regressions', () => {
  for (const fixture of loadFixtures()) {
    const test = fixture.open ? it.fails : it;
    test(`${fixture.name}: ${fixture.category}${fixture.open ? ' (open)' : ''}`, () => {
      const outcome = replay(fixture.ops, fixture.sim, fixture.category);
      expect(outcome.defects).toEqual([]);
    });
  }
  it('has a fixture directory the loader can read', () => {
    expect(Array.isArray(loadFixtures())).toBe(true);
  });
});
