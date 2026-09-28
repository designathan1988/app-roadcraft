/**
 * Renders the contact sheet of the citizen roster (front and profile, with
 * ids) from a RUNNING dev server, for classifying the models by eye.
 *
 *   node scripts/contact-sheet.mjs <out.jpg> [--base=http://localhost:5176] [--ids=a,b,c]
 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from '@playwright/test';

const args = process.argv.slice(2);
const OUT = path.resolve(args.find((a) => !a.startsWith('--')) ?? 'docs/screenshots/contact-sheet.jpg');
const BASE = (args.find((a) => a.startsWith('--base=')) ?? '--base=http://localhost:5176').slice(7);
const IDS = (args.find((a) => a.startsWith('--ids=')) ?? '').slice(6).split(',').filter(Boolean);

const browser = await chromium.launch({
  channel: 'chrome',
  args: ['--use-gl=angle', `--use-angle=${process.platform === 'win32' ? 'd3d11' : 'vulkan'}`, '--enable-gpu', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage();
await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
const url = await page.evaluate(async (ids) => {
  const { contactSheet } = await import('/tests/fixtures/contactSheet.ts');
  return contactSheet(ids.length ? ids : undefined, 4);
}, IDS);
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, Buffer.from(url.split(',')[1], 'base64'));
console.log(`contact sheet -> ${OUT}`);
await browser.close();
