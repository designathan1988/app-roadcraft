/**
 * Headless benchmark of the simulation and the edit paths.
 *
 *   node scripts/bench-sim.mjs [out.json]
 *
 * Runs tests/bench/pipeline.spec.ts under vitest (one worker - it measures
 * time, and must not compete with itself) with BENCH=1. BENCH_WARM,
 * BENCH_TICKS and BENCH_EDITS tune the warm-up seconds, the measured ticks
 * and the repeats per edit kind. Prints the JSON; writes it to out.json too.
 */
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const out = process.argv[2] ? resolve(process.argv[2]) : '';
const result = spawnSync(process.execPath, [
  resolve('node_modules/vitest/vitest.mjs'), 'run', 'tests/bench/pipeline.spec.ts',
  '--maxWorkers=1', '--testTimeout=0', '--silent=false',
], {
  stdio: 'inherit',
  env: { ...process.env, BENCH: '1', VITEST_MAX_WORKERS: '1', ...(out ? { BENCH_OUT: out } : {}) },
});
process.exit(result.status ?? 1);
