import {
  BoxGeometry,
  Color,
  DoubleSide,
  DynamicDrawUsage,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  MeshBasicMaterial,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  Object3D,
  Quaternion,
  Vector3,
  SphereGeometry,
  type BufferGeometry,
  type Material,
} from 'three';

import { pedPose, vehiclePose } from '@sim/pose';
import { roadFrame } from './vehicleFrame';
import {
  ARCHETYPES,
  archetypeById,
  type Archetype,
  type VehicleShape,
} from '@sim/vehicles/archetypes';
import type { SimWorld } from '@sim/world';
import type { Vehicle as SimVehicle } from '@sim/vehicles/state';
import type { SegmentId } from '@world/ids';
import { m } from '@world/units';
import { DT, FLEET_CEILING, PED_CEILING } from '@sim/params';
import { buildCarModel, carStyleOf, carStylesFor } from './carBody';
import { CROWD_IDS, createRiggedCitizens, type CitizenClipKey, type ClipIdentity } from './riggedCitizens';
import type { Company } from './citizenCasting';
import { kerbTransfer, seatPerson, type KerbStop } from '@sim/vehicles/kerbStops';
import { FOOTWAY_RISE } from '@world/roadTypes';
import { groundGradient } from './groundShear';
import { WheelOdometer, blinkOn, indicatorSide, pathCurvature, steerAngle } from './vehicleSignals';
import {
  axleStations, buildBusModel, buildTruckModel, buildTwoWheelerModel, seatFitScale, rimGeometry, spokedRimGeometry,
  merge, tyreGeometry, type TwoWheelerModel, type VehicleModel,
} from './vehicleModels';
import { HELMET_SEGMENTS, STEER_FULL } from './riderPoses';
import { DOOR_SWING, createKerbFigure, kerbFigure, occupantPlays, type Play } from './occupants';

/**
 * Vehicles and riders use the original instanced batches. Citizens use
 * rigged Rocketbox meshes with baked animation palettes in separate batches.
 *
 * At the far band only vehicles are drawn. The middle band includes citizens;
 * the near band adds the finest detail. Citizen stride follows distance travelled rather
 * than a shared clock, so each gait has its own phase.
 *
 * Buffers are allocated once. Only their written prefixes are uploaded, and
 * capacity overflow drops detail instead of allocating during a frame.
 */

/**
 * Fleet and crowd the buffers are sized for: the simulation's own ceilings,
 * so nothing can be simulated that cannot be drawn.
 */
const MAX_VEHICLES = FLEET_CEILING;
const MAX_PEDS = PED_CEILING;
/** Two-wheeler riders' own batches (frames, wheels, helmets). */
const MAX_RIDERS = 400;

/**
 * Zoom at which the closest band switches on.
 *
 * This was 0.9, and that number was reasoned about against a viewport running
 * from 0.18 to 3.2. The isometric rig's own range at an 800-pixel canvas is
 * `height / (halfHeight * 2)` over a half-height clamped to [55, 950], which
 * is 0.42 to 7.27 - so 0.9 sits above twice the minimum and the game is played
 * well below it. The practical effect was that mirrors, number plates, wheel
 * hubs, pillars AND THE PEOPLE INSIDE THE CARS existed in the code, were
 * placed correctly, and were almost never drawn. Reported, reasonably, as
 * "the cars have no detail at all" and "you didn't put anyone in the cars".
 *
 * 0.55 puts the close band just above the detail cutoff, so detail appears as
 * soon as anything is worth looking at. It costs about ten more matrix writes
 * per vehicle, which the update-range fix below more than pays for.
 */
const NEAR_DETAIL_ZOOM = 0.55;

/**
 * Below this zoom a vehicle is its far proxy (`VehicleModel.far`): one opaque
 * low-poly instance with the glass and wheels painted on. A car is then under
 * nine pixels long; the whole body's bevels and the transparent glass pass
 * cost as much there as at a close zoom and show nothing.
 */
const FAR_BODY_ZOOM = 0.7;
/**
 * From this zoom the cabin and the people in it are drawn (the tier may ask
 * for more, `QualitySettings.occupantZoom`). A seated person is a skinned body
 * of thousands of triangles; below about 1.2 their head is under a pixel.
 */
const OCCUPANT_ZOOM = 1.2;

const SIDES = [1, -1] as const;

/**
 * Lamp state for the vehicle currently being drawn.
 *
 * The tail lamp used to be a constant, so every car on the map was drawn with
 * its lights in exactly the same state whatever it was doing - the single
 * biggest thing standing between the traffic and being readable, because a
 * queue forming is a line of brake lights coming on one after another.
 *
 * It is a closure variable rather than a parameter because the four body
 * builders each place lamps from several call sites; threading it through all
 * of them would be a wider change than the thing it expresses.
 */
interface LampState {
  tail: number;
  /** Lit indicator side: +1 left, -1 right, 0 none. Already includes the flash. */
  indicate: number;
  /** Front-wheel steering angle, radians, positive to the left. */
  steer: number;
  /** Rolling angle of the wheels, radians. */
  spin: number;
  /** Angle of a bicycle's cranks, radians. */
  crank: number;
}

export interface AgentRenderOptions {
  readonly pedestrianDetail?: 0 | 1 | 2;
  readonly pedestrianVisible?: (x: number, y: number, height: number) => boolean;
  /** Whether a vehicle of this reach, centred here, can be on screen or cast a shadow onto it. */
  readonly vehicleVisible?: (x: number, y: number, height: number, radius: number) => boolean;
  /** Zoom from which vehicle cabins and occupants are drawn. */
  readonly occupantZoom?: number;
}

export interface AgentMeshes {
  readonly meshes: readonly Object3D[];
  /**
   * @param zoom Viewport zoom, used only to pick the closest detail band. It
   *   defaults to fully zoomed in, so a caller that does not pass it gets the
   *   richest look rather than a silently stripped one.
   */
  sync(world: SimWorld, alpha: number, detailed: boolean, zoom?: number, options?: AgentRenderOptions): void;
  /** Every figure drawn last frame and the body it was cast as (`citizenCasting.ts`). */
  census(): ReturnType<ReturnType<typeof createRiggedCitizens>['census']>;
  /** Lamps burn brighter than white after dark, so headlights and tail lights glow. */
  setNight(dark: number): void;
  dispose(): void;
}

/** Time constant of the pitch and roll ease, seconds. */
const SUSPENSION_TAU = 0.06;

type ElevationAt = (world: SimWorld, x: number, y: number, segment?: SegmentId) => number;

// ---------------------------------------------------------------- variation

/**
 * A cheap integer avalanche hash.
 *
 * This is the only source of per-agent variety in the module. It has to mix
 * into the low bits, because every consumer takes a remainder of a shifted
 * slice, and it has to be exactly reproducible, because how a car looks must
 * not depend on when it was first drawn.
 */
export function agentHash(id: number): number {
  let h = (id | 0) + 0x9e3779b9;
  h = Math.imul(h ^ (h >>> 16), 0x21f0aaad);
  h = Math.imul(h ^ (h >>> 15), 0x735a2d97);
  return (h ^ (h >>> 15)) >>> 0;
}

/** A slice of a hash as a fraction in [0, 1). */
const frac = (h: number, shift: number): number => ((h >>> shift) & 0xff) / 256;
/** A slice of a hash as an index into `n` items. */
const pick = (h: number, shift: number, n: number): number => (h >>> shift) % n;
/** Reads a palette entry, with the indexing narrowed away. */
const from = (palette: readonly number[], h: number, shift: number): number =>
  palette[pick(h, shift, palette.length)] as number;

/**
 * Skin tones, light to dark.
 *
 * Six is the smallest set in which a crowd does not read as one family. They
 * are sampled uniformly: weighting them would encode an assumption about the
 * city the player is building that the engine has no business making.
 */
export const SKIN_TONES: readonly number[] = [
  0xf2d3b6, 0xe6b98f, 0xd19a6a, 0xa9714a, 0x7d4e30, 0x4e3120,
];

export const HAIR_COLOURS: readonly number[] = [
  0x17110d, 0x2f1f14, 0x4a2f1c, 0x6f4a24, 0xa8803c, 0xc9412a, 0x8d8a83, 0xd8d6d0,
];
/** Index of the first grey in `HAIR_COLOURS`, which the elderly draw from. */
const FIRST_GREY = 6;

export const SHIRT_COLOURS: readonly number[] = [
  0xd8dde2, 0x2f5f92, 0xb8432f, 0x3f7d5c, 0xe0b83f, 0x8a4f8c, 0x2b2f36, 0xd77c3a, 0xf0e6d2,
  0x5d6b7a,
];

export const TROUSER_COLOURS: readonly number[] = [
  0x2b3440, 0x3d4a5c, 0x55504a, 0x1f2328, 0x7a6a52, 0x8f9399, 0x4a3a52, 0x233d33,
];

const SHOE_COLOURS: readonly number[] = [0x1a1a1c, 0x3b2a1e, 0x6b6e72, 0xe2e4e6];
const HELMET_COLOURS: readonly number[] = [0x1c1e22, 0xd8dbe0, 0xc0392b, 0x2c5f9e, 0xe0a33a];

/** Tints for parts that are never painted the vehicle's own colour. */
const RUBBER = 0x15181b;
const HUB = 0x9aa0a6;
const TRIM = 0x1b2328;
const CHROME = 0xb9bec4;
/** A number plate is retro-reflective, so unlit white is the honest material. */
const PLATE = 0xf0efe6;
/** A bus's destination blind: amber on black, read as lit amber. */
const DESTINATION = 0xffb13b;
const HEADLAMP = 0xfff3c4;
const TAILLAMP = 0xff3b2f;
/** A tail lamp with the brakes on. */
const BRAKELAMP = 0xff1a08;
/** The amber of an indicator, on the side the vehicle is moving towards. */
const INDICATOR = 0xffa11c;
/**
 * Deceleration, in units per second per second, at which the brake lights come on.
 *
 * Real brake lights are wired to the pedal rather than to a threshold, but the
 * simulation has no pedal - it has an acceleration, and a driver easing off is
 * not braking. About 1 unit/s^2 is the point where a following driver would
 * see the nose dip.
 */
const BRAKE_DECEL = 1.0;
const BOX_BODY = 0xe6e8ea;

/** Height of a seated head above the middle of its torso. */
const SEAT_HEAD_RISE = m(0.38);

export type PedBuild = 'child' | 'adult' | 'elder';

export interface PedLook {
  readonly build: PedBuild;
  /** Overall height, in world units. */
  readonly height: number;
  /** Width and depth multiplier, so a crowd is not one body repeated. */
  readonly girth: number;
  /** Head diameter as a fraction of height. Children are top-heavy. */
  readonly headFraction: number;
  readonly skin: number;
  readonly hair: number;
  readonly trousers: number;
  readonly shoes: number;
  /** Bare legs below a hem, instead of trouser legs. */
  readonly skirt: boolean;
  /** A flat cap instead of a skull of hair. */
  readonly hat: boolean;
  /** Forward lean of the torso, in radians. */
  readonly stoop: number;
  /** Stride length multiplier, which spreads the cadence across the crowd. */
  readonly stride: number;
  /** Whether a dog trots alongside. */
  readonly dog: boolean;
}

/**
 * Everything about how one pedestrian looks, from their id alone.
 *
 * The shirt is deliberately absent: it stays the `color` the simulation drew at
 * spawn, so the seeded spawn stream still decides something visible and two
 * runs of one seed still produce the same street.
 */
export function pedLook(id: number): PedLook {
  const h = agentHash(id);
  const g = agentHash(id ^ 0x5bf03635);

  const age = pick(h, 0, 100);
  const build: PedBuild = age < 16 ? 'child' : age < 88 ? 'adult' : 'elder';
  const elder = build === 'elder';
  const t = frac(h, 8);

  // A child is 1.05 to 1.40 m, an adult 1.58 to 1.90, and the elderly a little
  // shorter than they were. Heights are written in metres so they stay honest
  // against a 1.45 m car roof.
  const height =
    build === 'child'
      ? m(1.05 + t * 0.35)
      : elder
        ? m(1.5 + t * 0.22)
        : m(1.58 + t * 0.32);

  // Grey arrives with age rather than at random: three elderly heads in four
  // draw from the grey end of the palette.
  const hair =
    elder && pick(g, 8, 4) !== 0
      ? (HAIR_COLOURS[FIRST_GREY + pick(g, 10, 2)] as number)
      : from(HAIR_COLOURS, g, 12);

  return {
    build,
    height,
    girth: 0.86 + frac(g, 0) * 0.34,
    headFraction: build === 'child' ? 0.19 : elder ? 0.138 : 0.132,
    skin: from(SKIN_TONES, h, 16),
    hair,
    trousers: from(TROUSER_COLOURS, g, 16),
    shoes: from(SHOE_COLOURS, h, 24),
    skirt: pick(h, 12, 8) < 3,
    hat: pick(g, 22, 9) === 0,
    stoop: elder ? 0.16 : build === 'child' ? 0.05 : 0.03,
    stride: 0.86 + frac(g, 4) * 0.34,
    // Children do not walk dogs unaccompanied, so the lead is an adult trait.
    dog: build !== 'child' && pick(g, 24, 100) < 9,
  };
}

export interface VehicleLook {
  /** Figures to draw, driver first. Never more than the class has seats. */
  readonly occupants: number;
  /** Bit 0 is the offside window, bit 1 the kerbside one. Set means down. */
  readonly windowsDown: number;
  /** How far a lowered window is down: 0.45 part-way, 1 fully into the door. */
  readonly windowDrop: number;
  readonly driverSkin: number;
  readonly driverShirt: number;
  readonly passengerSkin: number;
  readonly passengerShirt: number;
  readonly helmet: number;
  /** Second body colour, for a truck's box and a bus's roof. */
  readonly accent: number;
  /**
   * A panoramic glass roof. The camera looks down at 48 degrees, so on a car
   * with a painted roof the people inside are only ever glimpsed through the
   * side glass; on these the driver and passengers read from above.
   */
  readonly glassRoof: boolean;
  /** A contrasting black roof panel. */
  readonly blackRoof: boolean;
}

/**
 * How a door's window is drawn with a share `drop` of it lowered (0 shut, 1
 * fully down): the pane shortened from the top about its own bottom edge,
 * as the part still showing above the door; fully down it is inside the
 * door and not drawn at all. Sliding the pane down instead pushed its top
 * edge into the cabin (it leans inboard with the body) or, along its lean,
 * its bottom edge out through the door skin. `up` and `sy` are the vertical
 * offset and scale to place it with, in the door's own frame.
 */
export function windowPane(door: { glass: BufferGeometry }, drop: number): { visible: boolean; up: number; sy: number } {
  if (drop >= 0.98) return { visible: false, up: 0, sy: 0 };
  if (drop <= 0) return { visible: true, up: 0, sy: 1 };
  if (!door.glass.boundingBox) door.glass.computeBoundingBox();
  const bottom = door.glass.boundingBox?.min.y ?? 0;
  const sy = 1 - drop;
  return { visible: true, up: bottom * (1 - sy), sy };
}

/** Everything about how one vehicle's occupants and windows look, from its id. */
export function vehicleLook(id: number, seats: number): VehicleLook {
  const h = agentHash(id ^ 0x2545f491);
  const g = agentHash(id ^ 0x27220a95);
  const room = Math.max(1, Math.floor(seats));
  return {
    occupants: 1 + pick(h, 6, room),
    // Most cars closed; three in ten with a window or both front ones down.
    windowsDown: pick(h, 2, 10) < 7 ? 0 : pick(h, 2, 10) - 6,
    windowDrop: pick(g, 9, 2) === 0 ? 0.45 : 1,
    driverSkin: from(SKIN_TONES, h, 14),
    driverShirt: from(SHIRT_COLOURS, h, 20),
    passengerSkin: from(SKIN_TONES, g, 6),
    passengerShirt: from(SHIRT_COLOURS, g, 12),
    helmet: from(HELMET_COLOURS, g, 18),
    accent: pick(g, 24, 3) === 0 ? BOX_BODY : from(SHIRT_COLOURS, g, 26),
    // Always a solid roof: a glass one showed the whole cabin from above, and
    // read as a car with its roof missing. One in five is black.
    glassRoof: false,
    blackRoof: pick(g, 28, 5) === 0,
  };
}

// ---------------------------------------------------------------- two-wheelers

/** Crank turns per wheel turn of a bicycle. */
const CRANK_RATIO = 0.57;
/** Steepest lean drawn, radians (about 35 degrees). */
const MAX_LEAN = 0.6;
const GRAVITY = m(9.81);
/** How fast a lean follows the bend, per second. */
const LEAN_RATE = 6;
const leans = new WeakMap<SimVehicle, { lean: number; age: number }>();

/**
 * How far a two-wheeler leans into the bend it is on: the angle whose tangent
 * is its sideways acceleration over gravity, which is what balances it, eased
 * so that it rolls into and out of a bend rather than snapping.
 */
function leanOf(world: SimWorld, v: SimVehicle): number {
  const target = Math.max(-MAX_LEAN, Math.min(MAX_LEAN, Math.atan((v.v * v.v * pathCurvature(world, v)) / GRAVITY)));
  const state = leans.get(v);
  if (!state) {
    leans.set(v, { lean: target, age: v.age });
    return target;
  }
  const dt = Math.max(0, Math.min(0.2, v.age - state.age));
  state.age = v.age;
  state.lean += (target - state.lean) * (1 - Math.exp(-dt * LEAN_RATE));
  return state.lean;
}

// ---------------------------------------------------------------- people in vehicles

const riderPlays: { key: CitizenClipKey; phase: number; weight: number }[] = [];


const smooth01 = (x: number): number => {
  const t = Math.min(1, Math.max(0, x));
  return t * t * (3 - 2 * t);
};

/** How much a two-wheeler is under way, 0 stopped (a foot down) to 1 riding. */
const riderMoving = (v: SimVehicle): number => smooth01((v.v / m(1) - 0.2) / 0.8);

// ---------------------------------------------------------------- doors and seats

/** Open fraction of one door, 0 shut to 1 fully open, from the simulation. */
function doorOpening(v: SimVehicle, door: number): number {
  return v.doors[door] ?? 0;
}

// ---------------------------------------------------------------- body plans

/**
 * Per-class geometry, derived once at module load.
 *
 * Everything the vehicle loop needs is precomputed here, in world units, so
 * that the loop multiplies rather than decides. The table is keyed by archetype
 * id, but every value comes from the archetype's declared `shape` and
 * proportions — no branch in this file names a class, which is what stops a bus
 * being drawn as a very long hatchback the next time the fleet changes.
 */
interface BodyPlan {
  readonly shape: VehicleShape;
  readonly length: number;
  readonly width: number;
  readonly height: number;
  readonly wheelRadius: number;
  /** Tyre width. */
  readonly tread: number;
  /** Axle positions along the body, front first. */
  readonly axleAlong: readonly number[];
  /** Lateral offset of a wheel from the centreline. Zero for two-wheelers. */
  readonly axleSide: number;
  readonly cabinLength: number;
  readonly cabinAlong: number;
  readonly seats: number;
  /** Seated torso centre, and the head above it. */
  readonly seatY: number;
  readonly headY: number;
  /** First seat row, and the step back to the next. */
  readonly seatAlong: number;
  readonly seatPitch: number;
  readonly seatSide: number;
}

function bodyPlan(a: Archetype): BodyPlan {
  const twoWheeler = a.shape === 'motorcycle' || a.shape === 'bicycle';
  const bus = a.shape === 'bus';
  const truck = a.shape === 'truck';
  const tread = twoWheeler ? a.width * (a.shape === 'bicycle' ? 0.14 : 0.3) : a.width * 0.14;

  // Two axles straddle the body; three put one under the nose and a bogie at
  // the back, which is what gives a bus its four rear wheels and a truck its
  // three axles.
  const axleAlong: readonly number[] = axleStations(a);

  // Seat heights put the heads inside the glazed band of each body plan, which
  // is the only place an occupant is visible from outside.
  const seatY = a.height * (bus ? 0.55 : truck ? 0.5 : 0.46);
  return {
    shape: a.shape,
    length: a.length,
    width: a.width,
    height: a.height,
    wheelRadius: a.wheelRadius,
    tread,
    axleAlong,
    axleSide: twoWheeler ? 0 : a.width * 0.5 - tread * 0.5,
    cabinLength: a.length * a.cabinFraction,
    cabinAlong: a.length * a.cabinShift,
    seats: a.seats,
    seatY,
    headY: seatY + SEAT_HEAD_RISE,
    seatAlong: bus ? a.length * 0.36 : a.length * a.cabinShift,
    seatPitch: bus ? -a.length * 0.24 : truck ? 0 : -a.length * 0.2,
    seatSide: a.width * 0.24,
  };
}

const PLANS: ReadonlyMap<string, BodyPlan> = new Map(
  ARCHETYPES.map((a) => [a.id, bodyPlan(a)] as const),
);
const FALLBACK_PLAN = bodyPlan(archetypeById('sedan'));
const planOf = (a: Archetype): BodyPlan => PLANS.get(a.id) ?? FALLBACK_PLAN;

// ---------------------------------------------------------------- meshes

interface Part {
  readonly mesh: InstancedMesh;
  /** Write cursor, reset at the top of every sync. */
  n: number;
  /** Whether this sync wrote a colour, so the colours need uploading. */
  tinted: boolean;
}

function instanced(
  name: string,
  geometry: BufferGeometry,
  material: Material,
  count: number,
  castShadow = true,
): Part {
  const mesh = new InstancedMesh(geometry, material, count);
  mesh.name = name;
  mesh.instanceMatrix.setUsage(DynamicDrawUsage);
  // Every part carries a colour per instance, white until tinted. Materials
  // are shared between tinted and untinted parts, and three builds a
  // different program for an instanced mesh with colours than without, so a
  // mix of the two switched programs a dozen times a frame.
  mesh.instanceColor = new InstancedBufferAttribute(new Float32Array(count * 3).fill(1), 3);
  mesh.instanceColor.setUsage(DynamicDrawUsage);
  mesh.castShadow = castShadow;
  mesh.receiveShadow = false;
  // Instances move every frame, so a bounding sphere computed once is wrong;
  // the meshes are few enough that skipping the frustum test is the cheap answer.
  mesh.frustumCulled = false;
  mesh.count = 0;
  return { mesh, n: 0, tinted: false };
}

export function createAgentMeshes(elevationAt: ElevationAt, onAssetsReady: () => void = () => {},
  groundAt?: (x: number, y: number) => number): AgentMeshes {
  // Paint, trim and the cabin read a vertex colour that multiplies the
  // instance colour: one body geometry carries its black-outs, seams, seats
  // and carpet in one draw. Every geometry drawn with them is built by
  // `vehicleModels.merge`, which gives each a colour.
  // Automotive paint: a base coat under a glossy clear coat, reflecting the
  // sky's environment map. The plain standard material read as matt plastic.
  const paint = new MeshPhysicalMaterial({
    roughness: 0.38, metalness: 0.28, clearcoat: 1, clearcoatRoughness: 0.07,
    envMapIntensity: 1.35, vertexColors: true,
  });
  const trim = new MeshStandardMaterial({ roughness: 0.45, metalness: 0.35, vertexColors: true });
  const glassMaterial = new MeshStandardMaterial({
    color: 0x7896a2,
    roughness: 0.12,
    metalness: 0.04,
    transparent: true,
    // Keep a cool tint while letting seated people read through the panes.
    opacity: 0.34,
    envMapIntensity: 0.8,
    // Panes are single sheets seen from both sides: the windscreen from above,
    // a door's window from inside when it swings open.
    side: DoubleSide,
    // In ONE pass. three draws a transparent double-sided material twice, back
    // faces then front, and flags it for a new program before each: with a
    // glass mesh per vehicle model that was 62 program lookups a frame. A
    // pane is a single sheet, so there is no back face to order.
    forceSinglePass: true,
    depthWrite: false,
  });
  // The cabin: seats, dashboard, wheel. Dark and matt, so the people sitting in
  // it are what reads through the glass.
  const cabinMaterial = new MeshStandardMaterial({ roughness: 0.9, metalness: 0.02, vertexColors: true });
  const rubber = new MeshStandardMaterial({ roughness: 0.92, metalness: 0.05 });
  // Unlit, so a lamp stays bright inside a shadow — the only thing in the scene
  // for which that is correct. One material serves headlights, tail lights,
  // destination blinds and number plates; the instance colour separates them.
  const lampMaterial = new MeshBasicMaterial({ toneMapped: false });
  const cloth = new MeshStandardMaterial({ roughness: 0.85, metalness: 0 });

  const unitBox = new BoxGeometry(1, 1, 1);
  // A dog's body: shoulders a little wider than the waist.
  const torsoGeometry = new BoxGeometry(1, 1, 1);
  taper(torsoGeometry, 0.92, 1.2);
  const wheelGeometry = tyreGeometry();
  const hubGeometry = rimGeometry();
  // A bicycle's tyre is a thin hoop and its wheel is spokes, not a disc.
  const thinTyreGeometry = tyreGeometry(0.035);
  const spokedGeometry = spokedRimGeometry();
  const headGeometry = new SphereGeometry(0.5, 10, 7);

  const wheels = instanced('vehicle-wheels', wheelGeometry, rubber, MAX_VEHICLES * 6);
  const hubs = instanced('vehicle-hubs', hubGeometry, trim, MAX_VEHICLES * 6, false);
  const thinWheels = instanced('bicycle-wheels', thinTyreGeometry, rubber, MAX_RIDERS * 2);
  const spokes = instanced('bicycle-spokes', spokedGeometry, trim, MAX_RIDERS * 2, false);
  const lamps = instanced('vehicle-lamps', unitBox, lampMaterial, MAX_VEHICLES * 9, false);
  // A motorcyclist's helmet: a smooth shell, glossy like paint. Its facets
  // are fine enough that the head it is fitted to stays inside
  // (`riderPoses.HELMET_SEGMENTS`).
  const helmetGeometry = merge([new SphereGeometry(0.5, HELMET_SEGMENTS.width, HELMET_SEGMENTS.height)]);
  const helmets = instanced('rider-helmets', helmetGeometry, paint, MAX_RIDERS);

  const parts: readonly Part[] = [wheels, hubs, thinWheels, spokes, lamps, helmets];
  /**
   * One set of instanced meshes per car class, built from its own model
   * (`vehicleModels.ts`): a class is five to thirteen draws for the whole fleet
   * of it, whatever its size.
   */
  interface CarParts {
    readonly model: VehicleModel;
    /** The body, glazing and cabin with every door shut: one instance each. */
    readonly shell: Part;
    readonly glass: Part;
    readonly interior: Part;
    /** The same while a door moves: the pieces, and each leaf on its own. */
    readonly openShell: Part;
    readonly openGlass: Part;
    readonly openInterior: Part;
    readonly doors: readonly Part[];
    readonly doorGlass: readonly Part[];
    readonly doorCards: readonly (Part | null)[];
    readonly trim: Part;
    /** The roof panel in paint, or in glass on a car with a panoramic roof. */
    readonly roof: Part | null;
    readonly roofGlass: Part | null;
    readonly accent: Part | null;
    readonly far: Part;
    readonly steering: Part | null;
  }
  const carParts = new Map<string, CarParts>();
  /** Which body a vehicle is drawn with: its class and, for a car, the style its id picks. */
  const bodyKey = (vehicle: SimVehicle): string => {
    const a = vehicle.archetype;
    if (a.shape === 'bus') return `${a.id}:bus`;
    if (a.shape === 'truck') return `${a.id}:truck`;
    return `${a.id}:${carStyleOf(a, agentHash(vehicle.id ^ 0x57e1))}`;
  };
  const modelGeometries: BufferGeometry[] = [];
  // One set per class and body style: a sedan may be drawn as an estate and
  // an SUV as a pick-up (`carBody.carStyleOf`), the same size to the simulation.
  const bodies: { key: string; model: VehicleModel }[] = [];
  for (const archetype of ARCHETYPES) {
    if (archetype.shape === 'car') {
      for (const style of carStylesFor(archetype)) bodies.push({ key: `${archetype.id}:${style}`, model: buildCarModel(archetype, style) });
    } else if (archetype.shape === 'bus') bodies.push({ key: `${archetype.id}:bus`, model: buildBusModel(archetype) });
    else if (archetype.shape === 'truck') bodies.push({ key: `${archetype.id}:truck`, model: buildTruckModel(archetype) });
  }
  for (const { key, model } of bodies) {
    const id = key.replace(':', '-');
    const own = new Set<BufferGeometry>([model.shell, model.glass, model.interior, model.openShell, model.openGlass,
      model.openInterior, model.trim, model.far, ...model.doors.flatMap((d) => [d.panel, d.glass, ...(d.card ? [d.card] : [])])]);
    if (model.roof) own.add(model.roof);
    if (model.accent) own.add(model.accent);
    if (model.steering) own.add(model.steering.geometry);
    modelGeometries.push(...own);
    carParts.set(key, {
      model,
      shell: instanced(`car-${id}-shell`, model.shell, paint, MAX_VEHICLES),
      glass: instanced(`car-${id}-glass`, model.glass, glassMaterial, MAX_VEHICLES, false),
      interior: instanced(`car-${id}-interior`, model.interior, cabinMaterial, MAX_VEHICLES, false),
      openShell: instanced(`car-${id}-openshell`, model.openShell, paint, MAX_VEHICLES),
      openGlass: instanced(`car-${id}-openglass`, model.openGlass, glassMaterial, MAX_VEHICLES, false),
      openInterior: instanced(`car-${id}-openinterior`, model.openInterior, cabinMaterial, MAX_VEHICLES, false),
      doors: model.doors.map((d, i) => instanced(`car-${id}-door${i}`, d.panel, paint, MAX_VEHICLES)),
      doorGlass: model.doors.map((d, i) => instanced(`car-${id}-doorglass${i}`, d.glass, glassMaterial, MAX_VEHICLES, false)),
      doorCards: model.doors.map((d, i) => d.card ? instanced(`car-${id}-doorcard${i}`, d.card, cabinMaterial, MAX_VEHICLES, false) : null),
      trim: instanced(`car-${id}-trim`, model.trim, trim, MAX_VEHICLES, false),
      roof: model.roof ? instanced(`car-${id}-roof`, model.roof, paint, MAX_VEHICLES) : null,
      roofGlass: model.roof ? instanced(`car-${id}-roofglass`, model.roof, glassMaterial, MAX_VEHICLES, false) : null,
      accent: model.accent ? instanced(`car-${id}-accent`, model.accent, paint, MAX_VEHICLES) : null,
      far: instanced(`car-${id}-far`, model.far, paint, MAX_VEHICLES),
      steering: model.steering ? instanced(`car-${id}-wheel`, model.steering.geometry, cabinMaterial, MAX_VEHICLES, false) : null,
    });
  }
  const carPartList: Part[] = [...carParts.values()].flatMap((c) => [
    c.shell, c.glass, c.interior, c.openShell, c.openGlass, c.openInterior, ...c.doors, ...c.doorGlass,
    ...c.doorCards.filter((p): p is Part => p !== null), c.trim, c.far,
    ...[c.roof, c.roofGlass, c.accent, c.steering].filter((p): p is Part => p !== null),
  ]);

  interface TwoWheelerParts {
    readonly model: TwoWheelerModel;
    readonly body: Part;
    readonly trim: Part;
    readonly steering: Part;
    readonly cranks: Part | null;
  }
  const twoWheelerParts = new Map<string, TwoWheelerParts>();
  for (const archetype of ARCHETYPES) {
    if (archetype.shape !== 'motorcycle' && archetype.shape !== 'bicycle') continue;
    const model = buildTwoWheelerModel(archetype);
    const id = archetype.id;
    modelGeometries.push(model.body, model.trim, model.steering, ...(model.cranks ? [model.cranks] : []));
    twoWheelerParts.set(id, {
      model,
      body: instanced(`bike-${id}-body`, model.body, paint, MAX_RIDERS),
      trim: instanced(`bike-${id}-trim`, model.trim, trim, MAX_RIDERS),
      steering: instanced(`bike-${id}-steering`, model.steering, trim, MAX_RIDERS, false),
      cranks: model.cranks ? instanced(`bike-${id}-cranks`, model.cranks, trim, MAX_RIDERS, false) : null,
    });
  }
  const twoWheelerPartList: Part[] = [...twoWheelerParts.values()].flatMap((t) =>
    [t.body, t.trim, t.steering, ...(t.cranks ? [t.cranks] : [])]);
  const allParts: readonly Part[] = [...parts, ...carPartList, ...twoWheelerPartList];

  // The whole roster of eighty: a crowd drawn from four test bodies, left in
  // while the walk was being worked on, read as one family cloned down the
  // street.
  const pedestrians = createRiggedCitizens(CROWD_IDS, onAssetsReady);
  const meshes = [...allParts.map((part) => part.mesh), pedestrians.group];

  const object = new Object3D();
  // Yaw outermost, so the third Euler component becomes a rotation about the
  // agent's own lateral axis: a raked windscreen, a leaning rider, a swinging
  // leg. With this order a positive rake tips a part's top towards the rear.
  object.rotation.order = 'YXZ';
  const colour = new Color();

  // The palettes hold a few dozen distinct strings between them, so caching by
  // the string avoids running the CSS parser — which allocates — once per agent
  // per frame.
  const hexCache = new Map<string, number>();
  const hexOf = (css: string): number => {
    let hex = hexCache.get(css);
    if (hex === undefined) {
      colour.set(css);
      hex = colour.getHex();
      hexCache.set(css, hex);
    }
    return hex;
  };

  // Frame of the agent currently being written. Held here rather than passed,
  // so `place` takes offsets in the agent's own frame and allocates nothing.
  // The detail band the current vehicle and its occupants are drawn at.
  let occupantBand = 0;
  let fx = 0;
  let fy = 0;
  let fdx = 1;
  let fdy = 0;
  let fyaw = 0;
  let fdeck = 0;
  // Lean of a two-wheeler into a bend, radians, positive to the left; the
  // whole frame rolls about the line where the tyres touch the road.
  let froll = 0;
  let fcos = 1;
  let fsin = 0;
  /**
   * THE vehicle's one transform, as a rotation: yaw, then pitch about its
   * lateral axis, then roll about its own forward axis (road camber less a
   * two-wheeler's lean). Every part - body, glass, wheels, lamps, the wheel,
   * the people in it - is placed through it, and nothing samples its own
   * height. Before, each vehicle had one height at its centre and a frame
   * with yaw only: on a gradient the body stayed level, one axle's wheels
   * sank and the other's floated, and raked parts slid against the body.
   */
  const fq = new Quaternion();
  const qPitch = new Quaternion();
  const qRoll = new Quaternion();
  const qPart = new Quaternion();
  const qLocal = new Quaternion();
  const vOffset = new Vector3();
  const AXIS_Y = new Vector3(0, 1, 0);
  const AXIS_Z = new Vector3(0, 0, 1);
  const AXIS_X = new Vector3(1, 0, 0);
  const eulerScratch = new Object3D();
  eulerScratch.rotation.order = 'YXZ';

  const frameAt = (x: number, y: number, angle: number, deck: number, roll = 0, pitch = 0, roadRoll = 0): void => {
    fx = x;
    fy = y;
    fyaw = angle;
    fdx = Math.cos(angle);
    fdy = Math.sin(angle);
    fdeck = deck;
    froll = roll;
    fcos = Math.cos(roll);
    fsin = Math.sin(roll);
    fq.setFromAxisAngle(AXIS_Y, angle);
    qPitch.setFromAxisAngle(AXIS_Z, pitch);
    qRoll.setFromAxisAngle(AXIS_X, roadRoll - roll);
    fq.multiply(qPitch).multiply(qRoll);
  };

  /** A point in the current frame (forward, up, left) to world (x, y) and height. */
  const toWorld = (along: number, up: number, side: number, out: { x: number; y: number; h: number }): void => {
    vOffset.set(along, up, -side).applyQuaternion(fq);
    out.x = fx + vOffset.x;
    out.y = fy - vOffset.z;
    out.h = fdeck + vOffset.y;
  };
  const partPoint = { x: 0, y: 0, h: 0 };

  /** Per-vehicle suspension state: the frame eases towards the road, never snaps. */
  const suspension = new Map<number, { deck: number; pitch: number; roll: number; seen: number }>();
  let suspensionClock = typeof performance !== 'undefined' ? performance.now() : 0;
  let suspensionDt = 0;
  let suspensionFrame = 0;

  /**
   * Writes one instance, positioned in the current agent's frame.
   *
   * `along` runs forward, `side` runs to the agent's left and `up` is height
   * above the road surface; the world-to-three mapping is (x, y) -> (x, h, -y)
   * and a world heading is the three yaw directly. `tint` below zero leaves the
   * instance colour alone, for parts whose material already says everything.
   */
  const place = (
    part: Part,
    along: number,
    side: number,
    up: number,
    sx: number,
    sy: number,
    sz: number,
    tint: number,
    rake = 0,
    yaw = 0,
  ): void => {
    if (part.n >= part.mesh.instanceMatrix.count) return;
    // Through the vehicle's one transform (`fq`): position and orientation
    // both, so a lean or a gradient carries every part together.
    toWorld(along, up, side, partPoint);
    object.position.set(partPoint.x, partPoint.h, -partPoint.y);
    eulerScratch.rotation.set(0, yaw, rake);
    qLocal.setFromEuler(eulerScratch.rotation);
    qPart.copy(fq).multiply(qLocal);
    object.quaternion.copy(qPart);
    object.scale.set(sx, sy, sz);
    object.updateMatrix();
    part.mesh.setMatrixAt(part.n, object.matrix);
    if (tint >= 0) {
      colour.setHex(tint);
      part.mesh.setColorAt(part.n, colour);
      part.tinted = true;
    }
    part.n++;
  };

  /** Road wheels, plus their hubs at the closest band. */
  const placeWheels = (plan: BodyPlan, band: number): void => {
    const d = plan.wheelRadius * 2;
    plan.axleAlong.forEach((along, axle) => {
      // Only the front axle steers; every hub turns with the distance driven,
      // which is what makes a wheel read as rolling rather than sliding.
      const steer = axle === 0 ? lamp.steer : 0;
      if (plan.shape === 'bicycle') {
        place(thinWheels, along, 0, plan.wheelRadius, d, d, plan.tread, RUBBER, 0, steer);
        place(spokes, along, 0, plan.wheelRadius, d, d, plan.tread, CHROME, lamp.spin, steer);
        return;
      }
      if (plan.axleSide === 0) {
        place(wheels, along, 0, plan.wheelRadius, d, d, plan.tread, RUBBER, 0, steer);
        if (band >= 1) {
          place(hubs, along, 0, plan.wheelRadius, d * 0.45, d * 0.45, plan.tread * 1.1, HUB, lamp.spin, steer);
        }
        return;
      }
      for (const side of SIDES) {
        place(wheels, along, side * plan.axleSide, plan.wheelRadius, d, d, plan.tread, RUBBER, 0, steer);
        if (band >= 1) {
          place(
            hubs,
            along,
            side * (plan.axleSide + plan.tread * 0.3),
            plan.wheelRadius,
            d * 0.52,
            d * 0.52,
            plan.tread * 0.5,
            HUB,
            lamp.spin,
            steer,
          );
        }
      }
    });
  };

  /**
   * Hatchback, sedan, SUV and van, from the class's model (`vehicleModels.ts`):
   * a shaped body with its wheel arches, doors on hinges, glass you can see
   * through, and a cabin with seats and a wheel.
   */
  const drawCar = (vehicle: SimVehicle, plan: BodyPlan, paintHex: number, look: VehicleLook, band: number): void => {
    const car = carParts.get(bodyKey(vehicle));
    if (!car) return;
    const model = car.model;
    if (band < 1) {
      // Far away: one opaque, low-poly body, glass and wheels painted on.
      place(car.far, 0, 0, 0, 1, 1, 1, paintHex);
      for (const l of model.taillamps) place(lamps, l.x, -l.z, l.y, l.sx, l.sy, l.sz, lamp.tail);
      return;
    }
    const doorsMoving = vehicle.doors.length > 0;
    if (!doorsMoving && look.windowsDown === 0) {
      place(car.shell, 0, 0, 0, 1, 1, 1, paintHex);
      place(car.glass, 0, 0, 0, 1, 1, 1, -1);
    } else if (!doorsMoving) {
      // A window down: the fixed glazing, then each door's window, lowered
      // into its door - behind the painted skin and the door card, so it is
      // never seen outside the door, and the person beside it shows through
      // the opening. `windowsDown` was worked out for every car and never
      // read: every window was always shut.
      place(car.shell, 0, 0, 0, 1, 1, 1, paintHex);
      place(car.openGlass, 0, 0, 0, 1, 1, 1, -1);
      model.doors.forEach((door, i) => {
        const down = (look.windowsDown & (door.side === -1 ? 1 : 2)) !== 0 && door.kind === 'hinge';
        const pane = windowPane(door, down ? look.windowDrop : 0);
        if (pane.visible) place(car.doorGlass[i]!, door.hingeX, -door.hingeZ, pane.up, 1, pane.sy, 1, -1);
      });
    } else {
      place(car.openShell, 0, 0, 0, 1, 1, 1, paintHex);
      place(car.openGlass, 0, 0, 0, 1, 1, 1, -1);
      model.doors.forEach((door, i) => {
        const open = doorOpening(vehicle, door.index);
        if (door.kind === 'slide') {
          // A plug door: out a little, then along the body.
          const out = Math.min(1, open * 4) * m(0.07);
          const along = door.hingeX + door.slide * smooth01((open - 0.15) / 0.85);
          const across = -(door.hingeZ + door.side * out);
          place(car.doors[i]!, along, across, 0, 1, 1, 1, paintHex);
          place(car.doorGlass[i]!, along, across, 0, 1, 1, 1, -1);
          return;
        }
        // Swung about the hinge, outwards on its own side.
        const swing = open * DOOR_SWING;
        place(car.doors[i]!, door.hingeX, -door.hingeZ, 0, 1, 1, 1, paintHex, 0, door.side * swing);
        place(car.doorGlass[i]!, door.hingeX, -door.hingeZ, 0, 1, 1, 1, -1, 0, door.side * swing);
      });
    }
    if (car.roof && car.roofGlass) {
      if (look.glassRoof) place(car.roofGlass, 0, 0, 0, 1, 1, 1, -1);
      else place(car.roof, 0, 0, 0, 1, 1, 1, look.blackRoof ? 0x15171a : paintHex);
    }
    if (car.accent) place(car.accent, 0, 0, 0, 1, 1, 1, look.accent);
    placeWheels(plan, band);

    place(car.trim, 0, 0, 0, 1, 1, 1, -1);
    for (const l of model.headlamps) place(lamps, l.x, -l.z, l.y, l.sx, l.sy, l.sz, HEADLAMP);
    for (const l of model.taillamps) place(lamps, l.x, -l.z, l.y, l.sx, l.sy, l.sz, lamp.tail);
    for (const l of model.indicators) {
      // `lamp.indicate` is +1 for left, and the model's left is -Z.
      if (lamp.indicate !== 0 && lamp.indicate === -l.side) {
        place(lamps, l.x, -l.z, l.y, l.sx * 1.2, l.sy, l.sz, INDICATOR);
      }
    }
    if (band < 2) return;
    if (!doorsMoving) place(car.interior, 0, 0, 0, 1, 1, 1, -1);
    else {
      place(car.openInterior, 0, 0, 0, 1, 1, 1, -1);
      model.doors.forEach((door, i) => {
        const card = car.doorCards[i];
        if (!card || door.kind !== 'hinge') return;
        place(card, door.hingeX, -door.hingeZ, 0, 1, 1, 1, -1, 0, door.side * doorOpening(vehicle, door.index) * DOOR_SWING);
      });
    }
    model.plates.forEach((l, i) => place(lamps, l.x, -l.z, l.y, l.sx, l.sy, l.sz, i < 2 ? PLATE : DESTINATION));
    placeCarOccupants(vehicle, car);
  };

  /** The company a vehicle's people are cast in (`citizenCasting.codesFor`). */
  const vehicleCompany = (vehicle: SimVehicle): Company =>
    vehicle.archetype.shape === 'bus' ? 'bus' : vehicle.archetype.shape === 'truck' ? 'truck'
      : vehicle.archetype.shape === 'motorcycle' || vehicle.archetype.shape === 'bicycle' ? 'rider' : 'car';
  /** Whether anybody aboard is a child: a car with a child in it is never on a work trip. */
  const carriesChild = (vehicle: SimVehicle): boolean => {
    const seats = Math.min(32, vehicle.archetype.seats);
    for (let i = 0; i < seats; i++) if ((vehicle.seats & (1 << i)) !== 0 && seatPerson(vehicle, i).ageClass === 'child') return true;
    return false;
  };
  /** Who sits in (or steps out of) a seat: the seat's person, cast with the vehicle's company. */
  const seatIdentity = (vehicle: SimVehicle, person: { seed: number; gender: 'f' | 'm'; ageClass: 'child' | 'adult' | 'elder' },
    hasChild: boolean): ClipIdentity => ({ seed: person.seed, gender: person.gender, ageClass: person.ageClass,
    company: vehicleCompany(vehicle), companyId: vehicle.id, hasChild });

  /** The whole person in a seat: its world point, written without allocating. */
  const seatPoint: { x: number; y: number; h?: number } = { x: 0, y: 0, h: 0 };

  /**
   * The people in a car, each in a seat of the model: the driver at the wheel
   * on the left, then the front passenger, then the rear bench; on a bus the
   * passengers upright in its seats.
   */
  const placeCarOccupants = (vehicle: SimVehicle, car: CarParts): void => {
    if (occupantBand < 1) return;
    const model = car.model;
    // Who is sitting where is the simulation's (`Vehicle.seats`): people get
    // in and out at the kerb, and somebody on the way in or out is drawn by
    // `placeKerbPerson`, not in the seat.
    const moving = vehicle.kerbStop?.phase === 'transfer' ? vehicle.kerbStop.seat : -1;
    let driverScale = 0;
    // Only the seats the simulation can fill: `Vehicle.seats` is a 32-bit
    // mask, and `1 << 32` is 1 again in JavaScript. A bus has more seats than
    // that, and seats 32 onwards read the bits of seats 0 onwards - seven
    // phantom passengers in the back of every bus, some of them twins of the
    // people really aboard.
    const seatCount = Math.min(model.seats.length, vehicle.archetype.seats);
    const hasChild = carriesChild(vehicle);
    // A person picked up from the street already has a visible identity. Cast
    // them first so generated seat occupants follow that person's dress code.
    for (const pickedFirst of [true, false]) for (let index = 0; index < seatCount; index++) {
      if ((vehicle.seats & (1 << index)) === 0 || index === moving) continue;
      if ((vehicle.people[index] !== undefined) !== pickedFirst) continue;
      const seat = model.seats[index]!;
      if (seat.row > rowsDrawn) continue;
      seatWorldInto(seat, seatPoint, seat.hipY);
      const who = seatIdentity(vehicle, seatPerson(vehicle, index), hasChild);
      // The seat's pose (`riderPoses.ts`) with a glance now and then
      // (`occupants.ts`). A car seat sizes its occupant to clear the roof
      // lining; an upright cab or bus seat, whose feet must be on the floor,
      // draws them at the size the pose was solved at.
      const plays = occupantPlays(seat, who.seed, frameClock, seatPlays);
      const fixed = seat.pose === 'car' ? 0 : 1;
      const drawn = pedestrians.drawClip(who, seatPoint.x, seatPoint.y, seatPoint.h ?? fdeck + seat.hipY, fyaw, plays as readonly { key: CitizenClipKey; phase: number; weight: number }[],
        0, seatFitScale(seat), false, fixed);
      if (seat.driver) driverScale = drawn;
    }
    // The wheel where this driver's hands are: at their own size, and turned
    // with the front wheels.
    if (car.steering && model.steering) {
      const seat = model.seats[model.steering.seat]!;
      const wheel = model.steering.wheel;
      const s = driverScale > 0 ? driverScale / m(1) : 1;
      placeSteeringWheel(car.steering, seat.x + m(wheel.forward) * s, -seat.z, seat.hipY + m(wheel.up) * s,
        wheel.tilt, Math.max(-1.6, Math.min(1.6, lamp.steer * 5)), s);
    }
    const stop = vehicle.kerbStop;
    if (stop) placeKerbPerson(vehicle, model, stop);
  };

  /** Reused by every seated person: what they play this frame. */
  const seatPlays: Play[] = [];
  /** Seconds of simulation, for the occupants' own motion; set per vehicle. */
  let frameClock = 0;
  /** Seat rows drawn this frame (`SeatModel.row`); set per sync from the zoom. */
  let rowsDrawn = Infinity;

  /** A steering wheel about its column: yaw with the vehicle, tilt, then the turn. */
  const placeSteeringWheel = (part: Part, along: number, side: number, up: number, tilt: number, turn: number, size = 1): void => {
    if (part.n >= part.mesh.instanceMatrix.count) return;
    toWorld(along, up, side, partPoint);
    object.position.set(partPoint.x, partPoint.h, -partPoint.y);
    eulerScratch.rotation.order = 'YZX';
    eulerScratch.rotation.set(turn, 0, tilt);
    qLocal.setFromEuler(eulerScratch.rotation);
    eulerScratch.rotation.order = 'YXZ';
    object.quaternion.copy(fq).multiply(qLocal);
    // The rim at the driver's size too, so the hands on it are on it.
    object.scale.set(size, size, size);
    object.updateMatrix();
    part.mesh.setMatrixAt(part.n, object.matrix);
    part.n++;
  };

  const seatWorld = (seat: { x: number; z: number }): { x: number; y: number } =>
    ({ x: fx + fdx * seat.x + fdy * seat.z, y: fy + fdy * seat.x - fdx * seat.z });
  /**
   * A seat (X forward, Z to the right, `up` above the road) to world, through
   * the vehicle's transform: on a gradient the people ride with the car.
   */
  const seatWorldInto = (seat: { x: number; z: number }, out: { x: number; y: number; h?: number }, up = 0): void => {
    toWorld(seat.x, up, -seat.z, partPoint);
    out.x = partPoint.x;
    out.y = partPoint.y;
    out.h = partPoint.h;
  };

  /** Somebody at the kerb this frame (`occupants.kerbFigure`), reused. */
  const kerb = createKerbFigure();
  /** A world point in the current vehicle's frame: X forward, Z to the right. */
  const toVehicle = (x: number, y: number): { x: number; z: number } => {
    const dx = x - fx;
    const dy = y - fy;
    return { x: dx * fdx + dy * fdy, z: dx * fdy - dy * fdx };
  };

  /**
   * Somebody getting out at the kerb, or in. At a hinged door
   * (`occupants.kerbFigure`): turned on the seat towards the open door, onto
   * the sill with the feet on the road, up out of the car in the opening, and
   * round the back of the open door to the footway - or all of it the other
   * way round. At a bus's plug door, a step up through it. Positions come
   * from the body model's seat and door, the timing from the simulation
   * (`kerbTransfer`).
   */
  const placeKerbPerson = (vehicle: SimVehicle, model: VehicleModel, stop: KerbStop): void => {
    const progress = kerbTransfer(stop);
    const person = stop.person;
    const door = model.doors.find((d) => d.index === stop.door);
    if (!progress || !person || !door) return;
    const side = door.side;
    const along = door.hingeX - door.length / 2;
    const flank = Math.abs(door.hingeZ);
    const seat = stop.seatStage ? model.seats[stop.seat] : undefined;
    const identity = seatIdentity(vehicle, person, carriesChild(vehicle));
    if (seat && door.kind === 'hinge' && !(progress.walked >= 1 && (stop.phase === 'hold' || stop.phase === 'close'))) {
      const f = kerbFigure({ seat, door, foot: toVehicle(person.footX, person.footY) }, stop.kind, progress.seated, progress.walked, kerb);
      seatWorldInto(f, seatPoint, f.y);
      pedestrians.drawClip(identity, seatPoint.x, seatPoint.y, seatPoint.h ?? fdeck + f.y, fyaw + f.heading, f.plays,
        0, f.seated ? seatFitScale(seat) : Infinity, f.anchor === 'pelvis' ? false : f.anchor === 'feet' ? true : 'pelvisOver');
      return;
    }
    // Just outside the door opening on the road, and just inside it.
    const outside = seatWorld({ x: along, z: side * (flank + m(0.45)) });
    const inside = seatWorld({ x: along, z: side * (flank - m(0.4)) });
    const walkTo = (fromX: number, fromY: number, toX: number, toY: number, t: number, height: number): void => {
      const x = fromX + (toX - fromX) * t;
      const y = fromY + (toY - fromY) * t;
      const distance = Math.hypot(toX - fromX, toY - fromY);
      const heading = Math.atan2(toY - fromY, toX - fromX);
      pedestrians.drawClip(identity, x, y, height, heading,
        [{ key: 'walk', phase: 0, distance: distance * t, weight: 1 }], 0, Infinity, true);
    };
    if (progress.walked >= 1 && (stop.phase === 'hold' || stop.phase === 'close')) {
      // Standing on the footway: the truck's mate with the load, facing the truck.
      pedestrians.drawClip(identity, person.footX, person.footY, fdeck,
        Math.atan2(outside.y - person.footY, outside.x - person.footX),
        [{ key: 'idle', phase: (stop.t * 0.1) % 1, weight: 1 }], 0, Infinity, true);
      return;
    }
    if (progress.walked > 0 || progress.seated <= 0) {
      // Between the door and the footway.
      if (stop.kind === 'drop') walkTo(outside.x, outside.y, person.footX, person.footY, progress.walked, fdeck);
      else walkTo(person.footX, person.footY, outside.x, outside.y, 1 - progress.walked, fdeck);
      return;
    }
    // A bus: stepping up through the door, then gone inside.
    const t = stop.kind === 'drop' ? 1 - progress.seated : progress.seated;
    if (stop.kind === 'pick' && t > 0.9) return;
    walkTo(outside.x, outside.y, inside.x, inside.y, stop.kind === 'pick' ? t : 1 - t, fdeck + m(0.25) * t);
  };

  /**
   * A motorcycle or a bicycle from its model: the frame and bodywork, the
   * steering assembly turned about the head tube, the cranks of a bicycle
   * turned by the pedalling, and the rider astride it. The frame state
   * already carries the lean (`frameAt`), so every part tips with it.
   */
  const drawTwoWheeler = (vehicle: SimVehicle, plan: BodyPlan, paintHex: number, look: VehicleLook, band: number): void => {
    const bike = twoWheelerParts.get(vehicle.archetype.id);
    if (!bike) return;
    const model = bike.model;
    place(bike.body, 0, 0, 0, 1, 1, 1, paintHex);
    place(bike.steering, model.headX, 0, model.headY, 1, 1, 1, CHROME, 0, lamp.steer);
    placeWheels(plan, band);
    if (band < 1) return;
    place(bike.trim, 0, 0, 0, 1, 1, 1, TRIM);
    if (bike.cranks) place(bike.cranks, model.bracketX, 0, model.bracketY, 1, 1, 1, CHROME, -lamp.crank);
    const h = model.headlamp;
    place(lamps, h.x, 0, h.y, h.sx, h.sy, h.sz, HEADLAMP, 0, lamp.steer);
    const t = model.taillamp;
    place(lamps, t.x, 0, t.y, t.sx, t.sy, t.sz, lamp.tail);
    placeRiderFigure(vehicle, model, plan.shape === 'bicycle', look);
  };

  /**
   * The person astride: a baked IK pose (`riderPoses.ts`) with the hands on
   * the grips and the feet on the pegs or pedals, blended towards the stopped
   * pose (a foot down) as the machine comes to rest and towards the steering
   * poses as the bars turn; pedalling follows the cranks exactly. The pelvis
   * is placed on the seat with the frame's lean, and the figure leans with it.
   */
  const placeRiderFigure = (vehicle: SimVehicle, model: TwoWheelerModel, cyclist: boolean, look: VehicleLook): void => {
    if (occupantBand < 1) return;
    const pelvisUp = model.seatY;
    // The seat point rolled about the road-level forward axis (`place`).
    const sideOffset = pelvisUp * fsin;
    const x = fx + fdx * model.seatX - fdy * sideOffset;
    const y = fy + fdy * model.seatX + fdx * sideOffset;
    const height = fdeck + pelvisUp * fcos;
    const moving = riderMoving(vehicle);
    const steer = Math.max(-1, Math.min(1, lamp.steer / STEER_FULL));
    const plays = riderPlays;
    plays.length = 0;
    if (cyclist) {
      const phase = (-lamp.crank - Math.PI) / (2 * Math.PI);
      plays.push({ key: 'bikePedal', phase, weight: moving * (1 - Math.abs(steer) * 0.4) });
      if (steer > 0) plays.push({ key: 'bikeLeft', phase: 0, weight: moving * steer * 0.4 });
      if (steer < 0) plays.push({ key: 'bikeRight', phase: 0, weight: moving * -steer * 0.4 });
      plays.push({ key: 'bikeStop', phase: 0, weight: 1 - moving });
    } else {
      plays.push({ key: 'motoRide', phase: 0, weight: moving * (1 - Math.abs(steer)) });
      if (steer > 0) plays.push({ key: 'motoLeft', phase: 0, weight: moving * steer });
      if (steer < 0) plays.push({ key: 'motoRight', phase: 0, weight: moving * -steer });
      plays.push({ key: 'motoStop', phase: 0, weight: 1 - moving });
    }
    // At the size the pose was solved at: the hands are on the grips and the
    // feet on the pegs or pedals only there.
    const drawn = pedestrians.drawClip(seatIdentity(vehicle, seatPerson(vehicle, 0), false), x, y, height, fyaw, plays, froll, Infinity, false, 1,
      cyclist ? null : helmetMatrix);
    if (!cyclist && drawn > 0 && helmets.n < helmets.mesh.instanceMatrix.count) {
      // A motorcyclist's helmet, fitted to this body's head
      // (`riderPoses.helmetShape`) and put where the pose just drawn has it.
      helmets.mesh.setMatrixAt(helmets.n, helmetMatrix);
      colour.setHex(look.helmet);
      helmets.mesh.setColorAt(helmets.n, colour);
      helmets.tinted = true;
      helmets.n++;
    }
  };

  /** The helmet of the rider just drawn (`drawClip`). */
  const helmetMatrix = new Matrix4();



  /** Refreshed for every vehicle, read by whichever body builder runs. */
  const lamp: LampState = { tail: TAILLAMP, indicate: 0, steer: 0, spin: 0, crank: 0 };
  const odometer = new WheelOdometer();

  return {
    meshes,
    census: () => pedestrians.census(),
    setNight: (dark) => {
      lampMaterial.color.setScalar(1 + 2.4 * dark);
    },
    sync(world, alpha, detailed, zoom = Number.POSITIVE_INFINITY, options = {}) {
      const now = typeof performance !== 'undefined' ? performance.now() : suspensionClock + 16;
      suspensionDt = Math.min(0.1, Math.max(0, (now - suspensionClock) / 1000));
      suspensionClock = now;
      suspensionFrame++;
      if (suspensionFrame % 600 === 0) {
        for (const [id, ride] of suspension) if (suspensionFrame - ride.seen > 120) suspension.delete(id);
      }
      pedestrians.begin(options.pedestrianDetail ?? 2, zoom);
      for (const part of allParts) part.n = 0;
      const band = !detailed ? 0 : zoom >= NEAR_DETAIL_ZOOM ? 2 : 1;
      // Vehicles have their own bands: the far proxy below FAR_BODY_ZOOM, the
      // whole body above it, the cabin and the people in it from the zoom the
      // quality tier allows them at.
      const occupantZoom = options.occupantZoom ?? OCCUPANT_ZOOM;
      const vehicleBand = !detailed || zoom < FAR_BODY_ZOOM ? 0 : zoom >= occupantZoom ? 2 : 1;
      // Between the occupant zoom and 1.6 times it, only the front row.
      rowsDrawn = zoom >= occupantZoom * 1.6 ? Infinity : 0;

      let drawn = 0;
      for (const vehicle of world.vehiclesInIdOrder()) {
        if (drawn >= MAX_VEHICLES) break;
        const pose = vehiclePose(world, vehicle, alpha);
        if (!pose) continue;
        const lane = world.lanelet(vehicle.lanelet);
        const plan = planOf(vehicle.archetype);
        const twoWheeled = plan.shape === 'motorcycle' || plan.shape === 'bicycle';
        const deck = elevationAt(world, pose.p.x, pose.p.y, lane?.segment);
        // Off screen, and too far from it for its shadow to fall on it:
        // nothing of this vehicle is written this frame.
        if (options.vehicleVisible && !options.vehicleVisible(pose.p.x, pose.p.y, deck, plan.length * 0.5 + plan.height * 2)) continue;
        // A two-wheeler leans into its bend and, stopped, tilts onto the
        // rider's foot on the road (`TwoWheelerFit.stopTilt`).
        const fit = twoWheeled ? twoWheelerParts.get(vehicle.archetype.id)?.model.fit : undefined;
        // The road under each axle and each side: pitch from the axles, roll
        // from the sides, height where the frame's origin sits between them.
        // Sampled on the vehicle's own road, so a deck or a bore is what it
        // rides on, never the ground under or over it.
        const front = plan.axleAlong[0] ?? plan.length * 0.35;
        const rear = plan.axleAlong[plan.axleAlong.length - 1] ?? -plan.length * 0.35;
        const seg = lane?.segment ?? (lane ? world.connector(lane.id)?.inSegment : undefined);
        const onRoad = (x: number, y: number): number => elevationAt(world, x, y, seg);
        const want = roadFrame(onRoad, pose.p.x, pose.p.y, pose.angle, front, rear,
          twoWheeled ? 0 : plan.axleSide, deck);
        const wantDeck = want.deck;
        const wantPitch = want.pitch;
        const wantRoll = want.roll;
        // Suspension: pitch and roll ease towards the road over a few
        // hundredths of a second, so a change of grade is ridden, not jolted.
        // The HEIGHT follows the road exactly: eased too, it lagged the road
        // by metres at speed and the wheels sank into a climb (the contact
        // test, tests/render/vehicleFrame.spec.ts). Grade breaks themselves
        // are rounded by the road's vertical curves (world/elevation.ts).
        let ride = suspension.get(vehicle.id);
        if (!ride || Math.abs(ride.pitch - wantPitch) > 0.2) {
          ride = { deck: wantDeck, pitch: wantPitch, roll: wantRoll, seen: suspensionFrame };
          suspension.set(vehicle.id, ride);
        } else {
          const k = 1 - Math.exp(-suspensionDt / SUSPENSION_TAU);
          ride.pitch += (wantPitch - ride.pitch) * k;
          ride.roll += (wantRoll - ride.roll) * k;
          ride.deck = wantDeck;
          ride.seen = suspensionFrame;
        }
        frameAt(pose.p.x, pose.p.y, pose.angle, ride.deck,
          twoWheeled ? leanOf(world, vehicle) + (fit ? fit.stopTilt * (1 - riderMoving(vehicle)) : 0) : 0,
          ride.pitch, ride.roll);
        const paintHex = hexOf(vehicle.color);
        const look = vehicleLook(vehicle.id, plan.seats);
        occupantBand = vehicleBand;
        frameClock = vehicle.age;

        // Brakes and indicators, straight off the simulation. `prev` is the
        // previous step's kinematics, so the difference is this step's
        // acceleration without storing anything new on the vehicle.
        const decel = (vehicle.prev.v - vehicle.v) / DT;
        lamp.tail = decel >= BRAKE_DECEL ? BRAKELAMP : TAILLAMP;
        // `lateral` is the unfinished part of a lane change, signed towards
        // the lane being left - so the vehicle is heading the other way.
        // Indicators for a turn ahead, a lane change wanted or under way, and
        // flashing (`vehicleSignals.ts`); the front wheels steer along the
        // path and every wheel rolls with the distance driven.
        const side = indicatorSide(world, vehicle);
        lamp.indicate = side !== 0 && blinkOn(vehicle.age, vehicle.id) ? side : 0;
        const axles = plan.axleAlong;
        lamp.steer = steerAngle(world, vehicle, (axles[0] ?? 0) - (axles[axles.length - 1] ?? 0));
        const driven = odometer.advance(vehicle);
        lamp.spin = -driven / Math.max(plan.wheelRadius, 1e-3);
        // A bicycle's cranks turn a little over half a turn per turn of the
        // wheel: about 80 rpm at a city cyclist's 18 km/h.
        lamp.crank = (driven / (2 * Math.PI * Math.max(plan.wheelRadius, 1e-3))) * CRANK_RATIO * 2 * Math.PI;
        switch (plan.shape) {
          case 'motorcycle':
          case 'bicycle':
            drawTwoWheeler(vehicle, plan, paintHex, look, Math.max(1, vehicleBand));
            break;
          case 'car':
          case 'bus':
          case 'truck':
            drawCar(vehicle, plan, paintHex, look, vehicleBand);
            break;
        }
        drawn++;
      }

      // Pedestrians start at band 1: zoomed out past it a whole person is
      // smaller than a car's wing mirror, and drawing the crowd there costs
      // more than the entire fleet does.
      if (band >= 1) {
        let pedCount = 0;
        for (const ped of world.pedViews) {
          if (pedCount >= MAX_PEDS) break;
          const pose = pedPose(ped, alpha);
          const open = ped.ground === 'open';
          const segment = ped.segment;
          const land = open && groundAt ? groundAt : (gx: number, gy: number) => elevationAt(world, gx, gy, segment);
          const deck = open ? land(pose.p.x, pose.p.y) + m(0.04)
            : elevationAt(world, pose.p.x, pose.p.y, segment) +
              (ped.ground === 'crossing' ? 0 : FOOTWAY_RISE);
          if (options.pedestrianVisible && !options.pedestrianVisible(pose.p.x, pose.p.y, deck)) continue;
          frameAt(pose.p.x, pose.p.y, pose.angle, deck);
          // The rise is the same on both sides of the difference, so the
          // gradient is the road's own under the walker.
          const ground = groundGradient(land,
            pose.p.x, pose.p.y, deck - (open ? m(0.04) : ped.ground === 'crossing' ? 0 : FOOTWAY_RISE));
          pedestrians.draw(ped, pose.p.x, pose.p.y, pose.angle, deck, alpha, ground);
          pedCount++;
        }
      }

      pedestrians.finish();

      // Upload only what was written this frame.
      //
      // `needsUpdate = true` with no range makes three re-send the WHOLE
      // attribute. These buffers are sized for the population ceiling, so
      // uploading their entire capacity wastes bandwidth on unused instances.
      // The written prefix is usually a tiny fraction of that.
      for (const part of allParts) {
        part.mesh.count = part.n;
        // An empty instanced mesh still costs a program bind, its uniforms
        // and a state change in every pass, the shadow pass included: there
        // are a hundred and fifty of them and most are empty most frames.
        part.mesh.visible = part.n > 0;
        const matrix = part.mesh.instanceMatrix;
        matrix.clearUpdateRanges();
        if (part.n > 0) matrix.addUpdateRange(0, part.n * 16);
        matrix.needsUpdate = true;

        const colour = part.mesh.instanceColor;
        if (colour && part.tinted) {
          colour.clearUpdateRanges();
          if (part.n > 0) colour.addUpdateRange(0, part.n * 3);
          colour.needsUpdate = true;
        }
        part.tinted = false;
      }
    },
    dispose() {
      pedestrians.dispose();
      for (const geometry of [
        unitBox,
        torsoGeometry,
        wheelGeometry,
        hubGeometry,
        thinTyreGeometry,
        spokedGeometry,
        headGeometry,
        helmetGeometry,
      ]) {
        geometry.dispose();
      }
      for (const geometry of modelGeometries) geometry.dispose();
      for (const material of [paint, trim, glassMaterial, rubber, lampMaterial, cloth, cabinMaterial]) {
        material.dispose();
      }
    },
  };
}

/** Narrows a unit box towards its top, in place. */
function taper(geometry: BufferGeometry, topX: number, topZ: number): void {
  const position = geometry.getAttribute('position');
  for (let i = 0; i < position.count; i++) {
    if (position.getY(i) > 0) {
      position.setX(i, position.getX(i) * topX);
      position.setZ(i, position.getZ(i) * topZ);
    }
  }
  position.needsUpdate = true;
  geometry.computeVertexNormals();
}
