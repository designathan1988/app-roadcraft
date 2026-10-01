// Packs MakeHuman's CC0 system clothes, hair, eyebrows and eyelashes for the
// game (docs/people-assets.md, "Proxies"). Reads the pack the asset site
// publishes (makehuman_system_assets_cc0.zip, unzipped into
// .cache/makehuman-system/x) and writes public/models/people/proxies/.
//
// Written from the file formats (.mhclo, .obj, .mhmat); no MakeHuman or MPFB
// code. Textures are resized in the Chrome Playwright already drives, to WebP:
// hair to greyscale with its alpha, so the game can dye it any colour.
//
//   node scripts/import-makehuman-proxies.mjs
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, '.cache', 'makehuman-system', 'x');
const OUT = join(ROOT, 'public', 'models', 'people', 'proxies');
const SOURCE = 'https://files.makehumancommunity.org/asset_packs/makehuman_system_assets/makehuman_system_assets_cc0.zip';

/** What to take, and the texture size each kind gets. */
const KINDS = {
  clothes: { size: 512 },
  hair: { size: 512, grey: true },
  eyebrows: { size: 256, grey: true },
  eyelashes: { size: 256, grey: true },
};

function parseMhclo(text) {
  const out = { verts: [], deleteVerts: [], scale: {}, zDepth: 50, obj: null, material: null, name: null, license: '' };
  let section = null;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('#')) {
      if (/CC0/.test(line)) out.license = 'CC0-1.0';
      continue;
    }
    if (!line) continue;
    const p = line.split(/\s+/);
    if (p[0] === 'verts') { section = 'verts'; continue; }
    if (p[0] === 'delete_verts') { section = 'delete'; continue; }
    if (section === 'verts' && /^-?\d/.test(p[0])) {
      if (p.length === 1) out.verts.push([+p[0], +p[0], +p[0], 1, 0, 0, 0, 0, 0]);
      else out.verts.push(p.slice(0, 9).map(Number));
      continue;
    }
    if (section === 'delete' && /^\d/.test(p[0])) {
      for (let i = 0; i < p.length; i++) {
        if (p[i + 1] === '-') { for (let v = +p[i]; v <= +p[i + 2]; v++) out.deleteVerts.push(v); i += 2; }
        else out.deleteVerts.push(+p[i]);
      }
      continue;
    }
    // Keyword lines may sit inside the verts section (shoes02 lists its
    // material after 'verts 0'): they do not end it.
    if (p[0] === 'x_scale' || p[0] === 'y_scale' || p[0] === 'z_scale') out.scale[p[0][0]] = [+p[1], +p[2], +p[3]];
    else if (p[0] === 'z_depth') out.zDepth = +p[1];
    else if (p[0] === 'obj_file') out.obj = p[1];
    else if (p[0] === 'material') out.material = p[1];
    else if (p[0] === 'name') out.name = p[1];
  }
  return out;
}

/** Vertices, UVs and faces of an .obj; faces as [v, vt] corner lists. */
function parseObj(text) {
  const v = [], vt = [], faces = [];
  for (const raw of text.split('\n')) {
    const p = raw.trim().split(/\s+/);
    if (p[0] === 'v') v.push([+p[1], +p[2], +p[3]]);
    else if (p[0] === 'vt') vt.push([+p[1], +p[2]]);
    else if (p[0] === 'f') faces.push(p.slice(1).map((c) => { const [a, b] = c.split('/'); return [+a - 1, b ? +b - 1 : -1]; }));
  }
  return { v, vt, faces };
}

function parseMhmat(text) {
  const m = {};
  for (const raw of text.split('\n')) {
    const p = raw.trim().split(/\s+/);
    if (p[0] === 'diffuseTexture') m.diffuse = p[1];
    if (p[0] === 'transparent') m.transparent = p[1] === 'True';
    if (p[0] === 'backfaceCull') m.backfaceCull = p[1] === 'True';
  }
  return m;
}

function pack(kind, dir, name) {
  const mhclo = parseMhclo(readFileSync(join(dir, `${name}.mhclo`), 'utf8'));
  const obj = parseObj(readFileSync(join(dir, mhclo.obj ?? `${name}.obj`), 'utf8'));
  if (obj.v.length !== mhclo.verts.length) throw new Error(`${name}: ${obj.v.length} obj vertices, ${mhclo.verts.length} fitted`);
  const mat = mhclo.material && existsSync(join(dir, mhclo.material)) ? parseMhmat(readFileSync(join(dir, mhclo.material), 'utf8')) : {};
  // One output vertex per (position, uv) pair: UV seams split.
  const key = new Map();
  const refs = [], weights = [], offsets = [], uvs = [], index = [];
  const vertexOf = (vi, ti) => {
    const k = `${vi}/${ti}`;
    let at = key.get(k);
    if (at !== undefined) return at;
    at = refs.length / 3;
    const f = mhclo.verts[vi];
    refs.push(f[0], f[1], f[2]);
    weights.push(f[3], f[4], f[5]);
    offsets.push(f[6], f[7], f[8]);
    const uv = ti >= 0 ? obj.vt[ti] : [0, 0];
    uvs.push(uv[0], 1 - uv[1]);
    key.set(k, at);
    return at;
  };
  for (const face of obj.faces) {
    const c = face.map(([vi, ti]) => vertexOf(vi, ti));
    for (let k = 1; k + 1 < c.length; k++) index.push(c[0], c[k], c[k + 1]);
  }
  const s = mhclo.scale;
  const scaleRefs = [s.x[0], s.x[1], s.y[0], s.y[1], s.z[0], s.z[1]];
  const scaleBase = [s.x[2], s.y[2], s.z[2]];
  const n = refs.length / 3;
  const layout = {};
  const parts = [];
  let offset = 0;
  const add = (label, arr) => {
    layout[label] = { byteOffset: offset, count: arr.length };
    parts.push(Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength));
    offset += arr.byteLength;
  };
  add('refs', Uint32Array.from(refs));
  add('weights', Float32Array.from(weights));
  add('offsets', Float32Array.from(offsets));
  add('uvs', Float32Array.from(uvs));
  add('index', Uint32Array.from(index));
  add('deleteVerts', Uint32Array.from(mhclo.deleteVerts));
  return {
    meta: {
      format: 'roadcraft-people-proxy/1', name, kind, vertexCount: n, triangleCount: index.length / 3,
      scaleRefs, scaleBase, zDepth: mhclo.zDepth, transparent: !!mat.transparent, doubleSided: mat.backfaceCull === false,
      layout, texture: mat.diffuse ? `${name}.webp` : null, license: mhclo.license || 'CC0-1.0',
      source: { pack: SOURCE, path: `${kind}/${name}` },
    },
    bin: Buffer.concat(parts),
    diffuse: mat.diffuse ? join(dir, mat.diffuse) : null,
  };
}

async function main() {
  if (!existsSync(SRC)) throw new Error(`unzip the pack into ${SRC} first`);
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ channel: 'chrome' });
  const page = await browser.newPage();
  const index = [];
  let bytes = 0;
  for (const [kind, opts] of Object.entries(KINDS)) {
    const base = join(SRC, kind);
    if (!existsSync(base)) continue;
    for (const name of readdirSync(base).sort()) {
      const dir = join(base, name);
      if (!statSync(dir).isDirectory() || !existsSync(join(dir, `${name}.mhclo`))) continue;
      const { meta, bin, diffuse } = pack(kind, dir, name);
      writeFileSync(join(OUT, `${name}.bin`), bin);
      if (diffuse) {
        const png = readFileSync(diffuse).toString('base64');
        const data = await page.evaluate(async ({ png, size, grey }) => {
          const img = new Image();
          img.src = `data:image/png;base64,${png}`;
          await img.decode();
          const c = document.createElement('canvas');
          c.width = c.height = size;
          const g = c.getContext('2d');
          g.drawImage(img, 0, 0, size, size);
          if (grey) {
            const d = g.getImageData(0, 0, size, size);
            for (let i = 0; i < d.data.length; i += 4) {
              const l = 0.299 * d.data[i] + 0.587 * d.data[i + 1] + 0.114 * d.data[i + 2];
              d.data[i] = d.data[i + 1] = d.data[i + 2] = l;
            }
            g.putImageData(d, 0, 0);
          }
          return c.toDataURL('image/webp', 0.86).split(',')[1];
        }, { png, size: opts.size, grey: !!opts.grey });
        writeFileSync(join(OUT, `${name}.webp`), Buffer.from(data, 'base64'));
        bytes += Buffer.from(data, 'base64').length;
      }
      writeFileSync(join(OUT, `${name}.json`), JSON.stringify(meta));
      bytes += bin.length;
      index.push({ name, kind, vertices: meta.vertexCount, triangles: meta.triangleCount, license: meta.license });
      console.log(`${kind.padEnd(10)} ${name.padEnd(22)} ${String(meta.vertexCount).padStart(6)} v ${String(meta.triangleCount).padStart(6)} t`);
    }
  }
  // Eyes: the high-poly eyeball, and each iris colour as its own texture.
  const resize = (file, size, grey = false) => page.evaluate(async ({ png, size, grey }) => {
    const img = new Image();
    img.src = `data:image/png;base64,${png}`;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const g = c.getContext('2d');
    g.drawImage(img, 0, 0, size, size);
    const d = g.getImageData(0, 0, size, size);
    let r = 0, gg = 0, b = 0, n = 0;
    for (let i = 0; i < d.data.length; i += 4) {
      if (d.data[i + 3] < 200) continue;
      r += d.data[i]; gg += d.data[i + 1]; b += d.data[i + 2]; n++;
    }
    if (grey) {
      for (let i = 0; i < d.data.length; i += 4) {
        const l = 0.299 * d.data[i] + 0.587 * d.data[i + 1] + 0.114 * d.data[i + 2];
        d.data[i] = d.data[i + 1] = d.data[i + 2] = l;
      }
      g.putImageData(d, 0, 0);
    }
    return { data: c.toDataURL('image/webp', 0.88).split(',')[1], average: n ? [r / n, gg / n, b / n].map(Math.round) : [255, 255, 255] };
  }, { png: readFileSync(file).toString('base64'), size, grey });

  const eyeDir = join(SRC, 'eyes', 'high-poly');
  if (existsSync(eyeDir)) {
    const { meta, bin } = pack('eyes', eyeDir, 'high-poly');
    const irises = [];
    const mats = join(SRC, 'eyes', 'materials');
    for (const f of readdirSync(mats).filter((x) => x.endsWith('_eye.png')).sort()) {
      const name = f.replace('_eye.png', '');
      const { data, average } = await resize(join(mats, f), 256);
      writeFileSync(join(OUT, `eye-${name}.webp`), Buffer.from(data, 'base64'));
      bytes += Buffer.from(data, 'base64').length;
      irises.push({ name, average });
    }
    meta.texture = null;
    meta.irises = irises;
    writeFileSync(join(OUT, 'eyes.bin'), bin);
    writeFileSync(join(OUT, 'eyes.json'), JSON.stringify({ ...meta, name: 'eyes' }));
    index.push({ name: 'eyes', kind: 'eyes', vertices: meta.vertexCount, triangles: meta.triangleCount, license: meta.license, irises: irises.map((i) => i.name) });
    console.log(`eyes       high-poly ${meta.vertexCount} v, ${irises.length} iris colours`);
  }

  // Skins: one texture per age, origin and sex (not the toon or the 'special suit' ones).
  const skins = [];
  const skinOut = join(ROOT, 'public', 'models', 'people', 'skins');
  rmSync(skinOut, { recursive: true, force: true });
  mkdirSync(skinOut, { recursive: true });
  for (const name of readdirSync(join(SRC, 'skins')).sort()) {
    const m = /^(young|middleage|old)_(african|asian|caucasian)_(female|male)(2?)$/.exec(name);
    if (!m) continue;
    const dir = join(SRC, 'skins', name);
    const mat = parseMhmat(readFileSync(join(dir, `${name}.mhmat`), 'utf8'));
    const { data, average } = await resize(join(dir, mat.diffuse), 1024);
    writeFileSync(join(skinOut, `${name}.webp`), Buffer.from(data, 'base64'));
    bytes += Buffer.from(data, 'base64').length;
    skins.push({ name, age: m[1], origin: m[2], sex: m[3], variant: m[4] ? 2 : 1, average });
    console.log(`skin       ${name.padEnd(28)} average ${average.join(',')}`);
  }
  writeFileSync(join(skinOut, 'index.json'), JSON.stringify({ format: 'roadcraft-people-skins/1', source: SOURCE, license: 'CC0-1.0', skins }, null, 1));

  await browser.close();
  writeFileSync(join(OUT, 'index.json'), JSON.stringify({
    format: 'roadcraft-people-proxies/2',
    source: SOURCE,
    license: 'CC0-1.0 (MakeHuman system assets; each .mhclo states its CC0 release)',
    items: index,
  }, null, 1));
  console.log(`${index.length} proxies, ${(bytes / 1048576).toFixed(1)} MB`);
}

main().catch((e) => { console.error(e); process.exit(1); });
