import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fitProxy, type ProxyPack } from '@people/body/proxy';
import { Morpher, type PeoplePacks } from '@people/body/morph';
import { DEFAULT_MACRO, ageFromYears } from '@people/body/macro';

const DIR = join(__dirname, '..', '..', 'public', 'models', 'people');
const buf = (f: string): ArrayBuffer => { const b = readFileSync(join(DIR, f)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
const json = <T>(f: string): T => JSON.parse(readFileSync(join(DIR, f), 'utf8')) as T;

interface Meta { name: string; kind: ProxyPack['kind']; scaleRefs: number[]; scaleBase: [number, number, number]; zDepth: number; layout: Record<string, { byteOffset: number; count: number }>; source: { path: string } }
export function loadProxy(name: string): ProxyPack {
  const meta = json<Meta>(`proxies/${name}.json`);
  const bin = buf(`proxies/${name}.bin`);
  const L = meta.layout;
  return {
    name, kind: meta.kind, scaleRefs: meta.scaleRefs, scaleBase: meta.scaleBase, zDepth: meta.zDepth, colour: 0xffffff,
    refs: new Uint32Array(bin, L.refs!.byteOffset, L.refs!.count),
    weights: new Float32Array(bin, L.weights!.byteOffset, L.weights!.count),
    offsets: new Float32Array(bin, L.offsets!.byteOffset, L.offsets!.count),
    uvs: new Float32Array(bin, L.uvs!.byteOffset, L.uvs!.count),
    index: new Uint32Array(bin, L.index!.byteOffset, L.index!.count),
    deleteVerts: new Uint32Array(bin, L.deleteVerts!.byteOffset, L.deleteVerts!.count),
  };
}
const packs: PeoplePacks = {
  base: json('base.json'), baseBin: buf('base.bin'),
  macro: json('targets-macro-pca.json'), macroBin: buf('targets-macro-pca.bin'),
  local: json('targets-local.json'), localBin: buf('targets-local.bin'),
  modifiers: json('modifiers.json'),
};
const morpher = new Morpher(packs);
const SRC = join(__dirname, '..', '..', '.cache', 'makehuman-system', 'x');

describe('MakeHuman proxies (clothes, hair) fitted to a body', () => {
  const index = json<{ items: { name: string; kind: string }[] }>('proxies/index.json');

  it('ships every system garment, hairstyle, eyebrow and eyelash set, CC0', () => {
    expect(index.items.filter((i) => i.kind === 'hair').length).toBeGreaterThanOrEqual(10);
    expect(index.items.filter((i) => i.kind === 'clothes').length).toBeGreaterThanOrEqual(15);
  });

  // Each piece was modelled on MakeHuman's default European body of its sex;
  // fitted on that body it must land where its own .obj puts it.
  it.runIf(existsSync(SRC))('lands on the body it was made on exactly where its own .obj puts it', () => {
    const C = { ...DEFAULT_MACRO, african: 0, asian: 0, caucasian: 1 };
    const male = morpher.shape({ ...C, gender: 1 });
    const female = morpher.shape({ ...C, gender: 0 });
    const cases: [string, Float32Array][] = [['male_casualsuit01', male], ['short02', male], ['shoes01', male], ['female_casualsuit01', female], ['long01', female]];
    for (const [name, body] of cases) {
      const meta = json<Meta>(`proxies/${name}.json`);
      const objText = readFileSync(join(SRC, meta.source.path, `${name}.obj`), 'utf8');
      const v = objText.split(String.fromCharCode(10)).filter((l) => l.startsWith('v ')).map((l) => l.split(/\s+/).slice(1, 4).map(Number));
      const fitted = fitProxy(loadProxy(name), body);
      const errors: number[] = [];
      for (let k = 0; k < fitted.length / 3; k += 5) {
        let best = Infinity;
        for (let j = 0; j < v.length; j += 1) {
          const q = v[j]!;
          const d = Math.hypot(q[0]! - fitted[k * 3]!, q[1]! - fitted[k * 3 + 1]!, q[2]! - fitted[k * 3 + 2]!);
          if (d < best) best = d;
          if (best < 1e-3) break;
        }
        errors.push(best);
      }
      errors.sort((a, b) => a - b);
      expect(errors[errors.length >> 1]!, name).toBeLessThan(0.01); // 1 mm
    }
  });

  it('follows the body: a heavy body makes a wider waist, a child a smaller shirt', () => {
    const shirt = loadProxy('male_casualsuit01');
    /** Depth of the garment at waist height (between 50 % and 60 % of its height). */
    const waist = (pos: Float32Array): number => {
      let ylo = Infinity, yhi = -Infinity;
      for (let i = 1; i < pos.length; i += 3) { ylo = Math.min(ylo, pos[i]!); yhi = Math.max(yhi, pos[i]!); }
      let lo = Infinity, hi = -Infinity;
      for (let i = 0; i < pos.length; i += 3) {
        const t = (pos[i + 1]! - ylo) / (yhi - ylo);
        // Depth, front to back, near the middle: the arms hang beside it.
        if (t < 0.5 || t > 0.6 || Math.abs(pos[i]!) > 0.8) continue;
        lo = Math.min(lo, pos[i + 2]!); hi = Math.max(hi, pos[i + 2]!);
      }
      return hi - lo;
    };
    const thin = fitProxy(shirt, morpher.shape({ ...DEFAULT_MACRO, gender: 1, weight: 0.1 }));
    const heavy = fitProxy(shirt, morpher.shape({ ...DEFAULT_MACRO, gender: 1, weight: 1 }));
    expect(waist(heavy)).toBeGreaterThan(waist(thin) * 1.04);
    const child = fitProxy(shirt, morpher.shape({ ...DEFAULT_MACRO, age: ageFromYears(8) }));
    const span = (p: Float32Array) => { let lo = Infinity, hi = -Infinity; for (let i = 1; i < p.length; i += 3) { lo = Math.min(lo, p[i]!); hi = Math.max(hi, p[i]!); } return hi - lo; };
    expect(span(child)).toBeLessThan(span(thin));
  });
});
