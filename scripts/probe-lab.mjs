// Drives the agents' laboratory (sandbox.html) as the player does - clicks on
// the ground, on objects, on people, and on the menu they open - and
// photographs each step. Headless on the GPU.
//
//   node scripts/probe-lab.mjs --base=http://127.0.0.1:4194 --out=docs/audit/lab
import { mkdirSync } from 'node:fs';
import { chromium } from '@playwright/test';

const opt = (name, fallback) => (process.argv.find((a) => a.startsWith(`--${name}=`)) ?? `--${name}=${fallback}`).slice(name.length + 3);
const base = opt('base', 'http://127.0.0.1:4194');
const out = opt('out', 'docs/audit/lab');
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e.stack || e.message).split('\n').slice(0, 3).join(' | ')));
await page.goto(`${base}/sandbox.html`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__lab && window.__lab.agents.length >= 2, null, { timeout: 120_000 });

/** Screen point of a world point. */
const screen = (x, y, z) => page.evaluate(([x, y, z]) => {
  const { camera } = window.__lab;
  const v = camera.position.clone().set(x, y, z).project(camera);
  return { x: (v.x * 0.5 + 0.5) * innerWidth, y: (-v.y * 0.5 + 0.5) * innerHeight };
}, [x, y, z]);
const click = async (x, y, z) => { const s = await screen(x, y, z); await page.mouse.click(s.x, s.y); return s; };
const menu = async (label) => {
  await page.waitForSelector('#menu:not([hidden])', { timeout: 5000 });
  await page.click(`#menu button:has-text("${label}")`);
};
const agentAt = (i) => page.evaluate((i) => {
  const a = window.__lab.agents[i];
  return { x: +a.position.x.toFixed(2), z: +a.position.z.toFixed(2), queue: a.queue.map((q) => q.label), carrying: !!a.carrying };
}, i);
const shot = (name) => page.screenshot({ path: `${out}/${name}.png` });
const log = [];

// 1. Walk behind the long wall: the way is round its end, not through it.
await click(-1, 0, -5);
await page.waitForTimeout(1500);
await shot('02-walking-round-the-wall');
await page.waitForTimeout(9000);
log.push(['walked to (-1,-5)', await agentAt(0)]);
await shot('03-arrived-behind-the-wall');

// 2. Sit on the bench beside it.
await click(-2.5, 0.45, -6.5);
await menu('Sentar');
await page.waitForTimeout(9000);
log.push(['sitting', await agentAt(0)]);
await shot('04-sitting');

// 3. Get up and pick up the box (its menu queues after the seat: the seat ends).
await click(2.5, 0.14, 4.5);
await menu('Pegar a caixa');
await page.waitForTimeout(16000);
log.push(['picked the box', await agentAt(0)]);
await shot('05-carrying-the-box');

// 4. Talk to the other person.
const other = await agentAt(1);
await click(other.x, 0.9, other.z);
await menu('Conversar');
await page.waitForTimeout(8000);
log.push(['talking', await agentAt(0), await agentAt(1)]);
await shot('06-talking');

// 5. Put the box down, from her own menu.
const me = await agentAt(0);
await page.waitForTimeout(10000);
await click(me.x, 0.9, me.z);
await menu('Largar a caixa');
await page.waitForTimeout(6000);
log.push(['put the box down', await agentAt(0)]);
await shot('07-box-down');

for (const line of log) console.log(JSON.stringify(line));
console.log('errors', errors.slice(0, 4));
await browser.close();
