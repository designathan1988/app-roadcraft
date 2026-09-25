import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Rng } from '@core/rng';
import { applyOp, freshState, randomOp, type FuzzOp, type FuzzState } from './ops';
import { checkWorld, type Defect } from './invariants';
import { checkSim, type SimRun } from './simCheck';

/**
 * The fuzz loop: generate, apply, check, shrink, record.
 *
 * Profiles (FUZZ_PROFILE):
 *  - `smoke` (default, part of `npm run check`): a handful of short seeded
 *    sequences and a short traffic run on each final network;
 *  - `deep`: many long sequences and long traffic runs, for a bug hunt.
 * FUZZ_SEEDS overrides the number of sequences, FUZZ_OPS their length,
 * FUZZ_FIRST the first seed; FUZZ_SIM=0 skips the traffic run.
 */
export interface Profile {
  readonly sequences: number;
  readonly ops: number;
  readonly sim: SimRun | null;
}

export const PROFILES: Record<string, Profile> = {
  smoke: { sequences: 6, ops: 24, sim: { seconds: 45, seed: 0x5eed, intensity: 1.5 } },
  deep: { sequences: 200, ops: 60, sim: { seconds: 240, seed: 0x5eed, intensity: 2 } },
};

export function profile(): Profile {
  const base = PROFILES[process.env['FUZZ_PROFILE'] ?? 'smoke'] ?? (PROFILES['smoke'] as Profile);
  const seeds = Number(process.env['FUZZ_SEEDS'] ?? NaN);
  const ops = Number(process.env['FUZZ_OPS'] ?? NaN);
  return {
    sequences: Number.isFinite(seeds) ? seeds : base.sequences,
    ops: Number.isFinite(ops) ? ops : base.ops,
    sim: process.env['FUZZ_SIM'] === '0' ? null : base.sim,
  };
}

export function generate(seed: number, count: number): FuzzOp[] {
  const rng = new Rng(seed);
  const state = freshState();
  const ops: FuzzOp[] = [];
  for (let i = 0; i < count; i++) {
    const op = randomOp(rng, state);
    ops.push(op);
    try { applyOp(state, op); } catch { break; }
  }
  return ops;
}

export interface Outcome {
  readonly defects: readonly Defect[];
  /** Index of the operation after which the defects appeared; -1 for the traffic run. */
  readonly step: number;
  readonly state: FuzzState;
}

/**
 * Replays a sequence and stops at the first operation after which the world
 * breaks. With `sim`, a sequence whose world never breaks is then driven.
 * `only` restricts the checks to one category (what the shrinker holds fixed).
 */
export function replay(ops: readonly FuzzOp[], sim: SimRun | null, only?: string | ((category: string) => boolean)): Outcome {
  const state = freshState();
  const wanted = typeof only === 'string' ? (c: string) => c === only : only;
  const keep = (list: Defect[]): Defect[] => (wanted ? list.filter((d) => wanted(d.category)) : list);
  for (let i = 0; i < ops.length; i++) {
    let defects: Defect[];
    try {
      if (!applyOp(state, ops[i] as FuzzOp)) continue;
      defects = keep([...state.notes.splice(0), ...checkWorld(state.doc, state.net)]);
    } catch (error) {
      defects = keep([{ category: 'exception', subject: `op ${i}`, detail: String((error as Error)?.stack ?? error).slice(0, 400) }]);
    }
    if (defects.length) return { defects, step: i, state };
  }
  if (sim && state.doc.segments.size) {
    let defects: Defect[];
    try {
      defects = keep(checkSim(state.doc, sim));
    } catch (error) {
      defects = keep([{ category: 'exception', subject: 'sim', detail: String((error as Error)?.stack ?? error).slice(0, 400) }]);
    }
    if (defects.length) return { defects, step: -1, state };
  }
  return { defects: [], step: ops.length, state };
}

/**
 * Removes operations while the sequence still produces a defect of the same
 * category: first everything after the failing step, then halves, then single
 * operations (ddmin, simplified). The result is usually a handful of gestures.
 */
export function shrink(ops: readonly FuzzOp[], category: string, sim: SimRun | null): FuzzOp[] {
  const fails = (candidate: readonly FuzzOp[]): number | null => {
    const outcome = replay(candidate, sim, category);
    return outcome.defects.length ? outcome.step : null;
  };
  let current = [...ops];
  const first = fails(current);
  if (first === null) return current;
  if (first >= 0) current = current.slice(0, first + 1);

  let chunk = Math.max(1, Math.floor(current.length / 2));
  while (chunk >= 1) {
    let removed = false;
    for (let start = 0; start < current.length; start += chunk) {
      const candidate = [...current.slice(0, start), ...current.slice(start + chunk)];
      if (!candidate.length) continue;
      const step = fails(candidate);
      if (step !== null) {
        current = step >= 0 ? candidate.slice(0, step + 1) : candidate;
        removed = true;
        start -= chunk;
      }
    }
    if (!removed) chunk = Math.floor(chunk / 2);
  }
  return current;
}

export interface Fixture {
  readonly name: string;
  readonly category: string;
  readonly detail: string;
  readonly sim: SimRun | null;
  readonly ops: readonly FuzzOp[];
  /** Present while the defect is not fixed: why, with the evidence. */
  readonly open?: string;
  /**
   * An open defect whose CATEGORY must still fail the smoke gate: the
   * recorded instance is known, any new one is news. Without it an open
   * fixture makes its whole category tolerated.
   */
  readonly gate?: boolean;
}

/** Categories with a recorded, unfixed defect: the smoke gate tolerates them. */
export function openCategories(): Set<string> {
  return new Set(loadFixtures().filter((f) => f.open && !f.gate).map((f) => f.category));
}

export const FIXTURE_DIR = join(process.cwd(), 'tests', 'fuzz', 'fixtures');

export function loadFixtures(): Fixture[] {
  let names: string[] = [];
  try { names = readdirSync(FIXTURE_DIR).filter((n) => n.endsWith('.json')).sort(); } catch { return []; }
  return names.map((n) => JSON.parse(readFileSync(join(FIXTURE_DIR, n), 'utf8')) as Fixture);
}

export function saveFixture(fixture: Fixture): string {
  mkdirSync(FIXTURE_DIR, { recursive: true });
  const path = join(FIXTURE_DIR, `${fixture.name}.json`);
  writeFileSync(path, JSON.stringify(fixture, null, 1) + '\n');
  return path;
}
