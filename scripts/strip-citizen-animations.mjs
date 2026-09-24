/* global structuredClone */
/**
 * Strips the animation clips out of the citizen GLBs, with every accessor and
 * bufferView that only they used.
 *
 * Nothing in the game plays those clips. A pedestrian plays the Rocketbox
 * captures in `src/render/motion/` (`citizenWalk.ts`), a person in or on a
 * vehicle an IK pose (`riderPoses.ts`), and `riggedCitizens.ts` never reads
 * `asset.animations`. The eight Quaternius clips `convert-citizens.mjs` once
 * retargeted onto every body were still a large share of each file, which
 * every player downloaded and parsed for nothing.
 *
 * Everything else is kept exactly: meshes, skins, nodes (their transforms are
 * the rest pose `riggedCitizens.ts` resets a body to), materials, textures,
 * images, the distant-LOD index accessors in `extras.roadcraftLods`, and the
 * asset metadata. Surviving accessors and bufferViews keep their relative
 * order; the binary is repacked with each surviving bufferView aligned to 4
 * bytes. Before anything is written, every mesh, skin and image reference of
 * the result is resolved and compared with the source: the same accessor
 * definition over the same bytes, the same image bytes.
 *
 * Idempotent: a file with nothing left to strip is not rewritten. The
 * catalog's `bytes`, `sha256` and `clips` follow every file it lists.
 *
 *   node scripts/strip-citizen-animations.mjs [directory]
 *
 * `directory` defaults to `public/models/citizens`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

const GLB_MAGIC = 0x46546c67; // 'glTF'
const CHUNK_JSON = 0x4e4f534a; // 'JSON'
const CHUNK_BIN = 0x004e4942; // 'BIN\0'

const pad4 = n => (4 - (n % 4)) % 4;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

/** A GLB split into its JSON document and its binary chunk. Anything else is refused. */
function readGlb(raw, name) {
  if (raw.length < 12 || raw.readUInt32LE(0) !== GLB_MAGIC) throw new Error(`${name}: not a GLB`);
  if (raw.readUInt32LE(4) !== 2) throw new Error(`${name}: GLB version ${raw.readUInt32LE(4)}, expected 2`);
  if (raw.readUInt32LE(8) !== raw.length) throw new Error(`${name}: the header's length is not the file's`);
  const chunks = [];
  for (let at = 12; at < raw.length;) {
    if (at + 8 > raw.length) throw new Error(`${name}: truncated chunk header`);
    const length = raw.readUInt32LE(at);
    if (at + 8 + length > raw.length) throw new Error(`${name}: truncated chunk`);
    chunks.push({ type: raw.readUInt32LE(at + 4), data: raw.subarray(at + 8, at + 8 + length) });
    at += 8 + length;
  }
  // A third chunk, or none of binary, is not something this tool knows how to keep.
  if (chunks.length !== 2 || chunks[0].type !== CHUNK_JSON || chunks[1].type !== CHUNK_BIN) {
    throw new Error(`${name}: expected exactly a JSON chunk and a BIN chunk`);
  }
  return { doc: JSON.parse(chunks[0].data.toString('utf8')), bin: chunks[1].data };
}

/** The GLB for a document and its binary: JSON padded with spaces, BIN with zeros. */
function writeGlb(doc, bin) {
  const text = Buffer.from(JSON.stringify(doc), 'utf8');
  const json = Buffer.concat([text, Buffer.alloc(pad4(text.length), 0x20)]);
  const binary = Buffer.concat([bin, Buffer.alloc(pad4(bin.length))]);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(GLB_MAGIC, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + json.length + 8 + binary.length, 8);
  const chunk = (length, type) => {
    const head = Buffer.alloc(8);
    head.writeUInt32LE(length, 0);
    head.writeUInt32LE(type, 4);
    return head;
  };
  return Buffer.concat([header, chunk(json.length, CHUNK_JSON), json, chunk(binary.length, CHUNK_BIN), binary]);
}

/**
 * Refuses a document this tool cannot see every reference in. An extension
 * (Draco, meshopt, GPU instancing, ...) can name accessors or bufferViews in
 * places the lists below do not look, and `roadcraftLods` is only read, and
 * only remapped, on a mesh primitive's extras.
 */
function assertUnderstood(doc, name) {
  if (doc.extensionsUsed?.length || doc.extensionsRequired?.length) {
    throw new Error(`${name}: uses extensions (${[...doc.extensionsUsed ?? [], ...doc.extensionsRequired ?? []]})`);
  }
  if (doc.buffers?.length !== 1 || doc.buffers[0].uri !== undefined) {
    throw new Error(`${name}: expected one buffer, stored in the BIN chunk`);
  }
  for (const view of doc.bufferViews ?? []) if (view.buffer !== 0) throw new Error(`${name}: a bufferView outside buffer 0`);
  const visit = (value, where) => {
    if (value === null || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      const at = `${where}.${key}`;
      if (key === 'extensions' && Object.keys(child ?? {}).length) throw new Error(`${name}: extension at ${at}`);
      if (key === 'roadcraftLods' && !/^\$\.meshes\.\d+\.primitives\.\d+\.extras\.roadcraftLods$/.test(at)) {
        throw new Error(`${name}: roadcraftLods outside a primitive's extras, at ${at}`);
      }
      visit(child, at);
    }
  };
  visit(doc, '$');
}

/**
 * Every place the document names an accessor, as `[holder, key]` pairs:
 * vertex attributes, indices, morph targets, the distant-LOD index lists
 * `citizen-lods.mjs` writes (`riggedCitizens.ts` loads them with
 * `parser.getDependency('accessor', i)`), inverse bind matrices, and animation
 * samplers while there still are any.
 */
function accessorSlots(doc) {
  const slots = [];
  for (const mesh of doc.meshes ?? []) for (const primitive of mesh.primitives) {
    for (const key of Object.keys(primitive.attributes)) slots.push([primitive.attributes, key]);
    if (primitive.indices !== undefined) slots.push([primitive, 'indices']);
    for (const target of primitive.targets ?? []) for (const key of Object.keys(target)) slots.push([target, key]);
    const lods = primitive.extras?.roadcraftLods;
    if (lods !== undefined) {
      if (!Array.isArray(lods)) throw new Error('roadcraftLods is not a list of accessor indices');
      for (let i = 0; i < lods.length; i++) slots.push([lods, i]);
    }
  }
  for (const skin of doc.skins ?? []) if (skin.inverseBindMatrices !== undefined) slots.push([skin, 'inverseBindMatrices']);
  for (const animation of doc.animations ?? []) for (const sampler of animation.samplers) {
    slots.push([sampler, 'input'], [sampler, 'output']);
  }
  return slots;
}

/** Every place the document names a bufferView: accessors (sparse ones too) and embedded images. */
function viewSlots(doc) {
  const slots = [];
  for (const accessor of doc.accessors ?? []) {
    if (accessor.bufferView !== undefined) slots.push([accessor, 'bufferView']);
    if (accessor.sparse) slots.push([accessor.sparse.indices, 'bufferView'], [accessor.sparse.values, 'bufferView']);
  }
  for (const image of doc.images ?? []) if (image.bufferView !== undefined) slots.push([image, 'bufferView']);
  return slots;
}

/**
 * Renumbers the referenced entries of a list of `count` in their original
 * order, rewrites every slot, and returns the old index of each survivor.
 */
function compact(slots, count, what) {
  for (const [holder, key] of slots) {
    const index = holder[key];
    if (!Number.isInteger(index) || index < 0 || index >= count) throw new Error(`${what} index ${index} out of range`);
  }
  const kept = [...new Set(slots.map(([holder, key]) => holder[key]))].sort((a, b) => a - b);
  const renumbered = new Map(kept.map((old, index) => [old, index]));
  for (const [holder, key] of slots) holder[key] = renumbered.get(holder[key]);
  return kept;
}

/** A bufferView as what it holds: its definition without its place, and a hash of its bytes. */
function viewContent(doc, bin, index) {
  const view = { ...doc.bufferViews[index] };
  const start = view.byteOffset ?? 0;
  delete view.buffer;
  delete view.byteOffset;
  const bytes = bin.subarray(start, start + view.byteLength);
  if (bytes.length !== view.byteLength) throw new Error(`bufferView ${index} runs past the binary`);
  return { ...view, bytes: sha256(bytes) };
}

/** An accessor as what it holds, its bufferViews resolved. */
function accessorContent(doc, bin, index) {
  const accessor = structuredClone(doc.accessors[index]);
  if (accessor.bufferView !== undefined) accessor.bufferView = viewContent(doc, bin, accessor.bufferView);
  if (accessor.sparse) {
    accessor.sparse.indices.bufferView = viewContent(doc, bin, accessor.sparse.indices.bufferView);
    accessor.sparse.values.bufferView = viewContent(doc, bin, accessor.sparse.values.bufferView);
  }
  return accessor;
}

/**
 * The document with every accessor and image reference replaced by what it
 * resolves to, and the index tables themselves dropped. Two documents that
 * resolve alike draw alike, whatever their numbering and byte layout.
 */
function resolved(doc, bin) {
  const copy = structuredClone(doc);
  delete copy.animations;
  for (const [holder, key] of accessorSlots(copy)) holder[key] = accessorContent(doc, bin, holder[key]);
  for (const image of copy.images ?? []) {
    if (image.bufferView !== undefined) image.bufferView = viewContent(doc, bin, image.bufferView);
  }
  delete copy.accessors;
  delete copy.bufferViews;
  delete copy.buffers;
  return copy;
}

/** The document and binary without animations or anything nothing references. */
function strip(source, bin) {
  const doc = structuredClone(source);
  const clips = (doc.animations ?? []).map(clip => clip.name);
  delete doc.animations;

  const accessors = doc.accessors ?? [];
  const keptAccessors = compact(accessorSlots(doc), accessors.length, 'accessor');
  if (doc.accessors) doc.accessors = keptAccessors.map(index => accessors[index]);

  const views = doc.bufferViews ?? [];
  const keptViews = compact(viewSlots(doc), views.length, 'bufferView');
  // Laid out in the order the bytes had, each view starting on 4 bytes.
  const layout = keptViews.map((old, index) => ({ old, index }))
    .sort((a, b) => (views[a.old].byteOffset ?? 0) - (views[b.old].byteOffset ?? 0) || a.index - b.index);
  const placed = new Array(keptViews.length);
  const parts = [];
  let length = 0;
  for (const { old, index } of layout) {
    const view = { ...views[old] };
    const start = view.byteOffset ?? 0;
    const bytes = bin.subarray(start, start + view.byteLength);
    if (bytes.length !== view.byteLength) throw new Error(`bufferView ${old} runs past the binary`);
    const gap = pad4(length);
    if (gap) parts.push(Buffer.alloc(gap));
    length += gap;
    view.byteOffset = length;
    parts.push(bytes);
    length += bytes.length;
    placed[index] = view;
  }
  const tail = pad4(length);
  if (tail) parts.push(Buffer.alloc(tail));
  length += tail;
  if (doc.bufferViews) doc.bufferViews = placed;
  doc.buffers[0].byteLength = length;
  return {
    doc, bin: Buffer.concat(parts, length), clips,
    accessors: [accessors.length, keptAccessors.length], views: [views.length, keptViews.length],
  };
}

const bytesText = n => n.toLocaleString('en-US');
const mib = n => `${(n / 1024 / 1024).toFixed(1)} MiB`;
const share = (before, after) => `${(100 * (after - before) / before).toFixed(1)}%`;

const directory = path.resolve(process.argv[2] ?? 'public/models/citizens');
const files = fs.readdirSync(directory).filter(file => file.endsWith('.glb')).sort();
if (!files.length) throw new Error(`No GLB in ${directory}`);
const catalogPath = path.join(directory, 'catalog.json');
const catalogText = fs.existsSync(catalogPath) ? fs.readFileSync(catalogPath, 'utf8') : null;
const catalog = catalogText === null ? null : JSON.parse(catalogText);
const listed = new Map((catalog?.models ?? []).map(model => [`${model.id}.glb`, model]));

let totalBefore = 0, totalAfter = 0, rewritten = 0;
for (const file of files) {
  const filename = path.join(directory, file);
  const raw = fs.readFileSync(filename);
  const { doc, bin } = readGlb(raw, file);
  assertUnderstood(doc, file);
  const result = strip(doc, bin);
  const glb = writeGlb(result.doc, result.bin);

  // Check the bytes about to be written, not the objects they came from.
  const written = readGlb(glb, `${file} (stripped)`);
  if (written.doc.animations !== undefined) throw new Error(`${file}: animations survived`);
  if (!isDeepStrictEqual(resolved(written.doc, written.bin), resolved(doc, bin))) {
    throw new Error(`${file}: the stripped model does not resolve to the same meshes, skins and images`);
  }

  const changed = !glb.equals(raw);
  if (changed) {
    fs.writeFileSync(filename, glb);
    rewritten++;
  }
  totalBefore += raw.length;
  totalAfter += glb.length;
  const model = listed.get(file);
  if (model) {
    model.bytes = glb.length;
    model.sha256 = sha256(glb);
    model.clips = [];
  }
  const removed = changed
    ? `${result.clips.length} clips, ${result.accessors[0] - result.accessors[1]} accessors, ` +
      `${result.views[0] - result.views[1]} bufferViews removed`
    : 'unchanged';
  console.log(`${file.padEnd(28)} ${bytesText(raw.length).padStart(10)} -> ${bytesText(glb.length).padStart(10)} bytes ` +
    `(${share(raw.length, glb.length)})  ${removed}${model ? '' : '  [not in catalog.json]'}`);
}

if (catalog) {
  const text = JSON.stringify(catalog, null, 2) + '\n';
  if (text !== catalogText.replace(/\r\n/g, '\n')) fs.writeFileSync(catalogPath, text);
}
console.log(`\n${files.length} models, ${rewritten} rewritten: ${bytesText(totalBefore)} -> ${bytesText(totalAfter)} bytes ` +
  `(${mib(totalBefore)} -> ${mib(totalAfter)}, ${share(totalBefore, totalAfter)})`);
