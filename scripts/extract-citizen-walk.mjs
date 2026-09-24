/**
 * Extracts a Rocketbox walk cycle from a GLB into the compact motion file the
 * game retargets onto every citizen (src/render/motion/).
 *
 *   node scripts/extract-citizen-walk.mjs <Walk_InPlace.glb> <out.json> [clip]
 *
 * Used for src/render/motion/walkMale.json (Male_Adult_01, m_walk_neutral)
 * and walkFemale.json (Female_Adult_01, f_walk_neutral).
 *
 * The sources are the official Rocketbox neutral walks on their own avatars,
 * MIT, Copyright (c) 2020 Microsoft. What is written is
 * motion only — no mesh, no texture: for every sampled frame the WORLD
 * rotation of each bone, the pelvis position and the height of the lowest foot
 * joint, plus each bone's world rotation in the bind pose. The game transfers
 * it bone by bone as a rotation relative to the bind pose, which does not
 * depend on how any one exporter oriented the bones' local axes.
 */
import fs from 'node:fs';
import path from 'node:path';
import { Matrix4, Quaternion, Vector3 } from 'three';

const source = process.argv[2];
const target = process.argv[3];
const clipName = process.argv[4] ?? 'Walk_InPlace';
if (!source || !target) throw new Error('Usage: node scripts/extract-citizen-walk.mjs <walk.glb> <out.json> [clip]');

const buffer = fs.readFileSync(source);
if (buffer.readUInt32LE(0) !== 0x46546c67) throw new Error('Not a GLB');
const jsonLength = buffer.readUInt32LE(12);
const gltf = JSON.parse(buffer.subarray(20, 20 + jsonLength).toString('utf8'));
const binStart = 20 + jsonLength + 8;
const bin = buffer.subarray(binStart, binStart + buffer.readUInt32LE(20 + jsonLength));

const WIDTH = { SCALAR: 1, VEC3: 3, VEC4: 4, MAT4: 16 };
function accessor(index) {
  const a = gltf.accessors[index];
  if (a.componentType !== 5126) throw new Error(`Accessor ${index} is not float`);
  const view = gltf.bufferViews[a.bufferView];
  const width = WIDTH[a.type];
  const offset = (view.byteOffset ?? 0) + (a.byteOffset ?? 0);
  const stride = view.byteStride ?? width * 4;
  const out = new Float32Array(a.count * width);
  for (let i = 0; i < a.count; i++) {
    for (let k = 0; k < width; k++) out[i * width + k] = bin.readFloatLE(offset + i * stride + k * 4);
  }
  return { data: out, width, count: a.count };
}

const skin = gltf.skins[0];
const joints = skin.joints;
const parentOf = new Map();
gltf.nodes.forEach((node, index) => (node.children ?? []).forEach((child) => parentOf.set(child, index)));
const nameOf = (index) => gltf.nodes[index].name;

const clip = gltf.animations.find((a) => a.name === clipName);
if (!clip) throw new Error(`No clip ${clipName}; have ${gltf.animations.map((a) => a.name).join(', ')}`);
const tracks = new Map();
let times = new Float32Array(0);
for (const channel of clip.channels) {
  const sampler = clip.samplers[channel.sampler];
  const input = accessor(sampler.input);
  // The longest timeline is the clip's; constant channels carry fewer keys.
  if (input.count > times.length) times = input.data;
  const entry = tracks.get(channel.target.node) ?? {};
  entry[channel.target.path] = { times: input.data, ...accessor(sampler.output) };
  tracks.set(channel.target.node, entry);
}

/** A channel's value at a time, linearly interpolated (slerp for rotations). */
function sampleAt(track, time, width) {
  const t = track.times;
  let i = 0;
  while (i < t.length - 2 && t[i + 1] <= time) i++;
  const span = t.length > 1 ? t[i + 1] - t[i] : 0;
  const f = span > 0 ? Math.min(1, Math.max(0, (time - t[i]) / span)) : 0;
  const a = [...track.data.subarray(i * width, i * width + width)];
  if (t.length < 2) return a;
  const b = [...track.data.subarray((i + 1) * width, (i + 1) * width + width)];
  if (width === 4) {
    const q = new Quaternion(...a).slerp(new Quaternion(...b), f);
    return [q.x, q.y, q.z, q.w];
  }
  return a.map((v, k) => v + (b[k] - v) * f);
}

/** Local matrix of a node at key `k`, from its track or its rest TRS. */
function local(index, k) {
  const node = gltf.nodes[index];
  const track = tracks.get(index) ?? {};
  const time = times[k];
  const t = track.translation ? sampleAt(track.translation, time, 3) : node.translation ?? [0, 0, 0];
  const r = track.rotation ? sampleAt(track.rotation, time, 4) : node.rotation ?? [0, 0, 0, 1];
  const s = track.scale ? sampleAt(track.scale, time, 3) : node.scale ?? [1, 1, 1];
  if (node.matrix) return new Matrix4().fromArray(node.matrix);
  return new Matrix4().compose(new Vector3(...t), new Quaternion(...r), new Vector3(...s));
}
function world(index, k, cache) {
  if (cache.has(index)) return cache.get(index);
  const parent = parentOf.get(index);
  const m = parent === undefined ? local(index, k) : world(parent, k, cache).clone().multiply(local(index, k));
  cache.set(index, m);
  return m;
}

const round = (v) => Math.round(v * 1e5) / 1e5;
const quat = (m) => {
  const q = new Quaternion();
  m.decompose(new Vector3(), q, new Vector3());
  return [q.x, q.y, q.z, q.w].map(round);
};
const pos = (m) => new Vector3().setFromMatrixPosition(m).toArray().map(round);

const ibm = accessor(skin.inverseBindMatrices);
const names = joints.map((j) => nameOf(j).replace(/ /g, '_'));
const bind = joints.map((_, i) => {
  const m = new Matrix4().fromArray(ibm.data.subarray(i * 16, i * 16 + 16)).invert();
  return { q: quat(m), p: pos(m) };
});
const pelvisIndex = names.indexOf('Bip01_Pelvis');
const footNames = ['Bip01_L_Foot', 'Bip01_R_Foot', 'Bip01_L_Toe0', 'Bip01_R_Toe0'];
const feet = footNames.map((n) => names.indexOf(n));
if (pelvisIndex < 0 || feet.some((i) => i < 0)) throw new Error('Not a Rocketbox Biped skeleton');

// The last key repeats the first (a closed loop), so it is not stored.
const frames = [];
for (let k = 0; k < times.length - 1; k++) {
  const cache = new Map();
  const matrices = joints.map((j) => world(j, k, cache));
  frames.push({
    q: matrices.map(quat),
    pelvis: pos(matrices[pelvisIndex]),
    lowest: round(Math.min(...feet.map((i) => new Vector3().setFromMatrixPosition(matrices[i]).y))),
  });
}
const bindLowest = Math.min(...feet.map((i) => bind[i].p[1]));
const out = {
  source: `${path.basename(source)} / ${clipName}`,
  license: 'Microsoft Rocketbox, MIT, Copyright (c) 2020 Microsoft',
  duration: round(times[times.length - 1] - times[0]),
  bones: names,
  bind,
  bindLowest: round(bindLowest),
  frames,
};
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.writeFileSync(target, JSON.stringify(out));
console.log(`wrote ${target}: ${frames.length} frames, ${names.length} bones, ${(fs.statSync(target).size / 1024).toFixed(0)} KB`);
