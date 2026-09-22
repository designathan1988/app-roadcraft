/** Add distance-only index LODs; full-detail vertices, weights and faces stay intact. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { MeshoptSimplifier } from 'meshoptimizer';

await MeshoptSimplifier.ready;
const root = path.resolve('public/models/citizens');
const catalog = JSON.parse(fs.readFileSync(path.join(root, 'catalog.json'), 'utf8'));
for (const model of catalog.models) {
  const filename = path.join(root, `${model.id}.glb`);
  const raw = fs.readFileSync(filename);
  const jsonLength = raw.readUInt32LE(12);
  const document = JSON.parse(raw.subarray(20, 20 + jsonLength).toString());
  if (model.lodTriangles) continue;
  const binary = raw.subarray(28 + jsonLength);
  const chunks = [binary];
  let length = binary.length;
  const read = index => {
    const accessor = document.accessors[index], view = document.bufferViews[accessor.bufferView];
    const start = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
    const columns = accessor.type === 'VEC3' ? 3 : 1;
    const Type = accessor.componentType === 5126 ? Float32Array : accessor.componentType === 5123 ? Uint16Array : Uint32Array;
    return new Type(binary.buffer, binary.byteOffset + start, accessor.count * columns);
  };
  const append = indices => {
    const payload = Buffer.from(indices.buffer, indices.byteOffset, indices.byteLength);
    document.bufferViews.push({ buffer: 0, byteOffset: length, byteLength: payload.length, target: 34963 });
    chunks.push(payload); length += payload.length;
    document.accessors.push({ bufferView: document.bufferViews.length - 1, componentType: 5125,
      count: indices.length, type: 'SCALAR' });
    return document.accessors.length - 1;
  };
  const counts = [0, 0, 0];
  for (const mesh of document.meshes) for (const primitive of mesh.primitives) {
    const positions = read(primitive.attributes.POSITION);
    const indices = Uint32Array.from(read(primitive.indices));
    counts[0] += indices.length / 3;
    const lods = [];
    for (const [ratio, error] of [[0.25, 0.008], [0.06, 0.025]]) {
      const target = Math.max(24, Math.floor(indices.length * ratio / 3) * 3);
      const [candidate] = MeshoptSimplifier.simplify(indices, positions, 3,
        Math.min(target, indices.length), error, ['Prune', 'Regularize']);
      // glTF accessors must be nonempty. Keep tiny isolated details if the
      // simplifier would prune their entire material group.
      const simplified = candidate.length ? candidate : indices;
      lods.push(append(simplified));
      counts[lods.length] += simplified.length / 3;
    }
    primitive.extras = { ...primitive.extras, roadcraftLods: lods };
  }
  document.buffers[0].byteLength = length;
  let json = Buffer.from(JSON.stringify(document));
  if (json.length % 4) json = Buffer.concat([json, Buffer.alloc(4 - json.length % 4, 32)]);
  const header = Buffer.alloc(20);
  header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4);
  header.writeUInt32LE(28 + json.length + length, 8);
  header.writeUInt32LE(json.length, 12); header.writeUInt32LE(0x4e4f534a, 16);
  const binHeader = Buffer.alloc(8); binHeader.writeUInt32LE(length, 0); binHeader.writeUInt32LE(0x004e4942, 4);
  const glb = Buffer.concat([header, json, binHeader, ...chunks]);
  fs.writeFileSync(filename, glb);
  model.bytes = glb.length; model.sha256 = createHash('sha256').update(glb).digest('hex');
  model.lodTriangles = counts;
  console.log(`${model.id}: ${counts.join(' / ')} triangles`);
}
fs.writeFileSync(path.join(root, 'catalog.json'), JSON.stringify(catalog, null, 2) + '\n');
