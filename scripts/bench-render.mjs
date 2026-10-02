// Render benchmark: the town to explore, three fixed camera spots, a real
// Chrome on the GPU. For each spot: GPU time per render pass (timer
// queries), CPU time of the draw, triangles and draw calls, and a picture to
// compare before and after a change (the picture is the proof that the look
// did not change; the numbers say what it cost).
//
//   node scripts/bench-render.mjs --base=http://127.0.0.1:4190 --out=docs/audit/perf/before
//
// A dev server must be running. Short and in the foreground: under a minute.
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

const opt = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const BASE = opt('base', 'http://127.0.0.1:5173');
const OUT = opt('out', 'docs/audit/perf/run');
const WAIT = Number(opt('wait', '25'));
const WIDTH = Number(opt('width', '1600'));
const HEIGHT = Number(opt('height', '900'));
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  channel: 'chrome',
  // No window on the player's screen: Chrome's headless mode still draws on
  // the real GPU through ANGLE (checked: the RTX, not SwiftShader).
  headless: true,
  args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e.message)));
await page.addInitScript(() => {
  try { localStorage.setItem('roadcraft.sky', 'day'); } catch { /* storage blocked */ }
  window.confirm = () => true;
});
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForFunction('Boolean(window.__roadcraft)', null, { timeout: 60_000 });
await page.evaluate(() => document.getElementById('sampleCity').click());
await page.waitForTimeout(WAIT * 1000);
// The morning rush: the town's streets full of the residents' trips (at
// 06:30, when the town is built, nobody is out yet and the simulation costs
// nothing worth measuring).
await page.evaluate(() => { window.__roadcraft.sim.clock.speed = 1; window.__roadcraft.sim.city.skip(95); });
await page.waitForTimeout(8000);

/** GPU ms per pass over `n` frames, plus CPU draw ms, calls and triangles. */
const measure = (n) => page.evaluate(async (n) => {
  const sc = window.__roadcraft.scene();
  const r = sc.gl;
  const g = r.getContext();
  const ext = g.getExtension('EXT_disjoint_timer_query_webgl2');
  const frames = [];
  let cur = null;
  let depth = 0;
  const origDraw = sc.draw;
  const origRender = r.render;
  r.render = function (scene, cam) {
    const t = r.getRenderTarget();
    const label = `${t ? `${t.width}x${t.height}` : 'screen'}|${scene.isScene ? 'scene' : scene.type}`;
    let q = null;
    if (depth === 0 && cur && ext) { q = g.createQuery(); g.beginQuery(ext.TIME_ELAPSED_EXT, q); }
    depth++;
    try { return origRender.apply(this, arguments); } finally {
      depth--;
      if (q) { g.endQuery(ext.TIME_ELAPSED_EXT); cur.passes.push({ label, q, calls: r.info.render.calls, tris: r.info.render.triangles }); }
    }
  };
  sc.draw = function (...a) {
    cur = { passes: [], cpu: 0 };
    const s = performance.now();
    try { return origDraw.apply(this, a); } finally { cur.cpu = performance.now() - s; frames.push(cur); cur = null; }
  };
  const gaps = [];
  let last = performance.now();
  await new Promise((done) => {
    let k = 0;
    const f = () => { const t = performance.now(); gaps.push(t - last); last = t; if (++k < n + 6) requestAnimationFrame(f); else done(); };
    requestAnimationFrame(f);
  });
  r.render = origRender;
  sc.draw = origDraw;
  await new Promise((done) => setTimeout(done, 400));
  const rows = new Map();
  let gpu = 0;
  let cpu = 0;
  let calls = 0;
  let tris = 0;
  let k = 0;
  for (const f of frames.slice(5)) {
    k++;
    cpu += f.cpu;
    for (const p of f.passes) {
      const ok = g.getQueryParameter(p.q, g.QUERY_RESULT_AVAILABLE);
      const ms = ok ? g.getQueryParameter(p.q, g.QUERY_RESULT) / 1e6 : 0;
      gpu += ms;
      calls += p.calls;
      tris += p.tris;
      const row = rows.get(p.label) ?? { ms: 0, n: 0, calls: 0, tris: 0 };
      row.ms += ms; row.n++; row.calls += p.calls; row.tris += p.tris;
      rows.set(p.label, row);
    }
  }
  const sorted = gaps.slice(5).sort((a, b) => a - b);
  return {
    gpuMs: +(gpu / k).toFixed(2),
    cpuDrawMs: +(cpu / k).toFixed(2),
    frameMedianMs: +sorted[sorted.length >> 1].toFixed(1),
    calls: Math.round(calls / k),
    mtris: +(tris / k / 1e6).toFixed(2),
    passes: [...rows].map(([label, r]) => ({ label, ms: +(r.ms / k).toFixed(2), perFrame: +(r.n / k).toFixed(1), calls: Math.round(r.calls / k), ktris: Math.round(r.tris / k / 1e3) }))
      .sort((a, b) => b.ms - a.ms).slice(0, 10),
  };
}, n);

/**
 * Three samples, the quickest kept: the machine is shared (other programs,
 * other agents), and the slowest samples measure them, not the game.
 */
const best = async (n) => {
  let pick = null;
  for (let i = 0; i < 3; i++) {
    const s = await measure(n);
    if (!pick || s.frameMedianMs + s.cpuDrawMs < pick.frameMedianMs + pick.cpuDrawMs) pick = s;
  }
  return pick;
};

const spots = {
  overview: async () => { await page.keyboard.press('Home'); },
  street: async () => page.evaluate(() => window.__roadcraft.lookAt(-300, -300, 8)),
  close: async () => page.evaluate(() => window.__roadcraft.lookAt(-480, -840, 22)),
};
const report = { base: BASE, width: WIDTH, height: HEIGHT, spots: {} };
for (const [name, go] of Object.entries(spots)) {
  await go();
  await page.waitForTimeout(3000);
  report.spots[name] = await best(60);
  await page.screenshot({ path: `${OUT}/${name}.png` });
}
// The shadow map is drawn inside the scene pass: the same overview with the
// shadow map left as it is (not redrawn) gives its cost by difference.
await page.keyboard.press('Home');
await page.waitForTimeout(1500);
await page.evaluate(() => {
  const sm = window.__roadcraft.scene().gl.shadowMap;
  sm.__render = sm.render;
  sm.render = () => {};
});
report.overviewShadowFrozen = await best(60);
await page.evaluate(() => {
  const sm = window.__roadcraft.scene().gl.shadowMap;
  sm.render = sm.__render;
});
/** Where the main thread spends a few seconds (JS Self-Profiling): inclusive and self shares. */
const profile = (seconds) => page.evaluate(async (seconds) => {
  if (typeof Profiler !== 'function') return null;
  const profiler = new Profiler({ sampleInterval: 1, maxBufferSize: 400000 });
  await new Promise((done) => setTimeout(done, seconds * 1000));
  const tr = await profiler.stop();
  const name = (fi) => {
    const f = tr.frames[fi];
    const res = f.resourceId !== undefined ? tr.resources[f.resourceId].split('/').pop().split('?')[0] : '';
    return `${f.name || '(anon)'} @${res}:${f.line ?? ''}`;
  };
  const incl = new Map();
  const self = new Map();
  let idle = 0;
  for (const sample of tr.samples) {
    if (sample.stackId === undefined) { idle++; continue; }
    let st = tr.stacks[sample.stackId];
    const leaf = name(st.frameId);
    self.set(leaf, (self.get(leaf) ?? 0) + 1);
    const seen = new Set();
    while (st) {
      const n = name(st.frameId);
      if (!seen.has(n)) { incl.set(n, (incl.get(n) ?? 0) + 1); seen.add(n); }
      st = st.parentId !== undefined ? tr.stacks[st.parentId] : null;
    }
  }
  const pct = (v) => (100 * v / tr.samples.length).toFixed(1);
  return {
    idle: pct(idle),
    inclusive: [...incl].sort((a, b) => b[1] - a[1]).slice(0, 30).map(([k, v]) => `${pct(v)}% ${k}`),
    self: [...self].sort((a, b) => b[1] - a[1]).slice(0, 25).map(([k, v]) => `${pct(v)}% ${k}`),
  };
}, seconds);
/** One frame's draw calls by object kind, picture and shadow apart. */
const inventory = () => page.evaluate(async () => {
  const sc = window.__roadcraft.scene();
  const r = sc.gl;
  const shadowTarget = () => {
    let t = null;
    sc.scene.traverse((o) => { if (o.isDirectionalLight && o.shadow?.map) t = o.shadow.map; });
    return t;
  };
  const counts = new Map();
  let on = false;
  const orig = r.renderBufferDirect;
  r.renderBufferDirect = function (camera, scene, geometry, material, object, group) {
    if (on) {
      const pass = r.getRenderTarget() === shadowTarget() ? 'shadow' : 'main';
      const kind = `${pass} ${(object.name || object.parent?.name || '?').replace(/[0-9]+/g, '#')}`;
      counts.set(kind, (counts.get(kind) ?? 0) + 1);
    }
    return orig.apply(this, arguments);
  };
  await new Promise((done) => requestAnimationFrame(() => { on = true; requestAnimationFrame(() => { on = false; done(); }); }));
  r.renderBufferDirect = orig;
  return [...counts].sort((a, b) => b[1] - a[1]).slice(0, 30).map(([k, v]) => `${v} ${k}`);
});
report.inventoryOverview = await inventory();
report.profileOverview1x = await profile(3);
// Fast forward: the simulation's share of a frame at 4x.
await page.evaluate(() => { window.__roadcraft.sim.clock.speed = 4; });
await page.waitForTimeout(3000);
report.fast = await best(60);
report.profileOverview4x = await profile(3);
report.status = await page.evaluate(() => document.querySelector('footer, [class*=status]')?.innerText.replace(/\n/g, ' ').slice(0, 120));
report.errors = errors.slice(0, 5);
writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2));
const line = (s) => `gpu ${s.gpuMs} ms · cpu draw ${s.cpuDrawMs} ms · frame ${s.frameMedianMs} ms · ${s.calls} calls · ${s.mtris} Mtris`;
for (const [name, s] of Object.entries(report.spots)) console.log(`${name.padEnd(9)} ${line(s)}`);
console.log(`no shadow ${line(report.overviewShadowFrozen)}  (overview, shadow map not redrawn)`);
console.log(`fast 4x   ${line(report.fast)}`);
console.log('passes at overview:');
for (const p of report.spots.overview.passes) console.log(`  ${p.label.padEnd(22)} ${p.ms} ms  x${p.perFrame}  ${p.calls} calls  ${p.ktris}k tris`);
console.log('draw calls at overview, one frame:');
for (const l of report.inventoryOverview) console.log(`  ${l}`);
for (const key of ['profileOverview1x', 'profileOverview4x']) {
  const p = report[key];
  if (!p) continue;
  console.log(`${key} (idle ${p.idle}%) inclusive:`);
  for (const l of p.inclusive.slice(0, 22)) console.log(`  ${l}`);
  console.log(`${key} self:`);
  for (const l of p.self.slice(0, 15)) console.log(`  ${l}`);
}
if (errors.length) console.log('page errors:', errors.slice(0, 3));
await browser.close();
