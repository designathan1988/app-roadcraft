import type { Vec2 } from '@core/vec2';
import { m } from '../units';
import {
  type BayComponent,
  type Building,
  type Relief,
  type Side,
  type Volume,
  SIDES,
  componentAt,
  volumeTop,
} from './types';

/**
 * Every spatial question about a building, answered from the record.
 *
 * The local frame: origin at `(b.x, b.y)`, +x along `rotation`, +y a quarter
 * turn anticlockwise of it. A volume is a rectangle of that frame in world
 * units - any size, snapped to `GRID` by the editor - standing on a level. Its
 * facades are divided into BAYS of about `module` each (`baysOn`), so a facade
 * of any length keeps its rhythm.
 */

/** The step every horizontal dimension snaps to in the editor: half a metre. */
export const GRID = m(0.5);
/** The smallest a volume may be on either side. */
export const MIN_SIZE = m(2);
/** Two lengths closer than this are the same one (shared walls, touching volumes). */
export const EPS = 1e-4;

export function localToWorld(b: Building, lx: number, ly: number): Vec2 {
  const c = Math.cos(b.rotation);
  const s = Math.sin(b.rotation);
  return { x: b.x + lx * c - ly * s, y: b.y + lx * s + ly * c };
}

export function worldToLocal(b: Building, p: Vec2): Vec2 {
  const c = Math.cos(b.rotation);
  const s = Math.sin(b.rotation);
  const dx = p.x - b.x;
  const dy = p.y - b.y;
  return { x: dx * c + dy * s, y: -dx * s + dy * c };
}

/** A local direction turned into the world. */
export function localDirToWorld(b: Building, dx: number, dy: number): Vec2 {
  const c = Math.cos(b.rotation);
  const s = Math.sin(b.rotation);
  return { x: dx * c - dy * s, y: dx * s + dy * c };
}

/** Outward unit normal of a side, in the local frame. */
export const SIDE_NORMAL: Readonly<Record<Side, Vec2>> = {
  0: { x: 0, y: -1 },
  1: { x: 1, y: 0 },
  2: { x: 0, y: 1 },
  3: { x: -1, y: 0 },
};

// ------------------------------------------------------------------ levels

/** Height of level `L`, world units. */
export function levelHeight(b: Building, level: number): number {
  const custom = b.levels?.[level];
  if (typeof custom === 'number') return custom;
  return level === 0 ? b.groundHeight : b.storeyHeight;
}

/** Height of the floor of level `L` above the building's ground floor. */
export function levelElevation(b: Building, level: number): number {
  let z = 0;
  for (let i = 0; i < level; i++) z += levelHeight(b, i);
  return z;
}

/** Highest level any volume reaches (one past the top storey). */
export function topLevel(b: Building): number {
  let top = 0;
  for (const v of b.volumes) top = Math.max(top, volumeTop(v));
  return top;
}

/** Whether a volume has a storey on `level`. */
export const occupiesLevel = (v: Volume, level: number): boolean => v.base <= level && level < volumeTop(v);

// ------------------------------------------------------------------ plan

/** Local rectangle of a volume, world units: [x0, y0, x1, y1]. */
export function volumeRectLocal(_b: Building, v: Volume): [number, number, number, number] {
  return [v.x, v.y, v.x + v.w, v.y + v.d];
}

/** The four world corners of a volume, anticlockwise in the local frame. */
export function volumeCorners(b: Building, v: Volume, grow = 0): Vec2[] {
  const [x0, y0, x1, y1] = volumeRectLocal(b, v);
  return [
    localToWorld(b, x0 - grow, y0 - grow),
    localToWorld(b, x1 + grow, y0 - grow),
    localToWorld(b, x1 + grow, y1 + grow),
    localToWorld(b, x0 - grow, y1 + grow),
  ];
}

/** Volumes standing on the ground. Everything else stands on these. */
export const groundVolumes = (b: Building): Volume[] => b.volumes.filter((v) => v.base === 0);

/** World corner rings of every ground volume: the building's footprint. */
export function footprintRects(b: Building, grow = 0): Vec2[][] {
  return groundVolumes(b).map((v) => volumeCorners(b, v, grow));
}

/** Local bounding box of the footprint, world units. */
export function footprintBox(b: Building): { x0: number; y0: number; x1: number; y1: number } {
  const ground = groundVolumes(b);
  const list = ground.length > 0 ? ground : b.volumes;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const v of list) {
    x0 = Math.min(x0, v.x);
    y0 = Math.min(y0, v.y);
    x1 = Math.max(x1, v.x + v.w);
    y1 = Math.max(y1, v.y + v.d);
  }
  if (!Number.isFinite(x0)) return { x0: 0, y0: 0, x1: b.module, y1: b.module };
  return { x0, y0, x1, y1 };
}

/** World centre of the footprint's bounding box. */
export function footprintCentre(b: Building): Vec2 {
  const f = footprintBox(b);
  return localToWorld(b, (f.x0 + f.x1) / 2, (f.y0 + f.y1) / 2);
}

/** World bounding box of a building's footprint. */
export function buildingBounds(b: Building, grow = 0): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const v of b.volumes) {
    for (const p of volumeCorners(b, v, grow)) {
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
    }
  }
  return { minX, minY, maxX, maxY };
}

// ------------------------------------------------------------------ solids

type Rect = readonly [number, number, number, number];

/** Whether two volumes share floor area in plan (touching is not sharing). */
export const planOverlap = (a: Volume, c: Volume): boolean =>
  a.x < c.x + c.w - EPS && c.x < a.x + a.w - EPS && a.y < c.y + c.d - EPS && c.y < a.y + a.d - EPS;

/** Pairs of volumes that would stand in the same space: overlapping in plan and in levels. */
export function clashes(b: Building): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < b.volumes.length; i++) {
    const a = b.volumes[i] as Volume;
    for (let j = i + 1; j < b.volumes.length; j++) {
      const c = b.volumes[j] as Volume;
      if (a.base < volumeTop(c) && c.base < volumeTop(a) && planOverlap(a, c)) out.push([a.id, c.id]);
    }
  }
  return out;
}

/** What is left of `rect` once `cut` is taken out of it: up to four rectangles. */
function subtract(rect: Rect, cut: Rect): Rect[] {
  const [x0, y0, x1, y1] = rect;
  const [cx0, cy0, cx1, cy1] = cut;
  if (cx0 >= x1 - EPS || cx1 <= x0 + EPS || cy0 >= y1 - EPS || cy1 <= y0 + EPS) return [rect];
  const out: Rect[] = [];
  if (cy0 > y0 + EPS) out.push([x0, y0, x1, cy0]);
  if (cy1 < y1 - EPS) out.push([x0, cy1, x1, y1]);
  const my0 = Math.max(y0, cy0);
  const my1 = Math.min(y1, cy1);
  if (cx0 > x0 + EPS) out.push([x0, my0, cx0, my1]);
  if (cx1 < x1 - EPS) out.push([cx1, my0, x1, my1]);
  return out;
}

/**
 * Whether a volume above the ground has something under every part of it:
 * its rectangle is covered by the volumes that have a storey on the level
 * below its base.
 */
export function isSupported(b: Building, v: Volume): boolean {
  if (v.base === 0) return true;
  let left: Rect[] = [[v.x, v.y, v.x + v.w, v.y + v.d]];
  for (const o of b.volumes) {
    if (o.id === v.id || !occupiesLevel(o, v.base - 1)) continue;
    const cut: Rect = [o.x, o.y, o.x + o.w, o.y + o.d];
    left = left.flatMap((r) => subtract(r, cut));
    if (left.length === 0) return true;
  }
  return left.every(([x0, y0, x1, y1]) => x1 - x0 < EPS * 10 || y1 - y0 < EPS * 10);
}

// ------------------------------------------------------------------ facades

/** Length of one side of a volume. */
export const sideLength = (v: Volume, side: Side): number => (side === 0 || side === 2 ? v.w : v.d);

/** Bays on a side: as many as fit at about one module each, at least one. */
export const baysOn = (b: Building, v: Volume, side: Side): number =>
  Math.max(1, Math.round(sideLength(v, side) / b.module));

/** Width of every bay of a side: the side shared evenly. */
export const bayWidth = (b: Building, v: Volume, side: Side): number => sideLength(v, side) / baysOn(b, v, side);

/** Local start of a side (where its along coordinate is 0) and its along direction. */
export function sideStart(v: Volume, side: Side): { x: number; y: number; tx: number; ty: number } {
  switch (side) {
    case 0: return { x: v.x, y: v.y, tx: 1, ty: 0 };
    case 1: return { x: v.x + v.w, y: v.y, tx: 0, ty: 1 };
    case 2: return { x: v.x, y: v.y + v.d, tx: 1, ty: 0 };
    default: return { x: v.x, y: v.y, tx: 0, ty: 1 };
  }
}

/**
 * Stretches of a side, in its along coordinate, that another volume stands
 * against on `level`: shared walls, where no facade is built.
 */
export function coveredSpans(b: Building, v: Volume, side: Side, level: number): [number, number][] {
  const out: [number, number][] = [];
  for (const o of b.volumes) {
    if (o.id === v.id || !occupiesLevel(o, level)) continue;
    let touches: boolean;
    let from: number;
    let to: number;
    if (side === 0 || side === 2) {
      touches = side === 0 ? Math.abs(o.y + o.d - v.y) < EPS * 10 : Math.abs(o.y - (v.y + v.d)) < EPS * 10;
      from = Math.max(o.x, v.x) - v.x;
      to = Math.min(o.x + o.w, v.x + v.w) - v.x;
    } else {
      touches = side === 3 ? Math.abs(o.x + o.w - v.x) < EPS * 10 : Math.abs(o.x - (v.x + v.w)) < EPS * 10;
      from = Math.max(o.y, v.y) - v.y;
      to = Math.min(o.y + o.d, v.y + v.d) - v.y;
    }
    if (touches && to - from > EPS) out.push([from, to]);
  }
  return out.sort((p, q) => p[0] - q[0]);
}

/** The parts of [a0, a1] no span covers. */
export function exposedParts(spans: readonly (readonly [number, number])[], a0: number, a1: number): [number, number][] {
  const out: [number, number][] = [];
  let from = a0;
  for (const [s0, s1] of spans) {
    if (s1 <= from + EPS || s0 >= a1 - EPS) continue;
    if (s0 > from + EPS) out.push([from, Math.min(s0, a1)]);
    from = Math.max(from, s1);
    if (from >= a1 - EPS) break;
  }
  if (a1 - from > EPS) out.push([from, a1]);
  return out;
}

// ------------------------------------------------------------------ reliefs

/** The relief a bay of a storey is in, if any (the last one listed wins). */
export function reliefAt(v: Volume, side: Side, index: number, storey: number): Relief | null {
  const list = v.reliefs;
  if (!list) return null;
  for (let i = list.length - 1; i >= 0; i--) {
    const r = list[i] as Relief;
    if (r.side === side && index >= r.bay0 && index <= r.bay1 && storey >= r.storey0 && storey <= r.storey1) return r;
  }
  return null;
}

/**
 * The plan rectangle a relief's region occupies in front of its face, local
 * frame, world units: [x0, y0, x1, y1]. Only a projection has one.
 */
export function projectionRect(b: Building, v: Volume, r: Relief): [number, number, number, number] | null {
  if (r.depth <= 0) return null;
  const w = bayWidth(b, v, r.side);
  const count = baysOn(b, v, r.side);
  const a0 = Math.max(0, r.bay0) * w;
  const a1 = (Math.min(count - 1, r.bay1) + 1) * w;
  switch (r.side) {
    case 0: return [v.x + a0, v.y - r.depth, v.x + a1, v.y];
    case 2: return [v.x + a0, v.y + v.d, v.x + a1, v.y + v.d + r.depth];
    case 1: return [v.x + v.w, v.y + a0, v.x + v.w + r.depth, v.y + a1];
    default: return [v.x - r.depth, v.y + a0, v.x, v.y + a1];
  }
}

/**
 * World rings of the projections that stand on the ground (from the first
 * storey of a ground volume): part of the footprint for the road and
 * neighbour tests, like the volumes themselves.
 */
export function groundProjections(b: Building, grow = 0): Vec2[][] {
  const out: Vec2[][] = [];
  for (const v of groundVolumes(b)) {
    for (const r of v.reliefs ?? []) {
      if (r.storey0 !== 0) continue;
      const rect = projectionRect(b, v, r);
      if (!rect) continue;
      const [x0, y0, x1, y1] = rect;
      out.push([
        localToWorld(b, x0 - grow, y0 - grow),
        localToWorld(b, x1 + grow, y0 - grow),
        localToWorld(b, x1 + grow, y1 + grow),
        localToWorld(b, x0 - grow, y1 + grow),
      ]);
    }
  }
  return out;
}

/** Local centre of bay `index` on the facade line of `side`. */
export function bayCentreLocal(b: Building, v: Volume, side: Side, index: number): Vec2 {
  const s = sideStart(v, side);
  const a = (index + 0.5) * bayWidth(b, v, side);
  return { x: s.x + s.tx * a, y: s.y + s.ty * a };
}

/** One exposed bay (or piece of one) of one storey: everything a mesh builder or a picker needs. */
export interface FacadeBay {
  readonly volume: number;
  /** Storey index within the volume. */
  readonly storey: number;
  readonly level: number;
  readonly side: Side;
  readonly index: number;
  readonly component: BayComponent;
  /** World point at the bottom centre of the bay (of the piece), on the facade line. */
  readonly x: number;
  readonly y: number;
  /** Outward normal, world. */
  readonly nx: number;
  readonly ny: number;
  /** Height of the bay's floor above the building's ground floor. */
  readonly z: number;
  /** Where the piece starts along the side, local units from the side's start. */
  readonly start: number;
  /** How far the bay's plane stands out from the side (negative: set back), by a relief. */
  readonly push: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Every bay that is an OUTSIDE wall. A stretch of a side that another volume
 * stands against on the same level is a shared wall and is left out; a bay
 * only partly against one keeps its exposed piece, as plain wall.
 */
export function facadeBays(b: Building): FacadeBay[] {
  const out: FacadeBay[] = [];
  const elevations: number[] = [];
  const top = topLevel(b);
  for (let level = 0; level <= top; level++) elevations.push(levelElevation(b, level));
  for (const v of b.volumes) {
    for (let k = 0; k < v.storeys.length; k++) {
      const storey = v.storeys[k];
      if (!storey) continue;
      const level = v.base + k;
      const z = elevations[level] ?? levelElevation(b, level);
      const height = levelHeight(b, level);
      for (const side of SIDES) {
        const n = SIDE_NORMAL[side];
        const normal = localDirToWorld(b, n.x, n.y);
        const count = baysOn(b, v, side);
        const width = bayWidth(b, v, side);
        const spans = coveredSpans(b, v, side, level);
        const s = sideStart(v, side);
        for (let index = 0; index < count; index++) {
          const a0 = index * width;
          const a1 = a0 + width;
          const parts = spans.length === 0 ? [[a0, a1] as [number, number]] : exposedParts(spans, a0, a1);
          const first = parts[0];
          const whole = parts.length === 1 && first !== undefined && Math.abs(first[0] - a0) < EPS && Math.abs(first[1] - a1) < EPS;
          const push = reliefAt(v, side, index, k)?.depth ?? 0;
          for (const [p0, p1] of parts) {
            const mid = (p0 + p1) / 2;
            const world = localToWorld(b, s.x + s.tx * mid + n.x * push, s.y + s.ty * mid + n.y * push);
            out.push({
              volume: v.id,
              storey: k,
              level,
              side,
              index,
              component: whole ? componentAt(storey.facade, side, index) : 'wall',
              x: world.x,
              y: world.y,
              nx: normal.x,
              ny: normal.y,
              z,
              start: p0,
              push,
              width: p1 - p0,
              height,
            });
          }
        }
      }
    }
  }
  return out;
}

// ------------------------------------------------------------------ roofs

/** Default roof pitches, degrees. */
export const DEFAULT_PITCH: Readonly<Record<string, number>> = { gable: 30, hip: 30, shed: 12, sawtooth: 35 };

/** A volume's roof pitch as rise over run. */
export function roofSlope(v: Volume): number {
  const degrees = v.pitch ?? DEFAULT_PITCH[v.roof] ?? 30;
  return Math.tan((degrees * Math.PI) / 180);
}

/** Whether a gable or hip ridge runs along the local x axis: as set, else along the longer side. */
export const ridgeAlongX = (v: Volume): boolean => (v.ridge ? v.ridge === 'x' : v.w >= v.d);

/** The side a shed roof falls towards. */
export const shedFall = (v: Volume): Side => v.fall ?? 0;

/** The run of one sawtooth: two modules, or the whole depth if less. */
export const sawtoothRun = (b: Building, v: Volume): number => Math.min(2 * b.module, v.d);

/** How far a volume's roof rises above its top floor, world units. */
export function roofRise(b: Building, v: Volume): number {
  const slope = roofSlope(v);
  switch (v.roof) {
    case 'gable':
    case 'hip':
      return (ridgeAlongX(v) ? v.d : v.w) * 0.5 * slope;
    case 'shed': {
      const fall = shedFall(v);
      return (fall === 0 || fall === 2 ? v.d : v.w) * slope;
    }
    case 'sawtooth':
      return sawtoothRun(b, v) * 0.5 * slope;
    default:
      return 0;
  }
}

/** Height of a volume's top (eaves), above the building's ground floor. */
export const volumeHeight = (b: Building, v: Volume): number => levelElevation(b, volumeTop(v));

/** The highest point of the building above its ground floor. */
export function buildingHeight(b: Building): number {
  let h = 0;
  for (const v of b.volumes) h = Math.max(h, volumeHeight(b, v) + roofRise(b, v));
  return h;
}
