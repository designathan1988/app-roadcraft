import type { Vec2 } from '@core/vec2';
import {
  type BayComponent,
  type Building,
  type Side,
  type Volume,
  SIDES,
  baysOn,
  componentAt,
  volumeTop,
} from './types';

/**
 * Every spatial question about a building, answered from the record.
 *
 * The local frame: origin at `(b.x, b.y)`, +x along `rotation`, +y a quarter
 * turn anticlockwise of it. Cells are `module` squares; cell `(i, j)` spans
 * `[i, i+1] x [j, j+1]` modules.
 */

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

// ------------------------------------------------------------------ plan

/** Local rectangle of a volume, world units: [x0, y0, x1, y1]. */
export function volumeRectLocal(b: Building, v: Volume): [number, number, number, number] {
  const u = b.module;
  return [v.x * u, v.y * u, (v.x + v.w) * u, (v.y + v.d) * u];
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

/** Local bounding box of the footprint, in cells. */
export function footprintCells(b: Building): { x0: number; y0: number; x1: number; y1: number } {
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
  if (!Number.isFinite(x0)) return { x0: 0, y0: 0, x1: 1, y1: 1 };
  return { x0, y0, x1, y1 };
}

/** World centre of the footprint's bounding box. */
export function footprintCentre(b: Building): Vec2 {
  const f = footprintCells(b);
  return localToWorld(b, ((f.x0 + f.x1) / 2) * b.module, ((f.y0 + f.y1) / 2) * b.module);
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

// ------------------------------------------------------------------ occupancy

const cellKey = (i: number, j: number, level: number): string => `${i},${j},${level}`;

/** Which volume holds each `(cell, level)`. A second holder is an overlap. */
export interface Occupancy {
  readonly owner: Map<string, number>;
  /** Pairs of volume ids found sharing a cell on a level. */
  readonly clashes: [number, number][];
  at(i: number, j: number, level: number): number | undefined;
}

export function occupancy(b: Building): Occupancy {
  const owner = new Map<string, number>();
  const clashes: [number, number][] = [];
  for (const v of b.volumes) {
    for (let k = 0; k < v.storeys.length; k++) {
      const level = v.base + k;
      for (let i = v.x; i < v.x + v.w; i++) {
        for (let j = v.y; j < v.y + v.d; j++) {
          const key = cellKey(i, j, level);
          const held = owner.get(key);
          if (held !== undefined && held !== v.id) clashes.push([held, v.id]);
          else owner.set(key, v.id);
        }
      }
    }
  }
  return { owner, clashes, at: (i, j, level) => owner.get(cellKey(i, j, level)) };
}

/** The cell just outside bay `index` of `side`. */
export function cellBeyond(v: Volume, side: Side, index: number): [number, number] {
  switch (side) {
    case 0: return [v.x + index, v.y - 1];
    case 1: return [v.x + v.w, v.y + index];
    case 2: return [v.x + index, v.y + v.d];
    default: return [v.x - 1, v.y + index];
  }
}

/** Local centre of bay `index` on the facade line of `side`. */
export function bayCentreLocal(b: Building, v: Volume, side: Side, index: number): Vec2 {
  const u = b.module;
  switch (side) {
    case 0: return { x: (v.x + index + 0.5) * u, y: v.y * u };
    case 1: return { x: (v.x + v.w) * u, y: (v.y + index + 0.5) * u };
    case 2: return { x: (v.x + index + 0.5) * u, y: (v.y + v.d) * u };
    default: return { x: v.x * u, y: (v.y + index + 0.5) * u };
  }
}

/** One exposed bay of one storey: everything a mesh builder or a picker needs. */
export interface FacadeBay {
  readonly volume: number;
  /** Storey index within the volume. */
  readonly storey: number;
  readonly level: number;
  readonly side: Side;
  readonly index: number;
  readonly component: BayComponent;
  /** World point at the bottom centre of the bay, on the facade line. */
  readonly x: number;
  readonly y: number;
  /** Outward normal, world. */
  readonly nx: number;
  readonly ny: number;
  /** Height of the bay's floor above the building's ground floor. */
  readonly z: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Every bay that is an OUTSIDE wall. A bay whose neighbouring cell on the
 * same level belongs to another volume is a shared wall and is left out.
 */
export function facadeBays(b: Building, occ: Occupancy = occupancy(b)): FacadeBay[] {
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
        const count = baysOn(v, side);
        for (let index = 0; index < count; index++) {
          const [ci, cj] = cellBeyond(v, side, index);
          if (occ.at(ci, cj, level) !== undefined) continue;
          const local = bayCentreLocal(b, v, side, index);
          const world = localToWorld(b, local.x, local.y);
          out.push({
            volume: v.id,
            storey: k,
            level,
            side,
            index,
            component: componentAt(storey.facade, side, index),
            x: world.x,
            y: world.y,
            nx: normal.x,
            ny: normal.y,
            z,
            width: b.module,
            height,
          });
        }
      }
    }
  }
  return out;
}

// ------------------------------------------------------------------ roofs

/** Roof pitches, as rise over run. */
export const GABLE_PITCH = Math.tan((30 * Math.PI) / 180);
export const SHED_PITCH = Math.tan((12 * Math.PI) / 180);
export const SAWTOOTH_PITCH = Math.tan((35 * Math.PI) / 180);

/** How far a volume's roof rises above its top floor, world units. */
export function roofRise(b: Building, v: Volume): number {
  const u = b.module;
  switch (v.roof) {
    case 'gable':
    case 'hip':
      return (Math.min(v.w, v.d) * u * 0.5) * GABLE_PITCH;
    case 'shed':
      return v.d * u * SHED_PITCH;
    case 'sawtooth':
      return Math.min(2, v.d) * u * 0.5 * SAWTOOTH_PITCH;
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
