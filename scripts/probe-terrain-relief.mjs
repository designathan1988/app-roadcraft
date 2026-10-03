// The terrain tool's amplitude, driven through the player's own interface: the
// Terrain tool, the Radius and Strength sliders at their new maxima, drags on
// the canvas - a mountain, a pit, a channel, and a road climbing the slope -
// photographed with the measurements beside them.
//
//   node scripts/probe-terrain-relief.mjs --base=http://127.0.0.1:4180 --out=docs/audit/terrain-relief
import { mkdirSync } from 'node:fs';
import { chromium } from '@playwright/test';

const opt = (name, fallback) => (process.argv.find((a) => a.startsWith(`--${name}=`)) ?? `--${name}=${fallback}`).slice(name.length + 3);
const base = opt('base', 'http://127.0.0.1:4180');
const out = opt('out', 'docs/audit/terrain-relief');
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 200)));
await page.addInitScript(() => { window.confirm = () => true; try { localStorage.setItem('roadcraft.sky', 'day'); } catch { /* blocked */ } });
await page.goto(base, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => Boolean(window.__roadcraft), null, { timeout: 120_000 });
await page.waitForTimeout(1500);

const centre = { x: 800, y: 470 };
const look = async (x, y, zoom) => {
  await page.evaluate(([x, y, z]) => window.__roadcraft.lookAt(x, y, z), [x, y, zoom]);
  await page.waitForTimeout(350);
};
/** One stroke of the brush in hand: press at the view's centre, wander, release. */
const stroke = async (path, times = 1) => {
  for (let k = 0; k < times; k++) {
    const [px, py] = path[0];
    await page.mouse.move(centre.x + px, centre.y + py);
    await page.mouse.down();
    for (const [dx, dy] of path.slice(1)) {
      await page.mouse.move(centre.x + dx, centre.y + dy, { steps: 4 });
      await page.waitForTimeout(60);
    }
    await page.mouse.up();
    await page.waitForTimeout(140);
  }
};
const circle = (r, n = 12) => Array.from({ length: n + 1 }, (_, i) => [Math.cos((i / n) * Math.PI * 2) * r, Math.sin((i / n) * Math.PI * 2) * r * 0.55]);
const shot = async (name, x, y, zoom) => {
  await look(x, y, zoom);
  await page.waitForTimeout(1400);
  await page.screenshot({ path: `${out}/${name}.png` });
};
const log = [];

// ------------------------------------------------------- the tool, as a player takes it
await page.click('[data-tool="terrain"]');
for (const [id, value] of [['terrainRadius', '300'], ['terrainStrength', '40']]) {
  await page.evaluate(([id, value]) => {
    const input = document.getElementById(id);
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }, [id, value]);
}
log.push(['panel', await page.evaluate(() => ({
  radius: document.getElementById('terrainRadius').value,
  radiusMax: document.getElementById('terrainRadius').max,
  strength: document.getElementById('terrainStrength').value,
  strengthMax: document.getElementById('terrainStrength').max,
}))]);

// The panel itself, one photograph per mode, with the brush ring on the map
// at the widest radius: what the player sees before a stroke.
for (const mode of ['raise', 'lower', 'flatten', 'river']) {
  await page.click(`[data-terrain-mode="${mode}"]`);
  await page.mouse.move(centre.x, centre.y);
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${out}/00-panel-${mode}.png` });
}
await page.click('[data-terrain-mode="raise"]');

// ------------------------------------------------------- a mountain
await look(0, 0, 1.1);
await stroke(circle(60), 9);
log.push(['mountain', await page.evaluate(() => window.__roadcraft.scene().terrainHeightAt(0, 0))]);

// ------------------------------------------------------- a pit beside it
await page.click('[data-terrain-mode="lower"]');
await look(900, 300, 1.1);
await stroke(circle(55), 8);
log.push(['pit', await page.evaluate(() => window.__roadcraft.scene().terrainHeightAt(900, 300))]);

// ------------------------------------------------------- a channel out of the mountain
await page.click('[data-terrain-mode="river"]');
await look(200, 500, 1.1);
await stroke([[0, -120], [-40, -40], [-40, 60], [60, 140], [200, 190]], 3);
log.push(['river', await page.evaluate(() => window.__roadcraft.scene().terrainHeightAt(200, 500))]);

// ------------------------------------------------------- a road up the mountain
await page.click('[data-tool="road"]');
await look(0, 0, 1.1);
await page.mouse.move(centre.x - 320, centre.y + 210);
await page.mouse.down();
await page.mouse.move(centre.x - 140, centre.y + 90, { steps: 6 });
await page.mouse.move(centre.x + 20, centre.y - 20, { steps: 6 });
await page.mouse.move(centre.x + 210, centre.y - 150, { steps: 6 });
await page.mouse.up();
await page.waitForTimeout(900);

const measurements = await page.evaluate(() => {
  const R = window.__roadcraft;
  const S = R.scene();
  const heights = [];
  for (const [, n] of R.doc.nodes) heights.push({ x: Math.round(n.x), y: Math.round(n.y), h: Number(S.terrainHeightAt(n.x, n.y).toFixed(1)), offset: Number((n.heightOffset ?? 0).toFixed(2)) });
  return {
    nodes: heights,
    roadTop: R.net.ribbons.size,
    peak: Number(S.terrainHeightAt(0, 0).toFixed(1)),
    pit: Number(S.terrainHeightAt(900, 300).toFixed(1)),
    stamps: R.doc.terrainStamps.length,
  };
});
log.push(['measured', measurements]);

await shot('01-panel-raise', 0, 0, 1.15);
await shot('02-mountain', 0, 0, 0.55);
await shot('03-mountain-close', 120, 120, 1.5);
await shot('04-pit', 900, 300, 0.55);
await shot('05-pit-close', 780, 260, 1.4);
await shot('06-road-slope', 0, 0, 1.15);
await shot('07-road-slope-close', -120, 120, 2.2);
await shot('08-overview', 200, 150, 0.34);

console.log(JSON.stringify(log, null, 2));
console.log('page errors:', errors.length ? errors : 'none');
await browser.close();
