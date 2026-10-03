// A street corner of the sample town from above, close: what the footway does
// round a junction and where the buildings stop. Headless on the GPU.
//
//   node scripts/probe-corner.mjs --base=http://127.0.0.1:4180 --out=docs/audit/corner
import { mkdirSync } from 'node:fs';
import { chromium } from '@playwright/test';

const opt = (name, fallback) => (process.argv.find((a) => a.startsWith(`--${name}=`)) ?? `--${name}=${fallback}`).slice(name.length + 3);
const base = opt('base', 'http://127.0.0.1:4180');
const out = opt('out', 'docs/audit/corner');
const tag = opt('tag', 'before');
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
await page.addInitScript(() => { window.confirm = () => true; try { localStorage.setItem('roadcraft.sky', 'day'); } catch { /* blocked */ } });
await page.goto(base, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => Boolean(window.__roadcraft), null, { timeout: 120_000 });
await page.evaluate(() => document.getElementById('sampleCity')?.click());
await page.waitForTimeout(6000);
// The junctions of the town, nearest the middle first.
const nodes = await page.evaluate(() => {
  const doc = window.__roadcraft.doc ?? window.__roadcraft.sim?.doc;
  const out = [];
  for (const [id, n] of doc.nodes) if (n.incident.length >= 3) out.push({ id, x: n.x, y: n.y, legs: n.incident.length });
  return out.sort((a, b) => Math.hypot(a.x, a.y) - Math.hypot(b.x, b.y)).slice(0, 3);
});
console.log(JSON.stringify(nodes));
for (const [i, n] of nodes.entries()) {
  await page.evaluate(([x, y]) => window.__roadcraft.lookAt(x, y, 5), [n.x, n.y]);
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${out}/${tag}-junction-${i}.png` });
}
await browser.close();
