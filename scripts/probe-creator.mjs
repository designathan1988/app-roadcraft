// Photographs the Person Creator's galleries (hair, clothes and accessories)
// in a built game, each section opened in turn. Headless on the GPU.
//
//   node scripts/probe-creator.mjs --base=http://127.0.0.1:4180 --out=docs/audit/creator
import { mkdirSync } from 'node:fs';
import { chromium } from '@playwright/test';

const opt = (name, fallback) => (process.argv.find((a) => a.startsWith(`--${name}=`)) ?? `--${name}=${fallback}`).slice(name.length + 3);
const base = opt('base', 'http://127.0.0.1:4180');
const out = opt('out', 'docs/audit/creator');
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 200)));
await page.addInitScript(() => { window.confirm = () => true; });
await page.goto(base, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => Boolean(window.__roadcraft), null, { timeout: 120_000 });
await page.waitForSelector('.loading-screen', { state: 'detached', timeout: 300_000 }).catch(() => {});
await page.evaluate(() => document.getElementById('sampleCity')?.click());
await page.waitForTimeout(4000);
await page.keyboard.press('k');
await page.waitForTimeout(4000);
const sections = await page.$$eval('.pc-section-title', (els) => els.map((e) => e.textContent));
const counts = [];
for (let i = 0; i < sections.length; i++) {
  const name = sections[i];
  if (!/cabelo|hair|roupa|clothes/i.test(name ?? '')) continue;
  await page.evaluate((i) => { document.querySelectorAll('details.pc-section').forEach((d, k) => { d.open = k === i; }); }, i);
  await page.waitForTimeout(1500);
  counts.push(await page.evaluate((i) => {
    const box = document.querySelectorAll('details.pc-section')[i];
    return [...box.querySelectorAll('.pc-slider-name, .pc-gallery-title, h4, span')].slice(0, 0).length
      + [...box.children].map((c) => `${c.className}`).join(',').length * 0
      + box.querySelectorAll('img, button').length;
  }, i));
  const box = (await page.$$('details.pc-section'))[i];
  await box.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${out}/${String(i).padStart(2, '0')}-${(name ?? '').replace(/\W+/g, '_')}.png`, fullPage: false });
  // The section's whole height, in slices.
  const h = await box.evaluate((b) => b.getBoundingClientRect().height);
  for (let y = 900, k = 1; y < h && k < 8; y += 900, k++) {
    await box.evaluate((b, y) => { let p = b.parentElement; while (p && p.scrollHeight <= p.clientHeight) p = p.parentElement; if (p) p.scrollTop += 900; }, y);
    await page.waitForTimeout(800);
    await page.screenshot({ path: `${out}/${String(i).padStart(2, '0')}-${(name ?? '').replace(/\W+/g, '_')}-${k}.png` });
  }
}
console.log(JSON.stringify({ sections, counts, errors }, null, 1));
await browser.close();
