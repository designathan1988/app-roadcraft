// Measures how the selected agent walks in the laboratory, frame by frame,
// on routes round the walls: stalls (stopped while still far from the goal),
// jerks (speed changes over a frame), the body's turn per frame, and the time
// to arrive. What the player sees as "stuck" and "jolts". Headless on the GPU.
//
//   node scripts/probe-walk.mjs --base=http://127.0.0.1:4194
import { chromium } from '@playwright/test';

const base = (process.argv.find((a) => a.startsWith('--base=')) ?? '--base=http://127.0.0.1:4194').slice(7);
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
await page.goto(`${base}/sandbox.html`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__lab && window.__lab.agents.length >= 2, null, { timeout: 120_000 });

// Routes that must go round things: behind the long wall, through the gap, round the planter.
const routes = [[-1, -5], [4, -4.5], [0.5, 6.5], [-6.5, 0], [6.8, 4], [-1, 1.5], [4.5, -1.2], [1.5, -0.2], [4.2, 0.4]];
const results = [];
for (const [x, z] of routes) {
  const r = await page.evaluate(async ([x, z]) => {
    const lab = window.__lab;
    const a = lab.agents[0];
    const to = a.position.clone().set(x, 0, z);
    a.push({ label: 'probe', steps: [{ kind: 'goto', to }] }, true);
    const samples = [];
    const t0 = performance.now();
    await new Promise((done) => {
      const tick = () => {
        samples.push({ t: performance.now(), x: a.position.x, z: a.position.z, h: a.heading });
        if (!a.busy || performance.now() - t0 > 30000) done(); else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    let stalls = 0, jerks = 0, turns = 0, worstTurn = 0, path = 0, wobble = 0, lastSign = 0;
    let prevSpeed = 0;
    for (let i = 1; i < samples.length; i++) {
      const s = samples[i], p = samples[i - 1];
      const dt = Math.max(1e-3, (s.t - p.t) / 1000);
      const step = Math.hypot(s.x - p.x, s.z - p.z);
      path += step;
      const speed = step / dt;
      const left = Math.hypot(x - s.x, z - s.z);
      if (left > 0.6 && speed < 0.15 && i > 10) stalls++;
      if (i > 2 && Math.abs(speed - prevSpeed) > 0.6) jerks++;
      const dh = Math.abs(Math.atan2(Math.sin(s.h - p.h), Math.cos(s.h - p.h)));
      worstTurn = Math.max(worstTurn, dh / dt);
      if (dh / dt > 4) turns++;
      const signed = Math.atan2(Math.sin(s.h - p.h), Math.cos(s.h - p.h));
      const sign = Math.abs(signed) > 0.004 ? Math.sign(signed) : 0;
      if (sign && lastSign && sign !== lastSign) wobble++;
      if (sign) lastSign = sign;
      prevSpeed = speed;
    }
    const last = samples[samples.length - 1];
    return {
      to: [x, z], seconds: +((last.t - samples[0].t) / 1000).toFixed(1), frames: samples.length,
      arrivedOff: +Math.hypot(x - last.x, z - last.z).toFixed(2), path: +path.toFixed(1),
      stallFrames: stalls, jerkFrames: jerks, wobbleFlips: wobble, sharpTurnFrames: turns, worstTurnRadPerS: +worstTurn.toFixed(1),
    };
  }, [x, z]);
  results.push(r);
}
for (const r of results) console.log(JSON.stringify(r));
const sum = (k) => results.reduce((s, r) => s + r[k], 0);
console.log(`TOTAL stalls ${sum('stallFrames')} · jerks ${sum('jerkFrames')} · wobble ${sum('wobbleFlips')} · sharp turns ${sum('sharpTurnFrames')} · seconds ${sum('seconds').toFixed(1)}`);
await browser.close();
