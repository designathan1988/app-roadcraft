import { Box3, Bone, Matrix4, Object3D, Quaternion, SkinnedMesh, Vector3 } from 'three';

/**
 * Poses for people sitting in and on vehicles, built on the citizens' own
 * skeleton by inverse kinematics.
 *
 * The seated clips the citizen assets ship with are CHAIR poses: measured on
 * the rig, the head is 0.91 m above the pelvis and the feet 0.54 m below it,
 * knees at a right angle. A car's cabin has 1.1 m between floor and roof
 * lining, so a driver in that pose had their head through the roof and their
 * feet through the floor. The captured sitting idle is no better on a bus:
 * its legs splay 0.36 m to the side, and a passenger by the window had a foot
 * through the bodywork.
 *
 * A pose here is a handful of TARGETS in the pelvis frame - where the feet,
 * the hands and the head have to be - and two-bone IK puts the limbs there on
 * whatever body is being baked. Distances are in metres, in the model's frame:
 * +Z forward, +Y up, +X to the body's left (the Rocketbox convention).
 *
 * Where a person touches a machine - the rim of a steering wheel, the grips
 * and pegs of a motorcycle, the bars and pedals of a bicycle - the place is
 * stated HERE, once (`DRIVER_WHEEL`, `CAB_WHEEL`, `MOTO_FIT`, `BIKE_FIT`),
 * and the vehicle models build those parts to it. The hands were 18 to 25 cm
 * off the grips while the two were written down separately.
 *
 * The poses are baked into bone palettes once per body, like every other clip
 * (`riggedCitizens.ts`); nothing here runs per frame. The small movements that
 * keep a seated person alive - a look in the mirror, out of the window, down
 * at a phone - are more still poses of the same seat, which the renderer
 * blends in and out per person (`occupants.ts`).
 */

export type RiderClipKey =
  | 'carDrive' | 'carDriveMirror' | 'carDriveRight'
  | 'carRide' | 'carRideLeft' | 'carRideRight'
  | 'carRearRide' | 'carRearLeft' | 'carRearRight'
  | 'cabDrive' | 'cabDriveMirror' | 'cabDriveRight'
  | 'cabRide' | 'cabRideLeft' | 'cabRideRight'
  | 'chairSit' | 'chairSitLeft' | 'chairSitRight' | 'chairSitPhone'
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
  /** Head turn, radians, positive to the left; shared between the neck and the head. */
  readonly turn?: number;
}

type V3 = readonly [number, number, number];

// ---------------------------------------------------------------- steering wheels

/**
 * A steering wheel, from the hip point, metres: its centre ahead and above,
 * the tilt of its rim from vertical (top towards the driver) and its radius.
 * The vehicle models build the column to it and the renderer places the wheel
 * there at the driver's own size, so the hands the driving poses put on the
 * rim are on the rim.
 */
export interface WheelSpec {
  readonly forward: number;
  readonly up: number;
  readonly tilt: number;
  readonly radius: number;
}

/**
 * A car's wheel, per the vehicle spec (docs/vehicle-model-spec.md, section 3.2): 0.46 m
 * ahead of the hip point and 0.36 m above it, its plane 26 degrees from
 * vertical. It was 0.215 m above the hip, which put the rim in the driver's
 * lap and their hands with it.
 */
export const DRIVER_WHEEL: WheelSpec = { forward: 0.46, up: 0.36, tilt: 0.45, radius: 0.185 };

/**
 * A bus's or a truck's wheel: large, laid back towards flat, in front of a
 * driver sitting upright and high over the pedals.
 */
export const CAB_WHEEL: WheelSpec = { forward: 0.42, up: 0.13, tilt: 1.0, radius: 0.22 };

/**
 * A point on the rim of a wheel, pelvis frame (+X left, +Y up, +Z forward):
 * `clock` radians round from the top, positive to the left.
 */
export function rimPoint(clock: number, wheel: WheelSpec = DRIVER_WHEEL): V3 {
  const { forward, up, tilt, radius } = wheel;
  const across = Math.sin(clock) * radius;
  const along = Math.cos(clock) * radius;
  return [across, up + along * Math.cos(tilt), forward - along * Math.sin(tilt)];
}

// ---------------------------------------------------------------- two-wheelers

/**
 * Where a rider sits on a two-wheeler and what they hold and stand on,
 * metres. Heights are over the road; everything else is from the pelvis bone,
 * `side` across from the centre line, `up` and `forward` from the pelvis.
 */
export interface TwoWheelerFit {
  /** Height of the pelvis bone over the road. */
  readonly pelvisY: number;
  /** How far the pelvis bone sits above the saddle's top: the seat of the trousers. */
  readonly saddleDrop: number;
  /** The centre of each grip. */
  readonly grip: { readonly side: number; readonly up: number; readonly forward: number };
  /** The steering axis, ahead of the pelvis: the bars turn about it. */
  readonly steerAxis: number;
  /** A motorcycle's footpegs. */
  readonly peg?: { readonly side: number; readonly up: number; readonly forward: number };
  /** A bicycle's bottom bracket, and its cranks. */
  readonly bracket?: { readonly up: number; readonly forward: number };
  readonly crank?: number;
  /** Pedal centres either side of the frame. */
  readonly pedalSide?: number;
  /** Stopped, the machine tilts this far towards the rider's left foot, which is down. */
  readonly stopTilt: number;
  /** Where that foot is put down: out from the centre line, and a little ahead of the pelvis. */
  readonly footDown: { readonly side: number; readonly forward: number };
}

export const MOTO_FIT: TwoWheelerFit = {
  pelvisY: 0.96,
  saddleDrop: 0.1,
  grip: { side: 0.31, up: 0.2, forward: 0.52 },
  steerAxis: 0.8,
  peg: { side: 0.24, up: -0.6, forward: 0.1 },
  stopTilt: 0.14,
  footDown: { side: 0.42, forward: 0.12 },
};

export const BIKE_FIT: TwoWheelerFit = {
  pelvisY: 0.98,
  saddleDrop: 0.08,
  grip: { side: 0.27, up: 0.1, forward: 0.52 },
  steerAxis: 0.72,
  bracket: { up: -0.68, forward: 0.22 },
  crank: 0.17,
  pedalSide: 0.13,
  stopTilt: 0.16,
  footDown: { side: 0.34, forward: 0.1 },
};

/** Largest steering angle a steered pose is baked at; the renderer blends towards it. */
export const STEER_FULL = 0.3;

/**
 * Where a hand holds a grip: the wrist a little behind and above the grip's
 * centre, and 2 cm in towards the stem (the first component is applied
 * towards the centre line: `offset(..., -1)` for the left hand).
 */
const WRIST_ON_GRIP: V3 = [0.02, 0.03, -0.06];
/** Where the ankle is over a peg or a pedal under the ball of the foot. */
const ANKLE_OVER_PEDAL: V3 = [0, 0.07, -0.08];

/** A grip's centre in the pelvis frame, the bars turned by `steer` (radians, left positive). */
export function gripPoint(fit: TwoWheelerFit, side: 1 | -1, steer = 0): V3 {
  // Relative to the steering axis, turned about it.
  const x = side * fit.grip.side;
  const z = fit.grip.forward - fit.steerAxis;
  const c = Math.cos(steer);
  const s = Math.sin(steer);
  return [x * c + z * s, fit.grip.up, -x * s + z * c + fit.steerAxis];
}

const offset = (p: V3, d: V3, side: 1 | -1): V3 => [p[0] + d[0] * side, p[1] + d[1], p[2] + d[2]];

/** A pedal's centre in the pelvis frame: `angle` round the bracket, `side` 1 for the left. */
export function pedalPoint(fit: TwoWheelerFit, angle: number, side: 1 | -1): V3 {
  const b = fit.bracket ?? { up: -0.68, forward: 0.22 };
  const crank = fit.crank ?? 0.17;
  return [side * (fit.pedalSide ?? 0.13), b.up + Math.sin(angle) * crank, b.forward + Math.cos(angle) * crank];
}

/**
 * The ankle target for a foot put down on the road beside a machine tilted
 * by `fit.stopTilt`: found in the tilted frame, so that after the tilt the
 * foot is on the road.
 */
function footDownTarget(fit: TwoWheelerFit): V3 {
  const t = fit.stopTilt;
  const ankle = 0.08;
  const x = fit.footDown.side * Math.cos(t) - ankle * Math.sin(t);
  const h = fit.footDown.side * Math.sin(t) + ankle * Math.cos(t);
  return [x, h - fit.pelvisY, fit.footDown.forward];
}

function hands(fit: TwoWheelerFit, steer = 0): Pick<Targets, 'leftHand' | 'rightHand'> {
  return {
    leftHand: offset(gripPoint(fit, 1, steer), WRIST_ON_GRIP, -1),
    rightHand: offset(gripPoint(fit, -1, steer), WRIST_ON_GRIP, 1),
  };
}

// ---------------------------------------------------------------- the poses

/**
 * A car seat: reclined a little, thighs near level, feet forward on the
 * pedals or the floor, and for the driver the hands on the wheel at ten to
 * two. Floor and wheel are placed to match `vehicleModels.ts` (hip point
 * 0.3 m above the floor, the wheel at `DRIVER_WHEEL`).
 */
const CAR_DRIVE: Targets = {
  // The rest pose already stoops about 0.2 rad forward; this reclines the
  // trunk some 28 degrees back from upright, as a car seat holds it.
  lean: -0.8,
  // Heels on the floor (the ankle 8 cm over it, the hip point 0.28 m up) and
  // 0.8 m ahead of the hip, on the pedals. The ankles were 0.6 m ahead and
  // 0.15 m down, closer to the hip than a leg reaches without folding: the
  // knee rose above the hip, and every occupant sat with their knees at
  // their chest.
  leftFoot: [0.17, -0.08, 0.62],
  rightFoot: [-0.14, -0.08, 0.64],
  leftHand: rimPoint(1.05),
  rightHand: rimPoint(-1.05),
  kneePole: [0, 1, 1],
  elbowPole: [0, -1, 0.2],
  look: -0.12,
};
const CAR_RIDE: Targets = {
  lean: -0.8,
  // Legs out, the knees a little over the hips: a passenger's feet go under
  // the seat in front, 0.75 m ahead of the hip point.
  leftFoot: [0.16, -0.08, 0.61],
  rightFoot: [-0.16, -0.08, 0.61],
  leftHand: [0.13, 0.06, 0.3],
  rightHand: [-0.13, 0.06, 0.3],
  kneePole: [0, 1, 1],
  elbowPole: [0.3, -1, 0],
  look: -0.1,
};

/** A rear passenger folds their knees into the footwell beneath the front seat. */
const CAR_REAR_RIDE: Targets = {
  ...CAR_RIDE,
  lean: -0.55,
  leftFoot: [0.15, -0.13, 0.43],
  rightFoot: [-0.15, -0.13, 0.44],
  leftHand: [0.14, 0.04, 0.23],
  rightHand: [-0.14, 0.04, 0.23],
};

/**
 * The driver's seat of a bus or a truck cab: upright, the hip 0.45 m over
 * the floor, the feet down on the pedals and the hands on a big, laid-back
 * wheel (`CAB_WHEEL`). The car pose, used there before, left the feet 0.3 m
 * above the cab floor.
 */
const CAB_DRIVE: Targets = {
  lean: -0.42,
  leftFoot: [0.16, -0.37, 0.4],
  rightFoot: [-0.15, -0.37, 0.43],
  leftHand: rimPoint(1.15, CAB_WHEEL),
  rightHand: rimPoint(-1.15, CAB_WHEEL),
  kneePole: [0, 1, 1],
  elbowPole: [0, -1, 0.1],
  look: -0.05,
};
const CAB_RIDE: Targets = {
  lean: -0.42,
  leftFoot: [0.16, -0.37, 0.38],
  rightFoot: [-0.16, -0.37, 0.38],
  leftHand: [0.13, 0.02, 0.27],
  rightHand: [-0.13, 0.02, 0.27],
  kneePole: [0, 1, 1],
  elbowPole: [0.3, -1, 0],
  look: 0,
};

/**
 * A bus seat: upright, thighs level, shins down to the floor 0.55 m below the
 * hip, hands resting on the thighs.
 */
const CHAIR_SIT: Targets = {
  lean: -0.3,
  leftFoot: [0.12, -0.46, 0.4],
  rightFoot: [-0.12, -0.46, 0.4],
  leftHand: [0.12, 0.03, 0.27],
  rightHand: [-0.12, 0.03, 0.27],
  kneePole: [0, 1, 1],
  elbowPole: [0.3, -1, 0],
  look: 0.05,
};

/** A head turned, and the shoulders a little with it. */
const turned = (t: Targets, turn: number, look = t.look ?? 0): Targets => ({ ...t, turn, look, twist: (t.twist ?? 0) + turn * 0.15 });

/**
 * Astride a motorcycle: leaning into the tank, hands on the grips, feet on
 * the pegs (`MOTO_FIT`).
 */
const MOTO: Targets = {
  lean: 0.28,
  ...hands(MOTO_FIT),
  leftFoot: offset([MOTO_FIT.peg!.side, MOTO_FIT.peg!.up, MOTO_FIT.peg!.forward], ANKLE_OVER_PEDAL, 1),
  rightFoot: offset([-MOTO_FIT.peg!.side, MOTO_FIT.peg!.up, MOTO_FIT.peg!.forward], ANKLE_OVER_PEDAL, -1),
  kneePole: [0.5, 0.1, 1],
  elbowPole: [0.6, -1, 0],
  look: -0.12,
};
/** Stopped: the machine tilted onto the left foot, the right on its peg. */
const MOTO_STOP: Targets = { ...MOTO, lean: 0.12, leftFoot: footDownTarget(MOTO_FIT) };

/**
 * On a bicycle: a forward reach to the bars and the feet on the pedals,
 * which turn round the bottom bracket (`BIKE_FIT`).
 */
const BIKE: Omit<Targets, 'leftFoot' | 'rightFoot'> = {
  lean: 0.32,
  ...hands(BIKE_FIT),
  kneePole: [0.1, 0.2, 1],
  elbowPole: [0.4, -1, 0],
  look: -0.2,
};
const pedalFoot = (angle: number, side: 1 | -1): V3 => offset(pedalPoint(BIKE_FIT, angle, side), ANKLE_OVER_PEDAL, side);

/** Steering: the bars turned by `STEER_FULL`, the hands with them, the trunk following a little. */
function steered<T extends Omit<Targets, 'leftFoot' | 'rightFoot'>>(t: T, fit: TwoWheelerFit, direction: 1 | -1): T {
  return { ...t, twist: direction * 0.15, ...hands(fit, direction * STEER_FULL) };
}

export const RIDER_CLIPS: readonly RiderClip[] = [
  still('carDrive', CAR_DRIVE),
  still('carDriveMirror', turned(CAR_DRIVE, 0.6, -0.05)),
  still('carDriveRight', turned(CAR_DRIVE, -0.45)),
  still('carRide', CAR_RIDE),
  still('carRideLeft', turned(CAR_RIDE, 0.6)),
  still('carRideRight', turned(CAR_RIDE, -0.6)),
  still('carRearRide', CAR_REAR_RIDE),
  still('carRearLeft', turned(CAR_REAR_RIDE, 0.6)),
  still('carRearRight', turned(CAR_REAR_RIDE, -0.6)),
  still('cabDrive', CAB_DRIVE),
  still('cabDriveMirror', turned(CAB_DRIVE, 0.6, 0)),
  still('cabDriveRight', turned(CAB_DRIVE, -0.5, 0)),
  still('cabRide', CAB_RIDE),
  still('cabRideLeft', turned(CAB_RIDE, 0.55)),
  still('cabRideRight', turned(CAB_RIDE, -0.6)),
  still('chairSit', CHAIR_SIT),
  still('chairSitLeft', turned(CHAIR_SIT, 0.65)),
  still('chairSitRight', turned(CHAIR_SIT, -0.65)),
  still('chairSitPhone', { ...CHAIR_SIT, leftHand: [0.05, 0.14, 0.3], rightHand: [-0.05, 0.14, 0.3], elbowPole: [0.6, -1, -0.2], look: 0.55 }),
  still('motoRide', MOTO),
  still('motoLeft', steered(MOTO, MOTO_FIT, 1)),
  still('motoRight', steered(MOTO, MOTO_FIT, -1)),
  still('motoStop', MOTO_STOP),
  {
    key: 'bikePedal',
    duration: 1,
    loop: true,
    pose(rig, time) {
      const angle = time * Math.PI * 2;
      apply(rig, { ...BIKE, leftFoot: pedalFoot(angle, 1), rightFoot: pedalFoot(angle + Math.PI, -1) });
    },
  },
  still('bikeLeft', { ...steered(BIKE, BIKE_FIT, 1), leftFoot: pedalFoot(0, 1), rightFoot: pedalFoot(Math.PI, -1) }),
  still('bikeRight', { ...steered(BIKE, BIKE_FIT, -1), leftFoot: pedalFoot(0, 1), rightFoot: pedalFoot(Math.PI, -1) }),
  // Stopped: tilted onto the left foot, the right on its pedal at the top of
  // the stroke, ready to push off.
  still('bikeStop', { ...BIKE, lean: 0.18, leftFoot: footDownTarget(BIKE_FIT), rightFoot: pedalFoot(Math.PI * 0.6, -1) }),
];

// ---------------------------------------------------------------- helmets

/**
 * Bodies whose hair no helmet of a helmet's size holds - buns, big curls, a
 * ponytail high on the crown: fitted round the hair, the shell came out 0.41
 * to 0.52 m across. Nobody is drawn riding a motorcycle on one of these
 * bodies; the rider takes another of their sex. `tests/render/riderFit.spec.ts`
 * measures every head and fails if this list and the heads disagree.
 */
export const NO_HELMET: ReadonlySet<string> = new Set([
  'female_01', 'female_02', 'female_04', 'female_07', 'female_09', 'female_11', 'female_12', 'female_17',
  'female_party_02', 'medical_female_01', 'medical_female_03', 'medical_male_04', 'pilot_male_03',
  'police_male_01', 'security_female_01', 'sports_male_03',
  // Long hair a helmet would sit on, not round.
  'female_15',
]);

/** The largest a helmet may be across any axis, metres. */
export const HELMET_MAX = 0.405;

/** Segments round a helmet shell: its flat facets sit this close to the true ellipsoid. */
export const HELMET_SEGMENTS = { width: 24, height: 16 } as const;

/**
 * A helmet made for one body: an ellipsoid in the head bone's own frame that
 * encloses every point of the head above the base of the skull - hair
 * included - with a little room, returned as the matrix that takes a sphere
 * of unit DIAMETER there. The renderer multiplies it by the posed head bone
 * and the body's own transform, so the helmet goes where that head is, at
 * its size, turned with it.
 *
 * It used to be one sphere of one size at a fixed height over the seat: on a
 * tall rider or a leaning one the head came out through its side, which
 * players saw as a ball stuck in the rider's head.
 */
export function helmetShape(rig: Object3D): Matrix4 | null {
  rig.updateMatrixWorld(true);
  const head = rig.getObjectByName(BONES.head);
  if (!head) return null;
  const points = headPoints(rig, head);
  if (points.length < 8) return null;
  const box = new Box3().setFromPoints(points);
  const centre = box.getCenter(new Vector3());
  const half = box.getSize(new Vector3()).multiplyScalar(0.5);
  let k = 0;
  for (const p of points) {
    k = Math.max(k, Math.hypot((p.x - centre.x) / half.x, (p.y - centre.y) / half.y, (p.z - centre.z) / half.z));
  }
  // Room between the head and the shell, and for the shell's flat facets
  // lying inside the ellipsoid through their corners.
  const facet = 1 / (Math.cos(Math.PI / HELMET_SEGMENTS.height) * Math.cos(Math.PI / HELMET_SEGMENTS.width));
  const pad = 1.2; // centimetres: the skeleton is authored in them
  const radius = half.multiplyScalar(k * facet).addScalar(pad);
  return new Matrix4().compose(centre, new Quaternion(), radius.multiplyScalar(2));
}

/**
 * The points of a posed head a helmet must hold, in the head bone's frame:
 * every vertex the head bone moves most, from the base of the skull up. The
 * neck, the chin under the chin bar and hair hanging below the rim are
 * outside a real helmet too.
 */
export function headPoints(rig: Object3D, head: Object3D): Vector3[] {
  const out: Vector3[] = [];
  const v = new Vector3();
  rig.traverse((o) => {
    if (!(o instanceof SkinnedMesh)) return;
    const bone = o.skeleton.bones.indexOf(head as Bone);
    if (bone < 0) return;
    o.skeleton.update();
    const index = o.geometry.getAttribute('skinIndex');
    const weight = o.geometry.getAttribute('skinWeight');
    const count = o.geometry.getAttribute('position').count;
    for (let i = 0; i < count; i++) {
      let w = 0;
      for (let c = 0; c < 4; c++) if (index.getComponent(i, c) === bone) w += weight.getComponent(i, c);
      if (w < 0.5) continue;
      o.getVertexPosition(i, v);
      o.localToWorld(v);
      const local = head.worldToLocal(v.clone());
      if (local.x > 0) out.push(local);
    }
  });
  return out;
}

/** Seconds a still pose is baked over: two frames, the same pose. */
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
  const neck = find(BONES.neck);
  const head = find(BONES.head);
  // A turn of the head less the part the shoulders already took.
  const turn = (t.turn ?? 0) - (t.twist ?? 0);
  if (neck && turn) rotateWorld(neck, new Vector3(0, 1, 0), turn * 0.4);
  if (head && turn) rotateWorld(head, new Vector3(0, 1, 0), turn * 0.6);
  if (head && t.look) rotateWorld(head, new Vector3(1, 0, 0), t.look - t.lean * 0.6);
  rig.updateMatrixWorld(true);

  limb(rig, BONES.leftLeg, worldOf(t.leftFoot), t.kneePole ?? [0, 0, 1]);
  limb(rig, BONES.rightLeg, worldOf(t.rightFoot), mirrorPole(t.kneePole ?? [0, 0, 1], -1));
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

/** A pole given for the left limb, mirrored to the right. */
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
