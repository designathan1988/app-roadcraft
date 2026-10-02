/* global Image, document */
// Adds the curated MakeHuman COMMUNITY skins (skins01 women, skins02 men) to
// public/models/people/skins next to the system ones, with their age, origin,
// sex and whether the face wears make-up. Downloaded packs are read from
// .cache/makehuman-community/<pack>.zip; the zip is unpacked with Python.
//
//   node scripts/import-makehuman-skins.mjs
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = join(ROOT, '.cache', 'makehuman-community');
const OUT = join(ROOT, 'public', 'models', 'people', 'skins');

/** The chosen skins: lively, ordinary faces (no tattoos, goth or nude-body skins). */
const CHOSEN = {
  toigo_light_skin_with_natural_makeup: { sex: 'female', origin: 'caucasian', age: 'young', makeup: true },
  toigo_light_skin_with_makeup: { sex: 'female', origin: 'caucasian', age: 'young', makeup: true },
  toigo_light_skin_female_bronze_with_makeup: { sex: 'female', origin: 'caucasian', age: 'young', makeup: true },
  toigo_light_skin_female_ginger_with_makeup: { sex: 'female', origin: 'caucasian', age: 'young', makeup: true },
  toigo_light_skin_female_with_violet_makeup: { sex: 'female', origin: 'caucasian', age: 'young', makeup: true },
  toigo_light_skin_female_freckles: { sex: 'female', origin: 'caucasian', age: 'young', makeup: false },
  toigo_light_skin_female_bronze: { sex: 'female', origin: 'caucasian', age: 'young', makeup: false },
  darthfurby_caucasian_female: { sex: 'female', origin: 'caucasian', age: 'middleage', makeup: false },
  callharvey3d_midtoned_female: { sex: 'female', origin: 'african', age: 'young', makeup: false },
  cutoff3d_indian_female_enhanced: { sex: 'female', origin: 'asian', age: 'young', makeup: true },
  onlytheghosts_young_eurasian_female: { sex: 'female', origin: 'asian', age: 'young', makeup: false },
  onlytheghosts_middle_aged_eurasian_female: { sex: 'female', origin: 'asian', age: 'middleage', makeup: false },
  onlytheghosts_old_eurasian_female: { sex: 'female', origin: 'asian', age: 'old', makeup: false },
  toigo_light_skin_male_freckles: { sex: 'male', origin: 'caucasian', age: 'young', makeup: false },
  toigo_light_skin_male_bronze: { sex: 'male', origin: 'caucasian', age: 'young', makeup: false },
  toigo_light_skin_male_ginger: { sex: 'male', origin: 'caucasian', age: 'young', makeup: false },
  mindfront_aksel_skin: { sex: 'male', origin: 'caucasian', age: 'middleage', makeup: false },
  mindfront_skin_male_african_middleage: { sex: 'male', origin: 'african', age: 'middleage', makeup: false },
  onlytheghosts_old_eurasian_male: { sex: 'male', origin: 'asian', age: 'old', makeup: false },
};

function unpack(name) {
  const dir = join(CACHE, 'x', name);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
    execFileSync('python', ['-c', 'import sys, zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])', join(CACHE, `${name}.zip`), dir]);
  }
  return join(dir, 'skins');
}

const diffuseOf = (mhmat) => /^diffuseTexture\s+(\S+)/m.exec(mhmat)?.[1] ?? null;
const meta = (text, key) => new RegExp(`^#\\s*${key}\\s+(.*)$`, 'im').exec(text)?.[1]?.trim() ?? '';

async function main() {
  const browser = await chromium.launch({ channel: 'chrome' });
  const page = await browser.newPage();
  const index = JSON.parse(readFileSync(join(OUT, 'index.json'), 'utf8'));
  index.skins = index.skins.filter((s) => !s.community);
  for (const pack of ['skins01', 'skins02']) {
    const base = unpack(pack);
    for (const name of readdirSync(base)) {
      const chosen = CHOSEN[name];
      if (!chosen) continue;
      const mhmat = readFileSync(join(base, name, `${name}.mhmat`), 'utf8');
      const diffuse = diffuseOf(mhmat);
      if (!diffuse) { console.log(`${name}: no diffuse texture`); continue; }
      const file = join(base, name, diffuse);
      const mime = /\.jpe?g$/i.test(file) ? 'image/jpeg' : 'image/png';
      const { data, average } = await page.evaluate(async ({ raw, mime }) => {
        const img = new Image();
        img.src = `data:${mime};base64,${raw}`;
        await img.decode();
        const c = document.createElement('canvas');
        c.width = c.height = 1024;
        const g = c.getContext('2d');
        g.drawImage(img, 0, 0, 1024, 1024);
        const d = g.getImageData(0, 0, 1024, 1024);
        let r = 0, gg = 0, b = 0, n = 0;
        for (let i = 0; i < d.data.length; i += 16) {
          if (d.data[i + 3] < 200) continue;
          r += d.data[i]; gg += d.data[i + 1]; b += d.data[i + 2]; n++;
        }
        return { data: c.toDataURL('image/webp', 0.88).split(',')[1], average: [r / n, gg / n, b / n].map(Math.round) };
      }, { raw: readFileSync(file).toString('base64'), mime });
      writeFileSync(join(OUT, `${name}.webp`), Buffer.from(data, 'base64'));
      index.skins.push({ name, ...chosen, variant: 1, average, community: true,
        license: meta(mhmat, 'license') || 'unstated', author: meta(mhmat, 'author') || 'unknown' });
      console.log(`skin ${name.padEnd(48)} ${chosen.sex} ${chosen.origin} ${chosen.age} makeup=${chosen.makeup}`);
    }
  }
  await browser.close();
  writeFileSync(join(OUT, 'index.json'), JSON.stringify(index, null, 1));
}

main().catch((e) => { console.error(e); process.exit(1); });
