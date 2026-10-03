// The walls tool and houses flush with the street, photographed: two roads
// crossing on an empty map, a house on a street and one on the corner, then
// a fence, a wall and a hedge drawn along the streets, a run refused across a
// road, and a run removed. Headless on the GPU.
//
//   node scripts/probe-barriers.mjs --base=http://127.0.0.1:4180 --out=docs/audit/barriers
import { mkdirSync } from 'node:fs';
import { chromium } from '@playwright/test';

const opt = (name, fallback) => (process.argv.find((a) => a.startsWith(`--${name}=`)) ?? `--${name}=${fallback}`).slice(name.length + 3);
const base = opt('base', 'http://127.0.0.1:4180');
const out = opt('out', 'docs/audit/barriers');
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 200)));
await page.addInitScript(() => { window.confirm = () => true; try { localStorage.setItem('roadcraft.sky', 'day'); } catch { /* blocked */ } });
await page.goto(base, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => Boolean(window.__roadcraft), null, { timeout: 120_000 });
await page.waitForTimeout(1500);

// Two roads crossing at the origin.
await page.evaluate(() => {
  const seg = (id, a, b) => ({ id, a, b, type: 1, curve: null, dashOrigin: 0, direction: 'both', lanes: null, structure: 'ground' });
  window.__roadcraft.loadDoc({
    version: 1,
    nodes: [
      { id: 1, x: -240, y: 0, heightOffset: 0, smooth: false, control: 'auto', blockedMovements: [] },
      { id: 2, x: 0, y: 0, heightOffset: 0, smooth: false, control: 'auto', blockedMovements: [] },
      { id: 3, x: 240, y: 0, heightOffset: 0, smooth: false, control: 'auto', blockedMovements: [] },
      { id: 4, x: 0, y: -240, heightOffset: 0, smooth: false, control: 'auto', blockedMovements: [] },
      { id: 5, x: 0, y: 240, heightOffset: 0, smooth: false, control: 'auto', blockedMovements: [] },
    ],
    segments: [seg(1, 1, 2), seg(2, 2, 3), seg(3, 4, 2), seg(4, 2, 5)],
    terrain: [],
  });
});
await page.waitForTimeout(2500);
// How far the back of the footway is from the centre of the east-west road.
const back = await page.evaluate(() => {
  const ribbon = window.__roadcraft.net.ribbons.get(2);
  return ribbon.rings[2].bbox.maxY;
});
console.log('footway back', back);

const centre = { x: 800, y: 450 };
const look = async (x, y, zoom = 2.6) => { await page.evaluate(([x, y, z]) => window.__roadcraft.lookAt(x, y, z), [x, y, zoom]); await page.waitForTimeout(400); };
const clickAt = async (x, y, modifiers = []) => {
  await look(x, y);
  await page.mouse.move(centre.x, centre.y);
  for (const k of modifiers) await page.keyboard.down(k);
  await page.mouse.click(centre.x, centre.y);
  for (const k of modifiers) await page.keyboard.up(k);
  await page.waitForTimeout(250);
};
const shot = async (name, x, y, zoom) => { await look(x, y, zoom); await page.waitForTimeout(1200); await page.screenshot({ path: `${out}/${name}.png` }); };
const log = [];

// ---- houses: one on the street, one on the corner
await page.keyboard.press('h');
await page.waitForTimeout(1200);
const armed = await page.evaluate(() => {
  const b = document.querySelector('[data-preset="city:house"]');
  if (!b) return false;
  b.click();
  return true;
});
log.push(['house tile', armed]);
await page.waitForTimeout(500);
await clickAt(80, back + 20);
await page.evaluate(() => document.querySelector('[data-preset="city:house"]')?.click());
await page.waitForTimeout(300);
await clickAt(back + 12, back + 12);
log.push(['buildings', await page.evaluate(() => [...window.__roadcraft.doc.buildings.all()].map((b) => ({ id: b.id, x: Math.round(b.x), y: Math.round(b.y), rot: +b.rotation.toFixed(2), lots: b.volumes.length })))]);
await page.keyboard.press('Escape');
await shot('01-houses-flush', 40, 40, 2.2);
await shot('01b-corner-house-close', 30, 30, 6);

// ---- the walls tool: its panel
await page.keyboard.press('f');
await page.waitForTimeout(800);
await shot('02-walls-tool-panel', 0, 0, 1.6);
// A fence along the south side of the west street, round into the side road.
for (const [x, y] of [[-200, -back - 2], [-60, -back - 2], [-60, -120]]) await clickAt(x, y);
await shot('03-fence-traced', -120, -60, 1.8);
await page.keyboard.press('Enter');
await page.waitForTimeout(800);
// A wall along the north side of the west street.
await page.click('[data-barrier="wall"]');
for (const [x, y] of [[-200, back + 2], [-40, back + 2]]) await clickAt(x, y);
await page.keyboard.press('Enter');
// A hedge along the south side of the east street.
await page.click('[data-barrier="hedge"]');
for (const [x, y] of [[40, -back - 2], [200, -back - 2]]) await clickAt(x, y);
await page.keyboard.press('Enter');
await page.waitForTimeout(800);
log.push(['barriers', await page.evaluate(() => [...window.__roadcraft.doc.barriers.values()].map((b) => ({ id: b.id, kind: b.kind, points: b.points.length })))]);
await shot('04-fence-wall-hedge', 0, 0, 1.4);
await shot('05-close-fence-wall', -110, 0, 5);
await shot('06-close-hedge', 120, -back, 5);
await shot('06b-close-fence', -130, -back - 6, 10);
// A run across the road: refused, drawn red.
await page.click('[data-barrier="fence"]');
await clickAt(140, -100);
await look(140, 100);
await page.mouse.move(centre.x + 3, centre.y + 3);
await page.mouse.move(centre.x, centre.y);
await page.waitForTimeout(400);
await shot('07-refused-across-road-preview', 140, 0, 1.8);
await clickAt(140, 100);
await page.keyboard.press('Enter');
await page.waitForTimeout(500);
log.push(['after refused run', await page.evaluate(() => window.__roadcraft.doc.barriers.size)]);
// Shift-click removes the hedge.
await clickAt(120, -back - 2, ['Shift']);
await page.waitForTimeout(600);
log.push(['after removal', await page.evaluate(() => [...window.__roadcraft.doc.barriers.values()].map((b) => b.kind))]);
await shot('08-hedge-removed', 0, 0, 1.4);
// Undo brings it back.
await page.keyboard.press('Control+z');
await page.waitForTimeout(800);
log.push(['after undo', await page.evaluate(() => [...window.__roadcraft.doc.barriers.values()].map((b) => b.kind))]);
await shot('09-undo-brings-it-back', 0, 0, 1.4);

console.log(JSON.stringify({ log, errors }, null, 1));
await browser.close();
