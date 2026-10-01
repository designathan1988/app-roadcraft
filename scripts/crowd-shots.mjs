/* global window, document, requestAnimationFrame, Image */
// One crowd scenario (tests/fixtures/crowdScenarios.ts) in the RUNNING game
// (`npm run dev`), photographed as a timed sequence from a FIXED camera, so
// slides, jumps, swaying and uneven speed stay visible. Writes <out>/<name>.jpg.
//   node scripts/crowd-shots.mjs <base> <out> <name> [startSeconds] [stepSeconds] [frames] [distance] [elevation] [cx cy]
// e.g. node scripts/crowd-shots.mjs http://localhost:5173 docs/audit/<date>/scenarios gap-one 6 0.5 8 30 1.2
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from '@playwright/test';

const [BASE, OUTDIR, NAME, START = '4', STEP = '1', FRAMES = '8', DIST = '40', ELEV = '0.95', CX, CY] = process.argv.slice(2);
const OUT = path.resolve(OUTDIR);
fs.mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', args: ['--use-gl=angle', '--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
try {
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e.message)));
await page.goto(`${BASE}/?people=crowd`, { waitUntil: 'networkidle' });
await page.waitForFunction('Boolean(window.__roadcraft)', null, { timeout: 60000 });
const placed = await page.evaluate(async ({ name, start, cx, cy }) => {
  const R = window.__roadcraft;
  const step = (_sim, o) => R.step(o.traffic, o.pedestrians);
  const addScriptedWalker = (sim, spec) => R.crowd.add(sim, spec);
  const { SCENARIOS } = await import('/tests/fixtures/crowdScenarios.ts');
  const sc = SCENARIOS.find((s) => s.name === name);
  R.loadDoc(sc.doc.toJSON());
  R.sim.pedestrianIntensity = 0;
  R.sim.trafficIntensity = 0;
  R.sim.clock.paused = true;
  step(R.sim, { traffic: false, pedestrians: true });
  const ids = [];
  for (const wk of sc.walkers(R.net)) ids.push(addScriptedWalker(R.sim, { x: wk.x, y: wk.y, goal: wk.goal, ...(wk.pace !== undefined ? { pace: wk.pace } : {}), ...(wk.leader !== undefined ? { leader: ids[wk.leader] } : {}) }));
  // A zero-second photo still needs the initial bodies published; no tick is advanced.
  R.sim.pedEngine.publish(R.sim);
  for (let i = 0; i < Math.round(start / R.DT); i++) step(R.sim, { traffic: false, pedestrians: true });
  window.__focus = sc.focus;
  if (cx !== undefined) window.__fixed = { x: Number(cx), y: Number(cy) };
  return ids.filter((i) => i !== null).length;
}, { name: NAME, start: Number(START), cx: CX, cy: CY });
const shots = [];
for (let k = 0; k < Number(FRAMES); k++) {
  shots.push(await page.evaluate(async ({ stepSeconds, dist, elev }) => {
    const R = window.__roadcraft;
    const step = (_sim, o) => R.step(o.traffic, o.pedestrians);
    // Look where the people are: their centre.
    // The camera stays where the people were at the first frame, so motion shows.
    if (!window.__fixed) {
      const v = R.sim.pedViews;
      window.__fixed = v.length ? { x: v.reduce((s, p) => s + p.x, 0) / v.length, y: v.reduce((s, p) => s + p.y, 0) / v.length } : window.__focus;
    }
    const cx = window.__fixed.x, cy = window.__fixed.y;
    R.lookAt(cx, cy, 20);
    R.scene().census();
    for (let i = 0; i < 4; i++) await new Promise((r) => requestAnimationFrame(r));
    // Casting precedes asynchronous model loading. Wait for the actual drawn
    // meshes of the visible cast, with simulation time and camera held fixed.
    const deadline = Date.now() + 30000;
    for (;;) {
      const drawn = [];
      let assetError;
      R.scene().scene.traverse((o) => {
        if (o.userData.error) assetError = o.userData.error;
        if (o.isInstancedMesh && o.count > 0 && o.visible) drawn.push(o.name);
      });
      if (assetError) throw new Error(`Citizen model failed to load: ${assetError}`);
      const cast = R.scene().census();
      if (cast.every((person) => drawn.some((name) => name.startsWith(`citizen-${person.model}-`)))) break;
      if (Date.now() >= deadline) throw new Error('Timed out waiting for visible citizen meshes');
      await new Promise((r) => requestAnimationFrame(r));
    }
    const h = R.scene().elevationAt(cx, cy);
    const shot = R.scene().inspect.shot({ x: cx, y: cy, h: h + 1, azimuth: 1.25, elevation: elev, distance: dist, fov: 35, width: 640, height: 480 });
    for (let i = 0; i < Math.round(stepSeconds / R.DT); i++) step(R.sim, { traffic: false, pedestrians: true });
    return shot;
  }, { stepSeconds: Number(STEP), dist: Number(DIST), elev: Number(ELEV) }));
}
const rows = Math.ceil(shots.length / 2);
const sheet = await page.evaluate(async ({ urls, rows, step }) => {
  const c = document.createElement('canvas'); c.width = 1280; c.height = 480 * rows;
  const g = c.getContext('2d');
  for (let i = 0; i < urls.length; i++) {
    const img = new Image(); img.src = urls[i]; await img.decode();
    g.drawImage(img, (i % 2) * 640, Math.floor(i / 2) * 480);
    g.fillStyle = 'rgba(0,0,0,.6)'; g.fillRect((i % 2) * 640, Math.floor(i / 2) * 480, 92, 26);
    g.fillStyle = '#fff'; g.font = '600 18px monospace'; g.fillText(`+${(i * step).toFixed(2)}s`, (i % 2) * 640 + 6, Math.floor(i / 2) * 480 + 19);
  }
  return c.toDataURL('image/jpeg', 0.85);
}, { urls: shots, rows, step: Number(STEP) });
fs.writeFileSync(path.join(OUT, `${NAME}.jpg`), Buffer.from(sheet.split(',')[1], 'base64'));
console.log('placed', placed, 'errors', errors.slice(0, 3));
if (errors.length) throw new Error(`Scenario page errors: ${errors.join('; ')}`);
} finally {
await browser.close();
}
