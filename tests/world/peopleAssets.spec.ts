// Structure of the MakeHuman CC0 packs written by scripts/import-makehuman.mjs
// (docs/people-assets.md). Reads the files from public/models/people/.
import { existsSync, readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const DIR = join(__dirname, '..', '..', 'public', 'models', 'people');
const json = <T>(f: string): T => JSON.parse(readFileSync(join(DIR, f), 'utf8')) as T;
const bin = (f: string): ArrayBuffer => {
  const b = readFileSync(join(DIR, f));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
};

interface Section { name: string; type: string; itemSize: number; count: number; byteOffset: number; byteLength: number }
interface BaseMeta {
  vertexCount: number; uvCount: number; faceCount: number; sections: Section[];
  faceGroups: string[]; vertexGroups: Record<string, [number, number][]>;
  zeroedVertices: Record<string, number[]>;
}
interface TargetMeta {
  entryCount: number; maxRelativeQuantError: number;
  layout: { indices: { byteOffset: number; count: number }; deltas: { byteOffset: number; count: number } };
  targets: { name: string; group: string; start: number; count: number; scale: number; maxAbs: number; maxQuantError: number }[];
}
interface Bone { name: string; parent: string | null; head: { strategy: string; cubeName?: string; vertexIndices?: number[] }; tail: Bone['head'] }
interface Skeleton { boneCount: number; bones: Bone[]; weights: { vertexCount: number; layout: { weights: { byteOffset: number } } } }
interface Manifest { source: { sha: string }; assets: { path: string; licence: string; sha: string }[]; skipped: { path: string; reason: string }[] }

const PINNED_SHA = 'afb9f530a7c2741dedb8df0ebae2e0b183caec21';
const base = json<BaseMeta>('base.json');
const baseBuf = bin('base.bin');
const section = (name: string): Section => {
  const s = base.sections.find((x) => x.name === name);
  if (!s) throw new Error(`missing section ${name}`);
  return s;
};

const GAME_ENGINE_BONES = [
  'Root', 'ball_l', 'ball_r', 'calf_l', 'calf_r', 'clavicle_l', 'clavicle_r', 'foot_l', 'foot_r', 'hand_l', 'hand_r',
  'head', 'index_01_l', 'index_01_r', 'index_02_l', 'index_02_r', 'index_03_l', 'index_03_r', 'lowerarm_l',
  'lowerarm_r', 'middle_01_l', 'middle_01_r', 'middle_02_l', 'middle_02_r', 'middle_03_l', 'middle_03_r', 'neck_01',
  'pelvis', 'pinky_01_l', 'pinky_01_r', 'pinky_02_l', 'pinky_02_r', 'pinky_03_l', 'pinky_03_r', 'ring_01_l',
  'ring_01_r', 'ring_02_l', 'ring_02_r', 'ring_03_l', 'ring_03_r', 'spine_01', 'spine_02', 'spine_03', 'thigh_l',
  'thigh_r', 'thumb_01_l', 'thumb_01_r', 'thumb_02_l', 'thumb_02_r', 'thumb_03_l', 'thumb_03_r', 'upperarm_l',
  'upperarm_r',
];

describe('people assets: base mesh', () => {
  it('has the hm08 counts and sections inside the file', () => {
    expect(base.vertexCount).toBe(19158);
    expect(base.uvCount).toBe(21334);
    expect(base.faceCount).toBeGreaterThan(18000);
    for (const s of base.sections) expect(s.byteOffset + s.byteLength).toBeLessThanOrEqual(baseBuf.byteLength);
    expect(section('positions').count).toBe(base.vertexCount);
    expect(section('faceVerts').count).toBe(base.faceCount);
  });

  it('has finite positions and UVs, and faces index inside range', () => {
    const p = section('positions');
    const pos = new Float32Array(baseBuf, p.byteOffset, p.count * 3);
    expect(pos.every(Number.isFinite)).toBe(true);
    const u = section('uvs');
    expect(new Float32Array(baseBuf, u.byteOffset, u.count * 2).every(Number.isFinite)).toBe(true);
    const fv = section('faceVerts');
    const faces = new Uint16Array(baseBuf, fv.byteOffset, fv.count * 4);
    expect(Math.max(...faces)).toBeLessThan(base.vertexCount);
    const fu = section('faceUvs');
    expect(Math.max(...new Uint16Array(baseBuf, fu.byteOffset, fu.count * 4))).toBeLessThan(base.uvCount);
    const fg = section('faceGroup');
    expect(Math.max(...new Uint8Array(baseBuf, fg.byteOffset, fg.count))).toBeLessThan(base.faceGroups.length);
  });

  it('ships no genital helper: no face group, no vertex group, zeroed and unreferenced vertices', () => {
    expect(base.faceGroups.some((g) => g.includes('genital'))).toBe(false);
    expect(Object.keys(base.vertexGroups).some((g) => g.includes('genital'))).toBe(false);
    const zeroed = new Set(base.zeroedVertices['helper-genital']);
    expect(zeroed.size).toBeGreaterThan(0);
    const fv = section('faceVerts');
    const faces = new Uint16Array(baseBuf, fv.byteOffset, fv.count * 4);
    expect(faces.some((v) => zeroed.has(v))).toBe(false);
  });

  it('keeps the joint cubes the skeleton is fitted from', () => {
    expect(base.vertexGroups['joint-pelvis']).toBeDefined();
    expect(base.vertexGroups.body).toBeDefined();
  });
});

interface MacroPca {
  components: number; vertexCount: number; energy: number; residualTolerance: number; maxResidualQuantError: number;
  layout: {
    basis: { byteOffset: number; count: number; scales: number[] };
    coefficients: { byteOffset: number; count: number };
    residualIndices: { byteOffset: number; count: number };
    residualDeltas: { byteOffset: number; count: number };
  };
  targets: { name: string; group: string; row: number; residualStart: number; residualCount: number; residualScale: number }[];
}

describe('people assets: macro targets as principal components', () => {
  const meta = json<MacroPca>('targets-macro-pca.json');
  const buf = bin('targets-macro-pca.bin');
  const K = meta.components;
  const D = meta.vertexCount * 3;
  const basis = new Int16Array(buf, meta.layout.basis.byteOffset, K * D);
  const coeff = new Float32Array(buf, meta.layout.coefficients.byteOffset, meta.layout.coefficients.count);
  const rIdx = new Uint16Array(buf, meta.layout.residualIndices.byteOffset, meta.layout.residualIndices.count);
  const rD = new Int16Array(buf, meta.layout.residualDeltas.byteOffset, meta.layout.residualDeltas.count * 3);

  /** Target `row` as the runtime rebuilds it: basis blend plus its residual. */
  const rebuild = (row: number): Float64Array => {
    const out = new Float64Array(D);
    for (let k = 0; k < K; k++) {
      const c = (coeff[row * K + k] ?? 0) * (meta.layout.basis.scales[k] ?? 0);
      if (c === 0) continue;
      for (let j = 0; j < D; j++) out[j] = (out[j] ?? 0) + c * (basis[k * D + j] ?? 0);
    }
    const t = meta.targets[row]!;
    for (let e = t.residualStart; e < t.residualStart + t.residualCount; e++) {
      const v = rIdx[e]!;
      for (let a = 0; a < 3; a++) out[v * 3 + a] = (out[v * 3 + a] ?? 0) + (rD[e * 3 + a] ?? 0) * t.residualScale;
    }
    return out;
  };

  it('holds all 348 macro targets in a compact basis', () => {
    expect(meta.targets.length).toBe(348);
    expect(meta.targets.every((t) => t.group === 'macrodetails')).toBe(true);
    expect(meta.layout.coefficients.count).toBe(348 * K);
    expect(meta.energy).toBeGreaterThan(0.9999);
    expect(buf.byteLength).toBe(meta.layout.residualDeltas.byteOffset + meta.layout.residualDeltas.count * 6);
    // The plain-delta macro pack was 41 MB.
    expect(buf.byteLength).toBeLessThan(12_000_000);
    for (const c of coeff) expect(Number.isFinite(c)).toBe(true);
  });

  it('never moves the genital helper', () => {
    const zeroed = new Set(base.zeroedVertices['helper-genital']);
    let bad = 0;
    for (const v of rIdx) if (v >= base.vertexCount || zeroed.has(v)) bad++;
    expect(bad).toBe(0);
    for (const row of [0, 100, 347]) {
      const t = rebuild(row);
      let moved = 0;
      for (const v of zeroed) moved += Math.abs(t[v * 3]!) + Math.abs(t[v * 3 + 1]!) + Math.abs(t[v * 3 + 2]!);
      expect(moved).toBeLessThan(1e-3);
    }
  });

  // The source targets are in the importer's cache when it has been run here.
  const SOURCE = join(__dirname, '..', '..', '.cache', 'makehuman', PINNED_SHA, 'repo', 'src', 'mpfb', 'data', 'targets');
  it.runIf(existsSync(SOURCE))('reproduces every sampled source target within half a millimetre', () => {
    for (let row = 0; row < meta.targets.length; row += 29) {
      const t = meta.targets[row]!;
      const text = gunzipSync(readFileSync(join(SOURCE, `${t.name}.target.gz`))).toString('utf8');
      const truth = new Float64Array(D);
      for (const line of text.split(String.fromCharCode(10))) {
        const p = line.trim().split(/\s+/);
        if (p.length < 4 || p[0]!.startsWith('#')) continue;
        const v = Number(p[0]);
        truth[v * 3] = Number(p[1]); truth[v * 3 + 1] = Number(p[2]); truth[v * 3 + 2] = Number(p[3]);
      }
      for (const v of base.zeroedVertices['helper-genital'] ?? []) truth[v * 3] = truth[v * 3 + 1] = truth[v * 3 + 2] = 0;
      const got = rebuild(row);
      let worst = 0;
      for (let v = 0; v < meta.vertexCount; v++) {
        worst = Math.max(worst, Math.hypot(got[v * 3]! - truth[v * 3]!, got[v * 3 + 1]! - truth[v * 3 + 1]!, got[v * 3 + 2]! - truth[v * 3 + 2]!));
      }
      // Decimetres: 0.005 is half a millimetre; the residual's own int16 step on top.
      expect(worst, t.name).toBeLessThan(meta.residualTolerance + 1e-4);
    }
  });
});

describe.each([
  ['targets-local', 700],
])('people assets: %s', (name, minTargets) => {
  const meta = json<TargetMeta>(`${name}.json`);
  const buf = bin(`${name}.bin`);
  const idx = new Uint16Array(buf, meta.layout.indices.byteOffset, meta.entryCount);
  const d = new Int16Array(buf, meta.layout.deltas.byteOffset, meta.entryCount * 3);

  it('has contiguous runs covering every entry', () => {
    expect(meta.targets.length).toBeGreaterThanOrEqual(minTargets);
    let next = 0;
    for (const t of meta.targets) {
      expect(t.start).toBe(next);
      next += t.count;
    }
    expect(next).toBe(meta.entryCount);
    expect(buf.byteLength).toBe(meta.layout.deltas.byteOffset + meta.entryCount * 6);
  });

  it('indexes base vertices only, never the genital helper', () => {
    const zeroed = new Set(base.zeroedVertices['helper-genital']);
    let bad = 0;
    for (const v of idx) if (v >= base.vertexCount || zeroed.has(v)) bad++;
    expect(bad).toBe(0);
    expect(meta.targets.some((t) => t.group === 'genitals' || t.name.includes('genital'))).toBe(false);
  });

  it('decodes finite offsets within each target bound, quantisation below 1e-4 relative', () => {
    let outOfBound = 0;
    for (const t of meta.targets) {
      expect(Number.isFinite(t.scale) && t.scale > 0).toBe(true);
      const bound = t.maxAbs * (1 + 1e-6);
      for (let e = t.start * 3; e < (t.start + t.count) * 3; e++) {
        const q = d[e] ?? 0;
        const v = q * t.scale;
        if (!Number.isFinite(v) || Math.abs(v) > bound || q === -32768) outOfBound++;
      }
      expect(t.maxQuantError).toBeLessThanOrEqual(t.scale / 2 + 1e-9);
    }
    expect(outOfBound).toBe(0);
    expect(meta.maxRelativeQuantError).toBeLessThan(1e-4);
  });
});

describe('people assets: game_engine skeleton and weights', () => {
  const skel = json<Skeleton>('skeleton-game-engine.json');

  it('has the 53 game_engine bones with valid parents and joint references', () => {
    expect(skel.boneCount).toBe(53);
    expect(skel.bones.map((b) => b.name).sort()).toEqual([...GAME_ENGINE_BONES].sort());
    const names = new Set(skel.bones.map((b) => b.name));
    expect(skel.bones.filter((b) => b.parent === null).map((b) => b.name)).toEqual(['Root']);
    for (const b of skel.bones) {
      if (b.parent) expect(names.has(b.parent)).toBe(true);
      for (const end of [b.head, b.tail]) {
        if (end.strategy === 'CUBE') expect(base.vertexGroups[end.cubeName ?? '']).toBeDefined();
        for (const v of end.vertexIndices ?? []) expect(v).toBeLessThan(base.vertexCount);
      }
    }
  });

  it('has top-4 weights summing to 1 for every weighted vertex', () => {
    const buf = bin('weights-game-engine.bin');
    const n = skel.weights.vertexCount;
    expect(n).toBe(base.vertexCount);
    const joints = new Uint8Array(buf, 0, n * 4);
    const w = new Uint16Array(buf, skel.weights.layout.weights.byteOffset, n * 4);
    const zeroed = new Set(base.zeroedVertices['helper-genital']);
    let weighted = 0;
    for (let v = 0; v < n; v++) {
      let raw = 0;
      for (let k = 0; k < 4; k++) raw += w[v * 4 + k] ?? 0;
      const sum = raw / 65535;
      if (sum === 0) {
        expect(zeroed.has(v)).toBe(true);
        continue;
      }
      weighted++;
      expect(Math.abs(sum - 1)).toBeLessThan(1e-3);
      for (let k = 0; k < 4; k++) expect(joints[v * 4 + k]).toBeLessThan(53);
    }
    expect(weighted).toBe(n - zeroed.size);
  });
});

describe('people assets: licence manifest', () => {
  const m = json<Manifest>('LICENSES.json');

  it('pins one MPFB2 commit and lists only CC0 assets', () => {
    expect(m.source.sha).toBe(PINNED_SHA);
    expect(m.assets.length).toBeGreaterThan(1000);
    for (const a of m.assets) {
      expect(a.licence).toBe('CC0-1.0');
      expect(a.sha).toBe(PINNED_SHA);
      expect(a.path).not.toMatch(/genital/);
    }
  });

  it('records what was skipped and why', () => {
    expect(m.skipped.length).toBeGreaterThan(0);
    for (const s of m.skipped) expect(s.reason.length).toBeGreaterThan(0);
    expect(m.skipped.some((s) => s.path.includes('targets/genitals/'))).toBe(true);
  });
});
