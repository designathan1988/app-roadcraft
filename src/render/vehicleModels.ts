import {
  BoxGeometry,
  BufferGeometry,
  CylinderGeometry,
  ExtrudeGeometry,
  Float32BufferAttribute,
  LatheGeometry,
  Shape,
  TorusGeometry,
  Vector2,
} from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

import type { Archetype, BodyStyle } from '@sim/vehicles/archetypes';
import { m } from '@world/units';

/**
 * Vehicle bodies, built once per class from the class's own proportions.
 *
 * Every vehicle used to be a stack of scaled boxes: a slab for the body, a
 * smaller slab for the cabin, glass as thin boxes stood on top. From the
 * isometric camera that read as a brick with a lid, the doors did not exist,
 * and nobody could be seen inside because the "cabin" was solid paint.
 *
 * A body is now drawn the way a car is designed, from a SIDE PROFILE:
 *
 *  - the nose (bumper, bonnet, front wings) and the tail (boot or hatch, rear
 *    wings) are profiles with their wheel arches cut out, extruded across the
 *    width with a rounded bevel, so a highlight runs along every edge;
 *  - between them the cabin is open: a floor and a sill carry the DOORS, which
 *    are separate panels hinged at their front edge, each with its own glass,
 *    so a door opens and the person getting out is actually seen;
 *  - above the waist the greenhouse is a roof on thin pillars, glazed with a
 *    windscreen, a rear window and quarter lights, so from above the people
 *    inside are visible through the glass;
 *  - inside there are seats, a dashboard and a steering wheel on the driver's
 *    side (the left, in Brazil's right-hand traffic).
 *
 * Geometry is in metres converted to world units, in the vehicle's frame:
 * X forward, Y up, Z to the vehicle's RIGHT, origin on the road under the
 * middle of the body. Everything is merged per material, so a car is five or
 * six instances whatever the detail, and every car of a class shares them.
 */

/** Side of the vehicle a door is on: -1 left (the driver's), +1 right (the kerb's). */
export type DoorSide = -1 | 1;

export interface DoorModel {
  /** Index into the vehicle's door state. */
  readonly index: number;
  readonly side: DoorSide;
  /** Hinge line: along the body and across it, world units. */
  readonly hingeX: number;
  readonly hingeZ: number;
  /** Door length from hinge to trailing edge, world units. */
  readonly length: number;
  /** Seat this door serves (index into `seats`). */
  readonly seat: number;
  /** Painted panel, in the door's own frame (origin on the hinge line, at road level). */
  readonly panel: BufferGeometry;
  /** The door's window, same frame. */
  readonly glass: BufferGeometry;
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
}

/**
 * How far a seated person reaches from their pelvis in the car-seat poses
 * (`riderPoses.ts`), metres at full size: the worst of the 77 adult bodies
 * in the roster, measured on the rig (`docs/audit/seated-pose-extents.json`,
 * `scripts/_extents.mjs`).
 */
export const SEATED_EXTENTS = { top: 0.94, bottom: 0.28, forward: 0.88, back: 0.33, half: 0.26 } as const;

/**
 * The largest size a person may be drawn at in this seat and stay entirely
 * inside the cabin: head under the roof lining, feet above the floor, knees
 * and toes short of the bulkhead, shoulders clear of the door and the next
 * seat. Anybody larger is drawn at this size; nobody is drawn larger than 1.1.
 */
export function seatFitScale(seat: SeatModel): number {
  const metres = (u: number): number => u / M(1);
  return Math.min(1.1,
    (metres(seat.headroom) - 0.02) / SEATED_EXTENTS.top,
    (metres(seat.hipY - seat.floor)) / SEATED_EXTENTS.bottom,
    metres(seat.legroom) / SEATED_EXTENTS.forward,
    metres(seat.sideRoom) / SEATED_EXTENTS.half);
}

export interface VehicleModel {
  /** Painted body, instance colour = paint. */
  readonly shell: BufferGeometry;
  /** Unpainted exterior: bumpers, sills, grille, mirrors' arms, number plate recess. */
  readonly trim: BufferGeometry;
  /** Fixed glazing. */
  readonly glass: BufferGeometry;
  /** Cabin: seats, dashboard, steering wheel, floor. */
  readonly interior: BufferGeometry;
  readonly doors: readonly DoorModel[];
  readonly seats: readonly SeatModel[];
  /** Lamps, as boxes in the vehicle frame: centre and size, world units. */
  readonly headlamps: readonly Lamp[];
  readonly taillamps: readonly Lamp[];
  readonly indicators: readonly (Lamp & { readonly side: DoorSide; readonly front: boolean })[];
}

export interface Lamp {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly sx: number;
  readonly sy: number;
  readonly sz: number;
}

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
  /** Waistline: bottom of the side windows, top of the doors. */
  readonly belt: number;
  /** Door edges along the body: front edge, then the trailing edge of each door. */
  readonly doorEdges: readonly number[];
  /** Blind panels instead of glass behind the last door (a van's load area). */
  readonly blindRear: boolean;
}

const PROFILES: Record<BodyStyle, Profile> = {
  // The windscreen's top edge sits ahead of the front seats and the roof runs
  // back past the rear ones: a seated head is under the roof, never under the
  // glass that slopes down to the bonnet.
  sedan: {
    clearance: 0.1, noseY: 0.44, bonnetY: 0.53,
    screenBase: [0.2, 0.6], screenTop: [0.05, 0.97], roofEnd: [-0.29, 0.98], deck: [-0.38, 0.66],
    tailY: 0.64, belt: 0.6, doorEdges: [0.2, -0.05, -0.27], blindRear: false,
  },
  hatch: {
    clearance: 0.11, noseY: 0.45, bonnetY: 0.55,
    screenBase: [0.21, 0.6], screenTop: [0.06, 0.98], roofEnd: [-0.38, 0.98], deck: [-0.47, 0.62],
    tailY: 0.6, belt: 0.6, doorEdges: [0.21, -0.05, -0.27], blindRear: false,
  },
  suv: {
    clearance: 0.13, noseY: 0.5, bonnetY: 0.62,
    screenBase: [0.22, 0.66], screenTop: [0.08, 0.97], roofEnd: [-0.44, 0.98], deck: [-0.47, 0.6],
    tailY: 0.58, belt: 0.64, doorEdges: [0.22, 0.0, -0.22], blindRear: false,
  },
  van: {
    clearance: 0.1, noseY: 0.36, bonnetY: 0.44,
    screenBase: [0.4, 0.47], screenTop: [0.27, 0.95], roofEnd: [-0.49, 0.98], deck: [-0.5, 0.9],
    tailY: 0.9, belt: 0.5, doorEdges: [0.26, 0.06], blindRear: true,
  },
};

/** Wall thickness of doors and pillars, metres. */
const SKIN = m(0.06);
/** Gap round a door, metres: the shut line that makes it read as a door. */
const SHUT_LINE = m(0.012);

const M = (metres: number): number => m(metres);

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
  const axles = [L * 0.31, -L * 0.31];
  const archR = r + M(0.05);
  const bevel = M(0.07);

  const shellParts: BufferGeometry[] = [];
  const trimParts: BufferGeometry[] = [];
  const glassParts: BufferGeometry[] = [];
  const interiorParts: BufferGeometry[] = [];

  const doorFront = X(p.doorEdges[0]!);
  const doorRear = X(p.doorEdges[p.doorEdges.length - 1]!);
  const screenBase = { x: X(p.screenBase[0]), y: Y(p.screenBase[1]) };
  const screenTop = { x: X(p.screenTop[0]), y: Y(p.screenTop[1]) };
  const roofEnd = { x: X(p.roofEnd[0]), y: Y(p.roofEnd[1]) };
  const deck = { x: X(p.deck[0]), y: Y(p.deck[1]) };
  const belt = Y(p.belt);
  const sill = Y(p.clearance) + M(0.16);
  // The floor pan sits just above the underbody, as low as a real one.
  const floor = Y(p.clearance) + M(0.02);

  // ---- nose: from the door's front edge forward, front arch cut out.
  {
    const s = new Shape();
    const front = L / 2;
    const ax = axles[0]!;
    s.moveTo(doorFront, Y(p.clearance));
    s.lineTo(ax - archR, Y(p.clearance));
    arch(s, ax, r * 0.95, archR);
    s.lineTo(front - M(0.12), Y(p.clearance) + M(0.04));
    s.quadraticCurveTo(front, Y(p.clearance) + M(0.08), front, Y(p.noseY) * 0.55);
    s.lineTo(front, Y(p.noseY));
    s.quadraticCurveTo(front - M(0.03), Y(p.bonnetY), front - M(0.3), Y(p.bonnetY));
    // The bonnet rises gently to the scuttle at the foot of the windscreen.
    s.lineTo(Math.max(screenBase.x, doorFront), Math.min(screenBase.y, belt));
    if (screenBase.x > doorFront) s.lineTo(doorFront, belt);
    s.lineTo(doorFront, Y(p.clearance));
    shellParts.push(extrude(s, W, bevel));
  }

  // ---- tail: from the last door edge back, rear arch cut out.
  {
    const s = new Shape();
    const back = -L / 2;
    const ax = axles[1]!;
    s.moveTo(doorRear, Y(p.clearance));
    s.lineTo(doorRear, p.blindRear ? roofEnd.y - M(0.02) : belt);
    if (p.blindRear) {
      s.lineTo(back + M(0.05), roofEnd.y - M(0.02));
    } else {
      // Waist to the base of the rear window, then the boot lid or hatch.
      s.lineTo(deck.x, deck.y);
      s.lineTo(back + M(0.1), Y(p.tailY));
      s.quadraticCurveTo(back, Y(p.tailY) - M(0.02), back, Y(p.tailY) - M(0.2));
    }
    s.lineTo(back, Y(p.clearance) + M(0.12));
    s.quadraticCurveTo(back, Y(p.clearance), back + M(0.15), Y(p.clearance));
    s.lineTo(ax - archR, Y(p.clearance));
    arch(s, ax, r * 0.95, archR);
    s.lineTo(doorRear, Y(p.clearance));
    shellParts.push(extrude(s, W, bevel));
  }

  // ---- floor and sills between them: the doors close onto these.
  const cabinLength = doorFront - doorRear;
  const cabinMid = (doorFront + doorRear) / 2;
  trimParts.push(box(cabinLength + M(0.02), sill - Y(p.clearance), W - M(0.02), cabinMid, (sill + Y(p.clearance)) / 2, 0));
  interiorParts.push(box(cabinLength, M(0.04), W - SKIN * 2, cabinMid, floor, 0));

  // ---- greenhouse: pillars and roof in paint, glass between.
  const roofSkin = M(0.03);
  const inset = M(0.1); // the greenhouse tucks in from the body sides
  const gw = W - inset * 2;
  // Roof slab, following the roof line.
  {
    const s = new Shape();
    s.moveTo(screenTop.x, screenTop.y - roofSkin);
    s.lineTo(screenTop.x + M(0.02), screenTop.y);
    s.lineTo(roofEnd.x, roofEnd.y);
    s.lineTo(roofEnd.x - M(0.02), roofEnd.y - roofSkin);
    s.lineTo(screenTop.x, screenTop.y - roofSkin);
    shellParts.push(extrude(s, gw, M(0.035)));
  }
  // Pillars: A (along the windscreen's edge), B (between the doors), C / D.
  for (const side of [-1, 1] as const) {
    const z = side * (gw / 2 - M(0.04));
    shellParts.push(strut(screenBase.x, belt, screenTop.x, screenTop.y - roofSkin * 0.5, z, M(0.07), M(0.08)));
    for (let i = 1; i < p.doorEdges.length - 1; i++) {
      const x = X(p.doorEdges[i]!);
      shellParts.push(strut(x, belt, x + (screenTop.x - screenBase.x) * 0.05, roofAt(x) - roofSkin * 0.5, z, M(0.08), M(0.08)));
    }
    if (!p.blindRear) {
      shellParts.push(strut(deck.x, deck.y, roofEnd.x, roofEnd.y - roofSkin * 0.5, z, M(0.1), M(0.1)));
    }
  }
  /** Height of the roof line over `x`: up the windscreen, along the roof, down the rear window. */
  function roofAt(x: number): number {
    const lerp = (x0: number, y0: number, x1: number, y1: number): number => {
      const t = Math.min(1, Math.max(0, (x - x0) / (Math.abs(x1 - x0) < 1e-6 ? 1e-6 : x1 - x0)));
      return y0 + (y1 - y0) * t;
    };
    if (x >= screenTop.x) return lerp(screenBase.x, screenBase.y, screenTop.x, screenTop.y);
    if (x >= roofEnd.x) return lerp(screenTop.x, screenTop.y, roofEnd.x, roofEnd.y);
    return p.blindRear ? roofEnd.y : lerp(roofEnd.x, roofEnd.y, deck.x, deck.y);
  }

  // Windscreen and rear window.
  glassParts.push(quadAcross(screenBase.x - M(0.02), belt + M(0.01), screenTop.x + M(0.01), screenTop.y - roofSkin, gw - M(0.1)));
  if (!p.blindRear) {
    glassParts.push(quadAcross(deck.x + M(0.02), deck.y + M(0.01), roofEnd.x - M(0.01), roofEnd.y - roofSkin, gw - M(0.16)));
  }
  // Quarter lights behind the last door, or blind panels on a van.
  for (const side of [-1, 1] as const) {
    const z = side * (gw / 2 - M(0.02));
    if (p.blindRear) {
      const s = new Shape();
      s.moveTo(doorRear, belt - M(0.02));
      s.lineTo(-L / 2 + M(0.06), belt - M(0.02));
      s.lineTo(-L / 2 + M(0.06), roofEnd.y - roofSkin);
      s.lineTo(doorRear, roofAt(doorRear) - roofSkin);
      shellParts.push(extrude(s, M(0.05), 0, side * (halfW - M(0.05))));
    } else if (deck.x < doorRear - M(0.12)) {
      glassParts.push(pane([
        [doorRear - M(0.04), belt + M(0.02)],
        [deck.x + M(0.06), deck.y + M(0.02)],
        [Math.max(roofEnd.x, deck.x) + M(0.08), roofAt(Math.max(roofEnd.x, deck.x) + M(0.08)) - roofSkin - M(0.02)],
        [doorRear - M(0.04), roofAt(doorRear) - roofSkin - M(0.02)],
      ], z));
    }
  }

  // ---- doors: one or two a side, hinged at the front edge.
  const doors: DoorModel[] = [];
  const seats: SeatModel[] = [];
  const edges = p.doorEdges.map(X);
  for (const side of [-1, 1] as const) {
    for (let i = 0; i < edges.length - 1; i++) {
      const x0 = edges[i]! - SHUT_LINE * 2;
      const x1 = edges[i + 1]! + SHUT_LINE * 2;
      const hingeZ = side * (halfW - SKIN / 2);
      // Panel: sill to waist, drawn relative to the hinge (x0).
      const panelShape = new Shape();
      panelShape.moveTo(0, sill - M(0.01));
      panelShape.lineTo(x1 - x0, sill - M(0.01));
      panelShape.lineTo(x1 - x0, belt);
      panelShape.lineTo(0, belt);
      panelShape.lineTo(0, sill - M(0.01));
      const panel = extrude(panelShape, SKIN, M(0.02));
      // Window frame and glass: waist to the roof line, the leading edge
      // following the A-pillar on a front door.
      const leadX = i === 0 ? Math.min(0, screenTop.x - x0 + M(0.06)) : 0;
      const topFront = roofAt(x0 + leadX) - roofSkin;
      const topBack = roofAt(x1) - roofSkin;
      const glass = pane([
        [leadX === 0 ? -M(0.02) : -M(0.03), belt + M(0.015)],
        [x1 - x0 - M(0.03), belt + M(0.015)],
        [x1 - x0 - M(0.03), topBack - M(0.03)],
        [leadX, topFront - M(0.03)],
      ], 0);
      // The leaf is modelled with its hinge at the origin and its body running
      // BACKWARDS (negative X, since x1 < x0), which is how it swings open.
      // Pull the glass in to the line of the greenhouse.
      glass.translate(0, 0, -side * (halfW - gw / 2 - M(0.02)));
      const seatIndex = seats.length;
      doors.push({ index: doors.length, side, hingeX: x0, hingeZ, length: x0 - x1, seat: seatIndex, panel, glass });
      // Door handle and, on a front door, the mirror.
      trimParts.push(box(M(0.14), M(0.03), M(0.03), (x0 + x1) / 2 - M(0.1), belt - M(0.12), side * (halfW + M(0.005))));
      if (i === 0) {
        trimParts.push(box(M(0.08), M(0.1), M(0.18), screenBase.x - M(0.08), belt + M(0.06), side * (halfW + M(0.08))));
        shellParts.push(box(M(0.12), M(0.12), M(0.16), screenBase.x - M(0.12), belt + M(0.08), side * (halfW + M(0.16))));
      }
      // The seat this door gives on to.
      // The hip point sits a little ahead of the door's trailing edge, which
      // puts the reclined head under the roof and leaves the legs room under
      // the dashboard or the seat in front.
      const seatX = x1 + Math.max(M(0.22), (x0 - x1) * 0.2);
      const seatZ = side * (gw / 2 - M(0.42));
      const hipY = floor + M(0.3);
      // Legs reach under the dashboard to the bulkhead, or under the front
      // seat from the back
      // (the footwell runs forward between the front wheel arches, to about
      // the line of the front axle).
      const ahead = i === 0 ? Math.max(doorFront, axles[0]! - M(0.1)) - seatX : x0 + M(0.3) - seatX;
      // The head sits back from the hip (a reclined seat), where the roof
      // may already be sloping down to the rear window.
      let lining = Infinity;
      for (let dx = -M(0.28); dx <= M(0.06); dx += M(0.02)) lining = Math.min(lining, roofAt(seatX + dx) - roofSkin);
      seats.push({
        x: seatX, z: seatZ, hipY,
        headroom: lining - hipY,
        legroom: ahead,
        floor: floor + M(0.02),
        sideRoom: Math.min(gw / 2 - Math.abs(seatZ), Math.abs(seatZ)),
        driver: side === -1 && i === 0,
      });
      interiorParts.push(...seatGeometry(seatX, seatZ, floor, i === 0));
    }
  }

  // Dashboard and steering wheel.
  interiorParts.push(box(M(0.36), M(0.22), gw - M(0.14), screenBase.x - M(0.12), belt - M(0.06), 0));
  const driverSeat = seats.find((s) => s.driver);
  if (driverSeat) {
    const wheel = new TorusGeometry(M(0.19), M(0.025), 6, 14);
    wheel.rotateY(Math.PI / 2);
    wheel.rotateZ(-0.45);
    // Where the driving pose puts the hands (`riderPoses.ts`), at a typical seated size.
    wheel.translate(driverSeat.x + M(0.37), driverSeat.hipY + M(0.28), driverSeat.z);
    interiorParts.push(wheel);
  }

  // Bumpers, grille, number plate recesses, side skirts.
  trimParts.push(box(M(0.14), Y(p.noseY) * 0.35, W - M(0.06), L / 2 - M(0.05), Y(p.clearance) + Y(p.noseY) * 0.2, 0));
  trimParts.push(box(M(0.14), Y(p.noseY) * 0.32, W - M(0.06), -L / 2 + M(0.05), Y(p.clearance) + Y(p.noseY) * 0.2, 0));
  trimParts.push(box(M(0.04), Y(p.noseY) * 0.22, W * 0.46, L / 2 + M(0.005), Y(p.noseY) * 0.72, 0));

  const lampY = Y(p.noseY) * 0.86;
  const tailY = p.blindRear ? Y(p.clearance) + M(0.55) : Y(p.tailY) - M(0.16);
  const headlamps: Lamp[] = [];
  const taillamps: Lamp[] = [];
  const indicators: (Lamp & { side: DoorSide; front: boolean })[] = [];
  for (const side of [-1, 1] as const) {
    headlamps.push({ x: L / 2 - M(0.02), y: lampY, z: side * W * 0.34, sx: M(0.06), sy: M(0.1), sz: W * 0.2 });
    taillamps.push({ x: -L / 2 + M(0.02), y: tailY, z: side * W * 0.36, sx: M(0.06), sy: p.blindRear ? M(0.3) : M(0.11), sz: W * 0.16 });
    indicators.push({ x: L / 2 - M(0.02), y: lampY, z: side * W * 0.46, sx: M(0.06), sy: M(0.07), sz: W * 0.06, side, front: true });
    indicators.push({ x: -L / 2 + M(0.02), y: tailY + M(0.12), z: side * W * 0.42, sx: M(0.06), sy: M(0.06), sz: W * 0.08, side, front: false });
  }

  return {
    shell: merge(shellParts),
    trim: merge(trimParts),
    glass: merge(glassParts),
    interior: merge(interiorParts),
    doors,
    seats,
    headlamps,
    taillamps,
    indicators,
  };
}

// ------------------------------------------------------------------ helpers

/** Cuts a wheel arch into a profile running rear to front along its bottom edge. */
function arch(s: Shape, centreX: number, centreY: number, radius: number): void {
  // From the arch's rear foot, over the top, to its front foot.
  const steps = 10;
  for (let i = 0; i <= steps; i++) {
    const a = Math.PI - (Math.PI * i) / steps;
    s.lineTo(centreX + Math.cos(a) * radius, Math.max(centreY + Math.sin(a) * radius, 0) + (i === 0 || i === steps ? 0 : 0));
  }
}

/** Extrudes a side profile across the body, centred on Z (or on `z`). */
function extrude(s: Shape, width: number, bevel: number, z = 0): BufferGeometry {
  const depth = Math.max(1e-3, width - bevel * 2);
  const g = new ExtrudeGeometry(s, {
    depth,
    bevelEnabled: bevel > 0,
    bevelThickness: bevel,
    bevelSize: bevel * 0.8,
    // Rounded INTO the outline rather than grown out of it, so a profile's
    // wheel arch and ground clearance are the sizes they were drawn at.
    bevelOffset: -bevel * 0.8,
    bevelSegments: bevel > 0 ? 3 : 0,
    curveSegments: 8,
  });
  g.translate(0, 0, -depth / 2 + z);
  return g;
}

function box(sx: number, sy: number, sz: number, x: number, y: number, z: number): BufferGeometry {
  return new BoxGeometry(sx, sy, sz).translate(x, y, z);
}

/** A bar from (x0, y0) to (x1, y1) at `z`, `wide` along the body and `deep` across it. */
function strut(x0: number, y0: number, x1: number, y1: number, z: number, wide: number, deep: number): BufferGeometry {
  const length = Math.hypot(x1 - x0, y1 - y0);
  const g = new BoxGeometry(wide, length, deep);
  g.rotateZ(-Math.atan2(x1 - x0, y1 - y0));
  g.translate((x0 + x1) / 2, (y0 + y1) / 2, z);
  return g;
}

/** A pane spanning the width, from one edge line (x0, y0) to another (x1, y1). */
function quadAcross(x0: number, y0: number, x1: number, y1: number, width: number): BufferGeometry {
  const hw = width / 2;
  const g = new BufferGeometry();
  const v = [x0, y0, -hw, x0, y0, hw, x1, y1, hw, x1, y1, -hw];
  g.setAttribute('position', new Float32BufferAttribute(v, 3));
  g.setIndex([0, 2, 1, 0, 3, 2]);
  g.computeVertexNormals();
  return g;
}

/** A flat pane in the X-Y plane at `z`, from a polygon, both faces. */
function pane(points: readonly (readonly [number, number])[], z: number): BufferGeometry {
  const s = new Shape(points.map(([x, y]) => new Vector2(x, y)));
  return extrude(s, M(0.012), 0, z);
}

/** A seat: cushion and backrest (bench width at the back). */
function seatGeometry(x: number, z: number, floor: number, front: boolean): BufferGeometry[] {
  const w = M(0.5);
  const cushion = box(M(0.5), M(0.12), w, x + M(0.08), floor + M(0.22), z);
  const back = new BoxGeometry(M(0.12), M(0.6), w);
  back.rotateZ(0.22);
  back.translate(x - M(0.22), floor + M(0.55), z);
  const parts = [cushion, back];
  if (front) {
    const rest = box(M(0.1), M(0.14), M(0.26), x - M(0.28), floor + M(0.92), z);
    parts.push(rest);
  }
  return parts;
}

/** Merges parts, keeping only the attributes they all share. */
function merge(parts: BufferGeometry[]): BufferGeometry {
  const ready = parts.map((g) => {
    const n = g.index ? g.toNonIndexed() : g;
    for (const name of Object.keys(n.attributes)) {
      if (name !== 'position' && name !== 'normal') n.deleteAttribute(name);
    }
    return n;
  });
  const merged = mergeGeometries(ready, false);
  for (const g of parts) g.dispose();
  if (!merged) throw new Error('vehicle model: parts could not be merged');
  return merged;
}

// ------------------------------------------------------------------ wheels

/** A tyre with a rounded shoulder, axis along Z, unit diameter. */
export function tyreGeometry(): BufferGeometry {
  const pts: Vector2[] = [];
  const steps = 6;
  for (let i = 0; i <= steps; i++) {
    const a = -Math.PI / 2 + (Math.PI * i) / steps;
    pts.push(new Vector2(0.4 + Math.cos(a) * 0.1, Math.sin(a) * 0.5));
  }
  pts.unshift(new Vector2(0.3, -0.5));
  pts.push(new Vector2(0.3, 0.5));
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
  {
    const s = new Shape();
    s.moveTo(headX - M(0.05), M(0.8));
    s.lineTo(headX - M(0.02), M(0.95));
    s.quadraticCurveTo(headX - M(0.2), M(1.02), headX - M(0.5), M(0.9));
    s.lineTo(headX - M(0.55), M(0.78));
    s.lineTo(headX - M(0.05), M(0.8));
    body.push(extrude(s, M(0.32), M(0.06)));
  }
  // Tail cowl behind the seat, and a belly fairing.
  {
    const s = new Shape();
    s.moveTo(-M(0.2), M(0.8));
    s.lineTo(-M(0.25), M(0.88));
    s.lineTo(rear - M(0.05), M(0.93));
    s.lineTo(rear + M(0.02), M(0.82));
    s.lineTo(-M(0.2), M(0.8));
    body.push(extrude(s, M(0.24), M(0.04)));
  }
  // Frame spine from the head to the swingarm pivot.
  body.push(strut(headX, headY - M(0.05), -M(0.15), M(0.45), 0, M(0.07), M(0.08)));
  // Seat.
  trim.push(box(M(0.62), M(0.08), M(0.3), -M(0.22), M(0.84), 0));
  // Engine block and cylinder, exhaust along the right side.
  trim.push(box(M(0.46), M(0.34), M(0.3), M(0.02), M(0.47), 0));
  trim.push(new CylinderGeometry(M(0.045), M(0.05), L * 0.55, 8).rotateZ(Math.PI / 2 + 0.12).translate(-L * 0.12, M(0.32), M(0.18)));
  // Swingarm to the rear axle, and the rear mudguard.
  trim.push(strut(-M(0.12), M(0.42), rear, r, M(0.1), M(0.05), M(0.05)));
  trim.push(strut(-M(0.12), M(0.42), rear, r, -M(0.1), M(0.05), M(0.05)));
  trim.push(box(M(0.3), M(0.03), M(0.16), rear + M(0.05), r + M(0.36), 0));
  // Steering: fork legs down to the front axle, bars, headlamp nacelle,
  // front mudguard - modelled about the steering head.
  const steering: BufferGeometry[] = [];
  const dx = front - headX;
  const dy = r - headY;
  for (const side of [-1, 1] as const) {
    steering.push(strut(0, 0, dx, dy, side * M(0.09), M(0.05), M(0.05)));
  }
  steering.push(box(M(0.05), M(0.05), M(0.72), -M(0.08), M(0.12), 0));
  steering.push(box(M(0.1), M(0.06), M(0.06), -M(0.08), M(0.14), M(0.34)));
  steering.push(box(M(0.1), M(0.06), M(0.06), -M(0.08), M(0.14), -M(0.34)));
  steering.push(box(M(0.14), M(0.16), M(0.2), M(0.08), -M(0.02), 0));
  steering.push(box(M(0.36), M(0.03), M(0.14), dx - M(0.02), dy + r + M(0.06), 0));
  return {
    body: merge(body),
    trim: merge(trim),
    steering: merge(steering),
    headX,
    headY,
    cranks: null,
    bracketX: 0,
    bracketY: 0,
    seatX: -M(0.2),
    seatY: M(0.78),
    headlamp: { x: headX + M(0.16), y: headY - M(0.02), z: 0, sx: M(0.04), sy: M(0.12), sz: M(0.14) },
    taillamp: { x: rear - M(0.06), y: M(0.9), z: 0, sx: M(0.03), sy: M(0.06), sz: M(0.14) },
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
  trim.push(box(M(0.26), M(0.05), M(0.14), seatTop.x - M(0.02), M(0.99), 0));
  trim.push(box(M(0.34), M(0.02), M(0.14), rear + M(0.05), r + M(0.36), 0));
  // Steering: fork, stem and a flat bar.
  const steering: BufferGeometry[] = [];
  for (const side of [-1, 1] as const) {
    steering.push(strut(0, 0, front - headX, r - headY, side * M(0.05), tube * 0.8, tube * 0.8));
  }
  steering.push(strut(0, 0, -M(0.04), M(0.14), 0, tube, tube));
  steering.push(box(M(0.03), M(0.03), M(0.56), -M(0.06), M(0.15), 0));
  // Cranks and pedals about the bottom bracket: two arms, opposite.
  const cranks: BufferGeometry[] = [];
  for (const side of [-1, 1] as const) {
    const arm = new BoxGeometry(M(0.17), M(0.025), M(0.02)).translate(side * M(0.085), 0, side * M(0.09));
    cranks.push(arm);
    cranks.push(box(M(0.1), M(0.02), M(0.09), side * M(0.17), 0, side * M(0.13)));
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
    seatX: seatTop.x - M(0.02),
    seatY: M(0.95),
    headlamp: { x: headX + M(0.06), y: headY - M(0.08), z: 0, sx: M(0.03), sy: M(0.05), sz: M(0.06) },
    taillamp: { x: rear - M(0.02), y: r + M(0.38), z: 0, sx: M(0.02), sy: M(0.04), sz: M(0.08) },
  };
}

// ------------------------------------------------------------------ bus and truck

/**
 * A city bus: a long box with rounded ends, a glazed band down both sides, a
 * raked windscreen, two doors on the kerb side, and rows of seats that can be
 * seen through the side glass. Built in the same frame and merged the same way
 * as a car. `doors` is empty: the bus doors are drawn as darker glazed leaves,
 * since nobody boards at the kerb here yet.
 */
export function buildBusModel(a: Archetype): VehicleModel {
  const L = a.length;
  const W = a.width;
  const H = a.height;
  const r = a.wheelRadius;
  const axles = [L * 0.37, -L * 0.21, -L * 0.34];
  const archR = r + M(0.06);
  const floor = M(0.4);
  const belt = H * 0.42;
  const roof = H * 0.93;
  const shell: BufferGeometry[] = [];
  const trim: BufferGeometry[] = [];
  const glass: BufferGeometry[] = [];
  const interior: BufferGeometry[] = [];
  // Lower body with its arches.
  {
    const s = new Shape();
    const front = L / 2;
    const back = -L / 2;
    s.moveTo(back + M(0.1), M(0.3));
    for (const ax of [...axles].sort((p, q) => p - q)) {
      s.lineTo(ax - archR, M(0.3));
      arch(s, ax, r, archR);
    }
    s.lineTo(front - M(0.1), M(0.3));
    s.quadraticCurveTo(front, M(0.3), front, M(0.5));
    s.lineTo(front, belt);
    s.lineTo(back, belt);
    s.lineTo(back, M(0.45));
    s.quadraticCurveTo(back, M(0.3), back + M(0.1), M(0.3));
    shell.push(extrude(s, W, M(0.08)));
  }
  // Roof cap with rounded ends.
  {
    const s = new Shape();
    s.moveTo(L / 2 - M(0.25), roof - M(0.25));
    s.quadraticCurveTo(L / 2 - M(0.2), H, L / 2 - M(0.6), H);
    s.lineTo(-L / 2 + M(0.3), H);
    s.quadraticCurveTo(-L / 2, H, -L / 2, roof - M(0.15));
    s.lineTo(L / 2 - M(0.25), roof - M(0.25));
    shell.push(extrude(s, W, M(0.08)));
  }
  // Window pillars down both sides, and the rear panel.
  const bays = Math.max(4, Math.round(L / M(1.3)));
  for (const side of [-1, 1] as const) {
    for (let i = 0; i <= bays; i++) {
      const x = -L / 2 + M(0.15) + ((L - M(0.6)) * i) / bays;
      shell.push(box(M(0.1), roof - belt, M(0.06), x, (roof + belt) / 2, side * (W / 2 - M(0.03))));
    }
    glass.push(pane([[-L / 2 + M(0.15), belt + M(0.04)], [L / 2 - M(0.35), belt + M(0.04)],
      [L / 2 - M(0.35), roof - M(0.08)], [-L / 2 + M(0.15), roof - M(0.08)]], side * (W / 2 - M(0.035))));
  }
  shell.push(box(M(0.08), roof - belt, W - M(0.1), -L / 2 + M(0.05), (roof + belt) / 2, 0));
  // Windscreen, raked a little.
  glass.push(quadAcross(L / 2 - M(0.02), belt, L / 2 - M(0.2), roof - M(0.2), W - M(0.2)));
  // Doors on the kerb side (+Z), front and middle: a glazed leaf each, hung
  // at its front edge, opened at a stop (`kerbStops.ts`). Boarding at the
  // front, alighting at the middle, as Brazilian city buses do.
  const doors: DoorModel[] = [];
  for (const [index, centre] of [[0, L / 2 - M(0.9)], [1, -M(0.3)]] as const) {
    const length = M(1.1);
    const hingeX = centre + length / 2;
    const leaf = new Shape();
    leaf.moveTo(0, M(0.42));
    leaf.lineTo(-length, M(0.42));
    leaf.lineTo(-length, roof - M(0.05));
    leaf.lineTo(0, roof - M(0.05));
    leaf.lineTo(0, M(0.42));
    const frame = extrude(leaf, M(0.05), M(0.01));
    const pane = new BoxGeometry(length - M(0.16), roof - M(0.62), M(0.02))
      .translate(-length / 2, (roof + M(0.37)) / 2, M(0.02));
    doors.push({ index, side: 1, hingeX, hingeZ: W / 2 - M(0.02), length, seat: -1, panel: frame, glass: pane });
  }
  trim.push(box(M(0.12), M(0.3), W, L / 2, M(0.45), 0));
  trim.push(box(M(0.12), M(0.3), W, -L / 2, M(0.45), 0));
  // Inside: a floor and rows of seats either side of the aisle.
  interior.push(box(L - M(0.4), M(0.05), W - M(0.2), 0, floor, 0));
  const seats: SeatModel[] = [];
  const driverX = L / 2 - M(1.2);
  interior.push(...seatGeometry(driverX, -W * 0.25, floor, true));
  seats.push({ x: driverX, z: -W * 0.25, hipY: floor + M(0.3), headroom: roof - floor - M(0.35), legroom: M(0.95),
    floor: floor + M(0.025), sideRoom: W * 0.25, driver: true });
  for (let row = 0; row < 3; row++) {
    const x = L * (0.18 - row * 0.2);
    for (const side of [-1, 1] as const) {
      const z = side * W * 0.27;
      interior.push(...seatGeometry(x, z, floor, false));
      seats.push({ x, z, hipY: floor + M(0.3), headroom: roof - floor - M(0.3), legroom: M(0.9),
        floor: floor + M(0.025), sideRoom: W * 0.23, driver: false });
    }
  }
  return {
    shell: merge(shell), trim: merge(trim), glass: merge(glass), interior: merge(interior),
    doors, seats, ...heavyLamps(L, W, M(0.6), M(0.7)),
  };
}

/**
 * A rigid truck: a cab with a raked windscreen and doors, and a box body on a
 * dark chassis with the rear axles under it.
 */
export function buildTruckModel(a: Archetype): VehicleModel {
  const L = a.length;
  const W = a.width;
  const H = a.height;
  const r = a.wheelRadius;
  const cabLength = L * a.cabinFraction;
  const cabFront = L / 2;
  const cabBack = cabFront - cabLength;
  const shell: BufferGeometry[] = [];
  const trim: BufferGeometry[] = [];
  const glass: BufferGeometry[] = [];
  const interior: BufferGeometry[] = [];
  const cabTop = H * 0.8;
  const belt = H * 0.47;
  const axleF = L * 0.37;
  const truckDoors: DoorModel[] = [];
  {
    const s = new Shape();
    s.moveTo(cabBack, M(0.6));
    s.lineTo(axleF - r - M(0.08), M(0.6));
    arch(s, axleF, r, r + M(0.08));
    s.lineTo(cabFront, M(0.6));
    s.lineTo(cabFront, belt);
    s.lineTo(cabFront - M(0.05), belt + M(0.02));
    s.lineTo(cabBack, belt + M(0.02));
    s.lineTo(cabBack, M(0.6));
    shell.push(extrude(s, W, M(0.08)));
  }
  // Cab roof and pillars, glazed in between.
  shell.push(box(cabLength - M(0.3), M(0.12), W - M(0.06), cabBack + (cabLength - M(0.3)) / 2, cabTop, 0));
  for (const side of [-1, 1] as const) {
    shell.push(strut(cabFront - M(0.05), belt, cabFront - M(0.3), cabTop, side * (W / 2 - M(0.05)), M(0.1), M(0.1)));
    shell.push(box(M(0.12), cabTop - belt, M(0.08), cabBack + M(0.06), (cabTop + belt) / 2, side * (W / 2 - M(0.04))));
    // The cab door: a panel from the step to the waist, and its window,
    // hinged at the front of the cab behind the wheel arch.
    const hingeX = cabFront - M(0.3);
    const length = cabLength - M(0.45);
    const panelShape = new Shape();
    panelShape.moveTo(0, M(0.62));
    panelShape.lineTo(-length, M(0.62));
    panelShape.lineTo(-length, belt);
    panelShape.lineTo(0, belt);
    panelShape.lineTo(0, M(0.62));
    const doorGlass = pane([[-M(0.04), belt + M(0.03)], [-length + M(0.03), belt + M(0.03)],
      [-length + M(0.03), cabTop - M(0.08)], [-M(0.1), cabTop - M(0.08)]], 0);
    truckDoors.push({ index: truckDoors.length, side, hingeX, hingeZ: side * (W / 2 - M(0.03)), length,
      seat: side === -1 ? 0 : 1, panel: extrude(panelShape, M(0.06), M(0.015)), glass: doorGlass });
    glass.push(pane([[cabBack + M(0.12), belt + M(0.03)], [hingeX - length, belt + M(0.03)],
      [hingeX - length, cabTop - M(0.06)], [cabBack + M(0.12), cabTop - M(0.06)]], side * (W / 2 - M(0.03))));
    trim.push(box(M(0.1), M(0.36), M(0.06), cabFront - M(0.25), belt + M(0.3), side * (W / 2 + M(0.2))));
  }
  glass.push(quadAcross(cabFront - M(0.03), belt + M(0.02), cabFront - M(0.3), cabTop - M(0.05), W - M(0.2)));
  // Chassis rails, box body, bumper and grille.
  trim.push(box(L - M(0.2), M(0.25), W * 0.7, -M(0.1), M(0.62), 0));
  const boxLength = L - cabLength - M(0.25);
  shell.push(box(boxLength, H - M(0.95), W, cabBack - M(0.2) - boxLength / 2, (H + M(0.95)) / 2, 0));
  trim.push(box(M(0.14), M(0.32), W, cabFront + M(0.02), M(0.55), 0));
  trim.push(box(M(0.04), M(0.5), W * 0.6, cabFront + M(0.01), belt - M(0.35), 0));
  const seats: SeatModel[] = [];
  const seatX = cabBack + cabLength * 0.4;
  for (const side of [-1, 1] as const) {
    const z = side * W * 0.24;
    interior.push(...seatGeometry(seatX, z, M(1.0), side === -1));
    seats.push({ x: seatX, z, hipY: M(1.29), headroom: cabTop - M(0.06) - M(1.29), legroom: M(0.9),
      floor: M(1.0), sideRoom: W * 0.24, driver: side === -1 });
  }
  interior.push(box(M(0.3), M(0.3), W - M(0.2), cabFront - M(0.35), belt - M(0.05), 0));
  return {
    shell: merge(shell), trim: merge(trim), glass: merge(glass), interior: merge(interior),
    doors: truckDoors, seats, ...heavyLamps(L, W, M(0.75), M(0.7)),
  };
}

function heavyLamps(L: number, W: number, headY: number, tailY: number) {
  const headlamps: Lamp[] = [];
  const taillamps: Lamp[] = [];
  const indicators: (Lamp & { side: DoorSide; front: boolean })[] = [];
  for (const side of [-1, 1] as const) {
    headlamps.push({ x: L / 2 + M(0.02), y: headY, z: side * W * 0.36, sx: M(0.04), sy: M(0.14), sz: W * 0.16 });
    taillamps.push({ x: -L / 2 - M(0.01), y: tailY, z: side * W * 0.38, sx: M(0.04), sy: M(0.2), sz: W * 0.12 });
    indicators.push({ x: L / 2 + M(0.02), y: headY + M(0.2), z: side * W * 0.44, sx: M(0.04), sy: M(0.08), sz: W * 0.06, side, front: true });
    indicators.push({ x: -L / 2 - M(0.01), y: tailY + M(0.25), z: side * W * 0.44, sx: M(0.04), sy: M(0.08), sz: W * 0.06, side, front: false });
  }
  return { headlamps, taillamps, indicators };
}

/**
 * The body with every door shut, as one painted and one glazed geometry.
 *
 * A car whose doors are all closed - nearly every car, nearly all the time -
 * is then two instances instead of ten, which is most of the per-vehicle cost
 * of the fleet at a city-wide zoom. The separate door leaves are drawn only
 * while a door actually moves.
 */
export function closedBody(model: VehicleModel): { shell: BufferGeometry; glass: BufferGeometry } {
  const shell = [model.shell.clone(), ...model.doors.map((d) => d.panel.clone().translate(d.hingeX, 0, d.hingeZ))];
  const glass = [model.glass.clone(), ...model.doors.map((d) => d.glass.clone().translate(d.hingeX, 0, d.hingeZ))];
  return { shell: merge(shell), glass: merge(glass) };
}
