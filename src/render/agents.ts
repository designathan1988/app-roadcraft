import {
  BoxGeometry,
  Color,
  CylinderGeometry,
  DynamicDrawUsage,
  InstancedMesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  SphereGeometry,
  type BufferGeometry,
  type Material,
} from 'three';

import { clamp } from '@core/scalar';
import { pedPose, vehiclePose } from '@sim/pose';
import {
  ARCHETYPES,
  archetypeById,
  type Archetype,
  type VehicleShape,
} from '@sim/vehicles/archetypes';
import type { SimWorld } from '@sim/world';
import type { SegmentId } from '@world/ids';
import { m } from '@world/units';
import { DT } from '@sim/params';
import { createRiggedCitizens } from './riggedCitizens';
import { FOOTWAY_RISE } from './roadSurfaces';

/**
 * Vehicles, riders and dogs use the original instanced batches. Citizens use
 * rigged Rocketbox meshes with baked animation palettes in separate batches.
 *
 * At the far band only vehicles are drawn. The middle band includes citizens;
 * the near band adds dogs. Citizen stride follows distance travelled rather
 * than a shared clock, so each gait has its own phase.
 *
 * Buffers are allocated once. Only their written prefixes are uploaded, and
 * capacity overflow drops detail instead of allocating during a frame.
 */

/** Fleet and crowd the buffers are sized for. Both sit under the sim ceilings. */
const MAX_VEHICLES = 1_200;
const MAX_PEDS = 1_000;
/** Dogs are flavour, not a second crowd. A hundred bounds the extra work. */
const MAX_DOGS = 120;
/** Seated figures inside vehicles, and figures straddling two-wheelers. */
const MAX_OCCUPANTS = MAX_VEHICLES * 2;
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
  /** Lit indicator side: +1 left, -1 right, 0 none. */
  indicate: number;
}

export interface AgentRenderOptions {
  readonly pedestrianDetail?: 0 | 1 | 2;
  readonly pedestrianVisible?: (x: number, y: number, height: number) => boolean;
}

export interface AgentMeshes {
  readonly meshes: readonly Object3D[];
  /**
   * @param zoom Viewport zoom, used only to pick the closest detail band. It
   *   defaults to fully zoomed in, so a caller that does not pass it gets the
   *   richest look rather than a silently stripped one.
   */
  sync(world: SimWorld, alpha: number, detailed: boolean, zoom?: number, options?: AgentRenderOptions): void;
  dispose(): void;
}

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
const DOG_COATS: readonly number[] = [0x6b4a2c, 0x2a2724, 0xd8c9a8, 0x94734a, 0xe8e4dc];
const HELMET_COLOURS: readonly number[] = [0x1c1e22, 0xd8dbe0, 0xc0392b, 0x2c5f9e, 0xe0a33a];

/** Tints for parts that are never painted the vehicle's own colour. */
const RUBBER = 0x15181b;
const HUB = 0x9aa0a6;
const TRIM = 0x1b2328;
const CHROME = 0xb9bec4;
/** A number plate is retro-reflective, so unlit white is the honest material. */
const PLATE = 0xf0efe6;
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
/** How far into a lane change the indicator stays lit, in world units. */
const INDICATOR_LATERAL = 0.15;
const SIGN = 0xffe7a8;
const BOX_BODY = 0xe6e8ea;

/** Seated-figure proportions, in metres — a head is 0.23 m whatever it rides in. */
const SEAT_TORSO_DEEP = m(0.32);
const SEAT_TORSO_TALL = m(0.5);
const SEAT_TORSO_WIDE = m(0.44);
const SEAT_HEAD = m(0.23);
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
  readonly driverSkin: number;
  readonly driverShirt: number;
  readonly passengerSkin: number;
  readonly passengerShirt: number;
  readonly helmet: number;
  /** Second body colour, for a truck's box and a bus's roof. */
  readonly accent: number;
}

/** Everything about how one vehicle's occupants and windows look, from its id. */
export function vehicleLook(id: number, seats: number): VehicleLook {
  const h = agentHash(id ^ 0x2545f491);
  const g = agentHash(id ^ 0x27220a95);
  const room = Math.max(1, Math.floor(seats));
  return {
    occupants: 1 + pick(h, 6, room),
    windowsDown: pick(h, 2, 4),
    driverSkin: from(SKIN_TONES, h, 14),
    driverShirt: from(SHIRT_COLOURS, h, 20),
    passengerSkin: from(SKIN_TONES, g, 6),
    passengerShirt: from(SHIRT_COLOURS, g, 12),
    helmet: from(HELMET_COLOURS, g, 18),
    accent: pick(g, 24, 3) === 0 ? BOX_BODY : from(SHIRT_COLOURS, g, 26),
  };
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
  const axleAlong: readonly number[] =
    a.axles >= 3
      ? [a.length * 0.37, -a.length * 0.21, -a.length * 0.34]
      : twoWheeler
        ? [a.length * 0.37, -a.length * 0.37]
        : [a.length * 0.31, -a.length * 0.31];

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
  mesh.castShadow = castShadow;
  mesh.receiveShadow = false;
  // Instances move every frame, so a bounding sphere computed once is wrong;
  // the meshes are few enough that skipping the frustum test is the cheap answer.
  mesh.frustumCulled = false;
  mesh.count = 0;
  return { mesh, n: 0 };
}

export function createAgentMeshes(elevationAt: ElevationAt): AgentMeshes {
  const paint = new MeshStandardMaterial({ roughness: 0.32, metalness: 0.16, envMapIntensity: 1.1 });
  const trim = new MeshStandardMaterial({ roughness: 0.45, metalness: 0.35 });
  const glassMaterial = new MeshStandardMaterial({
    color: 0x9cc6d6,
    roughness: 0.08,
    metalness: 0.1,
    transparent: true,
    // Clear enough to see who is driving.
    //
    // The camera looks down at 48 degrees, so the roof covers most of the
    // cabin and the occupants are read through the SIDE glass and the
    // windscreen. At 0.58 that glass was carrying more reflection than
    // transmission and the figures inside were a suggestion rather than
    // people. This is the one material in the scene whose job is to let
    // something behind it be seen.
    opacity: 0.4,
    envMapIntensity: 1.35,
  });
  const rubber = new MeshStandardMaterial({ roughness: 0.92, metalness: 0.05 });
  // Unlit, so a lamp stays bright inside a shadow — the only thing in the scene
  // for which that is correct. One material serves headlights, tail lights,
  // destination blinds and number plates; the instance colour separates them.
  const lampMaterial = new MeshBasicMaterial({ toneMapped: false });
  const cloth = new MeshStandardMaterial({ roughness: 0.85, metalness: 0 });

  const unitBox = new BoxGeometry(1, 1, 1);
  // A slightly chamfered body reads as a car rather than as a brick: the top is
  // narrower than the bottom, which is what gives the highlight its shape.
  const bodyGeometry = new BoxGeometry(1, 1, 1);
  taper(bodyGeometry, 0.88, 0.94);
  const cabinGeometry = new BoxGeometry(1, 1, 1);
  taper(cabinGeometry, 0.8, 0.86);
  // A torso is the opposite chamfer: shoulders wider than the waist.
  const torsoGeometry = new BoxGeometry(1, 1, 1);
  taper(torsoGeometry, 0.92, 1.2);
  const wheelGeometry = new CylinderGeometry(0.5, 0.5, 1, 10).rotateX(Math.PI / 2);
  const hubGeometry = new CylinderGeometry(0.5, 0.5, 1, 8).rotateX(Math.PI / 2);
  const headGeometry = new SphereGeometry(0.5, 7, 5);

  const bodies = instanced('vehicle-bodies', bodyGeometry, paint, MAX_VEHICLES + 300);
  const cabins = instanced('vehicle-cabins', cabinGeometry, paint, MAX_VEHICLES);
  const wheels = instanced('vehicle-wheels', wheelGeometry, rubber, MAX_VEHICLES * 6);
  const hubs = instanced('vehicle-hubs', hubGeometry, trim, MAX_VEHICLES * 4, false);
  const glass = instanced('vehicle-glass', unitBox, glassMaterial, MAX_VEHICLES * 4, false);
  const trims = instanced('vehicle-trims', unitBox, trim, MAX_VEHICLES * 6, false);
  const lamps = instanced('vehicle-lamps', unitBox, lampMaterial, MAX_VEHICLES * 5, false);
  const torsos = instanced('figure-torsos', torsoGeometry, cloth, MAX_PEDS + MAX_OCCUPANTS + MAX_DOGS);
  const heads = instanced(
    'figure-heads',
    headGeometry,
    cloth,
    MAX_PEDS + MAX_OCCUPANTS + MAX_DOGS,
    false,
  );
  const hips = instanced('figure-hips', unitBox, cloth, MAX_PEDS + MAX_RIDERS, false);
  const limbs = instanced(
    'figure-limbs',
    unitBox,
    cloth,
    MAX_PEDS * 6 + MAX_RIDERS * 4 + MAX_DOGS * 5,
    false,
  );

  const parts: readonly Part[] = [
    bodies,
    cabins,
    wheels,
    hubs,
    glass,
    trims,
    lamps,
    torsos,
    heads,
    hips,
    limbs,
  ];
  const pedestrians = createRiggedCitizens(['female_08', 'male_03', 'male_12']);
  const meshes = [...parts.map((part) => part.mesh), pedestrians.group];

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
  let fx = 0;
  let fy = 0;
  let fdx = 1;
  let fdy = 0;
  let fyaw = 0;
  let fdeck = 0;

  const frameAt = (x: number, y: number, angle: number, deck: number): void => {
    fx = x;
    fy = y;
    fyaw = angle;
    fdx = Math.cos(angle);
    fdy = Math.sin(angle);
    fdeck = deck;
  };

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
  ): void => {
    if (part.n >= part.mesh.instanceMatrix.count) return;
    object.position.set(fx + fdx * along - fdy * side, fdeck + up, -(fy + fdy * along + fdx * side));
    object.rotation.set(0, fyaw, rake);
    object.scale.set(sx, sy, sz);
    object.updateMatrix();
    part.mesh.setMatrixAt(part.n, object.matrix);
    if (tint >= 0) {
      colour.setHex(tint);
      part.mesh.setColorAt(part.n, colour);
    }
    part.n++;
  };

  /** Road wheels, plus their hubs at the closest band. */
  const placeWheels = (plan: BodyPlan, band: number): void => {
    const d = plan.wheelRadius * 2;
    for (const along of plan.axleAlong) {
      if (plan.axleSide === 0) {
        place(wheels, along, 0, plan.wheelRadius, d, d, plan.tread, RUBBER);
        if (band >= 2) {
          place(hubs, along, 0, plan.wheelRadius, d * 0.45, d * 0.45, plan.tread * 1.1, HUB);
        }
        continue;
      }
      for (const side of SIDES) {
        place(wheels, along, side * plan.axleSide, plan.wheelRadius, d, d, plan.tread, RUBBER);
        if (band >= 2) {
          place(
            hubs,
            along,
            side * (plan.axleSide + plan.tread * 0.3),
            plan.wheelRadius,
            d * 0.52,
            d * 0.52,
            plan.tread * 0.5,
            HUB,
          );
        }
      }
    }
  };

  /** Seated figures, spread back along the seat rows the class declares. */
  const placeOccupants = (plan: BodyPlan, look: VehicleLook): void => {
    for (let i = 0; i < look.occupants; i++) {
      const along = plan.seatAlong + plan.seatPitch * Math.floor(i / 2);
      // The driver sits on the left, which is where right-hand traffic puts
      // them; the second figure in each row takes the other side.
      const side = (i % 2 === 0 ? 1 : -1) * plan.seatSide;
      const driver = i === 0;
      place(
        torsos,
        along,
        side,
        plan.seatY,
        SEAT_TORSO_DEEP,
        SEAT_TORSO_TALL,
        SEAT_TORSO_WIDE,
        driver ? look.driverShirt : look.passengerShirt,
      );
      place(
        heads,
        along,
        side,
        plan.headY,
        SEAT_HEAD,
        SEAT_HEAD,
        SEAT_HEAD,
        driver ? look.driverSkin : look.passengerSkin,
      );
    }
  };

  /**
   * The figure astride a two-wheeler.
   *
   * Anatomy is in metres rather than fractions of the machine, because the
   * difference that matters — a cyclist's feet reach almost to the road while a
   * motorcyclist's rest on pegs a third of a metre up — only means anything in
   * real units.
   */
  const placeRider = (plan: BodyPlan, look: VehicleLook, cyclist: boolean): void => {
    const hipY = cyclist ? m(0.92) : m(0.75);
    const footY = cyclist ? m(0.16) : m(0.34);
    const lean = cyclist ? -0.42 : -0.26;
    const seat = -plan.length * 0.06;
    const shoulderY = hipY + m(0.46);
    const shirt = look.driverShirt;
    const trousers = look.passengerShirt;

    place(hips, seat, 0, hipY - m(0.06), m(0.3), m(0.2), m(0.34), trousers);
    place(torsos, seat + m(0.1), 0, hipY + m(0.28), m(0.28), m(0.52), m(0.42), shirt, lean);
    place(
      heads,
      seat + m(0.26),
      0,
      hipY + m(0.62),
      m(0.26),
      m(0.26),
      m(0.26),
      // A motorcyclist wears a helmet; a cyclist, in this city, does not.
      cyclist ? look.driverSkin : look.helmet,
    );

    // One box from hip to foot, angled forward so a knee reads without a joint.
    // The cyclist's is longer and nearer vertical.
    const legAngle = cyclist ? 0.22 : 0.62;
    const legLen = (hipY - footY) / Math.cos(legAngle);
    const armAngle = cyclist ? 0.85 : 0.72;
    const armLen = m(0.46);
    for (const side of SIDES) {
      place(
        limbs,
        seat + Math.sin(legAngle) * legLen * 0.5,
        side * m(0.18),
        hipY - Math.cos(legAngle) * legLen * 0.5,
        m(0.15),
        legLen,
        m(0.15),
        trousers,
        legAngle,
      );
      place(
        limbs,
        seat + m(0.14) + Math.sin(armAngle) * armLen * 0.5,
        side * m(0.2),
        shoulderY - Math.cos(armAngle) * armLen * 0.5,
        m(0.12),
        armLen,
        m(0.12),
        shirt,
        armAngle,
      );
    }
  };

  /**
   * Hatchback, sedan, SUV and van.
   *
   * The lower body is narrower than the track so the tyres show, and from band
   * 1 the greenhouse is a roof slab carried on four panes of glass rather than
   * a solid box, because nobody can sit inside a solid box.
   */
  const drawCar = (plan: BodyPlan, paintHex: number, look: VehicleLook, band: number): void => {
    const L = plan.length;
    const W = plan.width;
    const H = plan.height;
    place(bodies, 0, 0, H * 0.34, L, H * 0.46, W * 0.95, paintHex);
    if (band < 1) {
      place(cabins, plan.cabinAlong, 0, H * 0.71, plan.cabinLength, H * 0.4, W * 0.9, paintHex);
      return;
    }

    const nose = plan.cabinAlong + plan.cabinLength * 0.5;
    const tail = plan.cabinAlong - plan.cabinLength * 0.5;
    place(cabins, plan.cabinAlong, 0, H * 0.9, plan.cabinLength * 0.96, H * 0.13, W * 0.85, paintHex);
    place(glass, nose - L * 0.03, 0, H * 0.72, L * 0.05, H * 0.3, W * 0.8, -1, 0.5);
    place(glass, tail + L * 0.03, 0, H * 0.72, L * 0.045, H * 0.28, W * 0.78, -1, -0.46);
    for (let i = 0; i < 2; i++) {
      // A window that is down is simply not written. No second material, no
      // second geometry, and an open window is a dark opening anyway.
      if ((look.windowsDown & (1 << i)) !== 0) continue;
      place(
        glass,
        plan.cabinAlong,
        (i === 0 ? 1 : -1) * W * 0.44,
        H * 0.72,
        plan.cabinLength * 0.8,
        H * 0.27,
        W * 0.02,
        -1,
      );
    }
    for (const side of SIDES) {
      place(trims, side * L * 0.49, 0, H * 0.22, L * 0.035, H * 0.17, W * 0.99, TRIM);
      place(lamps, L * 0.495, side * W * 0.31, H * 0.36, L * 0.02, H * 0.1, W * 0.2, HEADLAMP);
      place(lamps, -L * 0.495, side * W * 0.33, H * 0.38, L * 0.018, H * 0.09, W * 0.17, lamp.tail);
      if (lamp.indicate === side) {
        place(lamps, -L * 0.49, side * W * 0.42, H * 0.38, L * 0.016, H * 0.08, W * 0.08, INDICATOR);
        place(lamps, L * 0.49, side * W * 0.4, H * 0.36, L * 0.016, H * 0.08, W * 0.08, INDICATOR);
      }
    }
    placeWheels(plan, band);
    if (band < 2) return;

    place(lamps, -L * 0.507, 0, H * 0.2, L * 0.012, H * 0.07, W * 0.3, PLATE);
    for (const side of SIDES) {
      // A B-pillar, so the roof still has something holding it up on the side
      // whose window is down.
      place(trims, plan.cabinAlong, side * W * 0.44, H * 0.72, L * 0.02, H * 0.27, W * 0.03, TRIM);
      place(trims, nose - L * 0.06, side * W * 0.57, H * 0.64, L * 0.035, H * 0.06, W * 0.1, TRIM);
    }
    placeOccupants(plan, look);
  };

  const drawBus = (plan: BodyPlan, paintHex: number, look: VehicleLook, band: number): void => {
    const L = plan.length;
    const W = plan.width;
    const H = plan.height;
    if (band < 1) {
      place(bodies, 0, 0, H * 0.5, L, H * 0.82, W, paintHex);
      place(cabins, 0, 0, H * 0.95, L * 0.99, H * 0.1, W * 0.96, look.accent);
      return;
    }

    place(bodies, 0, 0, H * 0.31, L, H * 0.44, W, paintHex);
    place(cabins, 0, 0, H * 0.92, L * 0.98, H * 0.16, W * 0.97, look.accent);
    // Glazing runs nearly the full length down both flanks, which is the single
    // feature that separates a bus from a very large van at any distance.
    for (const side of SIDES) {
      place(glass, 0, side * W * 0.49, H * 0.69, L * 0.94, H * 0.3, W * 0.02, -1);
    }
    place(glass, L * 0.49, 0, H * 0.69, L * 0.03, H * 0.32, W * 0.92, -1, 0.12);
    place(glass, -L * 0.49, 0, H * 0.69, L * 0.03, H * 0.26, W * 0.9, -1, -0.1);
    place(trims, 0, 0, H * 0.11, L * 0.99, H * 0.16, W * 1.01, TRIM);
    for (const side of SIDES) {
      place(lamps, L * 0.5, side * W * 0.36, H * 0.16, L * 0.012, H * 0.08, W * 0.16, HEADLAMP);
      place(lamps, -L * 0.5, side * W * 0.38, H * 0.2, L * 0.012, H * 0.08, W * 0.14, lamp.tail);
      if (lamp.indicate === side) {
        place(lamps, -L * 0.5, side * W * 0.46, H * 0.2, L * 0.012, H * 0.07, W * 0.07, INDICATOR);
      }
    }
    placeWheels(plan, band);
    if (band < 2) return;

    place(lamps, L * 0.5, 0, H * 0.86, L * 0.012, H * 0.1, W * 0.52, SIGN);
    // Doors are on the kerb side, which in right-hand traffic is the vehicle's
    // right — negative on an axis that runs to its left.
    place(trims, L * 0.31, -W * 0.5, H * 0.44, L * 0.07, H * 0.62, W * 0.03, TRIM);
    place(trims, -L * 0.06, -W * 0.5, H * 0.44, L * 0.07, H * 0.62, W * 0.03, TRIM);
    placeOccupants(plan, look);
  };

  const drawTruck = (plan: BodyPlan, paintHex: number, look: VehicleLook, band: number): void => {
    const L = plan.length;
    const W = plan.width;
    const H = plan.height;
    const cab = plan.cabinAlong;
    const cabLen = plan.cabinLength;
    // Cab and box are separate bodies with daylight between them, which is what
    // stops a truck reading as one long bus.
    const boxLen = L * 0.52;
    const boxAt = -L * 0.21;
    place(bodies, boxAt, 0, H * 0.62, boxLen, H * 0.62, W * 0.98, look.accent);
    if (band < 1) {
      place(bodies, cab, 0, H * 0.42, cabLen, H * 0.62, W, paintHex);
      place(cabins, cab, 0, H * 0.83, cabLen * 0.92, H * 0.28, W * 0.94, paintHex);
      return;
    }

    place(bodies, cab, 0, H * 0.3, cabLen, H * 0.38, W, paintHex);
    place(cabins, cab, 0, H * 0.83, cabLen * 0.92, H * 0.28, W * 0.94, paintHex);
    place(glass, cab + cabLen * 0.46, 0, H * 0.6, L * 0.02, H * 0.24, W * 0.86, -1, 0.16);
    for (let i = 0; i < 2; i++) {
      if ((look.windowsDown & (1 << i)) !== 0) continue;
      place(
        glass,
        cab,
        (i === 0 ? 1 : -1) * W * 0.47,
        H * 0.6,
        cabLen * 0.6,
        H * 0.22,
        W * 0.02,
        -1,
      );
    }
    place(trims, L * 0.1, 0, H * 0.2, L * 0.22, H * 0.06, W * 0.45, TRIM);
    for (const side of SIDES) {
      place(lamps, L * 0.49, side * W * 0.34, H * 0.26, L * 0.014, H * 0.09, W * 0.18, HEADLAMP);
      place(lamps, -L * 0.49, side * W * 0.36, H * 0.34, L * 0.014, H * 0.08, W * 0.16, lamp.tail);
      if (lamp.indicate === side) {
        place(lamps, -L * 0.49, side * W * 0.44, H * 0.34, L * 0.014, H * 0.07, W * 0.07, INDICATOR);
      }
    }
    placeWheels(plan, band);
    if (band < 2) return;

    for (const side of SIDES) {
      place(trims, cab + cabLen * 0.42, side * W * 0.58, H * 0.62, L * 0.02, H * 0.12, W * 0.08, TRIM);
    }
    place(lamps, -L * 0.505, 0, H * 0.32, L * 0.01, H * 0.05, W * 0.24, PLATE);
    placeOccupants(plan, look);
  };

  const drawMotorcycle = (
    plan: BodyPlan,
    paintHex: number,
    look: VehicleLook,
    band: number,
  ): void => {
    const L = plan.length;
    const W = plan.width;
    const H = plan.height;
    place(bodies, -L * 0.02, 0, H * 0.5, L * 0.6, H * 0.3, W * 0.46, paintHex);
    place(cabins, L * 0.3, 0, H * 0.7, L * 0.1, H * 0.3, W * 0.42, paintHex, 0.32);
    if (band < 1) return;

    placeWheels(plan, band);
    place(trims, L * 0.33, 0, H * 0.47, L * 0.05, H * 0.55, W * 0.16, CHROME, 0.22);
    place(lamps, L * 0.4, 0, H * 0.66, L * 0.03, H * 0.14, W * 0.3, HEADLAMP);
    place(lamps, -L * 0.4, 0, H * 0.55, L * 0.025, H * 0.1, W * 0.22, lamp.tail);
    placeRider(plan, look, false);
    if (band < 2) return;

    place(trims, L * 0.3, 0, H * 0.87, L * 0.04, H * 0.05, W * 1.05, CHROME);
    place(trims, -L * 0.22, -W * 0.28, H * 0.24, L * 0.42, H * 0.07, W * 0.12, CHROME);
  };

  const drawBicycle = (
    plan: BodyPlan,
    paintHex: number,
    look: VehicleLook,
    band: number,
  ): void => {
    const L = plan.length;
    const W = plan.width;
    const H = plan.height;
    place(cabins, -L * 0.02, 0, H * 0.52, L * 0.55, H * 0.07, W * 0.14, paintHex);
    place(bodies, -L * 0.12, 0, H * 0.62, L * 0.06, H * 0.55, W * 0.12, paintHex, 0.22);
    if (band < 1) return;

    placeWheels(plan, band);
    place(trims, L * 0.3, 0, H * 0.6, L * 0.04, H * 0.6, W * 0.12, CHROME, 0.16);
    place(trims, -L * 0.16, 0, H * 0.8, L * 0.18, H * 0.05, W * 0.22, TRIM);
    placeRider(plan, look, true);
    if (band < 2) return;

    place(trims, L * 0.3, 0, H * 0.9, L * 0.03, H * 0.04, W, TRIM);
  };

  /** The dog trotting behind a pedestrian, drawn in the walker's own frame. */
  const placeDog = (phase: number, drive: number, coat: number): void => {
    const back = -m(0.85);
    const aside = -m(0.6);
    place(torsos, back, aside, m(0.36), m(0.66), m(0.26), m(0.22), coat);
    place(heads, back + m(0.42), aside, m(0.48), m(0.19), m(0.19), m(0.19), coat);
    place(limbs, back - m(0.38), aside, m(0.46), m(0.05), m(0.3), m(0.05), coat, 0.9);
    // A dog's cadence is faster than its owner's: the same phase, scaled.
    const trot = Math.sin(phase * 1.7) * 0.5 * drive;
    const legLen = m(0.26);
    for (let i = 0; i < 4; i++) {
      const fore = i < 2;
      const angle = i % 2 === 0 ? trot : -trot;
      place(
        limbs,
        back + (fore ? m(0.26) : -m(0.24)) + Math.sin(angle) * legLen * 0.5,
        aside + (fore ? m(0.07) : -m(0.07)),
        m(0.3) - Math.cos(angle) * legLen * 0.5,
        m(0.05),
        legLen,
        m(0.05),
        coat,
        angle,
      );
    }
  };


  /** Refreshed for every vehicle, read by whichever body builder runs. */
  const lamp: LampState = { tail: TAILLAMP, indicate: 0 };

  return {
    meshes,
    sync(world, alpha, detailed, zoom = Number.POSITIVE_INFINITY, options = {}) {
      pedestrians.begin(options.pedestrianDetail ?? 2);
      for (const part of parts) part.n = 0;
      const band = !detailed ? 0 : zoom >= NEAR_DETAIL_ZOOM ? 2 : 1;

      let drawn = 0;
      for (const vehicle of world.vehiclesInIdOrder()) {
        if (drawn >= MAX_VEHICLES) break;
        const pose = vehiclePose(world, vehicle, alpha);
        if (!pose) continue;
        const lane = world.lanelet(vehicle.lanelet);
        frameAt(
          pose.p.x,
          pose.p.y,
          pose.angle,
          elevationAt(world, pose.p.x, pose.p.y, lane?.segment),
        );
        const plan = planOf(vehicle.archetype);
        const paintHex = hexOf(vehicle.color);
        const look = vehicleLook(vehicle.id, plan.seats);

        // Brakes and indicators, straight off the simulation. `prev` is the
        // previous step's kinematics, so the difference is this step's
        // acceleration without storing anything new on the vehicle.
        const decel = (vehicle.prev.v - vehicle.v) / DT;
        lamp.tail = decel >= BRAKE_DECEL ? BRAKELAMP : TAILLAMP;
        // `lateral` is the unfinished part of a lane change, signed towards
        // the lane being left - so the vehicle is heading the other way.
        lamp.indicate =
          Math.abs(vehicle.lateral) > INDICATOR_LATERAL ? -Math.sign(vehicle.lateral) : 0;
        switch (plan.shape) {
          case 'bus':
            drawBus(plan, paintHex, look, band);
            break;
          case 'truck':
            drawTruck(plan, paintHex, look, band);
            break;
          case 'motorcycle':
            drawMotorcycle(plan, paintHex, look, band);
            break;
          case 'bicycle':
            drawBicycle(plan, paintHex, look, band);
            break;
          case 'car':
            drawCar(plan, paintHex, look, band);
            break;
        }
        drawn++;
      }

      // Pedestrians start at band 1: zoomed out past it a whole person is
      // smaller than a car's wing mirror, and drawing the crowd there costs
      // more than the entire fleet does.
      if (band >= 1) {
        let pedCount = 0;
        let dogsLeft = MAX_DOGS;
        for (const ped of world.pedsInIdOrder()) {
          if (pedCount >= MAX_PEDS) break;
          const pose = pedPose(world, ped, alpha);
          if (!pose) continue;
          const edge = world.sidewalks.edges.get(ped.edge);
          const deck = elevationAt(world, pose.p.x, pose.p.y, edge?.segment) +
            (edge?.kind === 'crossing' ? 0 : FOOTWAY_RISE);
          if (options.pedestrianVisible && !options.pedestrianVisible(pose.p.x, pose.p.y, deck)) continue;
          frameAt(pose.p.x, pose.p.y, pose.angle, deck);
          const look = pedLook(ped.id);
          pedestrians.draw(ped, pose.p.x, pose.p.y, pose.angle, deck, alpha);
          const phase = ped.age * ped.v * 1.5;
          if (band >= 2 && look.dog && dogsLeft > 0) {
            placeDog(phase, clamp(ped.v / Math.max(ped.speed, 1e-3), 0, 1),
              from(DOG_COATS, agentHash(ped.id ^ 0x7f4a7c15), 3));
            dogsLeft--;
          }
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
      for (const part of parts) {
        part.mesh.count = part.n;
        const matrix = part.mesh.instanceMatrix;
        matrix.clearUpdateRanges();
        if (part.n > 0) matrix.addUpdateRange(0, part.n * 16);
        matrix.needsUpdate = true;

        const colour = part.mesh.instanceColor;
        if (colour) {
          colour.clearUpdateRanges();
          if (part.n > 0) colour.addUpdateRange(0, part.n * 3);
          colour.needsUpdate = true;
        }
      }
    },
    dispose() {
      pedestrians.dispose();
      for (const geometry of [
        unitBox,
        bodyGeometry,
        cabinGeometry,
        torsoGeometry,
        wheelGeometry,
        hubGeometry,
        headGeometry,
      ]) {
        geometry.dispose();
      }
      for (const material of [paint, trim, glassMaterial, rubber, lampMaterial, cloth]) {
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
