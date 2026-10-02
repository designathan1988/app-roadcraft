import earcut from 'earcut';
import clipping from 'polygon-clipping';
import { resolveBlocks } from '@world/buildings/blocks';
import { asPolygon, edgeFrame, localFootprint, volumeSides } from '@world/buildings/footprints';
import {
  BufferGeometry,
  Color,
  Float32BufferAttribute,
  Group,
  InstancedMesh,
  Mesh,
  Uint32BufferAttribute,
} from 'three';

import type { Vec2 } from '@core/vec2';
import { m } from '@world/units';
import {
  type Entrance,
  type Foundation,
  type GroundAt,
  type PavedAt,
  STEP_RUN,
  flightRun,
  foundationOf,
} from '@world/buildings/foundation';
import {
  type FacadeBay,
  SIDE_NORMAL,
  bayWidth,
  baysOn,
  coveredSpans,
  exposedParts,
  facadeBays,
  levelElevation,
  levelHeight,
  projectionRect,
  ridgeAlongX,
  roofRise,
  roofHeightAt,
  roofSlope,
  sawtoothRun,
  shedFall,
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
import { elementRect, onGround, stairSteps } from '@world/buildings/elements';
import {
  type BayComponent,
  type Building,
  type BuildingElement,
  type FacadeGeometry,
  type Relief,
  type FaceId,
  type Side,
  SIDES,
  type Volume,
  volumeTop,
  type LotSurface,
} from '@world/buildings/types';
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
function openingOf(component: BayComponent, W: number, H: number, geometry?: FacadeGeometry): Opening | null {
  let w: number;
  let h0: number;
  let h1: number;
  let depth = REVEAL;
  switch (component) {
    case 'window':
    case 'sashWindow':
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
  if (geometry && (component === 'window' || component === 'sashWindow' || component === 'wideWindow')) {
    if (geometry.windowWidth !== undefined) w = W * geometry.windowWidth;
    if (geometry.sill !== undefined) h0 = Math.min(geometry.sill, H - m(.65));
    if (geometry.windowHeight !== undefined) h1 = h0 + H * geometry.windowHeight;
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
/** Smooth 3D value noise, 0..1, for tone that drifts over a whole facade. */
function macroNoise(x: number, y: number, z: number): number {
  const hash = (i: number, j: number, k: number): number => {
    let h = Math.imul(i | 0, 0x27d4eb2d) ^ Math.imul(j | 0, 0x165667b1) ^ Math.imul(k | 0, 0x3c6ef372);
    h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
    return ((h ^ (h >>> 13)) >>> 0) / 4_294_967_296;
  };
  const x0 = Math.floor(x), y0 = Math.floor(y), z0 = Math.floor(z);
  const s = (t: number): number => t * t * (3 - 2 * t);
  const fx = s(x - x0), fy = s(y - y0), fz = s(z - z0);
  const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
  const plane = (k: number): number =>
    lerp(lerp(hash(x0, y0, k), hash(x0 + 1, y0, k), fx), lerp(hash(x0, y0 + 1, k), hash(x0 + 1, y0 + 1, k), fx), fy);
  return lerp(plane(z0), plane(z0 + 1), fz);
}

/** World units over which a facade's tone drifts. */
const MACRO_SCALE = m(12);
/** How far above the ground floor a wall's weathering at the base reaches. */
const GRIME_REACH = m(1.2);

class Shell {
  readonly parts = new Map<Finish, ShellPart>();
  /**
   * The ground floor's height for the building being emitted: walls darken
   * towards it (splash and dirt at the base), which also seats the building
   * on the ground. NaN turns it off.
   */
  ground = Number.NaN;

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
    const wall = Math.abs(wz) < 0.5;
    points.forEach(([x, y, z], i) => {
      const q = three[i] as readonly [number, number, number];
      part.position.push(q[0], q[1], q[2]);
      part.normal.push(nx, ny, nz);
      // No two stretches of wall quite the same tone, and the base weathered.
      let tone = 0.97 + macroNoise(x / MACRO_SCALE, y / MACRO_SCALE, z / MACRO_SCALE) * 0.06;
      if (wall && Number.isFinite(this.ground)) {
        const t = Math.min(1, Math.max(0, (z - this.ground) / GRIME_REACH));
        tone *= 0.8 + 0.2 * t * t * (3 - 2 * t);
      }
      part.colour.push(c.rgb[0] * tone, c.rgb[1] * tone, c.rgb[2] * tone);
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

/**
 * The frame of a face of `side`, starting `along` units from the side's
 * start, its plane `push` units out from the side (negative: set back).
 */
function sideFrame(v: Volume, side: FaceId, along: number, push = 0): Pick<BayFace, 'ax' | 'ay' | 'tx' | 'ty' | 'nx' | 'ny'> {
  const s = sideStart(v, side);
  const edge = edgeFrame(v, side);
  const n = { x: edge.nx, y: edge.ny };
  return { ax: s.x + s.tx * along + n.x * push, ay: s.y + s.ty * along + n.y * push, tx: s.tx, ty: s.ty, nx: n.x, ny: n.y };
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
  shell.ground = floor;
  const entranceKey = (volume: number, side: FaceId, index: number): string => `${volume}:${side}:${index}`;
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
  const wallOf = (v: Volume, side: FaceId, storey?: number): Paint => paint(wallMaterial(b, v, side, storey), shade);
  // Mouldings - bands, cornices, copings, reveals - are smooth: a finish with
  // a pattern (formwork ties, courses) repeated along a moulding reads as rivets.
  const trimSpec = trimMaterial(b);
  const trim = paint({ finish: trimSpec.finish === 'metal' ? 'metal' : 'plaster', colour: trimSpec.colour });
  const plinth = paint(plinthMaterial(b));
  const awning = new Color().setHex(paletteOf(b).awning);

  // ---- plinth: from below the lowest ground up to the floor, notched where
  // a flight of steps is set into the building
  for (const v of b.volumes) {
    if (v.base !== 0) continue;
    const notches = new Map<FaceId, { a0: number; a1: number; recess: number }[]>();
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
    // A projection standing on the ground stands on the plinth too.
    for (const r of v.reliefs ?? []) {
      const rect = r.storey0 === 0 ? projectionRect(b, v, r) : null;
      if (!rect) continue;
      const g = PLINTH_GROW;
      if (v.outline) {
        const frame = edgeFrame(v, r.side), width = bayWidth(b, v, r.side);
        const a0 = r.bay0 * width - g, a1 = (r.bay1 + 1) * width + g;
        const at = (a: number, depth: number, z: number): V3 =>
          e.L(frame.x + frame.tx * a + frame.nx * depth, frame.y + frame.ty * a + frame.ny * depth, z);
        e.shell.face([at(a0, r.depth + g, f.bottom), at(a1, r.depth + g, f.bottom), at(a1, r.depth + g, floor), at(a0, r.depth + g, floor)], e.N(frame.nx, frame.ny), plinth);
        e.shell.face([at(a0, -g, floor), at(a1, -g, floor), at(a1, r.depth + g, floor), at(a0, r.depth + g, floor)], [0, 0, 1], plinth);
      } else {
        e.box(rect[0] - g, rect[1] - g, rect[2] + g, rect[3] + g, f.bottom, floor, plinth);
      }
    }
  }

  // ---- facades, bay by bay: only outside walls are in `bays`
  const componentAt = new Map<string, BayComponent>();
  for (const bay of bays) componentAt.set(`${bay.volume}:${bay.level}:${bay.side}:${bay.index}`, bay.component);
  const volumes = new Map(b.volumes.map((v) => [v.id, v]));
  for (const bay of bays) {
    const v = volumes.get(bay.volume) as Volume;
    const face: BayFace = { ...sideFrame(v, bay.side, bay.start, bay.push), z0: floor + bay.z, W: bay.width, H: bay.height };
    const left = componentAt.get(`${bay.volume}:${bay.level}:${bay.side}:${bay.index - 1}`);
    const right = componentAt.get(`${bay.volume}:${bay.level}:${bay.side}:${bay.index + 1}`);
    const recess = bay.level === 0 ? entrances.get(entranceKey(bay.volume, bay.side, bay.index))?.recess ?? 0 : 0;
    const composition = v.storeys[bay.storey]?.facade;
    const grammar = composition?.patterns?.[bay.side] ?? composition?.pattern ?? v.facadePattern;
    const controls = v.facadeGeometry?.[bay.side];
    if (grammar === 'observation' && bay.component === 'wideWindow') {
      const mullion = Math.min(m(0.12), face.W * .12);
      const head = Math.min(m(0.25), face.H * .12);
      const glass = paint({ finish: 'glass', colour: 0x526b73 });
      const frame = paint({ finish: 'metal', colour: 0xd5d5ca });
      e.rect(face, mullion, face.W - mullion, head, face.H - head, -m(.11), e.N(face.nx, face.ny), glass);
      e.rect(face, 0, mullion, 0, face.H, -m(.16), e.N(face.nx, face.ny), frame);
      e.rect(face, face.W - mullion, face.W, 0, face.H, -m(.16), e.N(face.nx, face.ny), frame);
      e.rect(face, 0, face.W, 0, head, -m(.16), e.N(face.nx, face.ny), frame);
      e.rect(face, 0, face.W, face.H - head, face.H, -m(.16), e.N(face.nx, face.ny), frame);
      continue;
    }
    emitBay(e, face, bay, wallOf(v, bay.side, bay.storey), trim, awning, left === 'pillar', right === 'pillar', recess, controls);
    const ribDepth = controls?.pierDepth ?? (grammar === 'artDecoCrown' ? m(.65) : grammar === 'artDeco' ? m(.3) : 0);
    if (ribDepth > 0 && bay.index % (controls?.pierEvery ?? 1) === 0) {
      // Shallow, continuous-looking stone pilasters give every mass a vertical
      // rhythm while retaining individually editable windows and wall bays.
      const width = Math.min(controls?.pierWidth ?? (grammar === 'artDecoCrown' ? m(.65) : m(.36)), face.W * .3);
      const a0 = width * 0.35, a1 = a0 + width;
      const depth = -ribDepth;
      const stone = paint({ finish: 'plaster', colour: 0xd9d4c5 });
      e.rect(face, a0, a1, 0, face.H, depth, e.N(face.nx, face.ny), stone);
      e.jamb(face, a0, 0, face.H, 0, depth, e.N(-face.tx, -face.ty), stone);
      e.jamb(face, a1, 0, face.H, depth, 0, e.N(face.tx, face.ty), stone);
    }
  }

  // ---- reliefs: the cheeks, head and sill of every face region pushed in or out
  for (const v of b.volumes) {
    for (const r of v.reliefs ?? []) emitRelief(e, b, v, r, floor, wallOf(v, r.side, r.storey0), trim);
  }

  // ---- storey bands and cornices, per volume
  for (const v of b.volumes) {
    for (let k = 1; k < v.storeys.length; k++) {
      const level = v.base + k;
      if (level === 0) continue;
      band(e, v, floor + levelElevation(b, level), BAND_OUT, BAND_H, trim);
    }
  }

  // ---- roofs (none over a floor cut open to look inside)
  for (const v of b.volumes) {
    if (b.cutaway !== undefined && volumeTop(v) === b.cutaway + 1) continue;
    emitRoof(e, b, v, floor, (side) => wallOf(v, side), trim, paint(roofMaterial(b, v)));
    emitRoofDetails(e, b, v, floor);
  }
  if (b.cutaway !== undefined) emitInterior(e, b, floor, b.cutaway);

  // ---- entrance steps: outside, down to the ground in front, or set into
  // the building where the paving leaves no room for them
  for (const entrance of f.entrances) {
    if (entrance.steps <= 0) continue;
    const v = volumes.get(entrance.volume) as Volume;
    const frame = sideFrame(v, entrance.side, entranceStart(entrance, v), entrance.push);
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

  // ---- the lot: a paved apron round the base, and a path to the street
  emitLot(e, b, f, groundAt, pavedAt);

  // ---- free elements: stairs, ramps, pillars, canopies, walls, slabs
  for (const el of b.elements ?? []) {
    const look = el.material ? paint(el.material) : elementPaint(b, el.kind);
    emitElement(e, el, floor, f.bottom, look);
  }

  // ---- cores: a lift overrun on the highest flat roof over the core
  const u = b.module;
  // Cut open, the shafts are seen from inside: no machine room over them.
  for (const core of b.cutaway === undefined ? b.cores : []) {
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

const FLOOR_FINISH = paint({ finish: 'stone', colour: 0xd8d2c6 });
const SHAFT = paint({ finish: 'concrete', colour: 0xb9b6ae });
const CAB = paint({ finish: 'metal', colour: 0x9aa3a8 });
const STEP = paint({ finish: 'stone', colour: 0xc9c2b3 });
const DESK = paint({ finish: 'wood', colour: 0x6e4a32 });

/**
 * Inside a building cut open at level `cut` (the Construction tool's interior
 * view): the floor of that level, and the cores - lift shafts with the car
 * at that floor, stair shafts with their flight - and on the ground floor the
 * lobby's desk. These are the places people will walk through: entrance,
 * lobby, core, floor.
 */
function emitInterior(e: Emitter, b: Building, floor: number, cut: number): void {
  const z = floor + levelElevation(b, cut);
  for (const v of b.volumes) {
    if (v.mode === 'void' || v.mode === 'intersect') continue;
    if (!(v.base <= cut && volumeTop(v) > cut)) continue;
    const flat = localFootprint(v).flatMap((p) => [p.x, p.y]);
    const triangles = earcut(flat);
    for (let i = 0; i < triangles.length; i += 3) {
      const p = [triangles[i]!, triangles[i + 1]!, triangles[i + 2]!].map((k) => e.L(flat[2 * k]!, flat[2 * k + 1]!, z + 0.04));
      e.shell.face(p as [V3, V3, V3], [0, 0, 1], FLOOR_FINISH);
    }
  }
  const u = b.module;
  const wall = m(0.2);
  const top = floor + levelElevation(b, cut + 1) - m(0.3);
  for (const core of b.cores) {
    if (core.from > cut || core.to < cut) continue;
    const w = core.kind === 'stair' ? u * 2 : u;
    const x0 = core.x, y0 = core.y, x1 = core.x + w, y1 = core.y + u;
    const z0 = floor + levelElevation(b, core.from);
    // The shaft: four walls, the front one with a doorway at this floor.
    e.box(x0, y1 - wall, x1, y1, z0, top, SHAFT);
    e.box(x0, y0, x0 + wall, y1, z0, top, SHAFT);
    e.box(x1 - wall, y0, x1, y1, z0, top, SHAFT);
    const door = Math.min(w * 0.5, m(1.2));
    const mid = (x0 + x1) / 2;
    e.box(x0, y0, mid - door / 2, y0 + wall, z0, top, SHAFT);
    e.box(mid + door / 2, y0, x1, y0 + wall, z0, top, SHAFT);
    e.box(mid - door / 2, y0, mid + door / 2, y0 + wall, z + m(2.2), top, SHAFT);
    if (core.kind === 'lift' || core.kind === 'stairLift') {
      // The car, standing at this floor.
      e.box(x0 + wall + m(0.1), y0 + wall + m(0.1), x1 - wall - m(0.1), y1 - wall - m(0.1), z + 0.05, z + m(2.3), CAB);
    }
    if (core.kind === 'stair' || core.kind === 'stairLift') {
      // A flight rising along the back of the shaft, and the landing.
      const steps = 12;
      const run = (x1 - x0 - 2 * wall) / steps;
      const rise = levelHeight(b, cut) / steps;
      for (let k = 0; k < steps; k++) {
        const sx = x0 + wall + k * run;
        e.box(sx, y0 + (y1 - y0) / 2, sx + run, y1 - wall, z, z + rise * (k + 1), STEP);
      }
    }
  }
  if (cut === 0) {
    // The lobby: a desk facing the way in, across the middle of the front.
    const ground = b.volumes.filter((v) => v.base === 0 && !v.mode);
    if (ground.length > 0) {
      const x0 = Math.min(...ground.map((v) => v.x));
      const x1 = Math.max(...ground.map((v) => v.x + v.w));
      const y0 = Math.min(...ground.map((v) => v.y));
      const cx = (x0 + x1) / 2;
      const dy = y0 + m(6);
      e.box(cx - m(2), dy, cx + m(2), dy + m(0.8), z, z + m(1.1), DESK);
    }
  }
}

/** How much light a window reveal keeps: it sits in the wall's own shadow. */
const REVEAL_SHADE = 0.68;

const shaded = (c: Paint, k: number): Paint => ({ rgb: [c.rgb[0] * k, c.rgb[1] * k, c.rgb[2] * k], finish: c.finish });

/** A stable number per bay, for choosing among window variants. */
function bayHash(bay: FacadeBay): number {
  let h = Math.imul(bay.volume + 1, 0x27d4eb2d) ^ Math.imul(bay.level + 7, 0x165667b1) ^ Math.imul(bay.side + 3, 0x3c6ef372) ^ Math.imul(bay.index + 11, 0x85ebca6b);
  h ^= Math.imul(Math.round(bay.x * 7), 0x2c1b3c6d) ^ Math.imul(Math.round(bay.y * 7), 0x297a2d39);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  return (h ^ (h >>> 13)) >>> 0;
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
  geometry?: FacadeGeometry,
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

  const found = openingOf(bay.component, W, H, geometry);
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
  // The reveals are in the wall's shadow: darkened here, so a recess reads as
  // one even where the ambient occlusion pass is off (the lower tiers).
  const reveal = shaded(recess > 0 ? wall : trim, REVEAL_SHADE);
  e.jamb(f, o.a0, o.h0, o.h1, 0, o.depth, along, reveal);
  e.jamb(f, o.a1, o.h0, o.h1, 0, o.depth, back, reveal);
  if (recess <= 0) e.strip(f, o.a0, o.a1, o.h0, 0, o.depth, [0, 0, 1], shaded(trim, 0.92));
  e.strip(f, o.a0, o.a1, o.h1, 0, o.depth, [0, 0, -1], shaded(reveal, 0.8));

  const w = o.a1 - o.a0;
  const h = o.h1 - o.h0;
  const am = (o.a0 + o.a1) / 2;
  const hm = (o.h0 + o.h1) / 2;
  switch (bay.component) {
    case 'window':
    case 'sashWindow': {
      // No two rows alike: some rooms darker, some curtained, some with the
      // roller shutter part way down - picked from the bay, so stable.
      const pick = bay.component === 'sashWindow' ? 13 : bayHash(bay) % 20;
      e.put(pick < 5 ? 'glassDark' : 'glass', f, am, hm, o.depth, w, h, 1);
      if (pick >= 5 && pick < 9) {
        const side = w * 0.26;
        e.put('curtain', f, o.a0 + side / 2, hm, o.depth - m(0.015), side, h, m(0.01));
        e.put('curtain', f, o.a1 - side / 2, hm, o.depth - m(0.015), side, h, m(0.01));
      } else if (pick >= 9 && pick < 13) {
        const down = h * (0.25 + (pick - 9) * 0.15);
        e.put('shutter', f, am, o.h1 - down / 2, o.depth - m(0.05), w, down, m(0.04));
      }
      e.put('frame', f, am, hm, o.depth - m(0.03), w, h, m(0.06));
      // The sill: out past the wall, with a drip.
      e.put('concrete', f, am, o.h0 - m(0.03), (o.depth - m(0.07)) / 2, w + m(0.14), m(0.06), o.depth + m(0.07));
      break;
    }
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
      if (bay.level === 0) {
        // A canopy over the door: a slab with a fascia at its edge (a drip),
        // and two brackets under it into the wall.
        e.put('concrete', f, am, o.h1 + m(0.3), -m(0.45), w + m(0.7), m(0.12), m(0.9));
        e.put('concrete', f, am, o.h1 + m(0.26), -m(0.88), w + m(0.7), m(0.2), m(0.05));
        for (const side of [-1, 1]) e.put('frame', f, am + side * (w / 2 + m(0.2)), o.h1 + m(0.12), -m(0.25), m(0.06), m(0.3), m(0.5));
      }
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
  notches: ReadonlyMap<FaceId, readonly { a0: number; a1: number; recess: number }[]>,
): void {
  const g = PLINTH_GROW;
  if (v.outline) {
    for (const side of volumeSides(v)) {
      const f = edgeFrame(v, side);
      const at = (a: number, depth: number, z: number): V3 => e.L(f.x + f.tx * a - f.nx * depth, f.y + f.ty * a - f.ny * depth, z);
      const n = e.N(f.nx, f.ny);
      const t = e.N(f.tx, f.ty);
      const cuts = [...(notches.get(side) ?? [])].sort((a, b) => a.a0 - b.a0);
      let from = 0;
      const wallTo = (to: number): void => {
        if (to - from < 1e-4) return;
        e.shell.face([at(from, -g, bottom), at(to, -g, bottom), at(to, -g, floor), at(from, -g, floor)], n, c);
        e.shell.face([at(from, -g, floor), at(to, -g, floor), at(to, g, floor), at(from, g, floor)], [0, 0, 1], c);
      };
      for (const cut of cuts) {
        wallTo(cut.a0);
        const depth = g + cut.recess;
        e.shell.face([at(cut.a0, -g, bottom), at(cut.a0, depth, bottom), at(cut.a0, depth, floor), at(cut.a0, -g, floor)], t, c);
        e.shell.face([at(cut.a1, depth, bottom), at(cut.a1, -g, bottom), at(cut.a1, -g, floor), at(cut.a1, depth, floor)], [-t[0], -t[1], 0], c);
        from = cut.a1;
      }
      wallTo(f.length);
    }
    return;
  }
  const x0 = v.x - g;
  const y0 = v.y - g;
  const x1 = v.x + v.w + g;
  const y1 = v.y + v.d + g;
  for (const side of volumeSides(v)) {
    // The side as a line in the plan: where it runs along its axis and where it stands across it.
    const alongX = side === 0 || side === 2;
    const lo = alongX ? x0 : y0;
    const hi = alongX ? x1 : y1;
    const at = side === 0 ? y0 : side === 1 ? x1 : side === 2 ? y1 : x0;
    const inward = side === 0 || side === 3 ? 1 : -1;
    const point = (a: number, depth: number, z: number): V3 =>
      alongX ? e.L(a, at + inward * depth, z) : e.L(at + inward * depth, a, z);
    const edge = edgeFrame(v, side);
    const n = { x: edge.nx, y: edge.ny };
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

/**
 * The frame of a relief: its two cheeks and its head and sill, between the
 * side's plane and the region's (whose bays the facade loop already drew,
 * pushed). A projection's head is a cap and its sill a soffit; a recess's are
 * a ceiling and a floor.
 */
function emitRelief(e: Emitter, b: Building, v: Volume, r: Relief, floor: number, wall: Paint, trim: Paint): void {
  const count = baysOn(b, v, r.side);
  const top = v.storeys.length - 1;
  if (r.depth === 0 || r.bay0 > count - 1 || r.storey0 > top) return;
  const w = bayWidth(b, v, r.side);
  const a0 = Math.max(0, r.bay0) * w;
  const a1 = (Math.min(count - 1, r.bay1) + 1) * w;
  const z0 = floor + levelElevation(b, v.base + Math.max(0, r.storey0));
  const z1 = floor + levelElevation(b, v.base + Math.min(top, r.storey1) + 1);
  const s = sideStart(v, r.side);
  const f = edgeFrame(v, r.side);
  const n = { x: f.nx, y: f.ny };
  const d = r.depth;
  const P = (a: number, z: number, out: number): V3 => e.L(s.x + s.tx * a + n.x * out, s.y + s.ty * a + n.y * out, z);
  const t = e.N(s.tx, s.ty);
  const into: V3 = [-t[0], -t[1], 0];
  const out = d > 0;
  // Cheeks: facing away from the region on a projection, into it on a recess.
  e.shell.face([P(a0, z0, 0), P(a0, z0, d), P(a0, z1, d), P(a0, z1, 0)], out ? into : t, wall);
  e.shell.face([P(a1, z0, d), P(a1, z0, 0), P(a1, z1, 0), P(a1, z1, d)], out ? t : into, wall);
  e.shell.face([P(a0, z1, 0), P(a1, z1, 0), P(a1, z1, d), P(a0, z1, d)], [0, 0, out ? 1 : -1], trim);
  e.shell.face([P(a0, z0, 0), P(a1, z0, 0), P(a1, z0, d), P(a0, z0, d)], [0, 0, out ? -1 : 1], trim);
}

/**
 * What stands on a flat roof: a water tank on a plinth and a roof hatch, in a
 * corner picked from the building's id (so a street is not a row of copies),
 * on roofs big enough to walk on.
 */
function emitRoofPlant(e: Emitter, b: Building, v: Volume, z: number, trim: Paint): void {
  if (v.roofDetails?.length) return;
  // Drains in two opposite corners, where the roof's fall takes the water.
  if (v.outline) return;
  for (const [dx, dy] of [[m(0.7), m(0.7)], [v.w - m(0.7), v.d - m(0.7)]] as const) {
    const x = v.x + dx;
    const y = v.y + dy;
    e.box(x - m(0.18), y - m(0.18), x + m(0.18), y + m(0.18), z, z + 0.02, DRAIN);
  }
  if (v.outline || v.w < m(6) || v.d < m(6)) return;
  const pick = ((b.id * 2654435761 + v.id * 40503) >>> 0) % 4;
  const inset = m(1.4);
  const tank = m(2.2);
  const cx = pick % 2 === 0 ? v.x + inset + tank / 2 : v.x + v.w - inset - tank / 2;
  const cy = pick < 2 ? v.y + v.d - inset - tank / 2 : v.y + inset + tank / 2;
  // The water tank on its plinth, with a lid proud of it and a hatch in the lid.
  e.box(cx - tank / 2 - m(0.15), cy - tank / 2 - m(0.15), cx + tank / 2 + m(0.15), cy + tank / 2 + m(0.15), z, z + m(0.3), ROOF_PLANT);
  e.box(cx - tank / 2, cy - tank / 2, cx + tank / 2, cy + tank / 2, z + m(0.3), z + m(1.8), trim);
  e.box(cx - tank / 2 - m(0.06), cy - tank / 2 - m(0.06), cx + tank / 2 + m(0.06), cy + tank / 2 + m(0.06), z + m(1.8), z + m(1.9), ROOF_PLANT);
  e.box(cx - m(0.3), cy - m(0.3), cx + m(0.3), cy + m(0.3), z + m(1.9), z + m(1.98), shaded(ROOF_PLANT, 0.8));
  // The roof hatch, diagonally across from the tank.
  const hx = pick % 2 === 0 ? v.x + v.w - m(2.4) : v.x + m(1.6);
  const hy = pick < 2 ? v.y + m(1.6) : v.y + v.d - m(2.4);
  e.box(hx, hy, hx + m(0.8), hy + m(0.8), z, z + m(0.45), ROOF_PLANT);
  // Two air-conditioning condensers on a rail, with their fan grilles, on
  // roofs with room for them.
  if (v.w >= m(9) && v.d >= m(7)) {
    const ux = pick % 2 === 0 ? v.x + v.w - m(1.4) : v.x + m(1.4);
    const uy = v.y + v.d / 2;
    for (const k of [-1, 1]) {
      const y = uy + k * m(0.65);
      e.box(ux - m(0.45), y - m(0.4), ux + m(0.45), y + m(0.4), z + m(0.15), z + m(0.85), CONDENSER);
      e.box(ux - m(0.28), y - m(0.28), ux + m(0.28), y + m(0.28), z + m(0.85), z + m(0.87), DRAIN);
    }
  }
  // A lift's machine room, with its door, on a building tall enough for one.
  if (v.storeys.length + v.base >= 4 && b.cores.length === 0) {
    const mx = v.x + v.w / 2;
    const my = v.y + v.d / 2;
    e.box(mx - m(1.3), my - m(1.3), mx + m(1.3), my + m(1.3), z, z + m(2.5), trim, ROOF_PLANT);
    e.box(mx - m(0.45), my - m(1.34), mx + m(0.45), my - m(1.3), z + m(0.05), z + m(2.1), DOOR_PAINT);
  }
}

const DRAIN: Paint = paint({ finish: 'metal', colour: 0x2d3033 });
const CONDENSER: Paint = paint({ finish: 'metal', colour: 0xc9ccc9 });
const DOOR_PAINT: Paint = paint({ finish: 'metal', colour: 0x5c6468 });

const LOT_PAINT: Readonly<Record<LotSurface, Paint>> = {
  grass: paint({ finish: 'concrete', colour: 0x6f9a4c }),
  paving: paint({ finish: 'stone', colour: 0xc4beb2 }),
  gravel: paint({ finish: 'concrete', colour: 0xa9a294 }),
  sand: paint({ finish: 'plaster', colour: 0xe2cf9c }),
  water: paint({ finish: 'glass', colour: 0x4f8fb3 }),
};
const LOT_KERB = paint({ finish: 'stone', colour: 0xb3ada0 });

/**
 * The open blocks of a building, laid on the ground: a plate of grass,
 * paving, gravel, sand or water on a low kerb, over the highest ground under
 * it. When the building is only lots, its free parts (trees, benches, paths,
 * fences) stand on them here.
 */
function emitLots(b: Building, lots: readonly Volume[], withParts: boolean, groundAt: GroundAt, shell: Shell,
  parts: Record<PartKind, Placement[]>): void {
  if (lots.length === 0) return;
  const e = new Emitter(b, shell, parts);
  const at = (lx: number, ly: number): number => {
    const w = e.L(lx, ly, 0);
    return groundAt(w[0], w[1]);
  };
  let floor = -Infinity;
  for (const v of lots) {
    for (const p of localFootprint(v)) floor = Math.max(floor, at(p.x, p.y));
    floor = Math.max(floor, at(v.x + v.w / 2, v.y + v.d / 2));
  }
  const top = floor + m(0.12);
  let low = Infinity;
  for (const v of lots) for (const p of localFootprint(v)) low = Math.min(low, at(p.x, p.y));
  for (const v of lots) {
    const ring = localFootprint(v);
    const flat = ring.flatMap((p) => [p.x, p.y]);
    const triangles = earcut(flat);
    const look = LOT_PAINT[v.open ?? 'grass'] ?? LOT_KERB;
    // Water sits a little lower, inside its kerb.
    const z = v.open === 'water' ? top - m(0.25) : top;
    for (let i = 0; i < triangles.length; i += 3) {
      const p = [triangles[i]!, triangles[i + 1]!, triangles[i + 2]!].map((k) => e.L(flat[2 * k]!, flat[2 * k + 1]!, z));
      shell.face(p as [V3, V3, V3], [0, 0, 1], look);
    }
    // The kerb round it, down to the lowest ground.
    for (let i = 0; i < ring.length; i++) {
      const p = ring[i]!;
      const q = ring[(i + 1) % ring.length]!;
      const len = Math.hypot(q.x - p.x, q.y - p.y) || 1;
      const nx = (q.y - p.y) / len;
      const ny = -(q.x - p.x) / len;
      shell.face([e.L(p.x, p.y, low - m(0.3)), e.L(q.x, q.y, low - m(0.3)), e.L(q.x, q.y, top), e.L(p.x, p.y, top)], e.N(nx, ny), LOT_KERB);
    }
  }
  if (withParts) {
    for (const el of b.elements ?? []) {
      const look = el.material ? paint(el.material) : elementPaint(b, el.kind);
      emitElement(e, el, top, low - m(0.3), look);
    }
  }
}

const ELEMENT_CONCRETE: Paint = paint({ finish: 'concrete', colour: 0xcfcac0 });

/** What an element is made of until the player says otherwise. */
function elementPaint(b: Building, kind: BuildingElement['kind']): Paint {
  switch (kind) {
    case 'canopy': return ELEMENT_CONCRETE;
    case 'wall': return paint(paletteOf(b).wall);
    case 'stair':
    case 'ramp':
    case 'pavement': return PAVING;
    case 'fence': return paint({ finish: 'metal', colour: 0x4b5153 });
    case 'tree': return TRUNK;
    case 'bench': return paint({ finish: 'wood', colour: 0x8a6a45 });
    case 'ac': return paint({ finish: 'metal', colour: 0xd7dade });
    case 'planter': return paint({ finish: 'concrete', colour: 0xb9b3a8 });
    default: return ELEMENT_CONCRETE;
  }
}

const CLOCK_FACE = paint({ finish: 'plaster', colour: 0xf4f1e8 });
const CLOCK_INK = paint({ finish: 'metal', colour: 0x23272b });

/**
 * A facade clock: a pale dial on a dark rim, twelve marks and two hands
 * standing just proud of it, on whichever side the element faces.
 */
function emitClock(e: Emitter, el: BuildingElement, x0: number, y0: number, x1: number, y1: number, z0: number, z1: number): void {
  e.box(x0, y0, x1, y1, z0, z1, CLOCK_INK);
  const along = el.facing === 0 || el.facing === 2;
  const a0 = along ? x0 : y0;
  const a1 = along ? x1 : y1;
  // The front plane and the way out of it.
  const front = el.facing === 0 ? y0 : el.facing === 2 ? y1 : el.facing === 1 ? x1 : x0;
  const out = el.facing === 0 || el.facing === 3 ? -1 : 1;
  const size = Math.min(a1 - a0, z1 - z0);
  const ca = (a0 + a1) / 2;
  const cz = (z0 + z1) / 2;
  const layer = (u0: number, u1: number, h0: number, h1: number, d0: number, d1: number, c: Paint): void => {
    const p0 = front + out * d0;
    const p1 = front + out * d1;
    if (along) e.box(u0, Math.min(p0, p1), u1, Math.max(p0, p1), h0, h1, c);
    else e.box(Math.min(p0, p1), u0, Math.max(p0, p1), u1, h0, h1, c);
  };
  const r = size * 0.42;
  layer(ca - r, ca + r, cz - r, cz + r, 0, m(0.04), CLOCK_FACE);
  for (let k = 0; k < 12; k++) {
    const a = (k / 12) * Math.PI * 2;
    const ua = ca + Math.sin(a) * r * 0.82;
    const uz = cz + Math.cos(a) * r * 0.82;
    const t = size * (k % 3 === 0 ? 0.05 : 0.03);
    layer(ua - t, ua + t, uz - t, uz + t, m(0.04), m(0.07), CLOCK_INK);
  }
  const w = size * 0.03;
  layer(ca - w, ca + w, cz, cz + r * 0.55, m(0.07), m(0.1), CLOCK_INK);
  layer(ca, ca + r * 0.78, cz - w, cz + w, m(0.1), m(0.12), CLOCK_INK);
}

/**
 * One free element. A stair is a block per step, every riser the same; a
 * ramp a slope with its cheeks; the rest are boxes. Whatever stands on the
 * ground reaches down to the plinth's bottom, so it meets sloping land.
 */
function emitElement(e: Emitter, el: BuildingElement, floor: number, bottom: number, c: Paint): void {
  const [x0, y0, x1, y1] = elementRect(el);
  const zb = onGround(el) ? bottom : floor + el.z;
  const z0 = floor + el.z;
  const z1 = z0 + el.h;
  if (el.kind === 'clock') {
    emitClock(e, el, x0, y0, x1, y1, z0, z1);
    return;
  }
  if (el.kind === 'stair' || el.kind === 'ramp') {
    // The run measured from the foot (the `facing` end) inwards.
    const sub = (u0: number, u1: number): [number, number, number, number] => {
      switch (el.facing) {
        case 0: return [x0, y0 + u0, x1, y0 + u1];
        case 2: return [x0, y1 - u1, x1, y1 - u0];
        case 3: return [x0 + u0, y0, x0 + u1, y1];
        default: return [x1 - u1, y0, x1 - u0, y1];
      }
    };
    if (el.kind === 'stair' && el.angle) {
      // A stair laid along a traced path: its own frame is turned, so the run
      // follows the line it was drawn on and turns with it.
      emitTurnedStair(e, el, z0, zb, c);
      return;
    }
    if (el.kind === 'stair') {
      const n = stairSteps(el);
      const tread = el.d / n;
      // A low flight is solid, like steps cast in place.
      if (el.h <= STAIR_SOLID) {
        for (let k = 0; k < n; k++) {
          const [a0, b0, a1, b1] = sub(k * tread, (k + 1) * tread);
          e.box(a0, b0, a1, b1, zb, z0 + ((k + 1) * el.h) / n, c);
        }
        // Three steps up to a door without a rail read as a heap of blocks:
        // a flight taller than a kerb carries its handrail too.
        if (el.h > m(0.5)) emitStairRails(e, el, [x0, y0, x1, y1], z0);
        return;
      }
      emitOpenStair(e, el, [x0, y0, x1, y1], z0, zb, c);
      return;
    }
    // A ramp: its slope, rising from the foot, over two cheeks.
    const foot = sub(0, 0);
    const head = sub(el.d, el.d);
    const [fa0, fb0, fa1, fb1] = foot;
    const [ha0, hb0, ha1, hb1] = head;
    const nf = SIDE_NORMAL[el.facing];
    const slope = el.h / el.d;
    const alongX = el.facing === 1 || el.facing === 3;
    const footPts: [V3, V3] = alongX ? [e.L(fa0, fb0, z0), e.L(fa0, fb1, z0)] : [e.L(fa0, fb0, z0), e.L(fa1, fb0, z0)];
    const headPts: [V3, V3] = alongX ? [e.L(ha0, hb0, z1), e.L(ha0, hb1, z1)] : [e.L(ha0, hb0, z1), e.L(ha1, hb0, z1)];
    e.shell.face([footPts[0], footPts[1], headPts[1], headPts[0]], e.N(nf.x * slope, nf.y * slope, 1), c);
    const cheek = (i: 0 | 1, n: V3): void => {
      const f = footPts[i];
      const h = headPts[i];
      e.shell.face([[f[0], f[1], zb], [h[0], h[1], zb], h, f], n, c);
    };
    const t = alongX ? e.N(0, 1) : e.N(1, 0);
    cheek(0, [-t[0], -t[1], 0]);
    cheek(1, t);
    e.shell.face([[footPts[0][0], footPts[0][1], zb], [footPts[1][0], footPts[1][1], zb], footPts[1], footPts[0]], e.N(nf.x, nf.y), c);
    e.shell.face([[headPts[0][0], headPts[0][1], zb], [headPts[1][0], headPts[1][1], zb], headPts[1], headPts[0]], e.N(-nf.x, -nf.y), c);
    return;
  }
  if (el.kind === 'tree') {
    emitTree(e, el, z0, bottom);
    return;
  }
  if (el.kind === 'railing') {
    emitFence(e, el, z0, z1, c, true);
    return;
  }
  if (el.kind === 'flowers') {
    emitFlowers(e, el, z0, zb);
    return;
  }
  if (el.kind === 'rocks') {
    emitRocks(e, el, z0, zb, c);
    return;
  }
  if (el.kind === 'parking') {
    emitParking(e, el, z0);
    return;
  }
  if (el.kind === 'awning') {
    // A canvas falling from the wall to its free edge, with a valance.
    const drop = el.h;
    const free = sub2(el, [x0, y0, x1, y1], 0.92, 1);
    const n = SIDE_NORMAL[el.facing];
    e.box(x0, y0, x1, y1, z0 - drop * 0.55, z0 + drop * 0.1, shadeOf(el));
    e.box(free[0], free[1], free[2], free[3], z0 - drop * 0.8, z0 - drop * 0.45, shadeOf(el));
    void n;
    return;
  }
  if (el.kind === 'fence') {
    emitFence(e, el, z0, z1, c);
    return;
  }
  if (el.kind === 'bench') {
    // A seat on two legs and a back, facing the way it faces.
    e.box(x0, y0, x1, y1, z0 + m(0.35), z0 + m(0.45), c);
    const back = sub2(el, [x0, y0, x1, y1], 0, 0.12);
    e.box(back[0], back[1], back[2], back[3], z0 + m(0.45), z0 + m(0.95), c);
    for (const u of [0.15, 0.85]) {
      const leg = sub2(el, [x0, y0, x1, y1], u - 0.06, u + 0.06);
      e.box(leg[0], leg[1], leg[2], leg[3], zb, z0 + m(0.35), shaded(c, 0.85));
    }
    return;
  }
  if (el.kind === 'ac') {
    // A wall unit: the case, and a grille plate on the side it faces.
    e.box(x0, y0, x1, y1, z0, z1, c);
    const g = sub2(el, [x0, y0, x1, y1], 0, 0.09);
    e.box(g[0], g[1], g[2], g[3], z0 + m(0.1), z1 - m(0.06), RAIL);
    return;
  }
  if (el.kind === 'planter') {
    e.box(x0, y0, x1, y1, zb, z1, c);
    const soil = m(0.06);
    e.box(x0 + soil, y0 + soil, x1 - soil, y1 - soil, z1 - m(0.05), z1 + m(0.02), PLANTER_SOIL);
    return;
  }
  if (el.kind === 'canopy') {
    // A cantilevered slab: a fascia down its free edge (the drip) and two
    // steel brackets under it back to the wall.
    e.box(x0, y0, x1, y1, z0, z1, c);
    const n = SIDE_NORMAL[el.facing];
    const lip = m(0.05);
    const [lx0, ly0, lx1, ly1] = el.facing === 0 ? [x0, y0, x1, y0 + lip] : el.facing === 2 ? [x0, y1 - lip, x1, y1] : el.facing === 3 ? [x0, y0, x0 + lip, y1] : [x1 - lip, y0, x1, y1];
    e.box(lx0 - Math.abs(n.y) * lip, ly0 - Math.abs(n.x) * lip, lx1 + Math.abs(n.y) * lip, ly1 + Math.abs(n.x) * lip, z0 - m(0.12), z1, shaded(c, 0.95));
    const across = el.facing === 0 || el.facing === 2;
    for (const t of [0.15, 0.85]) {
      const bx = across ? x0 + (x1 - x0) * t : (x0 + x1) / 2;
      const by = across ? (y0 + y1) / 2 : y0 + (y1 - y0) * t;
      const half = el.d * 0.35;
      e.box(
        across ? bx - m(0.04) : bx - half,
        across ? by - half : by - m(0.04),
        across ? bx + m(0.04) : bx + half,
        across ? by + half : by + m(0.04),
        z0 - m(0.35),
        z0,
        RAIL,
      );
    }
    return;
  }
  e.box(x0, y0, x1, y1, zb, z1, c);
}

const APRON = m(0.9);
const PATH_WIDTH = m(1.4);
const PATH_REACH = m(14);
const LOT_LIFT = 0.06;
const PAVING: Paint = paint({ finish: 'stone', colour: 0xbdb5a6 });

/**
 * What seats a building in its lot: a paved apron round the base of every
 * ground volume, laid on the land (sampled, so it follows a slope) and left
 * out where there is paving already; and, from every way in that does not
 * open straight onto a footway, a path out to the nearest one.
 */
function emitLot(e: Emitter, b: Building, f: Foundation, groundAt: GroundAt, pavedAt: PavedAt | undefined): void {
  const paved = (x: number, y: number): boolean => pavedAt !== undefined && Number.isFinite(pavedAt(x, y));
  const up: V3 = [0, 0, 1];
  const strip = (from: Vec2, to: Vec2, width: number, nx: number, ny: number): void => {
    // A strip `width` out from the line from -> to (local), along normal (nx, ny).
    const length = Math.hypot(to.x - from.x, to.y - from.y);
    const pieces = Math.max(1, Math.ceil(length / m(2)));
    for (let i = 0; i < pieces; i++) {
      const a = { x: from.x + ((to.x - from.x) * i) / pieces, y: from.y + ((to.y - from.y) * i) / pieces };
      const c = { x: from.x + ((to.x - from.x) * (i + 1)) / pieces, y: from.y + ((to.y - from.y) * (i + 1)) / pieces };
      const quad = [a, c, { x: c.x + nx * width, y: c.y + ny * width }, { x: a.x + nx * width, y: a.y + ny * width }];
      const world = quad.map((p) => e.L(p.x, p.y, 0));
      if (world.some((w) => paved(w[0], w[1]))) continue;
      e.shell.face(world.map((w) => [w[0], w[1], groundAt(w[0], w[1]) + LOT_LIFT] as V3), up, PAVING);
    }
  };
  for (const v of b.volumes) {
    if (v.base !== 0) continue;
    const g = PLINTH_GROW;
    for (const side of volumeSides(v)) {
      const edge = edgeFrame(v, side);
      const n = { x: edge.nx, y: edge.ny };
      const s0 = sideStart(v, side);
      const length = sideLength(v, side);
      // From corner to corner, grown past the corners so the apron closes round them.
      const from = { x: s0.x - s0.tx * (g + APRON) + n.x * g, y: s0.y - s0.ty * (g + APRON) + n.y * g };
      const to = { x: s0.x + s0.tx * (length + g + APRON) + n.x * g, y: s0.y + s0.ty * (length + g + APRON) + n.y * g };
      strip(from, to, APRON, n.x, n.y);
    }
  }
  for (const x of f.entrances) {
    if (!pavedAt) break;
    // Where the paving is right there, the entrance already opens onto it.
    let reach = 0;
    for (let d = APRON; d <= PATH_REACH; d += m(0.5)) {
      if (paved(x.x + x.nx * d, x.y + x.ny * d)) {
        reach = d;
        break;
      }
    }
    if (reach <= APRON + m(0.5)) continue;
    const c = Math.cos(b.rotation);
    const s = Math.sin(b.rotation);
    // The entrance's point and normal in the local frame.
    const lx = (x.x - b.x) * c + (x.y - b.y) * s;
    const ly = -(x.x - b.x) * s + (x.y - b.y) * c;
    const nx = x.nx * c + x.ny * s;
    const ny = -x.nx * s + x.ny * c;
    const start = APRON + m(0.1) + flightRun(x.steps);
    const half = PATH_WIDTH / 2;
    strip(
      { x: lx + nx * start - ny * half, y: ly + ny * start + nx * half },
      { x: lx + nx * start + ny * half, y: ly + ny * start - nx * half },
      reach - start,
      nx,
      ny,
    );
  }
}

/** A flight taller than this is built open: treads on a raking slab, with handrails. */
const STAIR_SOLID = m(1.2);
const TREAD = m(0.05);
const WAIST = m(0.25);
const HANDRAIL = m(0.95);

/**
 * A tall flight as it is really built: every step a tread and a riser, the
 * lot carried by a raking concrete slab (the waist) with its cheeks, and a
 * handrail on both sides on a post at each end. A solid wedge that tall reads
 * as a ramp of rubble, not a stair.
 */
function emitOpenStair(
  e: Emitter,
  el: BuildingElement,
  [x0, y0, x1, y1]: [number, number, number, number],
  z0: number,
  zb: number,
  c: Paint,
): void {
  const n = stairSteps(el);
  const tread = el.d / n;
  const riser = el.h / n;
  // A point `u` along the run from the foot, `a` across it, at height z.
  const P = (u: number, a: number, z: number): V3 => {
    switch (el.facing) {
      case 0: return e.L(x0 + a, y0 + u, z);
      case 2: return e.L(x0 + a, y1 - u, z);
      case 3: return e.L(x0 + u, y0 + a, z);
      default: return e.L(x1 - u, y0 + a, z);
    }
  };
  const nf = SIDE_NORMAL[el.facing];
  const out = e.N(nf.x, nf.y);
  const across = el.facing === 0 || el.facing === 2 ? e.N(1, 0) : e.N(0, 1);
  const back: V3 = [-across[0], -across[1], 0];
  const w = el.w;
  for (let k = 0; k < n; k++) {
    const top = z0 + (k + 1) * riser;
    const u0 = k * tread;
    const u1 = (k + 1) * tread;
    // The riser (down to the step below, or to the ground for the first) and the tread.
    const below = k === 0 ? zb : z0 + k * riser - TREAD;
    e.shell.face([P(u0, 0, below), P(u0, w, below), P(u0, w, top), P(u0, 0, top)], out, c);
    e.shell.face([P(u0, 0, top), P(u0, w, top), P(u1, w, top), P(u1, 0, top)], [0, 0, 1], c);
    // The step's ends, down to the waist.
    const base = Math.max(zb, z0 + (el.h * u0) / el.d - WAIST);
    e.shell.face([P(u0, 0, base), P(u1, 0, base), P(u1, 0, top), P(u0, 0, top)], back, c);
    e.shell.face([P(u1, w, base), P(u0, w, base), P(u0, w, top), P(u1, w, top)], across, c);
  }
  // The waist: a raking slab under the steps, from the ground up to the top.
  const slope = el.h / el.d;
  const soffit = (u: number): number => Math.max(zb, z0 + slope * u - WAIST);
  e.shell.face([P(0, 0, soffit(0)), P(0, w, soffit(0)), P(el.d, w, soffit(el.d)), P(el.d, 0, soffit(el.d))], e.N(-nf.x * slope, -nf.y * slope, -1), c);
  emitStairRails(e, el, [x0, y0, x1, y1], z0);
}

/**
 * The handrail of a flight: a slim rail over each edge, at a constant height
 * above the nosings, on posts every couple of steps. Shared by the open
 * flights and the short solid ones.
 */
function emitStairRails(
  e: Emitter,
  el: BuildingElement,
  [x0, y0, x1, y1]: [number, number, number, number],
  z0: number,
): void {
  const n = stairSteps(el);
  const tread = el.d / n;
  const riser = el.h / n;
  const P = (u: number, a: number, z: number): V3 => {
    switch (el.facing) {
      case 0: return e.L(x0 + a, y0 + u, z);
      case 2: return e.L(x0 + a, y1 - u, z);
      case 3: return e.L(x0 + u, y0 + a, z);
      default: return e.L(x1 - u, y0 + a, z);
    }
  };
  const nf = SIDE_NORMAL[el.facing];
  const slope = el.h / el.d;
  const across = el.facing === 0 || el.facing === 2 ? e.N(1, 0) : e.N(0, 1);
  const back: V3 = [-across[0], -across[1], 0];
  const w = el.w;
  const rail = m(0.05);
  for (const a of [rail, w - rail]) {
    const r0 = z0 + riser + HANDRAIL;
    const r1 = z0 + el.h + HANDRAIL;
    e.shell.face([P(0, a - rail, r0), P(0, a + rail, r0), P(el.d, a + rail, r1), P(el.d, a - rail, r1)], e.N(nf.x * slope, nf.y * slope, 1), RAIL);
    e.shell.face([P(0, a + rail, r0 - rail * 2), P(el.d, a + rail, r1 - rail * 2), P(el.d, a + rail, r1), P(0, a + rail, r0)], across, RAIL);
    e.shell.face([P(el.d, a - rail, r1 - rail * 2), P(0, a - rail, r0 - rail * 2), P(0, a - rail, r0), P(el.d, a - rail, r1)], back, RAIL);
    const every = Math.max(1, Math.round(m(1.2) / tread));
    for (let k = 0; k < n; k += every) postAt(e, P, k * tread + tread / 2, a, z0 + (k + 1) * riser, HANDRAIL);
    postAt(e, P, el.d - tread / 2, a, z0 + el.h, HANDRAIL);
  }
}

const RAIL: Paint = paint({ finish: 'metal', colour: 0x3a3f42 });
const PLANTER_SOIL: Paint = paint({ finish: 'wood', colour: 0x3d2f22 });
const TRUNK: Paint = paint({ finish: 'wood', colour: 0x5a4632 });

/**
 * A rectangle inside an element's plan, as fractions of the axis its `d`
 * runs on: 0 at the edge it faces, 1 at its back.
 */
function sub2(
  el: BuildingElement,
  [x0, y0, x1, y1]: [number, number, number, number],
  u0: number,
  u1: number,
): [number, number, number, number] {
  if (el.facing === 0 || el.facing === 2) {
    const a = y0 + (y1 - y0) * u0;
    const b = y0 + (y1 - y0) * u1;
    return [x0, Math.min(a, b), x1, Math.max(a, b)];
  }
  const a = x0 + (x1 - x0) * u0;
  const b = x0 + (x1 - x0) * u1;
  return [Math.min(a, b), y0, Math.max(a, b), y1];
}

/** A tree: a trunk, a tapered crown, and a shadow-quiet collar at its foot. */
function emitTree(e: Emitter, el: BuildingElement, z0: number, bottom: number): void {
  const trunk = m(0.22);
  const cx = el.x;
  const cy = el.y;
  const crown = leafPaint(el);
  e.box(cx - trunk / 2, cy - trunk / 2, cx + trunk / 2, cy + trunk / 2, bottom, z0 + el.h * 0.45, TRUNK);
  // The crown: an eight-sided cone from the trunk up to the tip, in two tiers.
  const r = Math.min(el.w, el.d) / 2;
  const tiers: readonly [number, number, number][] = [
    [z0 + el.h * 0.32, r, z0 + el.h * 0.62],
    [z0 + el.h * 0.55, r * 0.78, z0 + el.h],
  ];
  const sides = 8;
  for (const [base, radius, top] of tiers) {
    const ring = (radiusAt: number, z: number): V3[] =>
      Array.from({ length: sides }, (_, i) => {
        const a = (i / sides) * Math.PI * 2;
        return e.L(cx + Math.cos(a) * radiusAt, cy + Math.sin(a) * radiusAt, z);
      });
    const low = ring(radius, base);
    const high = ring(radius * 0.45, top);
    for (let i = 0; i < sides; i++) {
      const j = (i + 1) % sides;
      const a = (i + 0.5) / sides * Math.PI * 2;
      e.shell.face([low[i] as V3, low[j] as V3, high[j] as V3, high[i] as V3], e.N(Math.cos(a), Math.sin(a), 0.35), crown);
    }
    e.shell.face([high[0] as V3, high[1] as V3, high[2] as V3, high[3] as V3], e.N(0, 0, 1), crown);
  }
}

/**
 * A flight laid along a traced path: the steps live in the element's own
 * turned frame, so a run that wraps a corner follows the line it was drawn on.
 * The rise is the element's `h`, spread evenly over its steps.
 */
function emitTurnedStair(e: Emitter, el: BuildingElement, z0: number, zb: number, c: Paint): void {
  const a = el.angle ?? 0;
  const ca = Math.cos(a);
  const sa = Math.sin(a);
  // A point `u` along the run from the foot, `v` across it, at height z.
  const P = (u: number, v: number, z: number): V3 =>
    e.L(el.x + u * ca - v * sa, el.y + u * sa + v * ca, z);
  const hw = el.w / 2;
  const n = stairSteps(el);
  const tread = el.d / n;
  const riser = el.h / n;
  const across: V3 = e.N(-sa, ca, 0);
  const back: V3 = e.N(-ca, -sa, 0);
  for (let k = 0; k < n; k++) {
    const u0 = k * tread;
    const u1 = (k + 1) * tread;
    const top = z0 + (k + 1) * riser;
    const base = k === 0 ? zb : z0 + k * riser - m(0.08);
    // The riser, then the tread.
    e.shell.face([P(u0, -hw, base), P(u0, hw, base), P(u0, hw, top), P(u0, -hw, top)], back, c);
    e.shell.face([P(u0, -hw, top), P(u0, hw, top), P(u1, hw, top), P(u1, -hw, top)], e.N(0, 0, 1), c);
    // The two cheeks, down to the flight's underside.
    const under = Math.max(zb, z0 + el.h * (u0 / el.d) - m(0.25));
    e.shell.face([P(u0, -hw, under), P(u1, -hw, under), P(u1, -hw, top), P(u0, -hw, top)], e.N(-across[0], -across[1], 0), c);
    e.shell.face([P(u1, hw, under), P(u0, hw, under), P(u0, hw, top), P(u1, hw, top)], across, c);
  }
  emitRailLine(e, P, el, z0, hw);
}

/** Both handrails of a flight in an arbitrary frame. */
function emitRailLine(
  e: Emitter,
  P: (u: number, v: number, z: number) => V3,
  el: BuildingElement,
  z0: number,
  hw: number,
): void {
  if (el.h < m(0.5)) return;
  const n = stairSteps(el);
  const tread = el.d / n;
  const riser = el.h / n;
  const rail = m(0.05);
  for (const v of [-hw + rail, hw - rail]) {
    const r0 = z0 + riser + HANDRAIL;
    const r1 = z0 + el.h + HANDRAIL;
    e.shell.face([P(0, v - rail, r0), P(0, v + rail, r0), P(el.d, v + rail, r1), P(el.d, v - rail, r1)], e.N(0, 0, 1), RAIL);
    const every = Math.max(1, Math.round(m(1.2) / tread));
    for (let k = 0; k < n; k += every) postAt(e, P, k * tread + tread / 2, v, z0 + (k + 1) * riser, HANDRAIL);
  }
}

/** A run of fence: posts and two rails along the box's length. */
function emitFence(e: Emitter, el: BuildingElement, z0: number, z1: number, c: Paint, light = false): void {
  const half = el.w / 2;
  const at = (u: number, v: number): { x: number; y: number } => {
    const a = el.angle ?? 0;
    const across = el.facing === 0 || el.facing === 2 ? { x: 1, y: 0 } : { x: 0, y: 1 };
    const ux = across.x * Math.cos(a) - across.y * Math.sin(a);
    const uy = across.x * Math.sin(a) + across.y * Math.cos(a);
    const vx = -uy;
    const vy = ux;
    return { x: el.x + ux * u + vx * v, y: el.y + uy * u + vy * v };
  };
  const railTop = z0 + el.h;
  const railMid = z0 + el.h * 0.45;
  for (const [z, tall] of [[railMid, m(0.06)], [railTop, m(0.07)]] as const) {
    const a = at(-half, 0);
    const b = at(half, 0);
    const n = { x: -(b.y - a.y), y: b.x - a.x };
    const len = Math.hypot(n.x, n.y) || 1;
    const t = m(0.03);
    const nx = (n.x / len) * t;
    const ny = (n.y / len) * t;
    e.shell.face(
      [e.L(a.x - nx, a.y - ny, z), e.L(b.x - nx, b.y - ny, z), e.L(b.x + nx, b.y + ny, z), e.L(a.x + nx, a.y + ny, z)],
      e.N(n.x / len, n.y / len, 0),
      c,
    );
    e.shell.face(
      [e.L(a.x - nx, a.y - ny, z + tall), e.L(b.x - nx, b.y - ny, z + tall), e.L(b.x + nx, b.y + ny, z + tall), e.L(a.x + nx, a.y + ny, z + tall)],
      e.N(0, 0, 1),
      c,
    );
  }
  // Posts every couple of metres on a fence, closer together on a railing,
  // and always at both ends.
  const spacing = light ? m(0.45) : m(2);
  const posts = Math.max(2, Math.round(el.w / spacing) + 1);
  for (let k = 0; k < posts; k++) {
    const u = -half + (el.w * k) / (posts - 1);
    const p = at(u, 0);
    const t = light ? m(0.03) : m(0.06);
    e.box(p.x - t, p.y - t, p.x + t, p.y + t, z0, z1 + m(0.05), c);
  }
}

/** A flower bed: soil in a stone kerb, with a handful of coloured blooms. */
function emitFlowers(e: Emitter, el: BuildingElement, z0: number, bottom: number): void {
  const kerb = m(0.12);
  e.box(el.x - el.w / 2, el.y - el.d / 2, el.x + el.w / 2, el.y + el.d / 2, bottom, z0 + m(0.16), FLOWER_KERB);
  e.box(el.x - el.w / 2 + kerb, el.y - el.d / 2 + kerb, el.x + el.w / 2 - kerb, el.y + el.d / 2 - kerb, z0 + m(0.1), z0 + m(0.2), PLANTER_SOIL);
  const blooms = 9;
  for (let k = 0; k < blooms; k++) {
    const h = Math.abs(Math.round(Math.sin(el.id * 12.9898 + k * 78.233) * 43758.5453));
    const fx = el.x + ((h % 100) / 100 - 0.5) * (el.w - m(0.3));
    const fy = el.y + (((h >> 3) % 100) / 100 - 0.5) * (el.d - m(0.3));
    const s = m(0.1) + ((h >> 7) % 7) * m(0.012);
    e.box(fx - s, fy - s, fx + s, fy + s, z0 + m(0.18), z0 + m(0.18) + s * 2.2, el.material ? paint(el.material) : FLOWER_PETALS[k % FLOWER_PETALS.length] as Paint);
  }
}

/** Boulders: two or three low prisms, each turned a little. */
function emitRocks(e: Emitter, el: BuildingElement, z0: number, bottom: number, c: Paint): void {
  const count = 3;
  for (let k = 0; k < count; k++) {
    const h = Math.abs(Math.round(Math.sin(el.id * 3.7 + k * 12.3) * 9127.13));
    const rx = ((h % 100) / 100 - 0.5) * (el.w - m(0.4));
    const ry = (((h >> 3) % 100) / 100 - 0.5) * (el.d - m(0.4));
    const r = m(0.22) + ((h >> 7) % 5) * m(0.05);
    const top = z0 + el.h * (0.5 + ((h >> 5) % 4) * 0.12);
    const t = z0 + (el.h - (top - z0)) * 0.3;
    const p = (dx: number, dy: number, dz: number): V3 => e.L(el.x + rx + dx, el.y + ry + dy, dz);
    const base: V3[] = [p(-r, -r, bottom), p(r, -r, bottom), p(r, r, bottom), p(-r, r, bottom)];
    const apex: V3[] = [p(-r * 0.4, -r * 0.35, top), p(r * 0.45, -r * 0.3, top), p(r * 0.35, r * 0.4, top), p(-r * 0.45, r * 0.35, top)];
    for (let i = 0; i < 4; i++) {
      const j = (i + 1) % 4;
      const q = (i + 0.5) * 0.25 * Math.PI * 2;
      e.shell.face([base[i] as V3, base[j] as V3, apex[j] as V3, apex[i] as V3], e.N(Math.cos(q), Math.sin(q), 0.3), c);
    }
    e.shell.face([apex[0] as V3, apex[1] as V3, apex[2] as V3, apex[3] as V3], e.N(0, 0, 1), c);
    void t;
  }
}

/** A parking apron: asphalt and the stall lines painted on it. */
function emitParking(e: Emitter, el: BuildingElement, z0: number): void {
  e.box(el.x - el.w / 2, el.y - el.d / 2, el.x + el.w / 2, el.y + el.d / 2, z0 - m(0.02), z0 + el.h, PARKING_ASPHALT);
  const stalls = Math.max(1, Math.floor(el.w / m(2.5)));
  const line = m(0.1);
  const along = el.facing === 0 || el.facing === 2;
  for (let k = 0; k <= stalls; k++) {
    const u = -el.w / 2 + (el.w * k) / stalls;
    const half = m(0.42);
    if (along) e.box(el.x + u - line / 2, el.y - el.d / 2, el.x + u + line / 2, el.y - el.d / 2 + el.d * 0.72, z0 + el.h, z0 + el.h + m(0.02), PARKING_LINE);
    else e.box(el.x - el.w / 2, el.y + u - line / 2, el.x - el.w / 2 + el.w * 0.72, el.y + u + line / 2, z0 + el.h, z0 + el.h + m(0.02), PARKING_LINE);
    void half;
  }
}

const FLOWER_KERB: Paint = paint({ finish: 'stone', colour: 0xa9a196 });
const FLOWER_PETALS: readonly Paint[] = [
  paint({ finish: 'plaster', colour: 0xd9557a }),
  paint({ finish: 'plaster', colour: 0xe8c752 }),
  paint({ finish: 'plaster', colour: 0xd9d3e8 }),
  paint({ finish: 'plaster', colour: 0xc2472f }),
];
const PARKING_ASPHALT: Paint = paint({ finish: 'concrete', colour: 0x4a4d4f });
const PARKING_LINE: Paint = paint({ finish: 'plaster', colour: 0xe9e6dc });

/** The canvas colour of an awning, from the building's own palette. */
function shadeOf(el: BuildingElement): Paint {
  return el.material ? paint(el.material) : paint({ finish: 'plaster', colour: 0xc85a4a });
}

/** The leaves: a tree keeps one tone per tree, from its own position. */
function leafPaint(el: BuildingElement): Paint {
  if (el.material) return paint(el.material);
  const greens = [0x4d6b3a, 0x577a41, 0x43603a, 0x5f7f4a];
  const pick = greens[Math.abs(Math.round(el.id * 2654435761)) % greens.length] as number;
  return paint({ finish: 'wood', colour: pick });
}

/** A slim square post of the handrail, from a tread up to the rail. */
function postAt(e: Emitter, P: (u: number, a: number, z: number) => V3, u: number, a: number, z: number, h: number): void {
  const r = m(0.025);
  const corners: V3[] = [P(u - r, a - r, 0), P(u + r, a - r, 0), P(u + r, a + r, 0), P(u - r, a + r, 0)];
  for (let i = 0; i < 4; i++) {
    const p = corners[i] as V3;
    const q = corners[(i + 1) % 4] as V3;
    const mid: V3 = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2, 0];
    const centre: V3 = [(corners[0]![0] + corners[2]![0]) / 2, (corners[0]![1] + corners[2]![1]) / 2, 0];
    e.shell.face([[p[0], p[1], z], [q[0], q[1], z], [q[0], q[1], z + h], [p[0], p[1], z + h]], [mid[0] - centre[0], mid[1] - centre[1], 0], RAIL);
  }
}

/** A horizontal band around a volume at height z (a storey line or a cornice). */
function band(e: Emitter, v: Volume, z: number, out: number, height: number, c: Paint): void {
  // A moulding is a PROFILE, not a slab: a fillet under a projecting drip,
  // whose shadow line is what makes it read at a distance.
  const tier = (o: number, z0: number, z1: number, paint: Paint): void => {
    if (!v.outline) { e.box(v.x - o, v.y - o, v.x + v.w + o, v.y + v.d + o, z0, z1, paint); return; }
    for (const side of volumeSides(v)) {
      const f = edgeFrame(v, side), n = e.N(f.nx, f.ny);
      const P = (a: number, z: number): V3 => e.L(f.x + f.tx * a + f.nx * o, f.y + f.ty * a + f.ny * o, z);
      e.shell.face([P(0, z0), P(f.length, z0), P(f.length, z1), P(0, z1)], n, paint);
    }
  };
  tier(out * 0.45, z - height / 2, z - height * 0.1, shaded(c, 0.94));
  tier(out, z - height * 0.1, z + height / 2, c);
}

function emitCornice(e: Emitter, v: Volume, z: number, trim: Paint): void {
  const deco = v.facadePattern === 'artDeco' || v.facadePattern === 'artDecoCrown';
  band(e, v, z - m(.2), deco ? m(.55) : CORNICE_OUT, deco ? m(.55) : m(.36), trim);
  if (deco) band(e, v, z - m(1.05), m(.28), m(.32), trim);
}

/** User-placed details follow the mass and rest on its actual roof surface. */
function emitRoofDetails(e: Emitter, b: Building, v: Volume, floor: number): void {
  const base = floor + volumeHeight(b, v);
  const metal = paint({ finish: 'metal', colour: 0x677b79 });
  const panel = paint({ finish: 'glass', colour: 0x153e4c });
  const glazing = paint({ finish: 'glass', colour: 0x6098a6 });
  const masonry = paint({ finish: 'brick', colour: 0x876755 });
  const concrete = paint({ finish: 'concrete', colour: 0xaaa99d });
  for (const detail of v.roofDetails ?? []) {
    const z = base + roofHeightAt(b, v, detail);
    if (detail.kind === 'solar' || detail.kind === 'skylight') {
      const c = Math.cos(detail.rotation), s = Math.sin(detail.rotation);
      const point = (x: number, y: number, lift: number): V3 => {
        const px = detail.x + x * c - y * s, py = detail.y + x * s + y * c;
        return e.L(px, py, base + roofHeightAt(b, v, { x: px, y: py }) + lift);
      };
      const quad = (grow: number, lift: number): V3[] => [
        point(-detail.w / 2 - grow, -detail.d / 2 - grow, lift),
        point(detail.w / 2 + grow, -detail.d / 2 - grow, lift),
        point(detail.w / 2 + grow, detail.d / 2 + grow, lift),
        point(-detail.w / 2 - grow, detail.d / 2 + grow, lift),
      ];
      e.shell.face(quad(0.15, 0.18), [0, 0, 1], metal);
      e.shell.face(quad(0, 0.24), [0, 0, 1], detail.kind === 'solar' ? panel : glazing);
      continue;
    }
    if (detail.kind === 'vent') {
      e.box(detail.x - detail.w / 2, detail.y - detail.d / 2,
        detail.x + detail.w / 2, detail.y + detail.d / 2, z - 0.2, z + m(1), metal);
    } else if (detail.kind === 'spire') {
      const height = detail.h ?? m(11.7);
      const radius = Math.min(detail.w, detail.d) * 0.47;
      const baseStone = paint({ finish: 'plaster', colour: 0xd1ccbe });
      e.box(detail.x - radius, detail.y - radius, detail.x + radius, detail.y + radius, z - m(0.15), z + m(0.75), baseStone);
      const rings = [
        { z: z + m(0.75), r: radius * .78 },
        { z: z + height * .28, r: radius * .48 },
        { z: z + height * .84, r: radius * .12 },
        { z: z + height, r: Math.max(m(0.025), radius * .025) },
      ];
      for (let band = 0; band < rings.length - 1; band++) {
        const lo = rings[band]!, hi = rings[band + 1]!;
        for (let i = 0; i < 8; i++) {
          const a = i * Math.PI / 4, c = (i + 1) * Math.PI / 4;
          const point = (angle: number, r: number, h: number): V3 =>
            e.L(detail.x + Math.cos(angle) * r, detail.y + Math.sin(angle) * r, h);
          e.shell.face([point(a, lo.r, lo.z), point(c, lo.r, lo.z), point(c, hi.r, hi.z), point(a, hi.r, hi.z)],
            e.N(Math.cos((a + c) / 2), Math.sin((a + c) / 2)), band === 0 ? baseStone : metal);
        }
      }
      if (detail.flag && detail.flag !== 'none') {
        const flagTop = z + height * .98, flagBottom = flagTop - m(1.25);
        const x0 = detail.x + m(.08), x1 = x0 + m(2.2);
        const white = paint({ finish: 'plaster', colour: 0xf3eee3 });
        const red = paint({ finish: 'plaster', colour: 0xb43138 });
        const blue = paint({ finish: 'plaster', colour: 0x3f688d });
        const black = paint({ finish: 'plaster', colour: 0x20252a });
        for (const face of [-1, 1] as const) {
          const y = detail.y + face * m(.035);
          const p = (x: number, h: number): V3 => e.L(x, y + (x - x0) * .065, h);
          const quad = (a: number, c: number, lo: number, hi: number, colour: Paint): void =>
            e.shell.face([p(a, lo), p(c, lo), p(c, hi), p(a, hi)], e.N(0, face), colour);
          quad(x0, x1, flagBottom, flagTop, detail.flag === 'plain' ? blue : white);
          const raised = face * m(.014);
          const mark = (a: number, c: number, lo: number, hi: number, colour: Paint): void =>
            e.shell.face([e.L(a, y + (a - x0) * .065 + raised, lo), e.L(c, y + (c - x0) * .065 + raised, lo),
              e.L(c, y + (c - x0) * .065 + raised, hi), e.L(a, y + (a - x0) * .065 + raised, hi)], e.N(0, face), colour);
          if (detail.flag === 'saoPaulo') {
            mark(x0 + m(.67), x0 + m(.93), flagBottom, flagTop, red);
            mark(x0, x1, flagBottom + m(.47), flagBottom + m(.74), red);
          } else if (detail.flag === 'saoPauloState') {
            const stripe = (flagTop - flagBottom) / 13;
            for (let i = 0; i < 13; i += 2) mark(x0, x1, flagBottom + i * stripe, flagBottom + (i + 1) * stripe, black);
            mark(x0, x0 + m(.7), flagTop - m(.7), flagTop, red);
            mark(x0 + m(.28), x0 + m(.42), flagTop - m(.42), flagTop - m(.28), white);
          }
        }
      }
    } else if (detail.kind === 'chimney') {
      e.box(detail.x - detail.w / 2, detail.y - detail.d / 2,
        detail.x + detail.w / 2, detail.y + detail.d / 2, z - 0.2, z + m(2.1), masonry);
      e.box(detail.x - detail.w / 2 - .1, detail.y - detail.d / 2 - .1,
        detail.x + detail.w / 2 + .1, detail.y + detail.d / 2 + .1, z + m(2.1), z + m(2.25), concrete);
    } else {
      e.box(detail.x - detail.w / 2, detail.y - detail.d / 2,
        detail.x + detail.w / 2, detail.y + detail.d / 2, z - .1, z + m(1.6), metal);
    }
  }
}

/** Cut a pitched roof into planar regions, then clip each region to any outline. */
function emitPolygonRoof(
  e: Emitter, b: Building, v: Volume, floor: number,
  wallOf: (side: FaceId) => Paint, trim: Paint, roofColour: Paint,
): void {
  const z = floor + volumeHeight(b, v);
  const x0 = v.x, y0 = v.y, x1 = v.x + v.w, y1 = v.y + v.d;
  const slope = roofSlope(v);
  type Patch = { ring: Vec2[]; height: (p: Vec2) => number };
  const rect = (a: number, c: number, d: number, f: number): Vec2[] =>
    [{ x: a, y: c }, { x: d, y: c }, { x: d, y: f }, { x: a, y: f }];
  let patches: Patch[] = [];
  if (v.roof === 'flat' || v.roof === 'terrace') {
    patches = [{ ring: rect(x0, y0, x1, y1), height: () => 0 }];
  } else if (v.roof === 'gable') {
    if (ridgeAlongX(v)) {
      const mid = (y0 + y1) / 2;
      patches = [
        { ring: rect(x0, y0, x1, mid), height: (p) => (p.y - y0) * slope },
        { ring: rect(x0, mid, x1, y1), height: (p) => (y1 - p.y) * slope },
      ];
    } else {
      const mid = (x0 + x1) / 2;
      patches = [
        { ring: rect(x0, y0, mid, y1), height: (p) => (p.x - x0) * slope },
        { ring: rect(mid, y0, x1, y1), height: (p) => (x1 - p.x) * slope },
      ];
    }
  } else if (v.roof === 'hip') {
    const alongX = v.w >= v.d;
    const long = alongX ? v.w : v.d, short = alongX ? v.d : v.w;
    const h = short / 2;
    const P = (u: number, a: number): Vec2 => alongX ? { x: x0 + u, y: y0 + a } : { x: x0 + a, y: y0 + u };
    const polygon = (pairs: readonly (readonly [number, number])[]): Vec2[] => pairs.map(([u, a]) => P(u, a));
    const U = (p: Vec2): number => alongX ? p.x - x0 : p.y - y0;
    const A = (p: Vec2): number => alongX ? p.y - y0 : p.x - x0;
    patches = [
      { ring: polygon([[0, 0], [h, h], [0, short]]), height: (p) => U(p) * slope },
      { ring: polygon([[long, 0], [long, short], [long - h, h]]), height: (p) => (long - U(p)) * slope },
      { ring: polygon([[0, 0], [long, 0], [long - h, h], [h, h]]), height: (p) => A(p) * slope },
      { ring: polygon([[h, h], [long - h, h], [long, short], [0, short]]), height: (p) => (short - A(p)) * slope },
    ];
  } else if (v.roof === 'shed') {
    const fall = shedFall(v);
    patches = [{ ring: rect(x0, y0, x1, y1), height: (p) =>
      (fall === 0 ? p.y - y0 : fall === 2 ? y1 - p.y : fall === 1 ? x1 - p.x : p.x - x0) * slope }];
  } else {
    const run = sawtoothRun(b, v);
    for (let from = y0; from < y1 - 1e-6; from += run) {
      const to = Math.min(y1, from + run), middle = (from + to) / 2;
      patches.push({ ring: rect(x0, from, x1, middle), height: (p) => (p.y - from) * slope });
      patches.push({ ring: rect(x0, middle, x1, to), height: (p) => (to - p.y) * slope });
    }
  }
  const footprint = asPolygon(localFootprint(v));
  const heightAt = (p: Vec2): number => roofHeightAt(b, v, p);
  const roofPaint = v.roof === 'terrace' ? TERRACE : roofColour;
  for (const patch of patches) {
    const pieces = clipping.intersection(footprint, asPolygon(patch.ring));
    for (const piece of pieces) {
      const ring = piece[0];
      if (!ring || ring.length < 4) continue;
      const flat = ring.slice(0, -1).flat();
      const triangles = earcut(flat);
      for (let i = 0; i < triangles.length; i += 3) {
        const plan = [triangles[i], triangles[i + 1], triangles[i + 2]].map((index) =>
          ({ x: flat[2 * index!]!, y: flat[2 * index! + 1]! }));
        const a = plan[0]!, c = plan[1]!, d = plan[2]!;
        const az = patch.height(a), cz = patch.height(c), dz = patch.height(d);
        const ux = c.x - a.x, uy = c.y - a.y, uz = cz - az;
        const vx = d.x - a.x, vy = d.y - a.y, vz = dz - az;
        let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
        if (nz < 0) { nx = -nx; ny = -ny; nz = -nz; }
        const length = Math.hypot(nx, ny, nz) || 1;
        e.shell.face([e.L(a.x, a.y, z + az), e.L(c.x, c.y, z + cz), e.L(d.x, d.y, z + dz)],
          e.N(nx / length, ny / length, nz / length), roofPaint);
      }
    }
  }
  // The eaves close under pitched surfaces. Short segments follow every break.
  for (const side of volumeSides(v)) {
    const frame = edgeFrame(v, side);
    const divisions = Math.max(1, Math.ceil(frame.length / b.module));
    for (let i = 0; i < divisions; i++) {
      const a0 = i * frame.length / divisions, a1 = (i + 1) * frame.length / divisions;
      const p0 = { x: frame.x + frame.tx * a0, y: frame.y + frame.ty * a0 };
      const p1 = { x: frame.x + frame.tx * a1, y: frame.y + frame.ty * a1 };
      const h0 = Math.max(0, heightAt(p0)), h1 = Math.max(0, heightAt(p1));
      if (h0 + h1 > 1e-4) e.shell.face([e.L(p0.x, p0.y, z), e.L(p1.x, p1.y, z), e.L(p1.x, p1.y, z + h1), e.L(p0.x, p0.y, z + h0)], e.N(frame.nx, frame.ny), wallOf(side));
    }
    // A low continuous coping makes the plan legible at game zoom.
    const f: BayFace = { ...sideFrame(v, side, 0), z0: z, W: frame.length, H: PARAPET_H };
    if (v.roof === 'flat' || v.roof === 'terrace') {
      if (v.roof === 'terrace') e.put('roofRailing', f, frame.length / 2, 0, m(.12), frame.length, m(1), 1);
      else e.rect(f, 0, frame.length, 0, PARAPET_H, 0, e.N(f.nx, f.ny), wallOf(side));
    }
  }
  if (v.roof === 'flat' || v.roof === 'terrace') emitCornice(e, v, z, trim);
  if (v.roof === 'flat') emitRoofPlant(e, b, v, z, trim);
}


function emitRoof(
  e: Emitter,
  b: Building,
  v: Volume,
  floor: number,
  wallOf: (side: FaceId) => Paint,
  trim: Paint,
  roofColour: Paint,
): void {
  if (v.outline) { emitPolygonRoof(e, b, v, floor, wallOf, trim, roofColour); return; }
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
    if (!terrace) emitRoofPlant(e, b, v, z, trim);
    // Its top stays just under the roof: a face shared with the roof cap
    // z-fights into stripes.
    emitCornice(e, v, z, trim);
    // An edge bay gets a parapet (or a railing, on a terrace) only where the
    // roof really ends: not against a neighbour of the same or greater height.
    for (const side of volumeSides(v)) {
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
            e.rect(face, 0, W, 0, PARAPET_H, PARAPET_T, [-out[0], -out[1], 0], shaded(wallOf(side), 0.82));
            // The coping: proud of both faces, so the rain drips clear of them.
            e.strip(face, 0, W, PARAPET_H, -m(0.05), PARAPET_T + m(0.05), up, trim);
            e.rect(face, 0, W, PARAPET_H - m(0.06), PARAPET_H, -m(0.05), out, shaded(trim, 0.9));
          }
        }
      }
    }
    return;
  }

  const rise = roofRise(b, v);
  const slope = roofSlope(v);
  if (v.roof === 'gable' || v.roof === 'hip') {
    const alongX = ridgeAlongX(v);
    // Work in a frame whose "long" axis runs along the ridge.
    const span = alongX ? y1 - y0 : x1 - x0;
    const eave = z - EAVES * slope;
    const ridge = z + rise;
    const hip = v.roof === 'hip' ? Math.min(span / 2, (alongX ? x1 - x0 : y1 - y0) / 2) : 0;
    const Lp = (along: number, across: number, height: number): V3 =>
      alongX ? e.L(along, across, height) : e.L(across, along, height);
    const a0 = alongX ? x0 : y0;
    const a1 = alongX ? x1 : y1;
    const c0 = alongX ? y0 : x0;
    const c1 = alongX ? y1 : x1;
    const cm = (c0 + c1) / 2;
    const nNear = alongX ? e.N(0, -slope, 1) : e.N(-slope, 0, 1);
    const nFar = alongX ? e.N(0, slope, 1) : e.N(slope, 0, 1);
    const o = EAVES;
    const r0 = a0 + hip;
    const r1 = a1 - hip;
    // The two long slopes.
    sh.face([Lp(a0 - o, c0 - o, eave), Lp(a1 + o, c0 - o, eave), Lp(r1, cm, ridge), Lp(r0, cm, ridge)], nNear, roofColour);
    sh.face([Lp(a1 + o, c1 + o, eave), Lp(a0 - o, c1 + o, eave), Lp(r0, cm, ridge), Lp(r1, cm, ridge)], nFar, roofColour);
    const endLow = alongX ? e.N(-slope, 0, 1) : e.N(0, -slope, 1);
    const endHigh = alongX ? e.N(slope, 0, 1) : e.N(0, slope, 1);
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
    // One slope, low along the side it falls towards and high along the
    // opposite one. Q(a, t) is a point of the plan: `a` along the low eave
    // (0..1), `t` from the low eave to the high one (0..1).
    const fall = shedFall(v);
    const lowAlongX = fall === 0 || fall === 2;
    const eaveLength = lowAlongX ? x1 - x0 : y1 - y0;
    const run = lowAlongX ? y1 - y0 : x1 - x0;
    const Q = (a: number, t: number, height: number): V3 => {
      switch (fall) {
        case 0: return e.L(x0 + a * (x1 - x0), y0 + t * (y1 - y0), height);
        case 2: return e.L(x0 + a * (x1 - x0), y1 - t * (y1 - y0), height);
        case 3: return e.L(x0 + t * (x1 - x0), y0 + a * (y1 - y0), height);
        default: return e.L(x1 - t * (x1 - x0), y0 + a * (y1 - y0), height);
      }
    };
    const high = z + run * slope;
    const oa = EAVES / eaveLength;
    const ot = EAVES / run;
    const nf = SIDE_NORMAL[fall];
    sh.face(
      [Q(-oa, -ot, z - EAVES * slope), Q(1 + oa, -ot, z - EAVES * slope), Q(1 + oa, 1 + ot, high + EAVES * slope), Q(-oa, 1 + ot, high + EAVES * slope)],
      e.N(nf.x * slope, nf.y * slope, 1),
      roofColour,
    );
    // The two end walls, rising with the slope, and the tall wall at the back.
    const back = ((fall + 2) % 4) as Side;
    const ends = SIDES.filter((x) => x !== fall && x !== back);
    for (const end of ends) {
      const a = (lowAlongX ? end === 3 : end === 0) ? 0 : 1;
      const n = SIDE_NORMAL[end];
      sh.face([Q(a, 0, z), Q(a, 1, z), Q(a, 1, high)], e.N(n.x, n.y), wallOf(end));
    }
    const nb = SIDE_NORMAL[back];
    sh.face([Q(0, 1, z), Q(1, 1, z), Q(1, 1, high), Q(0, 1, high)], e.N(nb.x, nb.y), wallOf(back));
    return;
  }

  // Sawtooth: teeth of up to two cells, glazed on their steep face.
  const tooth = sawtoothRun(b, v);
  const toothRise = tooth * 0.5 * slope;
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
  // The blocks as drawn: unions, cuts and intersections resolved, the stored
  // blocks untouched (`world/buildings/blocks.ts`).
  const resolved = resolveBlocks(b);
  // Open blocks are lots: laid on the ground, not built. The rest is the
  // building; a building that is only lots (a park) has its parts on them.
  const lots = resolved.volumes.filter((v) => v.open);
  const closed = resolved.volumes.filter((v) => !v.open);
  if (closed.length > 0) emitBuilding({ ...resolved, volumes: closed }, groundAt, shell, parts, pavedAt);
  emitLots(resolved, lots, closed.length === 0, groundAt, shell, parts);
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
export function assembleBuildingMeshes(
  chunks: readonly BuildingChunk[],
  kit: BuildingKit,
  ghost = false,
  dim = false,
): BuildingMeshes {
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
    const mesh = new Mesh(g, ghost ? kit.ghostShell : dim ? kit.dimShell[finish] : kit.shell[finish]);
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
    const mesh = new InstancedMesh(kit.geometry[kind], ghost ? kit.ghostParts : dim ? kit.dimParts : kit.material[kind], count);
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
