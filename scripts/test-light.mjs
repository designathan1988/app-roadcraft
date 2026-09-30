// Runs vitest on the given spec paths with one worker at below-normal
// priority, so a test run never takes the whole machine from the person
// using it. Usage: node scripts/test-light.mjs <paths...> [-- vitest args]
import { spawn } from 'node:child_process';
import os from 'node:os';

const child = spawn(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', '--maxWorkers=1', ...process.argv.slice(2)], {
  stdio: 'inherit',
});
try { os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* not allowed: run anyway */ }
child.on('exit', (code) => process.exit(code ?? 1));
