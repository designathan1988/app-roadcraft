// Who holds the big typed arrays: every typed array of 64 KB or more made on
// the page is recorded with the first frame of the game's own code that made
// it, and dropped again when it is collected; after the town has settled the
// live bytes are summed by that frame. Headless on the GPU.
import { chromium } from '@playwright/test';

const base = (process.argv.find((a) => a.startsWith('--base=')) ?? '--base=http://127.0.0.1:4197').slice(7);
const settle = Number((process.argv.find((a) => a.startsWith('--settle=')) ?? '--settle=60000').slice(9));
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-precise-memory-info'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
await page.addInitScript(() => {
  window.confirm = () => true;
  Error.stackTraceLimit = 60;
  const live = new Map();
  let next = 0;
  const registry = new FinalizationRegistry((id) => live.delete(id));
  const MIN = 65536;
  const site = () => {
    const lines = (new Error().stack ?? '').split('\n').slice(2);
    const own = lines.find((l) => /index-|assets\/[a-z]/i.test(l) && !/three-/.test(l)) ?? lines.find((l) => /three-/.test(l)) ?? lines[0] ?? '?';
    const three = lines.find((l) => /three-/.test(l));
    return `${own.trim()}${three && three !== own ? '  <- ' + three.trim() : ''}`;
  };
  for (const name of ['Float32Array', 'Float64Array', 'Uint8Array', 'Uint16Array', 'Uint32Array', 'Int16Array', 'Int32Array', 'Int8Array', 'Uint8ClampedArray']) {
    const Native = globalThis[name];
    const Wrapped = new Proxy(Native, {
      construct(target, args, newTarget) {
        const array = Reflect.construct(target, args, newTarget);
        // Only arrays that own a new buffer of their own, big enough to matter.
        if (array.byteLength >= MIN && !(args[0] instanceof ArrayBuffer)) {
          const id = next++;
          const st = site();
          live.set(id, { bytes: array.byteLength, site: st });
          if (/32672/.test(st) && (window.__morphLog ??= []).length < 6) window.__morphLog.push({ lod: (() => { let l = '?'; try { window.__roadcraft.scene().scene.traverse((o) => { if (o.userData?.lod !== undefined) l = o.userData.lod; }); } catch { /* not ready */ } return l; })(), zoom: window.__roadcraft?.camera?.zoom, t: Math.round(performance.now()), mb: Math.round(array.byteLength / 1048576), stack: (new Error().stack ?? '').split(String.fromCharCode(10)).slice(2, 60).filter((l) => /index-/.test(l)).slice(0, 10).map((l) => l.trim().replace(/http:[^ ]*assets\//, '')).join(' | ') });
          registry.register(array.buffer, id);
        }
        return array;
      },
    });
    globalThis[name] = Wrapped;
  }
  const NativeBuffer = ArrayBuffer;
  globalThis.ArrayBuffer = new Proxy(NativeBuffer, {
    construct(target, args, newTarget) {
      const buffer = Reflect.construct(target, args, newTarget);
      if (buffer.byteLength >= MIN) {
        const id = next++;
        live.set(id, { bytes: buffer.byteLength, site: 'ArrayBuffer ' + site() });
        registry.register(buffer, id);
      }
      return buffer;
    },
  });
  window.__liveArrays = () => {
    const by = new Map();
    let total = 0;
    for (const { bytes, site } of live.values()) { by.set(site, (by.get(site) ?? 0) + bytes); total += bytes; }
    return { totalMB: Math.round(total / 1048576), top: [...by].sort((a, b) => b[1] - a[1]).slice(0, 30).map(([s, b]) => [Math.round(b / 1048576), s]) };
  };
});
await page.goto(base, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => Boolean(window.__roadcraft), null, { timeout: 180_000 });
await page.evaluate(() => {
  window.__seen = [];
  const t0 = performance.now();
  const tick = () => {
    const r = window.__roadcraft; const sc = r?.scene?.()?.scene;
    if (sc) sc.traverse((o) => {
      if (o.geometry?.morphAttributes?.position && o.visible && window.__seen.length < 10) {
        const path = []; let p = o; while (p) { path.push(p.name || p.type); p = p.parent; }
        const key = path.join('<');
        if (!window.__seen.some((x) => x.key === key)) window.__seen.push({ key, t: Math.round(performance.now()), count: o.count, cast: o.castShadow, lod: o.parent?.userData?.lod });
      }
    });
    if (performance.now() - t0 < 30000) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
});
await page.waitForTimeout(settle);
console.log('SEEN', JSON.stringify(await page.evaluate(() => window.__seen), null, 1));
const cdp = await page.context().newCDPSession(page);
await cdp.send('HeapProfiler.collectGarbage');
await page.waitForTimeout(2000);
await cdp.send('HeapProfiler.collectGarbage');
console.log(JSON.stringify(await page.evaluate(() => {
  const sc = window.__roadcraft.scene().scene; const out = { lods: new Set(), morphMeshes: 0, meshes: 0, morphVisible: 0, names: [] };
  sc.traverse((o) => { if (o.userData?.lod !== undefined) out.lods.add(o.userData.lod); if (o.isInstancedMesh && o.name.startsWith('citizen')) { out.meshes++; if (o.geometry.morphAttributes.position) { out.morphMeshes++; if (o.visible && o.count > 0) { out.morphVisible++; if (out.names.length < 6) out.names.push(o.name + ' count ' + o.count); } } } });
  return { ...out, lods: [...out.lods] };
})));
console.log(JSON.stringify(await page.evaluate(() => {
  const out = []; const sc = window.__roadcraft.scene().scene;
  sc.traverse((o) => { if (o.geometry?.morphAttributes?.position && out.length < 12) { const path = []; let p = o; while (p) { path.push(p.name || p.type); p = p.parent; } out.push({ path: path.reverse().join(' > '), type: o.type, visible: o.visible, cast: o.castShadow, count: o.count }); } });
  return out;
}), null, 1));
const result = await page.evaluate(() => ({ heapMB: Math.round(performance.memory.usedJSHeapSize / 1048576), ...window.__liveArrays() }));
console.log('heap', result.heapMB, 'MB; live typed arrays tracked', result.totalMB, 'MB');
for (const [mb, s] of result.top) console.log(`${String(mb).padStart(6)} MB  ${s}`);
await browser.close();
