import {
  BoxGeometry,
  BufferGeometry,
  Color,
  CylinderGeometry,
  ExtrudeGeometry,
  Float32BufferAttribute,
  LatheGeometry,
  Quaternion,
  Shape,
  ShapeUtils,
  TorusGeometry,
  Vector2,
  Vector3,
} from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

import type { Archetype, BodyStyle } from '@sim/vehicles/archetypes';
import { m } from '@world/units';
import { DRIVER_WHEEL } from './riderPoses';

/**
 * Vehicle bodies, built once per class from the class's own proportions.
 *
 * A body is drawn the way a car is designed, from a SIDE PROFILE, and then
 * split the way a car is built:
 *
 *  - the LOWER BODY is one outline - bumper, bonnet, waist, boot, sills, wheel
 *    arches - described as a bottom line and a top line, both monotone along
 *    the car. Any stretch of it is then a simple polygon (`outline`), so the
 *    nose, the tail, a door and the sill below it are cut from the same line
 *    and meet exactly; a door whose trailing edge runs over the rear wheel
 *    takes the arch out of its own bottom edge instead of crossing it.
 *  - with every door shut the lower body is ONE extrusion with its cabin top
 *    taken out (`hollow`): a continuous, bevelled side with no gaps, shut
 *    lines drawn on it. While a door moves the body is drawn in pieces
 *    instead - nose, tail, sill and the separate door leaves on their hinges.
 *  - above the waist the GREENHOUSE is a lofted surface - windscreen, roof,
 *    rear window - between two side planes that lean in towards the roof
 *    (tumblehome), with the pillars and the side glass cut from those planes.
 *    From the camera's 48 degrees the leaning glass faces up at the viewer,
 *    and the people inside are what is seen through it.
 *  - inside there is a finished cabin: carpet, a dashboard across the car with
 *    its binnacle and centre console, bucket seats and a rear bench with
 *    headrests, door cards with armrests, a parcel shelf or a boot floor.
 *
 * Buses and trucks are built with the same helpers (`buildBusModel`,
 * `buildTruckModel`): a low-floor bus with rows of seats, stanchions, a
 * driver's cab and sliding plug doors; a cab-over truck with a cab you can
 * see into, a chassis and a box body.
 *
 * Geometry is in world units, in the vehicle's frame: X forward, Y up, Z to the
 * vehicle's RIGHT, origin on the road under the middle of the body. Every
 * part carries a vertex colour that MULTIPLIES the instance colour (white keeps
 * the paint; dark gives black trim, rubber or a black-out pillar), so a body
 * is one draw per material whatever it depicts.
 */

/** Side of the vehicle a door is on: -1 left (the driver's), +1 right (the kerb's). */
export type DoorSide = -1 | 1;

export interface DoorModel {
  /** Index into the vehicle's door state. Two leaves of one bus door share it. */
  readonly index: number;
  readonly side: DoorSide;
  /**
   * `hinge`: swings about a vertical axis at the front edge (cars, cabs).
   * `slide`: a plug door, stepping out and sliding along the body by `slide`
   * (signed, world units) - how a city bus opens.
   */
  readonly kind: 'hinge' | 'slide';
  readonly slide: number;
  /** Hinge line (or the closed leaf's origin): along the body and across it, world units. */
  readonly hingeX: number;
  readonly hingeZ: number;
  /** Door length from hinge to trailing edge, world units. */
  readonly length: number;
  /** Seat this door serves (index into `seats`), or -1. */
  readonly seat: number;
  /** Painted panel, in the door's own frame (origin on the hinge line, at road level). */
  readonly panel: BufferGeometry;
  /** The door's window, same frame. */
  readonly glass: BufferGeometry;
  /** The door card on its inside (cabin material), same frame; null on a bus leaf. */
  readonly card: BufferGeometry | null;
}

export interface SeatModel {
  /** Hip point: along, across (Z, right positive), height above the road; world units. */
  readonly x: number;
  readonly z: number;
  readonly hipY: number;
  /** Headroom above the hip point to the inside of the roof, world units. */
  readonly headroom: number;
  /** Room ahead of the hip point for the legs: to the front bulkhead, or under the seat in front. */
  readonly legroom: number;
  /** Height of the cabin floor under this seat. */
  readonly floor: number;
  /** Room either side of the seat's centre line: to the door or glass, or to the next seat. */
  readonly sideRoom: number;
  readonly driver: boolean;
  /** Row from the front, 0 for the driver's row: at a middle zoom only the front row is drawn. */
  readonly row: number;
  /**
   * The posture the seat is made for: `car`, reclined with the legs forward
   * (`riderPoses.ts`), or `chair`, upright with the knees bent (a bus seat,
   * the captured sitting clip).
   */
  readonly pose: 'car' | 'chair';
}

/**
 * How far a seated person reaches from their pelvis, metres at full size: the
 * worst of the adult bodies in the roster, measured on the rig
 * (`docs/audit/seated-pose-extents.json`, `scripts/measure-seated-poses.mjs`)
 * over every car-seat pose and every idle variation of it.
 */
export const SEATED_EXTENTS = { top: 0.94, bottom: 0.28, forward: 0.88, back: 0.33, half: 0.26 } as const;

/** The same for the upright chair pose a bus passenger sits in (`sitIdle`). */
export const CHAIR_EXTENTS = { top: 0.95, bottom: 0.55, forward: 0.62, back: 0.3, half: 0.26 } as const;

export const extentsOf = (seat: Pick<SeatModel, 'pose'>): typeof SEATED_EXTENTS | typeof CHAIR_EXTENTS =>
  seat.pose === 'chair' ? CHAIR_EXTENTS : SEATED_EXTENTS;

/**
 * The largest size a person may be drawn at in this seat and stay entirely
 * inside the cabin: head under the roof lining, feet above the floor, knees
 * and toes short of the bulkhead, shoulders clear of the door and the next
 * seat. Anybody larger is drawn at this size; nobody is drawn larger than 1.1.
 */
export function seatFitScale(seat: SeatModel): number {
  const metres = (u: number): number => u / M(1);
  const e = extentsOf(seat);
  return Math.min(1.1,
    (metres(seat.headroom) - 0.02) / e.top,
    (metres(seat.hipY - seat.floor)) / e.bottom,
    metres(seat.legroom) / e.forward,
    metres(seat.sideRoom) / e.half);
}

/** Where a steering wheel sits and how it is inclined, in the vehicle frame. */
export interface SteeringModel {
  readonly geometry: BufferGeometry;
  /** Seat (index into `seats`) whose occupant holds it. */
  readonly seat: number;
  /** Tilt of the rim's plane from vertical, top towards the driver, radians. */
  readonly tilt: number;
}

export interface VehicleModel {
  /** Painted body with every door shut, doors and handles included. */
  readonly shell: BufferGeometry;
  /** Glazing with every door shut. */
  readonly glass: BufferGeometry;
  /** Painted body in pieces, for while a door moves: the door leaves are drawn separately. */
  readonly openShell: BufferGeometry;
  /** Fixed glazing only, same moment. */
  readonly openGlass: BufferGeometry;
  /** Unpainted exterior: bumpers, grille, wheel-arch liners, sills, mirrors' glass. */
  readonly trim: BufferGeometry;
  /** Cabin, doors shut: seats, dashboard, carpet, door cards. */
  readonly interior: BufferGeometry;
  /** Cabin without the door cards, which then travel with their leaves. */
  readonly openInterior: BufferGeometry;
  /** The panel of the roof that may be glass (a panoramic roof), or null. */
  readonly roof: BufferGeometry | null;
  /** A second body colour: a truck's box. */
  readonly accent: BufferGeometry | null;
  /** One opaque, low-poly geometry for the far zoom: body, dark glass and wheels. */
  readonly far: BufferGeometry;
  readonly steering: SteeringModel | null;
  readonly doors: readonly DoorModel[];
  readonly seats: readonly SeatModel[];
  /** Lamps, as boxes in the vehicle frame: centre and size, world units. */
  readonly headlamps: readonly Lamp[];
  readonly taillamps: readonly Lamp[];
  readonly indicators: readonly (Lamp & { readonly side: DoorSide; readonly front: boolean })[];
  /** Number plates, and on a bus the destination blind. */
  readonly plates: readonly Lamp[];
}

export interface Lamp {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly sx: number;
  readonly sy: number;
  readonly sz: number;
}

const M = (metres: number): number => m(metres);

/**
 * Axle positions along the body, front first, world units. One definition for
 * the body model's wheel arches and the renderer's wheels.
 */
export function axleStations(a: Archetype): number[] {
  const L = a.length;
  if (a.shape === 'motorcycle' || a.shape === 'bicycle') return [L * 0.37, -L * 0.37];
  // A city bus: a long front overhang for the entrance, a tandem at the back.
  if (a.shape === 'bus') return [L * 0.28, -L * 0.17, -L * 0.28];
  if (a.axles >= 3) return [L * 0.37, -L * 0.21, -L * 0.34];
  return [L * 0.31, -L * 0.31];
}

// ------------------------------------------------------------------ palette

/** Vertex colours: they multiply the instance colour, so these are shades. */
const WHITE = 0xffffff;
/** Black-out on paint: B-pillars, window surrounds, a bus's pillars. */
const BLACKOUT = 0x1a1b1e;
/** Shut lines and seams on paint. */
const SEAM = 0x3a3a3a;
const DARK_TRIM = 0x202226;
const CHROME_TRIM = 0xb9bec4;
const GRILLE = 0x0e0f11;
const RUBBER_TRIM = 0x121315;
const LINER = 0x0c0c0d;
/** Cabin colours, sRGB. */
const CARPET = 0x26282c;
const DASH = 0x1e2023;
const SEAT_FABRIC = 0x4a4f57;
const SEAT_SIDE = 0x34373d;
const CARD = 0x3b3e44;
const HEADREST = 0x42464d;
const WHEEL_RIM = 0x141517;
const BUS_FLOOR = 0x5b6168;
const BUS_SEAT = 0x2e4c86;
const BUS_SHELL = 0x7d848c;
const POLE_YELLOW = 0xe3b529;
const PANEL_GREY = 0x8b9198;

// ------------------------------------------------------------------ geometry helpers

type P2 = readonly [number, number];

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** Sets a constant vertex colour on a geometry, in place, and returns it. */
function tint<T extends BufferGeometry>(g: T, hex: number): T {
  const c = new Color().setHex(hex);
  const n = g.getAttribute('position').count;
  const data = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    data[i * 3] = c.r;
    data[i * 3 + 1] = c.g;
    data[i * 3 + 2] = c.b;
  }
  g.setAttribute('color', new Float32BufferAttribute(data, 3));
  return g;
}

/**
 * Merges parts into one non-indexed geometry with position, normal and
 * colour. A part without a colour is white - it takes the instance colour
 * as it is.
 */
export function merge(parts: BufferGeometry[]): BufferGeometry {
  const ready = parts.map((g) => {
    const n = g.index ? g.toNonIndexed() : g;
    if (!n.getAttribute('normal')) n.computeVertexNormals();
    if (!n.getAttribute('color')) tint(n, WHITE);
    for (const name of Object.keys(n.attributes)) {
      if (name !== 'position' && name !== 'normal' && name !== 'color') n.deleteAttribute(name);
    }
    n.clearGroups();
    return n;
  });
  const merged = mergeGeometries(ready, false);
  for (const g of parts) g.dispose();
  for (const g of ready) g.dispose();
  if (!merged) throw new Error('vehicle model: parts could not be merged');
  return merged;
}

/** Points of a polyline monotone in x, clipped to [xa, xb]. */
function clipX(line: readonly P2[], xa: number, xb: number): P2[] {
  const out: P2[] = [];
  const push = (p: P2): void => {
    const last = out[out.length - 1];
    if (!last || Math.abs(last[0] - p[0]) > 1e-7 || Math.abs(last[1] - p[1]) > 1e-7) out.push(p);
  };
  for (let i = 0; i < line.length - 1; i++) {
    const a = line[i]!;
    const b = line[i + 1]!;
    const dx = b[0] - a[0];
    if (Math.abs(dx) < 1e-9) {
      if (a[0] >= xa - 1e-9 && a[0] <= xb + 1e-9) { push(a); push(b); }
      continue;
    }
    const ta = (xa - a[0]) / dx;
    const tb = (xb - a[0]) / dx;
    const t0 = Math.max(0, Math.min(ta, tb));
    const t1 = Math.min(1, Math.max(ta, tb));
    if (t0 > t1) continue;
    push([lerp(a[0], b[0], t0), lerp(a[1], b[1], t0)]);
    push([lerp(a[0], b[0], t1), lerp(a[1], b[1], t1)]);
  }
  return out;
}

/** Height of a monotone polyline at x (the first match), or NaN outside it. */
function heightAt(line: readonly P2[], x: number): number {
  for (let i = 0; i < line.length - 1; i++) {
    const a = line[i]!;
    const b = line[i + 1]!;
    const lo = Math.min(a[0], b[0]);
    const hi = Math.max(a[0], b[0]);
    if (x < lo - 1e-9 || x > hi + 1e-9) continue;
    if (Math.abs(b[0] - a[0]) < 1e-9) return Math.max(a[1], b[1]);
    return lerp(a[1], b[1], (x - a[0]) / (b[0] - a[0]));
  }
  return Number.NaN;
}

/** Drops consecutive duplicates and a closing point equal to the first. */
function clean(points: readonly P2[]): P2[] {
  const out: P2[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (!last || Math.hypot(last[0] - p[0], last[1] - p[1]) > 1e-6) out.push(p);
  }
  while (out.length > 2 && Math.hypot(out[0]![0] - out[out.length - 1]![0], out[0]![1] - out[out.length - 1]![1]) < 1e-6) out.pop();
  return out;
}

/** Extrudes a side profile across the body, centred on Z (or on `z`). */
function extrude(points: readonly P2[], width: number, bevel: number, z = 0, curveSegments = 6, bevelSegments = 3): ExtrudeGeometry {
  const shape = new Shape(clean(points).map(([x, y]) => new Vector2(x, y)));
  const depth = Math.max(1e-3, width - bevel * 2);
  const g = new ExtrudeGeometry(shape, {
    depth,
    bevelEnabled: bevel > 0,
    bevelThickness: bevel,
    bevelSize: bevel * 0.8,
    // Rounded INTO the outline rather than grown out of it, so a profile's
    // wheel arch and ground clearance are the sizes they were drawn at.
    bevelOffset: -bevel * 0.8,
    bevelSegments: bevel > 0 ? bevelSegments : 0,
    curveSegments,
  });
  g.translate(0, 0, -depth / 2 + z);
  return g;
}

/**
 * Takes the top out of an extruded lower body over [xa, xb]: the faces
 * swept across the width whose middle is above `above` and whose ends are
 * inside the straight part of the extrusion. What is left is a tub - the
 * sides, the bevelled rails along the top of each, the underbody - that
 * the cabin sits in.
 */
function hollow(g: ExtrudeGeometry, xa: number, xb: number, above: number): BufferGeometry {
  const position = g.getAttribute('position');
  const normal = g.getAttribute('normal');
  const depth = (g.parameters.options.depth ?? 1) / 2 + 1e-4;
  const keepP: number[] = [];
  const keepN: number[] = [];
  let cz = 0;
  // The extrusion was translated to be centred on z = 0.
  for (let i = 0; i < position.count; i++) cz += position.getZ(i);
  cz /= Math.max(1, position.count);
  for (let t = 0; t < position.count; t += 3) {
    let inside = true;
    let x = 0;
    let y = 0;
    for (let k = 0; k < 3; k++) {
      const z = position.getZ(t + k) - cz;
      if (Math.abs(z) > depth) inside = false;
      x += position.getX(t + k) / 3;
      y += position.getY(t + k) / 3;
    }
    const drop = inside && x > xa - 1e-4 && x < xb + 1e-4 && y > above;
    if (drop) continue;
    for (let k = 0; k < 3; k++) {
      keepP.push(position.getX(t + k), position.getY(t + k), position.getZ(t + k));
      keepN.push(normal.getX(t + k), normal.getY(t + k), normal.getZ(t + k));
    }
  }
  const out = new BufferGeometry();
  out.setAttribute('position', new Float32BufferAttribute(keepP, 3));
  out.setAttribute('normal', new Float32BufferAttribute(keepN, 3));
  g.dispose();
  return out;
}

function box(sx: number, sy: number, sz: number, x: number, y: number, z: number): BufferGeometry {
  return new BoxGeometry(sx, sy, sz).translate(x, y, z);
}

/** A bar between two points in 3D, `thick` square in section. */
function bar(a: Vector3, b: Vector3, thick: number, thickB = thick): BufferGeometry {
  const length = a.distanceTo(b);
  const g = new BoxGeometry(thick, length, thickB);
  const dir = b.clone().sub(a).normalize();
  // Rotation taking the box's long axis (+Y) onto the bar.
  g.applyQuaternion(new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), dir));
  g.translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
  return g;
}

/** A rectangle rounded in plan (X-Z), `height` tall, bottom at `y`. */
function roundedSlab(lx: number, lz: number, radius: number, height: number, x: number, y: number, z: number, segments = 3): BufferGeometry {
  const r = Math.min(radius, lx / 2 - 1e-4, lz / 2 - 1e-4);
  const s = new Shape();
  const hx = lx / 2;
  const hz = lz / 2;
  s.moveTo(-hx + r, -hz);
  s.lineTo(hx - r, -hz);
  s.quadraticCurveTo(hx, -hz, hx, -hz + r);
  s.lineTo(hx, hz - r);
  s.quadraticCurveTo(hx, hz, hx - r, hz);
  s.lineTo(-hx + r, hz);
  s.quadraticCurveTo(-hx, hz, -hx, hz - r);
  s.lineTo(-hx, -hz + r);
  s.quadraticCurveTo(-hx, -hz, -hx + r, -hz);
  const g = new ExtrudeGeometry(s, { depth: height, bevelEnabled: false, curveSegments: segments });
  // Shape in X-Y extruded along Z: turn it so the extrusion runs up.
  g.rotateX(-Math.PI / 2);
  g.translate(x, y, z);
  return g;
}

/**
 * A flat polygon mapped into 3D, triangulated in its own 2D coordinates, and
 * wound so its face points along `outward`.
 */
function polygon(points2: readonly P2[], to3: (p: P2) => Vector3, outward: Vector3): BufferGeometry {
  const pts = clean(points2);
  if (pts.length < 3) return new BufferGeometry().setAttribute('position', new Float32BufferAttribute([], 3));
  const contour = pts.map(([x, y]) => new Vector2(x, y));
  const faces = ShapeUtils.triangulateShape(contour, []);
  const v = pts.map(to3);
  const out: number[] = [];
  const e1 = new Vector3();
  const e2 = new Vector3();
  for (const [a, b, c] of faces) {
    const pa = v[a!]!;
    const pb = v[b!]!;
    const pc = v[c!]!;
    e1.subVectors(pb, pa);
    e2.subVectors(pc, pa);
    const n = e1.clone().cross(e2);
    const order = n.dot(outward) >= 0 ? [pa, pb, pc] : [pa, pc, pb];
    for (const p of order) out.push(p.x, p.y, p.z);
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(out, 3));
  g.computeVertexNormals();
  return g;
}

/** A polygon given twice, facing both ways, a sliver apart: a pane seen from inside and out. */
function twoSided(points2: readonly P2[], to3: (p: P2) => Vector3, outward: Vector3, gap: number): BufferGeometry {
  const off = outward.clone().normalize().multiplyScalar(gap / 2);
  const front = polygon(points2, (p) => to3(p).add(off), outward);
  const back = polygon(points2, (p) => to3(p).sub(off), outward.clone().negate());
  return merge([front, back]);
}

/**
 * A surface lofted along a profile: at each station (x, y) it spans the width
 * from -half(y) to +half(y) with a crown, and it is wound to face up and out.
 */
function loft(stations: readonly P2[], half: (y: number) => number, crown: number, across = 6,
  zRange: readonly [number, number] = [-1, 1]): BufferGeometry {
  const pos: number[] = [];
  const index: number[] = [];
  const cols = across + 1;
  for (const [x, y] of stations) {
    const h = half(y);
    for (let j = 0; j <= across; j++) {
      const u = lerp(zRange[0], zRange[1], j / across);
      pos.push(x, y + crown * (1 - u * u), u * h);
    }
  }
  for (let i = 0; i < stations.length - 1; i++) {
    const [x0, y0] = stations[i]!;
    const [x1, y1] = stations[i + 1]!;
    // Outward in the X-Y plane for a segment running from i to i + 1.
    const out = new Vector3(y1 - y0, -(x1 - x0), 0);
    if (out.y < 0 || (Math.abs(out.y) < 1e-9 && out.x < 0)) out.negate();
    for (let j = 0; j < across; j++) {
      const a = i * cols + j;
      const b = a + 1;
      const c = a + cols;
      const d = c + 1;
      const pa = new Vector3(pos[a * 3]!, pos[a * 3 + 1]!, pos[a * 3 + 2]!);
      const pb = new Vector3(pos[b * 3]!, pos[b * 3 + 1]!, pos[b * 3 + 2]!);
      const pc = new Vector3(pos[c * 3]!, pos[c * 3 + 1]!, pos[c * 3 + 2]!);
      const n = pb.clone().sub(pa).cross(pc.clone().sub(pa));
      if (n.dot(out) >= 0) index.push(a, b, c, b, d, c);
      else index.push(a, c, b, b, c, d);
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(pos, 3));
  g.setIndex(index);
  g.computeVertexNormals();
  return g;
}

/**
 * A seat's side profile, extruded across its width: cushion, backrest and
 * a rounded front edge, reclined by `recline` (radians back from upright).
 * `hip` is the occupant's hip point; the cushion sits under it and the
 * backrest behind it, where the pose puts the buttocks and the back.
 */
function seatShell(hipX: number, hipY: number, floor: number, width: number, z: number, recline: number,
  backHeight: number, fabric: number): BufferGeometry[] {
  const top = hipY - M(0.1);
  const base = Math.max(floor + M(0.1), top - M(0.13));
  const backX = hipX - M(0.14);
  const sin = Math.sin(recline);
  const cos = Math.cos(recline);
  const thick = M(0.13);
  const s: P2[] = [
    [hipX + M(0.36), top - M(0.03)],
    [hipX + M(0.4), top - M(0.08)],
    [hipX + M(0.36), base],
    [backX - thick * cos, base],
    [backX - thick * cos - backHeight * sin, top + backHeight * cos - M(0.02)],
    [backX - backHeight * sin + M(0.01), top + backHeight * cos],
    [backX, top + M(0.05)],
    [backX + M(0.06), top],
  ];
  // The points run round the outline clockwise from the front; `extrude`
  // takes either winding.
  const shell = tint(extrude(s, width, M(0.035), z, 4, 2), fabric);
  const out: BufferGeometry[] = [shell];
  // Bolsters on the backrest's edges, a shade darker.
  for (const side of [-1, 1] as const) {
    const g = bar(
      new Vector3(backX - M(0.02), top + M(0.08), z + side * (width / 2 - M(0.04))),
      new Vector3(backX - M(0.02) - backHeight * 0.8 * sin, top + backHeight * 0.8 * cos, z + side * (width / 2 - M(0.04))),
      M(0.09), M(0.07));
    out.push(tint(g, SEAT_SIDE));
  }
  // The runner under it.
  out.push(tint(box(M(0.3), Math.max(M(0.02), base - floor), width * 0.6, hipX + M(0.08), (base + floor) / 2, z), DASH));
  return out;
}

function headrest(x: number, y: number, z: number, width = M(0.26)): BufferGeometry[] {
  return [
    tint(roundedSlab(M(0.1), width, M(0.04), M(0.18), x, y, z), HEADREST),
    tint(box(M(0.015), M(0.08), M(0.015), x, y - M(0.04), z - width * 0.25), DASH),
    tint(box(M(0.015), M(0.08), M(0.015), x, y - M(0.04), z + width * 0.25), DASH),
  ];
}

/** A steering wheel: rim, three spokes and a boss, axis along X, centred on the origin. */
function steeringWheel(radius: number): BufferGeometry {
  const rim = new TorusGeometry(radius, M(0.022), 6, 20);
  rim.rotateY(Math.PI / 2);
  const parts: BufferGeometry[] = [rim];
  for (const angle of [Math.PI / 2 + 0.2, -Math.PI / 2 - 0.2, Math.PI]) {
    const spoke = new BoxGeometry(M(0.02), radius, M(0.035));
    spoke.translate(0, radius / 2, 0);
    spoke.rotateX(angle);
    parts.push(spoke);
  }
  parts.push(new CylinderGeometry(M(0.06), M(0.07), M(0.05), 10).rotateZ(Math.PI / 2));
  return tint(merge(parts), WHEEL_RIM);
}

// ------------------------------------------------------------------ cars

/**
 * Proportions of each body style, as fractions of the class's length (x, from
 * the middle, forward positive) and height (y, from the road).
 */
interface Profile {
  /** Ground clearance under the sills. */
  readonly clearance: number;
  /** Top of the bumper at the very front, and of the bonnet's leading edge. */
  readonly noseY: number;
  readonly bonnetY: number;
  /** Base and top of the windscreen. */
  readonly screenBase: readonly [number, number];
  readonly screenTop: readonly [number, number];
  /** Rear end of the roof, and the base of the rear window. */
  readonly roofEnd: readonly [number, number];
  readonly deck: readonly [number, number];
  /** Height of the tail at the very back (top of the boot lid or the hatch). */
  readonly tailY: number;
  /** Door edges along the body: front edge, then the trailing edge of each door. */
  readonly doorEdges: readonly number[];
  /** Blind panels instead of glass behind the last door (a van's load area). */
  readonly blindRear: boolean;
  /** How far each side leans in from the waist to the roof, as a fraction of the width. */
  readonly tumble: number;
  /** The cabin opening runs back to here (a fraction of the length). */
  readonly cabinRear: number;
}

const PROFILES: Record<BodyStyle, Profile> = {
  // The windscreen's top edge sits ahead of the front seats and the roof runs
  // back past the rear ones: a seated head is under the roof, never under the
  // glass that slopes down to the bonnet.
  sedan: {
    clearance: 0.1, noseY: 0.44, bonnetY: 0.54,
    screenBase: [0.2, 0.6], screenTop: [0.05, 0.97], roofEnd: [-0.29, 0.98], deck: [-0.38, 0.66],
    tailY: 0.65, doorEdges: [0.2, -0.05, -0.27], blindRear: false, tumble: 0.11, cabinRear: -0.31,
  },
  hatch: {
    clearance: 0.11, noseY: 0.45, bonnetY: 0.56,
    screenBase: [0.21, 0.6], screenTop: [0.06, 0.98], roofEnd: [-0.38, 0.98], deck: [-0.47, 0.62],
    tailY: 0.6, doorEdges: [0.21, -0.05, -0.27], blindRear: false, tumble: 0.1, cabinRear: -0.46,
  },
  suv: {
    clearance: 0.13, noseY: 0.5, bonnetY: 0.63,
    screenBase: [0.22, 0.66], screenTop: [0.08, 0.97], roofEnd: [-0.44, 0.98], deck: [-0.47, 0.66],
    tailY: 0.64, doorEdges: [0.22, 0.0, -0.22], blindRear: false, tumble: 0.08, cabinRear: -0.46,
  },
  van: {
    clearance: 0.1, noseY: 0.36, bonnetY: 0.45,
    screenBase: [0.4, 0.49], screenTop: [0.27, 0.95], roofEnd: [-0.49, 0.97], deck: [-0.5, 0.97],
    tailY: 0.97, doorEdges: [0.26, 0.06], blindRear: true, tumble: 0.05, cabinRear: 0.06,
  },
};

/** Wall thickness of a door leaf, metres. */
const SKIN = m(0.06);
/** Gap left at each end of a door leaf, so it clears its opening as it swings. */
const SHUT = m(0.004);

export function buildVehicleModel(a: Archetype): VehicleModel {
  const style = a.style ?? 'sedan';
  const p = PROFILES[style];
  const L = a.length;
  const W = a.width;
  const H = a.height;
  const X = (f: number): number => f * L;
  const Y = (f: number): number => f * H;
  const halfW = W / 2;
  const r = a.wheelRadius;
  const axles = axleStations(a);
  const front = L / 2;
  const back = -L / 2;
  const clear = Y(p.clearance);
  const archR = r + M(0.06);
  const archY = r * 0.98;
  const bevel = M(0.05);

  const edges = p.doorEdges.map(X);
  const doorFront = edges[0]!;
  const doorRear = edges[edges.length - 1]!;
  const sb = { x: X(p.screenBase[0]), y: Y(p.screenBase[1]) };
  const st = { x: X(p.screenTop[0]), y: Y(p.screenTop[1]) };
  const re = { x: X(p.roofEnd[0]), y: Y(p.roofEnd[1]) };
  const dk = { x: X(p.deck[0]), y: Y(p.deck[1]) };
  const sill = clear + M(0.17);
  // The floor pan sits just above the underbody, as low as a real one.
  const floor = clear + M(0.02);

  // ---- the waist: the bottom of the side glass, rising a little to the back.
  const beltEnd = p.blindRear ? doorRear : dk.x;
  const beltRear = p.blindRear ? sb.y + M(0.04) : dk.y;
  const beltAt = (x: number): number => lerp(sb.y, beltRear, Math.min(1, Math.max(0, (sb.x - x) / Math.max(1e-6, sb.x - beltEnd))));

  // ---- the lower body's two lines.
  const tailTop = Y(p.tailY);
  const top: P2[] = [
    [front, Y(p.noseY)],
    [front - M(0.03), lerp(Y(p.noseY), Y(p.bonnetY), 0.55)],
    [front - M(0.09), lerp(Y(p.noseY), Y(p.bonnetY), 0.85)],
    [front - M(0.2), Y(p.bonnetY)],
    [lerp(front - M(0.2), sb.x, 0.5), lerp(Y(p.bonnetY), sb.y, 0.42)],
    [sb.x, sb.y],
  ];
  if (p.blindRear) {
    top.push([doorRear, beltAt(doorRear)], [doorRear, re.y], [back + M(0.06), re.y], [back + M(0.01), re.y - M(0.05)], [back, re.y - M(0.12)]);
  } else {
    top.push([dk.x, dk.y]);
    for (const q of [[back + M(0.16), tailTop], [back + M(0.05), tailTop - M(0.03)], [back + M(0.01), tailTop - M(0.1)], [back, tailTop - M(0.18)]] as const) {
      if (q[0] < top[top.length - 1]![0] - M(0.01)) top.push(q);
    }
  }
  const archTop = (x: number): number => {
    let y = -Infinity;
    for (const ax of axles) {
      const dx = x - ax;
      if (Math.abs(dx) < archR) y = Math.max(y, archY + Math.sqrt(archR * archR - dx * dx));
    }
    return y;
  };
  const cornerR = M(0.13);
  const bottomAt = (x: number): number => {
    let y = clear;
    const fromFront = x - (front - cornerR);
    if (fromFront > 0) y = clear + cornerR - Math.sqrt(Math.max(0, cornerR * cornerR - fromFront * fromFront));
    const fromBack = (back + cornerR) - x;
    if (fromBack > 0) y = clear + cornerR - Math.sqrt(Math.max(0, cornerR * cornerR - fromBack * fromBack));
    return Math.max(y, archTop(x));
  };
  const xs = new Set<number>([back, front]);
  for (let i = 1; i <= 5; i++) {
    xs.add(back + (cornerR * i) / 5);
    xs.add(front - (cornerR * i) / 5);
  }
  for (const ax of axles) {
    for (let i = 0; i <= 16; i++) xs.add(ax - archR + (2 * archR * i) / 16);
    xs.add(ax - archR - 1e-3);
    xs.add(ax + archR + 1e-3);
  }
  const bottom: P2[] = [...xs].filter((x) => x >= back && x <= front).sort((u, v) => u - v).map((x) => [x, bottomAt(x)] as const);
  /** The lower body between xa and xb, as a simple polygon. */
  const outline = (xa: number, xb: number): P2[] => [...clipX(bottom, xa, xb), ...clipX(top, xa, xb)];

  // ---- greenhouse: the top line and the leaning side planes.
  const roofMid = Math.max(st.y, re.y) + M(0.015);
  const roofStations: P2[] = [];
  const roofBack = p.blindRear ? doorRear : re.x;
  const roofBackY = p.blindRear ? re.y : re.y;
  for (let i = 0; i <= 5; i++) {
    const t = i / 5;
    roofStations.push([lerp(st.x, roofBack, t), lerp(st.y, roofBackY, t) + (roofMid - Math.max(st.y, roofBackY)) * Math.sin(Math.PI * t)]);
  }
  const profile: P2[] = [[sb.x, sb.y], ...roofStations];
  if (!p.blindRear) profile.push([dk.x, dk.y]);
  const profileY = (x: number): number => heightAt(profile, x);
  const beltLow = Math.min(sb.y, beltRear);
  const tumble = p.tumble * W;
  const glassBase = halfW - M(0.045);
  const lean = tumble / Math.max(1e-6, roofMid - beltLow);
  const zSide = (y: number): number => glassBase - Math.max(0, y - beltLow) * lean;
  const crown = M(0.035);
  const sideTo3 = (side: DoorSide) => ([x, y]: P2): Vector3 => new Vector3(x, y, side * zSide(y));
  const sideOut = (side: DoorSide): Vector3 => new Vector3(0, lean, side).normalize();
  /** The side plane between the waist and the top line, from xa to xb (xa < xb). */
  const sideRegion = (xa: number, xb: number): P2[] => {
    const upper = clipX(profile, xa, xb);
    return [[xa, beltAt(xa)], [xb, beltAt(xb)], ...upper];
  };
  const pillarA = { base: sb.x - M(0.13), top: st.x - M(0.07) };
  /** x of the A-pillar's rear edge at height y. */
  const aPillarAt = (y: number): number => lerp(pillarA.base, pillarA.top, (y - sb.y) / Math.max(1e-6, st.y - sb.y));

  const shell: BufferGeometry[] = [];
  const openShell: BufferGeometry[] = [];
  const fixedGlass: BufferGeometry[] = [];
  const trim: BufferGeometry[] = [];
  const cabin: BufferGeometry[] = [];
  const closedCards: BufferGeometry[] = [];

  // ---- the lower body, whole and in pieces.
  const cabinRear = X(p.cabinRear);
  const cabinTop = floor + M(0.2);
  shell.push(hollow(extrude(outline(back, front), W, bevel, 0, 8), cabinRear, doorFront, cabinTop));
  openShell.push(extrude(outline(doorFront, front), W, bevel, 0, 8));
  openShell.push(hollow(extrude(outline(back, doorRear), W, bevel, 0, 8), cabinRear, doorRear + 1e-3, cabinTop));
  {
    // The sill under the doors, clear of both arches.
    const xa = Math.max(doorRear, axles[1]! + archR);
    const xb = Math.min(doorFront, axles[0]! - archR);
    const s: P2[] = [[xa, clear], [xb, clear], [xb, sill], [xa, sill]];
    for (const side of [-1, 1] as const) openShell.push(extrude(s, SKIN, M(0.01), side * (halfW - SKIN / 2), 2, 1));
    // A floor across under the cabin for the pieces, as the whole body has.
    openShell.push(tint(box(xb - xa, M(0.02), W - SKIN * 2, (xa + xb) / 2, clear + M(0.01), 0), LINER));
  }

  // ---- greenhouse surfaces.
  // The roof: a painted border, and the panel inside it, which may be glass
  // (`roof`). Lofted over the same stations so the two meet exactly.
  const glassRoofInset = M(0.1);
  const innerStations = roofStations.slice(1, roofStations.length - 1);
  const innerHalf = (y: number): number => zSide(y) - glassRoofInset;
  const roofPanel = loft(innerStations, innerHalf, crown, 6);
  const roofBorder: BufferGeometry[] = [
    loft(roofStations.slice(0, 2), zSide, crown, 8),
    loft(roofStations.slice(-2), zSide, crown, 8),
  ];
  for (const side of [-1, 1] as const) {
    // The strips either side of the panel: from the panel's edge to the side.
    const inner = innerStations.map(([x, y]) => [x, y] as P2);
    const u = (y: number): number => innerHalf(y) / zSide(y);
    const pos: number[] = [];
    const idx: number[] = [];
    for (const [x, y] of inner) {
      const h = zSide(y);
      const u0 = u(y);
      for (let j = 0; j <= 2; j++) {
        const t = lerp(u0, 1, j / 2);
        pos.push(x, y + crown * (1 - t * t), side * t * h);
      }
    }
    for (let i = 0; i < inner.length - 1; i++) {
      for (let j = 0; j < 2; j++) {
        const a = i * 3 + j;
        if (side === 1) idx.push(a, a + 3, a + 1, a + 1, a + 3, a + 4);
        else idx.push(a, a + 1, a + 3, a + 1, a + 4, a + 3);
      }
    }
    const strip = new BufferGeometry();
    strip.setAttribute('position', new Float32BufferAttribute(pos, 3));
    strip.setIndex(idx);
    strip.computeVertexNormals();
    // Wound to face up whichever way the stations run.
    if ((strip.getAttribute('normal').getY(0)) < 0) {
      const flipped = idx.slice();
      for (let k = 0; k < flipped.length; k += 3) [flipped[k + 1], flipped[k + 2]] = [flipped[k + 2]!, flipped[k + 1]!];
      strip.setIndex(flipped);
      strip.computeVertexNormals();
    }
    roofBorder.push(strip);
  }
  const border = merge(roofBorder);
  shell.push(border.clone());
  openShell.push(border);
  const screen = loft([[sb.x, sb.y], [st.x, st.y]], zSide, crown, 8);
  fixedGlass.push(screen);
  if (!p.blindRear) fixedGlass.push(loft([[re.x, re.y], [dk.x, dk.y]], zSide, crown, 8));

  // Pillars and side glass, per side.
  const doors: DoorModel[] = [];
  const seats: SeatModel[] = [];
  const bPillar = M(0.05);
  for (const side of [-1, 1] as const) {
    const to3 = sideTo3(side);
    const out = sideOut(side);
    // A-pillar: a band along the windscreen's side edge, down to the waist.
    const a: P2[] = [[pillarA.base, beltAt(pillarA.base)], [sb.x + M(0.02), sb.y], [st.x + M(0.01), st.y], [pillarA.top, profileY(pillarA.top)]];
    const aGeo = twoSided(a, to3, out, M(0.02));
    shell.push(aGeo.clone());
    openShell.push(aGeo);
    // B-pillars between doors, blacked out as most modern cars are.
    for (let i = 1; i < edges.length - 1; i++) {
      const x = edges[i]!;
      const g = tint(twoSided(sideRegion(x - bPillar, x + bPillar), to3, out, M(0.03)), BLACKOUT);
      shell.push(g.clone());
      openShell.push(g);
    }
    // Behind the last door: quarter glass and the C (or D) pillar.
    if (!p.blindRear) {
      const pillarFront = Math.max(dk.x + M(style === 'sedan' ? 0.24 : 0.18), re.x - M(0.05));
      if (doorRear - pillarFront > M(0.2)) {
        fixedGlass.push(twoSided(sideRegion(pillarFront, doorRear - SHUT), to3, out, M(0.01)));
        const pillar = twoSided(sideRegion(dk.x, pillarFront), to3, out, M(0.02));
        shell.push(pillar.clone());
        openShell.push(pillar);
      } else {
        const pillar = twoSided(sideRegion(dk.x, doorRear), to3, out, M(0.02));
        shell.push(pillar.clone());
        openShell.push(pillar);
      }
    }

    // ---- doors: one or two a side, hinged at the front edge.
    for (let i = 0; i < edges.length - 1; i++) {
      const x0 = edges[i]! - SHUT;
      const x1 = edges[i + 1]! + SHUT;
      const hingeX = x0;
      const hingeZ = side * (halfW - SKIN / 2);
      // Panel: the lower body's own outline between the door edges, from
      // the sill (or the arch, where the door runs over a wheel) to the waist.
      const lower = clipX(bottom, x1, x0).map(([x, y]) => [x, Math.max(sill, y)] as P2);
      const panelOutline: P2[] = [...lower, [x0, beltAt(x0) - M(0.005)], [x1, beltAt(x1) - M(0.005)]];
      const panel = extrude(panelOutline.map(([x, y]) => [x - hingeX, y] as P2), SKIN, M(0.012), 0, 4, 2);
      const panelParts: BufferGeometry[] = [panel];
      // Handle, and on a front door the mirror.
      const handleX = x1 + M(0.12) - hingeX;
      panelParts.push(tint(box(M(0.16), M(0.03), M(0.02), handleX + M(0.04), beltAt(x1) - M(0.1), side * (SKIN / 2 + M(0.008))), SEAM));
      if (i === 0) {
        const my = beltAt(x0) + M(0.05);
        panelParts.push(tint(box(M(0.1), M(0.05), M(0.1), -M(0.12), my - M(0.02), side * (SKIN / 2 + M(0.05))), DARK_TRIM));
        panelParts.push(roundedSlab(M(0.12), M(0.2), M(0.04), M(0.12), -M(0.14), my, side * (SKIN / 2 + M(0.14))));
        panelParts.push(tint(box(M(0.012), M(0.09), M(0.17), -M(0.2), my + M(0.06), side * (SKIN / 2 + M(0.14))), 0x6f7d86));
      }
      const leaf = merge(panelParts);
      // The window: from the waist to the top line, the leading edge of a
      // front door following the A-pillar, the trailing edge of a front
      // door stopping at the B-pillar.
      const gx1 = i + 1 < edges.length - 1 ? edges[i + 1]! + bPillar : x1;
      const gx0 = i === 0 ? Math.min(x0, pillarA.base) : edges[i]! - bPillar;
      let glassOutline = sideRegion(gx1, gx0);
      if (i === 0) glassOutline = glassOutline.map(([x, y]) => [Math.min(x, aPillarAt(y) - M(0.005)), y] as P2);
      const glass = twoSided(glassOutline, sideTo3(side), sideOut(side), M(0.008));
      glass.translate(-hingeX, 0, -hingeZ);
      // The door card: trim on the inside from the floor to the waist, with
      // an armrest and a pull.
      const cardZ = side * (halfW - SKIN - M(0.015)) - hingeZ;
      const cardTop = beltAt(x1) - M(0.01);
      const card = merge([
        tint(box(x0 - x1 - M(0.03), cardTop - floor - M(0.04), M(0.03), (x1 + x0) / 2 - hingeX, (cardTop + floor + M(0.04)) / 2, cardZ), CARD),
        tint(box(Math.min(M(0.4), (x0 - x1) * 0.5), M(0.05), M(0.07), (x1 + x0) / 2 - hingeX, floor + M(0.42), cardZ - side * M(0.04)), DASH),
        tint(box(x0 - x1 - M(0.06), M(0.04), M(0.04), (x1 + x0) / 2 - hingeX, cardTop - M(0.01), cardZ - side * M(0.005)), DASH),
      ]);
      const seatIndex = seats.length;
      doors.push({ index: doors.length, side, kind: 'hinge', slide: 0, hingeX, hingeZ, length: x0 - x1, seat: seatIndex,
        panel: leaf, glass, card });

      // The seat this door gives on to. The hip point sits a little ahead of
      // the door's trailing edge, which puts the reclined head under the roof
      // and leaves the legs room under the dashboard or the seat in front.
      const seatX = x1 + Math.max(M(0.22), (x0 - x1) * 0.2);
      const seatZ = side * (zSide(beltLow) - M(0.36));
      const hipY = floor + M(0.3);
      const ahead = i === 0 ? Math.max(doorFront, axles[0]! - M(0.1)) - seatX : x0 + M(0.3) - seatX;
      // The head sits back from the hip (a reclined seat), where the roof
      // may already be sloping down to the rear window; the lining is the
      // roof surface less its thickness, sampled over the head.
      let lining = Infinity;
      for (let dx = -M(0.3); dx <= M(0.08); dx += M(0.02)) {
        const y = profileY(seatX + dx);
        if (Number.isFinite(y)) lining = Math.min(lining, y - M(0.03));
      }
      const sideRoom = Math.min(zSide(hipY + M(0.6)) - Math.abs(seatZ), Math.abs(seatZ));
      seats.push({
        x: seatX, z: seatZ, hipY,
        headroom: lining - hipY,
        legroom: ahead,
        floor: floor + M(0.02),
        sideRoom,
        driver: side === -1 && i === 0,
        row: i,
        pose: 'car',
      });
    }
  }

  // ---- the cabin.
  const inner = W - SKIN * 2 - M(0.04);
  const perSide = edges.length - 1;
  const seatOf = (side: DoorSide, row: number): SeatModel => seats[(side === -1 ? 0 : perSide) + row]!;
  const rearRow = perSide - 1;
  const lastSeatX = seatOf(-1, rearRow).x;
  const bulkX = Math.max(doorFront, axles[0]! - M(0.1));
  // Carpet from the bulkhead back to behind the last seat.
  cabin.push(tint(box(bulkX - (lastSeatX - M(0.55)), M(0.03), inner, (bulkX + lastSeatX - M(0.55)) / 2, floor, 0), CARPET));
  // Dashboard: a side profile across the cabin, from under the windscreen
  // down to the footwell, with its face towards the front seats.
  {
    const dashRear = sb.x - M(0.52);
    const dashTop = sb.y - M(0.01);
    const s: P2[] = [
      [sb.x + M(0.02), dashTop - M(0.02)],
      [bulkX + M(0.05), floor + M(0.12)],
      [bulkX - M(0.08), floor + M(0.12)],
      [dashRear + M(0.1), dashTop - M(0.3)],
      [dashRear, dashTop - M(0.2)],
      [dashRear - M(0.02), dashTop - M(0.05)],
      [dashRear + M(0.06), dashTop + M(0.01)],
    ];
    cabin.push(tint(extrude(s, inner, M(0.03), 0, 4, 2), DASH));
    const driver = seatOf(-1, 0);
    // Binnacle over the instruments, and the centre stack with its screen.
    cabin.push(tint(roundedSlab(M(0.2), M(0.34), M(0.06), M(0.07), dashRear + M(0.12), dashTop - M(0.005), driver.z), DASH));
    cabin.push(tint(box(M(0.02), M(0.14), M(0.22), dashRear - M(0.005), dashTop - M(0.14), 0), 0x0b1a26));
    // Centre console from the dash back between the front seats.
    const consoleBack = driver.x - M(0.1);
    cabin.push(tint(roundedSlab(dashRear - consoleBack, M(0.2), M(0.05), M(0.2), (dashRear + consoleBack) / 2, floor, 0), DASH));
    cabin.push(tint(box(M(0.04), M(0.1), M(0.04), driver.x + M(0.28), floor + M(0.25), 0), 0x0f1012));
    // Steering column, from the dash to the wheel.
    const wheel = new Vector3(driver.x + M(DRIVER_WHEEL.forward), driver.hipY + M(DRIVER_WHEEL.up), driver.z);
    const column = new Vector3(dashRear + M(0.1), wheel.y - M(0.05), driver.z);
    cabin.push(tint(bar(wheel, column, M(0.06)), DASH));
  }
  // Seats: buckets in front, a bench behind.
  const recline = 0.44;
  for (const side of [-1, 1] as const) {
    const s = seatOf(side, 0);
    cabin.push(...seatShell(s.x, s.hipY, floor, M(0.5), s.z, recline, M(0.58), SEAT_FABRIC));
    const hr = headrestAt(s.x, s.hipY, recline);
    cabin.push(...headrest(hr.x, hr.y, s.z));
  }
  if (perSide > 1) {
    const s = seatOf(-1, rearRow);
    const benchZ = 0;
    const benchWidth = Math.min(inner - M(0.06), Math.abs(seatOf(1, rearRow).z - s.z) + M(0.62));
    cabin.push(...seatShell(s.x, s.hipY, floor, benchWidth, benchZ, recline + 0.05, M(0.56), SEAT_FABRIC));
    const hr = headrestAt(s.x, s.hipY, recline + 0.05);
    for (const side of [-1, 1] as const) cabin.push(...headrest(hr.x - M(0.01), hr.y - M(0.03), seatOf(side, rearRow).z, M(0.24)));
    // Behind the bench: a parcel shelf under a sedan's rear window, or the
    // floor of a hatchback's boot.
    const benchBack = s.x - M(0.14) - M(0.56) * Math.sin(recline + 0.05) - M(0.12);
    if (style === 'sedan') {
      cabin.push(tint(box(benchBack - dk.x + M(0.02), M(0.03), inner, (benchBack + dk.x) / 2, dk.y - M(0.03), 0), CARPET));
    } else {
      const bootFloor = floor + M(0.32);
      cabin.push(tint(box(s.x - M(0.2) - (back + M(0.12)), M(0.03), inner, (s.x - M(0.2) + back + M(0.12)) / 2, bootFloor, 0), CARPET));
      // Boot sides up to the waist, so nothing is seen through the tub.
      for (const sd of [-1, 1] as const) {
        cabin.push(tint(box(s.x - M(0.2) - (back + M(0.12)), dk.y - bootFloor, M(0.03), (s.x - M(0.2) + back + M(0.12)) / 2, (dk.y + bootFloor) / 2, sd * (halfW - SKIN - M(0.015))), CARD));
      }
      // A load cover, as most hatchbacks carry.
      cabin.push(tint(box(Math.max(M(0.1), benchBack - (dk.x + M(0.05))), M(0.015), inner - M(0.04), (benchBack + dk.x + M(0.05)) / 2, dk.y - M(0.02), 0), 0x2c2e33));
    }
  } else {
    // A van: a bulkhead behind the cab.
    cabin.push(tint(box(M(0.04), re.y - floor - M(0.04), inner, doorRear - M(0.03), (re.y + floor) / 2, 0), PANEL_GREY));
  }
  // Door cards with every door shut, and the trim behind the last door.
  for (const d of doors) {
    if (d.card) closedCards.push(d.card.clone().translate(d.hingeX, 0, d.hingeZ));
  }
  if (!p.blindRear && cabinRear < doorRear - M(0.05)) {
    for (const side of [-1, 1] as const) {
      const quarter = tint(box(doorRear - cabinRear, beltAt(doorRear) - floor, M(0.03), (doorRear + cabinRear) / 2, (beltAt(doorRear) + floor) / 2, side * (halfW - SKIN - M(0.015))), CARD);
      cabin.push(quarter);
    }
  }

  // ---- steering wheel.
  const driverIndex = seats.findIndex((s) => s.driver);
  const steering: SteeringModel | null = driverIndex >= 0
    ? { geometry: steeringWheel(M(DRIVER_WHEEL.radius)), seat: driverIndex, tilt: DRIVER_WHEEL.tilt }
    : null;

  // ---- trim: bumpers, grille, liners, sills, plates' recesses.
  const noseY = Y(p.noseY);
  trim.push(tint(roundedSlab(M(0.16), W - M(0.02), M(0.1), noseY * 0.42, front - M(0.06), clear + M(0.02), 0), DARK_TRIM));
  trim.push(tint(roundedSlab(M(0.16), W - M(0.02), M(0.1), M(0.22), back + M(0.06), clear + M(0.04), 0), DARK_TRIM));
  trim.push(tint(box(M(0.04), noseY * 0.2, W * 0.42, front + M(0.001), noseY * 0.74, 0), GRILLE));
  for (const ax of axles) {
    // Wheel-arch liners: nothing is seen through an arch but the tyre.
    const tread = W * 0.14;
    trim.push(tint(box(archR * 1.7, archY + archR * 0.95 - clear, W - tread * 2 - M(0.04), ax, (archY + archR * 0.95 + clear) / 2, 0), LINER));
  }
  for (const side of [-1, 1] as const) {
    // A black rocker along each sill.
    const xa = axles[1]! + archR + M(0.02);
    const xb = axles[0]! - archR - M(0.02);
    trim.push(tint(box(xb - xa, M(0.07), M(0.02), (xa + xb) / 2, clear + M(0.04), side * (halfW + M(0.004))), DARK_TRIM));
  }
  if (style === 'sedan' || style === 'hatch') {
    trim.push(tint(new CylinderGeometry(M(0.035), M(0.035), M(0.12), 8).rotateZ(Math.PI / 2).translate(back - M(0.01), clear + M(0.05), halfW * 0.55), CHROME_TRIM));
  }

  // ---- shut lines and handles on the whole body.
  for (const side of [-1, 1] as const) {
    for (let i = 0; i < edges.length; i++) {
      const x = edges[i]!;
      const lower = Math.max(sill, bottomAt(x));
      const upper = beltAt(x) - M(0.01);
      if (upper - lower < M(0.05)) continue;
      shell.push(tint(box(M(0.008), upper - lower, M(0.004), x, (upper + lower) / 2, side * (halfW + M(0.001))), SEAM));
    }
    const x0 = doorRear;
    const x1 = doorFront;
    shell.push(tint(box(x1 - x0, M(0.006), M(0.004), (x0 + x1) / 2, sill, side * (halfW + M(0.001))), SEAM));
  }

  // ---- lamps and plates.
  const lampY = noseY - M(0.07);
  const tailLampY = p.blindRear ? clear + M(0.62) : tailTop - M(0.14);
  const headlamps: Lamp[] = [];
  const taillamps: Lamp[] = [];
  const indicators: (Lamp & { side: DoorSide; front: boolean })[] = [];
  for (const side of [-1, 1] as const) {
    headlamps.push({ x: front - M(0.015), y: lampY, z: side * (halfW - M(0.24)), sx: M(0.05), sy: M(0.09), sz: M(0.3) });
    taillamps.push({ x: back + M(0.012), y: tailLampY, z: side * (halfW - M(0.2)), sx: M(0.04), sy: p.blindRear ? M(0.3) : M(0.1), sz: M(0.28) });
    indicators.push({ x: front - M(0.02), y: lampY - M(0.02), z: side * (halfW - M(0.06)), sx: M(0.05), sy: M(0.05), sz: M(0.06), side, front: true });
    indicators.push({ x: back + M(0.015), y: tailLampY + (p.blindRear ? M(0.2) : 0), z: side * (halfW - M(0.04)), sx: M(0.04), sy: M(0.06), sz: M(0.06), side, front: false });
  }
  const plates: Lamp[] = [
    { x: front + M(0.03), y: clear + noseY * 0.2, z: 0, sx: M(0.015), sy: M(0.11), sz: M(0.4) },
    { x: back - M(0.012), y: p.blindRear ? clear + M(0.4) : tailTop - M(0.3), z: 0, sx: M(0.015), sy: M(0.11), sz: M(0.4) },
  ];

  // ---- far LOD: the outline unbevelled, a dark greenhouse, dark wheels.
  const far: BufferGeometry[] = [];
  far.push(extrude(outline(back, front), W, 0, 0, 2));
  {
    const gh: P2[] = [[sb.x, beltAt(sb.x) - M(0.02)], ...roofStations.map(([x, y]) => [x, y] as P2)];
    if (!p.blindRear) gh.push([dk.x, dk.y - M(0.02)]);
    else gh.push([doorRear, beltAt(doorRear) - M(0.02)]);
    far.push(tint(extrude(gh, 2 * zSide(roofMid * 0.5 + beltLow * 0.5), 0, 0, 2), 0x1b2328));
    const roofSlab: P2[] = [...roofStations.map(([x, y]) => [x, y + M(0.02)] as P2), ...[...roofStations].reverse().map(([x, y]) => [x, y - M(0.04)] as P2)];
    far.push(extrude(roofSlab, 2 * zSide(roofMid) + M(0.02), 0, 0, 2));
  }
  far.push(...farWheels(axles, r, halfW, W * 0.14));

  const interior = merge([...cabin.map((g) => g.clone()), ...closedCards]);
  const openInterior = merge(cabin);
  return {
    shell: merge([...shell, ...doors.map((d) => d.panel.clone().translate(d.hingeX, 0, d.hingeZ))]),
    glass: merge([...fixedGlass.map((g) => g.clone()), ...doors.map((d) => d.glass.clone().translate(d.hingeX, 0, d.hingeZ))]),
    openShell: merge(openShell),
    openGlass: merge(fixedGlass),
    trim: merge(trim),
    interior,
    openInterior,
    roof: merge([roofPanel]),
    accent: null,
    far: merge(far),
    steering,
    doors,
    seats,
    headlamps,
    taillamps,
    indicators,
    plates,
  };
}

/** Where a headrest goes for a seat reclined by `recline`. */
function headrestAt(hipX: number, hipY: number, recline: number): { x: number; y: number } {
  const up = M(0.6);
  return { x: hipX - M(0.2) - up * Math.sin(recline), y: hipY - M(0.1) + up * Math.cos(recline) + M(0.02) };
}

/** Plain dark wheels for the far LOD. */
function farWheels(axles: readonly number[], r: number, halfW: number, tread: number): BufferGeometry[] {
  const out: BufferGeometry[] = [];
  for (const ax of axles) {
    for (const side of [-1, 1] as const) {
      out.push(tint(new CylinderGeometry(r, r, tread, 8).rotateX(Math.PI / 2).translate(ax, r, side * (halfW - tread / 2)), RUBBER_TRIM));
    }
  }
  return out;
}

// ------------------------------------------------------------------ wheels

/** A tyre with a rounded shoulder, axis along Z, unit diameter. */
export function tyreGeometry(section = 0.1): BufferGeometry {
  const pts: Vector2[] = [];
  const steps = 6;
  const outer = 0.5 - section;
  for (let i = 0; i <= steps; i++) {
    const angle = -Math.PI / 2 + (Math.PI * i) / steps;
    pts.push(new Vector2(outer + Math.cos(angle) * section, Math.sin(angle) * 0.5));
  }
  pts.unshift(new Vector2(outer - section * 0.9, -0.5));
  pts.push(new Vector2(outer - section * 0.9, 0.5));
  const g = new LatheGeometry(pts, 16);
  g.rotateX(Math.PI / 2);
  return g;
}

/** A five-spoke rim, axis along Z, unit diameter, one unit wide. */
export function rimGeometry(): BufferGeometry {
  const disc = new CylinderGeometry(0.36, 0.36, 0.5, 14).rotateX(Math.PI / 2);
  const parts: BufferGeometry[] = [disc];
  for (let i = 0; i < 5; i++) {
    const spoke = new BoxGeometry(0.62, 0.1, 0.16);
    spoke.translate(0.16, 0, 0.26);
    spoke.rotateZ((i * 2 * Math.PI) / 5);
    parts.push(spoke);
  }
  parts.push(new CylinderGeometry(0.09, 0.09, 0.3, 8).rotateX(Math.PI / 2).translate(0, 0, 0.2));
  return merge(parts);
}

/** A bicycle's wheel inside its tyre: a thin rim, a hub and spokes; unit diameter. */
export function spokedRimGeometry(): BufferGeometry {
  const parts: BufferGeometry[] = [new TorusGeometry(0.43, 0.025, 4, 24)];
  parts.push(new CylinderGeometry(0.05, 0.05, 0.9, 8).rotateX(Math.PI / 2));
  for (let i = 0; i < 16; i++) {
    const spoke = new BoxGeometry(0.008, 0.43, 0.008).translate(0, 0.215, (i % 2 ? 1 : -1) * 0.18);
    spoke.rotateZ((i * 2 * Math.PI) / 16);
    parts.push(spoke);
  }
  return merge(parts);
}

// ------------------------------------------------------------------ two-wheelers

/**
 * A motorcycle or a bicycle, in the same frame as a car, with the parts that
 * move kept apart: the steering assembly turns about the head tube, the
 * cranks of a bicycle turn with the pedalling, and the whole machine leans
 * into a bend about the line where its tyres touch the road.
 */
export interface TwoWheelerModel {
  /** Frame, tank, bodywork: painted. */
  readonly body: BufferGeometry;
  /** Seat, engine, exhaust, mudguards: unpainted. */
  readonly trim: BufferGeometry;
  /** Fork, handlebar and front lamp, in a frame whose origin is the steering head. */
  readonly steering: BufferGeometry;
  /** Where the steering head is: along the body, and its height. */
  readonly headX: number;
  readonly headY: number;
  /** Cranks and pedals, about the bottom bracket (bicycles only). */
  readonly cranks: BufferGeometry | null;
  readonly bracketX: number;
  readonly bracketY: number;
  /** Where the rider's pelvis sits: along the body and height above the road. */
  readonly seatX: number;
  readonly seatY: number;
  readonly headlamp: Lamp;
  readonly taillamp: Lamp;
}

export function buildTwoWheelerModel(a: Archetype): TwoWheelerModel {
  return a.shape === 'bicycle' ? bicycleModel(a) : motorcycleModel(a);
}

/** A bar from (x0, y0) to (x1, y1) at `z`, `wide` along the body and `deep` across it. */
function strut(x0: number, y0: number, x1: number, y1: number, z: number, wide: number, deep: number): BufferGeometry {
  const length = Math.hypot(x1 - x0, y1 - y0);
  const g = new BoxGeometry(wide, length, deep);
  g.rotateZ(-Math.atan2(x1 - x0, y1 - y0));
  g.translate((x0 + x1) / 2, (y0 + y1) / 2, z);
  return g;
}

function motorcycleModel(a: Archetype): TwoWheelerModel {
  const L = a.length;
  const r = a.wheelRadius;
  const front = L * 0.37;
  const rear = -L * 0.37;
  const headX = front - M(0.22);
  const headY = M(0.95);
  const body: BufferGeometry[] = [];
  const trim: BufferGeometry[] = [];
  // Tank, sloping down to the seat.
  body.push(extrude([[headX - M(0.05), M(0.8)], [headX - M(0.02), M(0.95)], [headX - M(0.2), M(1.0)], [headX - M(0.45), M(0.93)], [headX - M(0.55), M(0.8)]], M(0.32), M(0.06)));
  // Tail cowl behind the seat.
  body.push(extrude([[-M(0.2), M(0.8)], [-M(0.25), M(0.86)], [rear - M(0.02), M(0.92)], [rear + M(0.04), M(0.82)]], M(0.2), M(0.04)));
  // Frame spine from the head to the swingarm pivot.
  body.push(strut(headX, headY - M(0.05), -M(0.15), M(0.45), 0, M(0.07), M(0.08)));
  // Seat: a padded saddle from the tank back over the tail.
  trim.push(tint(extrude([[headX - M(0.5), M(0.86)], [-M(0.52), M(0.9)], [-M(0.56), M(0.84)], [headX - M(0.5), M(0.8)]], M(0.26), M(0.04)), 0x1a1a1c));
  // Engine block and cylinder, exhaust along the right side.
  trim.push(tint(box(M(0.44), M(0.32), M(0.28), M(0.02), M(0.47), 0), 0x55595e));
  trim.push(tint(new CylinderGeometry(M(0.045), M(0.05), L * 0.5, 8).rotateZ(Math.PI / 2 + 0.12).translate(-L * 0.14, M(0.34), M(0.17)), CHROME_TRIM));
  // Swingarm to the rear axle, and the rear mudguard.
  trim.push(strut(-M(0.12), M(0.42), rear, r, M(0.1), M(0.05), M(0.05)));
  trim.push(strut(-M(0.12), M(0.42), rear, r, -M(0.1), M(0.05), M(0.05)));
  trim.push(tint(box(M(0.26), M(0.03), M(0.14), rear + M(0.05), r + M(0.34), 0), DARK_TRIM));
  // Steering: fork legs down to the front axle, bars, headlamp nacelle,
  // front mudguard - modelled about the steering head.
  const steering: BufferGeometry[] = [];
  const dx = front - headX;
  const dy = r - headY;
  for (const side of [-1, 1] as const) steering.push(strut(0, 0, dx, dy, side * M(0.09), M(0.05), M(0.05)));
  steering.push(box(M(0.04), M(0.04), M(0.7), -M(0.1), M(0.13), 0));
  steering.push(tint(box(M(0.12), M(0.05), M(0.05), -M(0.1), M(0.14), M(0.33)), 0x1a1a1c));
  steering.push(tint(box(M(0.12), M(0.05), M(0.05), -M(0.1), M(0.14), -M(0.33)), 0x1a1a1c));
  steering.push(box(M(0.14), M(0.16), M(0.2), M(0.08), -M(0.02), 0));
  steering.push(tint(box(M(0.34), M(0.03), M(0.13), dx - M(0.02), dy + r + M(0.06), 0), DARK_TRIM));
  return {
    body: merge(body),
    trim: merge(trim),
    steering: merge(steering),
    headX,
    headY,
    cranks: null,
    bracketX: 0,
    bracketY: 0,
    seatX: -M(0.24),
    seatY: M(0.8),
    headlamp: { x: headX + M(0.16), y: headY - M(0.02), z: 0, sx: M(0.04), sy: M(0.12), sz: M(0.14) },
    taillamp: { x: rear - M(0.04), y: M(0.9), z: 0, sx: M(0.03), sy: M(0.05), sz: M(0.12) },
  };
}

function bicycleModel(a: Archetype): TwoWheelerModel {
  const L = a.length;
  const r = a.wheelRadius;
  const front = L * 0.37;
  const rear = -L * 0.37;
  const bracketX = -M(0.02);
  const bracketY = M(0.3);
  const seatTop = { x: -M(0.2), y: M(0.88) };
  const headX = front - M(0.2);
  const headY = M(0.9);
  const tube = M(0.035);
  const body: BufferGeometry[] = [];
  // The diamond: seat tube, top tube, down tube, and the two stays each side.
  body.push(strut(bracketX, bracketY, seatTop.x, seatTop.y, 0, tube, tube));
  body.push(strut(seatTop.x, seatTop.y - M(0.04), headX, headY - M(0.04), 0, tube, tube));
  body.push(strut(bracketX, bracketY, headX, headY - M(0.12), 0, tube * 1.2, tube * 1.2));
  for (const side of [-1, 1] as const) {
    body.push(strut(bracketX, bracketY, rear, r, side * M(0.06), tube * 0.8, tube * 0.8));
    body.push(strut(seatTop.x, seatTop.y - M(0.05), rear, r, side * M(0.06), tube * 0.8, tube * 0.8));
  }
  const trim: BufferGeometry[] = [];
  // Seat post and saddle, and a rear rack.
  trim.push(strut(seatTop.x, seatTop.y, seatTop.x - M(0.03), M(0.97), 0, M(0.025), M(0.025)));
  trim.push(tint(box(M(0.26), M(0.05), M(0.14), seatTop.x - M(0.02), M(0.99), 0), 0x1a1a1c));
  trim.push(box(M(0.34), M(0.02), M(0.12), rear + M(0.05), r + M(0.34), 0));
  // Steering: fork, stem and a flat bar with grips.
  const steering: BufferGeometry[] = [];
  for (const side of [-1, 1] as const) {
    steering.push(strut(0, 0, front - headX, r - headY, side * M(0.05), tube * 0.8, tube * 0.8));
    steering.push(tint(box(M(0.035), M(0.035), M(0.1), -M(0.08), M(0.15), side * M(0.26)), 0x1a1a1c));
  }
  steering.push(strut(0, 0, -M(0.06), M(0.14), 0, tube, tube));
  steering.push(box(M(0.025), M(0.025), M(0.56), -M(0.08), M(0.15), 0));
  // Cranks and pedals about the bottom bracket: two arms, opposite.
  const cranks: BufferGeometry[] = [];
  for (const side of [-1, 1] as const) {
    cranks.push(new BoxGeometry(M(0.17), M(0.025), M(0.02)).translate(side * M(0.085), 0, side * M(0.09)));
    cranks.push(tint(box(M(0.1), M(0.02), M(0.09), side * M(0.17), 0, side * M(0.13)), 0x1a1a1c));
  }
  cranks.push(new CylinderGeometry(M(0.09), M(0.09), M(0.012), 14).rotateX(Math.PI / 2).translate(0, 0, M(0.06)));
  return {
    body: merge(body),
    trim: merge(trim),
    steering: merge(steering),
    headX,
    headY,
    cranks: merge(cranks),
    bracketX,
    bracketY,
    seatX: seatTop.x - M(0.03),
    seatY: M(0.95),
    headlamp: { x: headX + M(0.06), y: headY - M(0.08), z: 0, sx: M(0.03), sy: M(0.05), sz: M(0.06) },
    taillamp: { x: rear - M(0.02), y: r + M(0.38), z: 0, sx: M(0.02), sy: M(0.04), sz: M(0.08) },
  };
}

// ------------------------------------------------------------------ bus

/**
 * A low-floor city bus. A lower body with the three wheel arches, a glazed
 * band down both sides between black pillars, a roof with rounded ends and an
 * air-conditioning pod, a raked windscreen over a destination blind, and on
 * the kerb side two plug doors of two glazed leaves each. Inside: a grey
 * floor, the driver's cab on the left with its seat, dashboard, wheel and
 * screen, rows of seats either side of the aisle clear of the middle door,
 * yellow stanchions, and a back row across the width.
 */
export function buildBusModel(a: Archetype): VehicleModel {
  const L = a.length;
  const W = a.width;
  const H = a.height;
  const r = a.wheelRadius;
  const halfW = W / 2;
  const front = L / 2;
  const back = -L / 2;
  const axles = axleStations(a);
  const archR = r + M(0.07);
  const clear = M(0.28);
  const floor = M(0.38);
  const sillY = M(1.02);
  const cant = H - M(0.42);
  const wall = M(0.06);
  const shell: BufferGeometry[] = [];
  const trim: BufferGeometry[] = [];
  const glass: BufferGeometry[] = [];
  const cabin: BufferGeometry[] = [];

  // Door openings on the kerb side: [rear edge, front edge].
  const doorSpans: [number, number][] = [[front - M(1.5), front - M(0.3)], [-M(0.9), M(0.3)]];

  // ---- lower body: side walls with the arches cut, front and rear panels.
  const archTop = (x: number): number => {
    let y = -Infinity;
    for (const ax of axles) {
      const dx = x - ax;
      if (Math.abs(dx) < archR) y = Math.max(y, r + Math.sqrt(archR * archR - dx * dx));
    }
    return y;
  };
  const xs = new Set<number>([back, front]);
  for (const ax of axles) for (let i = 0; i <= 16; i++) xs.add(ax - archR + (2 * archR * i) / 16);
  for (const [x0, x1] of doorSpans) { xs.add(x0); xs.add(x1); }
  const bottom: P2[] = [...xs].filter((x) => x >= back && x <= front).sort((u, v) => u - v)
    .map((x) => [x, Math.max(clear, archTop(x))] as const);
  const wallOutline = (xa: number, xb: number, topY: number): P2[] => [...clipX(bottom, xa, xb), [xb, topY], [xa, topY]];
  // Left: one wall. Right: the stretches between the doors.
  shell.push(extrude(wallOutline(back + M(0.08), front - M(0.08), sillY), wall, M(0.02), -(halfW - wall / 2), 4, 2));
  {
    let x = back + M(0.08);
    for (const [x0, x1] of [...doorSpans].sort((u, v) => u[0] - v[0])) {
      shell.push(extrude(wallOutline(x, x0, sillY), wall, M(0.02), halfW - wall / 2, 4, 2));
      x = x1;
    }
    shell.push(extrude(wallOutline(x, front - M(0.08), sillY), wall, M(0.02), halfW - wall / 2, 4, 2));
  }
  // A darker skirt band along the bottom.
  for (const side of [-1, 1] as const) {
    trim.push(tint(box(L - M(0.3), M(0.1), M(0.02), 0, clear + M(0.05), side * (halfW + M(0.005))), DARK_TRIM));
  }
  // Front: a panel from the bumper to the windscreen, rounded at the corners.
  const screenBase = M(0.95);
  shell.push(roundedSlab(M(0.14), W, M(0.1), screenBase - clear, front - M(0.07), clear, 0));
  shell.push(roundedSlab(M(0.14), W, M(0.1), sillY - clear + M(0.05), back + M(0.07), clear, 0));
  // Rear: engine bay under a panel up to the cant rail, with a small window.
  shell.push(box(M(0.06), cant - sillY, W - M(0.04), back + M(0.03), (cant + sillY) / 2, 0));
  glass.push(twoSided([[-halfW + M(0.3), sillY + M(0.9)], [halfW - M(0.3), sillY + M(0.9)], [halfW - M(0.3), cant - M(0.15)], [-halfW + M(0.3), cant - M(0.15)]],
    ([z, y]) => new Vector3(back - M(0.005), y, z), new Vector3(-1, 0, 0), M(0.006)));
  trim.push(tint(box(M(0.02), M(0.5), W * 0.7, back - M(0.005), clear + M(0.45), 0), GRILLE));

  // ---- the window band: pillars and glass from the sill to the cant rail.
  const bays = Math.max(5, Math.round((L - M(1.5)) / M(1.4)));
  const bandStart = back + M(0.15);
  const bandEnd = front - M(0.25);
  const pillar = M(0.09);
  for (const side of [-1, 1] as const) {
    const z = side * (halfW - wall / 2);
    const spans: [number, number][] = [];
    // Pillars at bay edges, skipping the door openings on the kerb side.
    const inDoor = (x: number): boolean => side === 1 && doorSpans.some(([x0, x1]) => x > x0 - M(0.05) && x < x1 + M(0.05));
    const posts: number[] = [];
    for (let i = 0; i <= bays; i++) posts.push(bandStart + ((bandEnd - bandStart) * i) / bays);
    if (side === 1) for (const [x0, x1] of doorSpans) posts.push(x0 - pillar / 2, x1 + pillar / 2);
    const sorted = posts.filter((x) => !inDoor(x) || doorSpans.some(([x0, x1]) => Math.abs(x - x0 + pillar / 2) < 1e-6 || Math.abs(x - x1 - pillar / 2) < 1e-6))
      .sort((u, v) => u - v);
    for (const x of sorted) shell.push(tint(box(pillar, cant - sillY, wall, x, (cant + sillY) / 2, z), BLACKOUT));
    for (let i = 0; i < sorted.length - 1; i++) {
      const x0 = sorted[i]! + pillar / 2;
      const x1 = sorted[i + 1]! - pillar / 2;
      if (x1 - x0 < M(0.2) || inDoor((x0 + x1) / 2)) continue;
      spans.push([x0, x1]);
    }
    for (const [x0, x1] of spans) {
      glass.push(twoSided([[x0, sillY], [x1, sillY], [x1, cant], [x0, cant]], ([x, y]) => new Vector3(x, y, side * (halfW - wall * 0.3)), new Vector3(0, 0, side), M(0.006)));
    }
    // A black band under the glass, the rubber of the glazing.
    shell.push(tint(box(bandEnd - bandStart, M(0.05), wall + M(0.004), (bandStart + bandEnd) / 2, sillY + M(0.01), z), BLACKOUT));
  }
  // The driver's side window, ahead of the first bay on the left.
  // Windscreen: raked a little, black-edged, over the destination blind.
  const screenTop = cant - M(0.3);
  glass.push(loft([[front - M(0.04), screenBase], [front - M(0.14), screenTop]], () => halfW - M(0.08), M(0.04), 6));
  shell.push(tint(box(M(0.1), M(0.08), W - M(0.02), front - M(0.06), screenBase - M(0.02), 0), BLACKOUT));
  for (const side of [-1, 1] as const) {
    shell.push(tint(bar(new Vector3(front - M(0.05), screenBase, side * (halfW - M(0.04))), new Vector3(front - M(0.16), cant, side * (halfW - M(0.04))), M(0.09), M(0.08)), BLACKOUT));
  }
  shell.push(tint(box(M(0.12), cant - screenTop, W - M(0.02), front - M(0.15), (cant + screenTop) / 2, 0), BLACKOUT));

  // ---- roof with rounded ends, and the air-conditioning pod.
  {
    const s: P2[] = [[back + M(0.02), cant], [front - M(0.12), cant], [front - M(0.2), H - M(0.12)], [front - M(0.5), H], [back + M(0.35), H], [back + M(0.03), H - M(0.1)]];
    shell.push(extrude(s, W, M(0.08), 0, 6));
    trim.push(tint(roundedSlab(M(2.6), W * 0.62, M(0.2), M(0.2), -M(0.6), H - M(0.01), 0), 0xd4d7da));
  }

  // ---- doors: two glazed leaves each, sliding apart on the kerb side.
  const doors: DoorModel[] = [];
  doorSpans.forEach(([x0, x1], index) => {
    const leaf = (x1 - x0) / 2;
    for (const dir of [1, -1] as const) {
      // Leaf origin at its own centre line on the closed door.
      const cx = dir === 1 ? x1 - leaf / 2 : x0 + leaf / 2;
      const hingeZ = halfW - wall / 2;
      const frame: BufferGeometry[] = [];
      const hw = leaf / 2 - M(0.005);
      const top = cant - M(0.02);
      const bot = floor + M(0.02);
      frame.push(tint(box(leaf - M(0.01), M(0.08), wall * 0.7, 0, bot + M(0.04), 0), BLACKOUT));
      frame.push(tint(box(leaf - M(0.01), M(0.08), wall * 0.7, 0, top - M(0.04), 0), BLACKOUT));
      frame.push(tint(box(M(0.06), top - bot, wall * 0.7, hw - M(0.03), (top + bot) / 2, 0), BLACKOUT));
      frame.push(tint(box(M(0.06), top - bot, wall * 0.7, -hw + M(0.03), (top + bot) / 2, 0), BLACKOUT));
      frame.push(tint(box(leaf - M(0.1), M(0.04), wall * 0.7, 0, sillY, 0), BLACKOUT));
      const pane = twoSided([[-hw + M(0.05), bot + M(0.08)], [hw - M(0.05), bot + M(0.08)], [hw - M(0.05), top - M(0.08)], [-hw + M(0.05), top - M(0.08)]],
        ([x, y]) => new Vector3(x, y, 0), new Vector3(0, 0, 1), M(0.006));
      doors.push({ index, side: 1, kind: 'slide', slide: dir * (leaf - M(0.06)), hingeX: cx, hingeZ, length: leaf, seat: -1,
        panel: merge(frame), glass: pane, card: null });
    }
  });

  // ---- inside.
  cabin.push(tint(box(L - M(0.3), M(0.04), W - wall * 2, 0, floor, 0), BUS_FLOOR));
  // Inner walls under the windows, so the tub reads as a room.
  for (const side of [-1, 1] as const) {
    cabin.push(tint(box(L - M(0.4), sillY - floor, M(0.03), 0, (sillY + floor) / 2, side * (halfW - wall - M(0.015))), BUS_SHELL));
  }
  // Wheel-arch boxes inside, over the rear tandem.
  for (const ax of axles.slice(1)) {
    for (const side of [-1, 1] as const) {
      cabin.push(tint(box(archR * 1.9, archR + r - floor + M(0.04), M(0.45), ax, (archR + r + floor) / 2, side * (halfW - wall - M(0.23))), BUS_SHELL));
    }
  }
  // Driver's cab: dashboard, seat, wheel column and a partition behind.
  const seats: SeatModel[] = [];
  const driverX = front - M(1.2);
  const driverZ = -halfW + M(0.62);
  const driverHip = floor + M(0.5);
  cabin.push(tint(extrude([[front - M(0.12), screenBase + M(0.05)], [front - M(0.12), floor], [front - M(0.5), floor], [front - M(0.55), screenBase - M(0.05)], [front - M(0.45), screenBase + M(0.12)]], W - wall * 2 - M(0.02), M(0.03), 0, 4, 2), DASH));
  cabin.push(...seatShell(driverX, driverHip, floor, M(0.52), driverZ, 0.3, M(0.62), SEAT_FABRIC));
  const hr = headrestAt(driverX, driverHip, 0.3);
  cabin.push(...headrest(hr.x, hr.y, driverZ));
  cabin.push(tint(box(M(0.04), M(1.1), M(0.9), driverX - M(0.48), floor + M(0.55), -halfW + M(0.5)), PANEL_GREY));
  const wheelAt = new Vector3(driverX + M(DRIVER_WHEEL.forward), driverHip + M(DRIVER_WHEEL.up), driverZ);
  cabin.push(tint(bar(wheelAt, new Vector3(front - M(0.45), floor + M(0.3), driverZ), M(0.07)), DASH));
  seats.push({ x: driverX, z: driverZ, hipY: driverHip, headroom: cant - M(0.05) - driverHip, legroom: front - M(0.12) - driverX,
    floor, sideRoom: Math.min(M(0.45), halfW - wall - Math.abs(driverZ)), driver: true, row: 0, pose: 'car' });

  // Passenger seats: pairs either side of the aisle, a row of five at the back.
  const pitch = M(0.78);
  const seatWidth = M(0.44);
  const seatHip = floor + M(0.55);
  const passenger: { x: number; z: number }[] = [];
  const firstRow = front - M(2.1);
  const lastRow = back + M(1.25);
  const inDoorway = (x: number): boolean => doorSpans.some(([x0, x1]) => x > x0 - M(0.45) && x < x1 + M(0.6));
  for (let x = firstRow; x >= lastRow; x -= pitch) {
    for (const side of [-1, 1] as const) {
      if (side === 1 && inDoorway(x)) continue;
      for (const k of [0, 1]) passenger.push({ x, z: side * (halfW - wall - M(0.04) - seatWidth * (k + 0.5)) });
    }
  }
  const backRow = back + M(0.55);
  for (let k = -2; k <= 2; k++) passenger.push({ x: backRow, z: k * (seatWidth + M(0.02)) });
  for (const s of passenger) {
    cabin.push(...busSeat(s.x, seatHip, floor, seatWidth, s.z));
  }
  // The six seats the simulation fills (seats 1..6) are spread over the bus;
  // the rest are empty.
  const order = spreadOrder(passenger.length);
  for (const i of order) {
    const s = passenger[i]!;
    const ahead = passenger.some((q) => Math.abs(q.z - s.z) < 1e-3 && q.x > s.x && q.x - s.x < pitch * 1.5);
    seats.push({ x: s.x, z: s.z, hipY: seatHip, headroom: cant - M(0.05) - seatHip,
      legroom: ahead ? pitch - M(0.12) : M(0.9), floor, sideRoom: seatWidth / 2 + M(0.04), driver: false, row: 1, pose: 'chair' });
  }
  // Stanchions by the aisle and at the doors, and the ceiling rails.
  const aisle = halfW - wall - M(0.04) - seatWidth * 2 - M(0.03);
  for (let x = firstRow + M(0.3); x > lastRow; x -= pitch * 2) {
    for (const side of [-1, 1] as const) {
      if (side === 1 && inDoorway(x)) continue;
      cabin.push(tint(new CylinderGeometry(M(0.02), M(0.02), cant - floor, 6).translate(x, (cant + floor) / 2, side * aisle), POLE_YELLOW));
    }
  }
  for (const [x0, x1] of doorSpans) {
    cabin.push(tint(new CylinderGeometry(M(0.02), M(0.02), cant - floor, 6).translate((x0 + x1) / 2, (cant + floor) / 2, halfW - wall - M(0.35)), POLE_YELLOW));
  }
  for (const side of [-1, 1] as const) {
    cabin.push(tint(new CylinderGeometry(M(0.018), M(0.018), L - M(3), 6).rotateZ(Math.PI / 2).translate(-M(0.5), cant - M(0.12), side * aisle), POLE_YELLOW));
  }

  // ---- lamps, blind and plates.
  const headlamps: Lamp[] = [];
  const taillamps: Lamp[] = [];
  const indicators: (Lamp & { side: DoorSide; front: boolean })[] = [];
  for (const side of [-1, 1] as const) {
    headlamps.push({ x: front + M(0.005), y: M(0.62), z: side * (halfW - M(0.3)), sx: M(0.04), sy: M(0.14), sz: M(0.34) });
    taillamps.push({ x: back - M(0.005), y: M(0.75), z: side * (halfW - M(0.18)), sx: M(0.04), sy: M(0.34), sz: M(0.16) });
    indicators.push({ x: front + M(0.005), y: M(0.82), z: side * (halfW - M(0.12)), sx: M(0.04), sy: M(0.08), sz: M(0.12), side, front: true });
    indicators.push({ x: back - M(0.005), y: M(1.15), z: side * (halfW - M(0.18)), sx: M(0.04), sy: M(0.1), sz: M(0.16), side, front: false });
  }
  const plates: Lamp[] = [
    { x: front + M(0.01), y: M(0.45), z: 0, sx: M(0.015), sy: M(0.13), sz: M(0.4) },
    { x: back - M(0.01), y: M(0.5), z: 0, sx: M(0.015), sy: M(0.13), sz: M(0.4) },
    // The destination blind, lit.
    { x: front - M(0.14), y: cant - M(0.16), z: 0, sx: M(0.02), sy: M(0.2), sz: W - M(0.5) },
  ];

  const steering: SteeringModel = { geometry: steeringWheel(M(DRIVER_WHEEL.radius) * 1.15), seat: 0, tilt: DRIVER_WHEEL.tilt };
  const far = merge([
    box(L - M(0.1), sillY - clear, W, 0, (sillY + clear) / 2, 0),
    tint(box(L - M(0.3), cant - sillY, W - M(0.04), 0, (cant + sillY) / 2, 0), 0x1b2328),
    extrude([[back + M(0.02), cant], [front - M(0.12), cant], [front - M(0.2), H - M(0.12)], [front - M(0.5), H], [back + M(0.35), H], [back + M(0.03), H - M(0.1)]], W, 0, 0, 2),
    ...farWheels(axles, r, halfW, W * 0.14),
  ]);
  const shellGeo = merge(shell);
  const glassGeo = merge(glass);
  const interiorGeo = merge(cabin);
  return {
    shell: shellGeo, glass: glassGeo, openShell: shellGeo, openGlass: glassGeo,
    trim: merge(trim), interior: interiorGeo, openInterior: interiorGeo,
    roof: null, accent: null, far, steering, doors, seats, headlamps, taillamps, indicators, plates,
  };
}

/** A bus seat: a moulded shell on a pedestal, a grab handle on top. */
function busSeat(x: number, hipY: number, floor: number, width: number, z: number): BufferGeometry[] {
  const parts = seatShell(x, hipY, floor, width - M(0.03), z, 0.14, M(0.52), BUS_SEAT);
  const backX = x - M(0.14) - M(0.52) * Math.sin(0.14) - M(0.08);
  parts.push(tint(box(M(0.03), M(0.03), width * 0.5, backX, hipY - M(0.1) + M(0.54), z), POLE_YELLOW));
  return parts;
}

/**
 * The order the simulation's passenger seats take the bus's seats in: spread
 * from front to back and side to side, so six passengers are not six in a row.
 */
function spreadOrder(n: number): number[] {
  const out: number[] = [];
  const used = new Set<number>();
  const want = [0.08, 0.55, 0.3, 0.8, 0.18, 0.66, 0.42, 0.92];
  want.forEach((f, k) => {
    let i = Math.min(n - 1, Math.floor(f * n)) + (k % 2);
    while (used.has(i % n)) i++;
    used.add(i % n);
    out.push(i % n);
  });
  for (let i = 0; i < n; i++) if (!used.has(i)) out.push(i);
  return out;
}

// ------------------------------------------------------------------ truck

/**
 * A rigid truck: a cab over the front axle with a raked windscreen, a roof
 * deflector, doors over the front wheels with steps behind them, a cab you
 * can see into; a dark chassis with the fuel tank, side guards and the rear
 * axles; and a box body in the truck's second colour (`accent`).
 */
export function buildTruckModel(a: Archetype): VehicleModel {
  const L = a.length;
  const W = a.width;
  const H = a.height;
  const r = a.wheelRadius;
  const halfW = W / 2;
  const cabLength = L * a.cabinFraction;
  const cabFront = L / 2;
  const cabBack = cabFront - cabLength;
  const axles = axleStations(a);
  const archR = r + M(0.08);
  const cabFloor = M(1.15);
  const cabBottom = M(0.95);
  const belt = M(1.9);
  const cabTop = M(2.95);
  const shell: BufferGeometry[] = [];
  const trim: BufferGeometry[] = [];
  const glass: BufferGeometry[] = [];
  const cabin: BufferGeometry[] = [];
  const accent: BufferGeometry[] = [];
  const skin = M(0.06);

  // ---- cab: front face, sides with the door openings, rear wall, roof.
  const doorFront = cabFront - M(0.42);
  const doorRear = cabBack + M(0.22);
  shell.push(roundedSlab(M(0.16), W, M(0.12), belt - M(0.55), cabFront - M(0.08), M(0.55), 0));
  for (const side of [-1, 1] as const) {
    const z = side * (halfW - skin / 2);
    // Front corner and rear strip of each side, from the cab bottom to the waist.
    shell.push(extrude([[doorFront, cabBottom], [cabFront - M(0.1), cabBottom], [cabFront - M(0.1), belt], [doorFront, belt]], skin, M(0.015), z, 2, 1));
    shell.push(extrude([[cabBack, cabBottom], [doorRear, cabBottom], [doorRear, belt], [cabBack, belt]], skin, M(0.015), z, 2, 1));
    // Mudguard over the front wheel.
    trim.push(tint(extrude(archOutline(axles[0]!, r, archR), M(0.3), M(0.02), side * (halfW - M(0.17)), 8, 1), DARK_TRIM));
    // Steps behind the wheel, up to the cab floor.
    for (const [k, y] of [[0, M(0.5)], [1, M(0.82)]] as const) {
      trim.push(tint(box(M(0.4), M(0.04), M(0.22), axles[0]! - archR - M(0.25) + k * M(0.05), y, side * (halfW - M(0.12))), CHROME_TRIM));
    }
    trim.push(tint(box(M(0.5), M(0.5), M(0.03), axles[0]! - archR - M(0.25), M(0.68), side * (halfW - M(0.02))), DARK_TRIM));
    // Mirror arm and head.
    trim.push(tint(bar(new Vector3(cabFront - M(0.3), belt + M(0.2), side * halfW), new Vector3(cabFront - M(0.25), belt + M(0.35), side * (halfW + M(0.28))), M(0.035)), DARK_TRIM));
    trim.push(tint(box(M(0.08), M(0.42), M(0.16), cabFront - M(0.25), belt + M(0.35), side * (halfW + M(0.3))), DARK_TRIM));
    // Side glass behind the door and the pillars.
    shell.push(box(M(0.1), cabTop - belt, skin, cabBack + M(0.05), (cabTop + belt) / 2, z));
    shell.push(bar(new Vector3(cabFront - M(0.1), belt, z), new Vector3(cabFront - M(0.3), cabTop - M(0.05), z), M(0.1), skin));
    glass.push(twoSided([[cabBack + M(0.1), belt], [doorRear, belt], [doorRear, cabTop - M(0.08)], [cabBack + M(0.1), cabTop - M(0.08)]],
      ([x, y]) => new Vector3(x, y, side * (halfW - skin / 2)), new Vector3(0, 0, side), M(0.006)));
  }
  // Cab floor seen from the side under the doors, and the rear wall.
  shell.push(box(cabLength - M(0.1), M(0.06), W - M(0.02), cabBack + (cabLength - M(0.1)) / 2, cabBottom, 0));
  shell.push(box(M(0.06), cabTop - cabBottom, W - M(0.02), cabBack + M(0.03), (cabTop + cabBottom) / 2, 0));
  // Roof, and a deflector up to the height of the box.
  shell.push(extrude([[cabBack, cabTop - M(0.04)], [cabFront - M(0.32), cabTop - M(0.04)], [cabFront - M(0.36), cabTop + M(0.08)], [cabBack, cabTop + M(0.08)]], W, M(0.05), 0, 2));
  shell.push(extrude([[cabBack + M(0.05), cabTop + M(0.06)], [cabFront - M(0.8), cabTop + M(0.06)], [cabBack + M(0.25), H - M(0.08)], [cabBack + M(0.05), H - M(0.08)]], W - M(0.1), M(0.04), 0, 2));
  // Windscreen and the black surround.
  glass.push(loft([[cabFront - M(0.1), belt + M(0.02)], [cabFront - M(0.3), cabTop - M(0.06)]], () => halfW - M(0.1), M(0.03), 6));
  shell.push(tint(box(M(0.06), M(0.08), W - M(0.04), cabFront - M(0.1), belt - M(0.01), 0), BLACKOUT));
  // Grille, bumper and the lamps' housings.
  trim.push(tint(box(M(0.03), M(0.55), W * 0.62, cabFront + M(0.005), belt - M(0.42), 0), GRILLE));
  trim.push(tint(roundedSlab(M(0.2), W, M(0.1), M(0.3), cabFront + M(0.01), M(0.42), 0), DARK_TRIM));

  // ---- doors over the front wheels.
  const doors: DoorModel[] = [];
  const seats: SeatModel[] = [];
  for (const side of [-1, 1] as const) {
    const hingeX = doorFront - SHUT;
    const x1 = doorRear + SHUT;
    const hingeZ = side * (halfW - skin / 2);
    const panel = merge([
      extrude([[x1 - hingeX, cabBottom + M(0.02)], [0, cabBottom + M(0.02)], [0, belt], [x1 - hingeX, belt]], skin, M(0.015), 0, 2, 1),
      tint(box(M(0.2), M(0.04), M(0.02), (x1 - hingeX) + M(0.2), belt - M(0.15), side * (skin / 2 + M(0.008))), SEAM),
    ]);
    const doorGlass = twoSided([[x1 - hingeX + M(0.03), belt], [-M(0.04), belt], [-M(0.18), cabTop - M(0.08)], [x1 - hingeX + M(0.03), cabTop - M(0.08)]],
      ([x, y]) => new Vector3(x, y, 0), new Vector3(0, 0, side), M(0.006));
    const card = tint(box(hingeX - x1 - M(0.04), belt - cabFloor - M(0.02), M(0.03), (x1 - hingeX) / 2, (belt + cabFloor) / 2, -side * M(0.04)), CARD);
    doors.push({ index: doors.length, side, kind: 'hinge', slide: 0, hingeX, hingeZ, length: hingeX - x1, seat: side === -1 ? 0 : 1,
      panel, glass: doorGlass, card });
  }
  // ---- cab interior.
  const seatX = cabBack + M(0.62);
  const hipY = cabFloor + M(0.45);
  cabin.push(tint(box(cabLength - M(0.2), M(0.04), W - skin * 2 - M(0.04), cabBack + cabLength / 2, cabFloor, 0), CARPET));
  cabin.push(tint(box(M(0.5), M(0.28), M(0.6), seatX + M(0.35), cabFloor + M(0.14), 0), DASH));
  cabin.push(tint(extrude([[cabFront - M(0.1), belt + M(0.04)], [cabFront - M(0.1), cabFloor], [cabFront - M(0.45), cabFloor], [cabFront - M(0.6), belt - M(0.15)], [cabFront - M(0.55), belt + M(0.08)]], W - skin * 2 - M(0.06), M(0.03), 0, 4, 2), DASH));
  cabin.push(tint(box(M(0.04), cabTop - cabFloor, W - skin * 2 - M(0.04), cabBack + M(0.08), (cabTop + cabFloor) / 2, 0), 0x3c3a36));
  for (const side of [-1, 1] as const) {
    const z = side * (halfW - M(0.55));
    cabin.push(...seatShell(seatX, hipY, cabFloor, M(0.52), z, 0.3, M(0.62), SEAT_FABRIC));
    const h = headrestAt(seatX, hipY, 0.3);
    cabin.push(...headrest(h.x, h.y, z));
    seats.push({ x: seatX, z, hipY, headroom: cabTop - M(0.08) - hipY, legroom: cabFront - M(0.45) - seatX,
      floor: cabFloor + M(0.02), sideRoom: Math.min(M(0.42), halfW - skin - Math.abs(z)), driver: side === -1, row: 0, pose: 'car' });
    if (side === -1) {
      const wheel = new Vector3(seatX + M(DRIVER_WHEEL.forward), hipY + M(DRIVER_WHEEL.up), z);
      cabin.push(tint(bar(wheel, new Vector3(cabFront - M(0.5), belt - M(0.1), z), M(0.07)), DASH));
    }
  }

  // ---- chassis, tank, guards, mudguards.
  const boxFront = cabBack - M(0.18);
  trim.push(tint(box(L - M(0.4), M(0.25), W * 0.62, -M(0.1), M(0.74), 0), DARK_TRIM));
  trim.push(tint(new CylinderGeometry(M(0.26), M(0.26), M(1.1), 12).rotateZ(Math.PI / 2).translate(boxFront - M(0.9), M(0.62), -halfW + M(0.32)), CHROME_TRIM));
  trim.push(tint(box(M(0.9), M(0.45), M(0.5), boxFront - M(0.9), M(0.62), halfW - M(0.35)), DARK_TRIM));
  for (const side of [-1, 1] as const) {
    const xa = axles[1]! + archR + M(0.1);
    const xb = boxFront - M(1.6);
    if (xb - xa > M(0.3)) trim.push(tint(box(xb - xa, M(0.28), M(0.03), (xa + xb) / 2, M(0.62), side * (halfW - M(0.05))), 0x8e9398));
    trim.push(tint(extrude(archOutline((axles[1]! + axles[2]!) / 2, r, archR + (axles[1]! - axles[2]!) / 2), M(0.5), M(0.02), side * (halfW - M(0.27)), 8, 1), DARK_TRIM));
  }
  trim.push(tint(box(M(0.12), M(0.14), W - M(0.1), -L / 2 + M(0.1), M(0.55), 0), DARK_TRIM));

  // ---- the box body, with its floor rail, corner posts and rear doors.
  const boxBack = -L / 2 + M(0.05);
  const boxLength = boxFront - boxBack;
  const boxBottom = M(1.05);
  accent.push(extrude([[boxBack, boxBottom], [boxFront, boxBottom], [boxFront, H], [boxBack, H]], W, M(0.03), 0, 2, 1));
  trim.push(tint(box(boxLength, M(0.12), W + M(0.01), (boxFront + boxBack) / 2, boxBottom + M(0.02), 0), DARK_TRIM));
  for (const x of [boxFront, boxBack]) {
    for (const side of [-1, 1] as const) {
      trim.push(tint(box(M(0.08), H - boxBottom, M(0.08), x + (x === boxFront ? -M(0.04) : M(0.04)), (H + boxBottom) / 2, side * (halfW - M(0.03))), 0x9aa0a6));
    }
  }
  accent.push(tint(box(M(0.01), H - boxBottom - M(0.2), M(0.01), boxBack - M(0.005), (H + boxBottom) / 2, 0), SEAM));
  for (const side of [-1, 1] as const) {
    trim.push(tint(box(M(0.02), M(0.8), M(0.05), boxBack - M(0.01), boxBottom + M(1.1), side * M(0.2)), CHROME_TRIM));
  }

  const headlamps: Lamp[] = [];
  const taillamps: Lamp[] = [];
  const indicators: (Lamp & { side: DoorSide; front: boolean })[] = [];
  for (const side of [-1, 1] as const) {
    headlamps.push({ x: cabFront + M(0.01), y: M(0.82), z: side * (halfW - M(0.32)), sx: M(0.04), sy: M(0.14), sz: M(0.34) });
    taillamps.push({ x: -L / 2 + M(0.02), y: M(0.62), z: side * (halfW - M(0.2)), sx: M(0.04), sy: M(0.14), sz: M(0.26) });
    indicators.push({ x: cabFront + M(0.01), y: M(0.82), z: side * (halfW - M(0.08)), sx: M(0.04), sy: M(0.1), sz: M(0.1), side, front: true });
    indicators.push({ x: -L / 2 + M(0.02), y: M(0.82), z: side * (halfW - M(0.2)), sx: M(0.04), sy: M(0.08), sz: M(0.14), side, front: false });
  }
  const plates: Lamp[] = [
    { x: cabFront + M(0.12), y: M(0.5), z: 0, sx: M(0.015), sy: M(0.12), sz: M(0.4) },
    { x: -L / 2 + M(0.03), y: M(0.5), z: 0, sx: M(0.015), sy: M(0.14), sz: M(0.4) },
  ];
  const steering: SteeringModel = { geometry: steeringWheel(M(DRIVER_WHEEL.radius) * 1.15), seat: 0, tilt: DRIVER_WHEEL.tilt };

  const far = merge([
    box(cabLength - M(0.05), belt - cabBottom, W, cabBack + cabLength / 2, (belt + cabBottom) / 2, 0),
    tint(box(cabLength - M(0.3), cabTop - belt, W - M(0.04), cabBack + (cabLength - M(0.3)) / 2, (cabTop + belt) / 2, 0), 0x1b2328),
    box(cabLength - M(0.3), M(0.12), W, cabBack + (cabLength - M(0.3)) / 2, cabTop + M(0.02), 0),
    tint(box(L - M(0.4), M(0.3), W * 0.62, -M(0.1), M(0.74), 0), DARK_TRIM),
    ...farWheels(axles, r, halfW, W * 0.14),
  ]);
  const farBox = tint(extrude([[boxBack, boxBottom], [boxFront, boxBottom], [boxFront, H], [boxBack, H]], W, 0, 0, 1), 0xd8dadc);
  const closedCards = doors.map((d) => d.card!.clone().translate(d.hingeX, 0, d.hingeZ));
  const shellGeo = merge(shell);
  return {
    shell: merge([shellGeo.clone(), ...doors.map((d) => d.panel.clone().translate(d.hingeX, 0, d.hingeZ))]),
    glass: merge([...glass.map((g) => g.clone()), ...doors.map((d) => d.glass.clone().translate(d.hingeX, 0, d.hingeZ))]),
    openShell: shellGeo,
    openGlass: merge(glass),
    trim: merge(trim),
    interior: merge([...cabin.map((g) => g.clone()), ...closedCards]),
    openInterior: merge(cabin),
    roof: null,
    accent: merge(accent),
    far: merge([far, farBox]),
    steering,
    doors,
    seats,
    headlamps,
    taillamps,
    indicators,
    plates,
  };
}

/** A mudguard's outline over a wheel: a half ring. */
function archOutline(cx: number, cy: number, radius: number): P2[] {
  const out: P2[] = [];
  const inner = radius;
  const outer = radius + M(0.06);
  for (let i = 0; i <= 10; i++) {
    const a = Math.PI - (Math.PI * i) / 10;
    out.push([cx + Math.cos(a) * outer, cy + Math.sin(a) * outer]);
  }
  for (let i = 10; i >= 0; i--) {
    const a = Math.PI - (Math.PI * i) / 10;
    out.push([cx + Math.cos(a) * inner, cy + Math.sin(a) * inner]);
  }
  return out;
}

/**
 * The body with every door shut, as one painted and one glazed geometry.
 * Kept for callers written against the older model: the model now carries
 * them itself.
 */
export function closedBody(model: VehicleModel): { shell: BufferGeometry; glass: BufferGeometry } {
  return { shell: model.shell, glass: model.glass };
}
