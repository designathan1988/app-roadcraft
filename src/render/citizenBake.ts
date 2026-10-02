/**
 * Baking a body's motion into bone palettes (`riggedCitizens.ts` draws them):
 * the clip slots, the bakes, and the rig they are baked on. Free of the DOM,
 * so the same code runs on the main thread and in the bake workers
 * (`citizenBake.worker.ts`), which take the core clips off the main thread
 * behind the loading screen.
 */
import { Bone, BufferAttribute, BufferGeometry, Matrix4, Object3D, Quaternion, Skeleton, SkinnedMesh, Vector3 } from 'three';
import { clone } from 'three/addons/utils/SkeletonUtils.js';
import { RIDER_CLIPS, helmetShape, type RiderClip, type RiderClipKey } from './riderPoses';
import {
  WALK_ADVANCE, clipTransferFor, neutralWalkFor, strideShare, walkDuration, walkSource,
  type LibraryClip, type LibraryClipName, type RocketboxLibrary, type WalkAmplitude, type WalkSex,
} from './citizenWalk';
import { ELDER_AMPLITUDE, SHUFFLE_AMPLITUDE, REST_AMPLITUDE, bakeFps, gaitClipOf, type GaitClipName, type GaitClips } from './citizenGait';
import { directionalWalkFor } from './citizenStride';

/*
 * The citizen GLBs carry no clips. The Quaternius capture once converted onto
 * this skeleton is what hunched every walker, and nothing played it, so it was
 * stripped (`scripts/strip-citizen-animations.mjs`). A pedestrian plays
 * Rocketbox captures (`WALK`, `LIBRARY`), and a person in or on a vehicle an IK
 * pose (`RIDER_CLIPS`).
 */
/** The Rocketbox neutral walk of the body's sex, exactly as captured. */
export const WALK = 0;
/** The same walk with an older person's shorter step and quieter arms. */
export const WALK_ELDER = 1;
/** The Rocketbox slow walk with its swing shrunk: short steps, for inching along. */
export const WALK_SHUFFLE = 2;
/** The Rocketbox library clips, baked after the walks in this order. */
export const LIBRARY = [
  'start', 'stop', 'run', 'turnLeft', 'turnRight',
  'idle', 'look', 'phone', 'talk', 'listen', 'sitDown', 'sitIdle', 'standUp', 'walkSlow', 'walkDrunk',
  'read', 'bag', 'trolley', 'umbrella', 'cheer', 'dance', 'wave', 'drink', 'photo', 'crouchDown', 'crouchIdle', 'crouchUp', 'laugh', 'angry', 'argue', 'knock', 'headphones', 'eatIdle', 'workTable',
  'walkN1', 'walkN2', 'walkN3', 'walkStroll', 'walkCool', 'walkFast',
] as const satisfies readonly LibraryClipName[];
export type Played = (typeof LIBRARY)[number];
export const LIBRARY_AT = Object.fromEntries(LIBRARY.map((name, i) => [name, WALK_SHUFFLE + 1 + i])) as
  Readonly<Record<Played, number>>;
export const DIRECTIONAL = ['walkRest', 'walkBack', 'walkLeft', 'walkRight'] as const;
export const DIRECTIONAL_AT = Object.fromEntries(DIRECTIONAL.map((name, i) => [name, WALK_SHUFFLE + 1 + LIBRARY.length + i])) as
  Readonly<Record<(typeof DIRECTIONAL)[number], number>>;
/** Where each clip the gait plays (`citizenGait.ts`) is baked. */
export const GAIT_AT: Readonly<Record<GaitClipName, number>> = {
  ...LIBRARY_AT, ...DIRECTIONAL_AT, walk: WALK, walkElder: WALK_ELDER, walkShuffle: WALK_SHUFFLE,
  walkHandL: WALK_SHUFFLE + 1 + LIBRARY.length + DIRECTIONAL.length + RIDER_CLIPS.length,
  walkHandR: WALK_SHUFFLE + 2 + LIBRARY.length + DIRECTIONAL.length + RIDER_CLIPS.length,
};
/**
 * People in and on vehicles (`riderPoses.ts`): car seats reclined to fit a
 * cabin, astride a motorcycle, pedalling a bicycle. Baked after the library.
 */
export const RIDER_AT = Object.fromEntries(RIDER_CLIPS.map((clip, i) => [clip.key, WALK_SHUFFLE + 1 + LIBRARY.length + DIRECTIONAL.length + i])) as
  Readonly<Record<RiderClipKey, number>>;
/** The walk hand in hand, holding with the left or the right: baked after the riders. */
export const HAND_WALK_AT = { walkHandL: WALK_SHUFFLE + 1 + LIBRARY.length + DIRECTIONAL.length + RIDER_CLIPS.length,
  walkHandR: WALK_SHUFFLE + 2 + LIBRARY.length + DIRECTIONAL.length + RIDER_CLIPS.length } as const;
/**
 * The clips somebody carrying a box plays, baked again with both arms holding
 * it in front (`carryBox`), after the hand-in-hand walks. Drawing swaps each
 * for its carried twin, same timing, so the gait needs to know nothing of it.
 */
export const CARRIED = ['walk', 'walkShuffle', 'idle', 'turnLeft', 'turnRight', 'walkBack', 'walkLeft', 'walkRight'] as const satisfies readonly GaitClipName[];
export const CARRY_AT = Object.fromEntries(CARRIED.map((name, i) =>
  [name, WALK_SHUFFLE + 3 + LIBRARY.length + DIRECTIONAL.length + RIDER_CLIPS.length + i])) as
  Readonly<Partial<Record<GaitClipName, number>>>;
/** Anything `drawClip` can play. */
export type CitizenClipKey = RiderClipKey | 'walk' | Played;


export const FPS = 30;
export interface ClipFrames {
  data: Float32Array;
  /** Intervals between baked frames; `data` holds `frames + 2` rows (the last repeated). */
  frames: number; duration: number;
  /** Ground one cycle covers on this body at scale 1, metres. */
  stride: number;
  /** Height of the pelvis above the model origin in the first frame, metres. */
  pelvisY: number;
  /** The pelvis's offset from the origin in plan in the first frame (model +X left, +Z forward), metres. */
  pelvisX: number;
  pelvisZ: number;
  loop: boolean;
  /** Ground covered by each baked frame on this body at scale 1, metres (start, stop). */
  travel?: Float32Array;
  /** Angle turned by each baked frame, radians, unsigned (turns). */
  yaw?: Float32Array;
  /** A rider's head bone in the first frame, in the model's frame: where a helmet goes. */
  head?: Matrix4;
  /** Per baked frame, the right then the left hand bone, in the model's frame (16 + 16): where a held thing goes. */
  hands?: Float32Array;
}

/** Longest stretch of baking between two frames, milliseconds. */
export let SLICE_MS = 4;
/** Sets the longest stretch of baking between two frames (Infinity in a worker: nothing to yield to). */
export function setSliceMs(ms: number): void {
  SLICE_MS = ms;
}
export let sliceStart = 0;

/**
 * Lets the frame loop in once this stretch of baking has run for `SLICE_MS`.
 * A body bakes some twenty-five clips, and baked in one go each body a
 * pedestrian first needed was a frame of 100 to 350 ms: the hitch every few
 * seconds while the crowd's bodies loaded.
 */
export async function breathe(): Promise<void> {
  if (performance.now() - sliceStart < SLICE_MS) return;
  await afterFrame();
  sliceStart = performance.now();
}

/**
 * Resolves just after the next frame has been drawn: one slice of work per
 * frame. Resumed by a bare zero timeout, several slices ran back to back
 * between two frames and took the time the frame needed; waiting for the
 * browser's idle callback, a game drawing every frame never had any and the
 * bodies were never finished.
 */
export function afterFrame(): Promise<void> {
  if (typeof requestAnimationFrame !== 'function') return new Promise<void>(resolve => setTimeout(resolve, 0));
  return new Promise<void>(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)));
}

/** One copy of a body to bake on, and the way back to its rest pose. */
export interface BakeRig {
  readonly rig: Object3D;
  readonly mesh: SkinnedMesh;
  /** Puts every node back where the asset has it, as a fresh copy would be. */
  reset(): void;
}

export function restRig(scene: Object3D): BakeRig {
  const rig = clone(scene);
  let mesh: SkinnedMesh | undefined;
  rig.traverse(o => { if (o instanceof SkinnedMesh && !mesh) mesh = o; });
  if (!mesh) throw new Error('Citizen model has no rig');
  const rest: { o: Object3D; p: Vector3; q: Quaternion; s: Vector3 }[] = [];
  rig.traverse(o => rest.push({ o, p: o.position.clone(), q: o.quaternion.clone(), s: o.scale.clone() }));
  return {
    rig, mesh,
    reset() {
      for (const { o, p, q, s } of rest) {
        o.position.copy(p);
        o.quaternion.copy(q);
        o.scale.copy(s);
      }
      rig.updateMatrixWorld(true);
    },
  };
}

/**
 * Bakes a pose function into bone palettes: `frames` intervals over
 * `duration`, one row more for the end, one more repeated so interpolation
 * past the last frame reads a real pose.
 */
export async function bakeFrames(body: BakeRig, pose: (time: number) => void, duration: number,
  loop: boolean, fps = FPS, withHands = false): Promise<{ data: Float32Array; frames: number; pelvisY: number; pelvisX: number; pelvisZ: number; hands?: Float32Array }> {
  const { rig, mesh } = body;
  const skeleton = mesh.skeleton;
  const frames = Math.max(1, Math.round(duration * fps));
  const width = skeleton.bones.length * 16;
  const data = new Float32Array((frames + 2) * width);
  const pelvis = rig.getObjectByName('Bip01_Pelvis');
  const handR = withHands ? rig.getObjectByName('Bip01_R_Hand') : undefined;
  const handL = withHands ? rig.getObjectByName('Bip01_L_Hand') : undefined;
  const hands = handR && handL ? new Float32Array((frames + 2) * 32) : undefined;
  const position = new Vector3();
  let pelvisY = 0;
  let pelvisX = 0;
  let pelvisZ = 0;
  for (let i = 0; i <= frames; i++) {
    await breathe();
    pose(loop ? (i % frames) * duration / frames : i * duration / frames);
    skeleton.update();
    data.set(skeleton.boneMatrices!, i * width);
    if (hands) {
      handR!.updateWorldMatrix(true, false);
      handL!.updateWorldMatrix(true, false);
      hands.set(handR!.matrixWorld.elements, i * 32);
      hands.set(handL!.matrixWorld.elements, i * 32 + 16);
    }
    if (i === 0 && pelvis) {
      pelvis.getWorldPosition(position);
      pelvisY = position.y;
      pelvisX = position.x;
      pelvisZ = position.z;
    }
  }
  data.copyWithin((frames + 1) * width, frames * width, (frames + 1) * width);
  if (hands) hands.copyWithin((frames + 1) * 32, frames * 32, (frames + 1) * 32);
  return { data, frames, pelvisY, pelvisX, pelvisZ, ...(hands ? { hands } : {}) };
}

/**
 * Bakes the Rocketbox walk onto one body: `amplitude` untouched is the capture
 * as recorded, anything less the elder's. `stride` is the ground one cycle
 * covers on THIS body, so moving it by that much per cycle plants the feet.
 */
export async function bakeWalk(body: BakeRig, sex: WalkSex, amplitude?: WalkAmplitude, hand?: 'L' | 'R', carry = false): Promise<ClipFrames> {
  body.reset();
  const walk = neutralWalkFor(body.rig, body.mesh, sex, amplitude);
  const duration = walkDuration(sex);
  const baked = await bakeFrames(body, time => {
    walk.pose(time);
    if (hand) holdHandOut(body.rig, hand);
    if (carry) carryBox(body.rig);
  }, duration, true, FPS, carry);
  const share = amplitude ? strideShare(walkSource(sex), amplitude) : 1;
  return { ...baked, duration, loop: true, stride: WALK_ADVANCE[sex] * walk.scale * share };
}

/**
 * Bakes one library clip onto one body, with its travel and turn curves
 * resampled to the baked frames (`gaitClipOf`). A cycle baked with its swing
 * shrunk to `amplitude` covers that much less ground.
 */
export async function bakeLibraryClip(body: BakeRig, clip: LibraryClip, amplitude?: WalkAmplitude, name?: string, carry = false): Promise<ClipFrames> {
  body.reset();
  const transfer = clipTransferFor(body.rig, body.mesh, clip, amplitude);
  const room = LIMB_ROOM[name ?? ''] ?? LIMB_ROOM_DEFAULT;
  // A long standing or seated loop is slow motion, captured at 10 fps in the
  // library; baking it at 30 tripled the memory and the load for nothing.
  const baked = await bakeFrames(body, time => {
    transfer.pose(time);
    clearLimbs(body.rig, room[0], room[1]);
    if (carry) carryBox(body.rig);
  }, clip.duration, clip.loop, bakeFps(clip), carry || HELD_CLIPS.has(name ?? ''));
  const facts = gaitClipOf(clip, transfer.scale, baked.frames);
  const share = amplitude ? strideShare(clip.source, amplitude) : 1;
  return { ...baked, ...facts, stride: facts.stride * share };
}

/**
 * Room for the arms, by clip: how far the upper arms are carried out from the
 * body and the forearms lifted, degrees. The captures were taken on slimmer
 * bodies than the people they are played on: seated, the hands sank into the
 * thighs and the arms into the sides.
 */
export const LIMB_ROOM: Readonly<Record<string, readonly [number, number]>> = {
  sitIdle: [13, 16], sitDown: [11, 12], standUp: [11, 12],
  idle: [8, 0], look: [8, 0], listen: [8, 0], talk: [6, 0], phone: [5, 0],
  start: [6, 0], stop: [6, 0], run: [6, 0], walkSlow: [6, 0],
  turnLeft: [7, 0], turnRight: [7, 0], turnLeft180: [7, 0], turnRight180: [7, 0],
};
export const LIMB_ROOM_DEFAULT: readonly [number, number] = [6, 0];

/** The clips whose hands hold something (`HELD`): their hand bones are baked too. */
export const HELD_CLIPS = new Set(['read', 'drink', 'phone', 'photo', 'bag', 'umbrella']);

export const limbA = new Vector3(), limbB = new Vector3(), limbAxis = new Vector3();
export const limbQ = new Quaternion(), limbWorld = new Quaternion(), limbParent = new Quaternion();

/** Turns `bone` in world space by `q`, keeping its parent where it is. */
export function turnInWorld(bone: Object3D, q: Quaternion): void {
  bone.getWorldQuaternion(limbWorld);
  if (bone.parent) bone.parent.getWorldQuaternion(limbParent); else limbParent.identity();
  bone.quaternion.copy(limbParent.invert().multiply(q.clone().multiply(limbWorld)));
  bone.updateMatrixWorld(true);
}

/**
 * The arm on one side held out a little, straight and still, its hand low
 * and to the side where a partner walking abreast takes it: the walk hand in
 * hand. The rest of the body walks on.
 */
export function holdHandOut(rig: Object3D, side: 'L' | 'R'): void {
  rig.updateMatrixWorld(true);
  const chest = rig.getObjectByName('Bip01_Spine2');
  const upper = rig.getObjectByName(`Bip01_${side}_UpperArm`);
  const fore = rig.getObjectByName(`Bip01_${side}_Forearm`);
  const hand = rig.getObjectByName(`Bip01_${side}_Hand`);
  if (!chest || !upper || !fore || !hand) return;
  chest.getWorldPosition(limbB);
  upper.getWorldPosition(limbA);
  const out = limbA.clone().sub(limbB).setY(0);
  if (out.lengthSq() < 1e-8) return;
  out.normalize();
  // Out far enough that two people a metre apart meet hand to hand.
  const spread = 0.5;
  const want = new Vector3(0, -Math.cos(spread), 0).addScaledVector(out, Math.sin(spread)).normalize();
  for (const [bone, next] of [[upper, fore], [fore, hand]] as const) {
    const from = bone.getWorldPosition(new Vector3());
    const to = next.getWorldPosition(new Vector3());
    const dir = to.sub(from);
    if (dir.lengthSq() < 1e-10) continue;
    turnInWorld(bone, limbQ.setFromUnitVectors(dir.normalize(), want));
  }
}

/**
 * Both arms holding a box in front: the upper arms down and a little forward,
 * the forearms level and reaching ahead, the hands on the box's sides, thumbs
 * up and fingers forward (so the palms face each other, on either hand). The
 * legs, hips and head walk or stand on as the clip has them.
 */
export function carryBox(rig: Object3D): void {
  rig.updateMatrixWorld(true);
  const chest = rig.getObjectByName('Bip01_Spine2');
  if (!chest) return;
  const forward = new Vector3(0, 0, 1);
  for (const side of ['L', 'R'] as const) {
    const upper = rig.getObjectByName(`Bip01_${side}_UpperArm`);
    const fore = rig.getObjectByName(`Bip01_${side}_Forearm`);
    const hand = rig.getObjectByName(`Bip01_${side}_Hand`);
    const finger = rig.getObjectByName(`Bip01_${side}_Finger2`);
    const thumb = rig.getObjectByName(`Bip01_${side}_Finger0`);
    if (!upper || !fore || !hand) continue;
    chest.getWorldPosition(limbB);
    upper.getWorldPosition(limbA);
    const out = limbA.clone().sub(limbB).setY(0);
    out.addScaledVector(forward, -out.dot(forward));
    if (out.lengthSq() < 1e-8) continue;
    out.normalize();
    const aims: [Object3D, Object3D, Vector3][] = [
      [upper, fore, new Vector3().addScaledVector(out, 0.14).add(new Vector3(0, -0.95, 0)).addScaledVector(forward, 0.12).normalize()],
      [fore, hand, new Vector3().addScaledVector(out, -0.2).add(new Vector3(0, 0.12, 0)).addScaledVector(forward, 1).normalize()],
    ];
    if (finger) aims.push([hand, finger, new Vector3().addScaledVector(out, -0.1).addScaledVector(forward, 1).normalize()]);
    for (const [bone, next, want] of aims) {
      const from = bone.getWorldPosition(new Vector3());
      const dir = next.getWorldPosition(new Vector3()).sub(from);
      if (dir.lengthSq() < 1e-10) continue;
      turnInWorld(bone, limbQ.setFromUnitVectors(dir.normalize(), want));
    }
    if (finger && thumb) {
      // Rolled about the fingers until the thumb is up.
      const at = hand.getWorldPosition(new Vector3());
      const along = finger.getWorldPosition(new Vector3()).sub(at).normalize();
      const t = thumb.getWorldPosition(new Vector3()).sub(at);
      t.addScaledVector(along, -t.dot(along));
      const up = new Vector3(0, 1, 0).addScaledVector(along, -along.y);
      if (t.lengthSq() > 1e-10 && up.lengthSq() > 1e-10) {
        t.normalize(); up.normalize();
        const angle = Math.atan2(new Vector3().crossVectors(t, up).dot(along), t.dot(up));
        turnInWorld(hand, limbQ.setFromAxisAngle(along, angle));
      }
    }
  }
}

/**
 * Carries each upper arm out from the chest by `abduct` degrees and lifts each
 * forearm by `lift`, on the pose the rig is in, so a body broader than the
 * capture's keeps its limbs outside itself.
 */
export function clearLimbs(rig: Object3D, abduct: number, lift: number): void {
  if (abduct <= 0 && lift <= 0) return;
  rig.updateMatrixWorld(true);
  const chest = rig.getObjectByName('Bip01_Spine2');
  if (!chest) return;
  chest.getWorldPosition(limbB);
  for (const side of ['L', 'R']) {
    const upper = rig.getObjectByName(`Bip01_${side}_UpperArm`);
    const fore = rig.getObjectByName(`Bip01_${side}_Forearm`);
    const hand = rig.getObjectByName(`Bip01_${side}_Hand`);
    if (!upper || !fore) continue;
    if (abduct > 0) {
      // Out, away from the chest: about the axis that turns "down" towards it.
      upper.getWorldPosition(limbA);
      const out = limbA.sub(limbB).setY(0);
      if (out.lengthSq() > 1e-8) {
        out.normalize();
        limbAxis.set(0, -1, 0).cross(out).normalize();
        turnInWorld(upper, limbQ.setFromAxisAngle(limbAxis, (abduct * Math.PI) / 180));
      }
    }
    if (lift > 0 && hand) {
      // The forearm turned up, about the axis across its own length.
      fore.getWorldPosition(limbA);
      hand.getWorldPosition(limbB.clone());
      const along = new Vector3();
      hand.getWorldPosition(along);
      along.sub(limbA);
      if (along.lengthSq() > 1e-8) {
        along.normalize();
        limbAxis.copy(along).cross(new Vector3(0, 1, 0)).normalize();
        if (limbAxis.lengthSq() > 1e-8) turnInWorld(fore, limbQ.setFromAxisAngle(limbAxis, (-lift * Math.PI) / 180));
      }
      chest.getWorldPosition(limbB);
    }
  }
}

/**
 * Bakes everything one body plays, on one copy of it put back to rest between
 * clips, a few milliseconds at a time. No skeleton traversal occurs during
 * drawing.
 */
/**
 * The library clips every walker plays all the time (starting, stopping,
 * turning, standing, the walks); the rest - gestures, sitting, crouching -
 * are baked the first time this body plays them (`Deferred`).
 */
export const CORE_LIBRARY: ReadonlySet<Played> = new Set<Played>([
  'start', 'stop', 'run', 'turnLeft', 'turnRight', 'idle', 'walkSlow',
  'walkN1', 'walkN2', 'walkN3', 'walkStroll', 'walkCool', 'walkFast',
]);

/**
 * A clip baked on first use: what to bake, and what stands in for it the
 * moment before (the standing idle for a gesture, the bare walk for a carried
 * one). Baking all of them at load was some 8,000 frames a body, 2.5 GB and
 * a minute and a half of the main thread for the roster; most bodies never
 * play most of them (load on demand, as engines stream animation).
 */
/**
 * The seated poses with the head turned (or a phone in hand), baked on first
 * use like the gestures: until then the same seat looking ahead stands in.
 * Each is a seated loop solved by IK frame by frame, the dearest bake there is.
 */
export const RIDER_BASE: Readonly<Partial<Record<RiderClipKey, RiderClipKey>>> = {
  carDriveMirror: 'carDrive', carDriveRight: 'carDrive',
  carRideLeft: 'carRide', carRideRight: 'carRide',
  carRearLeft: 'carRearRide', carRearRight: 'carRearRide',
  cabDriveMirror: 'cabDrive', cabDriveRight: 'cabDrive',
  cabRideLeft: 'cabRide', cabRideRight: 'cabRide',
  chairSitLeft: 'chairSit', chairSitRight: 'chairSit', chairSitPhone: 'chairSit',
};

export type Deferred = Map<number, { readonly make: () => Promise<ClipFrames>; readonly standIn: number }>;

export async function bake(scene: Object3D, sex: WalkSex, library: RocketboxLibrary,
  given?: readonly (ClipFrames | undefined)[]): Promise<{ clips: ClipFrames[]; helmet: Matrix4 | null; deferred: Deferred }> {
  const body = restRig(scene);
  // A helmet is fitted to this head, at rest, once.
  const helmet = helmetShape(body.rig);
  const clips: ClipFrames[] = [];
  // The elder's step, and the shuffle's, cover less ground in the same time,
  // in proportion to how far the feet then reach fore and aft (`strideShare`).
  clips[WALK] = given?.[WALK] ?? await bakeWalk(body, sex);
  clips[WALK_ELDER] = given?.[WALK_ELDER] ?? await bakeWalk(body, sex, ELDER_AMPLITUDE);
  clips[WALK_SHUFFLE] = given?.[WALK_SHUFFLE] ?? await bakeLibraryClip(body, library[sex].walkSlow, SHUFFLE_AMPLITUDE);
  const deferred: Deferred = new Map();
  for (const name of LIBRARY) {
    if (CORE_LIBRARY.has(name)) clips[LIBRARY_AT[name]] = given?.[LIBRARY_AT[name]] ?? await bakeLibraryClip(body, library[sex][name], undefined, name);
    else deferred.set(LIBRARY_AT[name], {
      make: () => bakeLibraryClip(body, library[sex][name], undefined, name),
      standIn: name === 'walkDrunk' ? WALK : LIBRARY_AT.idle,
    });
  }
  body.reset();
  const rest = clipTransferFor(body.rig, body.mesh, library[sex].walkSlow, REST_AMPLITUDE);
  clips[DIRECTIONAL_AT.walkRest] = given?.[DIRECTIONAL_AT.walkRest] ??
    { ...await bakeFrames(body, () => rest.pose(0), 1, true, 1), frames: 1, duration: 1, loop: true, stride: 0 };
  const directional = async (angle: number, carry: boolean): Promise<ClipFrames> => {
    body.reset();
    const warped = directionalWalkFor(body.rig, body.mesh, library[sex].walkSlow, SHUFFLE_AMPLITUDE, angle);
    const facts = clips[WALK_SHUFFLE]!;
    const frames = await bakeFrames(body, time => { warped.pose(time); if (carry) carryBox(body.rig); }, facts.duration, true, FPS, carry);
    return { ...frames, duration: facts.duration, loop: true, stride: facts.stride * warped.strideScale };
  };
  const SIDEWAYS = [['walkBack', Math.PI], ['walkLeft', Math.PI / 2], ['walkRight', -Math.PI / 2]] as const;
  for (const [name, angle] of SIDEWAYS) clips[DIRECTIONAL_AT[name]] = given?.[DIRECTIONAL_AT[name]] ?? await directional(angle, false);
  for (const clip of RIDER_CLIPS) {
    const base = RIDER_BASE[clip.key];
    if (base) deferred.set(RIDER_AT[clip.key], { make: () => bakeRiderClip(body, clip), standIn: RIDER_AT[base] });
    else clips[RIDER_AT[clip.key]] = given?.[RIDER_AT[clip.key]] ?? await bakeRiderClip(body, clip);
  }
  clips[HAND_WALK_AT.walkHandL] = given?.[HAND_WALK_AT.walkHandL] ?? await bakeWalk(body, sex, undefined, 'L');
  clips[HAND_WALK_AT.walkHandR] = given?.[HAND_WALK_AT.walkHandR] ?? await bakeWalk(body, sex, undefined, 'R');
  // Carrying a box: every clip again with the box in both hands, on first use.
  const carried = (name: (typeof CARRIED)[number], make: () => Promise<ClipFrames>): void => {
    deferred.set(CARRY_AT[name]!, { make, standIn: GAIT_AT[name] });
  };
  carried('walk', () => bakeWalk(body, sex, undefined, undefined, true));
  carried('walkShuffle', () => bakeLibraryClip(body, library[sex].walkSlow, SHUFFLE_AMPLITUDE, undefined, true));
  for (const name of ['idle', 'turnLeft', 'turnRight'] as const) {
    carried(name, () => bakeLibraryClip(body, library[sex][name], undefined, name, true));
  }
  // Stepping aside or back with the box, too: it never leaves the hands.
  for (const [name, angle] of SIDEWAYS) carried(name, () => directional(angle, true));
  // Until baked, each points at what stands in for it.
  for (const [at, { standIn }] of deferred) clips[at] = clips[standIn]!;
  return { clips, helmet, deferred };
}

/**
 * Bakes one IK pose of a person in or on a vehicle. The rig is put back to its
 * rest pose before every frame, because the IK aims bones from wherever they
 * are. A still pose needs two frames, not thirty.
 */
export async function bakeRiderClip(body: BakeRig, clip: RiderClip): Promise<ClipFrames> {
  const pose = (time: number): void => {
    body.reset();
    clip.pose(body.rig, time);
  };
  // A held pose is two frames; a seated idle loop (`SEATED_IDLE` s) six a
  // second, enough for breathing and a turn of the head.
  const still = clip.key !== 'bikePedal' && clip.duration <= 1;
  const baked = await bakeFrames(body, pose, clip.duration, clip.loop, still ? 2 : clip.key === 'bikePedal' ? FPS : 6);
  pose(0);
  const head = body.rig.getObjectByName('Bip01_Head')?.matrixWorld.clone();
  return { ...baked, duration: clip.duration, loop: clip.loop, stride: 1, ...(head ? { head } : {}) };
}

/** The baked clips of one body, by the name the gait plays them by. */
export function gaitClips(clips: readonly ClipFrames[]): GaitClips {
  return Object.fromEntries(Object.entries(GAIT_AT).map(([name, at]) => [name, clips[at]!])) as unknown as GaitClips;
}


// ---------------------------------------------------------------- the rig, as data for a worker

/** One node of a rig: bone, skinned mesh or plain node, its parent and rest transform. */
export interface RigNode {
  readonly name: string;
  readonly kind: 'bone' | 'skinned' | 'node';
  readonly parent: number;
  readonly p: readonly number[];
  readonly q: readonly number[];
  readonly s: readonly number[];
  /** A skinned mesh: its bones (node indices), their inverses, its bind, and the vertex data the bakes read (feet, head). */
  readonly skin?: {
    readonly bones: readonly number[];
    readonly inverses: Float32Array;
    readonly bind: readonly number[];
    readonly bindMode: string;
    readonly position: Float32Array;
    readonly skinIndex: Float32Array;
    readonly skinWeight: Float32Array;
  };
}

/** A rig as plain data, and the buffers to transfer with it. */
export function rigData(scene: Object3D): { readonly nodes: RigNode[]; readonly transfer: ArrayBuffer[] } {
  const order: Object3D[] = [];
  scene.traverse((o) => order.push(o));
  const at = new Map(order.map((o, i) => [o, i] as const));
  const transfer: ArrayBuffer[] = [];
  const copy = (a: ArrayLike<number>): Float32Array => { const f = Float32Array.from(a); transfer.push(f.buffer as ArrayBuffer); return f; };
  const nodes = order.map((o): RigNode => {
    const base = { name: o.name, parent: o.parent && at.has(o.parent) ? at.get(o.parent)! : -1,
      p: o.position.toArray(), q: o.quaternion.toArray(), s: o.scale.toArray() };
    if (o instanceof SkinnedMesh) {
      const g = o.geometry;
      const inverses = new Float32Array(o.skeleton.boneInverses.length * 16);
      o.skeleton.boneInverses.forEach((m, i) => inverses.set(m.elements, i * 16));
      transfer.push(inverses.buffer as ArrayBuffer);
      return { ...base, kind: 'skinned', skin: {
        bones: o.skeleton.bones.map((b) => at.get(b) ?? -1), inverses, bind: [...o.bindMatrix.elements], bindMode: o.bindMode,
        position: copy(g.getAttribute('position').array as ArrayLike<number>),
        skinIndex: copy(g.getAttribute('skinIndex').array as ArrayLike<number>),
        skinWeight: copy(g.getAttribute('skinWeight').array as ArrayLike<number>),
      } };
    }
    return { ...base, kind: (o as Bone).isBone ? 'bone' : 'node' };
  });
  return { nodes, transfer };
}

/** The rig rebuilt from `rigData`: the same bones, binds and vertices, no materials. */
export function rigFromData(nodes: readonly RigNode[]): Object3D {
  const built: Object3D[] = nodes.map((n) => {
    let o: Object3D;
    if (n.kind === 'bone') o = new Bone();
    else if (n.kind === 'skinned' && n.skin) {
      const g = new BufferGeometry();
      g.setAttribute('position', new BufferAttribute(n.skin.position, 3));
      g.setAttribute('skinIndex', new BufferAttribute(n.skin.skinIndex, 4));
      g.setAttribute('skinWeight', new BufferAttribute(n.skin.skinWeight, 4));
      o = new SkinnedMesh(g);
    } else o = new Object3D();
    o.name = n.name;
    o.position.fromArray(n.p as number[]);
    o.quaternion.fromArray(n.q as number[]);
    o.scale.fromArray(n.s as number[]);
    return o;
  });
  nodes.forEach((n, i) => { if (n.parent >= 0) built[n.parent]!.add(built[i]!); });
  const root = built[0]!;
  root.updateMatrixWorld(true);
  nodes.forEach((n, i) => {
    if (!n.skin) return;
    const mesh = built[i] as SkinnedMesh;
    const bones = n.skin.bones.map((b) => built[b] as Bone);
    const inverses = bones.map((_, k) => new Matrix4().fromArray(n.skin!.inverses, k * 16));
    mesh.bindMode = n.skin.bindMode as SkinnedMesh['bindMode'];
    mesh.bind(new Skeleton(bones, inverses), new Matrix4().fromArray(n.skin.bind as number[]));
  });
  return root;
}
