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
  /** Each bone's world rotation averaged over the cycle: the centre its swing is about. */
  readonly mean: readonly Quaternion[];
  /** Mean pelvis position over the cycle. */
  readonly pelvisMean: Vector3;
}
function source(text: string): Source {
  const file = JSON.parse(text) as WalkFile;
  const pelvis = file.bones.indexOf('Bip01_Pelvis');
  const mean = file.bones.map((_, bone) => {
    const first = quaternion(file.frames[0]!.q[bone]!);
    const sum = [0, 0, 0, 0];
    for (const frame of file.frames) {
      const q = frame.q[bone]!;
      // q and -q are the same rotation; average them on one hemisphere.
      const sign = first.x * q[0]! + first.y * q[1]! + first.z * q[2]! + first.w * q[3]! < 0 ? -1 : 1;
      for (let k = 0; k < 4; k++) sum[k]! += sign * q[k]!;
    }
    return quaternion(sum).normalize();
  });
  const pelvisMean = new Vector3();
  for (const frame of file.frames) pelvisMean.add(vector(frame.pelvis));
  pelvisMean.divideScalar(file.frames.length);
  return {
    file,
    bindInverse: file.bind.map(b => quaternion(b.q).invert()),
    pelvisBind: vector(file.bind[pelvis]?.p ?? [0, 0, 0]),
    mean,
    pelvisMean,
  };
}
const SOURCES = { male: source(maleSource), female: source(femaleSource) } as const;
export type WalkSex = keyof typeof SOURCES;
/** Length of one cycle of each walk, seconds. */
export const walkDuration = (sex: WalkSex): number => SOURCES[sex].file.duration;
/**
 * Ground covered by one cycle of each capture, metres, on its own avatar: the
 * forward travel of the packages' `Walk_Forward` clips (1.495864 m for the
 * man's, 1.596625 m for the woman's). Moving a body by anything else over one
 * cycle makes its feet skate.
 */
export const WALK_ADVANCE: Readonly<Record<WalkSex, number>> = { male: 1.495864, female: 1.596625 };

/**
 * How far each part of the body swings, as a share of the capture's own swing
 * about its mean pose. 1 everywhere is the capture untouched.
 *
 * This only ever SHRINKS a swing towards the posture the capture already
 * holds on average, so it can shorten a step or quieten the arms, but it can
 * never bend the trunk into a pose the capture does not have.
 */
export interface WalkAmplitude {
  /** Clavicles, arms, hands, fingers. */
  readonly arms: number;
  /** Thighs, calves, feet, toes. */
  readonly legs: number;
  /** Pelvis rotation and its rise and fall. */
  readonly hips: number;
}
const FULL: WalkAmplitude = { arms: 1, legs: 1, hips: 1 };

const ARM = /Clavicle|UpperArm|Forearm|Hand|Finger/;
const LEG = /Thigh|Calf|Foot|Toe/;

export interface NeutralWalk {
  /** Poses the rig at `time` (seconds, looping). Bones are left posed. */
  pose(time: number): void;
  /** Lowest foot joint the source has at `time`, scaled to this body. */
  lowestAt(time: number): number;
  /** This body's hip height over the source avatar's. */
  readonly scale: number;
}

/**
 * Prepares the transfer onto one body. `rig` must be at rest (just cloned),
 * and `mesh` is its skinned mesh, whose skeleton's bind pose is the reference.
 */
export function neutralWalkFor(rig: Object3D, mesh: SkinnedMesh, sex: WalkSex,
  amplitude: WalkAmplitude = FULL): NeutralWalk {
  const { file: WALK, bindInverse: SOURCE_BIND_INVERSE, pelvisBind: SOURCE_PELVIS_BIND,
    mean: SOURCE_MEAN, pelvisMean: SOURCE_PELVIS_MEAN } = SOURCES[sex];
  const untouched = amplitude.arms === 1 && amplitude.legs === 1 && amplitude.hips === 1;
  rig.updateMatrixWorld(true);
  const bones = mesh.skeleton.bones;
  // The converted citizens keep their bind pose in the source FBX's own space
  // (Z up, centimetres, identity bind matrix); the mesh's world transform is
  // what brings it into the scene. Leaving it out laid every walker flat.
  const bindWorld = (index: number): Matrix4 =>
    mesh.matrixWorld.clone().multiply(mesh.bindMatrix)
      .multiply(mesh.skeleton.boneInverses[index]!.clone().invert());

  interface Link { bone: Object3D; source: number; bind: Quaternion; depth: number; swing: number }
  const links: Link[] = [];
  WALK.bones.forEach((name, source) => {
    const index = bones.findIndex(b => b.name === name);
    if (index < 0) return;
    const bone = bones[index]!;
    const bind = new Quaternion();
    bindWorld(index).decompose(new Vector3(), bind, new Vector3());
    let depth = 0;
    for (let p = bone.parent; p; p = p.parent) depth++;
    const swing = ARM.test(name) ? amplitude.arms : LEG.test(name) ? amplitude.legs
      : name === 'Bip01_Pelvis' ? amplitude.hips : 1;
    links.push({ bone, source, bind, depth, swing });
  });
  links.sort((a, b) => a.depth - b.depth);

  const pelvisIndex = bones.findIndex(b => b.name === 'Bip01_Pelvis');
  const pelvis = pelvisIndex >= 0 ? bones[pelvisIndex]! : undefined;
  const pelvisBind = pelvis ? new Vector3().setFromMatrixPosition(bindWorld(pelvisIndex)) : new Vector3();
  const footIndices = ['Bip01_L_Foot', 'Bip01_R_Foot', 'Bip01_L_Toe0', 'Bip01_R_Toe0']
    .map(name => bones.findIndex(b => b.name === name)).filter(i => i >= 0);
  const footBind = footIndices.map(i => new Vector3().setFromMatrixPosition(bindWorld(i)).y);
  const lowestBind = footBind.length ? Math.min(...footBind) : 0;
  const feet = footIndices.map(i => bones[i]!);
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
  const hip = new Vector3();
  const foot = new Vector3();

  const lowestAt = (time: number): number => {
    const { k0, k1, f } = at(time);
    const lowest = WALK.frames[k0]!.lowest * (1 - f) + WALK.frames[k1]!.lowest * f;
    return lowestBind + (lowest - WALK.bindLowest) * scale;
  };
  const placePelvis = (): void => {
    if (!pelvis?.parent) return;
    pelvis.parent.updateWorldMatrix(true, false);
    pelvis.position.copy(pelvis.parent.worldToLocal(hip.copy(pelvisBind).add(travel)));
  };

  return {
    scale,
    pose(time) {
      const { k0, k1, f } = at(time);
      const a = WALK.frames[k0]!;
      const b = WALK.frames[k1]!;
      travel.copy(vector(a.pelvis)).lerp(vector(b.pelvis), f)
        .sub(SOURCE_PELVIS_MEAN).multiplyScalar(amplitude.hips)
        .add(SOURCE_PELVIS_MEAN).sub(SOURCE_PELVIS_BIND).multiplyScalar(scale);
      placePelvis();
      for (const link of links) {
        // World rotation now = (source now × source bind⁻¹) × this body's bind.
        q0.copy(quaternion(a.q[link.source]!)).slerp(q1.copy(quaternion(b.q[link.source]!)), f);
        if (link.swing !== 1) q0.copy(q1.copy(SOURCE_MEAN[link.source]!).slerp(q0, link.swing));
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
      if (untouched || !feet.length) return;
      // A shorter swing leaves the legs straighter under the hips, which would
      // sink the feet into the ground; the hips rise by what the feet sank.
      let lowest = Infinity;
      for (const bone of feet) lowest = Math.min(lowest, bone.getWorldPosition(foot).y);
      travel.y += lowestAt(time) - lowest;
      placePelvis();
      rig.updateMatrixWorld(true);
    },
    lowestAt,
  };
}
