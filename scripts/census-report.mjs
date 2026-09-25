/**
 * Checks a runtime census (`inspect-scene.mjs ... census`) against the
 * reviewed manifest: every figure inside the whitelist, every company
 * dressed in mutually compatible wardrobes. Exits 1 on any violation.
 *
 *   node scripts/census-report.mjs <census.json>
 */
import fs from 'node:fs';

const census = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const manifest = JSON.parse(fs.readFileSync(new URL('../src/render/citizens.manifest.json', import.meta.url), 'utf8'));
const allowed = new Set(manifest.models.filter((m) => m.allowedInCrowd === true && m.quality === 'ok').map((m) => m.id));
const PAIRS = [['casual', 'sport-casual'], ['casual', 'smart-casual'], ['business', 'smart-casual']];
const compatible = (a, b) => a === b || PAIRS.some(([x, y]) => (a === x && b === y) || (a === y && b === x));
const outside = census.filter((r) => !allowed.has(r.model));
const groups = new Map();
for (const r of census) {
  if (r.company === 'solo' || r.company === 'bus' || r.company === 'rider') continue;
  const key = `${r.company}:${r.companyId}`;
  if (!groups.has(key)) groups.set(key, new Set());
  groups.get(key).add(r.wardrobe);
}
const mixed = [...groups].filter(([, set]) => [...set].some((a) => [...set].some((b) => !compatible(a, b))));
const byCompany = {};
for (const r of census) byCompany[r.company] = (byCompany[r.company] ?? 0) + 1;
console.log(JSON.stringify({ figures: census.length, outsideWhitelist: outside.length, companies: groups.size,
  mixedCompanies: mixed.length, byCompany, modelsUsed: new Set(census.map((r) => r.model)).size }, null, 1));
for (const r of outside) console.log('OUTSIDE', r.model, r.company, r.companyId);
for (const [key, set] of mixed) console.log('MIXED', key, [...set].join(' + '));
process.exit(outside.length || mixed.length ? 1 : 0);
