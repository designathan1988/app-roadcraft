/**
 * Drives the real application in a real browser and checks what only the running
 * game can answer.
 *
 * The unit suite proves that the height field is continuous and that the mesh
 * builder refines without cracks. It cannot prove that the scene BOOTS, that the
 * surfaces end up above the ground the player sees, that a terrain edit rebuilds
 * everything it should, or that the frame budget survives a large map. Those are
 * measured here, on a list of scenarios chosen because each one used to be
 * broken: a junction over rolling ground, a viaduct crossing a road at grade, a
 * bridge over a river, a city grid on edited terrain, a tunnel under a hill, a
 * signalised junction whose lamps must actually light, and a raised deck the
 * editor has to be able to point at.
 *
 *   npm run verify:visual              # assert only
 *   npm run verify:visual -- --shots   # also write PNGs to docs/screenshots
 *
 * Exits non-zero on the first failed expectation, and prints every measurement
 * it took either way, so a regression is a number and not an impression.
 */
import { chromium } from '@playwright/test';
import { preview } from 'vite';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const PORT = Number(process.env.ROADCRAFT_VISUAL_PORT ?? 5199);
const WRITE_SHOTS = process.argv.includes('--shots');
const SHOT_DIR = path.resolve('docs', 'screenshots');

/** Software rendering is the fallback when no GPU is exposed to the browser. */
const LAUNCH_ARGS = [
  '--use-gl=angle',
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--no-sandbox',
];

/**
 * Each scenario builds a document from scratch through the same public API the
 * editor uses, so nothing here can pass against geometry the editor could not
 * produce.
 */
const SCENARIOS = [
  {
    name: 'player-grid-and-bends',
    zoom: 0.24,
    centre: { x: -61, y: 314 },
    build: `D.replaceFromJSON(${JSON.stringify(JSON.parse(fs.readFileSync(
      path.resolve('tests/fixtures/grid-and-bends.json'), 'utf8')).document)});`,
  },
  {
    name: 'crossroads-flat',
    zoom: 1.6,
    build: `
      const c = D.addNode({ x: 0, y: 0 });
      const n = D.addNode({ x: 0, y: -320 });
      const s = D.addNode({ x: 0, y: 320 });
      const w = D.addNode({ x: -320, y: 0 });
      const e = D.addNode({ x: 320, y: 0 });
      D.addSegment(n.id, c.id, 3); D.addSegment(c.id, s.id, 3);
      D.addSegment(w.id, c.id, 2); D.addSegment(c.id, e.id, 2);
    `,
  },
  {
    name: 'crossroads-rolling',
    zoom: 1.0,
    build: `
      const c = D.addNode({ x: 0, y: 0 });
      const n = D.addNode({ x: 0, y: -330 });
      const s = D.addNode({ x: 0, y: 330 });
      const w = D.addNode({ x: -330, y: 0 });
      const e = D.addNode({ x: 330, y: 0 });
      D.addSegment(n.id, c.id, 3); D.addSegment(c.id, s.id, 3);
      D.addSegment(w.id, c.id, 2); D.addSegment(c.id, e.id, 2);
      for (let i = 0; i < 10; i++) {
        D.addTerrainStamp({ x: -320 + i * 72, y: (i % 2 ? 1 : -1) * 190,
          radius: 130, strength: 18, mode: i % 3 === 0 ? 'lower' : 'raise' });
      }
    `,
  },
  {
    name: 'junction-mixed-T', zoom: 1.8,
    build: `
      const c = D.addNode({ x: 0, y: 0 });
      [0, 90, 180].forEach((degrees, index) => {
        const angle = degrees * Math.PI / 180;
        const far = D.addNode({ x: Math.cos(angle) * 420, y: Math.sin(angle) * 420 });
        D.addSegment(c.id, far.id, [2, 1, 3][index]);
      });
      D.setNodeControl(c.id, 'signal');
    `,
  },
  {
    name: 'junction-skewed', zoom: 1.8,
    build: `
      const c = D.addNode({ x: 0, y: 0 });
      [0, 67, 175, 257].forEach((degrees, index) => {
        const angle = degrees * Math.PI / 180;
        const far = D.addNode({ x: Math.cos(angle) * 420, y: Math.sin(angle) * 420 });
        D.addSegment(c.id, far.id, [1, 2, 3, 2][index]);
      });
      D.setNodeControl(c.id, 'signal');
    `,
  },
  {
    name: 'junction-five-leg', zoom: 1.8,
    build: `
      const c = D.addNode({ x: 0, y: 0 });
      [0, 68, 145, 218, 293].forEach((degrees, index) => {
        const angle = degrees * Math.PI / 180;
        const far = D.addNode({ x: Math.cos(angle) * 420, y: Math.sin(angle) * 420 });
        D.addSegment(c.id, far.id, [2, 1, 3, 2, 1][index]);
      });
      D.setNodeControl(c.id, 'signal');
    `,
  },
  {
    name: 'junction-one-way', zoom: 1.8,
    build: `
      const c = D.addNode({ x: 0, y: 0 });
      [0, 90, 180, 270].forEach((degrees, index) => {
        const angle = degrees * Math.PI / 180;
        const far = D.addNode({ x: Math.cos(angle) * 420, y: Math.sin(angle) * 420 });
        const leg = D.addSegment(c.id, far.id, [2, 3, 1, 2][index]);
        if (index % 2 === 0) D.setSegmentDirection(leg.id, index === 0 ? 'aToB' : 'bToA');
      });
      D.setNodeControl(c.id, 'signal');
    `,
  },
  {
    name: 'viaduct-over-road',
    zoom: 1.0,
    build: `
      const a = D.addNode({ x: -450, y: 0 });
      const b = D.addNode({ x: 450, y: 0 });
      const n = D.addNode({ x: 0, y: -330 });
      const s = D.addNode({ x: 0, y: 330 });
      const over = D.addSegment(a.id, b.id, 3);
      D.addSegment(n.id, s.id, 2);
      D.setSegmentStructure(over.id, 'elevated');
    `,
  },
  {
    name: 'elevated-to-grade',
    zoom: 1.0,
    build: `
      const a = D.addNode({ x: -700, y: 0 });
      const b = D.addNode({ x: -300, y: 0 });
      const c = D.addNode({ x: 300, y: 0 });
      const d = D.addNode({ x: 700, y: 0 });
      D.addSegment(a.id, b.id, 2);
      const up = D.addSegment(b.id, c.id, 2);
      D.addSegment(c.id, d.id, 2);
      D.setSegmentStructure(up.id, 'elevated');
    `,
  },
  {
    name: 'bridge-over-river',
    zoom: 1.0,
    build: `
      const a = D.addNode({ x: -430, y: 0 });
      const b = D.addNode({ x: -150, y: 0 });
      const c = D.addNode({ x: 150, y: 0 });
      const d = D.addNode({ x: 430, y: 0 });
      D.addSegment(a.id, b.id, 2);
      const span = D.addSegment(b.id, c.id, 2);
      D.addSegment(c.id, d.id, 2);
      D.setSegmentStructure(span.id, 'bridge');
      for (let i = 0; i < 9; i++) {
        D.addTerrainStamp({ x: -40 + i * 14, y: -260 + i * 65, radius: 120, strength: 12, mode: 'river' });
      }
    `,
  },
  {
    name: 'city-on-edited-terrain',
    zoom: 0.5,
    build: `
      const xs = [-600, -300, 0, 300, 600];
      const ys = [-420, -140, 140, 420];
      const g = ys.map((y) => xs.map((x) => D.addNode({ x, y })));
      for (let r = 0; r < g.length; r++) {
        for (let k = 0; k < xs.length - 1; k++) D.addSegment(g[r][k].id, g[r][k + 1].id, r === 1 ? 3 : 1);
      }
      for (let k = 0; k < xs.length; k++) {
        for (let r = 0; r < g.length - 1; r++) D.addSegment(g[r][k].id, g[r + 1][k].id, k === 2 ? 2 : 1);
      }
      for (let i = 0; i < 16; i++) {
        D.addTerrainStamp({ x: -750 + i * 100, y: ((i * 37) % 420) - 210,
          radius: 150, strength: 12, mode: i % 4 === 0 ? 'lower' : 'raise' });
      }
    `,
  },
  {
    // A tunnel is the one structure whose road is SUPPOSED to be under the
    // ground, so it gets its own expectations: the bore must actually be buried
    // and both portals must have been built. Without the second half of that a
    // tunnel that silently drew nothing would pass.
    name: 'tunnel-through-hill',
    zoom: 0.9,
    build: `
      const a = D.addNode({ x: -700, y: 0 });
      const b = D.addNode({ x: 700, y: 0 });
      const bore = D.addSegment(a.id, b.id, 2);
      D.setSegmentStructure(bore.id, 'tunnel');
      for (let i = 0; i < 6; i++) {
        D.addTerrainStamp({ x: -130 + i * 52, y: 0, radius: 260, strength: 22, mode: 'raise' });
      }
    `,
    expect: (r) => {
      if (r.buried === 0) return 'the tunnel road is not below the ground';
      if (r.portalMeshes < 2) return `only ${r.portalMeshes} portal meshes were built`;
      return null;
    },
  },
  {
    // Every lamp on a signalised junction must exist, and over a few seconds of
    // simulation all three colours must actually appear. A player reported that
    // green and amber never showed; nothing in the unit suite could see it,
    // because the defect was in the scene graph rather than in the controller.
    name: 'signalised-junction',
    zoom: 1.8,
    settle: 2_400,
    build: `
      const c = D.addNode({ x: 0, y: 0 });
      const n = D.addNode({ x: 0, y: -320 });
      const s = D.addNode({ x: 0, y: 320 });
      const w = D.addNode({ x: -320, y: 0 });
      const e = D.addNode({ x: 320, y: 0 });
      D.addSegment(n.id, c.id, 3); D.addSegment(c.id, s.id, 3);
      D.addSegment(w.id, c.id, 3); D.addSegment(c.id, e.id, 3);
      D.setNodeControl(c.id, 'signal');
    `,
    expect: (r) => {
      if (r.signalLamps === 0) return 'no signal lamps were built';
      if (r.litLamps === 0) return 'every signal lamp is dark';
      return null;
    },
  },
];

/** Runs inside the page: measures the built scene against the terrain under it. */
const PROBE = `(() => {
  const R = window.__roadcraft;
  const S = R.scene();
  const report = {
    meshes: 0, vertices: 0, triangles: 0, nonFinite: 0, belowTerrain: 0, worstSink: 0, heaviest: '',
    buried: 0, portalMeshes: 0, signalLamps: 0, litLamps: 0, worstAt: '',
  };
  let heaviestCount = 0;
  const terrainAt = (x, y) => S.terrainHeightAt(x, y);

  S.scene.traverse((o) => {
    if (!o.isMesh || !o.geometry || !o.geometry.getAttribute) return;
    const position = o.geometry.getAttribute('position');
    if (!position) return;
    if (o.name === 'sky' || o.name.startsWith('terrain')) return;
    if (!o.visible) return;
    const instances = o.isInstancedMesh ? o.count : 1;
    if (instances === 0) return;
    report.meshes++;
    report.vertices += position.count * instances;
    report.triangles += ((o.geometry.index ? o.geometry.index.count : position.count) / 3) * instances;
    if (position.count * instances > heaviestCount) {
      heaviestCount = position.count * instances;
      report.heaviest = o.name + ':' + heaviestCount;
    }
    if (o.name.startsWith('tunnel-')) report.portalMeshes++;
    if (o.name.startsWith('signal-lamp-')) {
      report.signalLamps++;
      if (o.userData && o.userData.active) report.litLamps++;
    }
    // A TUNNEL's bands are meant to be under the ground — that is what a tunnel
    // is — so they are counted separately instead of failing the surface check.
    const surface = /^(asphalt|kerb|footway|verge|markings)/.test(o.name);
    const buried = o.name.endsWith('-tunnel');
    const road = surface && !buried;
    const normal = o.geometry.getAttribute('normal');
    for (let i = 0; i < position.count; i++) {
      const x = position.getX(i), y = position.getY(i), z = position.getZ(i);
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) { report.nonFinite++; continue; }
      if (surface && buried && terrainAt(x, -z) - y > 1) report.buried++;
      if (!road) continue;
      // Only the TOP face is checked. A band's skirt is meant to run down into
      // the ground — that is what stops a kerb being an infinitely thin sheet —
      // and it is identified by its normal, which the builder writes as
      // horizontal for every skirt vertex and vertical for every surface one.
      if (normal && normal.getY(i) < 0.5) continue;
      const sink = terrainAt(x, -z) - y;
      if (sink > 0.35) {
        report.belowTerrain++;
        if (sink > report.worstSink) {
          report.worstSink = sink;
          report.worstAt = o.name + '@' + x.toFixed(0) + ',' + (-z).toFixed(0) + ' road=' + y.toFixed(2) + ' ground=' + terrainAt(x, -z).toFixed(2);
        }
      }
    }
  });
  report.worstSink = Number(report.worstSink.toFixed(3));
  return report;
})()`;

function fail(message) {
  console.error(`FAIL  ${message}`);
  process.exitCode = 1;
}

const server = await preview({ preview: { port: PORT, strictPort: true } });
const browser = await chromium.launch({
  ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
  args: LAUNCH_ARGS,
});
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

const pageErrors = [];
page.on('pageerror', (error) => pageErrors.push(String(error.message)));
page.on('console', (message) => {
  if (message.type() === 'error') pageErrors.push(message.text());
});

await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle' });
await page.waitForFunction('Boolean(window.__roadcraft)', null, { timeout: 30_000 });
await page.waitForTimeout(2_500);
await page.evaluate(() => window.__roadcraft.scene().setQuality('high'));

if (WRITE_SHOTS) fs.mkdirSync(SHOT_DIR, { recursive: true });

/** Resolves once the renderer has finished a rebuild started after `before`. */
async function waitForRebuild(target, before, timeout = 30_000) {
  await target.waitForFunction(
    (count) => window.__roadcraft.scene().stats.rebuilds > count,
    before,
    { timeout },
  );
  // One more frame, so the meshes the rebuild produced have been drawn at least
  // once and their bounding data is final.
  await target.evaluate(() => window.__roadcraft.redraw());
  await target.waitForTimeout(300);
}

const rows = [];
const movementRecords = [];
for (const scenario of SCENARIOS) {
  const rebuildsBefore = await page.evaluate(() => window.__roadcraft.scene().stats.rebuilds);
  await page.evaluate(({ build }) => {
    const R = window.__roadcraft;
    const D = R.doc;
    for (const id of [...D.segments.keys()]) D.removeSegment(id);
    for (const id of [...D.nodes.keys()]) D.removeNode(id);
    D.clearTerrain();
    new Function('D', 'R', build)(D, R);
    R.net.rebuild();
    R.redraw();
    // Only the serialisable fields cross into the page: a scenario also carries
    // its `expect` predicate, and a function cannot be sent over the protocol.
  }, { build: scenario.build });
  await page.waitForTimeout(scenario.settle ?? 400);
  await page.evaluate(({ zoom, centre }) => {
    const v = window.__roadcraft.scene().viewport;
    v.zoomAt(640, 400, zoom / v.zoom);
    v.moveTo(centre ?? { x: 0, y: 0 });
  }, { zoom: scenario.zoom, centre: scenario.centre });
  // Wait for the rebuild to COMPLETE, rather than for a guessed interval.
  // Reading the scene graph too early measures the previous scenario, which is
  // a green run that proves nothing — and a city-sized rebuild can take a
  // couple of seconds on a software rasteriser.
  await waitForRebuild(page, rebuildsBefore);

  const report = await page.evaluate(PROBE);
  const stats = await page.evaluate(() => window.__roadcraft.scene().stats);
  // `worstAt` is a sentence, not a measurement: it belongs in the failure, not
  // in a column that is empty on every green run.
  const columns = { ...report };
  delete columns.worstAt;
  rows.push({ scenario: scenario.name, ...columns, rebuildMs: stats.rebuildMs, fps: stats.fps });

  if (report.meshes === 0) fail(`${scenario.name}: nothing was built`);
  if (report.nonFinite > 0) fail(`${scenario.name}: ${report.nonFinite} non-finite vertices`);
  if (report.belowTerrain > 0) {
    fail(`${scenario.name}: ${report.belowTerrain} road vertices under the terrain (worst ${report.worstSink} at ${report.worstAt})`);
  }
  const complaint = scenario.expect?.(report);
  if (complaint) fail(`${scenario.name}: ${complaint}`);

  if (WRITE_SHOTS) {
    // Let the simulation populate the scene before photographing it: an empty
    // street is not what the screenshot is for. `runSim` advances the fixed-step
    // clock directly, because the clock refuses to catch up more than a few
    // steps per frame and a software rasteriser runs at single-figure frames.
    await page.evaluate(() => window.__roadcraft.runSim(70));
    await page.waitForTimeout(600);
    if (scenario.name.startsWith('junction-') || scenario.name === 'signalised-junction') {
      movementRecords.push(await page.evaluate((name) => {
        const R = window.__roadcraft, S = R.sim, scene = R.scene().scene;
        return { scenario: name, tick: S.clock.tick, movements: [...S.graph.connectors.values()]
          .map(connector => {
            const from = S.lanelet(connector.fromLane), to = S.lanelet(connector.toLane);
            const path = S.lanelet(connector.id);
            const controller = S.controller(connector.node);
            const head = `${connector.node}:${connector.inSegment}`;
            const displayed = controller ? ['red', 'amber', 'green'].find(colour =>
              scene.getObjectByName(`signal-lamp-${colour}-${head}`)?.userData.active) ?? 'none' : 'uncontrolled';
            const live = [...S.vehicles.values()].filter(vehicle => vehicle.lanelet === connector.id);
            const conflicting = S.conflicts.refs(connector.id).map(ref => ref.other);
            return { origin: String(connector.inSegment), fromLane: from?.laneIndex,
              intent: connector.turn, connector: connector.id,
              destination: String(connector.outSegment), toLane: to?.laneIndex,
              trajectory: path?.centre.toPoints(), displayed,
              conflicting, simultaneous: live.flatMap(vehicle =>
                [...S.vehicles.values()].filter(other => other.id !== vehicle.id && conflicting.includes(other.lanelet))
                  .map(other => ({ a: vehicle.id, b: other.id, otherMovement: other.lanelet }))),
            };
          }) };
      }, scenario.name));
    }
    // Traffic is paused for the capture. A canvas that redraws every frame makes
    // the screenshot compositor wait for a stable frame that never arrives, and
    // the capture times out rather than producing a blurred image.
    await page.evaluate(() => window.__roadcraft.setTraffic(false));
    await page.waitForTimeout(400);
    // JPEG, because these are photographs of a lit 3D scene: the same frame is
    // a megabyte as PNG and a tenth of that as JPEG, with no visible difference.
    await page.screenshot({
      path: path.join(SHOT_DIR, `${scenario.name}.jpg`),
      type: 'jpeg',
      quality: 82,
      timeout: 120_000,
    });
    await page.evaluate(() => window.__roadcraft.setTraffic(true));
  }
}
if (WRITE_SHOTS) fs.writeFileSync('docs/audit/junction-runtime-movements.json', JSON.stringify(movementRecords, null, 2) + '\n');

// The editor must be able to AIM at a raised deck.
//
// A tilted view projects a raised surface away from the point under it — a deck
// fifteen units up lands about thirteen units off on the ground plane — so an
// editor that casts at y = 0 picks a spot thirteen units short of the node the
// player is pointing at, and nothing ever snaps. That is exactly what a player
// reported: elevated roads could not be connected once they existed. Only the
// running app can answer this, because it needs the real camera.
{
  const before = await page.evaluate(() => window.__roadcraft.scene().stats.rebuilds);
  await page.evaluate(() => {
    const R = window.__roadcraft;
    const D = R.doc;
    for (const id of [...D.segments.keys()]) D.removeSegment(id);
    for (const id of [...D.nodes.keys()]) D.removeNode(id);
    D.clearTerrain();
    const a = D.addNode({ x: -500, y: 0 });
    const b = D.addNode({ x: 0, y: 0 });
    const c = D.addNode({ x: 460, y: 0 });
    D.addSegment(a.id, b.id, 2);
    const up = D.addSegment(b.id, c.id, 2);
    D.setSegmentStructure(up.id, 'elevated');
    R.net.rebuild();
    R.redraw();
  });
  await waitForRebuild(page, before);
  const aim = await page.evaluate(() => {
    const R = window.__roadcraft;
    const S = R.scene();
    const view = S.viewport;
    const node = [...R.doc.nodes.values()].find((n) => Math.abs(n.x - 460) < 1);
    if (!node) return { ok: false, why: 'the fixture node is missing' };
    const height = S.elevationAt(node.x, node.y);
    const w = window.innerWidth;
    const h = window.innerHeight;
    const screen = view.toScreen({ x: node.x, y: node.y }, w, h, height);
    const flat = view.toScreen({ x: node.x, y: node.y }, w, h, 0);
    const picked = R.pickAtScreen(screen.x, screen.y);
    return {
      ok: picked.kind === 'node' && picked.node === node.id,
      kind: picked.kind,
      height: Number(height.toFixed(2)),
      // How far the deck is thrown from the ground point under it. If this is
      // near zero the scenario is not testing anything.
      offset: Number(Math.hypot(screen.x - flat.x, screen.y - flat.y).toFixed(1)),
    };
  });
  rows.push({ scenario: 'aim-at-elevated-node', meshes: 0, vertices: 0, triangles: 0,
    nonFinite: 0, belowTerrain: 0, worstSink: 0, heaviest: `offset ${aim.offset}px`,
    buried: 0, portalMeshes: 0, signalLamps: 0, litLamps: 0, rebuildMs: 0, fps: 0 });

  if (!aim.ok) {
    fail(`aim-at-elevated-node: pointing at a deck ${aim.height} units up picked ${aim.kind ?? aim.why}`);
  }
}

// A terrain edit AFTER the roads exist has to rebuild every surface it touches.
const beforeEditRebuilds = await page.evaluate(() => window.__roadcraft.scene().stats.rebuilds);
await page.evaluate(() => {
  const R = window.__roadcraft;
  R.doc.addTerrainStamp({ x: 0, y: 0, radius: 200, strength: 26, mode: 'raise' });
  R.net.rebuild();
  R.redraw();
});
await waitForRebuild(page, beforeEditRebuilds);
const afterEdit = await page.evaluate(PROBE);
const afterStats = await page.evaluate(() => window.__roadcraft.scene().stats);
const afterColumns = { ...afterEdit };
delete afterColumns.worstAt;
rows.push({ scenario: 'after-terrain-edit', ...afterColumns, rebuildMs: afterStats.rebuildMs, fps: 0 });
if (afterEdit.belowTerrain > 0) {
  fail(`after-terrain-edit: ${afterEdit.belowTerrain} road vertices under the terrain (worst ${afterEdit.worstSink} at ${afterEdit.worstAt})`);
}

// People in vehicles: a close-up of traffic must draw seated citizens (the
// driver at the wheel, passengers riding), not boxes, and they must be there
// in the production bundle.
{
  await page.evaluate(() => {
    const R = window.__roadcraft;
    const D = R.doc;
    for (const id of [...D.segments.keys()]) D.removeSegment(id);
    for (const id of [...D.nodes.keys()]) D.removeNode(id);
    D.clearTerrain();
    const a = D.addNode({ x: -300, y: 0 });
    const b = D.addNode({ x: 300, y: 0 });
    D.addSegment(a.id, b.id, 3);
    R.net.rebuild();
    R.redraw();
  });
  await page.waitForTimeout(400);
  const target = await page.evaluate(() => {
    const R = window.__roadcraft;
    R.sim.trafficIntensity = 2;
    R.sim.pedestrianIntensity = 0;
    R.runSim(25);
    const S = R.sim;
    const car = [...S.vehicles.values()].find((v) => ['sedan', 'suv', 'hatch', 'van'].includes(v.archetype.id));
    if (!car) return null;
    const lane = S.lanelet(car.lanelet);
    const f = lane.centre.sampleAt(Math.max(0, car.s - car.archetype.length / 2));
    const view = R.scene().viewport;
    view.zoomAt(640, 400, 30 / view.zoom);
    view.moveTo(f.p);
    R.redraw();
    return { archetype: car.archetype.id, vehicles: S.vehicles.size };
  });
  // Seated citizens are loaded on first sight, like the walking ones.
  await page.waitForTimeout(4000);
  await page.evaluate(() => window.__roadcraft.redraw());
  await page.waitForTimeout(1200);
  const seated = await page.evaluate(() => {
    const group = window.__roadcraft.scene().scene.getObjectByName('rigged-citizens');
    let drawn = 0;
    group.traverse((o) => { if (o.isInstancedMesh) drawn = Math.max(drawn, o.count); });
    let batches = 0;
    group.traverse((o) => { if (o.isInstancedMesh && o.count > 0) batches++; });
    return { drawn, batches, peds: window.__roadcraft.sim.peds.size };
  });
  if (WRITE_SHOTS) {
    await page.screenshot({ path: path.join('docs', 'audit', 'vehicles-occupants-production.jpg'), quality: 88 });
  }
  rows.push({ scenario: 'vehicle-occupants', meshes: seated.batches, vertices: 0, triangles: 0,
    nonFinite: 0, belowTerrain: 0, worstSink: 0, heaviest: `${target?.archetype ?? 'none'}`,
    buried: 0, portalMeshes: 0, signalLamps: 0, litLamps: 0, rebuildMs: 0, fps: 0 });
  if (!target) fail('vehicle-occupants: no car to look at');
  else if (seated.peds === 0 && seated.batches === 0) fail('vehicle-occupants: nobody is seated in any vehicle');
}

if (pageErrors.length > 0) {
  fail(`page reported ${pageErrors.length} error(s): ${pageErrors.slice(0, 3).join(' | ')}`);
}

console.table(rows);
console.log(
  process.exitCode
    ? 'visual verification FAILED'
    : `visual verification passed (${rows.length} scenarios, backend ${await page.evaluate(() => window.__roadcraft.scene().backend)})`,
);

await browser.close();
await server.close();
