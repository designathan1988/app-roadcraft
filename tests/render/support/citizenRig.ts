import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Box3, Object3D, SkinnedMesh, Vector3 } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone } from 'three/addons/utils/SkeletonUtils.js';
import { CROWD } from '@render/citizenCasting';
import { captureBind, captureBindRotations } from '@render/citizenWalk';
import { Morpher, type PeoplePacks } from '@people/body/morph';
import { createPersonRig, type SkeletonMeta } from '@render/people/personRig';
import type { PersonMeshData } from '@render/people/personMesh';

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

/** A roster person (`people/roster.ts`), rigged as the crowd rigs one, in node. */
function personScene(name: string): Object3D {
  const model = CROWD.find((m) => m.id === name);
  if (!model?.person) throw new Error(`no roster person ${name}`);
  const dir = resolve('public/models/people');
  const buf = (f: string): ArrayBuffer => {
    const b = readFileSync(resolve(dir, f));
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
  };
  const json = <T>(f: string): T => JSON.parse(readFileSync(resolve(dir, f), 'utf8')) as T;
  peoplePacks ??= (() => {
    const base = json<PeoplePacks['base'] & { faceGroups: string[]; sections: { name: string; byteOffset: number; count: number }[] }>('base.json');
    const baseBin = buf('base.bin');
    const skeleton = json<SkeletonMeta & { weights: { layout: { joints: { byteOffset: number }; weights: { byteOffset: number } } } }>('skeleton-game-engine.json');
    const weightsBin = buf('weights-game-engine.bin');
    const section = (n: string) => base.sections.find((x) => x.name === n)!;
    const packs: PeoplePacks = {
      base, baseBin,
      macro: json('targets-macro-pca.json'), macroBin: buf('targets-macro-pca.bin'),
      local: json('targets-local.json'), localBin: buf('targets-local.bin'),
      modifiers: json('modifiers.json'),
    };
    const data: PersonMeshData = {
      vertexCount: base.vertexCount,
      faces: new Uint16Array(baseBin, section('faceVerts').byteOffset, section('faceVerts').count * 4),
      faceGroup: new Uint8Array(baseBin, section('faceGroup').byteOffset, section('faceGroup').count),
      faceGroups: base.faceGroups, vertexGroups: base.vertexGroups,
      joints: new Uint8Array(weightsBin, skeleton.weights.layout.joints.byteOffset, base.vertexCount * 4),
      weights: new Uint16Array(weightsBin, skeleton.weights.layout.weights.byteOffset, base.vertexCount * 4),
      boneNames: skeleton.bones.map((b) => b.name),
    };
    return { morpher: new Morpher(packs), data, skeleton, bodyRange: base.vertexGroups['body']! };
  })();
  const { morpher, data, skeleton, bodyRange } = peoplePacks;
  const person = model.person;
  return createPersonRig({
    data, skeleton, bodyRange, positions: morpher.shape(person.body, person.features), look: person.look,
    capture: captureBind(model.gender === 'f' ? 'female' : 'male'), captureAxes: captureBindRotations(model.gender === 'f' ? 'female' : 'male'),
  }).scene;
}
let peoplePacks: { morpher: Morpher; data: PersonMeshData; skeleton: SkeletonMeta; bodyRange: readonly (readonly [number, number])[] } | null = null;
const people = new Map<string, Object3D>();

/** A fresh copy of a body at its rest pose, as `riggedCitizens.restRig` makes one. */
export async function citizenRig(name: string): Promise<Object3D> {
  if (name.startsWith('mh_')) {
    let scene = people.get(name);
    if (!scene) people.set(name, (scene = personScene(name)));
    const rig = clone(scene);
    rig.updateMatrixWorld(true);
    return rig;
  }
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
