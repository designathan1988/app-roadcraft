// Terrain strokes on the town the game opens on: memory and the time each
// stroke takes, until it works or the page dies. Headless on the GPU.
//
//   node scripts/probe-terrain-crash.mjs --base=http://127.0.0.1:4180
import { chromium } from '@playwright/test';

const opt = (name, fallback) => (process.argv.find((a) => a.startsWith(`--${name}=`)) ?? `--${name}=${fallback}`).slice(name.length + 3);
const base = opt('base', 'http://127.0.0.1:4180');
const strokes = Number(opt('strokes', '6'));
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-precise-memory-info'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 200)));
page.on('crash', () => errors.push('PAGE CRASHED'));
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`${m.type()}: ${m.text().slice(0, 160)}`); });
await page.addInitScript(() => { window.confirm = () => true; });
await page.goto(base, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => Boolean(window.__roadcraft), null, { timeout: 120_000 });
await page.waitForTimeout(4000);
const gcSession = await page.context().newCDPSession(page);
const state = async () => { await gcSession.send('HeapProfiler.collectGarbage'); return page.evaluate(() => ({
  heapMB: Math.round((performance.memory?.usedJSHeapSize ?? 0) / 1048576),
  buildings: window.__roadcraft.doc.buildings.size,
  stamps: window.__roadcraft.doc.terrainStamps.length,
})); };
console.log('loaded', JSON.stringify(await state()));
await page.click('[data-tool="terrain"]');
for (const [id, value] of [['terrainRadius', opt('radius', '300')], ['terrainStrength', opt('strength', '40')]]) {
  await page.evaluate(([id, value]) => { const i = document.getElementById(id); i.value = value; i.dispatchEvent(new Event('input', { bubbles: true })); }, [id, value]);
}
const at = opt('at', '0,0').split(',').map(Number);
await page.evaluate(([x, y]) => window.__roadcraft.lookAt(x, y, 1.1), at);
await page.waitForTimeout(800);
const c = { x: 800, y: 470 };
const cdp = opt('profile', '') ? await page.context().newCDPSession(page) : null;
if (cdp) { await cdp.send('Profiler.enable'); await cdp.send('Profiler.setSamplingInterval', { interval: 500 }); }
for (let k = 0; k < strokes; k++) {
  if (cdp && k === 0) await cdp.send('Profiler.start');
  const t0 = Date.now();
  try {
    await page.mouse.move(c.x + 60, c.y);
    await page.mouse.down();
    for (let i = 1; i <= 12; i++) {
      await page.mouse.move(c.x + Math.cos(i / 12 * Math.PI * 2) * 60, c.y + Math.sin(i / 12 * Math.PI * 2) * 33, { steps: 4 });
      await page.waitForTimeout(60);
    }
    await page.mouse.up();
    await page.waitForTimeout(300);
    console.log(`stroke ${k + 1}: ${Date.now() - t0} ms`, JSON.stringify(await state()));
    if (cdp && k === 0) {
      const { profile } = await cdp.send('Profiler.stop');
      const self = new Map(); const byId = new Map(profile.nodes.map((n) => [n.id, n]));
      const dt = profile.timeDeltas; let total = 0;
      profile.samples.forEach((id, i) => { const n = byId.get(id); const f = n.callFrame; const key = `${f.functionName || '(anon)'} @${f.url.split('/').pop()}:${f.lineNumber + 1}`; self.set(key, (self.get(key) ?? 0) + (dt[i] ?? 0)); total += dt[i] ?? 0; });
      console.log('PROFILE total ms', Math.round(total / 1000));
      for (const [k2, v] of [...self].sort((a, b) => b[1] - a[1]).slice(0, 30)) console.log(`  ${(v / 1000).toFixed(0).padStart(6)} ms  ${k2}`);
    }
  } catch (e) {
    console.log(`stroke ${k + 1} FAILED after ${Date.now() - t0} ms: ${String(e.message).split('\n')[0]}`);
    break;
  }
}
console.log(JSON.stringify(errors.slice(0, 12), null, 1));
await browser.close();
