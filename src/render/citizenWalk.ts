import { Matrix4, Object3D, Quaternion, Vector3, type SkinnedMesh } from 'three';
import maleSource from './motion/walkMale.json?raw';
import femaleSource from './motion/walkFemale.json?raw';
import maleLibraryUrl from './motion/rocketboxMale.json?url';
import femaleLibraryUrl from './motion/rocketboxFemale.json?url';

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
  /** A cycle that repeats (the walk); a one-shot holds its last frame. */
  readonly loop?: boolean;
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
/**
 * Prepares a capture for transfer. `bindFrom` is the capture whose avatar it
 * was recorded on: the library clips share their sex's walk avatar (see
 * `scripts/extract-rocketbox-clips.mjs`), so they share its bind pose.
 */
function sourceOf(file: WalkFile, bindFrom: WalkFile = file): Source {
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
    bindInverse: bindFrom.bind.map(b => quaternion(b.q).invert()),
    pelvisBind: vector(bindFrom.bind[pelvis]?.p ?? [0, 0, 0]),
    mean,
    pelvisMean,
  };
}
const WALKS = {
  male: { ...(JSON.parse(maleSource) as WalkFile), loop: true },
  female: { ...(JSON.parse(femaleSource) as WalkFile), loop: true },
} as const;
const SOURCES = { male: sourceOf(WALKS.male), female: sourceOf(WALKS.female) } as const;
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
  return transferOnto(rig, mesh, SOURCES[sex], amplitude);
}

/** The same transfer, for a clip of the Rocketbox library (`loadRocketboxLibrary`). */
export function clipTransferFor(rig: Object3D, mesh: SkinnedMesh, clip: LibraryClip,
  amplitude: WalkAmplitude = FULL): NeutralWalk {
  return transferOnto(rig, mesh, clip.source, amplitude);
}

/**
 * Where each bone of a capture's avatar stands in its bind pose, metres, world:
 * the posture every transfer measures from. A body built for these captures
 * (`render/people/personRig.ts`) is put in the same posture before it is bound.
 */
export function captureBind(sex: WalkSex): ReadonlyMap<string, Vector3> {
  const file = SOURCES[sex].file;
  return new Map(file.bones.map((name, i) => [name, vector(file.bind[i]?.p ?? [0, 0, 0])]));
}

/** The neutral walk of one sex as a transfer source, for `strideShare`. */
export const walkSource = (sex: WalkSex): Source => SOURCES[sex];

/**
 * The share of a cycle's stride left once its swing is shrunk to
 * `amplitude`: how far the feet reach fore and aft of the hips, against the
 * capture's own reach.
 *
 * Measured on the capture's avatar from its world rotations alone — each leg
 * bone turned from its bind pose, its bind offset to the next joint carried
 * along — so the renderer and the tests answer it the same way, with no
 * skinned body to pose. Scaling a swing about its mean shortens the step in
 * proportion to how far the feet then travel under the body, and moving the
 * body by anything else over a cycle skates the feet.
 */
export function strideShare(source: Source, amplitude: WalkAmplitude): number {
  const { file, bindInverse, mean } = source;
  const reach = (share: number): number => {
    let low = Infinity, high = -Infinity;
    const q = new Quaternion();
    const offset = new Vector3();
    for (const side of ['L', 'R']) {
      const chain = ['Thigh', 'Calf', 'Foot'].map(part => file.bones.indexOf(`Bip01_${side}_${part}`));
      if (chain.some(i => i < 0)) continue;
      for (const frame of file.frames) {
        const foot = new Vector3();
        for (let k = 0; k < chain.length - 1; k++) {
          const bone = chain[k]!;
          q.copy(quaternion(frame.q[bone]!));
          if (share !== 1) q.copy(mean[bone]!.clone().slerp(q, share));
          q.multiply(bindInverse[bone]!);
          offset.copy(vector(file.bind[chain[k + 1]!]!.p)).sub(vector(file.bind[bone]!.p)).applyQuaternion(q);
          foot.add(offset);
        }
        low = Math.min(low, foot.z);
        high = Math.max(high, foot.z);
      }
    }
    return high - low;
  };
  return reach(amplitude.legs) / Math.max(1e-6, reach(1));
}

function transferOnto(rig: Object3D, mesh: SkinnedMesh, from: Source, amplitude: WalkAmplitude): NeutralWalk {
  const { file: WALK, bindInverse: SOURCE_BIND_INVERSE, pelvisBind: SOURCE_PELVIS_BIND,
    mean: SOURCE_MEAN, pelvisMean: SOURCE_PELVIS_MEAN } = from;
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
  const loop = WALK.loop !== false;
  const at = (time: number): { k0: number; k1: number; f: number } => {
    if (!loop) {
      // A one-shot's frames span its whole duration, last frame included.
      const x = Math.min(1, Math.max(0, time / WALK.duration)) * (count - 1);
      const k0 = Math.min(count - 1, Math.floor(x));
      return { k0, k1: Math.min(count - 1, k0 + 1), f: x - k0 };
    }
    const x = ((time / WALK.duration) % 1 + 1) % 1 * count;
    const k0 = Math.floor(x) % count;
    return { k0, k1: (k0 + 1) % count, f: x - Math.floor(x) };
  };
  const q0 = new Quaternion();
  const q1 = new Quaternion();
  const want = new Quaternion();
  const parentInverse = new Quaternion();
  const travel = new Vector3();
  const next = new Vector3();
  const hip = new Vector3();
  const foot = new Vector3();

  // World rotations for the current frame, top-down: a node's is its
  // parent's times its own. The links are posed shallowest first, so every
  // parent a link asks for is final by then. Asking three for it
  // (`getWorldQuaternion`) recomposed the whole chain above every bone, every
  // frame, and that was most of the time a body took to bake.
  const worldQ = new Map<Object3D, Quaternion>();
  const stamp = new Map<Object3D, number>();
  let frame = 0;
  const worldRotation = (o: Object3D): Quaternion => {
    let q = worldQ.get(o);
    if (!q) {
      q = new Quaternion();
      worldQ.set(o, q);
    }
    if (stamp.get(o) !== frame) {
      if (o.parent) q.multiplyQuaternions(worldRotation(o.parent), o.quaternion);
      else q.copy(o.quaternion);
      stamp.set(o, frame);
    }
    return q;
  };

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
      travel.fromArray(a.pelvis).lerp(next.fromArray(b.pelvis), f)
        .sub(SOURCE_PELVIS_MEAN).multiplyScalar(amplitude.hips)
        .add(SOURCE_PELVIS_MEAN).sub(SOURCE_PELVIS_BIND).multiplyScalar(scale);
      placePelvis();
      frame++;
      for (const link of links) {
        // World rotation now = (source now × source bind⁻¹) × this body's bind.
        q0.fromArray(a.q[link.source]!).slerp(q1.fromArray(b.q[link.source]!), f);
        if (link.swing !== 1) q0.copy(q1.copy(SOURCE_MEAN[link.source]!).slerp(q0, link.swing));
        want.copy(q0).multiply(SOURCE_BIND_INVERSE[link.source]!).multiply(link.bind);
        const parent = link.bone.parent;
        if (parent) link.bone.quaternion.multiplyQuaternions(parentInverse.copy(worldRotation(parent)).invert(), want);
        else link.bone.quaternion.copy(want);
      }
      rig.updateMatrixWorld(true);
      if (untouched || !feet.length) return;
      // A shorter swing leaves the legs straighter under the hips, which would
      // sink the feet into the ground; the hips rise by what the feet sank.
      let lowest = Infinity;
      for (const bone of feet) lowest = Math.min(lowest, foot.setFromMatrixPosition(bone.matrixWorld).y);
      travel.y += lowestAt(time) - lowest;
      placePelvis();
      rig.updateMatrixWorld(true);
    },
    lowestAt,
  };
}

// ------------------------------------------------------------------ library

/** The clips of the Rocketbox library, by the name the renderer plays them by. */
export type LibraryClipName =
  | 'start' | 'stop' | 'run' | 'walkSlow'
  | 'turnLeft' | 'turnRight' | 'turnLeft180' | 'turnRight180'
  | 'idle' | 'look' | 'phone' | 'talk' | 'listen'
  | 'sitDown' | 'sitIdle' | 'standUp';

/**
 * One clip of the library, decoded and ready to transfer.
 *
 * Besides the pose, each carries what the game needs to keep the feet planted
 * while it moves the body itself: `travel`, the ground covered by each frame
 * (walk start and stop, the run), and `yaw`, how far the body has turned by
 * each frame (the turns on the spot), both in the capture's own metres and
 * radians, one value per frame.
 */
export interface LibraryClip {
  readonly name: LibraryClipName;
  readonly kind: 'forward' | 'cycle' | 'turn' | 'static' | 'sit';
  readonly loop: boolean;
  readonly duration: number;
  /** Ground covered by the whole clip (a cycle: one cycle), metres. */
  readonly advance: number;
  /** Angle turned by the whole clip, radians; positive turns left. */
  readonly turned: number;
  readonly travel: Float32Array;
  readonly yaw: Float32Array;
  readonly source: Source;
}
export type RocketboxLibrary = Readonly<Record<WalkSex, Readonly<Record<LibraryClipName, LibraryClip>>>>;

interface LibraryFile {
  readonly bones: readonly string[];
  readonly clips: Readonly<Record<LibraryClipName, {
    kind: LibraryClip['kind']; loop: boolean; frames: number; duration: number;
    advance: number; turned: number;
    q: string; pelvis: string; travel: string; yaw: string; lowest: string;
  }>>;
}

function bytes(base64: string): ArrayBuffer {
  const text = atob(base64);
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i);
  return out.buffer;
}

/** Decodes both libraries, as fetched (`loadRocketboxLibrary`) or read from disk (tests). */
export function decodeRocketboxLibrary(male: unknown, female: unknown): RocketboxLibrary {
  return { male: decode(male as LibraryFile, WALKS.male), female: decode(female as LibraryFile, WALKS.female) };
}

function decode(file: LibraryFile, walk: WalkFile): Record<LibraryClipName, LibraryClip> {
  const out = {} as Record<LibraryClipName, LibraryClip>;
  const bones = file.bones.length;
  for (const [name, clip] of Object.entries(file.clips) as [LibraryClipName, LibraryFile['clips'][LibraryClipName]][]) {
    const q = new Int16Array(bytes(clip.q));
    const pelvis = new Float32Array(bytes(clip.pelvis));
    const lowest = new Float32Array(bytes(clip.lowest));
    const frames = [];
    for (let k = 0; k < clip.frames; k++) {
      const rotations: number[][] = [];
      for (let b = 0; b < bones; b++) {
        const o = (k * bones + b) * 4;
        rotations.push([q[o]! / 32767, q[o + 1]! / 32767, q[o + 2]! / 32767, q[o + 3]! / 32767]);
      }
      frames.push({ q: rotations, pelvis: [pelvis[k * 3]!, pelvis[k * 3 + 1]!, pelvis[k * 3 + 2]!], lowest: lowest[k]! });
    }
    const capture: WalkFile = { duration: clip.duration, loop: clip.loop, bones: file.bones, bind: walk.bind,
      bindLowest: walk.bindLowest, frames };
    out[name] = {
      name, kind: clip.kind, loop: clip.loop, duration: clip.duration, advance: clip.advance, turned: clip.turned,
      travel: new Float32Array(bytes(clip.travel)), yaw: new Float32Array(bytes(clip.yaw)),
      source: sourceOf(capture, walk),
    };
  }
  return out;
}

let library: Promise<RocketboxLibrary> | null = null;

/**
 * The Microsoft Rocketbox clips the citizens play besides the walk: starting
 * and stopping, running, turning on the spot, standing, looking round, a
 * phone, talking and listening, sitting down, sitting and standing up, for
 * each sex, from `scripts/extract-rocketbox-clips.mjs`. About two megabytes a
 * sex, so they are fetched once, when the first citizen is prepared, rather
 * than carried in the bundle.
 */
export function loadRocketboxLibrary(): Promise<RocketboxLibrary> {
  library ??= Promise.all([maleLibraryUrl, femaleLibraryUrl].map(async (url) => {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Rocketbox motion library ${url}: ${response.status}`);
    return response.json() as Promise<LibraryFile>;
  })).then(([male, female]) => decodeRocketboxLibrary(male, female));
  return library;
}
