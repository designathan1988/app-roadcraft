import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Vector3 } from 'three';
import { describe, expect, it } from 'vitest';

import { Morpher, type PeoplePacks } from '@people/body/morph';
import { randomPerson, wornItems, type PersonSpec } from '@people/spec';
import { parseProxy, type ProxyItem, type ProxyMeta } from '@people/body/proxy';
import { createPersonRig, type SkeletonMeta } from '@render/people/personRig';
import type { PersonMeshData } from '@render/people/personMesh';
import { captureBind, captureBindRotations } from '@render/citizenWalk';

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


/** A proxy from disk, without its texture (Node reads no WebP). */
const item = (name: string): ProxyItem => {
  const meta = json<ProxyMeta>(`proxies/${name}.json`);
  return { pack: parseProxy(meta, buf(`proxies/${name}.bin`)), texture: null, transparent: !!meta.transparent, textureFile: null };
};
const dress = (person: PersonSpec) => {
  const proxies = new Map(wornItems(person.look).map((n) => [n, item(n)]));
  const sex = person.body.gender < 0.5 ? 'female' : 'male';
  return createPersonRig({
    data, skeleton, bodyRange, positions: morpher.shape(person.body, person.features), look: person.look,
    capture: captureBind(sex), captureAxes: captureBindRotations(sex), proxies,
  });
};

describe('expressions on a dressed person', () => {
  it('moves the vertices as building the changed body again would', () => {
    // Somebody in an outfit (the bodies in painted shells are built again for each expression).
    let seed = 7;
    while (!randomPerson(seed, seed).look.outfit) seed++;
    const person = randomPerson(seed, seed);
    const proxies = new Map(wornItems(person.look).map((n) => [n, item(n)]));
    const sex = person.body.gender < 0.5 ? 'female' : 'male';
    const input = {
      data, skeleton, bodyRange, positions: morpher.shape(person.body, person.features), look: person.look,
      capture: captureBind(sex), captureAxes: captureBindRotations(sex), proxies,
    };
    const rig = createPersonRig(input);
    expect(rig.morph).toBeDefined();
    // A change of shape round the mouth, as an expression is.
    const changed = input.positions.slice();
    let top = -Infinity;
    for (const [a, b] of data.vertexGroups['body'] ?? []) for (let v = a; v <= b; v++) top = Math.max(top, input.positions[v * 3 + 1]!);
    for (const [a, b] of data.vertexGroups['body'] ?? []) for (let v = a; v <= b; v++) {
      if (input.positions[v * 3 + 1]! > top - 2) changed[v * 3 + 2] = changed[v * 3 + 2]! + 0.08;
    }
    const direct = rig.morph!(changed);
    const again = createPersonRig({ ...input, positions: changed }).mesh.geometry.getAttribute('position');
    const was = rig.mesh.geometry.getAttribute('position');
    let worst = 0, moved = 0;
    for (let i = 0; i < was.count; i++) {
      for (const [k, get] of [[0, 'getX'], [1, 'getY'], [2, 'getZ']] as const) {
        const rebuilt = again[get](i) - was[get](i);
        worst = Math.max(worst, Math.abs(rebuilt - direct[i * 3 + k]!));
        if (Math.abs(rebuilt) > 1e-4) moved++;
      }
    }
    expect(moved).toBeGreaterThan(0);
    expect(worst).toBeLessThan(1e-4);
  });
});

describe('a person dressed in MakeHuman garments', () => {
  for (const seed of [3, 11, 42, 77]) {
    it(`fits its clothes, shoes and hair to its body and posture (seed ${seed})`, () => {
      const person = randomPerson(seed, seed);
      const plain = createPersonRig({
        data, skeleton, bodyRange, positions: morpher.shape(person.body, person.features), look: (({ outfit: _o, ...rest }) => rest)(person.look),
        capture: captureBind('male'), captureAxes: captureBindRotations('male'),
      });
      const { mesh, height } = dress(person);
      const pos = mesh.geometry.getAttribute('position');
      // It is a different geometry from the shells: the garments are there.
      expect(pos.count).not.toBe(plain.mesh.geometry.getAttribute('position').count);
      // Bound without distortion.
      mesh.skeleton.update();
      const p = new Vector3();
      let worst = 0, low = Infinity, high = -Infinity;
      for (let v = 0; v < pos.count; v += 23) {
        p.fromBufferAttribute(pos, v);
        const rest = p.clone();
        mesh.applyBoneTransform(v, p);
        worst = Math.max(worst, p.distanceTo(rest));
      }
      for (let v = 0; v < pos.count; v++) { low = Math.min(low, pos.getY(v)); high = Math.max(high, pos.getY(v)); }
      expect(worst).toBeLessThan(1e-4);
      // Shoes on the ground, nothing far above the head (a hat, hair).
      expect(low).toBeGreaterThan(-0.03);
      expect(high).toBeLessThan(height + 0.25);
      // Every garment vertex is close to the body it was fitted to: a
      // posture or a unit gone wrong puts clothes metres off.
      const bodyPts: Vector3[] = [];
      const plainPos = plain.mesh.geometry.getAttribute('position');
      for (let v = 0; v < plainPos.count; v += 7) bodyPts.push(new Vector3().fromBufferAttribute(plainPos, v));
      let far = 0;
      for (let v = pos.count - 1, k = 0; v >= 0 && k < 400; v -= 37, k++) {
        p.fromBufferAttribute(pos, v);
        let best = Infinity;
        for (const q of bodyPts) best = Math.min(best, q.distanceTo(p));
        far = Math.max(far, best);
      }
      expect(far).toBeLessThan(0.2);
    });
  }
});
