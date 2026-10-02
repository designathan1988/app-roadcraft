/* global Image, document */
// Packs the MakeHuman COMMUNITY asset packs (hair, clothes, shoes, hats,
// glasses, jewellery, beards, brows, lashes) for the game, next to the system
// items `import-makehuman-proxies.mjs` writes. Reads the packs downloaded to
// .cache/makehuman-community/<pack>.zip (from
// https://files.makehumancommunity.org/asset_packs/<pack>/<pack>_cc0.zip).
//
// Every item states its own licence in its .mhclo; ALL items are imported
// (player's decision) and each keeps its licence and author in its json
// and in community.json, for the credits. Fantasy items (masks, horns,
// helmets) are for the Person Creator, never put on a passer-by.
//
// Only the items in src/people/wardrobeSelection.json (the curated choice,
// edited in the wardrobe catalogue) are written; --all writes every item.
// community.json always lists every item, for the catalogue.
//
//   node scripts/import-makehuman-community.mjs [--all]
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';
import { pack } from './import-makehuman-proxies.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = join(ROOT, '.cache', 'makehuman-community');
const UNPACKED = join(CACHE, 'x');
const OUT = join(ROOT, 'public', 'models', 'people', 'proxies');
const SITE = 'https://files.makehumancommunity.org/asset_packs';
const ALL = process.argv.includes('--all');
const SELECTED = new Set(JSON.parse(readFileSync(join(ROOT, 'src', 'people', 'wardrobeSelection.json'), 'utf8')).names);

/**
 * What each pack holds: the kind of item, the texture size, whether the
 * texture is made grey so the game can dye it, and whether ordinary people in
 * the street may wear it.
 */
const PACKS = {
  hair01: { kind: 'hair', size: 512, grey: true },
  hair02: { kind: 'hair', size: 512, grey: true },
  hair03: { kind: 'hair', size: 512, grey: true },
  eyebrows01: { kind: 'eyebrows', size: 256, grey: true },
  eyelashes01: { kind: 'eyelashes', size: 256, grey: true },
  bodyparts05: { kind: 'beard', size: 512, grey: true },
  shirts01: { kind: 'top', size: 512 },
  shirts02: { kind: 'top', size: 512 },
  shirts03: { kind: 'top', size: 512 },
  pants01: { kind: 'bottom', size: 512 },
  pants02: { kind: 'bottom', size: 512 },
  pants03: { kind: 'bottom', size: 512 },
  skirts01: { kind: 'skirt', size: 512 },
  skirts02: { kind: 'skirt', size: 512 },
  dress01: { kind: 'dress', size: 512 },
  dress02: { kind: 'dress', size: 512 },
  dress03: { kind: 'dress', size: 512 },
  suits01: { kind: 'suit', size: 512 },
  suits02: { kind: 'suit', size: 512 },
  suits03: { kind: 'suit', size: 512 },
  suits04: { kind: 'suit', size: 512 },
  suits05: { kind: 'suit', size: 512 },
  shoes01: { kind: 'shoes', size: 256 },
  shoes02: { kind: 'shoes', size: 256 },
  shoes03: { kind: 'shoes', size: 256 },
  hats01: { kind: 'hat', size: 256 },
  glasses01: { kind: 'glasses', size: 256 },
  gloves01: { kind: 'gloves', size: 256 },
  jewelry01: { kind: 'jewelry', size: 256 },
  hats02: { kind: 'helmet', size: 256, street: false },
  masks01: { kind: 'mask', size: 256, street: false },
  bodyparts01: { kind: 'horns', size: 256, street: false },
};

/** The item's licence as its .mhclo states it, normalised and recorded (every item is imported: player's decision). */
function licence(text) {
  const line = /^#\s*licen[sc]e\s+(.*)$/im.exec(text)?.[1]?.trim() ?? '';
  if (!line) return 'unstated';
  if (/agpl/i.test(line)) return 'AGPL-3.0';
  if (/cc[\s_-]*0|zero|public domain/i.test(line)) return 'CC0-1.0';
  if (/cc[\s_-]*by/i.test(line)) return /3\.0/.test(line) ? 'CC-BY-3.0' : 'CC-BY-4.0';
  return line.slice(0, 40);
}

const author = (text) => /^#\s*author\s+(.*)$/im.exec(text)?.[1]?.trim() ?? 'unknown';
const tags = (text) => [...text.matchAll(/^tag\s+(.+)$/gim)].map((m) => m[1].trim().toLowerCase());

function unpack(name) {
  const dir = join(UNPACKED, name);
  if (existsSync(dir)) return dir;
  mkdirSync(dir, { recursive: true });
  // Python's zipfile: the tar on PATH may be GNU tar, which reads `C:` as a host.
  execFileSync('python', ['-c', 'import sys, zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])', join(CACHE, `${name}.zip`), dir]);
  return dir;
}

/** Item folders (a folder holding `<folder>.mhclo`), anywhere in a pack. */
function items(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (!statSync(path).isDirectory()) continue;
    if (existsSync(join(path, `${entry}.mhclo`))) out.push({ dir: path, name: entry });
    else out.push(...items(path));
  }
  return out;
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ channel: 'chrome' });
  const page = await browser.newPage();
  const taken = [];
  const skipped = [];
  let bytes = 0;
  for (const [packName, opts] of Object.entries(PACKS)) {
    if (!existsSync(join(CACHE, `${packName}.zip`))) { console.log(`${packName}: not downloaded`); continue; }
    const dir = unpack(packName);
    for (const { dir: itemDir, name } of items(dir).sort((a, b) => a.name.localeCompare(b.name))) {
      const text = readFileSync(join(itemDir, `${name}.mhclo`), 'utf8');
      const license = licence(text);
      if (existsSync(join(OUT, `${name}.json`)) && !taken.some((t) => t.name === name)) {
        const old = JSON.parse(readFileSync(join(OUT, `${name}.json`), 'utf8'));
        if (!old.community) { skipped.push({ name, pack: packName, why: 'name taken by a system item' }); continue; }
      }
      let packed;
      try {
        packed = pack(opts.kind, itemDir, name, `${SITE}/${packName}/${packName}_cc0.zip`);
      } catch (e) {
        skipped.push({ name, pack: packName, why: String(e.message ?? e) });
        continue;
      }
      const { meta, bin, diffuse } = packed;
      let texture = null;
      if (diffuse && existsSync(diffuse)) {
        try {
          const raw = readFileSync(diffuse).toString('base64');
          const mime = /\.jpe?g$/i.test(diffuse) ? 'image/jpeg' : 'image/png';
          const data = await page.evaluate(async ({ raw, mime, size, grey }) => {
            const img = new Image();
            img.src = `data:${mime};base64,${raw}`;
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
            return { webp: c.toDataURL('image/webp', 0.84).split(',')[1], average: n ? [r / n, gg / n, b / n].map(Math.round) : null };
          }, { raw, mime, size: opts.size, grey: !!opts.grey });
          if (ALL || SELECTED.has(name)) writeFileSync(join(OUT, `${name}.webp`), Buffer.from(data.webp, 'base64'));
          bytes += Buffer.from(data.webp, 'base64').length;
          texture = { file: `${name}.webp`, average: data.average };
        } catch (e) {
          skipped.push({ name, pack: packName, why: `texture: ${e.message ?? e}` });
          continue;
        }
      }
      const out = {
        ...meta,
        kind: opts.kind,
        texture: texture?.file ?? null,
        average: texture?.average ?? null,
        license,
        author: author(text),
        tags: tags(text),
        street: opts.street !== false,
        community: true,
      };
      if (ALL || SELECTED.has(name)) {
        writeFileSync(join(OUT, `${name}.bin`), bin);
        writeFileSync(join(OUT, `${name}.json`), JSON.stringify(out));
      }
      bytes += bin.length;
      taken.push({ name, kind: opts.kind, pack: packName, license, author: out.author, tags: out.tags, street: out.street,
        vertices: meta.vertexCount, triangles: meta.triangleCount });
      console.log(`${opts.kind.padEnd(9)} ${name.padEnd(48)} ${license.padEnd(9)} ${String(meta.triangleCount).padStart(6)} t`);
    }
  }
  await browser.close();
  writeFileSync(join(OUT, 'community.json'), JSON.stringify({
    format: 'roadcraft-people-community/1',
    note: 'MakeHuman community asset packs; each item keeps the licence its .mhclo states. CC-BY items are credited in the About panel.',
    items: taken,
    skipped,
  }, null, 1));
  console.log(`${taken.length} community items taken, ${skipped.length} left out, ${(bytes / 1048576).toFixed(1)} MB`);
}

main().catch((e) => { console.error(e); process.exit(1); });
