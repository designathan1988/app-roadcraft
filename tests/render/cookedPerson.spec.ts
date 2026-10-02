import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Float32BufferAttribute, SkinnedMesh } from 'three';
import { describe, expect, it } from 'vitest';

import { DEFAULT_MACRO } from '@people/body/macro';
import { Morpher, type PeoplePacks } from '@people/body/morph';
import { randomPerson } from '@people/spec';
import { createPersonRig, type SkeletonMeta } from '@render/people/personRig';
import type { PersonMeshData } from '@render/people/personMesh';
import { captureBind, captureBindRotations } from '@render/citizenWalk';
import { cookPerson, uncookPerson } from '@render/people/cookedPerson';

const DIR = join(__dirname, '..', '..', 'public', 'models', 'people');
const buf = (f: string): ArrayBuffer => {
  const b = readFileSync(join(DIR, f));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
};
const json = <T>(f: string): T => JSON.parse(readFileSync(join(DIR, f), 'utf8')) as T;
const base = json<PeoplePacks['base'] & { faceGroups: string[]; sections: { name: string; byteOffset: number; count: number }[] }>('base.json');
const baseBin = buf('base.bin');
const packs: PeoplePacks = {
  base, baseBin,
  macro: json('targets-macro-pca.json'), macroBin: buf('targets-macro-pca.bin'),
  local: json('targets-local.json'), localBin: buf('targets-local.bin'),
  modifiers: json('modifiers.json'),
};
const skeleton = json<SkeletonMeta & { weights: { vertexCount: number; layout: { joints: { byteOffset: number }; weights: { byteOffset: number } } } }>('skeleton-game-engine.json');
const weightsBin = buf('weights-game-engine.bin');
const section = (name: string) => base.sections.find((s) => s.name === name)!;
const data: PersonMeshData = {
  vertexCount: base.vertexCount,
  faces: new Uint16Array(baseBin, section('faceVerts').byteOffset, section('faceVerts').count * 4),
  faceGroup: new Uint8Array(baseBin, section('faceGroup').byteOffset, section('faceGroup').count),
  faceGroups: base.faceGroups,
  vertexGroups: base.vertexGroups,
  joints: new Uint8Array(weightsBin, skeleton.weights.layout.joints.byteOffset, base.vertexCount * 4),
  weights: new Uint16Array(weightsBin, skeleton.weights.layout.weights.byteOffset, base.vertexCount * 4),
  boneNames: skeleton.bones.map((b) => b.name),
};
const morpher = new Morpher(packs);
const bodyRange = base.vertexGroups['body']!;

const rigFor = (seed: number) => {
  const person = seed === 0 ? { ...randomPerson(1, 1), body: DEFAULT_MACRO } : randomPerson(seed, seed);
  return createPersonRig({
    data, skeleton, bodyRange, positions: morpher.shape(person.body, person.features), look: person.look,
    capture: captureBind('male'), captureAxes: captureBindRotations('male'),
  });
};

describe('a person cooked ahead and read back', () => {
  it('is the same body: attributes, index, groups, bones, binds and face shapes', () => {
    const rig = rigFor(11);
    // A face shape with real moves and arithmetic noise, as the fitting leaves.
    const count = rig.mesh.geometry.getAttribute('position').count;
    const shape = new Float32Array(count * 3);
    for (let v = 0; v < count; v++) shape[v * 3 + 1] = v % 50 === 0 ? 0.004 : 1e-7;
    const morph = new Float32BufferAttribute(shape, 3);
    morph.name = 'smile';
    rig.mesh.geometry.morphAttributes['position'] = [morph];
    rig.mesh.geometry.morphTargetsRelative = true;
    rig.mesh.updateMorphTargets();
    const back = uncookPerson(cookPerson(rig.scene));
    let mesh: SkinnedMesh | undefined;
    back.traverse((o) => { if (o instanceof SkinnedMesh && !mesh) mesh = o; });
    expect(mesh).toBeDefined();
    const a = rig.mesh.geometry, b = mesh!.geometry;
    expect(Object.keys(b.attributes).sort()).toEqual(Object.keys(a.attributes).sort());
    for (const [name, attr] of Object.entries(a.attributes)) {
      expect(Array.from(b.getAttribute(name).array as ArrayLike<number>)).toEqual(Array.from(attr.array as ArrayLike<number>));
      expect(b.getAttribute(name).itemSize).toBe(attr.itemSize);
    }
    expect(Array.from(b.index!.array)).toEqual(Array.from(a.index!.array));
    expect(b.groups).toEqual(a.groups.map((g) => ({ start: g.start, count: g.count, materialIndex: g.materialIndex ?? 0 })));
    expect(mesh!.skeleton.bones.map((x) => x.name)).toEqual(rig.mesh.skeleton.bones.map((x) => x.name));
    // Equal as numbers (JSON writes -0 as 0, the same value).
    const same = (a: readonly number[], b: readonly number[]): void => a.forEach((x, i) => expect(x === b[i]).toBe(true));
    mesh!.skeleton.boneInverses.forEach((m, i) => same(m.elements, rig.mesh.skeleton.boneInverses[i]!.elements));
    same(mesh!.bindMatrix.elements, rig.mesh.bindMatrix.elements);
    back.updateMatrixWorld(true);
    rig.scene.updateMatrixWorld(true);
    mesh!.matrixWorld.elements.forEach((x, i) => expect(Math.abs(x - rig.mesh.matrixWorld.elements[i]!)).toBeLessThan(1e-9));
    // The face shape: every real move kept exactly, the noise dropped.
    const moved = b.morphAttributes['position']![0]!;
    expect(moved.name).toBe('smile');
    for (let v = 0; v < count; v += 1) {
      if (moved.getY(v) !== (v % 50 === 0 ? Math.fround(0.004) : 0)) throw new Error(`vertex ${v}: ${moved.getY(v)}`);
    }
    expect(mesh!.morphTargetDictionary).toEqual(rig.mesh.morphTargetDictionary);
    // What the skin shader reads off the geometry: without it, a crash on the first frame.
    for (const key of ['faceOrigin', 'faceScale', 'wornGroups']) expect(b.userData[key]).toEqual(a.userData[key]);
  });
});
