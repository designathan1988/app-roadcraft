import { Bone, Object3D, Quaternion, Vector3 } from 'three';

/**
 * Poses for people sitting in and on vehicles, built on the citizens' own
 * skeleton by inverse kinematics.
 *
 * The seated clips the citizen assets ship with are CHAIR poses: measured on
 * the rig, the head is 0.91 m above the pelvis and the feet 0.54 m below it,
 * knees at a right angle. A car's cabin has 1.1 m between floor and roof
 * lining, so a driver in that pose had their head through the roof and their
 * feet through the floor - the "body parts sticking out of the car" players
 * reported. People on motorcycles and bicycles were not people at all, only
 * boxes, because no clip existed for sitting astride.
 *
 * A pose here is a handful of TARGETS in the pelvis frame - where the feet,
 * the hands and the head have to be - and two-bone IK puts the limbs there on
 * whatever body is being baked. Distances are in metres, in the model's frame:
 * +Z forward, +Y up, +X to the body's left (the Rocketbox convention).
 *
 * The poses are baked into bone palettes once per body, like every other clip
 * (`riggedCitizens.ts`); nothing here runs per frame.
 */

export type RiderClipKey =
  | 'carDrive' | 'carRide'
  | 'motoRide' | 'motoLeft' | 'motoRight' | 'motoStop'
  | 'bikePedal' | 'bikeLeft' | 'bikeRight' | 'bikeStop';

export interface RiderClip {
  readonly key: RiderClipKey;
  /** Seconds of the baked clip. A pedalling clip is one crank revolution. */
  readonly duration: number;
  readonly loop: boolean;
  /** Poses the rig at `time`; the rig starts from its rest pose each frame. */
  pose(rig: Object3D, time: number): void;
}

/** Targets for one pose, in metres in the pelvis frame. */
interface Targets {
  /** Forward lean of the trunk, radians (negative reclines). */
  readonly lean: number;
  /** Twist of the trunk towards the left, radians. */
  readonly twist?: number;
  readonly leftFoot: V3;
  readonly rightFoot: V3;
  readonly leftHand: V3;
  readonly rightHand: V3;
  /** Pole the knees bend towards (forward and up for a seated person). */
  readonly kneePole?: V3;
  /** Pole the elbows bend towards (down and out). */
  readonly elbowPole?: V3;
  /** Head pitch to keep the eyes on the road, radians (positive looks down). */
  readonly look?: number;
}

type V3 = readonly [number, number, number];

// ---------------------------------------------------------------- the poses

/**
 * A car seat: reclined a little, thighs near level, feet forward on the
 * pedals or the floor, and for the driver the hands on the wheel at ten to
 * two. Floor and wheel are placed to match `vehicleModels.ts` (hip point
 * 0.24 m above the floor, wheel 0.42 m ahead of it and 0.32 m up).
 */
const CAR_DRIVE: Targets = {
  // The rest pose already stoops about 0.2 rad forward; this reclines the
  // trunk some 28 degrees back from upright, as a car seat holds it.
  lean: -0.8,
  // Ankles a little above the floor and short of the firewall, so neither
  // heel nor toe passes through the cabin floor or into the engine bay.
  leftFoot: [0.17, -0.15, 0.62],
  rightFoot: [-0.14, -0.15, 0.64],
  leftHand: [0.17, 0.3, 0.4],
  rightHand: [-0.17, 0.3, 0.4],
  kneePole: [0, 1, 1],
  elbowPole: [0, -1, 0.2],
  look: -0.12,
};
const CAR_RIDE: Targets = {
  lean: -0.8,
  leftFoot: [0.16, -0.15, 0.6],
  rightFoot: [-0.16, -0.15, 0.6],
  leftHand: [0.13, 0.06, 0.3],
  rightHand: [-0.13, 0.06, 0.3],
  kneePole: [0, 1, 1],
  elbowPole: [0.3, -1, 0],
  look: -0.1,
};

/**
 * Astride a motorcycle: leaning into the tank, hands on the grips, feet on
 * the pegs a third of a metre off the road. Pelvis 0.78 m over the road.
 */
const MOTO: Targets = {
  lean: 0.25,
  leftFoot: [0.2, -0.46, 0.12],
  rightFoot: [-0.2, -0.46, 0.12],
  leftHand: [0.3, 0.3, 0.52],
  rightHand: [-0.3, 0.3, 0.52],
  kneePole: [0.6, 0, 1],
  elbowPole: [0.6, -1, 0],
  look: -0.1,
};
/** Stopped: the bike held upright on the left foot, the right on its peg. */
const MOTO_STOP: Targets = { ...MOTO, lean: 0.12, leftFoot: [0.38, -0.76, 0.1] };

/**
 * On a bicycle: the saddle 0.95 m up, a forward reach to the bars, and the
 * feet on the pedals, which turn round the bottom bracket.
 */
const BIKE: Omit<Targets, 'leftFoot' | 'rightFoot'> = {
  lean: 0.35,
  leftHand: [0.24, 0.24, 0.5],
  rightHand: [-0.24, 0.24, 0.5],
  kneePole: [0, 0.2, 1],
  elbowPole: [0.4, -1, 0],
  look: -0.2,
};
/** Bottom bracket in the pelvis frame, and the crank length. */
const BRACKET: V3 = [0, -0.62, 0.14];
const CRANK = 0.17;
/** Pedal centres sit this far either side of the frame. */
const PEDAL_SIDE = 0.12;

function pedal(angle: number, side: 1 | -1): V3 {
  return [side * PEDAL_SIDE, BRACKET[1] + Math.sin(angle) * CRANK, BRACKET[2] + Math.cos(angle) * CRANK];
}

/** Steering: the bars turn, one hand forward and the other back, the trunk follows a little. */
function steered(t: Targets, direction: 1 | -1): Targets {
  const swing = 0.07;
  return {
    ...t,
    twist: direction * 0.08,
    leftHand: [t.leftHand[0], t.leftHand[1], t.leftHand[2] - direction * swing],
    rightHand: [t.rightHand[0], t.rightHand[1], t.rightHand[2] + direction * swing],
  };
}

export const RIDER_CLIPS: readonly RiderClip[] = [
  still('carDrive', CAR_DRIVE),
  still('carRide', CAR_RIDE),
  still('motoRide', MOTO),
  still('motoLeft', steered(MOTO, 1)),
  still('motoRight', steered(MOTO, -1)),
  still('motoStop', MOTO_STOP),
  {
    key: 'bikePedal',
    duration: 1,
    loop: true,
    pose(rig, time) {
      const angle = time * Math.PI * 2;
      apply(rig, { ...BIKE, leftFoot: pedal(angle, 1), rightFoot: pedal(angle + Math.PI, -1) });
    },
  },
  still('bikeLeft', steered({ ...BIKE, leftFoot: pedal(0, 1), rightFoot: pedal(Math.PI, -1) }, 1)),
  still('bikeRight', steered({ ...BIKE, leftFoot: pedal(0, 1), rightFoot: pedal(Math.PI, -1) }, -1)),
  // Stopped: off the saddle's point onto the left foot, the right on its
  // pedal at the top of the stroke, ready to push off.
  still('bikeStop', { ...BIKE, lean: 0.15, leftFoot: [0.34, -0.93, 0.08], rightFoot: pedal(Math.PI * 0.6, -1) }),
];

/** The pelvis height a pose is baked for, metres above the vehicle's floor or the road. */
export const RIDER_PELVIS_HEIGHT: Readonly<Record<'moto' | 'bike', number>> = { moto: 0.78, bike: 0.95 };

function still(key: RiderClipKey, targets: Targets): RiderClip {
  return { key, duration: 1, loop: true, pose: (rig) => apply(rig, targets) };
}

// ---------------------------------------------------------------- solving

const BONES = {
  pelvis: 'Bip01_Pelvis',
  spine: ['Bip01_Spine', 'Bip01_Spine1', 'Bip01_Spine2'],
  neck: 'Bip01_Neck',
  head: 'Bip01_Head',
  leftLeg: ['Bip01_L_Thigh', 'Bip01_L_Calf', 'Bip01_L_Foot'],
  rightLeg: ['Bip01_R_Thigh', 'Bip01_R_Calf', 'Bip01_R_Foot'],
  leftArm: ['Bip01_L_UpperArm', 'Bip01_L_Forearm', 'Bip01_L_Hand'],
  rightArm: ['Bip01_R_UpperArm', 'Bip01_R_Forearm', 'Bip01_R_Hand'],
} as const;

const tmpA = new Vector3();
const tmpB = new Vector3();
const tmpC = new Vector3();
const qa = new Quaternion();
const qb = new Quaternion();
const qc = new Quaternion();

/** Poses the rig so its limbs reach the targets. The rig must be at its rest pose. */
function apply(rig: Object3D, t: Targets): void {
  const find = (name: string): Object3D | undefined => rig.getObjectByName(name);
  const pelvis = find(BONES.pelvis);
  if (!pelvis) return;
  rig.updateMatrixWorld(true);
  // The pelvis frame in world: its position, and the MODEL's axes (the rig's
  // root is unrotated when a clip is baked), so targets are body-relative.
  const origin = pelvis.getWorldPosition(new Vector3());
  const worldOf = (v: V3): Vector3 => new Vector3(v[0], v[1], v[2]).add(origin);

  // Trunk: lean and twist shared over the three spine bones.
  // Only the spine ABOVE the hips: in a biped rig the thighs may hang from the
  // lowest spine bone, and leaning that would swing the legs with the trunk.
  const thigh = find(BONES.leftLeg[0]);
  const spine = BONES.spine.map(find).filter((b): b is Object3D => !!b && !isAncestor(b, thigh));
  for (const bone of spine) {
    rotateWorld(bone, new Vector3(1, 0, 0), t.lean / spine.length);
    if (t.twist) rotateWorld(bone, new Vector3(0, 1, 0), t.twist / spine.length);
  }
  const head = find(BONES.head);
  if (head && t.look) rotateWorld(head, new Vector3(1, 0, 0), t.look - t.lean * 0.6);
  rig.updateMatrixWorld(true);

  limb(rig, BONES.leftLeg, worldOf(t.leftFoot), t.kneePole ?? [0, 0, 1]);
  limb(rig, BONES.rightLeg, worldOf(t.rightFoot), t.kneePole ?? [0, 0, 1]);
  limb(rig, BONES.leftArm, worldOf(t.leftHand), mirrorPole(t.elbowPole ?? [0, -1, 0], 1));
  limb(rig, BONES.rightArm, worldOf(t.rightHand), mirrorPole(t.elbowPole ?? [0, -1, 0], -1));
  // Feet flat-ish: the sole points forward and a little down.
  for (const name of [BONES.leftLeg[2], BONES.rightLeg[2]]) {
    const foot = find(name);
    if (foot) levelFoot(foot);
  }
  rig.updateMatrixWorld(true);
}

function isAncestor(bone: Object3D, of: Object3D | undefined): boolean {
  for (let o = of?.parent ?? null; o; o = o.parent) if (o === bone) return true;
  return false;
}

/** An elbow pole given for the left arm, mirrored to the right. */
const mirrorPole = (p: V3, side: 1 | -1): V3 => [p[0] * side, p[1], p[2]];

/** Rotates a bone by `angle` about a WORLD axis, keeping its parent. */
function rotateWorld(bone: Object3D, axis: Vector3, angle: number): void {
  bone.updateMatrixWorld(true);
  const parent = bone.parent;
  const world = bone.getWorldQuaternion(qa);
  qb.setFromAxisAngle(axis, angle);
  const next = qb.multiply(world);
  const parentWorld = parent ? parent.getWorldQuaternion(qc) : qc.identity();
  bone.quaternion.copy(parentWorld.invert().multiply(next));
  bone.updateMatrixWorld(true);
}

/** Turns `bone` so the direction to `child` points at `target`, both in world. */
function aim(bone: Object3D, child: Vector3, target: Vector3): void {
  const from = bone.getWorldPosition(tmpA);
  const current = tmpB.copy(child).sub(from).normalize();
  const wanted = tmpC.copy(target).sub(from).normalize();
  if (current.lengthSq() < 1e-10 || wanted.lengthSq() < 1e-10) return;
  const delta = new Quaternion().setFromUnitVectors(current, wanted);
  const world = bone.getWorldQuaternion(qa);
  const next = delta.multiply(world);
  const parentWorld = bone.parent ? bone.parent.getWorldQuaternion(qc) : qc.identity();
  bone.quaternion.copy(parentWorld.invert().multiply(next));
  bone.updateMatrixWorld(true);
}

/**
 * Two-bone IK: the root bone, the middle joint and the end effector, reaching
 * for `target`, bending in the plane that contains `pole` (model frame).
 */
function limb(rig: Object3D, names: readonly string[], target: Vector3, pole: V3): void {
  const [root, mid, end] = names.map((n) => rig.getObjectByName(n));
  if (!(root instanceof Object3D) || !(mid instanceof Object3D) || !(end instanceof Object3D)) return;
  const a0 = root.getWorldPosition(new Vector3());
  const b0 = mid.getWorldPosition(new Vector3());
  const c0 = end.getWorldPosition(new Vector3());
  const upper = a0.distanceTo(b0);
  const lower = b0.distanceTo(c0);
  const toTarget = target.clone().sub(a0);
  const reach = Math.min((upper + lower) * 0.999, Math.max(Math.abs(upper - lower) * 1.001 + 1e-4, toTarget.length()));
  const d = toTarget.normalize();
  const p = new Vector3(pole[0], pole[1], pole[2]);
  p.sub(d.clone().multiplyScalar(p.dot(d)));
  if (p.lengthSq() < 1e-8) p.set(0, 0, 1);
  p.normalize();
  const cos = Math.min(1, Math.max(-1, (upper * upper + reach * reach - lower * lower) / (2 * upper * reach)));
  const sin = Math.sqrt(1 - cos * cos);
  const joint = a0.clone().add(d.clone().multiplyScalar(upper * cos)).add(p.multiplyScalar(upper * sin));
  aim(root, b0, joint);
  const goal = a0.clone().add(d.multiplyScalar(reach));
  aim(mid, end.getWorldPosition(new Vector3()), goal);
}

/** Levels a foot so its sole runs forward rather than hanging from the ankle. */
function levelFoot(foot: Object3D): void {
  const toe = foot.children.find((c) => c instanceof Bone);
  if (!toe) return;
  const at = foot.getWorldPosition(new Vector3());
  const tip = toe.getWorldPosition(new Vector3());
  const length = at.distanceTo(tip);
  if (length < 1e-4) return;
  aim(foot, tip, at.clone().add(new Vector3(0, -0.35, 1).normalize().multiplyScalar(length)));
}
