// Cooks the people ahead (src/render/people/cookedPerson.ts): every roster
// person built once in a real browser, packed, and written by the development
// server to cooked/people/<id>.bin, with a manifest stamped with the build's
// fingerprint of how people are built (cook-plugin.ts). The game then reads
// them back instead of building them; `npm run build` copies them into dist.
// Run again whenever the people code or assets change (the fingerprint
// changes and stale bodies are never used: they are built instead).
//
//   node scripts/cook-people.mjs [--base=http://127.0.0.1:5173]
//
// A development server of this checkout must be running. Headless, on the GPU.
import { chromium } from '@playwright/test';

const base = (process.argv.find((a) => a.startsWith('--base=')) ?? '--base=http://127.0.0.1:5173').slice(7);
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e.message)));
const started = Date.now();
await page.goto(`${base}/?nocook`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof window.__cookPeople === 'function', null, { timeout: 120_000 });
await page.waitForSelector('.loading-screen', { state: 'detached', timeout: 600_000 }).catch(() => {});
const result = await page.evaluate(() => window.__cookPeople());
if (!result.hash) throw new Error('The page has no people fingerprint (not a development build of this checkout?)');
const manifest = JSON.stringify({ hash: result.hash, ids: result.ids, cooked: new Date().toISOString() });
// Sent from the page, as the bodies were: Node's fetch refuses some ports (4190 among them).
const status = await page.evaluate(async (body) => (await fetch('/__cook/people/manifest.json', { method: 'PUT', body })).status, manifest);
if (status >= 300) throw new Error(`Manifest: ${status}`);
console.log(`cooked ${result.ids.length} people, ${(result.bytes / 1e6).toFixed(1)} MB, fingerprint ${result.hash}, ${((Date.now() - started) / 1000).toFixed(0)} s`);
if (errors.length) console.log('page errors:', errors.slice(0, 3));
await browser.close();
