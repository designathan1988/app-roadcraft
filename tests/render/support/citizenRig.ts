import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Box3, Object3D, SkinnedMesh, Vector3 } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone } from 'three/addons/utils/SkeletonUtils.js';

/**
 * The citizen bodies, loaded in node exactly as the game loads them
 * (`GLTFLoader`, then `SkeletonUtils.clone` per bake), minus their textures:
 * node has no image decoder, and nothing measured here reads a pixel.
 */

const root = resolve('public/models/citizens');

/** The GLB with its images, textures and samplers taken out. */
function untextured(name: string): ArrayBuffer {
  const raw = readFileSync(resolve(root, `${name}.glb`));
  const jsonLength = raw.readUInt32LE(12);
  const json = JSON.parse(raw.subarray(20, 20 + jsonLength).toString()) as Record<string, unknown> & {
    materials?: { pbrMetallicRoughness?: Record<string, unknown>; normalTexture?: unknown; emissiveTexture?: unknown; occlusionTexture?: unknown }[];
  };
  // The binary chunk follows the JSON chunk: its length, its type, its bytes.
  const binStart = 20 + jsonLength;
  const binLength = raw.readUInt32LE(binStart);
  const bin = raw.subarray(binStart + 8, binStart + 8 + binLength);
  delete json['images'];
  delete json['textures'];
  delete json['samplers'];
  for (const material of json.materials ?? []) {
    delete material.pbrMetallicRoughness?.['baseColorTexture'];
    delete material.pbrMetallicRoughness?.['metallicRoughnessTexture'];
    delete material.normalTexture;
    delete material.emissiveTexture;
    delete material.occlusionTexture;
  }
  let text = JSON.stringify(json);
  while (text.length % 4) text += ' ';
  const jsonBytes = Buffer.from(text, 'utf8');
  const out = Buffer.alloc(12 + 8 + jsonBytes.length + 8 + bin.length);
  out.writeUInt32LE(0x46546c67, 0);
  out.writeUInt32LE(2, 4);
  out.writeUInt32LE(out.length, 8);
  out.writeUInt32LE(jsonBytes.length, 12);
  out.writeUInt32LE(0x4e4f534a, 16);
  jsonBytes.copy(out, 20);
  const b = 20 + jsonBytes.length;
  out.writeUInt32LE(bin.length, b);
  out.writeUInt32LE(0x004e4942, b + 4);
  bin.copy(out, b + 8);
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.length) as ArrayBuffer;
}

const cache = new Map<string, Promise<Object3D>>();

/** The asset's scene, parsed once per body. */
export function citizenScene(name: string): Promise<Object3D> {
  let pending = cache.get(name);
  if (!pending) {
    pending = new GLTFLoader().parseAsync(untextured(name), '').then((gltf) => gltf.scene);
    cache.set(name, pending);
  }
  return pending;
}

/** A fresh copy of a body at its rest pose, as `riggedCitizens.restRig` makes one. */
export async function citizenRig(name: string): Promise<Object3D> {
  const rig = clone(await citizenScene(name));
  rig.updateMatrixWorld(true);
  return rig;
}

/**
 * Every vertex of a posed rig, in the rig's frame (metres; +Z forward, +Y up,
 * +X to the body's left), with the bone that moves it most. `stride` samples
 * one vertex in so many.
 */
export function posedVertices(rig: Object3D, stride = 1): { points: Vector3[]; bones: string[] } {
  rig.updateMatrixWorld(true);
  const points: Vector3[] = [];
  const bones: string[] = [];
  rig.traverse((o) => {
    if (!(o instanceof SkinnedMesh)) return;
    o.skeleton.update();
    const position = o.geometry.getAttribute('position');
    const index = o.geometry.getAttribute('skinIndex');
    const weight = o.geometry.getAttribute('skinWeight');
    for (let i = 0; i < position.count; i += stride) {
      const v = new Vector3();
      o.getVertexPosition(i, v);
      o.localToWorld(v);
      points.push(v);
      let best = 0;
      for (let k = 1; k < 4; k++) if (weight.getComponent(i, k) > weight.getComponent(i, best)) best = k;
      bones.push(o.skeleton.bones[index.getComponent(i, best)]?.name ?? '');
    }
  });
  return { points, bones };
}

/** World position of a named bone of a posed rig. */
export function bonePosition(rig: Object3D, name: string): Vector3 {
  const bone = rig.getObjectByName(name);
  if (!bone) throw new Error(`no bone ${name}`);
  return bone.getWorldPosition(new Vector3());
}

export function boundsOf(points: readonly Vector3[]): Box3 {
  return new Box3().setFromPoints(points as Vector3[]);
}
