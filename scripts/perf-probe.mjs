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

const result = await page.evaluate(async () => {
  const R = window.__roadcraft;
  const scene = R.scene();
  const people = scene.scene.getObjectByName('rigged-citizens');
  const frames = async (n, move) => {
    const ts = [];
    let last = performance.now();
    await new Promise((done) => {
      let k = 0;
      const f = () => {
        const t = performance.now();
        ts.push(t - last);
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
  R.lookAt(0, -560, 4);
  await new Promise((d) => setTimeout(d, 2500));
  const still = await frames(120);
  const gpuStill = await gpu(90);
  const moving = await frames(240, (k) => R.lookAt(-500 + k * 4, -400 + k * 1.6, 4));
  const back = await frames(240, (k) => R.lookAt(500 - k * 4, 400 - k * 1.6, 4));
  return {
    quality: scene.stats.quality,
    size: [scene.gl.domElement.width, scene.gl.domElement.height],
    peopleReady: `${people?.userData.loadedModels ?? 0}/${people?.userData.availableModels ?? 0}`,
    personBuilds: performance.getEntriesByName('person-rig').map((e) => Math.round(e.duration)),
    still, gpuStill, moving, back,
  };
});
console.log(JSON.stringify(result, null, 2));
if (errors.length) console.log('page errors:', errors.slice(0, 5));
await browser.close();
