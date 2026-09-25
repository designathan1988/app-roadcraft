/* global window, document, requestAnimationFrame, fetch, Image */
/**
 * THE INSPECTION HARNESS: close-ups of anything in the running game, at any
 * angle and resolution, from the development build's inspection camera
 * (`src/render/inspector.ts`), every picture stamped with the build it was
 * taken on (branch, commit, date - `/__build`).
 *
 *   node scripts/inspect-scene.mjs <out-dir> [set ...] [--base=http://localhost:5176] [--limit=20]
 *
 * Loads the inspection map (`tests/fixtures/inspectionMap.ts`: hill, hillside,
 * bridge, elevated road, tunnel, signalised crossing, acute junction and a
 * signalised city grid) into a RUNNING dev server, runs the traffic at peak
 * demand, pauses it, and photographs each set:
 *
 *   play         the play view with the interface, hovering a road (no debug ring)
 *   ground       asphalt, kerb, gutter, footway, markings, grass, trees close up
 *   structures   a car on the hill, the hillside, the bridge, the elevated road
 *                and at the tunnel mouth; a walker on the sloped footway
 *   cars         every vehicle body, four angles each
 *   interior     occupied seats, roof and near side cut away, and through the windscreen
 *   bikes        motorcycles and bicycles with their riders, side and 3/4
 *   people       groups and solo walkers close up
 *   census       every figure the RENDERER drew: model, role, group (census.json)
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
const LIMIT = Number((args.find((a) => a.startsWith('--limit=')) ?? '--limit=20').slice(8));
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
const stamp = await page.evaluate(async () => (await fetch('/__build', { cache: 'no-store' })).json());
const stampText = `${stamp.branch} · ${stamp.hash}${stamp.dirty ? '+' : ''} · ${stamp.date.slice(0, 16).replace('T', ' ')}`;
console.log(`build ${stampText}`);

// The map, built in the page by the same module the tests use.
await page.evaluate(async () => {
  const R = window.__roadcraft;
  const { buildInspectionMap } = await import('/tests/fixtures/inspectionMap.ts');
  const map = buildInspectionMap();
  R.loadDoc(map.doc.toJSON());
  window.__inspection = { segments: map.segments, nodes: map.nodes };
  R.sim.demandMultiplier = 1.55;
  R.setTraffic(true);
  R.runSim(150);
  R.sim.clock.paused = true;
});

const frames = (n) => page.evaluate((count) => new Promise((resolve) => {
  let left = count;
  const tick = () => (--left <= 0 ? resolve() : requestAnimationFrame(tick));
  requestAnimationFrame(tick);
}), n);

/** A node of the inspection map, in world units with its ground height. */
const nodeAt = (key) => page.evaluate((key) => {
  const R = window.__roadcraft;
  const node = R.doc.node(window.__inspection.nodes[key]);
  const p = node.pos ?? node;
  return { x: p.x, y: p.y, h: R.scene().elevationAt(p.x, p.y) };
}, key);

// Citizen and vehicle assets load lazily: look at the city until the crowd has bodies.
{
  const c = await nodeAt('city');
  await page.evaluate(({ x, y }) => window.__roadcraft.lookAt(x, y, 60), c);
  for (let i = 0; i < 20; i++) { await frames(10); await page.waitForTimeout(400); }
}

const manifest = [];

/** Writes a data URL to `name.png` with the build stamp burnt into its corner. */
async function save(name, url, note, spec) {
  const stamped = await page.evaluate(async ({ url, text }) => {
    const img = new Image();
    img.src = url;
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = img.width;
    canvas.height = img.height;
    const g = canvas.getContext('2d');
    g.drawImage(img, 0, 0);
    const size = Math.max(14, Math.round(img.height / 42));
    g.font = `600 ${size}px ui-monospace, Consolas, monospace`;
    const w = g.measureText(text).width + size;
    g.fillStyle = 'rgba(0,0,0,0.62)';
    g.fillRect(img.width - w - 6, img.height - size * 1.7 - 6, w, size * 1.7);
    g.fillStyle = '#ffffff';
    g.fillText(text, img.width - w - 6 + size / 2, img.height - size * 0.55 - 6);
    return canvas.toDataURL('image/png');
  }, { url, text: stampText });
  fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(stamped.split(',')[1], 'base64'));
  manifest.push({ name, note, spec });
}

/** Moves the play view over a point, lets it draw, then takes the shot. */
async function shoot(name, spec, note, zoom = 60) {
  await page.evaluate(({ x, y, zoom }) => { window.__roadcraft.lookAt(x, y, zoom); }, { ...spec, zoom });
  await frames(4);
  const url = await page.evaluate((s) => window.__roadcraft.scene().inspect?.shot(s) ?? null, spec);
  if (!url) throw new Error('no inspection camera: is this a development build?');
  await save(name, url, note, spec);
}

/**
 * Where a vehicle or walker is drawn: plan position, heading, and height of
 * its own road (deck, bore or footway), from the same pose and height field
 * the renderer uses.
 */
async function locate(kind, filter = {}) {
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
        if (filter.archetype && v.archetype.id !== filter.archetype) continue;
        const pose = vehiclePose(R.sim, v, 1);
        if (!pose) continue;
        const structure = seg === undefined ? undefined : R.doc.segment(seg)?.structure;
        const along = lane.length > 0 ? v.s / lane.length : 0;
        let seated = 0;
        for (let i = 0; i < 32; i++) if (v.seats & (1 << i)) seated++;
        out.push({ id: v.id, x: pose.p.x, y: pose.p.y, heading: pose.angle, along, archetype: v.archetype.id,
          shape: v.archetype.shape, width: v.archetype.width, length: v.archetype.length, height: v.archetype.height,
          seated, junction: seg === undefined, h: scene.elevationAt(pose.p.x, pose.p.y, structure) });
      }
    } else {
      for (const p of R.sim.pedsInIdOrder()) {
        const edge = R.sim.sidewalks.edges.get(p.edge);
        if (!edge) continue;
        if (filter.segment && edge.segment !== M.segments[filter.segment]) continue;
        if (filter.onFootway && edge.kind === 'crossing') continue;
        if (filter.crossing && edge.kind !== 'crossing') continue;
        const pose = pedPose(R.sim, p, 1);
        if (!pose) continue;
        out.push({ id: p.id, x: pose.p.x, y: pose.p.y, heading: pose.angle, party: p.party.size, partyId: p.party.id,
          h: scene.elevationAt(pose.p.x, pose.p.y) + (edge.kind === 'crossing' ? 0 : FOOTWAY_RISE) });
      }
    }
    return out;
  }, { kind, filter });
}

const pick = (list, prefer = () => 0) => [...list].sort((a, b) => prefer(a) - prefer(b))[0];
/** Metres to world units (one unit is 0.4 m). */
const M = (metres) => metres / 0.4;

if (want('play')) {
  // The play view as the player sees it, interface and build stamp included,
  // the pointer resting on a road with the road tool (no debug ring may show).
  const c = await nodeAt('city');
  await page.evaluate(({ x, y }) => window.__roadcraft.lookAt(x, y, 14), c);
  await frames(6);
  await page.mouse.move(700, 420);
  await frames(6);
  await page.screenshot({ path: path.join(OUT, 'play-hover-road.png') });
  manifest.push({ name: 'play-hover-road', note: 'play view, pointer on a road, road tool' });
  await page.evaluate(({ x, y }) => window.__roadcraft.lookAt(x + 30, y + 20, 45), c);
  await frames(6);
  await page.mouse.move(640, 400);
  await frames(6);
  await page.screenshot({ path: path.join(OUT, 'play-close.png') });
  manifest.push({ name: 'play-close', note: 'play view at the closest zoom' });
}

if (want('ground')) {
  const n = await nodeAt('city');
  const views = [
    ['ground-junction-overview', { x: n.x, y: n.y, h: n.h, azimuth: 0.9, elevation: 0.75, distance: M(38) }],
    ['ground-asphalt-close', { x: n.x + M(14), y: n.y + M(2), h: n.h, azimuth: 0.4, elevation: 0.5, distance: M(4) }],
    ['ground-kerb-gutter', { x: n.x + M(16), y: n.y + M(7.5), h: n.h, azimuth: -1.2, elevation: 0.35, distance: M(3.5) }],
    ['ground-footway', { x: n.x + M(18), y: n.y + M(10), h: n.h, azimuth: 0.2, elevation: 0.7, distance: M(6) }],
    ['ground-zebra', { x: n.x, y: n.y + M(12), h: n.h, azimuth: Math.PI / 2, elevation: 0.9, distance: M(22) }],
    ['ground-grass-far', { x: n.x + M(120), y: n.y + M(260), h: n.h, azimuth: 0.7, elevation: 0.78, distance: M(260) }],
    ['ground-trees', { x: n.x + M(45), y: n.y + M(40), h: n.h, azimuth: 0.7, elevation: 0.6, distance: M(35) }],
  ];
  for (const [name, spec] of views) await shoot(name, { fov: 35, width: 1600, height: 1000, ...spec }, name);
}

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

const vehicles = want('cars') || want('interior') || want('bikes') ? await locate('vehicle') : [];
/** One of each archetype, the fullest, not in a junction. */
const byArchetype = new Map();
for (const v of vehicles) if (!v.junction && (!byArchetype.has(v.archetype) || v.seated > byArchetype.get(v.archetype).seated)) byArchetype.set(v.archetype, v);

if (want('cars')) {
  for (const v of byArchetype.values()) {
    if (v.shape === 'motorcycle' || v.shape === 'bicycle') continue;
    const at = { x: v.x, y: v.y, h: v.h + v.height * 0.45, fov: 30, width: 1600, height: 1000 };
    const d = Math.max(v.length, v.height * 2) * 1.9;
    await shoot(`car-${v.archetype}-front34`, { ...at, azimuth: v.heading + 0.65, elevation: 0.22, distance: d }, `${v.archetype} #${v.id} front 3/4`);
    await shoot(`car-${v.archetype}-side`, { ...at, azimuth: v.heading + Math.PI / 2, elevation: 0.05, distance: d }, `${v.archetype} #${v.id} side`);
    await shoot(`car-${v.archetype}-rear34`, { ...at, azimuth: v.heading + Math.PI - 0.65, elevation: 0.3, distance: d }, `${v.archetype} #${v.id} rear 3/4`);
    await shoot(`car-${v.archetype}-top`, { ...at, azimuth: v.heading + 0.9, elevation: 0.85, distance: d }, `${v.archetype} #${v.id} from above (play angle)`);
  }
}

if (want('interior')) {
  const occupied = vehicles.filter((v) => v.seated > 0 && v.shape !== 'motorcycle' && v.shape !== 'bicycle' && !v.junction)
    .sort((a, b) => b.seated - a.seated);
  const seen = new Map();
  let n = 0;
  for (const v of occupied) {
    const count = seen.get(v.archetype) ?? 0;
    if (count >= 3 || n >= LIMIT) continue;
    seen.set(v.archetype, count + 1);
    n++;
    const at = { x: v.x, y: v.y, h: v.h + v.height * 0.4, fov: 30, width: 1600, height: 1000 };
    const d = Math.max(v.length * 0.9, M(3.6));
    const interior = { heading: v.heading, roofCut: v.height * 0.5, halfWidth: v.width / 2 };
    await shoot(`interior-${v.archetype}-${v.id}-left`, { ...at, azimuth: v.heading + Math.PI / 2, elevation: 0.5, distance: d, interior },
      `${v.archetype} #${v.id}, ${v.seated} aboard, roof and left side cut away`);
    await shoot(`interior-${v.archetype}-${v.id}-right`, { ...at, azimuth: v.heading - Math.PI / 2, elevation: 0.5, distance: d, interior },
      `${v.archetype} #${v.id}, roof and right side cut away`);
    await shoot(`interior-${v.archetype}-${v.id}-windscreen`, { ...at, azimuth: v.heading, elevation: 0.18, distance: d * 1.2 },
      `${v.archetype} #${v.id} through the windscreen`);
    await shoot(`interior-${v.archetype}-${v.id}-above`, { ...at, azimuth: v.heading + 0.9, elevation: 0.85, distance: d * 1.6 },
      `${v.archetype} #${v.id} from the play angle (roof must be opaque)`);
  }
}

if (want('bikes')) {
  const bikes = vehicles.filter((v) => (v.shape === 'motorcycle' || v.shape === 'bicycle') && !v.junction).slice(0, 6);
  for (const v of bikes) {
    const at = { x: v.x, y: v.y, h: v.h + M(0.8), fov: 30, width: 1400, height: 1000 };
    await shoot(`bike-${v.archetype}-${v.id}-side`, { ...at, azimuth: v.heading + Math.PI / 2, elevation: 0.08, distance: M(4.2) }, `${v.archetype} #${v.id} side`);
    await shoot(`bike-${v.archetype}-${v.id}-front34`, { ...at, azimuth: v.heading + 0.6, elevation: 0.25, distance: M(4) }, `${v.archetype} #${v.id} front 3/4`);
    await shoot(`bike-${v.archetype}-${v.id}-above`, { ...at, azimuth: v.heading - 2.3, elevation: 0.7, distance: M(4.5) }, `${v.archetype} #${v.id} from above behind`);
  }
}

if (want('people')) {
  const walkers = await locate('ped', { onFootway: true });
  const parties = new Map();
  for (const w of walkers) if (w.party > 1 && !parties.has(w.partyId)) parties.set(w.partyId, w);
  let i = 0;
  for (const w of parties.values()) {
    if (i++ >= LIMIT) break;
    await shoot(`group-${w.partyId}`, { x: w.x, y: w.y, h: w.h + M(0.9), azimuth: w.heading + 1.2, elevation: 0.12,
      distance: M(7), fov: 30, width: 1400, height: 1000 }, `party ${w.partyId} (${w.party} people)`);
  }
  i = 0;
  for (const w of walkers.filter((p) => p.party === 1)) {
    if (i++ >= LIMIT) break;
    await shoot(`solo-${w.id}`, { x: w.x, y: w.y, h: w.h + M(0.9), azimuth: w.heading + 1.0, elevation: 0.1,
      distance: M(4.5), fov: 30, width: 1000, height: 1200 }, `walker #${w.id}`);
  }
}

if (want('census')) {
  // What the renderer itself cast, over several frames and views.
  const census = await page.evaluate(async () => {
    const R = window.__roadcraft;
    const all = new Map();
    R.scene().census?.();
    for (const node of R.doc.nodes.values()) {
      R.lookAt(node.x, node.y, 18);
      for (let k = 0; k < 3; k++) {
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        for (const row of R.scene().census?.() ?? []) all.set(`${row.company}:${row.seed}`, row);
      }
    }
    // Recycle the pool: run on and sweep again.
    R.sim.clock.paused = false;
    R.runSim(120);
    R.sim.clock.paused = true;
    for (const node of R.doc.nodes.values()) {
      R.lookAt(node.x, node.y, 18);
      for (let k = 0; k < 3; k++) {
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        for (const row of R.scene().census?.() ?? []) all.set(`${row.company}:${row.seed}`, row);
      }
    }
    return [...all.values()];
  });
  fs.writeFileSync(path.join(OUT, 'census.json'), JSON.stringify(census, null, 2));
  manifest.push({ name: 'census', note: `${census.length} figures` });
}

fs.writeFileSync(path.join(OUT, 'shots.json'), JSON.stringify({ build: stamp, errors, shots: manifest }, null, 2));
console.log(`${manifest.length} shots, ${errors.length} page errors -> ${OUT}`);
if (errors.length) console.log(errors.slice(0, 5).join('\n'));
await browser.close();
