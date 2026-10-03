// How big the town's document is when serialised, and its parts.
import { chromium } from '@playwright/test';
const base = (process.argv.find((a) => a.startsWith('--base=')) ?? '--base=http://127.0.0.1:4197').slice(7);
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=d3d11', '--enable-gpu'] });
const page = await browser.newPage();
await page.addInitScript(() => { window.confirm = () => true; });
await page.goto(base, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => Boolean(window.__roadcraft), null, { timeout: 120_000 });
await page.waitForTimeout(3000);
console.log(JSON.stringify(await page.evaluate(() => {
  const json = window.__roadcraft.doc.toJSON();
  const size = (v) => (JSON.stringify(v) ?? '').length;
  const parts = {};
  for (const [k, v] of Object.entries(json)) parts[k] = size(v);
  const b = json.buildings ?? [];
  const biggest = [...b].map((x) => ({ id: x.id, fn: x.function, len: size(x) })).sort((a, c) => c.len - a.len).slice(0, 5);
  const fields = {};
  for (const x of b) for (const [k, v] of Object.entries(x)) fields[k] = (fields[k] ?? 0) + size(v);
  return { totalChars: size(json), parts, biggest, buildingFields: fields };
}), null, 1));
await browser.close();
