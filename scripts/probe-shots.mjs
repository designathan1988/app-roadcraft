// Pictures of the town at the rush from fixed spots, to compare a change
// before and after. Headless on the GPU.
//
//   node scripts/probe-shots.mjs --base=http://127.0.0.1:4190 --out=dir
import { mkdirSync } from 'node:fs';
import { chromium } from '@playwright/test';

const opt = (name, fallback) => (process.argv.find((a) => a.startsWith(`--${name}=`)) ?? `--${name}=${fallback}`).slice(name.length + 3);
const base = opt('base', 'http://127.0.0.1:5173');
const out = opt('out', 'shots');
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
await page.addInitScript(() => { window.confirm = () => true; try { localStorage.setItem('roadcraft.sky', 'day'); } catch { /* blocked */ } });
await page.goto(base, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => Boolean(window.__roadcraft), null, { timeout: 120_000 });
await page.waitForSelector('.loading-screen', { state: 'detached', timeout: 300_000 }).catch(() => {});
await page.evaluate(() => document.getElementById('sampleCity').click());
await page.waitForTimeout(8000);
await page.evaluate(() => window.__roadcraft.sim.city.skip(95));
await page.waitForTimeout(20000);
// Frozen for the pictures: the same moment, before and after.
await page.evaluate(() => { window.__roadcraft.sim.clock.paused = true; });
const spots = { far: [-200, -300, 0.6], mid: [-300, -300, 1.1], street: [-300, -300, 3.5] };
for (const [name, [x, y, z]] of Object.entries(spots)) {
  await page.evaluate(([x, y, z]) => window.__roadcraft.lookAt(x, y, z), [x, y, z]);
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${out}/${name}.png` });
}
await browser.close();
