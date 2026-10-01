#!/usr/bin/env node
/* global fetch, setTimeout */
// Build-time importer for the MakeHuman CC0 assets (Person model, step H0).
//
// Fetches asset DATA ONLY from the MPFB2 repository at a pinned commit and
// packs it into compact binary files under public/models/people/. No MakeHuman,
// MPFB2 or makehuman.js code is used or ported: every parser here is written
// from the plain file formats (Wavefront OBJ, MakeHuman ".target" text files,
// MPFB rig / weight JSON). See docs/people-assets.md for the output layout.
//
// Usage: node scripts/import-makehuman.mjs [--offline]
//   --offline  use only the download cache (.cache/makehuman/<sha>/)

import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';

// ---------------------------------------------------------------------------
// Pinned source
// ---------------------------------------------------------------------------

export const MPFB2_REPO = 'makehumancommunity/mpfb2';
/** MPFB2 master on 2026-09-29 ("Merge pull request #444"). Change deliberately. */
export const MPFB2_SHA = 'afb9f530a7c2741dedb8df0ebae2e0b183caec21';
const DATA = 'src/mpfb/data/';
const RAW = `https://raw.githubusercontent.com/${MPFB2_REPO}/${MPFB2_SHA}/`;
const TREE_API = `https://api.github.com/repos/${MPFB2_REPO}/git/trees/${MPFB2_SHA}?recursive=1`;

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = join(ROOT, '.cache', 'makehuman', MPFB2_SHA);
const OUT = join(ROOT, 'public', 'models', 'people');
const OFFLINE = process.argv.includes('--offline');

// The repository-level licence (LICENSE.md, section C) puts every asset --
// "base mesh and proxies, targets and modifiers, textures, clothes, rigs,
// poses and expressions, JSON data with mesh information" -- under CC0 1.0;
// the base mesh and the weight files also carry the CC0 statement themselves.
const LICENCE = {
  id: 'CC0-1.0',
  author: 'MakeHuman Team / Data Collection AB (www.makehumancommunity.org)',
  statement: `${RAW}LICENSE.md (section C) and ${RAW}LICENSE.ASSETS.md`,
};

// Excluded on content grounds (not licence): the genital helper and targets.
const GENITAL_GROUP = 'helper-genital';
const EXCLUDED_TARGET_DIRS = new Map([
  ['genitals', 'genital targets are not shipped (project rule)'],
  ['expression', 'facial expression units are animation data, not body shape; out of H0 scope'],
  ['_images', 'slider icons (UI images), not needed by the game'],
]);
const EXCLUDED_TEXTURES = new Map([
  ['mpfb_genitals.jpg', 'genital texture is not shipped (project rule)'],
  ['notfound.thumb', 'editor placeholder thumbnail'],
]);
const MAX_TEXTURE_PX = 1024;
/** Deltas smaller than this (decimetres, every axis) are dropped from the sparse packs. */
const ZERO_EPS = 1e-6;

// ---------------------------------------------------------------------------
// Download with cache
// ---------------------------------------------------------------------------

let downloadedBytes = 0;
let cachedBytes = 0;

async function fetchWithRetry(url, tries = 4) {
  for (let i = 0; ; i++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'roadcraft-import-makehuman' } });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return Buffer.from(await res.arrayBuffer());
    } catch (err) {
      if (i + 1 >= tries) throw err;
      await new Promise((r) => setTimeout(r, 500 * 2 ** i));
    }
  }
}

async function cached(relPath, url) {
  const file = join(CACHE, relPath);
  if (existsSync(file)) {
    const buf = await readFile(file);
    cachedBytes += buf.length;
    return buf;
  }
  if (OFFLINE) throw new Error(`--offline and not cached: ${relPath}`);
  const buf = await fetchWithRetry(url);
  downloadedBytes += buf.length;
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, buf);
  return buf;
}

/** Repository file at the pinned SHA; `.gz` files are returned decompressed. */
async function repoFile(path) {
  const buf = await cached(join('repo', path), RAW + path);
  return path.endsWith('.gz') ? gunzipSync(buf) : buf;
}

async function repoTree() {
  const buf = await cached('tree.json', TREE_API);
  const tree = JSON.parse(buf.toString('utf8'));
  if (tree.truncated) throw new Error('GitHub tree listing truncated');
  return tree.tree.filter((e) => e.type === 'blob');
}

/** Runs `fn` over `items` with bounded concurrency (keeps the network and disk calm). */
async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// ---------------------------------------------------------------------------
// Parsers (written from the file formats)
// ---------------------------------------------------------------------------

/** Wavefront OBJ: v, vt, g, f (quads or triangles, "v/vt" or "v/vt/vn"). */
function parseObj(text) {
  const positions = [];
  const uvs = [];
  const faces = []; // { v: [..], t: [..], group }
  const groups = [];
  const groupIndex = new Map();
  let group = 0;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line[0] === '#') continue;
    const parts = line.split(/\s+/);
    switch (parts[0]) {
      case 'v':
        positions.push(+parts[1], +parts[2], +parts[3]);
        break;
      case 'vt':
        uvs.push(+parts[1], +parts[2]);
        break;
      case 'g': {
        const name = parts.slice(1).join(' ');
        if (!groupIndex.has(name)) {
          groupIndex.set(name, groups.length);
          groups.push(name);
        }
        group = groupIndex.get(name);
        break;
      }
      case 'f': {
        const v = [];
        const t = [];
        for (const corner of parts.slice(1)) {
          const [vi, ti] = corner.split('/');
          v.push(+vi - 1);
          t.push(ti ? +ti - 1 : -1);
        }
        faces.push({ v, t, group });
        break;
      }
      default:
        break;
    }
  }
  return { positions, uvs, faces, groups };
}

/** MakeHuman target: one "index dx dy dz" line per moved vertex; "#" comments. */
function parseTarget(text) {
  const idx = [];
  const d = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line[0] === '#') continue;
    const p = line.split(/\s+/);
    if (p.length < 4) continue;
    idx.push(+p[0]);
    d.push(+p[1], +p[2], +p[3]);
  }
  return { idx, d };
}

/** Vertex-group JSON: name -> list of inclusive [first, last] ranges. */
function expandRanges(ranges) {
  const out = [];
  for (const [a, b] of ranges) for (let i = a; i <= b; i++) out.push(i);
  return out;
}

/** Width/height of a JPEG (SOFn marker) or PNG (IHDR). */
function imageSize(buf) {
  if (buf[0] === 0x89 && buf.toString('ascii', 1, 4) === 'PNG') {
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  }
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let o = 2;
    while (o < buf.length) {
      if (buf[o] !== 0xff) { o++; continue; }
      const marker = buf[o + 1];
      const len = buf.readUInt16BE(o + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { h: buf.readUInt16BE(o + 5), w: buf.readUInt16BE(o + 7) };
      }
      o += 2 + len;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Sparse target packing
// ---------------------------------------------------------------------------

/**
 * Packs targets into one file: [uint16 vertex index x N][pad to 4][int16 dx,dy,dz x N].
 * Each target is a contiguous run [start, start+count) with its own scale
 * (decimetres per int16 step, = maxAbs / 32767).
 */
function packTargets(list, dropVertex) {
  const entries = [];
  let total = 0;
  let worstErr = 0;
  let worstRel = 0;
  for (const t of list) {
    const keep = [];
    let maxAbs = 0;
    for (let i = 0; i < t.idx.length; i++) {
      const vi = t.idx[i];
      if (dropVertex(vi)) continue;
      const dx = t.d[i * 3], dy = t.d[i * 3 + 1], dz = t.d[i * 3 + 2];
      if (Math.abs(dx) < ZERO_EPS && Math.abs(dy) < ZERO_EPS && Math.abs(dz) < ZERO_EPS) continue;
      keep.push(i);
      maxAbs = Math.max(maxAbs, Math.abs(dx), Math.abs(dy), Math.abs(dz));
    }
    entries.push({ t, keep, maxAbs, start: total });
    total += keep.length;
  }
  const idxBytes = total * 2;
  const deltaOffset = (idxBytes + 3) & ~3;
  const buf = Buffer.alloc(deltaOffset + total * 6);
  const index = [];
  for (const { t, keep, maxAbs, start } of entries) {
    const scale = maxAbs > 0 ? maxAbs / 32767 : 1;
    let err = 0;
    keep.forEach((i, k) => {
      const e = start + k;
      buf.writeUInt16LE(t.idx[i], e * 2);
      for (let a = 0; a < 3; a++) {
        const v = t.d[i * 3 + a];
        const q = Math.max(-32767, Math.min(32767, Math.round(v / scale)));
        buf.writeInt16LE(q, deltaOffset + (e * 3 + a) * 2);
        err = Math.max(err, Math.abs(q * scale - v));
      }
    });
    worstErr = Math.max(worstErr, err);
    if (maxAbs > 0) worstRel = Math.max(worstRel, err / maxAbs);
    index.push({
      name: t.name,
      group: t.group,
      start,
      count: keep.length,
      scale,
      maxAbs,
      maxQuantError: err,
    });
  }
  return { buf, index, total, deltaOffset, worstErr, worstRel };
}


/**
 * The macro targets as a principal-component basis plus a sparse residual.
 *
 * The 348 macrodetails targets are DENSE (each moves ~19 000 vertices) and
 * are all combinations of a handful of factors - sex, age, muscle, weight,
 * ethnicity, height, proportions - so as plain deltas they were 41 MB, 83 %
 * of the pack. Decomposed (uncentred, through the 348 x 348 Gram matrix and
 * Jacobi), `MACRO_COMPONENTS` basis shapes carry 99.9998 % of their energy.
 * What is left above `MACRO_RESIDUAL` on any vertex is stored per target as a
 * sparse correction, computed against the QUANTISED basis, so every target is
 * reproduced within that tolerance (plus the residual's own int16 step).
 *
 * Target i = sum_k coeff[i][k] * basis[k] + residual[i]. A blend of targets
 * with weights w is sum_k (sum_i w_i coeff[i][k]) * basis[k] + sum_i w_i
 * residual[i]: one pass over the basis, whatever the blend.
 */
const MACRO_COMPONENTS = 64;
/** Decimetres: half a millimetre. */
const MACRO_RESIDUAL = 0.005;

function jacobiEigen(G) {
  const n = G.length;
  const A = G.map((r) => Float64Array.from(r));
  const V = Array.from({ length: n }, (_, i) => {
    const r = new Float64Array(n);
    r[i] = 1;
    return r;
  });
  for (let sweep = 0; sweep < 40; sweep++) {
    let off = 0;
    let diag = 0;
    for (let p = 0; p < n; p++) {
      diag += A[p][p] * A[p][p];
      for (let q = p + 1; q < n; q++) off += A[p][q] * A[p][q];
    }
    if (off <= diag * 1e-24) break;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) {
      const apq = A[p][q];
      if (apq === 0) continue;
      const theta = (A[q][q] - A[p][p]) / (2 * apq);
      const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1);
      const s = t * c;
      for (let k = 0; k < n; k++) {
        const akp = A[k][p], akq = A[k][q];
        A[k][p] = c * akp - s * akq;
        A[k][q] = s * akp + c * akq;
      }
      for (let k = 0; k < n; k++) {
        const apk = A[p][k], aqk = A[q][k];
        A[p][k] = c * apk - s * aqk;
        A[q][k] = s * apk + c * aqk;
      }
      for (let k = 0; k < n; k++) {
        const vkp = V[k][p], vkq = V[k][q];
        V[k][p] = c * vkp - s * vkq;
        V[k][q] = s * vkp + c * vkq;
      }
    }
  }
  return A.map((r, i) => ({ value: r[i], vector: V.map((row) => row[i]) })).sort((a, b) => b.value - a.value);
}

function packMacroPca(list, nv, dropVertex) {
  const D = nv * 3;
  const X = list.map((t) => {
    const row = new Float64Array(D);
    for (let i = 0; i < t.idx.length; i++) {
      const vi = t.idx[i];
      if (dropVertex(vi)) continue;
      row[vi * 3] = t.d[i * 3];
      row[vi * 3 + 1] = t.d[i * 3 + 1];
      row[vi * 3 + 2] = t.d[i * 3 + 2];
    }
    return row;
  });
  const n = X.length;
  const G = Array.from({ length: n }, () => new Float64Array(n));
  for (let i = 0; i < n; i++) for (let j = i; j < n; j++) {
    let s = 0;
    const a = X[i], b = X[j];
    for (let k = 0; k < D; k++) s += a[k] * b[k];
    G[i][j] = G[j][i] = s;
  }
  const eig = jacobiEigen(G);
  const total = eig.reduce((s, e) => s + Math.max(0, e.value), 0);
  const K = Math.min(MACRO_COMPONENTS, n);
  const comps = eig.slice(0, K);
  const energy = comps.reduce((s, e) => s + Math.max(0, e.value), 0) / total;

  // Basis C_k = sum_i U_ik X_i, quantised to int16 per component.
  const basisScale = [];
  const basisQ = comps.map((e) => {
    const b = new Float64Array(D);
    for (let i = 0; i < n; i++) {
      const u = e.vector[i];
      if (u === 0) continue;
      const x = X[i];
      for (let k = 0; k < D; k++) b[k] += u * x[k];
    }
    let maxAbs = 0;
    for (let k = 0; k < D; k++) maxAbs = Math.max(maxAbs, Math.abs(b[k]));
    const scale = maxAbs > 0 ? maxAbs / 32767 : 1;
    basisScale.push(scale);
    const q = new Int16Array(D);
    for (let k = 0; k < D; k++) q[k] = Math.max(-32767, Math.min(32767, Math.round(b[k] / scale)));
    return q;
  });
  const coeff = new Float32Array(n * K);
  for (let i = 0; i < n; i++) for (let k = 0; k < K; k++) coeff[i * K + k] = comps[k].vector[i];

  // Residual against the reconstruction the runtime will actually compute.
  const residuals = [];
  let residualTotal = 0;
  let worstAfter = 0;
  const rec = new Float64Array(D);
  for (let i = 0; i < n; i++) {
    rec.fill(0);
    for (let k = 0; k < K; k++) {
      const c = coeff[i * K + k] * basisScale[k];
      if (c === 0) continue;
      const q = basisQ[k];
      for (let j = 0; j < D; j++) rec[j] += c * q[j];
    }
    const idx = [];
    const d = [];
    let maxAbs = 0;
    for (let v = 0; v < nv; v++) {
      const dx = X[i][v * 3] - rec[v * 3];
      const dy = X[i][v * 3 + 1] - rec[v * 3 + 1];
      const dz = X[i][v * 3 + 2] - rec[v * 3 + 2];
      if (Math.hypot(dx, dy, dz) <= MACRO_RESIDUAL) continue;
      idx.push(v);
      d.push(dx, dy, dz);
      maxAbs = Math.max(maxAbs, Math.abs(dx), Math.abs(dy), Math.abs(dz));
    }
    const scale = maxAbs > 0 ? maxAbs / 32767 : 1;
    residuals.push({ name: list[i].name, idx, d, scale, start: residualTotal });
    residualTotal += idx.length;
    // What is left after the residual's own quantisation.
    for (let e = 0; e < idx.length; e++) {
      for (let a = 0; a < 3; a++) {
        const v = d[e * 3 + a];
        worstAfter = Math.max(worstAfter, Math.abs(Math.round(v / scale) * scale - v));
      }
    }
  }

  // Layout: basis int16 [K][D] | coeff float32 [n][K] | residual uint16 idx | pad | residual int16 [3].
  const basisBytes = K * D * 2;
  const coeffOffset = (basisBytes + 3) & ~3;
  const residIdxOffset = coeffOffset + n * K * 4;
  const residDeltaOffset = (residIdxOffset + residualTotal * 2 + 3) & ~3;
  const buf = Buffer.alloc(residDeltaOffset + residualTotal * 6);
  for (let k = 0; k < K; k++) {
    const q = basisQ[k];
    for (let j = 0; j < D; j++) buf.writeInt16LE(q[j], (k * D + j) * 2);
  }
  for (let i = 0; i < n * K; i++) buf.writeFloatLE(coeff[i], coeffOffset + i * 4);
  for (const r of residuals) {
    for (let e = 0; e < r.idx.length; e++) {
      const at = r.start + e;
      buf.writeUInt16LE(r.idx[e], residIdxOffset + at * 2);
      for (let a = 0; a < 3; a++) {
        buf.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(r.d[e * 3 + a] / r.scale))), residDeltaOffset + (at * 3 + a) * 2);
      }
    }
  }
  return {
    buf,
    json: {
      components: K,
      vertexCount: nv,
      energy,
      residualTolerance: MACRO_RESIDUAL,
      maxResidualQuantError: worstAfter,
      layout: {
        basis: { type: 'int16', byteOffset: 0, count: K * D, scales: basisScale },
        coefficients: { type: 'float32', byteOffset: coeffOffset, count: n * K },
        residualIndices: { type: 'uint16', byteOffset: residIdxOffset, count: residualTotal },
        residualDeltas: { type: 'int16', itemSize: 3, byteOffset: residDeltaOffset, count: residualTotal },
      },
      targets: residuals.map((r, i) => ({ name: r.name, group: list[i].group, row: i, residualStart: r.start, residualCount: r.idx.length, residualScale: r.scale })),
    },
    energy,
    residualTotal,
    worstAfter,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const t0 = Date.now();
  const tree = await repoTree();
  const inData = tree.filter((e) => e.path.startsWith(DATA));
  const licences = []; // { path, licence, author, source, sha, output }
  const skipped = []; // { path, reason }
  const addLicence = (path, output) =>
    licences.push({ path, licence: LICENCE.id, author: LICENCE.author, source: RAW + path, sha: MPFB2_SHA, output });

  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });

  // --- vertex groups ---------------------------------------------------------
  const vgPath = `${DATA}mesh_metadata/basemesh_vertex_groups.json`;
  const vertexGroups = JSON.parse((await repoFile(vgPath)).toString('utf8'));
  addLicence(vgPath, 'base.json');
  const genital = new Set(expandRanges(vertexGroups[GENITAL_GROUP] ?? []));
  const dropVertex = (vi) => genital.has(vi);

  // --- base mesh -------------------------------------------------------------
  const objPath = `${DATA}3dobjs/base.obj`;
  const objText = (await repoFile(objPath)).toString('utf8');
  if (!/CC0/.test(objText.slice(0, 2000))) throw new Error('base.obj lost its CC0 header');
  addLicence(objPath, 'base.bin');
  const obj = parseObj(objText);
  const nv = obj.positions.length / 3;
  const nuv = obj.uvs.length / 2;
  if (nv > 65535 || nuv > 65535) throw new Error('uint16 indices no longer fit');
  const genitalGroupId = obj.groups.indexOf(GENITAL_GROUP);
  const faces = obj.faces.filter((f) => f.group !== genitalGroupId);
  const droppedFaces = obj.faces.length - faces.length;
  // Genital helper vertices keep their slot (all packs share the hm08 index
  // space) but their position is zeroed and no face, target or weight uses them.
  const positions = Float32Array.from(obj.positions);
  for (const vi of genital) positions.fill(0, vi * 3, vi * 3 + 3);
  const uvs = Float32Array.from(obj.uvs);
  const faceVerts = new Uint16Array(faces.length * 4);
  const faceUvs = new Uint16Array(faces.length * 4);
  const faceGroup = new Uint8Array(faces.length);
  const faceGroupNames = obj.groups.filter((g) => g !== GENITAL_GROUP);
  const groupRemap = obj.groups.map((g) => faceGroupNames.indexOf(g));
  if (faceGroupNames.length > 255) throw new Error('too many face groups for uint8');
  faces.forEach((f, i) => {
    for (let k = 0; k < 4; k++) {
      // Triangles repeat their last corner (none exist in hm08, all faces are quads).
      const c = k < f.v.length ? k : f.v.length - 1;
      faceVerts[i * 4 + k] = f.v[c];
      faceUvs[i * 4 + k] = f.t[c] < 0 ? 0 : f.t[c];
    }
    faceGroup[i] = groupRemap[f.group];
  });
  const sections = [];
  const parts = [];
  let off = 0;
  const addSection = (name, arr, type, itemSize) => {
    const bytes = Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
    sections.push({ name, type, itemSize, count: arr.length / itemSize, byteOffset: off, byteLength: bytes.length });
    parts.push(bytes);
    off += bytes.length;
    const pad = (4 - (off % 4)) % 4;
    if (pad) { parts.push(Buffer.alloc(pad)); off += pad; }
  };
  addSection('positions', positions, 'float32', 3);
  addSection('uvs', uvs, 'float32', 2);
  addSection('faceVerts', faceVerts, 'uint16', 4);
  addSection('faceUvs', faceUvs, 'uint16', 4);
  addSection('faceGroup', faceGroup, 'uint8', 1);
  await writeFile(join(OUT, 'base.bin'), Buffer.concat(parts));
  const faceGroupCounts = {};
  for (const f of faces) faceGroupCounts[obj.groups[f.group]] = (faceGroupCounts[obj.groups[f.group]] ?? 0) + 1;
  const outGroups = {};
  for (const [name, ranges] of Object.entries(vertexGroups)) {
    if (name === GENITAL_GROUP) continue;
    outGroups[name] = ranges;
  }
  const cfgPath = `${DATA}mesh_metadata/hm08_config.json`;
  const hm08Config = JSON.parse((await repoFile(cfgPath)).toString('utf8'));
  addLicence(cfgPath, 'base.json');
  await writeFile(
    join(OUT, 'base.json'),
    JSON.stringify({
      format: 'roadcraft-people-base/1',
      mesh: 'hm08',
      source: { repo: MPFB2_REPO, sha: MPFB2_SHA, path: objPath },
      units: 'decimetres, +Y up, +Z forward (raw OBJ frame)',
      vertexCount: nv,
      uvCount: nuv,
      faceCount: faces.length,
      droppedFaces: { [GENITAL_GROUP]: droppedFaces },
      zeroedVertices: { [GENITAL_GROUP]: [...genital].sort((a, b) => a - b) },
      sections,
      faceGroups: faceGroupNames,
      faceGroupCounts,
      vertexGroups: outGroups,
      measurementVertices: hm08Config.dimensions ?? null,
    }),
  );

  // --- targets ---------------------------------------------------------------
  const targetFiles = inData.filter((e) => e.path.startsWith(`${DATA}targets/`) && e.path.endsWith('.target.gz'));
  const macroList = [];
  const localList = [];
  for (const e of targetFiles) {
    const rel = e.path.slice(`${DATA}targets/`.length);
    const dir = rel.split('/')[0];
    if (EXCLUDED_TARGET_DIRS.has(dir)) {
      skipped.push({ path: e.path, reason: EXCLUDED_TARGET_DIRS.get(dir) });
      continue;
    }
    const name = rel.replace(/\.target\.gz$/, '');
    (dir === 'macrodetails' ? macroList : localList).push({ path: e.path, name, group: dir });
  }
  for (const e of inData.filter((x) => x.path.startsWith(`${DATA}targets/_images/`))) {
    if (!skipped.some((s) => s.path === e.path)) skipped.push({ path: e.path, reason: EXCLUDED_TARGET_DIRS.get('_images') });
  }
  const load = async (list) =>
    pool(list, 8, async (t) => {
      const parsed = parseTarget((await repoFile(t.path)).toString('utf8'));
      for (const vi of parsed.idx) if (vi < 0 || vi >= nv) throw new Error(`${t.path}: vertex ${vi} out of range`);
      return { ...t, source: t.path, ...parsed };
    });
  const writeTargets = async (list, base, label) => {
    const parsed = await load(list);
    const packed = packTargets(parsed, dropVertex);
    await writeFile(join(OUT, `${base}.bin`), packed.buf);
    await writeFile(
      join(OUT, `${base}.json`),
      JSON.stringify({
        format: 'roadcraft-people-targets/1',
        kind: label,
        source: { repo: MPFB2_REPO, sha: MPFB2_SHA },
        units: 'decimetres (base.bin frame); delta = int16 * scale',
        layout: {
          indices: { type: 'uint16', byteOffset: 0, count: packed.total },
          deltas: { type: 'int16', itemSize: 3, byteOffset: packed.deltaOffset, count: packed.total },
        },
        entryCount: packed.total,
        maxQuantError: packed.worstErr,
        maxRelativeQuantError: packed.worstRel,
        targets: packed.index,
      }),
    );
    for (const t of parsed) addLicence(t.path, `${base}.bin`);
    return packed;
  };
  // The macro targets go as a principal-component pack (see `packMacroPca`).
  const macroParsed = await load(macroList);
  const macro = packMacroPca(macroParsed, nv, dropVertex);
  await writeFile(join(OUT, 'targets-macro-pca.bin'), macro.buf);
  await writeFile(
    join(OUT, 'targets-macro-pca.json'),
    JSON.stringify({
      format: 'roadcraft-people-macro-pca/1',
      kind: 'macrodetails',
      source: { repo: MPFB2_REPO, sha: MPFB2_SHA },
      units: 'decimetres (base.bin frame); basis = int16 * scales[k]; residual = int16 * residualScale',
      ...macro.json,
    }),
  );
  for (const t of macroParsed) addLicence(t.path, 'targets-macro-pca.bin');
  const local = await writeTargets(localList, 'targets-local', 'regional');

  // Modifier definitions (which targets pair into which slider).
  const modPath = `${DATA}targets/target.json`;
  const modifiers = JSON.parse((await repoFile(modPath)).toString('utf8'));
  for (const k of Object.keys(modifiers)) if (EXCLUDED_TARGET_DIRS.has(k)) delete modifiers[k];
  const macroDefPath = `${DATA}targets/macrodetails/macro.json`;
  const macroDef = JSON.parse((await repoFile(macroDefPath)).toString('utf8'));
  await writeFile(join(OUT, 'modifiers.json'), JSON.stringify({ source: { repo: MPFB2_REPO, sha: MPFB2_SHA }, macro: macroDef, regional: modifiers }));
  addLicence(modPath, 'modifiers.json');
  addLicence(macroDefPath, 'modifiers.json');

  // --- skeleton + weights ------------------------------------------------------
  const rigPath = `${DATA}rigs/standard/rig.game_engine.json`;
  const rig = JSON.parse((await repoFile(rigPath)).toString('utf8'));
  addLicence(rigPath, 'skeleton-game-engine.json');
  const boneNames = Object.keys(rig);
  const bones = boneNames.map((name) => {
    const b = rig[name];
    const end = (e) => {
      const o = { strategy: e.strategy, defaultPosition: e.default_position };
      if (e.cube_name) o.cubeName = e.cube_name;
      if (e.vertex_indices) o.vertexIndices = e.vertex_indices;
      if (e.vertex_index !== undefined) o.vertexIndex = e.vertex_index;
      if (e.offset) o.offset = e.offset;
      return o;
    };
    return {
      name,
      parent: b.parent || null,
      head: end(b.head),
      tail: end(b.tail),
      roll: b.roll ?? 0,
      connect: !!b.use_connect,
      inheritRotation: b.use_inherit_rotation !== false,
      inheritScale: b.inherit_scale ?? 'FULL',
    };
  });
  for (const b of bones) if (b.parent && !rig[b.parent]) throw new Error(`bone ${b.name}: unknown parent ${b.parent}`);
  await writeFile(
    join(OUT, 'skeleton-game-engine.json'),
    JSON.stringify({
      format: 'roadcraft-people-skeleton/1',
      rig: 'game_engine',
      source: { repo: MPFB2_REPO, sha: MPFB2_SHA, path: rigPath },
      units: 'defaultPosition: metres, Blender frame (+Z up, -Y forward); cube/vertex references index base.bin',
      strategies: {
        CUBE: 'mean of the vertices of the joint cube vertex group named cubeName (base.json vertexGroups)',
        MEAN: 'mean of the base-mesh vertices vertexIndices',
        VERTEX: 'the base-mesh vertex vertexIndex',
        XYZ: 'x, y, z taken from three different vertices (vertexIndices)',
      },
      boneCount: bones.length,
      bones,
    }),
  );

  const wPath = `${DATA}rigs/standard/weights.game_engine.json`;
  const wJson = JSON.parse((await repoFile(wPath)).toString('utf8'));
  if (!/CC0/i.test(String(wJson.license))) throw new Error('weights licence is not CC0');
  addLicence(wPath, 'weights-game-engine.bin');
  const perVertex = Array.from({ length: nv }, () => []);
  Object.entries(wJson.weights ?? {}).forEach(([bone, list]) => {
    const bi = boneNames.indexOf(bone);
    if (bi < 0) throw new Error(`weights reference unknown bone ${bone}`);
    for (const [vi, w] of list) if (!dropVertex(vi) && w > 0) perVertex[vi].push([bi, w]);
  });
  const joints = new Uint8Array(nv * 4);
  const weights = new Uint16Array(nv * 4);
  let unweighted = 0;
  let truncated = 0;
  perVertex.forEach((list, vi) => {
    if (!list.length) { unweighted++; return; }
    list.sort((a, b) => b[1] - a[1]);
    if (list.length > 4) truncated++;
    const top = list.slice(0, 4);
    const sum = top.reduce((s, [, w]) => s + w, 0);
    let acc = 0;
    top.forEach(([bi, w], k) => {
      joints[vi * 4 + k] = bi;
      const q = Math.round((w / sum) * 65535);
      weights[vi * 4 + k] = q;
      acc += q;
    });
    weights[vi * 4] += 65535 - acc; // rounding goes to the dominant joint; sums are exact
  });
  const wBuf = Buffer.concat([Buffer.from(joints.buffer), Buffer.from(weights.buffer)]);
  await writeFile(join(OUT, 'weights-game-engine.bin'), wBuf);
  const skelMeta = JSON.parse(await readFile(join(OUT, 'skeleton-game-engine.json'), 'utf8'));
  skelMeta.weights = {
    file: 'weights-game-engine.bin',
    vertexCount: nv,
    layout: {
      joints: { type: 'uint8', itemSize: 4, byteOffset: 0, note: 'bone index into bones[]' },
      weights: { type: 'uint16', itemSize: 4, byteOffset: nv * 4, note: 'normalised: w / 65535; each weighted vertex sums to exactly 65535' },
    },
    unweightedVertices: unweighted,
    verticesWithMoreThan4Influences: truncated,
  };
  await writeFile(join(OUT, 'skeleton-game-engine.json'), JSON.stringify(skelMeta));

  // --- textures ----------------------------------------------------------------
  const textures = [];
  await mkdir(join(OUT, 'textures'), { recursive: true });
  for (const e of inData.filter((x) => x.path.startsWith(`${DATA}textures/`))) {
    const file = e.path.split('/').pop();
    if (EXCLUDED_TEXTURES.has(file)) { skipped.push({ path: e.path, reason: EXCLUDED_TEXTURES.get(file) }); continue; }
    const buf = await repoFile(e.path);
    const size = imageSize(buf);
    if (!size) { skipped.push({ path: e.path, reason: 'not a JPEG/PNG image' }); continue; }
    if (size.w > MAX_TEXTURE_PX || size.h > MAX_TEXTURE_PX) {
      skipped.push({ path: e.path, reason: `${size.w}x${size.h} exceeds ${MAX_TEXTURE_PX} px (no resampler without new dependencies)` });
      continue;
    }
    await writeFile(join(OUT, 'textures', file), buf);
    textures.push({ file: `textures/${file}`, width: size.w, height: size.h, bytes: buf.length });
    addLicence(e.path, `textures/${file}`);
  }

  // --- proxies (clothes, hair, eyebrows, eyelashes) ------------------------------
  const proxyFiles = inData.filter((e) => /\.(mhclo|proxy|mhmat)$/.test(e.path));
  await mkdir(join(OUT, 'proxies'), { recursive: true });
  await writeFile(
    join(OUT, 'proxies', 'index.json'),
    JSON.stringify(
      {
        format: 'roadcraft-people-proxies/1',
        source: { repo: MPFB2_REPO, sha: MPFB2_SHA },
        items: [],
        note:
          proxyFiles.length === 0
            ? 'MPFB2 ships no clothes, hair, eyebrow, eyelash or proxy (.mhclo/.proxy/.mhmat) files in src/mpfb/data at this commit; ' +
              'they live in the separate MakeHuman system asset pack, to be imported in step H3.'
            : `found ${proxyFiles.length} proxy files; conversion not implemented in H0`,
      },
      null,
      2,
    ),
  );
  for (const e of proxyFiles) skipped.push({ path: e.path, reason: 'proxy conversion not implemented in H0' });

  // --- everything else in data/ that was not used ---------------------------------
  const used = new Set(licences.map((l) => l.path));
  const skippedPaths = new Set(skipped.map((s) => s.path));
  for (const e of inData) {
    if (used.has(e.path) || skippedPaths.has(e.path)) continue;
    skipped.push({ path: e.path, reason: 'not needed by the game in H0 (other rigs, poses, UV layers, Blender node trees, settings)' });
  }

  // --- licence manifest --------------------------------------------------------------
  licences.sort((a, b) => a.path.localeCompare(b.path));
  skipped.sort((a, b) => a.path.localeCompare(b.path));
  await writeFile(
    join(OUT, 'LICENSES.json'),
    JSON.stringify(
      {
        source: { repo: `https://github.com/${MPFB2_REPO}`, sha: MPFB2_SHA, licenceStatement: LICENCE.statement },
        policy: 'only CC0-1.0 asset data is shipped; no MakeHuman/MPFB2 program code is used',
        assets: licences,
        skipped,
      },
      null,
      1,
    ),
  );
  const cc0Text = (await repoFile('LICENSE.ASSETS.md')).toString('utf8');
  await writeFile(
    join(OUT, 'LICENSE-MakeHuman-CC0.txt'),
    [
      'MakeHuman assets (hm08 base mesh, targets, game_engine rig and weights, textures)',
      `Source: https://github.com/${MPFB2_REPO} at commit ${MPFB2_SHA}, directory ${DATA}`,
      'Copyright holders at the time of the CC0 release (September 2020): Data Collection AB,',
      'Joel Palmius, Jonas Hauquier. Released under CC0 1.0 Universal by the MakeHuman team;',
      'see https://static.makehumancommunity.org/about/license.html',
      'The data was converted to binary packs by scripts/import-makehuman.mjs; no MakeHuman',
      'or MPFB program code is included. The full CC0 legal text (LICENSE.ASSETS.md) follows.',
      '',
      cc0Text,
    ].join('\n'),
  );

  // --- report ----------------------------------------------------------------------------
  const files = [
    'base.bin', 'base.json', 'targets-macro-pca.bin', 'targets-macro-pca.json', 'targets-local.bin', 'targets-local.json',
    'modifiers.json', 'skeleton-game-engine.json', 'weights-game-engine.bin', 'proxies/index.json',
    'LICENSES.json', 'LICENSE-MakeHuman-CC0.txt', ...textures.map((t) => t.file),
  ];
  let total = 0;
  let totalGz = 0;
  const rows = [];
  for (const f of files) {
    const buf = await readFile(join(OUT, f));
    const gz = gzipSync(buf, { level: 9 }).length;
    total += buf.length;
    totalGz += gz;
    rows.push(`${f.padEnd(36)} ${String(buf.length).padStart(10)}  gzip ${String(gz).padStart(10)}`);
  }
  console.log(rows.join('\n'));
  console.log(`total ${total} bytes (gzip ${totalGz}); ${files.length} files`);
  console.log(`vertices ${nv}, uvs ${nuv}, faces ${faces.length} (dropped ${droppedFaces} ${GENITAL_GROUP})`);
  console.log(`macro targets ${macroList.length}: ${macro.json.components} components (${(macro.energy * 100).toFixed(5)} % of the energy), ${macro.residualTotal} residual entries, residual quant error ${macro.worstAfter.toExponential(3)} dm`);
  console.log(`local targets ${localList.length}: ${local.total} entries, max quant error ${local.worstErr.toExponential(3)} dm (rel ${local.worstRel.toExponential(3)})`);
  console.log(`bones ${bones.length}; unweighted vertices ${unweighted}; >4 influences ${truncated}`);
  console.log(`licensed assets ${licences.length}; skipped ${skipped.length}`);
  console.log(`downloaded ${downloadedBytes} bytes, read from cache ${cachedBytes} bytes; ${((Date.now() - t0) / 1000).toFixed(1)} s`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
