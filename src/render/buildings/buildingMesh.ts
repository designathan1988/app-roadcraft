import {
  BufferGeometry,
  Color,
  Float32BufferAttribute,
  Group,
  InstancedMesh,
  Mesh,
  Uint32BufferAttribute,
} from 'three';

import { m } from '@world/units';
import {
  type Entrance,
  type Foundation,
  type GroundAt,
  type PavedAt,
  STEP_RUN,
  foundationOf,
} from '@world/buildings/foundation';
import {
  type FacadeBay,
  SAWTOOTH_PITCH,
  SHED_PITCH,
  SIDE_NORMAL,
  GABLE_PITCH,
  bayWidth,
  coveredSpans,
  exposedParts,
  facadeBays,
  levelElevation,
  levelHeight,
  roofRise,
  sawtoothRun,
  sideLength,
  sideStart,
  volumeHeight,
} from '@world/buildings/geometry';
import {
  type Finish,
  type MaterialSpec,
  FINISHES,
  paletteOf,
  plinthMaterial,
  roofMaterial,
  trimMaterial,
  wallMaterial,
} from '@world/buildings/materials';
import { type BayComponent, type Building, type Side, type Volume, SIDES, volumeTop } from '@world/buildings/types';
import { type BuildingKit, PART_KINDS, type PartKind } from './kit';

/**
 * Buildings, as meshes. See docs/buildings.md section 5.
 *
 * ONE merged, vertex-coloured shell for every building passed in - walls with
 * real openings and reveals, plinths, storey bands, parapets, roofs, steps,
 * lift overruns - and one instanced batch per component part, shared by every
 * building. Built behind the renderer's revision gate, never in a draw call.
 */

export interface BuildingMeshes {
  readonly group: Group;
  readonly triangles: number;
  dispose(): void;
}

interface Placement {
  x: number;
  y: number;
  z: number;
  yaw: number;
  sx: number;
  sy: number;
  sz: number;
  colour?: Color;
}

type Rgb = readonly [number, number, number];

/** A surface's colour (linear) and the finish it is drawn with. */
interface Paint {
  readonly rgb: Rgb;
  readonly finish: Finish;
}

const linear = (hex: number, shade = 1): Rgb => {
  const c = new Color().setHex(hex);
  return [c.r * shade, c.g * shade, c.b * shade];
};

const paint = (m: MaterialSpec, shade = 1): Paint => ({ rgb: linear(m.colour, shade), finish: m.finish });

const TERRACE: Paint = paint({ finish: 'stone', colour: 0xb0a595 });
const ARCADE_FLOOR: Paint = paint({ finish: 'stone', colour: 0x9d968a });
const SAW_GLASS: Paint = paint({ finish: 'glass', colour: 0x3c5360 });
const ROOF_PLANT: Paint = paint({ finish: 'concrete', colour: 0x6c6a64 });
const PARAPET_BACK: Paint = paint({ finish: 'concrete', colour: 0x88867f });

// ------------------------------------------------------------------ dimensions
const REVEAL = m(0.2);
const BAND_OUT = m(0.07);
const BAND_H = m(0.22);
const CORNICE_OUT = m(0.16);
const PARAPET_H = m(0.85);
const PARAPET_T = m(0.25);
const EAVES = m(0.35);
const ARCADE = m(1.8);
const PLINTH_GROW = m(0.12);

interface Opening {
  a0: number;
  a1: number;
  h0: number;
  h1: number;
  depth: number;
}

/** The hole a component cuts in its bay, or null for a solid bay. */
function openingOf(component: BayComponent, W: number, H: number): Opening | null {
  let w: number;
  let h0: number;
  let h1: number;
  let depth = REVEAL;
  switch (component) {
    case 'window':
      w = Math.min(W - m(1.1), m(1.5));
      h0 = m(0.9);
      h1 = H - m(0.55);
      break;
    case 'wideWindow':
      w = W - m(0.35);
      h0 = m(0.35);
      h1 = H - m(0.35);
      depth = m(0.12);
      break;
    case 'balcony':
      w = Math.min(W - m(0.9), m(1.7));
      h0 = m(0.02);
      h1 = H - m(0.5);
      break;
    case 'door':
      w = Math.min(W - m(0.9), m(1.3));
      h0 = 0;
      h1 = Math.min(H - m(0.4), m(2.35));
      break;
    case 'shopfront':
      w = W - m(0.3);
      h0 = m(0.35);
      h1 = H - m(0.8);
      depth = m(0.12);
      break;
    case 'loadingDoor':
      w = W - m(0.7);
      h0 = 0;
      h1 = Math.min(H - m(0.6), m(4.5));
      depth = m(0.25);
      break;
    default:
      return null;
  }
  w = Math.max(m(0.4), Math.min(w, W - m(0.2)));
  h1 = Math.max(h0 + m(0.5), Math.min(h1, H - m(0.15)));
  const a0 = (W - w) / 2;
  return { a0, a1: a0 + w, h0, h1, depth };
}

// ------------------------------------------------------------------ shell builder

/** One finish's share of a shell: flat-shaded, vertex-coloured, UV'd triangles. */
class ShellPart {
  readonly position: number[] = [];
  readonly normal: number[] = [];
  readonly colour: number[] = [];
  readonly uv: number[] = [];
  readonly index: number[] = [];
}

/**
 * Triangles in THREE's axes, one buffer set per finish; winding fixed per face.
 *
 * UVs are in WORLD units laid on the face's own plane: along the face
 * horizontally and up it (up the slope, on a roof), so a texture's courses of
 * brick or rows of tiles run level on every wall and every roof. Each finish's
 * material scales them to its tile (`kit.ts`).
 */
class Shell {
  readonly parts = new Map<Finish, ShellPart>();

  /**
   * A planar polygon (3 or 4 world points, x/y map, z up) facing world normal
   * `n`. The winding is measured, never assumed: world y is mirrored into
   * three's z, which flips handedness (AGENTS.md trap: winding).
   */
  face(points: readonly (readonly [number, number, number])[], n: readonly [number, number, number], c: Paint): void {
    let part = this.parts.get(c.finish);
    if (!part) {
      part = new ShellPart();
      this.parts.set(c.finish, part);
    }
    const base = part.position.length / 3;
    const length = Math.hypot(n[0], n[1], n[2]) || 1;
    const wx = n[0] / length;
    const wy = n[1] / length;
    const wz = n[2] / length;
    // The face's own axes, in world: horizontal along it, and up it.
    const flat = Math.hypot(wx, wy);
    const tx = flat > 1e-6 ? -wy / flat : 1;
    const ty = flat > 1e-6 ? wx / flat : 0;
    // n x t: straight up on a wall, up the slope on a roof, +y on a flat.
    const bx = -wz * ty;
    const by = wz * tx;
    const bz = wx * ty - wy * tx;
    const three = points.map(([x, y, z]) => [x, z, -y] as const);
    const nx = wx;
    const ny = wz;
    const nz = -wy;
    points.forEach(([x, y, z], i) => {
      const q = three[i] as readonly [number, number, number];
      part.position.push(q[0], q[1], q[2]);
      part.normal.push(nx, ny, nz);
      part.colour.push(c.rgb[0], c.rgb[1], c.rgb[2]);
      part.uv.push(x * tx + y * ty, x * bx + y * by + z * bz);
    });
    const a = three[0] as readonly [number, number, number];
    const b = three[1] as readonly [number, number, number];
    const d = three[2] as readonly [number, number, number];
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = d[0] - a[0], vy = d[1] - a[1], vz = d[2] - a[2];
    const cx = uy * vz - uz * vy;
    const cy = uz * vx - ux * vz;
    const cz = ux * vy - uy * vx;
    const forward = cx * nx + cy * ny + cz * nz >= 0;
    const tri = (i: number, j: number, k: number): void => {
      if (forward) part.index.push(base + i, base + j, base + k);
      else part.index.push(base + i, base + k, base + j);
    };
    tri(0, 1, 2);
    if (points.length === 4) tri(0, 2, 3);
  }

  get triangles(): number {
    let n = 0;
    for (const part of this.parts.values()) n += part.index.length / 3;
    return n;
  }
}

type V3 = [number, number, number];

/** A face of one bay: its frame in the building's local plan, and its storey. */
interface BayFace {
  /** Local start of the bay on the facade line, its along direction and outward normal. */
  ax: number;
  ay: number;
  tx: number;
  ty: number;
  nx: number;
  ny: number;
  z0: number;
  W: number;
  H: number;
}

/** The frame of a face of `side`, starting `along` units from the side's start. */
function sideFrame(v: Volume, side: Side, along: number): Pick<BayFace, 'ax' | 'ay' | 'tx' | 'ty' | 'nx' | 'ny'> {
  const s = sideStart(v, side);
  const n = SIDE_NORMAL[side];
  return { ax: s.x + s.tx * along, ay: s.y + s.ty * along, tx: s.tx, ty: s.ty, nx: n.x, ny: n.y };
}

// ------------------------------------------------------------------ one building

class Emitter {
  private readonly c: number;
  private readonly s: number;
  readonly parts: Record<PartKind, Placement[]>;

  constructor(
    private readonly b: Building,
    readonly shell: Shell,
    parts: Record<PartKind, Placement[]>,
  ) {
    this.c = Math.cos(b.rotation);
    this.s = Math.sin(b.rotation);
    this.parts = parts;
  }

  /** A local plan point at absolute height z, in world axes. */
  L(lx: number, ly: number, z: number): V3 {
    return [this.b.x + lx * this.c - ly * this.s, this.b.y + lx * this.s + ly * this.c, z];
  }

  /** A local direction as a world normal. */
  N(dx: number, dy: number, dz = 0): V3 {
    return [dx * this.c - dy * this.s, dx * this.s + dy * this.c, dz];
  }

  /** A point on a bay face: `a` along, `h` up, `depth` into the wall. */
  P(f: BayFace, a: number, h: number, depth: number): V3 {
    return this.L(f.ax + f.tx * a - f.nx * depth, f.ay + f.ty * a - f.ny * depth, f.z0 + h);
  }

  /** A rectangle on (or parallel to) a bay face. */
  rect(f: BayFace, a0: number, a1: number, h0: number, h1: number, depth: number, n: V3, c: Paint): void {
    if (a1 - a0 < 1e-4 || h1 - h0 < 1e-4) return;
    this.shell.face([this.P(f, a0, h0, depth), this.P(f, a1, h0, depth), this.P(f, a1, h1, depth), this.P(f, a0, h1, depth)], n, c);
  }

  /** An axis-aligned box in the local plan: sides and top (the bottom is never seen). */
  box(x0: number, y0: number, x1: number, y1: number, z0: number, z1: number, c: Paint, top: Paint = c): void {
    if (z1 - z0 < 1e-4) return;
    const sh = this.shell;
    sh.face([this.L(x0, y0, z0), this.L(x1, y0, z0), this.L(x1, y0, z1), this.L(x0, y0, z1)], this.N(0, -1), c);
    sh.face([this.L(x1, y1, z0), this.L(x0, y1, z0), this.L(x0, y1, z1), this.L(x1, y1, z1)], this.N(0, 1), c);
    sh.face([this.L(x1, y0, z0), this.L(x1, y1, z0), this.L(x1, y1, z1), this.L(x1, y0, z1)], this.N(1, 0), c);
    sh.face([this.L(x0, y1, z0), this.L(x0, y0, z0), this.L(x0, y0, z1), this.L(x0, y1, z1)], this.N(-1, 0), c);
    sh.face([this.L(x0, y0, z1), this.L(x1, y0, z1), this.L(x1, y1, z1), this.L(x0, y1, z1)], [0, 0, 1], top);
  }

  /** A horizontal strip at height h, from depth d0 to d1 into the wall. */
  strip(f: BayFace, a0: number, a1: number, h: number, d0: number, d1: number, n: V3, c: Paint): void {
    this.shell.face([this.P(f, a0, h, d0), this.P(f, a1, h, d0), this.P(f, a1, h, d1), this.P(f, a0, h, d1)], n, c);
  }

  /** A vertical strip across the wall's thickness at `a`, from h0 to h1. */
  jamb(f: BayFace, a: number, h0: number, h1: number, d0: number, d1: number, n: V3, c: Paint): void {
    this.shell.face([this.P(f, a, h0, d0), this.P(f, a, h0, d1), this.P(f, a, h1, d1), this.P(f, a, h1, d0)], n, c);
  }

  /** An instance placed on a bay face, turned so its local +Z is the face's outward normal. */
  put(kind: PartKind, f: BayFace, a: number, h: number, depth: number, sx: number, sy: number, sz: number, colour?: Color): void {
    const p = this.P(f, a, h, depth);
    const n = this.N(f.nx, f.ny);
    const placement: Placement = { x: p[0], y: p[1], z: p[2], yaw: Math.atan2(n[0], -n[1]), sx, sy, sz };
    if (colour) placement.colour = colour;
    this.parts[kind].push(placement);
  }
}

function emitBuilding(
  b: Building,
  groundAt: GroundAt,
  shell: Shell,
  parts: Record<PartKind, Placement[]>,
  pavedAt?: PavedAt,
): void {
  const e = new Emitter(b, shell, parts);
  const bays = facadeBays(b);
  const f: Foundation = foundationOf(b, groundAt, bays, pavedAt);
  const floor = f.floor;
  const entranceKey = (volume: number, side: Side, index: number): string => `${volume}:${side}:${index}`;
  const entrances = new Map<string, Entrance>(f.entrances.map((x) => [entranceKey(x.volume, x.side, x.index), x]));
  /** The opening of an entrance, in its bay's face frame. */
  const entranceOpening = (x: Entrance): Opening =>
    openingOf(x.component, x.width, levelHeight(b, 0)) ??
    { a0: x.width * 0.2, a1: x.width * 0.8, h0: 0, h1: levelHeight(b, 0) * 0.7, depth: REVEAL };
  /** Where an entrance's bay starts along its side. */
  const entranceStart = (x: Entrance, v: Volume): number => x.index * bayWidth(b, v, x.side);
  // A small, stable shade per building, so a street of one preset is not a
  // single flat colour.
  const shade = 0.93 + (((b.id * 2654435761) >>> 0) % 1000) / 1000 * 0.12;
  const wallOf = (v: Volume, side: Side): Paint => paint(wallMaterial(b, v, side), shade);
  const trim = paint(trimMaterial(b));
  const plinth = paint(plinthMaterial(b));
  const awning = new Color().setHex(paletteOf(b).awning);

  // ---- plinth: from below the lowest ground up to the floor, notched where
  // a flight of steps is set into the building
  for (const v of b.volumes) {
    if (v.base !== 0) continue;
    const notches = new Map<Side, { a0: number; a1: number; recess: number }[]>();
    for (const x of f.entrances) {
      if (x.volume !== v.id || x.recess <= 0) continue;
      const o = entranceOpening(x);
      const frame = sideFrame(v, x.side, entranceStart(x, v));
      const start = x.side === 0 || x.side === 2 ? frame.ax : frame.ay;
      const list = notches.get(x.side) ?? [];
      list.push({ a0: start + o.a0, a1: start + o.a1, recess: x.recess });
      notches.set(x.side, list);
    }
    emitPlinth(e, v, f.bottom, floor, plinth, notches);
  }

  // ---- facades, bay by bay: only outside walls are in `bays`
  const componentAt = new Map<string, BayComponent>();
  for (const bay of bays) componentAt.set(`${bay.volume}:${bay.level}:${bay.side}:${bay.index}`, bay.component);
  const volumes = new Map(b.volumes.map((v) => [v.id, v]));
  for (const bay of bays) {
    const v = volumes.get(bay.volume) as Volume;
    const face: BayFace = { ...sideFrame(v, bay.side, bay.start), z0: floor + bay.z, W: bay.width, H: bay.height };
    const left = componentAt.get(`${bay.volume}:${bay.level}:${bay.side}:${bay.index - 1}`);
    const right = componentAt.get(`${bay.volume}:${bay.level}:${bay.side}:${bay.index + 1}`);
    const recess = bay.level === 0 ? entrances.get(entranceKey(bay.volume, bay.side, bay.index))?.recess ?? 0 : 0;
    emitBay(e, face, bay, wallOf(v, bay.side), trim, awning, left === 'pillar', right === 'pillar', recess);
  }

  // ---- storey bands and cornices, per volume
  for (const v of b.volumes) {
    for (let k = 1; k < v.storeys.length; k++) {
      const level = v.base + k;
      if (level === 0) continue;
      band(e, v, floor + levelElevation(b, level), BAND_OUT, BAND_H, trim);
    }
  }

  // ---- roofs
  for (const v of b.volumes) emitRoof(e, b, v, floor, (side) => wallOf(v, side), trim, paint(roofMaterial(b, v)));

  // ---- entrance steps: outside, down to the ground in front, or set into
  // the building where the paving leaves no room for them
  for (const entrance of f.entrances) {
    if (entrance.steps <= 0) continue;
    const v = volumes.get(entrance.volume) as Volume;
    const frame = sideFrame(v, entrance.side, entranceStart(entrance, v));
    const face: BayFace = { ...frame, z0: floor, W: entrance.width, H: 1 };
    const opening = entranceOpening(entrance);
    const n = e.N(face.nx, face.ny);
    const bottom = Math.min(entrance.ground, floor) - m(0.4);
    // Every riser the same: the flight spans exactly ground to floor.
    const riser = (floor - entrance.ground) / entrance.steps;
    if (entrance.recess > 0) {
      emitRecessedFlight(e, face, opening.a0, opening.a1, entrance, floor, bottom, riser, plinth);
      continue;
    }
    const halfW = (opening.a1 - opening.a0 + m(0.5)) / 2;
    for (let j = 0; j < entrance.steps; j++) {
      const top = floor - j * riser;
      const d0 = -(j === 0 ? 0 : STEP_RUN * (j + 1));
      const d1 = -STEP_RUN * (j + 2);
      const a0 = entrance.width / 2 - halfW;
      const a1 = entrance.width / 2 + halfW;
      // Front, top and the two cheeks of this step's block.
      e.rect(face, a0, a1, bottom - floor, top - floor, d1, n, plinth);
      shell.face([e.P(face, a0, top - floor, d0), e.P(face, a1, top - floor, d0), e.P(face, a1, top - floor, d1), e.P(face, a0, top - floor, d1)], [0, 0, 1], plinth);
      const tv = e.N(face.tx, face.ty);
      shell.face([e.P(face, a1, bottom - floor, d0), e.P(face, a1, bottom - floor, d1), e.P(face, a1, top - floor, d1), e.P(face, a1, top - floor, d0)], tv, plinth);
      shell.face([e.P(face, a0, bottom - floor, d1), e.P(face, a0, bottom - floor, d0), e.P(face, a0, top - floor, d0), e.P(face, a0, top - floor, d1)], [-tv[0], -tv[1], 0], plinth);
    }
  }

  // ---- cores: a lift overrun on the highest flat roof over the core
  const u = b.module;
  for (const core of b.cores) {
    let best: Volume | null = null;
    const cx = core.x + u / 2;
    const cy = core.y + u / 2;
    for (const v of b.volumes) {
      if (cx < v.x || cx >= v.x + v.w || cy < v.y || cy >= v.y + v.d) continue;
      if (!best || volumeTop(v) > volumeTop(best)) best = v;
    }
    if (!best || (best.roof !== 'flat' && best.roof !== 'terrace')) continue;
    const z = floor + volumeHeight(b, best);
    e.box(core.x, core.y, core.x + u, core.y + u, z, z + m(3), trim, ROOF_PLANT);
  }
}

function emitBay(
  e: Emitter,
  f: BayFace,
  bay: FacadeBay,
  wall: Paint,
  trim: Paint,
  awning: Color,
  pillarLeft: boolean,
  pillarRight: boolean,
  /** An entrance whose flight is set into the building: the opening becomes a porch this deep. */
  recess = 0,
): void {
  const out = e.N(f.nx, f.ny);
  const along = e.N(f.tx, f.ty);
  const back: V3 = [-along[0], -along[1], 0];
  const { W, H } = f;

  if (bay.component === 'pillar') {
    // An arcade: the wall steps back, a column stands on the facade line.
    e.rect(f, 0, W, 0, H, ARCADE, out, wall);
    e.strip(f, 0, W, H, 0, ARCADE, [0, 0, -1], trim);
    e.strip(f, 0, W, 0.02, 0, ARCADE, [0, 0, 1], ARCADE_FLOOR);
    if (!pillarLeft) e.jamb(f, 0, 0, H, 0, ARCADE, along, wall);
    if (!pillarRight) e.jamb(f, W, 0, H, 0, ARCADE, back, wall);
    const d = m(0.55);
    e.put('column', f, W / 2, H / 2, m(0.35), d, H, d);
    return;
  }

  const found = openingOf(bay.component, W, H);
  if (!found) {
    e.rect(f, 0, W, 0, H, 0, out, wall);
    return;
  }
  // A porch runs down to the floor and back to the door; its floor is the
  // top of the flight, so it has no sill of its own.
  const o = recess > 0 ? { ...found, h0: 0, depth: recess } : found;
  // The wall around the hole, then the four reveals into it.
  e.rect(f, 0, o.a0, 0, H, 0, out, wall);
  e.rect(f, o.a1, W, 0, H, 0, out, wall);
  e.rect(f, o.a0, o.a1, 0, o.h0, 0, out, wall);
  e.rect(f, o.a0, o.a1, o.h1, H, 0, out, wall);
  e.jamb(f, o.a0, o.h0, o.h1, 0, o.depth, along, recess > 0 ? wall : trim);
  e.jamb(f, o.a1, o.h0, o.h1, 0, o.depth, back, recess > 0 ? wall : trim);
  if (recess <= 0) e.strip(f, o.a0, o.a1, o.h0, 0, o.depth, [0, 0, 1], trim);
  e.strip(f, o.a0, o.a1, o.h1, 0, o.depth, [0, 0, -1], trim);

  const w = o.a1 - o.a0;
  const h = o.h1 - o.h0;
  const am = (o.a0 + o.a1) / 2;
  const hm = (o.h0 + o.h1) / 2;
  switch (bay.component) {
    case 'window':
      e.put('glass', f, am, hm, o.depth, w, h, 1);
      e.put('frame', f, am, hm, o.depth - m(0.03), w, h, m(0.06));
      e.put('concrete', f, am, o.h0 - m(0.03), (o.depth - m(0.07)) / 2, w + m(0.14), m(0.06), o.depth + m(0.07));
      break;
    case 'wideWindow':
      e.put('glass', f, am, hm, o.depth, w, h, 1);
      e.put('frame', f, am, hm, o.depth - m(0.03), w, h, m(0.05));
      break;
    case 'balcony':
      e.put('glass', f, am, hm, o.depth, w, h, 1);
      e.put('frame', f, am, hm, o.depth - m(0.03), w, h, m(0.06));
      e.put('concrete', f, W / 2, -m(0.09), -m(0.65), W - m(0.3), m(0.18), m(1.3));
      e.put('railing', f, W / 2, 0, 0, W - m(0.3), m(1.05), m(1.3));
      break;
    case 'door':
      e.put('door', f, am, hm, o.depth + m(0.03), w, h, m(0.06));
      if (bay.level === 0) e.put('concrete', f, am, o.h1 + m(0.3), -m(0.45), w + m(0.7), m(0.12), m(0.9));
      break;
    case 'shopfront':
      e.put('glass', f, am, hm, o.depth, w, h, 1);
      e.put('frame', f, am, hm, o.depth - m(0.03), w, h, m(0.05));
      e.put('awning', f, W / 2, o.h1 + m(0.45), 0, W - m(0.2), m(0.75), m(1.3), awning);
      break;
    case 'loadingDoor':
      e.put('shutter', f, am, hm, o.depth, w, h, m(0.1));
      break;
    default:
      break;
  }
}

/**
 * A ground volume's plinth, from `bottom` to `floor`, PLINTH_GROW proud of the
 * walls: its four sides and the ledge along their top (the rest of the top is
 * under the floor, never seen), with a notch cut into a side wherever a
 * flight of steps is set into the building.
 * Notch intervals are along the side's own axis (+x on sides 0 and 2, +y on
 * 1 and 3), in local units.
 */
function emitPlinth(
  e: Emitter,
  v: Volume,
  bottom: number,
  floor: number,
  c: Paint,
  notches: ReadonlyMap<Side, readonly { a0: number; a1: number; recess: number }[]>,
): void {
  const g = PLINTH_GROW;
  const x0 = v.x - g;
  const y0 = v.y - g;
  const x1 = v.x + v.w + g;
  const y1 = v.y + v.d + g;
  for (const side of SIDES) {
    // The side as a line in the plan: where it runs along its axis and where it stands across it.
    const alongX = side === 0 || side === 2;
    const lo = alongX ? x0 : y0;
    const hi = alongX ? x1 : y1;
    const at = side === 0 ? y0 : side === 1 ? x1 : side === 2 ? y1 : x0;
    const inward = side === 0 || side === 3 ? 1 : -1;
    const point = (a: number, depth: number, z: number): V3 =>
      alongX ? e.L(a, at + inward * depth, z) : e.L(at + inward * depth, a, z);
    const n = SIDE_NORMAL[side];
    const out = e.N(n.x, n.y);
    const cuts = [...(notches.get(side) ?? [])].sort((p, q) => p.a0 - q.a0);
    let from = lo;
    const wallTo = (to: number): void => {
      if (to - from < 1e-4) return;
      e.shell.face([point(from, 0, bottom), point(to, 0, bottom), point(to, 0, floor), point(from, 0, floor)], out, c);
      e.shell.face([point(from, 0, floor), point(to, 0, floor), point(to, g, floor), point(from, g, floor)], [0, 0, 1], c);
    };
    for (const cut of cuts) {
      wallTo(cut.a0);
      // The notch's cheeks, facing into it; the flight fills its floor and back.
      const depth = g + cut.recess;
      const t = alongX ? e.N(1, 0) : e.N(0, 1);
      e.shell.face([point(cut.a0, 0, bottom), point(cut.a0, depth, bottom), point(cut.a0, depth, floor), point(cut.a0, 0, floor)], t, c);
      e.shell.face([point(cut.a1, depth, bottom), point(cut.a1, 0, bottom), point(cut.a1, 0, floor), point(cut.a1, depth, floor)], [-t[0], -t[1], 0], c);
      from = cut.a1;
    }
    wallTo(hi);
  }
}

/**
 * A flight set into the building: from the plinth's face up to the door at
 * `recess` behind the facade, between the porch's jambs. Treads share the run
 * evenly, the top one is the landing in front of the door.
 */
function emitRecessedFlight(
  e: Emitter,
  face: BayFace,
  a0: number,
  a1: number,
  entrance: Entrance,
  floor: number,
  bottom: number,
  riser: number,
  c: Paint,
): void {
  const n = e.N(face.nx, face.ny);
  const start = -PLINTH_GROW;
  if (entrance.threshold > PLINTH_GROW) {
    // The slab over the verge, from the paving to the foot of the flight.
    const top = entrance.ground - floor;
    const out = -entrance.threshold;
    const t = e.N(face.tx, face.ty);
    e.rect(face, a0, a1, bottom - floor, top, out, n, c);
    e.shell.face([e.P(face, a0, top, out), e.P(face, a1, top, out), e.P(face, a1, top, start), e.P(face, a0, top, start)], [0, 0, 1], c);
    e.shell.face([e.P(face, a1, bottom - floor, out), e.P(face, a1, bottom - floor, start), e.P(face, a1, top, start), e.P(face, a1, top, out)], t, c);
    e.shell.face([e.P(face, a0, bottom - floor, start), e.P(face, a0, bottom - floor, out), e.P(face, a0, top, out), e.P(face, a0, top, start)], [-t[0], -t[1], 0], c);
  }
  const tread = (entrance.recess - start) / (entrance.steps + 1);
  for (let k = 0; k < entrance.steps; k++) {
    const top = entrance.ground + (k + 1) * riser - floor;
    const d0 = start + k * tread;
    // Each block runs to the door, so only its riser and its tread show.
    e.rect(face, a0, a1, bottom - floor, top, d0, n, c);
    e.shell.face([e.P(face, a0, top, d0), e.P(face, a1, top, d0), e.P(face, a1, top, entrance.recess), e.P(face, a0, top, entrance.recess)], [0, 0, 1], c);
  }
}

/** A horizontal band around a volume at height z (a storey line or a cornice). */
function band(e: Emitter, v: Volume, z: number, out: number, height: number, c: Paint): void {
  const x0 = v.x - out;
  const y0 = v.y - out;
  const x1 = v.x + v.w + out;
  const y1 = v.y + v.d + out;
  e.box(x0, y0, x1, y1, z - height / 2, z + height / 2, c);
}

function emitRoof(
  e: Emitter,
  b: Building,
  v: Volume,
  floor: number,
  wallOf: (side: Side) => Paint,
  trim: Paint,
  roofColour: Paint,
): void {
  const top = volumeTop(v);
  const z = floor + volumeHeight(b, v);
  const x0 = v.x;
  const y0 = v.y;
  const x1 = v.x + v.w;
  const y1 = v.y + v.d;
  const sh = e.shell;
  const up: V3 = [0, 0, 1];

  if (v.roof === 'flat' || v.roof === 'terrace') {
    const terrace = v.roof === 'terrace';
    sh.face([e.L(x0, y0, z), e.L(x1, y0, z), e.L(x1, y1, z), e.L(x0, y1, z)], up, terrace ? TERRACE : roofColour);
    // Its top stays just under the roof: a face shared with the roof cap
    // z-fights into stripes.
    band(e, v, z - m(0.2), CORNICE_OUT, m(0.36), trim);
    // An edge bay gets a parapet (or a railing, on a terrace) only where the
    // roof really ends: not against a neighbour of the same or greater height.
    for (const side of SIDES) {
      // Only where the roof really ends: not against a neighbour as tall or taller.
      const spans = [...coveredSpans(b, v, side, top - 1), ...coveredSpans(b, v, side, top)].sort((p, q) => p[0] - q[0]);
      const step = bayWidth(b, v, side);
      for (const [p0, p1] of exposedParts(spans, 0, sideLength(v, side))) {
        // In bay-sized pieces, so a railing keeps its baluster spacing.
        const pieces = Math.max(1, Math.round((p1 - p0) / step));
        const W = (p1 - p0) / pieces;
        for (let k = 0; k < pieces; k++) {
          const face: BayFace = { ...sideFrame(v, side, p0 + k * W), z0: z, W, H: PARAPET_H };
          if (terrace) {
            e.put('roofRailing', face, W / 2, 0, m(0.12), W, m(1.0), 1);
          } else {
            const out = e.N(face.nx, face.ny);
            e.rect(face, 0, W, 0, PARAPET_H, 0, out, wallOf(side));
            e.rect(face, 0, W, 0, PARAPET_H, PARAPET_T, [-out[0], -out[1], 0], PARAPET_BACK);
            e.strip(face, 0, W, PARAPET_H, 0, PARAPET_T, up, trim);
          }
        }
      }
    }
    return;
  }

  const rise = roofRise(b, v);
  const alongX = v.w >= v.d;
  if (v.roof === 'gable' || v.roof === 'hip') {
    // Work in a frame whose "long" axis runs along the ridge.
    const span = alongX ? y1 - y0 : x1 - x0;
    const pitch = GABLE_PITCH;
    const eave = z - EAVES * pitch;
    const ridge = z + rise;
    const hip = v.roof === 'hip' ? span / 2 : 0;
    const Lp = (along: number, across: number, height: number): V3 =>
      alongX ? e.L(along, across, height) : e.L(across, along, height);
    const a0 = alongX ? x0 : y0;
    const a1 = alongX ? x1 : y1;
    const c0 = alongX ? y0 : x0;
    const c1 = alongX ? y1 : x1;
    const cm = (c0 + c1) / 2;
    const nNear = alongX ? e.N(0, -1, 1) : e.N(-1, 0, 1);
    const nFar = alongX ? e.N(0, 1, 1) : e.N(1, 0, 1);
    const o = EAVES;
    const r0 = a0 + hip;
    const r1 = a1 - hip;
    // The two long slopes.
    sh.face([Lp(a0 - o, c0 - o, eave), Lp(a1 + o, c0 - o, eave), Lp(r1, cm, ridge), Lp(r0, cm, ridge)], nNear, roofColour);
    sh.face([Lp(a1 + o, c1 + o, eave), Lp(a0 - o, c1 + o, eave), Lp(r0, cm, ridge), Lp(r1, cm, ridge)], nFar, roofColour);
    const endLow = alongX ? e.N(-1, 0, 1) : e.N(0, -1, 1);
    const endHigh = alongX ? e.N(1, 0, 1) : e.N(0, 1, 1);
    if (v.roof === 'hip') {
      sh.face([Lp(a0 - o, c1 + o, eave), Lp(a0 - o, c0 - o, eave), Lp(r0, cm, ridge)], endLow, roofColour);
      sh.face([Lp(a1 + o, c0 - o, eave), Lp(a1 + o, c1 + o, eave), Lp(r1, cm, ridge)], endHigh, roofColour);
    } else {
      // Gable ends: wall-coloured triangles.
      const w0 = alongX ? e.N(-1, 0) : e.N(0, -1);
      const w1 = alongX ? e.N(1, 0) : e.N(0, 1);
      sh.face([Lp(a0, c0, z), Lp(a0, c1, z), Lp(a0, cm, ridge)], w0, wallOf(alongX ? 3 : 0));
      sh.face([Lp(a1, c1, z), Lp(a1, c0, z), Lp(a1, cm, ridge)], w1, wallOf(alongX ? 1 : 2));
    }
    return;
  }

  if (v.roof === 'shed') {
    const run = y1 - y0;
    const high = z + run * SHED_PITCH;
    const o = EAVES;
    sh.face([e.L(x0 - o, y0 - o, z - o * SHED_PITCH), e.L(x1 + o, y0 - o, z - o * SHED_PITCH), e.L(x1 + o, y1 + o, high + o * SHED_PITCH), e.L(x0 - o, y1 + o, high + o * SHED_PITCH)], e.N(0, -1, 4), roofColour);
    sh.face([e.L(x0, y0, z), e.L(x0, y1, z), e.L(x0, y1, high)], e.N(-1, 0), wallOf(3));
    sh.face([e.L(x1, y1, z), e.L(x1, y0, z), e.L(x1, y1, high)], e.N(1, 0), wallOf(1));
    sh.face([e.L(x1, y1, z), e.L(x0, y1, z), e.L(x0, y1, high), e.L(x1, y1, high)], e.N(0, 1), wallOf(2));
    return;
  }

  // Sawtooth: teeth of up to two cells, glazed on their steep face.
  const tooth = sawtoothRun(b, v);
  const toothRise = tooth * 0.5 * SAWTOOTH_PITCH;
  const glass = SAW_GLASS;
  for (let t0 = y0; t0 < y1 - 1e-6; t0 += tooth) {
    const t1 = Math.min(y1, t0 + tooth);
    const h = toothRise * ((t1 - t0) / tooth);
    sh.face([e.L(x0, t0, z), e.L(x1, t0, z), e.L(x1, t1, z + h), e.L(x0, t1, z + h)], e.N(0, -1, 2), roofColour);
    sh.face([e.L(x1, t1, z), e.L(x0, t1, z), e.L(x0, t1, z + h), e.L(x1, t1, z + h)], e.N(0, 1), glass);
    sh.face([e.L(x0, t0, z), e.L(x0, t1, z), e.L(x0, t1, z + h)], e.N(-1, 0), wallOf(3));
    sh.face([e.L(x1, t1, z), e.L(x1, t0, z), e.L(x1, t1, z + h)], e.N(1, 0), wallOf(1));
  }
}

// ------------------------------------------------------------------ chunks

/** One part batch of one building: its instance matrices (and colours). */
export interface PartBatch {
  readonly matrices: Float32Array;
  readonly colours: Float32Array | null;
  readonly count: number;
}

/**
 * Everything one building contributes, in typed arrays: a shell fragment with
 * local indices and its instance batches. The layer caches these per building
 * (see `layer.ts`), so an edit re-emits one building and merely concatenates
 * the rest.
 */
export interface ShellChunk {
  readonly position: Float32Array;
  readonly normal: Float32Array;
  readonly colour: Float32Array;
  readonly uv: Float32Array;
  readonly index: Uint32Array;
}

export interface BuildingChunk {
  /** The shell, one fragment per finish it uses. */
  readonly shells: Readonly<Partial<Record<Finish, ShellChunk>>>;
  readonly parts: Readonly<Record<PartKind, PartBatch>>;
}

/** Column-major T * Ry * S, written straight into `out` at `offset`. */
function writeMatrix(out: Float32Array, offset: number, p: Placement): void {
  const c = Math.cos(p.yaw);
  const s = Math.sin(p.yaw);
  out[offset] = c * p.sx; out[offset + 1] = 0; out[offset + 2] = -s * p.sx; out[offset + 3] = 0;
  out[offset + 4] = 0; out[offset + 5] = p.sy; out[offset + 6] = 0; out[offset + 7] = 0;
  out[offset + 8] = s * p.sz; out[offset + 9] = 0; out[offset + 10] = c * p.sz; out[offset + 11] = 0;
  // World y is mirrored into three's z, as everywhere else in this layer.
  out[offset + 12] = p.x; out[offset + 13] = p.z; out[offset + 14] = -p.y; out[offset + 15] = 1;
}

export function emitChunk(b: Building, groundAt: GroundAt, pavedAt?: PavedAt): BuildingChunk {
  const shell = new Shell();
  const parts = Object.fromEntries(PART_KINDS.map((k) => [k, [] as Placement[]])) as Record<PartKind, Placement[]>;
  emitBuilding(b, groundAt, shell, parts, pavedAt);
  const batches = {} as Record<PartKind, PartBatch>;
  for (const kind of PART_KINDS) {
    const list = parts[kind];
    const matrices = new Float32Array(list.length * 16);
    const coloured = kind === 'awning';
    const colours = coloured ? new Float32Array(list.length * 3) : null;
    list.forEach((p, i) => {
      writeMatrix(matrices, i * 16, p);
      if (colours && p.colour) {
        colours[i * 3] = p.colour.r;
        colours[i * 3 + 1] = p.colour.g;
        colours[i * 3 + 2] = p.colour.b;
      }
    });
    batches[kind] = { matrices, colours, count: list.length };
  }
  const shells: Partial<Record<Finish, ShellChunk>> = {};
  for (const [finish, part] of shell.parts) {
    if (part.index.length === 0) continue;
    shells[finish] = {
      position: new Float32Array(part.position),
      normal: new Float32Array(part.normal),
      colour: new Float32Array(part.colour),
      uv: new Float32Array(part.uv),
      index: new Uint32Array(part.index),
    };
  }
  return { shells, parts: batches };
}

/**
 * Meshes for a set of building chunks: one merged shell, one instanced batch
 * per part. `ghost` draws them with the translucent preview materials,
 * casting no shadow and with no instance colours (one program per material).
 */
export function assembleBuildingMeshes(chunks: readonly BuildingChunk[], kit: BuildingKit, ghost = false): BuildingMeshes {
  const group = new Group();
  group.name = ghost ? 'building-preview' : 'buildings';
  const meshes: (Mesh | InstancedMesh)[] = [];
  let triangles = 0;

  for (const finish of FINISHES) {
    let vertices = 0;
    let indices = 0;
    for (const chunk of chunks) {
      const part = chunk.shells[finish];
      if (!part) continue;
      vertices += part.position.length / 3;
      indices += part.index.length;
    }
    if (indices === 0) continue;
    const position = new Float32Array(vertices * 3);
    const normal = new Float32Array(vertices * 3);
    const colour = new Float32Array(vertices * 3);
    const uv = new Float32Array(vertices * 2);
    const index = new Uint32Array(indices);
    let v = 0;
    let n = 0;
    for (const chunk of chunks) {
      const part = chunk.shells[finish];
      if (!part) continue;
      position.set(part.position, v * 3);
      normal.set(part.normal, v * 3);
      colour.set(part.colour, v * 3);
      uv.set(part.uv, v * 2);
      for (let i = 0; i < part.index.length; i++) index[n + i] = (part.index[i] as number) + v;
      v += part.position.length / 3;
      n += part.index.length;
    }
    const g = new BufferGeometry();
    g.setAttribute('position', new Float32BufferAttribute(position, 3));
    g.setAttribute('normal', new Float32BufferAttribute(normal, 3));
    g.setAttribute('color', new Float32BufferAttribute(colour, 3));
    g.setAttribute('uv', new Float32BufferAttribute(uv, 2));
    g.setIndex(new Uint32BufferAttribute(index, 1));
    g.computeBoundingSphere();
    const mesh = new Mesh(g, ghost ? kit.ghostShell : kit.shell[finish]);
    mesh.name = ghost ? `building-preview-shell-${finish}` : `building-shell-${finish}`;
    mesh.castShadow = !ghost;
    mesh.receiveShadow = !ghost;
    meshes.push(mesh);
    triangles += indices / 3;
  }

  for (const kind of PART_KINDS) {
    let count = 0;
    for (const chunk of chunks) count += chunk.parts[kind].count;
    if (count === 0) continue;
    const mesh = new InstancedMesh(kit.geometry[kind], ghost ? kit.ghostParts : kit.material[kind], count);
    mesh.name = `building-${kind}${ghost ? '-preview' : ''}`;
    mesh.castShadow = !ghost && kit.castsShadow.has(kind);
    mesh.receiveShadow = !ghost;
    const matrices = mesh.instanceMatrix.array as Float32Array;
    const coloured = !ghost && kind === 'awning';
    if (coloured) mesh.setColorAt(0, new Color(1, 1, 1));
    const colours = coloured && mesh.instanceColor ? (mesh.instanceColor.array as Float32Array) : null;
    let at = 0;
    for (const chunk of chunks) {
      const batch = chunk.parts[kind];
      if (batch.count === 0) continue;
      matrices.set(batch.matrices, at * 16);
      if (colours && batch.colours) colours.set(batch.colours, at * 3);
      at += batch.count;
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingSphere();
    meshes.push(mesh);
    const g = kit.geometry[kind];
    triangles += ((g.index ? g.index.count : g.getAttribute('position').count) / 3) * count;
  }
  for (const mesh of meshes) group.add(mesh);

  return {
    group,
    triangles,
    dispose() {
      for (const mesh of meshes) {
        // The shell geometry is this build's own; the part geometries are the kit's.
        if (mesh instanceof InstancedMesh) mesh.dispose();
        else mesh.geometry.dispose();
      }
      group.clear();
    },
  };
}

/** Meshes for buildings, emitted afresh (the preview; tests). */
export function buildBuildingMeshes(
  buildings: Iterable<Building>,
  groundAt: GroundAt,
  kit: BuildingKit,
  ghost = false,
  pavedAt?: PavedAt,
): BuildingMeshes {
  return assembleBuildingMeshes([...buildings].map((b) => emitChunk(b, groundAt, pavedAt)), kit, ghost);
}