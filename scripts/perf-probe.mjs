// Frame-time probe: the town to explore, walked by the camera, in a real
// Chrome on the GPU. Prints frame times (still and moving), GPU time per
// render pass, and how many kinds of person were ready.
//
//   node scripts/perf-probe.mjs [--base=http://localhost:5173] [--wait=40] [--width=1920 --height=1080]
//
// A dev server must be running. Short, foreground: about a minute and a half.
import { chromium } from '@playwright/test';

const opt = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const BASE = opt('base', 'http://localhost:5173');
const WAIT = Number(opt('wait', '40'));
const WIDTH = Number(opt('width', '1920'));
const HEIGHT = Number(opt('height', '1080'));
const PROFILE = process.argv.includes('--profile');
const ZOOM = Number(opt('zoom', '4'));

const browser = await chromium.launch({ channel: 'chrome', headless: false,
  args: ['--use-gl=angle', `--use-angle=${process.platform === 'win32' ? 'd3d11' : 'vulkan'}`, '--enable-gpu', '--ignore-gpu-blocklist',
    `--window-size=${WIDTH},${HEIGHT + 120}`] });
const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e.message)));
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForFunction('Boolean(window.__roadcraft)', null, { timeout: 60_000 });
await page.evaluate(() => { window.confirm = () => true; document.getElementById('sampleCity').click(); });
await page.waitForTimeout(WAIT * 1000);

const result = await page.evaluate(async ({ profile, zoom }) => {
  const R = window.__roadcraft;
  const scene = R.scene();
  const people = scene.scene.getObjectByName('rigged-citizens');
  const spans = [];
  const frames = async (n, move) => {
    const ts = [];
    let last = performance.now();
    await new Promise((done) => {
      let k = 0;
      const f = () => {
        const t = performance.now();
        ts.push(t - last);
        spans.push([last, t]);
        last = t;
        if (move) move(k);
        if (++k < n) requestAnimationFrame(f); else done();
      };
      requestAnimationFrame(f);
    });
    ts.shift();
    const s = [...ts].sort((a, b) => a - b);
    const at = (q) => +s[Math.min(s.length - 1, Math.floor(s.length * q))].toFixed(1);
    return { median: at(0.5), p90: at(0.9), worst: at(1), over50: ts.filter((t) => t > 50).length, frames: ts.length };
  };
  // GPU time per render call, by target.
  const gpu = async (n) => {
    const r = scene.gl;
    const g = r.getContext();
    const ext = g.getExtension('EXT_disjoint_timer_query_webgl2');
    if (!ext) return null;
    const original = r.render.bind(r);
    const pending = [];
    const totals = {};
    r.render = (s, c) => {
      const q = g.createQuery();
      g.beginQuery(ext.TIME_ELAPSED_EXT, q);
      original(s, c);
      g.endQuery(ext.TIME_ELAPSED_EXT);
      const t = r.getRenderTarget();
      pending.push([q, t ? (t.texture?.name || 'target') : 'screen']);
    };
    const poll = () => {
      for (let i = pending.length - 1; i >= 0; i--) {
        const [q, name] = pending[i];
        if (!g.getQueryParameter(q, g.QUERY_RESULT_AVAILABLE)) continue;
        totals[name] = (totals[name] ?? 0) + g.getQueryParameter(q, g.QUERY_RESULT) / 1e6;
        g.deleteQuery(q);
        pending.splice(i, 1);
      }
    };
    await frames(n, () => poll());
    await new Promise((d) => setTimeout(d, 300));
    poll();
    r.render = original;
    const rows = Object.entries(totals).map(([k, v]) => [k, +(v / n).toFixed(2)]).sort((a, b) => b[1] - a[1]);
    return { total: +rows.reduce((a, b) => a + b[1], 0).toFixed(1), passes: rows.slice(0, 6) };
  };
  R.lookAt(0, -560, zoom);
  await new Promise((d) => setTimeout(d, 2500));
  const still = await frames(120);
  const gpuStill = await gpu(90);
  const keyOf = (pr) => { const k = pr.cacheKey || ''; return (pr.name || '') + '|' + k.slice(0, 160) + '|' + k.slice(k.lastIndexOf('srgb,') + 5).slice(0, 80) + '|' + k.length; };
  const before = new Set((scene.gl.info.programs || []).map(keyOf));
  const props = scene.gl.properties;
  const unready = [];
  scene.scene.traverse((o) => { const ms = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : []; for (const m of ms) if (!props.get(m).currentProgram) unready.push([o, m]); });
  const profiler = profile && typeof Profiler === 'function' ? new Profiler({ sampleInterval: 2, maxBufferSize: 200000 }) : null;
  const moving = await frames(240, (k) => R.lookAt(-500 + k * 4, -400 + k * 1.6, zoom));
  const back = await frames(240, (k) => R.lookAt(500 - k * 4, 400 - k * 1.6, zoom));
  let hot = null;
  if (profiler) {
    const tr = await profiler.stop();
    const name = (fi) => { const f = tr.frames[fi]; const r = f.resourceId !== undefined ? tr.resources[f.resourceId].split('/').pop().split('?')[0] : ''; return `${f.name || '(anon)'} @${r}:${f.line ?? ''}`; };
    const incl = new Map();
    let idle = 0;
    for (const sample of tr.samples) {
      if (sample.stackId === undefined) { idle++; continue; }
      let st = tr.stacks[sample.stackId];
      const seen = new Set();
      while (st) { const n = name(st.frameId); if (!seen.has(n)) { incl.set(n, (incl.get(n) ?? 0) + 1); seen.add(n); } st = st.parentId !== undefined ? tr.stacks[st.parentId] : null; }
    }
    const worst = [...spans].sort((x, y) => (y[1] - y[0]) - (x[1] - x[0])).slice(0, 3).map(([from, to]) => {
      const m = new Map();
      const leaf = new Map();
      for (const sample of tr.samples) {
        if (sample.timestamp < from || sample.timestamp > to || sample.stackId === undefined) continue;
        let st = tr.stacks[sample.stackId];
        const l = name(st.frameId);
        leaf.set(l, (leaf.get(l) ?? 0) + 1);
        const seen = new Set();
        while (st) { const n = name(st.frameId); if (!seen.has(n)) { m.set(n, (m.get(n) ?? 0) + 1); seen.add(n); } st = st.parentId !== undefined ? tr.stacks[st.parentId] : null; }
      }
      return { ms: Math.round(to - from), leaf: [...leaf].sort((x, y) => y[1] - x[1]).slice(0, 8).map(([k, v]) => `${v} ${k}`), top: [...m].sort((x, y) => y[1] - x[1]).slice(0, 8).map(([k, v]) => `${v} ${k}`) };
    });
    hot = { worst, idle: +(100 * idle / tr.samples.length).toFixed(1), top: [...incl].sort((a, b) => b[1] - a[1]).slice(0, 18).map(([k, v]) => `${(100 * v / tr.samples.length).toFixed(1)}% ${k}`) };
  }
  return {
    quality: scene.stats.quality,
    size: [scene.gl.domElement.width, scene.gl.domElement.height],
    peopleReady: `${people?.userData.loadedModels ?? 0}/${people?.userData.availableModels ?? 0}`,
    personBuilds: performance.getEntriesByName('person-rig').map((e) => Math.round(e.duration)),
    newPrograms: (scene.gl.info.programs || []).map(keyOf).filter((k) => !before.has(k)),
    keyDiff: (() => {
      const all = scene.gl.info.programs || [];
      const fresh = all.filter((pr) => !before.has(keyOf(pr)));
      return fresh.map((f) => {
        const a = f.cacheKey.split(',');
        let best = null, bestDiff = 1e9;
        for (const o of all) { if (o === f) continue; const b = o.cacheKey.split(','); if (b.length !== a.length) continue; const d = a.filter((x, i) => x !== b[i]).length; if (d < bestDiff) { bestDiff = d; best = b; } }
        return best ? a.map((x, i) => (x !== best[i] ? `#${i}: ${best[i]} -> ${x}` : null)).filter(Boolean) : ['no peer'];
      });
    })(),
    newProgramUsers: (() => {
      const fresh = new Set((scene.gl.info.programs || []).filter((pr) => !before.has(keyOf(pr))));
      const users = [];
      scene.scene.traverse((o) => { const ms = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : []; for (const m of ms) { const pr = props.get(m).currentProgram; if (pr && fresh.has(pr)) users.push(`${o.name || o.type} < ${o.parent?.name || o.parent?.type} < ${o.parent?.parent?.name || ''} / ${m.name || m.type}`); } });
      return users.slice(0, 10);
    })(),
    firstDrawnDuringWalk: unready.filter(([, m]) => props.get(m).currentProgram).map(([o, m]) => `${o.name || o.type} / ${m.name || m.type} / visible=${o.visible} parent=${o.parent?.name}`).slice(0, 15),
    still, gpuStill, moving, back, hot,
  };
}, { profile: PROFILE, zoom: ZOOM });
console.log(JSON.stringify(result, null, 2));
if (errors.length) console.log('page errors:', errors.slice(0, 5));
await browser.close();
