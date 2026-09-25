import { appendFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { applyOp, freshState } from './support/ops';
import { checkWorld, type Defect } from './support/invariants';
import { checkSim } from './support/simCheck';
import { generate, profile, replay, saveFixture, shrink } from './support/runner';

/**
 * THE DEFECT DETECTOR.
 *
 * Builds road networks with the editor's own commands (draw with snapping,
 * split, join, move, retype, lanes, one-way, structure, curve, bulldoze,
 * junction control), checks every world invariant after every gesture, then
 * drives traffic on the result and checks the bodies. See
 * `support/runner.ts` for the profiles and docs/fuzzing.md for how to use it.
 *
 * A failure prints the SHRUNK sequence. `FUZZ_RECORD=1` also writes it to
 * tests/fuzz/fixtures/, where `regressions.spec.ts` replays it for ever.
 */
const run = profile();
const first = Number(process.env['FUZZ_FIRST'] ?? 1);
const seeds = Array.from({ length: run.sequences }, (_, i) => first + i);

describe('road fuzzer', () => {
  it.skipIf(process.env['FUZZ_HUNT'] === '1')(`finds no defect in ${seeds.length} seeded sequences`, () => {
    const failures: unknown[] = [];
    for (const seed of seeds) {
      const ops = generate(seed, run.ops);
      const outcome = replay(ops, run.sim);
      if (!outcome.defects.length) continue;
      const worst = outcome.defects[0] as Defect;
      const minimal = shrink(ops, worst.category, run.sim);
      if (process.env['FUZZ_RECORD'] === '1') {
        saveFixture({ name: `${worst.category}-seed${seed}`, category: worst.category, detail: worst.detail,
          sim: outcome.step < 0 ? run.sim : null, ops: minimal });
      }
      failures.push({ seed, defect: worst, ops: minimal });
    }
    expect(failures).toEqual([]);
  });

  /**
   * Hunt mode (FUZZ_HUNT=1): never stops at the first defect. Tallies every
   * defect by category over every sequence, and records one shrunk fixture
   * per category (FUZZ_RECORD=1).
   */
  it.runIf(process.env['FUZZ_HUNT'] === '1')('tallies every defect by category', () => {
    const tally = new Map<string, { count: number; sequences: Set<number>; example: { seed: number; defect: Defect } }>();
    const note = (seed: number, d: Defect): void => {
      const entry = tally.get(d.category) ?? { count: 0, sequences: new Set<number>(), example: { seed, defect: d } };
      entry.count++;
      entry.sequences.add(seed);
      tally.set(d.category, entry);
    };
    for (const seed of seeds) {
      const ops = generate(seed, run.ops);
      const state = freshState();
      const seen = new Set<string>();
      let broken = false;
      for (let i = 0; i < ops.length; i++) {
        let defects: Defect[] = [];
        try {
          if (!applyOp(state, ops[i]!)) continue;
          defects = [...state.notes.splice(0), ...checkWorld(state.doc, state.net)];
        } catch (error) {
          defects = [{ category: 'exception', subject: `op ${i}`, detail: String(error).slice(0, 200) }];
          broken = true;
        }
        for (const d of defects) {
          const key = `${d.category}|${d.subject}`;
          if (seen.has(key)) continue;
          seen.add(key);
          note(seed, d);
        }
        if (broken) break;
      }
      if (!broken && run.sim && state.doc.segments.size) {
        try {
          for (const d of checkSim(state.doc, run.sim)) note(seed, d);
        } catch (error) {
          note(seed, { category: 'exception', subject: 'sim', detail: String(error).slice(0, 200) });
        }
      }
    }
    const log = (line: string): void => {
      console.log(line);
      if (process.env['FUZZ_REPORT']) appendFileSync(process.env['FUZZ_REPORT'], line + '\n');
    };
    const rows = [...tally.entries()].sort((a, b) => b[1].sequences.size - a[1].sequences.size);
    log(`fuzz hunt: ${seeds.length} sequences x ${run.ops} ops, sim ${run.sim?.seconds ?? 0}s`);
    for (const [category, entry] of rows) {
      log(`${category.padEnd(22)} ${String(entry.count).padStart(5)} defects in ${String(entry.sequences.size).padStart(3)} sequences  e.g. seed ${entry.example.seed}: ${entry.example.defect.subject} ${entry.example.defect.detail}`);
    }
    if (process.env['FUZZ_RECORD'] === '1') {
      for (const [category, entry] of rows) {
        const ops = generate(entry.example.seed, run.ops);
        const outcome = replay(ops, run.sim, category);
        if (!outcome.defects.length) continue;
        const minimal = shrink(ops, category, run.sim);
        const again = replay(minimal, run.sim, category);
        const path = saveFixture({ name: `${category}-seed${entry.example.seed}`, category,
          detail: (again.defects[0] ?? outcome.defects[0])!.detail, sim: again.step < 0 ? run.sim : null, ops: minimal });
        log(`recorded ${path} (${minimal.length} ops)`);
      }
    }
    expect(seeds.length).toBeGreaterThan(0);
  });
});
