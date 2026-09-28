import type { RiderClipKey } from './riderPoses';
import type { DoorModel, SeatModel, SeatPose } from './vehicleModels';
import { m } from '@world/units';

/**
 * What the people in a vehicle are doing, as clips to play and places to put
 * them - pure, so the tests can measure exactly what the renderer draws
 * (`agents.ts` is the only caller in the game).
 *
 *  - `occupantPlays`: a seated person's pose, with now and then a glance - in
 *    the mirror, out of the window, down at a phone - blended in and out.
 *  - `kerbFigure`: somebody getting out at the kerb or in: turned on the seat
 *    towards the open door, onto the sill with the feet down on the road,
 *    up out of the car in the opening, and away round the BACK of the open
 *    door. They used to slide straight from the seat to a point off the
 *    middle of the door, rising as they went, which walked them through the
 *    door leaf and put their head through the roof rail.
 */

/** Anything the rigged citizens can play (`riggedCitizens.CitizenClipKey`, without the import cycle). */
export type OccupantClip = RiderClipKey | 'walk' | 'walkSlow' | 'standUp' | 'idle';

export interface Play {
  key: OccupantClip;
  phase: number;
  weight: number;
  /** For a walk, ground covered in world units: the stride then plants the feet. */
  distance?: number;
}

/** The still poses a seat is sat in: the base, and the two glances blended into it. */
const SEAT_CLIPS: Readonly<Record<SeatPose, { readonly drive: readonly [RiderClipKey, RiderClipKey, RiderClipKey]; readonly ride: readonly [RiderClipKey, RiderClipKey, RiderClipKey] }>> = {
  car: { drive: ['carDrive', 'carDriveMirror', 'carDriveRight'], ride: ['carRide', 'carRideLeft', 'carRideRight'] },
  cab: { drive: ['cabDrive', 'cabDriveMirror', 'cabDriveRight'], ride: ['cabRide', 'cabRideLeft', 'cabRideRight'] },
  chair: { drive: ['chairSit', 'chairSitLeft', 'chairSitRight'], ride: ['chairSit', 'chairSitPhone', 'chairSitRight'] },
};
const REAR_CAR_CLIPS = ['carRearRide', 'carRearLeft', 'carRearRight'] as const;

const clipsFor = (seat: Pick<SeatModel, 'pose' | 'driver' | 'row'>): readonly [RiderClipKey, RiderClipKey, RiderClipKey] =>
  seat.pose === 'car' && !seat.driver && seat.row > 0
    ? REAR_CAR_CLIPS : SEAT_CLIPS[seat.pose][seat.driver ? 'drive' : 'ride'];

/** The pose somebody sits still in, in this seat. */
export function seatBaseClip(seat: Pick<SeatModel, 'pose' | 'driver' | 'row'>): RiderClipKey {
  return clipsFor(seat)[0];
}

/** A cheap integer hash, for the rhythm of one person's glances. */
function mix(n: number): number {
  let h = (n | 0) + 0x7f4a7c15;
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  return (h ^ (h >>> 15)) >>> 0;
}

const smooth = (x: number): number => {
  const t = Math.min(1, Math.max(0, x));
  return t * t * (3 - 2 * t);
};

/**
 * A seated person's pose at `time` (seconds of their own), written into
 * `out`: the seat's still pose, and every few seconds a glance - one of the
 * seat's two variations - eased in, held and eased out. The rhythm and the
 * choice come from `seed`, so two people side by side do not move together,
 * and a passenger on the right looks out of the right-hand window.
 */
export function occupantPlays(seat: Pick<SeatModel, 'pose' | 'driver' | 'row' | 'z'>, seed: number, time: number, out: Play[]): Play[] {
  const clips = clipsFor(seat);
  const h = mix(seed);
  const period = 6 + (h % 7);
  const t = time / period + ((h >>> 8) & 0xff) / 256;
  const cycle = Math.floor(t);
  const u = t - cycle;
  const c = mix(h ^ cycle);
  out.length = 0;
  // One cycle in four passes without a glance.
  let glance = (c & 3) === 0 ? 0 : smooth((u - 0.5) / 0.12) * (1 - smooth((u - 0.86) / 0.12));
  const variant = 1 + ((c >>> 4) & 1);
  // A bus passenger looks out of their own side's window, never across the
  // aisle; otherwise down at their phone.
  const key: RiderClipKey = seat.pose === 'chair' && !seat.driver && variant === 2
    ? (seat.z > 0 ? 'chairSitRight' : 'chairSitLeft')
    : clips[variant]!;
  if (glance < 0.001) glance = 0;
  out.push({ key: clips[0], phase: 0, weight: 1 - glance });
  if (glance > 0) out.push({ key, phase: 0, weight: glance });
  return out;
}

// ---------------------------------------------------------------- the kerb

/** How far a door swings open, radians. The renderer swings the leaves by it. */
export const DOOR_SWING = 1.15;

/**
 * How far the feet are ahead of the pelvis at the start of the captured
 * stand-up (`standUp`), metres, over the roster: the rise is anchored with
 * the seated pelvis on the sill, so the person ends standing this far out.
 */
export const STAND_UP_REACH = 0.36;

/** Clearance kept from the edge of an open door leaf by a body walking past it, metres. */
export const LEAF_CLEARANCE = 0.42;

/** Everything the choreography needs from the body model, in its frame (X forward, Z right). */
export interface KerbPlaces {
  /** The seat's hip point and floor, world units. */
  readonly seat: Pick<SeatModel, 'x' | 'z' | 'hipY' | 'floor' | 'pose' | 'driver' | 'row'>;
  readonly door: Pick<DoorModel, 'side' | 'hingeX' | 'hingeZ' | 'length'>;
  /** Where the person stands on the footway, in the vehicle's frame. */
  readonly foot: { readonly x: number; readonly z: number };
}

/** One frame of somebody moving between a seat and the footway. */
export interface KerbFigure {
  /** Anchor point in the vehicle frame, world units: see `anchor`. */
  x: number;
  y: number;
  z: number;
  /**
   * `pelvis`: the pelvis bone is on the point. `feet`: the model's origin
   * (between the feet) is. `feetUnderPelvis`: the feet on the height, the
   * first frame's pelvis over the point in plan - for rising from a seat.
   */
  anchor: 'pelvis' | 'feet' | 'feetUnderPelvis';
  /** Heading in the vehicle frame, radians: 0 forward, positive to the left. */
  heading: number;
  /** Whether the seat's size limit applies (inside the car), or the person's own size. */
  seated: boolean;
  readonly plays: Play[];
}

export function createKerbFigure(): KerbFigure {
  return { x: 0, y: 0, z: 0, anchor: 'pelvis', heading: 0, seated: true, plays: [] };
}

/** The open leaf's free end, vehicle frame, for a door swung by `open` (0 to 1). */
export function leafTip(door: KerbPlaces['door'], open: number): { x: number; z: number } {
  const angle = open * DOOR_SWING;
  return { x: door.hingeX - door.length * Math.cos(angle), z: door.hingeZ + door.side * door.length * Math.sin(angle) };
}

/** Where the person stands up, and the way they walk from there to the footway. */
export function kerbRoute(p: KerbPlaces): { sill: { x: number; z: number }; stand: { x: number; z: number }; via: { x: number; z: number } | null } {
  const side = p.door.side;
  const flank = Math.abs(p.door.hingeZ);
  const sill = { x: p.seat.x, z: side * flank };
  const stand = { x: p.seat.x, z: side * (flank + m(STAND_UP_REACH)) };
  // Round the back of the open leaf, when the straight way would brush it.
  const tip = leafTip(p.door, 1);
  const clear = m(LEAF_CLEARANCE);
  const near = distanceToSegment(tip, { x: p.door.hingeX, z: p.door.hingeZ }, stand, p.foot);
  const via = near < clear || segmentsCross(stand, p.foot, { x: p.door.hingeX, z: p.door.hingeZ }, tip)
    ? { x: Math.min(stand.x, tip.x - clear), z: tip.z + side * m(0.15) }
    : null;
  return { sill, stand, via };
}

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/**
 * Somebody getting out (`drop`) or in (`pick`), at a moment of the transfer:
 * `seated` 1 in the seat to 0 standing up outside the door, then `walked` 0
 * there to 1 on the footway (`kerbStops.kerbTransfer`). Written into `f`.
 */
export function kerbFigure(p: KerbPlaces, kind: 'drop' | 'pick', seated: number, walked: number, f: KerbFigure): KerbFigure {
  const side = p.door.side;
  const route = kerbRoute(p);
  const out = -side * Math.PI / 2;
  const high = p.seat.floor > m(0.6);
  f.plays.length = 0;
  if (walked > 0 || seated <= 0) {
    // On foot, between the door and the footway. A cab's floor is a metre up:
    // the first stretch is the climb down its steps.
    const pts = route.via ? [route.stand, route.via, p.foot] : [route.stand, p.foot];
    const lengths = pts.slice(1).map((q, i) => Math.hypot(q.x - pts[i]!.x, q.z - pts[i]!.z));
    const total = lengths.reduce((a, b) => a + b, 0);
    // `walked` is where they are: 0 at the door, 1 on the footway, both ways.
    const along = walked * total;
    let rest = along;
    let i = 0;
    while (i < lengths.length - 1 && rest > lengths[i]!) rest -= lengths[i++]!;
    const a = pts[i]!;
    const b = pts[i + 1]!;
    const t = lengths[i]! > 0 ? Math.min(1, rest / lengths[i]!) : 1;
    f.x = lerp(a.x, b.x, t);
    f.z = lerp(a.z, b.z, t);
    const dropDown = high ? Math.max(0, 1 - along / m(0.9)) : 0;
    f.y = p.seat.floor * dropDown;
    f.anchor = 'feet';
    // Facing the way they walk: out and on for a drop, towards the car for a pick.
    const dx = (b.x - a.x) * (kind === 'drop' ? 1 : -1);
    const dz = (b.z - a.z) * (kind === 'drop' ? 1 : -1);
    f.heading = Math.atan2(-dz, dx);
    f.seated = false;
    // The stride follows the ground actually covered, which for a pick-up
    // runs from the footway end.
    f.plays.push({ key: 'walk', phase: 0, weight: 1, distance: kind === 'drop' ? along : total - along });
    return f;
  }
  // In the car: `u` runs 0 in the seat to 1 stood up outside, for both ways.
  const u = 1 - seated;
  const base = seatBaseClip({ pose: p.seat.pose === 'chair' ? 'car' : p.seat.pose, driver: false, row: p.seat.row });
  const turnEnd = 0.3;
  const slideEnd = 0.55;
  const inboard = { x: p.seat.x, z: p.seat.z + side * m(0.1) };
  if (u < turnEnd) {
    // Turning on the seat towards the door, the legs swinging round into the opening.
    const t = smooth(u / turnEnd);
    f.x = lerp(p.seat.x, inboard.x, t);
    f.z = lerp(p.seat.z, inboard.z, t);
    f.y = p.seat.hipY;
    f.anchor = 'pelvis';
    f.heading = out * t;
    f.seated = true;
    f.plays.push({ key: base, phase: 0, weight: 1 });
    return f;
  }
  if (u < slideEnd) {
    // Across onto the sill, the feet coming down onto the road.
    const t = smooth((u - turnEnd) / (slideEnd - turnEnd));
    f.x = lerp(inboard.x, route.sill.x, t);
    f.z = lerp(inboard.z, route.sill.z, t);
    f.y = p.seat.hipY;
    f.anchor = 'pelvis';
    f.heading = out;
    f.seated = true;
    f.plays.push({ key: base, phase: 0, weight: 1 - t }, { key: 'chairSit', phase: 0, weight: t });
    return f;
  }
  // Up out of the seat, in the opening, facing out: the captured stand-up,
  // its seated start on the sill and the feet on the road (or the cab floor).
  const t = (u - slideEnd) / (1 - slideEnd);
  f.x = route.sill.x;
  f.z = route.sill.z;
  f.y = high ? p.seat.floor : 0;
  f.anchor = 'feetUnderPelvis';
  f.heading = out;
  f.seated = false;
  f.plays.push({ key: 'standUp', phase: t, weight: 1 });
  return f;
}

function distanceToSegment(q: { x: number; z: number }, a: { x: number; z: number }, a2: { x: number; z: number }, b: { x: number; z: number }): number {
  // Distance from the leaf (a -> q) to the walk (a2 -> b): least of the ends to the other segment.
  return Math.min(pointSegment(q, a2, b), pointSegment(a, a2, b), pointSegment(a2, a, q), pointSegment(b, a, q));
}

function pointSegment(p: { x: number; z: number }, a: { x: number; z: number }, b: { x: number; z: number }): number {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / Math.max(1e-9, dx * dx + dz * dz)));
  return Math.hypot(p.x - a.x - dx * t, p.z - a.z - dz * t);
}

function segmentsCross(a: { x: number; z: number }, b: { x: number; z: number }, c: { x: number; z: number }, d: { x: number; z: number }): boolean {
  const o = (p: { x: number; z: number }, q: { x: number; z: number }, r: { x: number; z: number }): number =>
    (q.x - p.x) * (r.z - p.z) - (q.z - p.z) * (r.x - p.x);
  return o(a, b, c) * o(a, b, d) < 0 && o(c, d, a) * o(c, d, b) < 0;
}
