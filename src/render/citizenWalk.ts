import { Matrix4, Object3D, Quaternion, Vector3, type SkinnedMesh } from 'three';
import maleSource from './motion/walkMale.json?raw';
import femaleSource from './motion/walkFemale.json?raw';

/**
 * The official Rocketbox neutral walks — a man's (m_walk_neutral, captured on
 * Male_Adult_01) and a woman's (f_walk_neutral, on Female_Adult_01), MIT,
 * Copyright (c) 2020 Microsoft — transferred onto any citizen at bake time.
 *
 * The walk every citizen used to play was a Quaternius clip retargeted onto
 * the Rocketbox skeleton offline (`scripts/convert-citizens.mjs`). That rig is
 * a different body — its spine, its shoulders, its rest pose — and the
 * transfer is where the hunched trunk, the crouched knees and the arms that
 * read as broken came from. This is the walk captured FOR the Rocketbox
 * skeleton, extracted by `scripts/extract-citizen-walk.mjs` into
 * `motion/`. A man and a woman walk differently in the capture itself —
 * cadence, hips, arms — so each body walks the walk of its sex.
 *
 * It is stored as world rotations, so it is transferred as a rotation
 * relative to each body's own bind pose: whatever way an exporter happened to
 * orient a bone's local axes, "the thigh swung 25 degrees forward of where it
 * hangs in the bind pose" means the same thing on every body. The pelvis
 * travel is scaled by hip height, so a child's hips bob a child's amount.
 */
interface WalkFile {
  readonly duration: number;
  readonly bones: readonly string[];
  readonly bind: readonly { readonly q: readonly number[]; readonly p: readonly number[] }[];
  readonly bindLowest: number;
  readonly frames: readonly {
    readonly q: readonly (readonly number[])[];
    readonly pelvis: readonly number[];
    readonly lowest: number;
  }[];
}

const quaternion = (v: readonly number[]): Quaternion =>
  new Quaternion(v[0] ?? 0, v[1] ?? 0, v[2] ?? 0, v[3] ?? 1);
const vector = (v: readonly number[]): Vector3 => new Vector3(v[0] ?? 0, v[1] ?? 0, v[2] ?? 0);

interface Source {
  readonly file: WalkFile;
  /** Bind rotations, inverted once for all bodies. */
  readonly bindInverse: readonly Quaternion[];
  readonly pelvisBind: Vector3;
}
function source(text: string): Source {
  const file = JSON.parse(text) as WalkFile;
  const pelvis = file.bones.indexOf('Bip01_Pelvis');
  return {
    file,
    bindInverse: file.bind.map(b => quaternion(b.q).invert()),
    pelvisBind: vector(file.bind[pelvis]?.p ?? [0, 0, 0]),
  };
}
const SOURCES = { male: source(maleSource), female: source(femaleSource) } as const;
export type WalkSex = keyof typeof SOURCES;
/** Length of one cycle of each walk, seconds. */
export const walkDuration = (sex: WalkSex): number => SOURCES[sex].file.duration;

export interface NeutralWalk {
  /** Poses the rig at `time` (seconds, looping). Bones are left posed. */
  pose(time: number): void;
  /** Lowest foot joint the source has at `time`, scaled to this body. */
  lowestAt(time: number): number;
}

/**
 * Prepares the transfer onto one body. `rig` must be at rest (just cloned),
 * and `mesh` is its skinned mesh, whose skeleton's bind pose is the reference.
 */
export function neutralWalkFor(rig: Object3D, mesh: SkinnedMesh, sex: WalkSex): NeutralWalk {
  const { file: WALK, bindInverse: SOURCE_BIND_INVERSE, pelvisBind: SOURCE_PELVIS_BIND } = SOURCES[sex];
  rig.updateMatrixWorld(true);
  const bones = mesh.skeleton.bones;
  // The converted citizens keep their bind pose in the source FBX's own space
  // (Z up, centimetres, identity bind matrix); the mesh's world transform is
  // what brings it into the scene. Leaving it out laid every walker flat.
  const bindWorld = (index: number): Matrix4 =>
    mesh.matrixWorld.clone().multiply(mesh.bindMatrix)
      .multiply(mesh.skeleton.boneInverses[index]!.clone().invert());

  interface Link { bone: Object3D; source: number; bind: Quaternion; depth: number }
  const links: Link[] = [];
  WALK.bones.forEach((name, source) => {
    const index = bones.findIndex(b => b.name === name);
    if (index < 0) return;
    const bone = bones[index]!;
    const bind = new Quaternion();
    bindWorld(index).decompose(new Vector3(), bind, new Vector3());
    let depth = 0;
    for (let p = bone.parent; p; p = p.parent) depth++;
    links.push({ bone, source, bind, depth });
  });
  links.sort((a, b) => a.depth - b.depth);

  const pelvisIndex = bones.findIndex(b => b.name === 'Bip01_Pelvis');
  const pelvis = pelvisIndex >= 0 ? bones[pelvisIndex]! : undefined;
  const pelvisBind = pelvis ? new Vector3().setFromMatrixPosition(bindWorld(pelvisIndex)) : new Vector3();
  const footBind = ['Bip01_L_Foot', 'Bip01_R_Foot', 'Bip01_L_Toe0', 'Bip01_R_Toe0']
    .map(name => bones.findIndex(b => b.name === name)).filter(i => i >= 0)
    .map(i => new Vector3().setFromMatrixPosition(bindWorld(i)).y);
  const lowestBind = footBind.length ? Math.min(...footBind) : 0;
  // Hip height over the lowest foot joint, this body against the source's.
  const scale = (pelvisBind.y - lowestBind) / Math.max(0.1, SOURCE_PELVIS_BIND.y - WALK.bindLowest);

  const count = WALK.frames.length;
  const at = (time: number): { k0: number; k1: number; f: number } => {
    const x = ((time / WALK.duration) % 1 + 1) % 1 * count;
    const k0 = Math.floor(x) % count;
    return { k0, k1: (k0 + 1) % count, f: x - Math.floor(x) };
  };
  const q0 = new Quaternion();
  const q1 = new Quaternion();
  const want = new Quaternion();
  const parentWorld = new Quaternion();
  const travel = new Vector3();

  return {
    pose(time) {
      const { k0, k1, f } = at(time);
      const a = WALK.frames[k0]!;
      const b = WALK.frames[k1]!;
      if (pelvis?.parent) {
        travel.copy(vector(a.pelvis)).lerp(vector(b.pelvis), f).sub(SOURCE_PELVIS_BIND).multiplyScalar(scale);
        pelvis.parent.updateWorldMatrix(true, false);
        pelvis.position.copy(pelvis.parent.worldToLocal(pelvisBind.clone().add(travel)));
      }
      for (const link of links) {
        // World rotation now = (source now × source bind⁻¹) × this body's bind.
        q0.copy(quaternion(a.q[link.source]!)).slerp(q1.copy(quaternion(b.q[link.source]!)), f);
        want.copy(q0).multiply(SOURCE_BIND_INVERSE[link.source]!).multiply(link.bind);
        const parent = link.bone.parent;
        if (parent) {
          parent.getWorldQuaternion(parentWorld);
          link.bone.quaternion.copy(parentWorld.invert().multiply(want));
        } else {
          link.bone.quaternion.copy(want);
        }
        link.bone.updateWorldMatrix(false, false);
      }
      rig.updateMatrixWorld(true);
    },
    lowestAt(time) {
      const { k0, k1, f } = at(time);
      const lowest = WALK.frames[k0]!.lowest * (1 - f) + WALK.frames[k1]!.lowest * f;
      return lowestBind + (lowest - WALK.bindLowest) * scale;
    },
  };
}
