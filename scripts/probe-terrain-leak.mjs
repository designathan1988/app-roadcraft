// What memory a terrain stroke leaves alive: a sampling heap profile across
// two strokes on the town, read after garbage collection, summed by the
// function that allocated it. Headless on the GPU.
import { chromium } from '@playwright/test';

const base = (process.argv.find((a) => a.startsWith('--base=')) ?? '--base=http://127.0.0.1:4197').slice(7);
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-precise-memory-info'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
await page.addInitScript(() => { window.confirm = () => true; });
await page.goto(base, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => Boolean(window.__roadcraft), null, { timeout: 120_000 });
await page.waitForTimeout(Number((process.argv.find((a) => a.startsWith('--settle=')) ?? '--settle=5000').slice(9)));
const cdp = await page.context().newCDPSession(page);
const heap = async () => { await cdp.send('HeapProfiler.collectGarbage'); return page.evaluate(() => {
  const scene = window.__roadcraft.scene();
  const s3 = scene.three ?? scene.scene ?? null;
  let bytes = 0, geos = new Set();
  const root = typeof scene.root === 'function' ? scene.root() : null;
  const walkObj = (o) => { if (o.geometry && !geos.has(o.geometry)) { geos.add(o.geometry); for (const a of Object.values(o.geometry.attributes)) bytes += a.array.byteLength; if (o.geometry.index) bytes += o.geometry.index.array.byteLength; } for (const c of o.children ?? []) walkObj(c); };
  const sc = scene.scene ?? null;
  if (sc) walkObj(sc);
  const info = scene.gl?.info?.memory ?? {};
  return { registered: info.geometries, textures: info.textures, heapMB: Math.round(performance.memory.usedJSHeapSize / 1048576), sceneGeoMB: Math.round(bytes / 1048576), geometries: geos.size, keys: Object.keys(scene).slice(0, 40).join(',') };
}); };
await page.click('[data-tool="terrain"]');
await page.evaluate(() => window.__roadcraft.lookAt(0, 0, 1.1));
await page.waitForTimeout(800);
console.log('before', await heap(), 'MB');
await cdp.send('HeapProfiler.enable');
await cdp.send('HeapProfiler.startSampling', { samplingInterval: 65536 });
const c = { x: 800, y: 470 };
console.log('settled', await heap());
const N = Number((process.argv.find((a) => a.startsWith('--strokes=')) ?? '--strokes=2').slice(10));
for (let k = 0; k < N; k++) {
  await page.mouse.move(c.x + 60, c.y);
  await page.mouse.down();
  for (let i = 1; i <= 12; i++) { await page.mouse.move(c.x + Math.cos(i / 12 * 6.283) * 60, c.y + Math.sin(i / 12 * 6.283) * 33, { steps: 4 }); await page.waitForTimeout(60); }
  await page.mouse.up();
  await page.waitForTimeout(1500);
  console.log('stroke', k + 1, JSON.stringify(await heap()).slice(0, 120));
}
await cdp.send('HeapProfiler.collectGarbage');
const { profile } = await cdp.send('HeapProfiler.getSamplingProfile');
console.log('after', await heap(), 'MB');
const totals = new Map();
const walk = (node, stack) => {
  const f = node.callFrame;
  const name = `${f.functionName || '(anon)'} @${f.url.split('/').pop()}:${f.lineNumber + 1}`;
  const path = [...stack, name];
  if (node.selfSize) {
    // Credit the allocation to the nearest frame of our own code.
    const own = [...path].reverse().find((p) => p.includes('index-')) ?? name;
    totals.set(own, (totals.get(own) ?? 0) + node.selfSize);
  }
  for (const child of node.children) walk(child, path.slice(-12));
};
walk(profile.head, []);
for (const [name, bytes] of [...totals].sort((a, b) => b[1] - a[1]).slice(0, 25)) console.log(`${(bytes / 1048576).toFixed(1).padStart(8)} MB  ${name}`);
await browser.close();
