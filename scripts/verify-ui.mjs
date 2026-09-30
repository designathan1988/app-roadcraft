/**
 * Walks the Builder's panel option by option and photographs each state, so
 * every group, tool, entry, gallery and parameter row can be LOOKED at.
 *
 *   npm run verify:ui
 *
 * Writes docs/screenshots/ui-<state>.png. The rule it serves is in CLAUDE.md:
 * interface work is not finished until the pictures have been looked at.
 */
import { chromium } from '@playwright/test';
import { preview } from 'vite';

const PORT = 5204;
const server = await preview({ preview: { port: PORT, strictPort: true } });
const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e.message)));

await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle' });
await page.waitForFunction('Boolean(window.__roadcraft)', null, { timeout: 30_000 });
await page.waitForTimeout(2500);

const band = async (name) => {
  const box = await page.evaluate(`(() => { const r = document.querySelector('.bw-dock').getBoundingClientRect(); return { x: Math.max(0, r.x - 10), y: Math.max(0, r.y - 10), width: Math.min(innerWidth - 1, r.width + 20), height: r.height + 20 }; })()`);
  await page.screenshot({ path: `docs/screenshots/ui-${name}.png`, clip: box });
};

const click = async (selector) => {
  const ok = await page.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.click(); return true; })()`);
  if (!ok) console.error('MISSING', selector);
  await page.waitForTimeout(260);
};

// A building to work on, so the tools that need a selection have one.
await page.evaluate(`(() => {
  const R = window.__roadcraft;
  const T = R.buildings;
  T.chooseBlueprint('block');
  T.hoverPlace({ x: 20, y: 20 });
  T.pointerDown({ x: 1, y: 1 }, { x: 20, y: 20 }, false);
  T.pointerUp(false);
})()`);
await page.waitForTimeout(900);

await click('.tool[data-tool="building"]');
await page.waitForTimeout(1200);
await band('00-select');

const GROUPS = {
  create: { draw: ['shapes', 'sketch', 'models'], mass: ['floors', 'volumes', 'planShape'], face: ['pushpull', 'inset', 'outset', 'flush', 'patterns'] },
  insert: {
    openings: ['openWindows', 'openDoors', 'balcony', 'shopfront', 'pillarBay', 'wallBay', 'freeOpening'],
    structure: ['stair', 'ramp', 'pillar', 'canopy', 'wall', 'slab', 'runs'],
    roof: ['roofs', 'roofShape'],
    components: ['greenery', 'furniture', 'roofGear', 'moreComponents'],
  },
  appearance: { finish: ['paint', 'material', 'colour', 'copyStyle'] },
};

for (const [group, tools] of Object.entries(GROUPS)) {
  await click(`.bw-section[data-builder-group="${group}"]`);
  for (const tool of Object.keys(tools)) {
    await click(`.bw-tool[data-builder-category="${tool}"]`);
    await band(`${group}-${tool}`);
  }
}
// The gallery of every family, since that is where the pictures are.
for (const [group, tools] of Object.entries(GROUPS)) {
  await click(`.bw-section[data-builder-group="${group}"]`);
  for (const [tool, families] of Object.entries(tools)) {
    await click(`.bw-tool[data-builder-category="${tool}"]`);
    for (const family of families) {
      const opened = await page.evaluate(`(() => { const el = document.querySelector('.bw-families button[data-builder-tool="${family}"]'); if (!el) return false; el.click(); return !!el.classList.contains('open') || true; })()`);
      if (!opened) { console.error('MISSING family', family); continue; }
      await page.waitForTimeout(700);
      const tiles = await page.evaluate(`document.querySelectorAll('.bw-tier3 .bw-tile').length`);
      if (tiles > 0) await band(`${group}-${tool}-${family}`);
      await page.evaluate(`(() => { const el = document.querySelector('.bw-families button[data-builder-tool="${family}"]'); if (el) el.click(); })()`);
      await page.waitForTimeout(200);
    }
  }
}

// The bar's own menus.
for (const [label, name] of [['Menu', 'bar-menu'], ['Simulação', 'bar-sim']]) {
  await page.evaluate(`(() => { const b = [...document.querySelectorAll('.bw-top .bw-chip')].find(c => c.textContent.includes(${JSON.stringify(label)})); if (b) b.click(); })()`);
  await page.waitForTimeout(400);
  const box = await page.evaluate(`(() => { const r = document.querySelector('.bw-drop').getBoundingClientRect(); return { x: r.x - 8, y: r.y - 8, width: r.width + 16, height: r.height + 16 }; })()`);
  await page.screenshot({ path: `docs/screenshots/ui-${name}.png`, clip: box });
  await page.evaluate(`document.body.click()`);
  await page.waitForTimeout(200);
}
for (const [chip, name] of [['.bw-floor', 'drop-floor'], ['.bw-snap', 'drop-snap'], ['.bw-chip:nth-of-type(4)', 'drop-view'], ['.bw-help', 'drop-help']]) {
  await page.evaluate(`(() => { const b = document.querySelector(${JSON.stringify(chip)}); if (b) b.click(); })()`);
  await page.waitForTimeout(400);
  const box = await page.evaluate(`(() => { const r = document.querySelector('.bw-drop').getBoundingClientRect(); return { x: Math.max(0, r.x - 8), y: Math.max(0, r.y - 8), width: r.width + 16, height: r.height + 16 }; })()`);
  await page.screenshot({ path: `docs/screenshots/ui-${name}.png`, clip: box });
  await page.evaluate(`document.body.click()`);
  await page.waitForTimeout(200);
}

console.log('errors', JSON.stringify(errors.slice(0, 4)));
await browser.close();
await new Promise((resolve) => server.httpServer.close(resolve));
