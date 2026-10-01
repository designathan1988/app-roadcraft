import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Vector3 } from 'three';
import { describe, expect, it } from 'vitest';

import { DEFAULT_MACRO } from '@people/body/macro';
import { Morpher, type PeoplePacks } from '@people/body/morph';
import { randomPerson } from '@people/spec';
import { createPersonRig, type SkeletonMeta } from '@render/people/personRig';
import type { PersonMeshData } from '@render/people/personMesh';
import { captureBind, neutralWalkFor, walkDuration } from '@render/citizenWalk';

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
    capture: captureBind('male'),
  });
};

describe('a MakeHuman person rigged for the crowd', () => {
  it('is bound without distortion: the skinned mesh at bind is the mesh', () => {
    const { mesh } = rigFor(0);
    mesh.skeleton.update();
    const p = new Vector3();
    const position = mesh.geometry.getAttribute('position');
    let worst = 0;
    for (let v = 0; v < position.count; v += 37) {
      p.fromBufferAttribute(position, v);
      const rest = p.clone();
      mesh.applyBoneTransform(v, p);
      worst = Math.max(worst, p.distanceTo(rest));
    }
    expect(worst).toBeLessThan(1e-4);
  });

  it('stands in the captures\' posture, its bones named as they name theirs', () => {
    const { scene } = rigFor(0);
    const capture = captureBind('male');
    for (const [bone, next] of [['Bip01_L_UpperArm', 'Bip01_L_Forearm'], ['Bip01_R_Thigh', 'Bip01_R_Calf']] as const) {
      const a = scene.getObjectByName(bone)!.getWorldPosition(new Vector3());
      const b = scene.getObjectByName(next)!.getWorldPosition(new Vector3());
      const mine = b.sub(a).normalize();
      const theirs = capture.get(next)!.clone().sub(capture.get(bone)!).normalize();
      expect(mine.angleTo(theirs)).toBeLessThan(0.02);
    }
  });

  it('walks the Rocketbox walk: feet forward and back in turn, the body whole', () => {
    for (const seed of [0, 11, 23]) {
      const { scene, mesh, height } = rigFor(seed);
      const walk = neutralWalkFor(scene, mesh, 'male');
      const position = mesh.geometry.getAttribute('position');
      // A vertex at each heel: the lowest body vertex on each side.
      let left = -1, right = -1;
      for (let v = 0; v < position.count; v++) {
        const x = position.getX(v), y = position.getY(v);
        if (x > 0.05 && (left < 0 || y < position.getY(left))) left = v;
        if (x < -0.05 && (right < 0 || y < position.getY(right))) right = v;
      }
      const leads: number[] = [];
      let tallest = 0;
      const p = new Vector3();
      for (let i = 0; i < 8; i++) {
        walk.pose((i / 8) * walkDuration('male'));
        scene.updateMatrixWorld(true);
        mesh.skeleton.update();
        const at = (v: number): Vector3 => mesh.applyBoneTransform(v, p.fromBufferAttribute(position, v).clone());
        leads.push(at(left).z - at(right).z);
        for (let v = 0; v < position.count; v += 97) tallest = Math.max(tallest, at(v).y);
        expect(Number.isFinite(leads.at(-1)!)).toBe(true);
      }
      // Each foot leads in its turn, by a real step.
      expect(Math.max(...leads)).toBeGreaterThan(0.2);
      expect(Math.min(...leads)).toBeLessThan(-0.2);
      expect(tallest).toBeGreaterThan(height * 0.85);
      expect(tallest).toBeLessThan(height * 1.12);
    }
  });
});

it('builds a rigged person in a fraction of a second', () => {
  const t0 = performance.now();
  for (let i = 0; i < 3; i++) rigFor(100 + i);
  const each = (performance.now() - t0) / 3;
  console.log(`rig ${each.toFixed(0)} ms per person`);
  expect(each).toBeLessThan(400);
});
