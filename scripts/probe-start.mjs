// How fast the game starts: time to the first drawn frame and to the town
// being playable, then a picture. Headless on the GPU.
//
//   node scripts/probe-start.mjs --base=http://127.0.0.1:4180 --out=docs/audit/start
import { mkdirSync } from 'node:fs';
import { chromium } from '@playwright/test';

const opt = (name, fallback) => (process.argv.find((a) => a.startsWith(`--${name}=`)) ?? `--${name}=${fallback}`).slice(name.length + 3);
const base = opt('base', 'http://127.0.0.1:4180');
const out = opt('out', 'docs/audit/start');
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 200)));
await page.addInitScript(() => { window.confirm = () => true; });
const t0 = Date.now();
await page.goto(base, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => Boolean(window.__roadcraft), null, { timeout: 120_000 });
const ready = Date.now() - t0;
await page.evaluate(() => document.getElementById('sampleCity')?.click());
await page.waitForTimeout(1500);
await page.screenshot({ path: `${out}/01-town-at-once.png` });
await page.evaluate(() => window.__roadcraft.lookAt(-300, -300, 3.5));
await page.waitForTimeout(8000);
await page.screenshot({ path: `${out}/02-street-6s.png` });
console.log(JSON.stringify({ readyMs: ready, loader: await page.$('.loading-screen') !== null, errors }));
await browser.close();
