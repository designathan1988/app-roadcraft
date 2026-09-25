/* global window, performance, requestAnimationFrame */
/**
 * Photographs the scene for a visual before/after: fixed cameras, three
 * close-ups, a slow pan and zoom, and the frame rate with full traffic.
 *
 *   node scripts/capture-scene.mjs <out-dir> [base-url]
 *
 * Drives the installed Chrome on the real GPU (CHROME_PATH to override)
 * against a RUNNING dev or preview server (default http://localhost:5176).
 * The scene is the saved player map (tests/fixtures/grid-and-bends.json).
 *
 * Writes into <out-dir>:
 *   overview.jpg, mid-junction.jpg        the fixed cameras
 *   close-kerb.jpg                        footway, kerb and asphalt
 *   close-tree.jpg                        a tree beside the footway
 *   close-car.jpg                         a car in the street by the kerb
 *   close-lamp.jpg, poles-wires.jpg       a street light; a pole run with wires
 *   motion/pan-NN.jpg, motion/zoom-NN.jpg slow pan and zoom, for shimmer
 *   fps.json                              frame rate, full traffic, high and low tiers
 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from '@playwright/test';

const OUT = path.resolve(process.argv[2] ?? 'docs/screenshots/scene');
const BASE = process.argv[3] ?? 'http://localhost:5176';
fs.mkdirSync(path.join(OUT, 'motion'), { recursive: true });

const browser = await chromium.launch({
  ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' }),
  args: ['--use-gl=angle', `--use-angle=${process.platform === 'win32' ? 'd3d11' : 'vulkan'}`,
    '--enable-gpu', '--ignore-gpu-blocklist', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e.message)));

await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
await page.waitForFunction('Boolean(window.__roadcraft)', null, { timeout: 60_000 });
// The scene only: every panel hidden, the 3D canvas and its overlay kept.
await page.addStyleTag({ content: '#app > *:not(canvas) { visibility: hidden !important; }' });
// Time every draw call's CPU side, to compare frames that vsync caps at 60.
await page.evaluate(() => {
  const scene = window.__roadcraft.scene();
  const draw = scene.draw.bind(scene);
  window.__drawMs = [];
  scene.draw = (...args) => { const t0 = performance.now(); draw(...args); window.__drawMs.push(performance.now() - t0); };
});
const fixture = JSON.parse(fs.readFileSync(path.resolve('tests/fixtures/grid-and-bends.json'), 'utf8'));
await page.evaluate((doc) => {
  const R = window.__roadcraft;
  R.doc.replaceFromJSON(doc);
  R.net.rebuild();
  // A pole run on the footway of the longest road, so wires and pole lamps
  // are in the scene too (the fixture has none).
  let best = null;
  for (const ribbon of R.net.ribbons.values()) if (!best || ribbon.full.length > best.full.length) best = ribbon;
  const out = best.road.width / 2 + best.road.sidewalk * 0.7;
  let previous = null;
  for (let s = best.full.length * 0.3; s < best.full.length * 0.7; s += 42) {
    const f = best.full.sampleAt(s);
    const pole = R.doc.addPole({ x: f.p.x - f.n.x * out, y: f.p.y - f.n.y * out }, true);
    if (previous) R.doc.addPoleSpan(previous.id, pole.id);
    previous = pole;
  }
  R.net.rebuild();
  R.scene().setQuality('high');
  R.sim.trafficIntensity = 2;
  R.sim.pedestrianIntensity = 1.5;
  R.runSim(90);
  R.redraw();
}, fixture.document);
await page.waitForTimeout(6000);

async function look(zoom, at, settle = 2500) {
  await page.evaluate(({ zoom, at }) => {
    const v = window.__roadcraft.scene().viewport;
    v.zoomAt(640, 400, zoom / v.zoom);
    v.moveTo(at);
    window.__roadcraft.redraw();
  }, { zoom, at });
  await page.waitForTimeout(settle);
}
async function shot(name) {
  await page.evaluate(() => window.__roadcraft.setTraffic(false));
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(OUT, name), type: 'jpeg', quality: 88, timeout: 120_000 });
  await page.evaluate(() => window.__roadcraft.setTraffic(true));
}

// ---- where the close-ups look -------------------------------------------
const targets = await page.evaluate(() => {
  const R = window.__roadcraft;
  const S = R.sim;
  // A kerb: the middle of the longest ribbon, at the carriageway's edge.
  let best = null;
  for (const ribbon of R.net.ribbons.values()) if (!best || ribbon.full.length > best.full.length) best = ribbon;
  const f = best.full.sampleAt(best.full.length / 2);
  const kerb = { x: f.p.x + f.n.x * (best.road.width / 2), y: f.p.y + f.n.y * (best.road.width / 2) };
  // A tree: the first instance of any tree mesh, nearest a road.
  let tree = null;
  R.scene().scene.traverse((o) => {
    if (tree || !o.isInstancedMesh || !o.name.startsWith('trees-') || o.count === 0) return;
    const m = new o.matrixWorld.constructor();
    o.getMatrixAt(0, m);
    tree = { x: m.elements[12], y: -m.elements[14] };
  });
  // A car on the outermost lane of a straight link.
  const cars = [...S.vehicles.values()].filter((v) => ['sedan', 'suv', 'hatch', 'van'].includes(v.archetype.id));
  const car = cars.find((v) => S.lanelet(v.lanelet)?.kind === 'link' && S.lanelet(v.lanelet).laneIndex === 0) ?? cars[0];
  let carAt = null;
  if (car) {
    const lane = S.lanelet(car.lanelet);
    carAt = lane.centre.sampleAt(Math.max(0, car.s - car.archetype.length / 2)).p;
  }
  let lamp = null;
  R.scene().scene.traverse((o) => {
    if (lamp || !o.isInstancedMesh || o.name !== 'street-lights' || o.count === 0) return;
    const m = new o.matrixWorld.constructor();
    o.getMatrixAt(Math.floor(o.count / 2), m);
    lamp = { x: m.elements[12], y: -m.elements[14] };
  });
  const poles = [...R.doc.poles.values()];
  const pole = poles[Math.floor(poles.length / 2)] ?? null;
  return { kerb, tree, car: carAt, carId: car?.id ?? null, lamp, pole: pole ? { x: pole.x, y: pole.y } : null };
});

// ---- fixed cameras --------------------------------------------------------
await look(0.24, { x: -61, y: 314 }, 4000);
await shot('overview.jpg');
await look(1.6, targets.kerb, 3000);
await shot('mid-junction.jpg');

// ---- close-ups ------------------------------------------------------------
await look(28, targets.kerb, 3500);
await shot('close-kerb.jpg');
if (targets.tree) { await look(14, targets.tree, 3500); await shot('close-tree.jpg'); }
if (targets.car) {
  await page.evaluate(() => window.__roadcraft.setTraffic(false));
  await look(26, targets.car, 4500);
  await page.screenshot({ path: path.join(OUT, 'close-car.jpg'), type: 'jpeg', quality: 88, timeout: 120_000 });
  await page.evaluate(() => window.__roadcraft.setTraffic(true));
}

if (targets.lamp) { await look(9, targets.lamp, 3500); await shot('close-lamp.jpg'); }
if (targets.pole) { await look(5, targets.pole, 3500); await shot('poles-wires.jpg'); }

// ---- slow pan and zoom, for shimmer and moire -----------------------------
await page.evaluate(() => window.__roadcraft.setTraffic(false));
await look(3, targets.kerb, 2000);
for (let i = 0; i < 8; i++) {
  await page.evaluate(({ at, i }) => {
    const v = window.__roadcraft.scene().viewport;
    v.moveTo({ x: at.x + i * 0.6, y: at.y + i * 0.35 });
    window.__roadcraft.redraw();
  }, { at: targets.kerb, i });
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(OUT, 'motion', `pan-${String(i).padStart(2, '0')}.jpg`), type: 'jpeg', quality: 85 });
}
for (let i = 0; i < 6; i++) {
  await page.evaluate(() => {
    const v = window.__roadcraft.scene().viewport;
    v.zoomAt(640, 400, 0.8);
    window.__roadcraft.redraw();
  });
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(OUT, 'motion', `zoom-${String(i).padStart(2, '0')}.jpg`), type: 'jpeg', quality: 85 });
}
await page.evaluate(() => window.__roadcraft.setTraffic(true));

// ---- frame rate, full traffic --------------------------------------------
async function fps(level) {
  await page.evaluate((level) => {
    const R = window.__roadcraft;
    R.scene().setQuality(level);
    R.sim.trafficIntensity = 3;
    R.sim.pedestrianIntensity = 2;
    const v = R.scene().viewport;
    v.zoomAt(640, 400, 1.0 / v.zoom);
    v.moveTo({ x: -61, y: 314 });
  }, level);
  await page.waitForTimeout(3000);
  return page.evaluate(async () => {
    const samples = [];
    window.__drawMs.length = 0;
    let last = performance.now();
    await new Promise((resolve) => {
      const tick = () => {
        const now = performance.now();
        samples.push(now - last);
        last = now;
        if (samples.length < 240) requestAnimationFrame(tick); else resolve();
      };
      requestAnimationFrame(tick);
    });
    samples.sort((a, b) => a - b);
    const R = window.__roadcraft;
    const draws = [...window.__drawMs].sort((a, b) => a - b);
    const stats = R.scene().stats;
    return { medianFps: +(1000 / samples[120]).toFixed(1), p95FrameMs: +samples[228].toFixed(1),
      medianDrawCpuMs: +(draws[Math.floor(draws.length / 2)] ?? 0).toFixed(2),
      p95DrawCpuMs: +(draws[Math.floor(draws.length * 0.95)] ?? 0).toFixed(2),
      drawCalls: stats.drawCalls, triangles: stats.triangles,
      vehicles: R.sim.vehicles.size, pedestrians: R.sim.peds.size };
  });
}
const result = { high: await fps('high'), low: await fps('low'), errors };
fs.writeFileSync(path.join(OUT, 'fps.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ out: OUT, targets, ...result }, null, 2));
await browser.close();
