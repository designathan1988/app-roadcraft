// How long the loading screen stays up: a cold start (no baked people kept)
// and a warm one (the bakes kept from the first). Headless, on the GPU.
//
//   node scripts/probe-loading.mjs --base=http://127.0.0.1:4190
import { chromium } from '@playwright/test';

const base = (process.argv.find((a) => a.startsWith('--base=')) ?? '--base=http://127.0.0.1:5173').slice(7);
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
const run = async (label) => {
  const page = await context.newPage();
  const t0 = Date.now();
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.loading-screen', { state: 'attached', timeout: 30_000 });
  await page.waitForSelector('.loading-screen', { state: 'detached', timeout: 600_000 });
  const measured = await page.evaluate(() => performance.getEntriesByName('loading-screen').map((e) => Math.round(e.duration)));
  const stages = await page.evaluate(() => Object.fromEntries(['person-rig', 'person-face', 'person-bake'].map((n) => {
    const e = performance.getEntriesByName(n);
    return [n, `${e.length}x sum ${Math.round(e.reduce((s, x) => s + x.duration, 0))} ms`];
  })));
  console.log(`${label}: loading screen ${measured[0]} ms (page open to play ${Date.now() - t0} ms)`, stages);
  await page.close();
};
await run('cold');
await run('warm');
await browser.close();
