/**
 * Boots the built game in the installed Chrome (real GPU) and drives the
 * building tool through the scenarios of docs/buildings.md, the way a player
 * would: through the tool's own pointer and keyboard paths, not by writing
 * records. Each scenario asserts what must hold and writes a screenshot to
 * docs/screenshots/buildings-<name>.jpg. Exits non-zero on the first failed
 * expectation or on any page error.
 *
 *   npm run build && node scripts/verify-buildings.mjs
 *
 * The same GPU flags as scripts/verify-visual.mjs (never SwiftShader unless
 * ROADCRAFT_SOFTWARE_GL=1).
 */
import { chromium } from '@playwright/test';
import { preview } from 'vite';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const PORT = Number(process.env.ROADCRAFT_BUILDINGS_PORT ?? 5198);
const SHOT_DIR = path.resolve('docs', 'screenshots');
const SOFTWARE_GL = process.env.ROADCRAFT_SOFTWARE_GL === '1';
const LAUNCH_ARGS = SOFTWARE_GL
  ? ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox']
  : ['--use-gl=angle', `--use-angle=${process.platform === 'win32' ? 'd3d11' : 'metal'}`, '--enable-gpu', '--ignore-gpu-blocklist', '--no-sandbox'];

/** Helpers every scenario runs with, in the page. */
const PRELUDE = `
  const R = window.__roadcraft;
  const D = R.doc;
  const T = R.buildings;
  const S = R.scene();
  const V = S.viewport;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const settle = async () => { R.redraw(); await wait(700); };
  const clear = () => {
    for (const id of [...D.segments.keys()]) D.removeSegment(id);
    for (const id of [...D.nodes.keys()]) D.removeNode(id);
    for (const b of [...D.buildings.all()]) D.buildings.remove(b.id);
    D.clearTerrain();
    R.net.rebuild();
  };
  const street = () => {
    const a = D.addNode({ x: -160, y: 0 });
    const b = D.addNode({ x: 160, y: 0 });
    D.addSegment(a.id, b.id, 1);
    R.net.rebuild();
  };
  const tool = async () => {
    document.querySelector('[data-tool="building"]').click();
    await wait(150);
  };
  const place = (key, x, y) => {
    T.chooseBlueprint(key);
    T.hoverPlace({ x, y });
    const valid = T.preview && T.preview.valid;
    T.pointerDown({ x: 1, y: 1 }, { x, y }, false);
    T.pointerUp(false);
    return valid ? T.selection.building : null;
  };
  const local = (b, lx, ly) => {
    const c = Math.cos(b.rotation), s = Math.sin(b.rotation);
    return { x: b.x + lx * c - ly * s, y: b.y + lx * s + ly * c };
  };
  const elevation = (b, level) => { let z = 0; for (let i = 0; i < level; i++) z += (b.levels?.[i] ?? (i === 0 ? b.groundHeight : b.storeyHeight)); return z; };
  /** Points the armed element at a face point (local lx, ly) on a storey, and clicks. */
  const aimAndClick = (b, lx, ly, level) => {
    const p = local(b, lx, ly);
    const screen = V.toScreen(p, innerWidth, innerHeight, T.floorOf(b) + elevation(b, level) + 3);
    T.pointerMove(screen, p, false);
    const preview = T.preview && { valid: T.preview.valid, problem: T.preview.problem };
    T.pointerDown(screen, p, false);
    T.pointerUp(false);
    return preview;
  };
  const frame = (x, y, zoom) => { V.moveTo({ x, y }); V.zoomAt(innerWidth / 2, innerHeight / 2, zoom / V.zoom); };
`;

const SCENARIOS = [
  {
    name: 'simple-house',
    run: `
      clear(); street(); await tool();
      const id = place('block', 0, 30);
      if (id === null) return 'the block did not place';
      T.addStoreys(1);
      T.setRoof('gable');
      let b = D.buildings.get(id);
      const v = b.volumes[0];
      T.armElement('canopy');
      const canopy = aimAndClick(b, v.x + Math.floor(v.w / b.module / 2 + 0.5) * b.module - b.module / 2 + 0.01, v.y, 0);
      T.armElement('canopy');
      T.armElement('stair');
      b = D.buildings.get(id);
      const stair = aimAndClick(b, v.x + v.w, v.y + b.module * 1.5, 1);
      T.armElement('stair');
      b = D.buildings.get(id);
      if (!canopy || !canopy.valid) return 'canopy: ' + JSON.stringify(canopy);
      if (!stair || !stair.valid) return 'side stair: ' + JSON.stringify(stair);
      if ((b.elements ?? []).length !== 2) return 'expected 2 elements, got ' + (b.elements ?? []).length;
      T.selection = null;
      frame(b.x + 15, b.y + 12, 7.5); await settle();
      return null;
    `,
  },
  {
    name: 'push-pull-and-recesses',
    run: `
      clear(); street(); await tool();
      const id = place('block', 0, 30);
      if (id === null) return 'the block did not place';
      T.addStoreys(3);
      T.resize(1, 11.3);
      T.addWing(1);
      const wing = T.selection.volume;
      T.selection = { building: id, volume: 1, bay: { storey: 2, side: 0, index: 1 }, bayEnd: { storey: 3, side: 0, index: 2 } };
      T.setRelief(2.25);
      T.selection = { building: id, volume: 1, bay: { storey: 0, side: 0, index: 4 }, bayEnd: { storey: 1, side: 0, index: 5 } };
      T.setRelief(-3.75);
      T.selection = { building: id, volume: wing, bay: null };
      T.setRoof('gable'); T.setRoofShape({ pitch: 45 }); T.setRoofShape({ ridge: 'y' });
      const b = D.buildings.get(id);
      if ((b.volumes[0].reliefs ?? []).length !== 2) return 'reliefs: ' + JSON.stringify(b.volumes[0].reliefs);
      if (b.volumes[0].w !== 41.25) return 'the pull did not snap: w=' + b.volumes[0].w;
      T.selection = null;
      frame(b.x + 25, b.y + 25, 6.5); await settle();
      return null;
    `,
  },
  {
    name: 'stair-on-a-shallow-lot',
    run: `
      clear(); street(); await tool();
      // Land rising behind the footway: the entrance is well above the paving.
      D.addTerrainStamp({ x: 0, y: 60, radius: 70, strength: 5, mode: 'raise' });
      R.net.rebuild(); await wait(900);
      const id = place('block', 0, 18);
      if (id === null) return 'the block did not place on the back of the footway';
      T.addStoreys(1);
      let b = D.buildings.get(id);
      const v = b.volumes[0];
      // A stair to the first floor off the street front has no room at all.
      T.armElement('stair');
      const front = aimAndClick(b, v.x + b.module * 1.5, v.y, 1);
      T.armElement('stair');
      b = D.buildings.get(id);
      if (!front || front.valid) return 'a stair to the first floor fitted on a footway: ' + JSON.stringify(front);
      if ((b.elements ?? []).length !== 0) return 'an invalid stair was stored';
      // And the entrance's own flight is set into the building, never out on the paving.
      const probe = await import('/src/world/buildings/foundation.ts').catch(() => null);
      if (probe) {
        const f = probe.foundationOf(b, (x, y) => S.terrainHeightAt(x, y), undefined, (x, y) => S.pavedHeightAt(x, y));
        const door = f.entrances.find((e) => e.component === 'door');
        if (door && door.steps > 0 && door.recess <= 0) {
          const run = (door.steps + 1) * 0.75;
          const foot = { x: door.x + door.nx * run, y: door.y + door.ny * run };
          if (Number.isFinite(S.pavedHeightAt(foot.x, foot.y))) return 'the entrance flight reaches the paving';
        }
      }
      T.selection = null;
      frame(b.x + 10, b.y + 2, 11); await settle();
      return null;
    `,
  },
  {
    name: 'on-a-slope',
    run: `
      clear(); street(); await tool();
      D.addTerrainStamp({ x: 60, y: 120, radius: 60, strength: 7, mode: 'raise' });
      R.net.rebuild(); await wait(900);
      const id = place('house', 40, 110);
      if (id === null) return 'the house did not place on the slope';
      const b = D.buildings.get(id);
      T.selection = null;
      frame(b.x + 8, b.y + 8, 8); await settle();
      return null;
    `,
  },
  {
    name: 'materials-per-face',
    run: `
      clear(); street(); await tool();
      const id = place('block', 0, 30);
      if (id === null) return 'the block did not place';
      T.addStoreys(2);
      T.setMaterialScope('volume'); T.paint({ finish: 'brick', colour: 0xd8c297 });
      T.selection = { building: id, volume: 1, bay: { storey: 1, side: 1, index: 0 } };
      T.setMaterialScope('face'); T.paint({ finish: 'glass', colour: 0x9fb8c4 });
      T.setMaterialScope('roof'); T.setRoof('hip'); T.paint({ finish: 'metal', colour: 0x55585c });
      const b = D.buildings.get(id);
      const v = b.volumes[0];
      if (v.materials?.wall?.finish !== 'brick' || v.materials?.sides?.[1]?.finish !== 'glass' || v.materials?.roof?.finish !== 'metal') return 'materials: ' + JSON.stringify(v.materials);
      T.selection = null;
      frame(b.x + 12, b.y + 12, 8); await settle();
      return null;
    `,
  },
  {
    name: 'undo-redo',
    run: `
      clear(); street(); await tool();
      const id = place('block', 0, 30);
      if (id === null) return 'the block did not place';
      const snapshot = () => JSON.stringify([...D.buildings.all()]);
      const start = snapshot();
      const edits = [
        () => T.addStoreys(2), () => T.resize(1, 5), () => T.addWing(2), () => T.setRoof('gable'),
        () => { T.selection = { building: id, volume: 1, bay: { storey: 1, side: 0, index: 1 } }; T.setRelief(-2); },
        () => { T.setMaterialScope('face'); T.paint({ finish: 'wood', colour: 0x9c6b43 }); },
        () => { T.selection = { building: id, volume: 1, bay: null }; T.addSetback(); },
        () => T.addStoreys(-1), () => T.setRoofShape({ pitch: 40 }), () => T.rotateSelected(Math.PI / 2),
      ];
      for (const edit of edits) edit();
      const end = snapshot();
      const press = (key) => window.dispatchEvent(new KeyboardEvent('keydown', { key, ctrlKey: true, bubbles: true }));
      for (let i = 0; i < edits.length; i++) press('z');
      await wait(300);
      if (snapshot() !== start) return 'undoing every edit did not return to the start';
      for (let i = 0; i < edits.length; i++) press('y');
      await wait(300);
      if (snapshot() !== end) return 'redoing every edit did not return to the end';
      T.selection = null;
      const b = D.buildings.get(id);
      frame(b.x + 12, b.y + 12, 7); await settle();
      return null;
    `,
  },
  {
    name: 'old-save',
    run: `
      clear(); street(); await tool();
      // A building exactly as schema 1 stored it: whole cells of the module.
      const json = D.toJSON();
      json.buildings = [{
        id: 1, schema: 1, x: -20, y: 16.5, rotation: 0, use: 'commercial', module: 7.5, groundHeight: 9, storeyHeight: 7.75, palette: 3,
        volumes: [{ id: 1, x: 0, y: 0, w: 4, d: 3, base: 0, roof: 'flat', storeys: [
          { facade: { fill: 'window', sides: { 0: 'shopfront' }, bays: { '0:2': 'door' } } }, { facade: { fill: 'window' } }] }],
        cores: [], nextVolumeId: 2,
      }];
      D.replaceFromJSON(json);
      R.net.rebuild();
      const b = [...D.buildings.all()][0];
      if (!b) return 'the old building did not load';
      if (b.schema !== 2 || b.volumes[0].w !== 30 || b.volumes[0].d !== 22.5) return 'not migrated: ' + JSON.stringify(b.volumes[0]);
      frame(b.x + 15, b.y + 12, 8); await settle();
      return null;
    `,
  },
  {
    name: 'traffic-around-buildings',
    run: `
      clear(); street(); await tool();
      for (let i = 0; i < 6; i++) place(i % 2 ? 'apartments' : 'block', -120 + i * 45, 28);
      for (let i = 0; i < 4; i++) place('house', -100 + i * 55, -30);
      if (D.buildings.size < 8) return 'only ' + D.buildings.size + ' buildings placed';
      R.setTraffic(true);
      R.runSim(40);
      await wait(1500);
      const vehicles = R.sim.vehicles ? R.sim.vehicles.size ?? R.sim.vehicles.length : null;
      const fps = S.stats.fps;
      T.selection = null;
      frame(0, 0, 3.2); await settle();
      window.__buildingsReport = { vehicles, fps, buildings: D.buildings.size };
      return null;
    `,
  },
];

function fail(message) {
  console.error(`FAIL  ${message}`);
  process.exitCode = 1;
}

const server = await preview({ preview: { port: PORT, strictPort: true } });
const browser = await chromium.launch({
  ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : SOFTWARE_GL ? {} : { channel: 'chrome' }),
  args: LAUNCH_ARGS,
});
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const pageErrors = [];
page.on('pageerror', (error) => pageErrors.push(String(error.message)));
page.on('console', (message) => {
  if (message.type() === 'error' && !/Failed to load resource|Citizen asset/.test(message.text())) pageErrors.push(message.text());
});
await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle' });
await page.waitForFunction('Boolean(window.__roadcraft)', null, { timeout: 30_000 });
await page.waitForTimeout(2_000);
await page.evaluate("window.__roadcraft.scene().setQuality('high')");
fs.mkdirSync(SHOT_DIR, { recursive: true });

for (const scenario of SCENARIOS) {
  const problem = await page.evaluate(`(async () => { ${PRELUDE} ${scenario.run} })()`).catch((e) => `threw: ${e.message}`);
  const shot = path.join(SHOT_DIR, `buildings-${scenario.name}.jpg`);
  await page.screenshot({ path: shot, type: 'jpeg', quality: 82 });
  if (problem) fail(`${scenario.name}: ${problem}`);
  else console.log(`ok    ${scenario.name}  ${path.relative(process.cwd(), shot)}`);
}
const report = await page.evaluate('window.__buildingsReport ?? null');
console.log('traffic', JSON.stringify(report));
if (report && !(report.vehicles > 0)) fail('no vehicles ran among the buildings');
if (pageErrors.length > 0) fail(`page errors: ${pageErrors.slice(0, 5).join(' | ')}`);

await browser.close();
await new Promise((resolve) => server.httpServer.close(resolve));
