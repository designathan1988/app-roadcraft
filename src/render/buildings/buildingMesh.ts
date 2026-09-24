import {
  BufferGeometry,
  Color,
  Float32BufferAttribute,
  Group,
  InstancedMesh,
  type Material,
  Mesh,
  Object3D,
  Uint32BufferAttribute,
} from 'three';

import { m } from '@world/units';
import { type Foundation, type GroundAt, STEP_RISE, STEP_RUN, foundationOf } from '@world/buildings/foundation';
import {
  type FacadeBay,
  SAWTOOTH_PITCH,
  SHED_PITCH,
  GABLE_PITCH,
  cellBeyond,
  facadeBays,
  levelElevation,
  occupancy,
  roofRise,
  volumeHeight,
} from '@world/buildings/geometry';
import { type BayComponent, type Building, type Side, type Volume, SIDES, baysOn, volumeTop } from '@world/buildings/types';
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

/** Wall, trim (bands, reveals, parapet caps) and pitched-roof colour per palette. */
const PALETTES: readonly { wall: number; trim: number; roof: number; awning: number }[] = [
  { wall: 0xe6d8bd, trim: 0xf4eee2, roof: 0x9c4f3a, awning: 0x2f6f5e },
  { wall: 0xa4563f, trim: 0xe0d6c6, roof: 0x4a4b50, awning: 0x8c2f2a },
  { wall: 0xbdbcb4, trim: 0xdcdcd6, roof: 0x55585c, awning: 0x2d4f7a },
  { wall: 0xd8c297, trim: 0xf0e6cf, roof: 0x8a5a3c, awning: 0xb5452b },
  { wall: 0xf0efe9, trim: 0xc9ccc9, roof: 0x5b5f63, awning: 0x2f6f5e },
  { wall: 0x72412f, trim: 0xd2c4b2, roof: 0x3d3e42, awning: 0xc4832d },
  { wall: 0x8f9ba5, trim: 0xe0e5e8, roof: 0x4f5357, awning: 0x2d4f7a },
  { wall: 0x939b91, trim: 0xc4c8c1, roof: 0x6f7577, awning: 0xc4a02d },
];
const PLINTH = 0x7f786d;
const FLAT_ROOF = 0x76746e;
const TERRACE = 0xb0a595;
const ARCADE_FLOOR = 0x9d968a;
const SAW_GLASS = 0x3c5360;

const linear = (hex: number, shade = 1): Rgb => {
  const c = new Color().setHex(hex);
  return [c.r * shade, c.g * shade, c.b * shade];
};

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

/** Flat-shaded, vertex-coloured triangles in THREE's axes; winding fixed per face. */
class Shell {
  readonly position: number[] = [];
  readonly normal: number[] = [];
  readonly colour: number[] = [];
  readonly index: number[] = [];

  /**
   * A planar polygon (3 or 4 world points, x/y map, z up) facing world normal
   * `n`. The winding is measured, never assumed: world y is mirrored into
   * three's z, which flips handedness (AGENTS.md trap: winding).
   */
  face(points: readonly (readonly [number, number, number])[], n: readonly [number, number, number], c: Rgb): void {
    const base = this.position.length / 3;
    const three = points.map(([x, y, z]) => [x, z, -y] as const);
    const length = Math.hypot(n[0], n[1], n[2]) || 1;
    const nx = n[0] / length;
    const ny = n[2] / length;
    const nz = -n[1] / length;
    for (const p of three) {
      this.position.push(p[0], p[1], p[2]);
      this.normal.push(nx, ny, nz);
      this.colour.push(c[0], c[1], c[2]);
    }
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
      if (forward) this.index.push(base + i, base + j, base + k);
      else this.index.push(base + i, base + k, base + j);
    };
    tri(0, 1, 2);
    if (points.length === 4) tri(0, 2, 3);
  }

  get triangles(): number {
    return this.index.length / 3;
  }

  geometry(): BufferGeometry {
    const g = new BufferGeometry();
    g.setAttribute('position', new Float32BufferAttribute(this.position, 3));
    g.setAttribute('normal', new Float32BufferAttribute(this.normal, 3));
    g.setAttribute('color', new Float32BufferAttribute(this.colour, 3));
    g.setIndex(new Uint32BufferAttribute(this.index, 1));
    g.computeBoundingSphere();
    return g;
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

function sideFrame(b: Building, v: Volume, side: Side, index: number): Pick<BayFace, 'ax' | 'ay' | 'tx' | 'ty' | 'nx' | 'ny'> {
  const u = b.module;
  switch (side) {
    case 0: return { ax: (v.x + index) * u, ay: v.y * u, tx: 1, ty: 0, nx: 0, ny: -1 };
    case 2: return { ax: (v.x + index) * u, ay: (v.y + v.d) * u, tx: 1, ty: 0, nx: 0, ny: 1 };
    case 1: return { ax: (v.x + v.w) * u, ay: (v.y + index) * u, tx: 0, ty: 1, nx: 1, ny: 0 };
    default: return { ax: v.x * u, ay: (v.y + index) * u, tx: 0, ty: 1, nx: -1, ny: 0 };
  }
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
  rect(f: BayFace, a0: number, a1: number, h0: number, h1: number, depth: number, n: V3, c: Rgb): void {
    if (a1 - a0 < 1e-4 || h1 - h0 < 1e-4) return;
    this.shell.face([this.P(f, a0, h0, depth), this.P(f, a1, h0, depth), this.P(f, a1, h1, depth), this.P(f, a0, h1, depth)], n, c);
  }

  /** An axis-aligned box in the local plan: sides and top (the bottom is never seen). */
  box(x0: number, y0: number, x1: number, y1: number, z0: number, z1: number, c: Rgb, top: Rgb = c): void {
    if (z1 - z0 < 1e-4) return;
    const sh = this.shell;
    sh.face([this.L(x0, y0, z0), this.L(x1, y0, z0), this.L(x1, y0, z1), this.L(x0, y0, z1)], this.N(0, -1), c);
    sh.face([this.L(x1, y1, z0), this.L(x0, y1, z0), this.L(x0, y1, z1), this.L(x1, y1, z1)], this.N(0, 1), c);
    sh.face([this.L(x1, y0, z0), this.L(x1, y1, z0), this.L(x1, y1, z1), this.L(x1, y0, z1)], this.N(1, 0), c);
    sh.face([this.L(x0, y1, z0), this.L(x0, y0, z0), this.L(x0, y0, z1), this.L(x0, y1, z1)], this.N(-1, 0), c);
    sh.face([this.L(x0, y0, z1), this.L(x1, y0, z1), this.L(x1, y1, z1), this.L(x0, y1, z1)], [0, 0, 1], top);
  }

  /** A horizontal strip at height h, from depth d0 to d1 into the wall. */
  strip(f: BayFace, a0: number, a1: number, h: number, d0: number, d1: number, n: V3, c: Rgb): void {
    this.shell.face([this.P(f, a0, h, d0), this.P(f, a1, h, d0), this.P(f, a1, h, d1), this.P(f, a0, h, d1)], n, c);
  }

  /** A vertical strip across the wall's thickness at `a`, from h0 to h1. */
  jamb(f: BayFace, a: number, h0: number, h1: number, d0: number, d1: number, n: V3, c: Rgb): void {
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
): void {
  const e = new Emitter(b, shell, parts);
  const u = b.module;
  const occ = occupancy(b);
  const bays = facadeBays(b, occ);
  const f: Foundation = foundationOf(b, groundAt, bays);
  const floor = f.floor;
  const palette = PALETTES[b.palette % PALETTES.length] ?? PALETTES[0]!;
  // A small, stable shade per building, so a street of one preset is not a
  // single flat colour.
  const shade = 0.93 + (((b.id * 2654435761) >>> 0) % 1000) / 1000 * 0.12;
  const wall = linear(palette.wall, shade);
  const trim = linear(palette.trim);
  const roofColour = linear(palette.roof);
  const plinth = linear(PLINTH);
  const awning = new Color().setHex(palette.awning);

  // ---- plinth: from below the lowest ground up to the floor
  for (const v of b.volumes) {
    if (v.base !== 0) continue;
    e.box(v.x * u - PLINTH_GROW, v.y * u - PLINTH_GROW, (v.x + v.w) * u + PLINTH_GROW, (v.y + v.d) * u + PLINTH_GROW, f.bottom, floor, plinth);
  }

  // ---- facades, bay by bay: only outside walls are in `bays`
  const componentAt = new Map<string, BayComponent>();
  for (const bay of bays) componentAt.set(`${bay.volume}:${bay.level}:${bay.side}:${bay.index}`, bay.component);
  const volumes = new Map(b.volumes.map((v) => [v.id, v]));
  for (const bay of bays) {
    const v = volumes.get(bay.volume) as Volume;
    const face: BayFace = { ...sideFrame(b, v, bay.side, bay.index), z0: floor + bay.z, W: bay.width, H: bay.height };
    const left = componentAt.get(`${bay.volume}:${bay.level}:${bay.side}:${bay.index - 1}`);
    const right = componentAt.get(`${bay.volume}:${bay.level}:${bay.side}:${bay.index + 1}`);
    emitBay(e, face, bay, wall, trim, awning, left === 'pillar', right === 'pillar');
  }

  // ---- storey bands and cornices, per volume
  for (const v of b.volumes) {
    for (let k = 1; k < v.storeys.length; k++) {
      const level = v.base + k;
      if (level === 0) continue;
      band(e, v, u, floor + levelElevation(b, level), BAND_OUT, BAND_H, trim);
    }
  }

  // ---- roofs
  for (const v of b.volumes) emitRoof(e, b, v, occ, floor, wall, trim, roofColour);

  // ---- entrance steps
  for (const entrance of f.entrances) {
    if (entrance.steps <= 0) continue;
    const v = volumes.get(entrance.volume) as Volume;
    const frame = sideFrame(b, v, entrance.side, entrance.index);
    const face: BayFace = { ...frame, z0: floor, W: u, H: 1 };
    const opening = openingOf(entrance.component, u, levelElevation(b, 1) || b.groundHeight);
    const halfW = ((opening ? opening.a1 - opening.a0 : u * 0.6) + m(0.5)) / 2;
    const n = e.N(face.nx, face.ny);
    const bottom = Math.min(entrance.ground, floor) - m(0.4);
    for (let j = 0; j < entrance.steps; j++) {
      const top = floor - j * STEP_RISE;
      const d0 = -(j === 0 ? 0 : STEP_RUN * (j + 1));
      const d1 = -STEP_RUN * (j + 2);
      const a0 = u / 2 - halfW;
      const a1 = u / 2 + halfW;
      // Front, top and the two cheeks of this step's block.
      e.rect(face, a0, a1, bottom - floor, top - floor, d1, n, plinth);
      shell.face([e.P(face, a0, top - floor, d0), e.P(face, a1, top - floor, d0), e.P(face, a1, top - floor, d1), e.P(face, a0, top - floor, d1)], [0, 0, 1], plinth);
      const tv = e.N(face.tx, face.ty);
      shell.face([e.P(face, a1, bottom - floor, d0), e.P(face, a1, bottom - floor, d1), e.P(face, a1, top - floor, d1), e.P(face, a1, top - floor, d0)], tv, plinth);
      shell.face([e.P(face, a0, bottom - floor, d1), e.P(face, a0, bottom - floor, d0), e.P(face, a0, top - floor, d0), e.P(face, a0, top - floor, d1)], [-tv[0], -tv[1], 0], plinth);
    }
  }

  // ---- cores: a lift overrun on the highest flat roof over the core
  for (const core of b.cores) {
    let best: Volume | null = null;
    for (const v of b.volumes) {
      if (core.x < v.x || core.x >= v.x + v.w || core.y < v.y || core.y >= v.y + v.d) continue;
      if (!best || volumeTop(v) > volumeTop(best)) best = v;
    }
    if (!best || (best.roof !== 'flat' && best.roof !== 'terrace')) continue;
    const z = floor + volumeHeight(b, best);
    e.box(core.x * u, core.y * u, (core.x + 1) * u, (core.y + 1) * u, z, z + m(3), trim, linear(FLAT_ROOF, 0.9));
  }
}

function emitBay(
  e: Emitter,
  f: BayFace,
  bay: FacadeBay,
  wall: Rgb,
  trim: Rgb,
  awning: Color,
  pillarLeft: boolean,
  pillarRight: boolean,
): void {
  const out = e.N(f.nx, f.ny);
  const along = e.N(f.tx, f.ty);
  const back: V3 = [-along[0], -along[1], 0];
  const { W, H } = f;

  if (bay.component === 'pillar') {
    // An arcade: the wall steps back, a column stands on the facade line.
    e.rect(f, 0, W, 0, H, ARCADE, out, wall);
    e.strip(f, 0, W, H, 0, ARCADE, [0, 0, -1], trim);
    e.strip(f, 0, W, 0.02, 0, ARCADE, [0, 0, 1], linear(ARCADE_FLOOR));
    if (!pillarLeft) e.jamb(f, 0, 0, H, 0, ARCADE, along, wall);
    if (!pillarRight) e.jamb(f, W, 0, H, 0, ARCADE, back, wall);
    const d = m(0.55);
    e.put('column', f, W / 2, H / 2, m(0.35), d, H, d);
    return;
  }

  const o = openingOf(bay.component, W, H);
  if (!o) {
    e.rect(f, 0, W, 0, H, 0, out, wall);
    return;
  }
  // The wall around the hole, then the four reveals into it.
  e.rect(f, 0, o.a0, 0, H, 0, out, wall);
  e.rect(f, o.a1, W, 0, H, 0, out, wall);
  e.rect(f, o.a0, o.a1, 0, o.h0, 0, out, wall);
  e.rect(f, o.a0, o.a1, o.h1, H, 0, out, wall);
  e.jamb(f, o.a0, o.h0, o.h1, 0, o.depth, along, trim);
  e.jamb(f, o.a1, o.h0, o.h1, 0, o.depth, back, trim);
  e.strip(f, o.a0, o.a1, o.h0, 0, o.depth, [0, 0, 1], trim);
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

/** A horizontal band around a volume at height z (a storey line or a cornice). */
function band(e: Emitter, v: Volume, u: number, z: number, out: number, height: number, c: Rgb): void {
  const x0 = v.x * u - out;
  const y0 = v.y * u - out;
  const x1 = (v.x + v.w) * u + out;
  const y1 = (v.y + v.d) * u + out;
  e.box(x0, y0, x1, y1, z - height / 2, z + height / 2, c);
}

function emitRoof(
  e: Emitter,
  b: Building,
  v: Volume,
  occ: ReturnType<typeof occupancy>,
  floor: number,
  wall: Rgb,
  trim: Rgb,
  roofColour: Rgb,
): void {
  const u = b.module;
  const top = volumeTop(v);
  const z = floor + volumeHeight(b, v);
  const x0 = v.x * u;
  const y0 = v.y * u;
  const x1 = (v.x + v.w) * u;
  const y1 = (v.y + v.d) * u;
  const sh = e.shell;
  const up: V3 = [0, 0, 1];

  if (v.roof === 'flat' || v.roof === 'terrace') {
    const terrace = v.roof === 'terrace';
    sh.face([e.L(x0, y0, z), e.L(x1, y0, z), e.L(x1, y1, z), e.L(x0, y1, z)], up, linear(terrace ? TERRACE : FLAT_ROOF));
    // Its top stays just under the roof: a face shared with the roof cap
    // z-fights into stripes.
    band(e, v, u, z - m(0.2), CORNICE_OUT, m(0.36), trim);
    // An edge bay gets a parapet (or a railing, on a terrace) only where the
    // roof really ends: not against a neighbour of the same or greater height.
    for (const side of SIDES) {
      const count = baysOn(v, side);
      for (let index = 0; index < count; index++) {
        const [ci, cj] = cellBeyond(v, side, index);
        if (occ.at(ci, cj, top - 1) !== undefined || occ.at(ci, cj, top) !== undefined) continue;
        const frame = sideFrame(b, v, side, index);
        const face: BayFace = { ...frame, z0: z, W: u, H: PARAPET_H };
        if (terrace) {
          e.put('roofRailing', face, u / 2, 0, m(0.12), u, m(1.0), 1);
        } else {
          const out = e.N(face.nx, face.ny);
          e.rect(face, 0, u, 0, PARAPET_H, 0, out, wall);
          e.rect(face, 0, u, 0, PARAPET_H, PARAPET_T, [-out[0], -out[1], 0], linear(FLAT_ROOF, 1.15));
          e.strip(face, 0, u, PARAPET_H, 0, PARAPET_T, up, trim);
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
      sh.face([Lp(a0, c0, z), Lp(a0, c1, z), Lp(a0, cm, ridge)], w0, wall);
      sh.face([Lp(a1, c1, z), Lp(a1, c0, z), Lp(a1, cm, ridge)], w1, wall);
    }
    return;
  }

  if (v.roof === 'shed') {
    const run = y1 - y0;
    const high = z + run * SHED_PITCH;
    const o = EAVES;
    sh.face([e.L(x0 - o, y0 - o, z - o * SHED_PITCH), e.L(x1 + o, y0 - o, z - o * SHED_PITCH), e.L(x1 + o, y1 + o, high + o * SHED_PITCH), e.L(x0 - o, y1 + o, high + o * SHED_PITCH)], e.N(0, -1, 4), roofColour);
    sh.face([e.L(x0, y0, z), e.L(x0, y1, z), e.L(x0, y1, high)], e.N(-1, 0), wall);
    sh.face([e.L(x1, y1, z), e.L(x1, y0, z), e.L(x1, y1, high)], e.N(1, 0), wall);
    sh.face([e.L(x1, y1, z), e.L(x0, y1, z), e.L(x0, y1, high), e.L(x1, y1, high)], e.N(0, 1), wall);
    return;
  }

  // Sawtooth: teeth of up to two cells, glazed on their steep face.
  const tooth = Math.min(2, v.d) * u;
  const toothRise = tooth * 0.5 * SAWTOOTH_PITCH;
  const glass = linear(SAW_GLASS);
  for (let t0 = y0; t0 < y1 - 1e-6; t0 += tooth) {
    const t1 = Math.min(y1, t0 + tooth);
    const h = toothRise * ((t1 - t0) / tooth);
    sh.face([e.L(x0, t0, z), e.L(x1, t0, z), e.L(x1, t1, z + h), e.L(x0, t1, z + h)], e.N(0, -1, 2), roofColour);
    sh.face([e.L(x1, t1, z), e.L(x0, t1, z), e.L(x0, t1, z + h), e.L(x1, t1, z + h)], e.N(0, 1), glass);
    sh.face([e.L(x0, t0, z), e.L(x0, t1, z), e.L(x0, t1, z + h)], e.N(-1, 0), wall);
    sh.face([e.L(x1, t1, z), e.L(x1, t0, z), e.L(x1, t1, z + h)], e.N(1, 0), wall);
  }
}

// ------------------------------------------------------------------ assembly

const scratch = new Object3D();

function instanced(
  name: string,
  geometry: BufferGeometry,
  material: Material,
  placements: readonly Placement[],
  castShadow: boolean,
  coloured: boolean,
): InstancedMesh | null {
  if (placements.length === 0) return null;
  const mesh = new InstancedMesh(geometry, material, placements.length);
  mesh.name = name;
  mesh.castShadow = castShadow;
  mesh.receiveShadow = true;
  placements.forEach((p, i) => {
    // World y is mirrored into three's z, as everywhere else in this layer.
    scratch.position.set(p.x, p.z, -p.y);
    scratch.rotation.set(0, p.yaw, 0);
    scratch.scale.set(p.sx, p.sy, p.sz);
    scratch.updateMatrix();
    mesh.setMatrixAt(i, scratch.matrix);
    if (coloured && p.colour) mesh.setColorAt(i, p.colour);
  });
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.computeBoundingSphere();
  return mesh;
}

/**
 * Meshes for a set of buildings. `ghost` draws them with the translucent
 * preview materials, casting no shadow.
 */
export function buildBuildingMeshes(
  buildings: Iterable<Building>,
  groundAt: GroundAt,
  kit: BuildingKit,
  ghost = false,
): BuildingMeshes {
  const group = new Group();
  group.name = ghost ? 'building-preview' : 'buildings';
  const shell = new Shell();
  const parts = Object.fromEntries(PART_KINDS.map((k) => [k, [] as Placement[]])) as Record<PartKind, Placement[]>;
  for (const b of buildings) emitBuilding(b, groundAt, shell, parts);

  const meshes: (Mesh | InstancedMesh)[] = [];
  let triangles = 0;
  if (shell.triangles > 0) {
    const mesh = new Mesh(shell.geometry(), ghost ? kit.ghostShell : kit.shell);
    mesh.name = ghost ? 'building-preview-shell' : 'building-shell';
    mesh.castShadow = !ghost;
    mesh.receiveShadow = !ghost;
    meshes.push(mesh);
    triangles += shell.triangles;
  }
  for (const kind of PART_KINDS) {
    const mesh = instanced(
      `building-${kind}${ghost ? '-preview' : ''}`,
      kit.geometry[kind],
      ghost ? kit.ghostParts : kit.material[kind],
      parts[kind],
      !ghost && kit.castsShadow.has(kind),
      !ghost && kind === 'awning',
    );
    if (!mesh) continue;
    meshes.push(mesh);
    const g = kit.geometry[kind];
    const per = (g.index ? g.index.count : g.getAttribute('position').count) / 3;
    triangles += per * mesh.count;
  }
  for (const mesh of meshes) group.add(mesh);

  return {
    group,
    triangles,
    dispose() {
      for (const mesh of meshes) {
        // The shell geometry is this build's own; the part geometries are the kit's.
        if (!(mesh instanceof InstancedMesh)) mesh.geometry.dispose();
        else mesh.dispose();
      }
      group.clear();
    },
  };
}
