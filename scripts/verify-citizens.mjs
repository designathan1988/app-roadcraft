/* global window, requestAnimationFrame, structuredClone, performance */
/** Validate the full roster through the production game's real renderer. */
import { chromium } from '@playwright/test';
import { preview } from 'vite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const port = Number(process.env.ROADCRAFT_CITIZEN_PORT ?? 5202);
const profiling = process.argv.includes('--profile');
const benchmarkOnly = process.argv.includes('--benchmark-only') || profiling;
const server = await preview({ preview: { port, strictPort: true } });
const browser = await chromium.launch({
  ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
  args: process.env.ROADCRAFT_SOFTWARE_RENDERER === '1'
    ? ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] : [],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
const output = path.join(os.tmpdir(), 'roadcraft-production-citizens');
fs.mkdirSync(output, { recursive: true });
fs.mkdirSync('docs/audit', { recursive: true });

try {
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForFunction(() => Boolean(window.__roadcraft));
  const initial = await page.evaluate(() => {
    const R = window.__roadcraft;
    R.setTraffic(false);
    R.runSim(5);
    return R.sim.peds.size;
  });
  await page.waitForFunction(() => (window.__roadcraft.scene().scene
    .getObjectByName('rigged-citizens').userData.loadedModels ?? 0) > 0, null, { timeout: 30_000 });
  const bootstrap = await page.evaluate(() => {
    const group = window.__roadcraft.scene().scene.getObjectByName('rigged-citizens');
    return { available: group.userData.availableModels, loaded: group.userData.loadedModels ?? 0 };
  });
  if (bootstrap.available !== 80 || bootstrap.loaded > initial) throw new Error('Roster is not lazy-loaded');

  const population = await page.evaluate(() => {
    const R = window.__roadcraft, D = R.doc;
    const seed = structuredClone([...R.sim.peds.values()][0]);
    if (!seed) throw new Error('The production game did not spawn a citizen');
    R.sim.peds.clear(); R.sim.pedOccupancy.clear();
    for (const vehicle of [...R.sim.vehicles.values()]) R.sim.removeVehicle(vehicle);
    for (const id of [...D.segments.keys()]) D.removeSegment(id);
    for (const id of [...D.nodes.keys()]) D.removeNode(id);
    D.clearTerrain();
    const rows = [-100, 0, 100].map(y => [D.addNode({ x: -230, y }), D.addNode({ x: 230, y })]);
    for (const row of rows) D.addSegment(row[0].id, row[1].id, 2);
    for (let i = 0; i < 2; i++) for (let side = 0; side < 2; side++) {
      D.addSegment(rows[i][side].id, rows[i + 1][side].id, 2);
    }
    R.net.rebuild(); R.sim.rebuildTopology();
    const edges = [...R.sim.sidewalks.edges.values()].filter(edge => edge.kind === 'walk' && edge.length > 300);
    const hash = id => {
      let h = (id | 0) + 0x9e3779b9;
      h = Math.imul(h ^ (h >>> 16), 0x21f0aaad);
      h = Math.imul(h ^ (h >>> 15), 0x735a2d97);
      return (h ^ (h >>> 15)) >>> 0;
    };
    const picked = new Map();
    for (let id = 1; picked.size < 80; id++) {
      const model = hash(id) % 80;
      if (!picked.has(model)) picked.set(model, id);
    }
    const ids = [...picked.entries()].sort((a, b) => a[0] - b[0]).map(entry => entry[1]);
    ids.forEach((id, i) => {
      const edge = edges[i % edges.length];
      const slot = Math.floor(i / edges.length);
      const s = edge.length * (slot + 1) / 16;
      const citizen = { ...structuredClone(seed), id, edge: edge.id, entry: edge.from,
        s, lat: 0, age: 0, v: 2.3 + (i % 5) * 0.3, state: 'Walking', route: [], goal: null,
        party: { id, size: 1, pace: 3.2 }, rank: 0, trailing: null, occupying: null,
        prev: { edge: edge.id, s, lat: 0 } };
      R.sim.peds.set(id, citizen);
    });
    R.scene().setQuality('high');
    const viewport = R.scene().viewport;
    viewport.moveTo({ x: 0, y: 0 }); viewport.zoomAt(640, 400, 1.3 / viewport.zoom);
    R.redraw();
    window.__citizenAuditIds = ids;
    window.__citizenAuditHash = hash;
    return ids.length;
  });
  await page.waitForFunction(() => window.__roadcraft.scene().scene
    .getObjectByName('rigged-citizens').userData.loadedModels === 80, null, { timeout: 120_000 });
  await page.evaluate(() => { window.__roadcraft.runSim(0.75); window.__roadcraft.redraw(); });
  await page.waitForTimeout(500);
  await page.screenshot({ path: 'docs/audit/citizens-production-overview.jpg', type: 'jpeg', quality: 92 });

  const samples = [];
  for (let i = 0; i < (benchmarkOnly ? 0 : 80); i++) {
    const sample = await page.evaluate(async index => {
      const R = window.__roadcraft, scene = R.scene();
      const citizen = R.sim.peds.get(window.__citizenAuditIds[index]);
      const edge = R.sim.sidewalks.edges.get(citizen.edge);
      const frame = R.sim.sidewalks.orientedPath(edge, citizen.entry).sampleAt(citizen.s);
      const at = { x: frame.p.x + frame.n.x * citizen.lat, y: frame.p.y + frame.n.y * citizen.lat };
      scene.viewport.moveTo(at);
      scene.viewport.zoomAt(640, 400, 20 / scene.viewport.zoom);
      R.redraw();
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const height = scene.elevationAt(at.x, at.y) + 0.36;
      const screen = scene.viewport.toScreen(at, 1280, 800, height + 2.5);
      const group = scene.scene.getObjectByName('rigged-citizens');
      const name = group.userData.models[index];
      return { id: name, glError: scene.gl.getContext().getError(),
        x: Math.max(0, Math.min(1040, Math.round(screen.x - 120))),
        y: Math.max(0, Math.min(560, Math.round(screen.y - 120))) };
    }, i);
    if (sample.glError !== 0) throw new Error(`GPU error for ${sample.id}: ${sample.glError}`);
    await page.screenshot({ path: path.join(output, `${sample.id}.png`),
      clip: { x: sample.x, y: sample.y, width: 240, height: 240 } });
    samples.push(sample);
  }
  if (errors.length) throw new Error(errors.join('\n'));
  const metrics = await page.evaluate(async profiling => {
    const R = window.__roadcraft, scene = R.scene();
    const crowd = scene.scene.getObjectByName('rigged-citizens');
    const repeatedModel = crowd.userData.models.indexOf('male_12');
    const seed = structuredClone(R.sim.peds.get(window.__citizenAuditIds[repeatedModel]));
    const a = R.doc.addNode({ x: -230, y: 220 }), b = R.doc.addNode({ x: 230, y: 220 });
    const segment = R.doc.addSegment(a.id, b.id, 2);
    R.net.rebuild(); R.sim.rebuildTopology();
    const edges = [...R.sim.sidewalks.edges.values()].filter(edge => edge.kind === 'walk' && edge.segment === segment.id);
    let id = 10000;
    for (let i = 0; i < 40; i++) {
      while (R.sim.peds.has(id) || window.__citizenAuditHash(id) % 80 !== repeatedModel) id++;
      const edge = edges[i % edges.length];
      const s = edge.length * (Math.floor(i / edges.length) + 1) / 22;
      R.sim.peds.set(id, { ...structuredClone(seed), id, edge: edge.id, entry: edge.from,
        s, lat: 0, route: [], goal: null, party: { id, size: 1, pace: 3.2 },
        prev: { edge: edge.id, s, lat: 0 } });
      id++;
    }
    scene.viewport.moveTo({ x: 0, y: 50 }); scene.viewport.zoomAt(640, 400, 1 / scene.viewport.zoom);
    R.sim.trafficIntensity = 0;
    const costs = { draw: 0, simulation: 0, uploads: 0, uploadCalls: 0, draws: 0, advances: 0 };
    const draw = scene.draw.bind(scene);
    scene.draw = (...args) => {
      const start = performance.now(); draw(...args); costs.draw += performance.now() - start; costs.draws++;
    };
    const advance = R.sim.clock.advance.bind(R.sim.clock);
    R.sim.clock.advance = (...args) => {
      const start = performance.now(); const value = advance(...args);
      costs.simulation += performance.now() - start; costs.advances++; return value;
    };
    const context = scene.gl.getContext();
    const rendererInfo = context.getExtension('WEBGL_debug_renderer_info');
    const gpu = rendererInfo ? context.getParameter(rendererInfo.UNMASKED_RENDERER_WEBGL) : context.getParameter(context.RENDERER);
    const upload = context.texSubImage2D.bind(context);
    context.texSubImage2D = (...args) => {
      const start = performance.now(); upload(...args);
      costs.uploads += performance.now() - start; costs.uploadCalls++;
    };
    R.setTraffic(true);
    const times = [];
    for (let frame = 0; frame < (profiling ? 25 : 90); frame++) await new Promise(resolve => requestAnimationFrame(time => {
      if (frame >= (profiling ? 5 : 30)) times.push(time);
      resolve();
    }));
    const group = scene.scene.getObjectByName('rigged-citizens');
    const repeated = Math.max(...group.children.filter(mesh => mesh.name.startsWith(`citizen-${group.userData.models[repeatedModel]}-`)).map(mesh => mesh.count));
    return { activeFps: 1000 * (times.length - 1) / (times[times.length - 1] - times[0]),
      lod: group.userData.lod,
      citizenTriangles: group.children.reduce((sum, mesh) => sum + mesh.count * (mesh.geometry.index?.count ?? mesh.geometry.getAttribute('position').count) / 3, 0),
      repeated, repeatedModel: group.userData.models[repeatedModel],
      glError: scene.gl.getContext().getError(), paletteBytes: group.userData.paletteBytes,
      animationBytes: group.userData.animationBytes,
      costs, gpu, rebuilds: scene.stats.rebuilds,
      gpuGeometries: scene.gl.info.memory.geometries, gpuTextures: scene.gl.info.memory.textures };
  }, profiling);
  if (metrics.glError !== 0 || metrics.repeated < 40) throw new Error(`Repeated-model animation upload failed: ${JSON.stringify(metrics)}`);
  const report = { bundle: fs.readdirSync('dist/assets').filter(name => name.endsWith('.js')),
    bootstrap, population, verified: samples.length, errors, metrics, samples };
  fs.writeFileSync(benchmarkOnly ? 'docs/audit/citizens-lod-benchmark.json' : 'docs/audit/citizens-production.json', JSON.stringify(report, null, 2) + '\n');
  console.log(`Production roster: ${bootstrap.available}; captured ${samples.length}; startup loaded ${bootstrap.loaded}.`);
  console.log(JSON.stringify(metrics));
  console.log(`Character captures: ${output}`);
} finally {
  await browser.close();
  await new Promise(resolve => server.httpServer.close(resolve));
}
