// Packs the MakeHuman community's ARKit face units (faceunits01: the 52
// blendshapes of Apple's ARKit face tracking, sculpted on the MakeHuman base
// mesh, CC0) for the game: public/models/people/faceunits.{bin,json}, in the
// same compact form as expressions.{bin,json} (`src/people/body/expressions.ts`).
//
// Reads .cache/makehuman-community/faceunits01.zip (from
// https://files.makehumancommunity.org/functional/faceunits01.zip).
//
//   node scripts/import-faceunits.mjs
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ZIP = join(ROOT, '.cache', 'makehuman-community', 'faceunits01.zip');
const DIR = join(ROOT, '.cache', 'makehuman-community', 'x', 'faceunits01');
const OUT = join(ROOT, 'public', 'models', 'people');
const SOURCE = 'https://files.makehumancommunity.org/functional/faceunits01.zip';

if (!existsSync(DIR)) {
  mkdirSync(DIR, { recursive: true });
  execFileSync('python', ['-c', 'import sys, zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])', ZIP, DIR]);
}
const base = JSON.parse(readFileSync(join(OUT, 'base.json'), 'utf8'));
const vertexCount = base.vertexCount;
const unitsDir = join(DIR, 'targets', 'faceunits');
const targets = readdirSync(unitsDir).filter((f) => f.endsWith('.target')).sort().map((file) => {
  const idx = [], d = [];
  for (const raw of readFileSync(join(unitsDir, file), 'utf8').split('\n')) {
    const p = raw.trim().split(/\s+/);
    if (p.length < 4 || p[0].startsWith('#')) continue;
    const v = +p[0];
    if (!(v >= 0 && v < vertexCount)) throw new Error(`${file}: vertex ${v} out of the base mesh`);
    idx.push(v);
    d.push(+p[1], +p[2], +p[3]);
  }
  return { name: file.replace(/\.target$/, ''), idx, d };
});

const total = targets.reduce((n, t) => n + t.idx.length, 0);
const deltaOffset = Math.ceil((total * 2) / 4) * 4;
const buf = Buffer.alloc(deltaOffset + total * 6);
const indices = new Uint16Array(buf.buffer, buf.byteOffset, total);
const deltas = new Int16Array(buf.buffer, buf.byteOffset + deltaOffset, total * 3);
const index = [];
let at = 0, worst = 0;
for (const t of targets) {
  const maxAbs = t.d.reduce((m, x) => Math.max(m, Math.abs(x)), 0) || 1e-9;
  const scale = maxAbs / 32767;
  for (let i = 0; i < t.idx.length; i++) {
    indices[at + i] = t.idx[i];
    for (let k = 0; k < 3; k++) {
      const q = Math.round(t.d[i * 3 + k] / scale);
      deltas[(at + i) * 3 + k] = q;
      worst = Math.max(worst, Math.abs(q * scale - t.d[i * 3 + k]));
    }
  }
  index.push({ name: t.name, start: at, count: t.idx.length, scale, maxAbs });
  at += t.idx.length;
}
writeFileSync(join(OUT, 'faceunits.bin'), buf);
writeFileSync(join(OUT, 'faceunits.json'), JSON.stringify({
  format: 'roadcraft-faceunits/1', source: SOURCE, author: 'Mika Suominen', licence: 'CC0-1.0',
  units: 'decimetres; delta = int16 * scale', vertexCount, entryCount: total, deltaOffset, targets: index,
}));
console.log(`face units: ${index.length} targets, ${total} entries, ${buf.length} bytes, max error ${worst.toExponential(2)} dm`);
