/**
 * Measures how far a seated person reaches from their pelvis in the car-seat
 * poses (`src/render/riderPoses.ts`), over every adult body of the roster, and
 * writes the worst case to docs/audit/seated-pose-extents.json, which
 * `tests/render/occupantFit.spec.ts` checks the body models against.
 *
 *   npm run dev            # in another terminal
 *   node scripts/measure-seated-poses.mjs [http://localhost:5173/]
 */
import { chromium } from '@playwright/test';
import fs from 'node:fs';
const browser = await chromium.launch({
  ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}), headless: true,
});
const page = await browser.newPage();
await page.goto(process.argv[2] ?? 'http://localhost:5173/');
await page.waitForFunction('Boolean(window.__roadcraft)', null, { timeout: 60000 });
const out = await page.evaluate(async () => {
  const THREE = await import('/node_modules/.vite/deps/three.js');
  const { GLTFLoader } = await import('/node_modules/.vite/deps/three_addons_loaders_GLTFLoader__js.js');
  const { clone } = await import('/node_modules/.vite/deps/three_addons_utils_SkeletonUtils__js.js');
  const { CITIZEN_ASSET_URLS } = await import('/src/render/citizenAssets.ts');
  const { CITIZEN_MODELS } = await import('/src/render/citizenCatalog.ts');
  const { RIDER_CLIPS } = await import('/src/render/riderPoses.ts');
  const res = {};
  const ids = CITIZEN_MODELS.map(m => m.id ?? m).filter(id => !String(id).includes('child'));
  for (const id of ids) {
    const gltf = await new GLTFLoader().loadAsync(CITIZEN_ASSET_URLS[id]);
    for (const clip of RIDER_CLIPS) {
      if (!clip.key.startsWith('car')) continue;
      const rig = clone(gltf.scene); rig.updateMatrixWorld(true);
      clip.pose(rig, 0); rig.updateMatrixWorld(true);
      const pelvis = rig.getObjectByName('Bip01_Pelvis').getWorldPosition(new THREE.Vector3());
      const box = new THREE.Box3(); const v = new THREE.Vector3();
      rig.traverse(o => { if (o.isSkinnedMesh) { o.skeleton.update(); const pos = o.geometry.attributes.position; for (let k = 0; k < pos.count; k += 3) { o.getVertexPosition(k, v); o.localToWorld(v); box.expandByPoint(v); } } });
      const r = { top: box.max.y - pelvis.y, bottom: box.min.y - pelvis.y, fwd: box.max.z - pelvis.z, back: pelvis.z - box.min.z, half: Math.max(box.max.x - pelvis.x, pelvis.x - box.min.x) };
      const prev = res[clip.key] ?? { top: 0, bottom: 0, fwd: 0, back: 0, half: 0, worst: {} };
      for (const k of ['top', 'fwd', 'back', 'half']) if (r[k] > prev[k]) { prev[k] = r[k]; prev.worst[k] = id; }
      if (r.bottom < prev.bottom) { prev.bottom = r.bottom; prev.worst.bottom = id; }
      res[clip.key] = prev;
    }
  }
  res.bodies = ids.length;
  return res;
});
fs.mkdirSync('docs/audit', { recursive: true });
fs.writeFileSync('docs/audit/seated-pose-extents.json', JSON.stringify(out, (k, v) => typeof v === 'number' ? +v.toFixed(3) : v, 2) + '\n');
console.log(JSON.stringify(out));
await browser.close();
