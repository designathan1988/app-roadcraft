// Brows close up under different card lifts / depth biases, changed live in
// the shader: tells depth fighting (changes with bias) from the strand
// texture's own gaps (does not).
import { mkdirSync } from 'node:fs';
import { chromium } from '@playwright/test';

const out = 'docs/audit/lab-face/brows';
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
await page.goto('http://127.0.0.1:4194/sandbox.html', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__lab && window.__lab.agents.length >= 2, null, { timeout: 120_000 });
await page.waitForTimeout(1500);
const info = await page.evaluate(() => {
  const { agents, camera, controls } = window.__lab;
  const a = agents[0];
  a.body.mesh.morphTargetInfluences.fill(0);
  const p = a.body.boneAt('Bip01_Head', camera.position.clone()).applyMatrix4(a.body.root.matrixWorld);
  camera.position.set(p.x + Math.sin(a.heading) * 0.32, p.y + 0.06, p.z + Math.cos(a.heading) * 0.32);
  controls.minDistance = 0.05; controls.target.copy(p); controls.update();
  const mats = Array.isArray(a.body.mesh.material) ? a.body.mesh.material : [a.body.mesh.material];
  window.__variant = (lift, bias) => {
    for (const m of mats) {
      const base = m.__baseCompile ?? m.onBeforeCompile;
      m.__baseCompile = base;
      m.onBeforeCompile = (shader, r) => {
        base.call(m, shader, r);
        shader.vertexShader = shader.vertexShader
          .replace('normalize(objectNormal) * 0.002', `normalize(objectNormal) * ${lift.toFixed(4)}`)
          .replace('mvPosition.z += 0.004 * bodyScale', `mvPosition.z += ${bias.toFixed(4)} * bodyScale`);
      };
      m.customProgramCacheKey = () => `v${lift}_${bias}`;
      m.needsUpdate = true;
    }
  };
  return { mats: mats.length, alphaTest: mats.map((m) => m.alphaTest), transparent: mats.map((m) => m.transparent) };
});
console.log(JSON.stringify(info));
for (const [lift, bias] of [[0, 0], [0.002, 0.004], [0.004, 0.01], [0.008, 0.03]]) {
  await page.evaluate(([l, b]) => window.__variant(l, b), [lift, bias]);
  await page.waitForTimeout(500);
  await page.evaluate(() => { const m = window.__lab.agents[0].body.mesh; m.morphTargetInfluences.fill(0); });
  await page.screenshot({ path: `${out}/lift${lift}-bias${bias}.png`, clip: { x: 300, y: 230, width: 620, height: 220 } });
}
await browser.close();
