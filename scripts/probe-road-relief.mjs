// A road laid straight over a brush-built mountain, on an empty map: where
// along it the ground stands above the road surface (the road buried), and
// what structure the solver gave it. Photographs it.
//
//   node scripts/probe-road-relief.mjs --base=http://127.0.0.1:4180 --out=.claude/_roadrelief
import { mkdirSync } from 'node:fs';
import { chromium } from '@playwright/test';

const opt = (name, fallback) => (process.argv.find((a) => a.startsWith(`--${name}=`)) ?? `--${name}=${fallback}`).slice(name.length + 3);
const base = opt('base', 'http://127.0.0.1:4180');
const out = opt('out', '.claude/_roadrelief');
const peak = Number(opt('peak', '240'));
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 200)));
await page.addInitScript(() => { window.confirm = () => true; try { localStorage.setItem('roadcraft.sky', 'day'); } catch { /* blocked */ } });
await page.goto(base, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => Boolean(window.__roadcraft), null, { timeout: 120_000 });
await page.waitForTimeout(1500);

await page.evaluate((peak) => {
  const R = window.__roadcraft;
  const data = R.doc.toJSON();
  for (const key of Object.keys(data)) if (Array.isArray(data[key])) data[key] = [];
  if (data.buildings && typeof data.buildings === 'object' && !Array.isArray(data.buildings)) {
    for (const key of Object.keys(data.buildings)) if (Array.isArray(data.buildings[key])) data.buildings[key] = [];
  }
  // Six strokes of a 300-wide brush, each a small circle of dabs.
  const terrain = [];
  let id = 1;
  for (let s = 1; s <= 6; s++) {
    for (let k = 0; k < 12; k++) {
      const a = (k / 12) * Math.PI * 2;
      terrain.push({ id: id++, x: Math.cos(a) * 60, y: Math.sin(a) * 60, radius: 300, strength: peak / 6 / 0.9, mode: 'raise', stroke: s });
    }
  }
  data.terrain = terrain;
  data.nodes = [{ id: 1, x: -420, y: -260 }, { id: 2, x: 420, y: 260 }];
  data.segments = [{ id: 1, a: 1, b: 2, type: 1, curve: null }];
  R.loadDoc(data);
}, peak);
await page.waitForTimeout(4000);

const measured = await page.evaluate(() => {
  const R = window.__roadcraft;
  const S = R.scene();
  const seg = [...R.doc.segments.values()][0];
  const rows = [];
  for (let i = 0; i <= 20; i++) {
    const t = i / 20;
    const x = -420 + 840 * t;
    const y = -260 + 520 * t;
    rows.push({ t, ground: Number(S.terrainHeightAt(x, y).toFixed(1)), road: Number(S.elevationAt(x, y).toFixed(1)), surface: Number(S.surfaceHeightAt(x, y).toFixed(1)) });
  }
  return { structure: seg?.structure, rows };
});
console.log(JSON.stringify(measured));
for (const [name, x, y, zoom] of [['01-over', 0, 0, 0.7], ['02-close', 0, 0, 1.6]]) {
  await page.evaluate(([x, y, z]) => window.__roadcraft.lookAt(x, y, z), [x, y, zoom]);
  await page.waitForTimeout(1800);
  await page.screenshot({ path: `${out}/${name}.png` });
}
console.log('page errors:', errors.length ? errors : 'none');
await browser.close();
