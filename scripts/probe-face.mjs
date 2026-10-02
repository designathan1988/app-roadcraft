// Close-ups in the agents' laboratory: the face (brows, blinks, speech) and
// the hands on a carried box. Headless on the GPU.
//
//   node scripts/probe-face.mjs --base=http://127.0.0.1:4194 --out=docs/audit/lab-face
import { mkdirSync } from 'node:fs';
import { chromium } from '@playwright/test';

const opt = (name, fallback) => (process.argv.find((a) => a.startsWith(`--${name}=`)) ?? `--${name}=${fallback}`).slice(name.length + 3);
const base = opt('base', 'http://127.0.0.1:4194');
const out = opt('out', 'docs/audit/lab-face');
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e.stack || e.message).split('\n').slice(0, 3).join(' | ')));
await page.goto(`${base}/sandbox.html`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__lab && window.__lab.agents.length >= 2, null, { timeout: 120_000 });
await page.waitForTimeout(1500);

/** Puts the camera before the agent's bone, `back` metres in front, `up` above. */
const look = (i, bone, back, up = 0, side = 0) => page.evaluate(([i, bone, back, up, side]) => {
  const { agents, camera, controls } = window.__lab;
  const a = agents[i];
  const p = a.body.boneAt(bone, camera.position.clone()).applyMatrix4(a.body.root.matrixWorld);
  const f = { x: Math.sin(a.heading), z: Math.cos(a.heading) };
  camera.position.set(p.x + f.x * back + f.z * side, p.y + up, p.z + f.z * back - f.x * side);
  controls.minDistance = 0.05; controls.target.copy(p);
  controls.update();
  const t = a.body.mesh.morphTargetDictionary ?? {};
  return { morphs: Object.keys(t).length, blink: t.blinkLeft !== undefined };
}, [i, bone, back, up, side]);
const shot = (name) => page.screenshot({ path: `${out}/${name}.png` });
const log = [];

// 1. The face, near: brows on the skin; a run of frames to catch a blink.
log.push(['face', await look(0, 'Bip01_Head', 0.32, 0.06)]);
await shot('01-face-front');
let blinks = 0;
for (let k = 0; k < 40 && blinks < 1; k++) {
  await page.waitForTimeout(60);
  const b = await page.evaluate(() => {
    const m = window.__lab.agents[0].body.mesh;
    return m.morphTargetInfluences[m.morphTargetDictionary.blinkLeft] ?? 0;
  });
  if (b > 0.6) { await look(0, 'Bip01_Head', 0.32, 0.06); await shot('02-face-blink'); blinks++; log.push(['blink', b]); }
}
await look(0, 'Bip01_Head', 0.28, 0.06, 0.2);
await shot('03-face-three-quarter');
await look(0, 'Bip01_Head', 0.04, 0.06, 0.32);
await shot('04-face-profile');

// 2. Talking: the pair interaction, faces close.
await page.evaluate(() => window.__lab.select(window.__lab.agents[0]));
await page.evaluate(() => { const { camera, controls, agents } = window.__lab; const p = agents[1].position; camera.position.set(p.x + 4, 6, p.z + 8); controls.target.set(p.x, 0.8, p.z); controls.update(); });
await page.waitForTimeout(300);
const other = await page.evaluate(() => { const p = window.__lab.agents[1].position; return [p.x, 1.0, p.z]; });
const s = await page.evaluate(([x, y, z]) => {
  const { camera } = window.__lab;
  const v = camera.position.clone().set(x, y, z).project(camera);
  return { x: (v.x * 0.5 + 0.5) * innerWidth, y: (-v.y * 0.5 + 0.5) * innerHeight };
}, other);
await page.mouse.click(s.x, s.y);
await page.waitForSelector('#menu:not([hidden])', { timeout: 5000 }).catch(() => {});
await page.click('#menu button:has-text("Conversar")').catch((e) => log.push(['no talk menu', String(e).slice(0, 80)]));
await page.waitForTimeout(9000);
log.push(['talking', await look(0, 'Bip01_Head', 0.6, 0.05, 0.2)]);
await shot('05-talking');
await page.waitForTimeout(250);
await look(0, 'Bip01_Head', 0.6, 0.05, 0.2);
await shot('06-talking-later');
log.push(['jaw', await page.evaluate(() => {
  const m = window.__lab.agents[0].body.mesh;
  return m.morphTargetInfluences[m.morphTargetDictionary.open] ?? null;
})]);

// 3. The box: picked up, hands on its sides.
await page.evaluate(() => window.__lab.agents[0].clear());
await page.evaluate(() => {
  const { camera } = window.__lab;
  camera.position.set(2.5, 9, 12);
  window.__lab.controls.target.set(2.5, 0, 4.5);
  window.__lab.controls.update();
});
await page.waitForTimeout(300);
const b = await page.evaluate(() => {
  const { camera } = window.__lab;
  const v = camera.position.clone().set(2.5, 0.14, 4.5).project(camera);
  return { x: (v.x * 0.5 + 0.5) * innerWidth, y: (-v.y * 0.5 + 0.5) * innerHeight };
});
await page.mouse.click(b.x, b.y);
await page.waitForSelector('#menu:not([hidden])', { timeout: 5000 }).catch(() => {});
await page.click('#menu button:has-text("Pegar a caixa")').catch((e) => log.push(['no box menu', String(e).slice(0, 80)]));
await page.waitForFunction(() => window.__lab.agents[0].carrying && window.__lab.agents[0].queue.length === 0, null, { timeout: 40_000 }).catch(() => log.push(['box not picked']));
await page.waitForTimeout(800);
log.push(['box', await page.evaluate(() => {
  const a = window.__lab.agents[0];
  return a.carrying ? { scaleX: +a.carrying.scale.x.toFixed(2) } : null;
})]);
await look(0, 'Bip01_Spine2', 1.1, 0.0);
await shot('07-box-front');
await look(0, 'Bip01_Spine2', 0.5, 0.25, 0.8);
await shot('08-box-side');
await look(0, 'Bip01_Spine2', 0.05, 0.05, 1.0);
await shot('09-box-profile');

console.log(JSON.stringify({ log, errors }, null, 1));
await browser.close();
