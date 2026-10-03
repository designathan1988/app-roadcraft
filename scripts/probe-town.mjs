/* global window, document, localStorage, performance */
// The default town, photographed and measured: the map the game opens on,
// built through its own module (`src/world/defaultTown.ts`) inside the running
// app, from a list of cameras - the overview, the avenue, the square, each
// neighbourhood, the works, the water - plus the numbers a picture cannot
// answer: heights, the steepest grade a street reached, and whether the scene
// booted without a page error.
//
//   node scripts/probe-town.mjs --base=http://127.0.0.1:4180 --out=docs/audit/town
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

const opt = (name, fallback) => (process.argv.find((a) => a.startsWith(`--${name}=`)) ?? `--${name}=${fallback}`).slice(name.length + 3);
const base = opt('base', 'http://127.0.0.1:4180');
const out = opt('out', 'docs/audit/town');
mkdirSync(out, { recursive: true });

/**
 * name, x, y, zoom (px per world unit), quarter turns of the camera, elevation
 * (rad, optional), and canvas size (optional).
 *
 * The zoom FLOOR is the canvas height divided by the world the rig may hold
 * (see `isoZoomBounds`), so a wide shot of the whole map is taken through a
 * SMALL canvas: at 1600x900 the play camera cannot pull back past about 0.42,
 * which is 3 800 units across and not the whole town.
 */
const SHOTS = [
  ['01-overview', -100, -100, 0.42, 0],
  ['02-town', 0, -120, 0.42, 0],
  ['03-avenue', 0, 0, 0.6, 2],
  ['04-avenue-west', -900, 0, 0.7, 2],
  ['05-square', 0, 240, 0.9, 0],
  ['06-north-blocks', -450, 300, 0.8, 0],
  ['07-south-blocks', -600, -300, 0.8, 0],
  ['08-works', 1200, -100, 0.7, 0],
  ['09-stream', 1900, 0, 0.6, 0],
  ['10-west-hill', -1400, -300, 0.4, 2],
  ['13-low-angle', -100, -300, 0.5, 0, 0.6, 1600, 700],
  ['14-low-north', -300, 700, 0.45, 1, 0.55, 1600, 700],
  ['15-low-works', 900, -200, 0.5, 2, 0.62, 1600, 700],
  ['11-wide', -100, -150, 0.22, 0, 0, 1600, 520],
  ['12-wide-north', -250, 900, 0.2, 0, 0, 1600, 460],
];

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 300)));
await page.addInitScript(() => { window.confirm = () => true; try { localStorage.setItem('roadcraft.sky', 'day'); } catch { /* blocked */ } });
await page.goto(base, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => Boolean(window.__roadcraft), null, { timeout: 120_000 });
await page.waitForTimeout(1200);

const built = await page.evaluate(async () => {
  const R = window.__roadcraft;
  const { buildDefaultTown } = await import('/src/world/defaultTown.ts');
  const { RoadDoc } = await import('/src/world/doc.ts');
  const town = new RoadDoc();
  const t0 = performance.now();
  const buildings = buildDefaultTown(town);
  const buildMs = performance.now() - t0;
  R.loadDoc(town.toJSON());
  R.sim.clock.paused = true;
  return { buildMs: Math.round(buildMs), buildings };
});
await page.waitForTimeout(4000);

const measured = await page.evaluate(() => {
  const R = window.__roadcraft;
  const S = R.scene();
  const at = (x, y) => Number(S.terrainHeightAt(x, y).toFixed(1));
  // The steepest grade any street had to be solved with, from the nodes the
  // player sees rather than from a profile: two nodes and their distance.
  let steepest = 0;
  let steepestAt = null;
  for (const seg of R.doc.segments.values()) {
    // A bridge ramp is allowed to be steep (RAMP_GRADE, 16%); a STREET is not.
    if ((seg.structure ?? 'ground') !== 'ground') continue;
    const a = R.doc.node(seg.a);
    const b = R.doc.node(seg.b);
    if (!a || !b) continue;
    const run = Math.hypot(b.x - a.x, b.y - a.y);
    if (run < 1) continue;
    const grade = Math.abs(S.elevationAt(a.x, a.y) - S.elevationAt(b.x, b.y)) / run;
    if (grade > steepest) { steepest = grade; steepestAt = { a: [Math.round(a.x), Math.round(a.y)], b: [Math.round(b.x), Math.round(b.y)] }; }
  }
  // The shape of the network itself: what the player would call "a street that
  // goes nowhere", and whether the town is one connected piece.
  const degree = new Map();
  for (const seg of R.doc.segments.values()) {
    degree.set(seg.a, (degree.get(seg.a) ?? 0) + 1);
    degree.set(seg.b, (degree.get(seg.b) ?? 0) + 1);
  }
  const deadEnds = [];
  for (const [id, n] of R.doc.nodes) {
    if ((degree.get(id) ?? 0) === 1) deadEnds.push([Math.round(n.x), Math.round(n.y)]);
  }
  const seen = new Set();
  let components = 0;
  for (const [id] of R.doc.nodes) {
    if (seen.has(id)) continue;
    components++;
    const stack = [id];
    while (stack.length) {
      const at = stack.pop();
      if (seen.has(at)) continue;
      seen.add(at);
      for (const seg of R.doc.segments.values()) {
        if (seg.a === at && !seen.has(seg.b)) stack.push(seg.b);
        else if (seg.b === at && !seen.has(seg.a)) stack.push(seg.a);
      }
    }
  }
  return {
    nodes: R.doc.nodes.size,
    segments: R.doc.segments.size,
    deadEnds,
    components,
    buildings: R.doc.buildings.size,
    barriers: R.doc.barriers.size,
    poles: R.doc.poles.size,
    stamps: R.doc.terrainStamps.length,
    people: R.doc.people.length,
    triangles: S.stats.triangles,
    drawCalls: S.stats.drawCalls,
    steepestGrade: Number((steepest * 100).toFixed(1)),
    steepestAt,
    heights: {
      avenueWest: at(-1400, 0), town: at(0, 0), avenueEast: at(600, 0),
      works: at(1150, -100), stream: at(1960, 0), westHill: at(-1800, -650),
      northRidge: at(0, 1350), northMountain: at(-200, 1950), southMountain: at(-1000, -1970),
      southHill: at(-1400, -1400), mapWest: at(-2300, 0), mapEast: at(2300, 0),
      mapNorth: at(0, 2300), mapSouth: at(0, -2300),
    },
  };
});

const shots = [];
let size = [1600, 900];
for (const [name, x, y, zoom, turns, elevation, width, height] of SHOTS) {
  if (width && height && (width !== size[0] || height !== size[1])) {
    size = [width, height];
    await page.setViewportSize({ width, height });
    await page.waitForTimeout(900);
  }
  await page.evaluate(([x, y, zoom, turns, elevation]) => {
    const R = window.__roadcraft;
    const v = R.scene().viewport;
    const canvas = document.getElementById('game');
    const azimuth = Math.PI / 4 + (turns ?? 0) * (Math.PI / 2);
    v.setOrbit(azimuth, elevation || 0.8378);
    v.zoomAt(canvas.clientWidth / 2, canvas.clientHeight / 2, zoom / v.zoom, canvas.clientWidth, canvas.clientHeight);
    v.moveTo({ x, y });
  }, [x, y, zoom, turns, elevation]);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${out}/${name}.png` });
  shots.push(`${name} @${Math.round(await page.evaluate(() => window.__roadcraft.scene().viewport.zoom * 100)) / 100}`);
}

writeFileSync(`${out}/measurements.json`, JSON.stringify({ built, measured, errors }, null, 2));
console.log(JSON.stringify({ built, measured, shots: shots.length, errors }, null, 2));
await browser.close();
