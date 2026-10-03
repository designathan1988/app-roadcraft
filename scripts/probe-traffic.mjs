// How alive the town the game opens on is: the clock skipped to the morning
// rush, then cars, people out and trips counted every few seconds from the
// status bar the player reads, plus street-level photographs. Headless.
//
//   node scripts/probe-traffic.mjs --base=http://127.0.0.1:4180 --out=.claude/_traffic
import { mkdirSync } from 'node:fs';
import { chromium } from '@playwright/test';

const opt = (name, fallback) => (process.argv.find((a) => a.startsWith(`--${name}=`)) ?? `--${name}=${fallback}`).slice(name.length + 3);
const base = opt('base', 'http://127.0.0.1:4180');
const out = opt('out', '.claude/_traffic');
const skip = Number(opt('skip', '95'));
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
await page.addInitScript(() => { window.confirm = () => true; try { localStorage.setItem('roadcraft.sky', 'day'); } catch { /* blocked */ } });
await page.goto(base, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => Boolean(window.__roadcraft), null, { timeout: 120_000 });
await page.waitForTimeout(3000);
await page.evaluate((skip) => { window.__roadcraft.sim.clock.speed = 1; window.__roadcraft.sim.city.skip(skip); }, skip);
for (let k = 0; k < 6; k++) {
  await page.waitForTimeout(5000);
  console.log(await page.evaluate(() => document.querySelector('footer, .status, #status')?.textContent?.replace(/\s+/g, ' ').trim() ?? document.body.innerText.split('\n').filter((l) => /veícul|vehic|pessoa|morador/i.test(l)).join(' | ')));
}
for (const [name, x, y, zoom, turns, elevation] of [['avenue', -150, 0, 2.2, 0, 0.5], ['square', -150, -100, 2.6, 1, 0.45], ['works-road', 750, 0, 2.2, 2, 0.5]]) {
  await page.evaluate(([x, y, zoom, turns, elevation]) => {
    const v = window.__roadcraft.scene().viewport;
    const canvas = document.getElementById('game');
    v.setOrbit(Math.PI / 4 + turns * (Math.PI / 2), elevation);
    v.zoomAt(canvas.clientWidth / 2, canvas.clientHeight / 2, zoom / v.zoom, canvas.clientWidth, canvas.clientHeight);
    v.moveTo({ x, y });
  }, [x, y, zoom, turns, elevation]);
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${out}/${name}.png` });
}
await browser.close();
