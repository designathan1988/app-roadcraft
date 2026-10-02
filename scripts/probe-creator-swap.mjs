// The Person Creator while a look changes: pictures of the preview right
// after a click (40 ms, 150 ms, 400 ms, 1.5 s), to see that the person never
// shows bare, untextured skin in between. Headless on the GPU.
//
//   node scripts/probe-creator-swap.mjs --base=http://127.0.0.1:4180 --out=docs/audit/creator-swap
import { mkdirSync } from 'node:fs';
import { chromium } from '@playwright/test';

const opt = (name, fallback) => (process.argv.find((a) => a.startsWith(`--${name}=`)) ?? `--${name}=${fallback}`).slice(name.length + 3);
const base = opt('base', 'http://127.0.0.1:4180');
const out = opt('out', 'docs/audit/creator-swap');
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 200)));
await page.addInitScript(() => { window.confirm = () => true; });
await page.goto(base, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => Boolean(window.__roadcraft), null, { timeout: 120_000 });
await page.keyboard.press('k');
await page.waitForTimeout(6000);
const stage = { x: 450, y: 65, width: 415, height: 720 };
const click = async (section, label) => {
  await page.evaluate((section) => {
    const boxes = [...document.querySelectorAll('details.pc-section')];
    boxes.forEach((d) => { d.open = d.querySelector('summary')?.textContent?.toLowerCase().includes(section) ?? false; });
  }, section);
  await page.waitForTimeout(300);
  await page.locator('details.pc-section[open] button', { hasText: label }).first().click();
};
for (const [step, section, label] of [['hair', 'cabelo', 'Curto 3'], ['outfit', 'roupas', 'Sneakers'], ['hair2', 'cabelo', 'Longo']]) {
  await click(section, label);
  for (const ms of [40, 150, 400, 1500]) {
    await page.waitForTimeout(ms === 40 ? 40 : ms - [40, 150, 400, 1500][[40, 150, 400, 1500].indexOf(ms) - 1]);
    await page.screenshot({ path: `${out}/${step}-${ms}ms.png`, clip: stage });
  }
}
console.log(JSON.stringify({ errors }));
await browser.close();
