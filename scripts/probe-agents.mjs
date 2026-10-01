/* global window, document, requestAnimationFrame, Image */
/**
 * THE AGENTS PROBE: what the player sees the walkers do, measured in the
 * running game, tick by tick, on the drawn bodies (`PedView`), and the worst
 * places photographed in sequence.
 *
 *   node scripts/probe-agents.mjs <out-dir> [--base=http://localhost:5173] [--seconds=120] [--map=player-city]
 *
 * Loads `tests/fixtures/<map>.json` into a RUNNING dev server, lets the city
 * fill for a minute, then steps the simulation itself (`src/sim/pipeline.ts`
 * `step`, as the game does) and measures every body every tick:
 *
 *   back      moving faster than 0.05 m/s against the way the body faces
 *   milling   over 0.6 m walked in 2 s with under 35 % of it as headway
 *   flips     turning one way then the other within 0.6 s, both over 0.8 rad/s
 *   jump      faster than 3.5 m/s between ticks
 *
 * Writes probe.json (rates, the busiest 25 u cells, the worst people) and,
 * for the three busiest cells, four inspector shots half a second apart
 * stitched in one picture (`hot-<x>_<y>.png`). Same definitions as
 * `tests/sim/support/agentDefects.ts`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from '@playwright/test';

const args = process.argv.slice(2);
const opt = (name, fallback) => (args.find((a) => a.startsWith(`--${name}=`)) ?? `--${name}=${fallback}`).split('=')[1];
const OUT = path.resolve(args.find((a) => !a.startsWith('--')) ?? 'docs/screenshots/probe');
const BASE = opt('base', 'http://localhost:5173');
const SECONDS = Number(opt('seconds', '120'));
const MAP = opt('map', 'player-city');
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ channel: 'chrome',
  args: ['--use-gl=angle', `--use-angle=${process.platform === 'win32' ? 'd3d11' : 'vulkan'}`, '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e.message)));
await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
await page.waitForFunction('Boolean(window.__roadcraft)', null, { timeout: 60_000 });
const fixture = JSON.parse(fs.readFileSync(`tests/fixtures/${MAP}.json`, 'utf8'));

const result = await page.evaluate(async ({ doc, seconds }) => {
  const R = window.__roadcraft;
  const { step } = await import('/src/sim/pipeline.ts');
  R.loadDoc(doc);
  R.setTraffic(true);
  R.sim.clock.paused = true;
  const DT = R.DT, U = 0.4, CELL = 25;
  for (let i = 0; i < Math.round(60 / DT); i++) step(R.sim, { traffic: true, pedestrians: true });
  const W = Math.round(2 / DT);
  const per = new Map();
  const hot = new Map();
  const spot = (x, y) => { const k = `${Math.round(x / CELL) * CELL},${Math.round(y / CELL) * CELL}`; hot.set(k, (hot.get(k) ?? 0) + 1); };
  const ev = { back: 0, milling: 0, flips: 0, jump: 0, moving: 0, samples: 0 };
  let longest = 0;
  for (let t = 0; t < Math.round(seconds / DT); t++) {
    step(R.sim, { traffic: true, pedestrians: true });
    for (const p of R.sim.pedViews) {
      let s = per.get(p.id);
      if (!s) { s = { steps: [], spell: 0, turnSign: 0, turnT: -99, back: 0, milling: 0 }; per.set(p.id, s); }
      ev.samples++;
      const dx = (p.x - p.prev.x) * U, dy = (p.y - p.prev.y) * U;
      const speed = Math.hypot(dx, dy) / DT;
      if (speed > 3.5) ev.jump++;
      if (speed > 0.05) {
        ev.moving++;
        const fwd = (dx * Math.cos(p.heading) + dy * Math.sin(p.heading)) / DT;
        if (fwd < -0.05) { ev.back++; s.back++; spot(p.x, p.y); }
      }
      let dh = p.heading - p.prev.heading;
      dh = Math.atan2(Math.sin(dh), Math.cos(dh));
      const rate = dh / DT;
      if (Math.abs(rate) > 0.8) {
        const sign = Math.sign(rate);
        if (s.turnSign && sign !== s.turnSign && t - s.turnT < 0.6 / DT) ev.flips++;
        s.turnSign = sign; s.turnT = t;
      }
      s.steps.push([p.x, p.y, Math.hypot(dx, dy)]);
      if (s.steps.length > W) s.steps.shift();
      let milling = false;
      if (s.steps.length === W && !p.gesture && p.kerbWait === 0 && p.ground !== 'crossing') {
        const walked = s.steps.reduce((a, e) => a + e[2], 0);
        const net = Math.hypot(s.steps[W - 1][0] - s.steps[0][0], s.steps[W - 1][1] - s.steps[0][1]) * U;
        milling = walked > 0.6 && net < 0.35 * walked;
      }
      if (milling) { ev.milling++; s.milling++; s.spell += DT; longest = Math.max(longest, s.spell); if (t % 30 === 0) spot(p.x, p.y); } else s.spell = 0;
    }
  }
  const minutes = ev.samples * DT / 60;
  return {
    people: R.sim.pedViews.length,
    personMinutes: +minutes.toFixed(1),
    backShare: ev.back / Math.max(1, ev.moving),
    millingShare: ev.milling / Math.max(1, ev.samples),
    longestMillingSpell: +longest.toFixed(2),
    flipsPerMinute: ev.flips / Math.max(1e-9, minutes),
    jumps: ev.jump,
    hotspots: [...hot].sort((a, b) => b[1] - a[1]).slice(0, 8),
    worst: [...per].map(([id, s]) => ({ id, back: s.back, milling: s.milling }))
      .sort((a, b) => b.back + b.milling - a.back - a.milling).slice(0, 8),
  };
}, { doc: fixture.document ?? fixture, seconds: SECONDS });
console.log(JSON.stringify({ ...result, hotspots: result.hotspots.slice(0, 5), worst: result.worst.slice(0, 3) }));

// Four shots of each of the three busiest places, half a second apart.
const frames = (n) => page.evaluate((c) => new Promise((res) => { let l = c; const t = () => (--l <= 0 ? res() : requestAnimationFrame(t)); requestAnimationFrame(t); }), n);
for (const [cell] of result.hotspots.slice(0, 3)) {
  const [x, y] = cell.split(',').map(Number);
  const shots = [];
  for (let k = 0; k < 4; k++) {
    await page.evaluate(({ x, y }) => window.__roadcraft.lookAt(x, y, 18), { x, y });
    await frames(6); await page.waitForTimeout(600); await frames(4);
    shots.push(await page.evaluate(({ x, y }) => {
      const R = window.__roadcraft, h = R.scene().elevationAt(x, y);
      return R.scene().inspect?.shot({ x, y, h: h + 2, azimuth: 0.9, elevation: 0.5, distance: 32, fov: 35, width: 640, height: 480 }) ?? null;
    }, { x, y }));
    await page.evaluate(async () => { const { step } = await import('/src/sim/pipeline.ts'); for (let i = 0; i < 30; i++) step(window.__roadcraft.sim, { traffic: true, pedestrians: true }); });
  }
  if (shots.some((s) => !s)) throw new Error('no inspection camera: is this a development build?');
  const sheet = await page.evaluate(async (urls) => {
    const canvas = document.createElement('canvas');
    canvas.width = 1280; canvas.height = 960;
    const g = canvas.getContext('2d');
    for (let i = 0; i < urls.length; i++) {
      const img = new Image(); img.src = urls[i]; await img.decode();
      g.drawImage(img, (i % 2) * 640, Math.floor(i / 2) * 480);
      g.fillStyle = 'rgba(0,0,0,0.6)'; g.fillRect((i % 2) * 640, Math.floor(i / 2) * 480, 70, 28);
      g.fillStyle = '#fff'; g.font = '600 18px monospace'; g.fillText(`+${i * 0.5}s`, (i % 2) * 640 + 8, Math.floor(i / 2) * 480 + 20);
    }
    return canvas.toDataURL('image/png');
  }, shots);
  fs.writeFileSync(path.join(OUT, `hot-${x}_${y}.png`), Buffer.from(sheet.split(',')[1], 'base64'));
}
fs.writeFileSync(path.join(OUT, 'probe.json'), JSON.stringify({ map: MAP, seconds: SECONDS, ...result, errors }, null, 1));
console.log(`-> ${OUT}${errors.length ? ` (${errors.length} page errors)` : ''}`);
await browser.close();
