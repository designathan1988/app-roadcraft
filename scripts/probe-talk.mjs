// Mouth while talking in the lab: jaw opening sampled over a conversation.
import { chromium } from '@playwright/test';
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
await page.goto('http://127.0.0.1:4194/sandbox.html', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__lab && window.__lab.agents.length >= 2, null, { timeout: 120_000 });
await page.evaluate(() => { const { camera, controls, agents } = window.__lab; window.__lab.select(agents[0]); const p = agents[1].position; camera.position.set(p.x + 4, 6, p.z + 8); controls.target.set(p.x, 0.8, p.z); controls.update(); });
await page.waitForTimeout(300);
const s = await page.evaluate(() => { const { camera, agents } = window.__lab; const p = agents[1].position; const v = camera.position.clone().set(p.x, 1, p.z).project(camera); return { x: (v.x * 0.5 + 0.5) * innerWidth, y: (-v.y * 0.5 + 0.5) * innerHeight }; });
await page.mouse.click(s.x, s.y);
await page.click('#menu button:has-text("Conversar")');
const jaws = [];
for (let k = 0; k < 80; k++) {
  await page.waitForTimeout(200);
  jaws.push(await page.evaluate(() => window.__lab.agents.map((a) => { const m = a.body.mesh; return +(m.morphTargetInfluences[m.morphTargetDictionary.open] ?? 0).toFixed(2); })));
}
console.log(JSON.stringify({ max0: Math.max(...jaws.map((j) => j[0])), max1: Math.max(...jaws.map((j) => j[1])), opened: jaws.filter((j) => j[0] > 0.05 || j[1] > 0.05).length, of: jaws.length }));
await browser.close();
