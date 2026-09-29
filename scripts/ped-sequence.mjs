/**
 * Photographs pedestrians in the running game: one walker at close zoom, frame
 * by frame, then the busiest kerb.
 *
 *   node scripts/ped-sequence.mjs <out-dir> [base-url] [zoom] [frames]
 *
 * Writes <out-dir>/walk-NN.jpg (one walker, camera re-centred each frame) and
 * <out-dir>/kerb-NN.jpg (the busiest crossing), plus <out-dir>/walk.json.
 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from '@playwright/test';

const OUT = path.resolve(process.argv[2] ?? 'docs/screenshots/ped');
const BASE = process.argv[3] ?? 'http://localhost:5199';
const ZOOM = Number(process.argv[4] ?? 20);
const FRAMES = Number(process.argv[5] ?? 12);
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' }),
  args: ['--use-gl=angle', `--use-angle=${process.platform === 'win32' ? 'd3d11' : 'vulkan'}`,
    '--enable-gpu', '--ignore-gpu-blocklist', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 900, height: 620 } });
page.on('pageerror', (e) => console.log('PAGE ERROR', e.message));
await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
await page.waitForFunction('Boolean(window.__roadcraft)', null, { timeout: 60_000 });
await page.addStyleTag({ content: '#app > *:not(canvas) { visibility: hidden !important; }' });

const fixture = JSON.parse(fs.readFileSync(path.resolve('tests/fixtures/grid-and-bends.json'), 'utf8'));
await page.evaluate((doc) => {
  const R = window.__roadcraft;
  R.doc.replaceFromJSON(doc);
  R.net.rebuild();
  R.scene().setQuality('high');
  R.sim.trafficIntensity = 1;
  R.sim.pedestrianIntensity = 3;
  R.runSim(300);
  R.redraw();
}, fixture.document);
await page.waitForTimeout(7000);

/** The busiest kerb: where the most walking pedestrians are within 40 units. */
const busy = await page.evaluate(() => {
  const R = window.__roadcraft;
  const peds = [...R.sim.peds.values()];
  let best = null, bestN = -1;
  for (const p of peds) {
    let n = 0;
    for (const q of peds) if (Math.hypot(q.x - p.x, q.y - p.y) < 60) n++;
    if (n > bestN) { bestN = n; best = { x: p.x, y: p.y, n }; }
  }
  return best;
});
console.log('busiest', JSON.stringify(busy));

await page.evaluate(({ x, y, zoom }) => {
  const v = window.__roadcraft.scene().viewport;
  v.zoomAt(450, 310, zoom / v.zoom);
  v.moveTo({ x, y });
  window.__roadcraft.redraw();
}, { x: busy.x, y: busy.y, zoom: 7 });
await page.waitForTimeout(2000);
for (let i = 0; i < 8; i++) {
  await page.waitForTimeout(700);
  await page.screenshot({ path: path.join(OUT, `kerb-${String(i).padStart(2, '0')}.jpg`), type: 'jpeg', quality: 90, timeout: 60_000 });
}

const me = await page.evaluate(() => {
  const R = window.__roadcraft;
  const p = [...R.sim.peds.values()]
    .filter((q) => q.state === 'Walking' && R.sim.sidewalks.edges.get(q.edge)?.kind === 'walk' && !q.activity && q.v > 1.6)
    .sort((a, b) => b.age - a.age)[0];
  return p ? { id: p.id } : null;
});
console.log('watching', JSON.stringify(me));
if (!me) { await browser.close(); process.exit(0); }

const frames = [];
for (let i = 0; i < FRAMES; i++) {
  const p = await page.evaluate(({ id, zoom }) => {
    const R = window.__roadcraft;
    const ped = R.sim.peds.get(id);
    if (!ped) return null;
    const v = R.scene().viewport;
    v.zoomAt(450, 310, zoom / v.zoom);
    v.moveTo({ x: ped.x, y: ped.y });
    R.redraw();
    const dx = ped.x - ped.prev.x, dy = ped.y - ped.prev.y;
    let off = Math.abs(Math.atan2(dy, dx) - ped.heading) % (2 * Math.PI);
    if (off > Math.PI) off = 2 * Math.PI - off;
    return { id: ped.id, x: +ped.x.toFixed(2), y: +ped.y.toFixed(2), head: +ped.heading.toFixed(3),
      v: +(Math.hypot(dx, dy) * 60 / 2.5).toFixed(2), latV: +(ped.latV / 2.5).toFixed(2),
      slipDeg: +((off * 180) / Math.PI).toFixed(0), state: ped.state, stuck: +ped.stuck.toFixed(1) };
  }, { id: me.id, zoom: ZOOM });
  if (!p) break;
  frames.push(p);
  await page.screenshot({ path: path.join(OUT, `walk-${String(i).padStart(2, '0')}.jpg`), type: 'jpeg', quality: 92, timeout: 60_000 });
  await page.waitForTimeout(110);
}
fs.writeFileSync(path.join(OUT, 'walk.json'), JSON.stringify(frames, null, 1));
console.log('frames', frames.length, 'slip p50', frames.map((f) => f.slipDeg).sort((a, b) => a - b)[Math.floor(frames.length / 2)]);
await browser.close();
