/**
 * Keep repository verification responsive on the machine running the game.
 * Set the Windows process limits before launching npm and its worker tree.
 */
import { spawn } from 'node:child_process';
import { cpus } from 'node:os';
import { dirname, join } from 'node:path';

const [requested, ...args] = process.argv.slice(2);
if (!requested) {
  process.stderr.write('Usage: node scripts/run-limited.mjs <command> [args...]\n');
  process.exit(2);
}

const executable = requested === 'npm'
  ? process.platform === 'win32' ? join(dirname(process.execPath), 'npm.cmd') : 'npm'
  : requested === 'node' ? process.execPath : requested;
const logicalProcessors = cpus().length;
const processorLimit = Math.min(4, Math.max(1, Math.floor(logicalProcessors / 2)));
// Adjacent logical processors on the development machine are SMT siblings.
// Spacing the selected bits lets four workers use separate physical cores.
const affinity = Array.from({ length: processorLimit }, (_, i) => i * 2)
  .reduce((mask, index) => mask + 2 ** index, 0);
const requestedWorkers = Number(process.env.VITEST_MAX_WORKERS);
const workerCount = Number.isFinite(requestedWorkers)
  ? Math.min(processorLimit, Math.max(1, requestedWorkers)) : processorLimit;
const env = { ...process.env, VITEST_MAX_WORKERS: String(workerCount) };
const quote = (value) => `'${value.replaceAll("'", "''")}'`;
const windows = process.platform === 'win32';
const command = windows
  ? `try { $p = Get-Process -Id $PID; $p.ProcessorAffinity = ${affinity}; $p.PriorityClass = 'BelowNormal' } ` +
    `catch { Write-Error $_; exit 1 }; & ${[executable, ...args].map(quote).join(' ')}; exit $LASTEXITCODE`
  : null;
const child = windows
  ? spawn('powershell.exe', ['-NoProfile', '-Command', command], { stdio: 'inherit', env })
  : spawn(executable, args, { stdio: 'inherit', env });
let stopping = false;
const stop = (signal) => {
  if (stopping || !child.pid) return;
  stopping = true;
  // Interrupt the whole process tree, not only the parent shell. Otherwise a
  // Vitest worker or Chrome renderer may keep using CPU after the check ends.
  if (windows) spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  else child.kill(signal);
  process.exitCode = signal === 'SIGINT' ? 130 : 143;
};
process.on('SIGINT', () => stop('SIGINT'));
process.on('SIGTERM', () => stop('SIGTERM'));
child.on('error', (error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
child.on('exit', (code, signal) => { if (!stopping) process.exitCode = code ?? (signal ? 1 : 0); });
