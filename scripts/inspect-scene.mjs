/* global window, requestAnimationFrame */
/**
 * THE INSPECTION HARNESS: close-ups of anything in the running game, at any
 * angle and resolution, from the development build's inspection camera
 * (`src/render/inspector.ts`).
 *
 *   node scripts/inspect-scene.mjs <out-dir> [set ...] [--base=http://localhost:5176]
 *
 * Loads the inspection map (`tests/fixtures/inspectionMap.ts`: hill, hillside,
 * bridge, elevated road, tunnel, signalised crossing, acute junction) into a
 * RUNNING dev server, runs the traffic, and photographs each set:
 *
 *   structures   a car on the hill, the hillside, the bridge, the elevated
 *                road and at the tunnel mouth; a walker on the sloped footway
 *   cars         every vehicle class, three angles each
 *   interior     every occupied seat, roof and near side cut away
 *   people       walkers and groups close up
 *
 * Every entity is framed by id: the play camera is moved over it first, so the
 * frame the inspector photographs is built for that spot (crowd culling and
 * the shadow frustum follow the play view), then the shot is taken from the
 * entity's own drawn pose. Writes PNGs and a shots.json with what each is.
 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from '@playwright/test';

const args = process.argv.slice(2);
const OUT = path.resolve(args.find((a) => !a.startsWith('--')) ?? 'docs/screenshots/inspect');
const BASE = (args.find((a) => a.startsWith('--base=')) ?? '--base=http://localhost:5176').slice(7);
const SETS = args.filter((a) => !a.startsWith('--')).slice(1);
const want = (set) => SETS.length === 0 || SETS.includes(set);
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' }),
  args: ['--use-gl=angle', `--use-angle=${process.platform === 'win32' ? 'd3d11' : 'vulkan'}`,
    '--enable-gpu', '--ignore-gpu-blocklist', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e.message)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
await page.waitForFunction('Boolean(window.__roadcraft)', null, { timeout: 60_000 });
await page.addStyleTag({ content: '#app > *:not(canvas) { visibility: hidden !important; }' });

// The map, built in the page by the same module the tests use.
await page.evaluate(async () => {
  const R = window.__roadcraft;
  const { buildInspectionMap } = await import('/tests/fixtures/inspectionMap.ts');
  const map = buildInspectionMap();
  R.loadDoc(map.doc.toJSON());
  window.__inspection = { segments: map.segments, nodes: map.nodes };
  R.setTraffic(true);
  R.runSim(90);
});
// Citizen and vehicle assets load lazily: wait until the crowd has bodies.
await page.waitForTimeout(4000);

const frames = (n) => page.evaluate((count) => new Promise((resolve) => {
  let left = count;
  const tick = () => (--left <= 0 ? resolve() : requestAnimationFrame(tick));
  requestAnimationFrame(tick);
}), n);

const manifest = [];
/** Moves the play view over a point, lets it draw, then takes the shot. */
async function shoot(name, spec, note) {
  await page.evaluate(({ x, y }) => window.__roadcraft.lookAt(x, y, 40), spec);
  await frames(3);
  const url = await page.evaluate((s) => window.__roadcraft.scene().inspect?.shot(s) ?? null, spec);
  if (!url) throw new Error('no inspection camera: is this a development build?');
  fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(url.split(',')[1], 'base64'));
  manifest.push({ name, note, spec });
}

/**
 * Where a vehicle or walker is drawn: plan position, heading, and height of
 * its own road (deck, bore or footway), from the same pose and height field
 * the renderer uses.
 */
async function locate(kind, filter) {
  return page.evaluate(async ({ kind, filter }) => {
    const R = window.__roadcraft;
    const { vehiclePose, pedPose } = await import('/src/sim/pose.ts');
    const { FOOTWAY_RISE } = await import('/src/world/roadTypes.ts');
    const scene = R.scene();
    const M = window.__inspection;
    const out = [];
    if (kind === 'vehicle') {
      for (const v of R.sim.vehiclesInIdOrder()) {
        const lane = R.sim.graph.lanelets.get(v.lanelet);
        if (!lane) continue;
        const seg = lane.segment;
        if (filter.segment && seg !== M.segments[filter.segment]) continue;
        if (filter.shape && v.archetype.shape !== filter.shape) continue;
        const pose = vehiclePose(R.sim, v, 1);
        if (!pose) continue;
        const structure = seg === undefined ? undefined : R.doc.segment(seg)?.structure;
        const along = lane.length > 0 ? v.s / lane.length : 0;
        out.push({ id: v.id, x: pose.p.x, y: pose.p.y, heading: pose.angle, along, archetype: v.archetype.id,
          width: v.archetype.width, length: v.archetype.length,
          h: scene.elevationAt(pose.p.x, pose.p.y, structure) });
      }
    } else {
      for (const p of R.sim.pedsInIdOrder()) {
        const edge = R.sim.sidewalks.edges.get(p.edge);
        if (!edge) continue;
        if (filter.segment && edge.segment !== M.segments[filter.segment]) continue;
        if (filter.onFootway && edge.kind === 'crossing') continue;
        const pose = pedPose(R.sim, p, 1);
        if (!pose) continue;
        out.push({ id: p.id, x: pose.p.x, y: pose.p.y, heading: pose.angle, party: p.party.size,
          h: scene.elevationAt(pose.p.x, pose.p.y) + (edge.kind === 'crossing' ? 0 : FOOTWAY_RISE) });
      }
    }
    return out;
  }, { kind, filter });
}

const pick = (list, prefer = () => 0) => [...list].sort((a, b) => prefer(a) - prefer(b))[0];

if (want('structures')) {
  for (const [segment, prefer] of [
    ['slope', (v) => Math.abs(v.along - 0.35)],
    ['crossfall', (v) => Math.abs(v.along - 0.5)],
    ['bridge', (v) => Math.abs(v.along - 0.5)],
    ['elevated', (v) => Math.abs(v.along - 0.15)],
    ['tunnel', (v) => v.along],
  ]) {
    const v = pick(await locate('vehicle', { segment }), prefer);
    if (!v) { manifest.push({ name: `structure-${segment}`, note: 'no vehicle found' }); continue; }
    const side = v.heading + Math.PI / 2;
    await shoot(`structure-${segment}-side`, { x: v.x, y: v.y, h: v.h + 1, azimuth: side, elevation: 0.08,
      distance: v.length * 2.2, fov: 30, width: 1400, height: 800 }, `${v.archetype} #${v.id} on ${segment}, side`);
    await shoot(`structure-${segment}-34`, { x: v.x, y: v.y, h: v.h + 1, azimuth: v.heading + 0.7, elevation: 0.3,
      distance: v.length * 3, fov: 30, width: 1400, height: 800 }, `${v.archetype} #${v.id} on ${segment}, 3/4`);
  }
  const walkers = await locate('ped', { segment: 'slope', onFootway: true });
  const w = pick(walkers, (p) => Math.abs(p.x + 550));
  if (w) {
    await shoot('structure-walker-slope-side', { x: w.x, y: w.y, h: w.h + 2.2, azimuth: w.heading + Math.PI / 2,
      elevation: 0.02, distance: 14, fov: 30, width: 1200, height: 900 }, `walker #${w.id} on the hill footway, side`);
  } else {
    manifest.push({ name: 'structure-walker-slope-side', note: 'no walker on the hill footway' });
  }
}

fs.writeFileSync(path.join(OUT, 'shots.json'), JSON.stringify({ errors, shots: manifest }, null, 2));
console.log(`${manifest.length} shots, ${errors.length} page errors -> ${OUT}`);
if (errors.length) console.log(errors.slice(0, 5).join('\n'));
await browser.close();
