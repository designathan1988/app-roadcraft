// What the overview draws, by kind: triangles (geometry x instances), meshes,
// instances and how many of them cast shadows. Headless on the GPU, the town
// at the morning rush.
//
//   node scripts/probe-triangles.mjs --base=http://127.0.0.1:4190
import { chromium } from '@playwright/test';

const base = (process.argv.find((a) => a.startsWith('--base=')) ?? '--base=http://127.0.0.1:5173').slice(7);
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
await page.addInitScript(() => { window.confirm = () => true; try { localStorage.setItem('roadcraft.sky', 'day'); } catch { /* blocked */ } });
await page.goto(base, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.loading-screen', { state: 'detached', timeout: 300_000 });
await page.evaluate(() => document.getElementById('sampleCity').click());
await page.waitForTimeout(8000);
await page.evaluate(() => window.__roadcraft.sim.city.skip(95));
await page.waitForTimeout(6000);
await page.keyboard.press('Home');
await page.waitForTimeout(3000);
const rows = await page.evaluate(() => {
  const scene = window.__roadcraft.scene().scene;
  const out = new Map();
  let total = 0;
  scene.traverse((o) => {
    if (!o.isMesh) return;
    for (let p = o; p; p = p.parent) if (!p.visible) return;
    const g = o.geometry;
    const count = g.index ? g.index.count : (g.attributes.position?.count ?? 0);
    const tris = (Number.isFinite(g.drawRange?.count) ? Math.min(count, g.drawRange.count) : count) / 3 * (o.isInstancedMesh ? o.count : 1);
    total += tris;
    const key = (o.name || o.parent?.name || o.material?.name || '?').replace(/[0-9]+/g, '#');
    const r = out.get(key) ?? { tris: 0, meshes: 0, inst: 0, shadow: 0 };
    r.tris += tris; r.meshes++; r.inst += o.isInstancedMesh ? o.count : 1; if (o.castShadow) r.shadow += tris;
    out.set(key, r);
  });
  return { total: Math.round(total / 1e3), top: [...out].sort((a, b) => b[1].tris - a[1].tris).slice(0, 25)
    .map(([k, r]) => `${Math.round(r.tris / 1e3)}k ${k} (${r.meshes} meshes, ${r.inst} inst, shadow ${Math.round(r.shadow / 1e3)}k)`) };
});
console.log(`visible ${rows.total}k triangles`);
for (const line of rows.top) console.log(`  ${line}`);
await browser.close();
