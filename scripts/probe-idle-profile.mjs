// Where the main thread goes while the game simply runs: the map opens, settles
// for `--settle` ms, then a CPU profile of `--secs` seconds is taken and
// summed by function - self time, and total time (self plus callees) - so a
// long task that repeats every second names itself. Headless on the GPU.
//
//   node scripts/probe-idle-profile.mjs --base=http://127.0.0.1:4197 --settle=15000 --secs=8
import { chromium } from '@playwright/test';

const opt = (name, fallback) => (process.argv.find((a) => a.startsWith(`--${name}=`)) ?? `--${name}=${fallback}`).slice(name.length + 3);
const base = opt('base', 'http://127.0.0.1:4197');
const settle = Number(opt('settle', '15000'));
const secs = Number(opt('secs', '8'));
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: Number(opt('width', '2560')), height: Number(opt('height', '1080')) } });
await page.addInitScript(() => { window.confirm = () => true; });
await page.goto(base, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => Boolean(window.__roadcraft), null, { timeout: 120_000 });
await page.waitForTimeout(settle);
const cdp = await page.context().newCDPSession(page);
await cdp.send('Profiler.enable');
await cdp.send('Profiler.setSamplingInterval', { interval: 500 });
await cdp.send('Profiler.start');
await page.waitForTimeout(secs * 1000);
const { profile } = await cdp.send('Profiler.stop');
const byId = new Map(profile.nodes.map((n) => [n.id, n]));
const parent = new Map();
for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
const name = (n) => `${n.callFrame.functionName || '(anon)'} @${n.callFrame.url.split('/').pop()}:${n.callFrame.lineNumber + 1}`;
const self = new Map();
const total = new Map();
let all = 0;
profile.samples.forEach((id, i) => {
  const dt = profile.timeDeltas[i] ?? 0;
  all += dt;
  const n = byId.get(id);
  self.set(name(n), (self.get(name(n)) ?? 0) + dt);
  const seen = new Set();
  for (let at = id; at !== undefined; at = parent.get(at)) {
    const key = name(byId.get(at));
    if (seen.has(key)) continue;
    seen.add(key);
    total.set(key, (total.get(key) ?? 0) + dt);
  }
});
const idle = self.get('(idle) @:0') ?? 0;
console.log(`profiled ${Math.round(all / 1000)} ms, idle ${Math.round(idle / 1000)} ms`);
console.log('SELF');
for (const [k, v] of [...self].sort((a, b) => b[1] - a[1]).slice(0, 25)) console.log(`  ${(v / 1000).toFixed(0).padStart(6)} ms  ${k}`);
console.log('TOTAL');
for (const [k, v] of [...total].sort((a, b) => b[1] - a[1]).slice(0, 45)) console.log(`  ${(v / 1000).toFixed(0).padStart(6)} ms  ${k}`);
await browser.close();
