import { pointInPolygon } from '@core/polygon';
import type { Vec2 } from '@core/vec2';
import { m } from '../units';
import { localFootprint } from './footprints';
import { deriveSpaces, flatPlan } from './spaces';
import { type Building, type BuildingFunction, type Volume, volumeTop, type PlacedFurniture } from './types';

/**
 * What is inside a building, floor by floor: rooms, the walls between them
 * with their doorways, and the furniture people use - beds, sofas, tables,
 * desks, shelves, counters, pews, seats, beds of a ward, cells.
 *
 * Derived, never stored: from the building's function, its blocks and its
 * cores, the same every time, so a building edited is furnished anew and a
 * saved city stays small. The renderer draws it when a building is seen
 * inside; residents will use the same pieces as the places they go to (a
 * bed to sleep in, a desk to work at, a seat in the cinema).
 *
 * All in the building's local frame, world units.
 */

export const FURNITURE_KINDS = [
  'bed', 'singleBed', 'sofa', 'armchair', 'table', 'chair', 'desk', 'officeChair', 'shelf', 'bookshelf', 'counter',
  'fridge', 'stove', 'sink', 'toilet', 'bath', 'wardrobe', 'tv', 'plant', 'pew', 'seat', 'wardBed', 'bars', 'screen',
  'altar', 'machine', 'rack', 'locker', 'atm', 'stage', 'barCounter', 'blackboard', 'checkout', 'treadmill', 'pallet',
  'ceilingLamp', 'floorLamp', 'tableLamp',
] as const;
export type FurnitureKind = (typeof FURNITURE_KINDS)[number];

export interface Furniture {
  readonly kind: FurnitureKind;
  /** Centre, local frame. */
  readonly x: number;
  readonly y: number;
  /** Size across (along the facing's normal it is `d`). */
  readonly w: number;
  readonly d: number;
  readonly h: number;
  /** The way it faces, radians in the local frame (0 faces -y, the front). */
  readonly angle: number;
}

/** A thin wall between rooms, from (x0,y0) to (x1,y1). */
export interface Partition {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

export interface FloorInterior {
  readonly level: number;
  readonly furniture: readonly Furniture[];
  readonly partitions: readonly Partition[];
}

/** Sizes in metres: across, deep, high. */
export const FURNITURE_SIZE: Readonly<Record<FurnitureKind, readonly [number, number, number]>> = {
  bed: [1.6, 2, 0.55], singleBed: [0.9, 2, 0.5], sofa: [2.2, 0.9, 0.8], armchair: [0.9, 0.9, 0.85], table: [1.6, 0.9, 0.75],
  chair: [0.48, 0.48, 0.9], desk: [1.4, 0.7, 0.75], officeChair: [0.55, 0.55, 1], shelf: [2, 0.5, 1.9], bookshelf: [2.4, 0.4, 2.2],
  counter: [3, 0.7, 1.05], fridge: [0.7, 0.7, 1.8], stove: [0.7, 0.6, 0.9], sink: [1, 0.6, 0.9], toilet: [0.45, 0.7, 0.8],
  bath: [0.8, 1.7, 0.6], wardrobe: [1.6, 0.6, 2], tv: [1.2, 0.4, 1.1], plant: [0.5, 0.5, 1.2], pew: [3.2, 0.6, 0.95],
  seat: [0.6, 0.6, 1], wardBed: [1, 2.1, 0.75], bars: [3, 0.12, 2.6], screen: [8, 0.3, 4], altar: [2, 1, 1.1],
  machine: [1.6, 1.1, 1.6], rack: [4, 1.1, 3.2], locker: [0.5, 0.5, 1.9], atm: [0.7, 0.6, 1.6], stage: [5, 3, 0.6],
  barCounter: [4, 0.7, 1.1], blackboard: [4, 0.1, 1.2], checkout: [1.8, 0.8, 0.95], treadmill: [0.8, 1.9, 1.3], pallet: [1.2, 1, 1.2],
  ceilingLamp: [0.6, 0.6, 0.35], floorLamp: [0.45, 0.45, 1.6], tableLamp: [0.35, 0.35, 0.55],
};

/** The pieces that give light: the room lights are where these are. */
export const LAMP_KINDS: ReadonlySet<FurnitureKind> = new Set(['ceilingLamp', 'floorLamp', 'tableLamp']);
export const isFurnitureKind = (v: unknown): v is FurnitureKind => (FURNITURE_KINDS as readonly unknown[]).includes(v);

const RIGHT = Math.PI / 2;

/**
 * The building as drawn cut open at `level`: every block that reaches it
 * stops there, with no roof, and the floor's inside is drawn (`cutaway`).
 * Blocks that start above the level are gone; lots stay.
 */
export function cutOpen(b: Building, level: number, view?: { x: number; y: number }): Building {
  const top = Math.max(0, ...b.volumes.map((v) => volumeTop(v) - 1));
  const at = Math.max(0, Math.min(level, top));
  return {
    ...b,
    volumes: b.volumes
      .filter((v) => v.open || v.base <= at)
      .map((v) => (v.open ? v : { ...v, storeys: v.storeys.slice(0, at - v.base + 1) })),
    cutaway: at,
    ...(view ? { cutView: view } : {}),
  };
}

/** One floor of a building, inside. */
export function interiorAt(b: Building, level: number): FloorInterior {
  const out: Furniture[] = [];
  const walls: Partition[] = [];
  const fn = b.function ?? defaultFunction(b);
  for (const v of b.volumes) {
    if (v.open || v.mode === 'void' || v.mode === 'intersect') continue;
    if (!(v.base <= level && volumeTop(v) > level)) continue;
    const plan = new Plan(b, v, level);
    furnish(plan, fn, level, b);
    out.push(...plan.items);
    walls.push(...plan.walls);
  }
  // The player's own arrangement, where there is one; otherwise the one made
  // for the function, with a light over each room.
  const stored = b.furnishing?.[String(level)];
  const furniture = stored ? stored.filter((p) => isFurnitureKind(p.kind)).map(placed) : [...out, ...roomLights(out)];
  return { level, furniture, partitions: walls };
}

/** A placed piece at its kind's size. */
function placed(p: PlacedFurniture): Furniture {
  const kind = p.kind as FurnitureKind;
  const [w, d, h] = FURNITURE_SIZE[kind];
  return { kind, x: p.x, y: p.y, w: m(w), d: m(d), h: m(h), angle: p.angle };
}

/** A ceiling light over each group of furniture: a room's worth. */
function roomLights(items: readonly Furniture[]): Furniture[] {
  const rooms: { x: number; y: number; n: number }[] = [];
  for (const f of items) {
    const room = rooms.find((r) => Math.hypot(r.x / r.n - f.x, r.y / r.n - f.y) < m(4.5));
    if (room) { room.x += f.x; room.y += f.y; room.n++; } else rooms.push({ x: f.x, y: f.y, n: 1 });
  }
  const [w, d, h] = FURNITURE_SIZE.ceilingLamp;
  return rooms.map((r) => ({ kind: 'ceilingLamp' as const, x: r.x / r.n, y: r.y / r.n, w: m(w), d: m(d), h: m(h), angle: 0 }));
}

/** A floor's furniture as stored pieces: what an edit starts from. */
export function furnishingOf(b: Building, level: number): PlacedFurniture[] {
  return interiorAt(b, level).furniture.map((f) => ({ kind: f.kind, x: f.x, y: f.y, angle: f.angle }));
}

function defaultFunction(b: Building): BuildingFunction {
  if (b.use === 'residential') return 'apartments';
  if (b.use === 'industrial') return 'factory';
  if (b.use === 'mixed') return 'apartments';
  return 'office';
}

/** One block's floor, being furnished: where things may stand, and what stands. */
class Plan {
  readonly items: Furniture[] = [];
  readonly walls: Partition[] = [];
  readonly ring: Vec2[];
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
  private readonly cores: [number, number, number, number][];

  constructor(readonly b: Building, readonly v: Volume, readonly level: number) {
    this.ring = localFootprint(v);
    const inset = m(0.4);
    this.x0 = v.x + inset;
    this.y0 = v.y + inset;
    this.x1 = v.x + v.w - inset;
    this.y1 = v.y + v.d - inset;
    const u = b.module;
    this.cores = b.cores.filter((c) => c.from <= level && c.to >= level)
      .map((c) => [c.x - m(1), c.y - m(1.5), c.x + (c.kind === 'stair' ? 2 * u : u) + m(1), c.y + u + m(1)]);
  }

  get w(): number { return this.x1 - this.x0; }
  get d(): number { return this.y1 - this.y0; }

  /** Whether a piece of this size fits at (x, y): inside the walls, clear of the cores and what stands. */
  free(x: number, y: number, w: number, d: number, angle: number): boolean {
    const turned = Math.abs(Math.sin(angle)) > 0.5;
    const hw = (turned ? d : w) / 2;
    const hd = (turned ? w : d) / 2;
    for (const [cx, cy] of [[x - hw, y - hd], [x + hw, y - hd], [x + hw, y + hd], [x - hw, y + hd]] as const) {
      if (!pointInPolygon({ x: cx, y: cy }, this.ring)) return false;
    }
    for (const [a0, b0, a1, b1] of this.cores) if (x + hw > a0 && x - hw < a1 && y + hd > b0 && y - hd < b1) return false;
    for (const it of this.items) {
      const t2 = Math.abs(Math.sin(it.angle)) > 0.5;
      const iw = (t2 ? it.d : it.w) / 2 + m(0.15);
      const id = (t2 ? it.w : it.d) / 2 + m(0.15);
      if (Math.abs(it.x - x) < hw + iw && Math.abs(it.y - y) < hd + id) return false;
    }
    return true;
  }

  put(kind: FurnitureKind, x: number, y: number, angle = 0, scale = 1): boolean {
    const [w, d, h] = FURNITURE_SIZE[kind];
    const fw = m(w) * scale, fd = m(d) * scale, fh = m(h);
    if (!this.free(x, y, fw, fd, angle)) return false;
    this.items.push({ kind, x, y, w: fw, d: fd, h: fh, angle });
    return true;
  }

  /** A grid of `kind` filling a rectangle, `gx` x `gy` apart, all facing `angle`. */
  grid(kind: FurnitureKind, x0: number, y0: number, x1: number, y1: number, gx: number, gy: number, angle = 0): void {
    for (let y = y0 + gy / 2; y <= y1 - gy / 2 + 1e-6; y += gy) {
      for (let x = x0 + gx / 2; x <= x1 - gx / 2 + 1e-6; x += gx) this.put(kind, x, y, angle);
    }
  }

  /** Pieces along the back wall (or the left/right), facing into the room. */
  alongBack(kind: FurnitureKind, from: number, to: number, gap: number): void {
    const [, d] = FURNITURE_SIZE[kind];
    for (let x = from; x <= to + 1e-6; x += gap) this.put(kind, x, this.y1 - m(d) / 2 - m(0.05), Math.PI);
  }

  alongSide(kind: FurnitureKind, side: 'left' | 'right', from: number, to: number, gap: number): void {
    const [, d] = FURNITURE_SIZE[kind];
    const x = side === 'left' ? this.x0 + m(d) / 2 + m(0.05) : this.x1 - m(d) / 2 - m(0.05);
    for (let y = from; y <= to + 1e-6; y += gap) this.put(kind, x, y, side === 'left' ? -RIGHT : RIGHT);
  }

  wall(x0: number, y0: number, x1: number, y1: number): void {
    this.walls.push({ x0, y0, x1, y1 });
  }

  /** A wall across x at `y`, with a doorway at `door` (local x). */
  wallAcross(y: number, x0: number, x1: number, door: number): void {
    const half = m(0.5);
    if (door - half > x0) this.wall(x0, y, door - half, y);
    if (door + half < x1) this.wall(door + half, y, x1, y);
  }

  wallAlong(x: number, y0: number, y1: number, door: number): void {
    const half = m(0.5);
    if (door - half > y0) this.wall(x, y0, x, door - half);
    if (door + half < y1) this.wall(x, door + half, x, y1);
  }
}

/** Furnishes one block's floor according to what the building is for. */
function furnish(p: Plan, fn: BuildingFunction, level: number, b: Building): void {
  const cx = (p.x0 + p.x1) / 2;
  const front = level === 0 ? m(3.5) : 0;
  const yStart = p.y0 + front;
  switch (fn) {
    case 'house': case 'townhouse': case 'apartments': case 'residentialTower': case 'hotel':
      // A block of flats is laid out as flats; a house, a hotel as before.
      if ((fn === 'apartments' || fn === 'residentialTower') && level > 0 && flatFloor(p, b)) break;
      if (fn === 'hotel' || level > 0 || fn === 'house' || fn === 'townhouse') homeUnits(p, b, fn === 'hotel');
      else lobby(p);
      return;
    case 'office': case 'cityHall': case 'police': case 'courthouse': case 'postOffice':
      if (level === 0) {
        lobby(p);
        p.put(fn === 'postOffice' ? 'counter' : 'desk', cx, p.y0 + m(4), Math.PI);
        if (fn === 'police') { p.wallAcross(p.y1 - m(3), p.x0, p.x1, cx); p.grid('bars', p.x0, p.y1 - m(3), p.x1, p.y1 - m(2.9), m(3.2), m(0.2)); }
        if (fn === 'courthouse') { p.put('altar', cx, p.y1 - m(2), Math.PI); p.grid('pew', p.x0 + m(1), yStart + m(3), p.x1 - m(1), p.y1 - m(5), m(3.6), m(1.4)); }
      } else {
        p.grid('desk', p.x0 + m(0.5), yStart + m(0.5), p.x1 - m(0.5), p.y1 - m(0.5), m(2.4), m(2.6));
        for (const it of [...p.items]) if (it.kind === 'desk') p.put('officeChair', it.x, it.y - m(0.75), Math.PI);
        p.alongBack('plant', p.x0 + m(1), p.x1 - m(1), m(6));
      }
      return;
    case 'council':
      if (level === 0) lobby(p);
      p.put('altar', cx, p.y1 - m(1.5), Math.PI);
      p.grid('desk', p.x0 + m(1), yStart + m(2), p.x1 - m(1), p.y1 - m(4), m(2), m(2.2), Math.PI);
      return;
    case 'hospital': case 'clinic':
      if (level === 0) {
        p.put('counter', cx, p.y0 + m(4), Math.PI);
        p.grid('seat', p.x0 + m(1), p.y0 + m(6), p.x1 - m(1), p.y0 + m(9), m(0.8), m(1.2), Math.PI);
      }
      wards(p, level === 0 ? p.y0 + m(10) : p.y0);
      return;
    case 'school': case 'university':
      classrooms(p, yStart);
      return;
    case 'library':
      p.put('counter', cx, p.y0 + m(4), Math.PI);
      p.grid('bookshelf', p.x0 + m(1), yStart + m(3), p.x1 - m(1), p.y1 - m(1), m(3.2), m(2.6));
      p.grid('table', p.x0 + m(1), yStart + m(1), p.x1 - m(1), yStart + m(3), m(3), m(2));
      return;
    case 'museum':
      p.grid('altar', p.x0 + m(2), yStart + m(2), p.x1 - m(2), p.y1 - m(2), m(5), m(5));
      p.alongBack('screen', cx, cx, m(10));
      return;
    case 'prison':
      if (level === 0) lobby(p);
      cells(p, yStart);
      return;
    case 'church':
      p.put('altar', cx, p.y1 - m(2), Math.PI);
      p.grid('pew', p.x0 + m(1), yStart + m(1), p.x1 - m(1), p.y1 - m(5), Math.max(m(3.6), p.w / 2), m(1.3));
      return;
    case 'cemetery': case 'park': case 'square': case 'playground': case 'sportsCourt':
      return;
    case 'busStation':
      p.put('counter', p.x0 + m(3), p.y1 - m(2), Math.PI);
      p.grid('pew', p.x0 + m(4), yStart + m(1), p.x1 - m(1), p.y1 - m(4), m(4), m(1.6));
      return;
    case 'shop': case 'pharmacy': case 'bakery': case 'gasStation':
      p.put('counter', cx, p.y1 - m(2.5), Math.PI);
      p.alongSide('shelf', 'left', yStart + m(1), p.y1 - m(4), m(2.2));
      p.alongSide('shelf', 'right', yStart + m(1), p.y1 - m(4), m(2.2));
      p.grid('shelf', p.x0 + m(2), yStart + m(1), p.x1 - m(2), p.y1 - m(5), m(3), m(2.4), RIGHT);
      return;
    case 'supermarket':
      p.grid('checkout', p.x0 + m(1), p.y0 + m(3), p.x1 - m(1), p.y0 + m(5), m(3), m(2));
      p.grid('shelf', p.x0 + m(1), p.y0 + m(7), p.x1 - m(1), p.y1 - m(3), m(2.4), m(3.2), RIGHT);
      p.alongBack('fridge', p.x0 + m(1), p.x1 - m(1), m(0.8));
      return;
    case 'mall':
      shopsAround(p, yStart);
      return;
    case 'bank':
      p.put('counter', cx - m(2), p.y1 - m(3), Math.PI);
      p.put('counter', cx + m(2), p.y1 - m(3), Math.PI);
      p.alongSide('atm', 'left', yStart + m(1), yStart + m(4), m(1.2));
      p.grid('seat', p.x0 + m(4), yStart + m(1), p.x1 - m(4), yStart + m(4), m(0.8), m(1.4), Math.PI);
      if (level > 0) p.grid('desk', p.x0 + m(0.5), p.y0 + m(0.5), p.x1 - m(0.5), p.y1 - m(0.5), m(2.4), m(2.6));
      return;
    case 'restaurant': case 'snackBar':
      p.put('counter', cx, p.y1 - m(2), Math.PI);
      p.alongBack('stove', p.x0 + m(1), p.x0 + m(4), m(0.9));
      dining(p, yStart, p.y1 - m(4));
      return;
    case 'bar':
      p.put('barCounter', cx, p.y1 - m(2), Math.PI);
      p.grid('seat', cx - m(1.8), p.y1 - m(3.3), cx + m(1.8), p.y1 - m(2.8), m(0.9), m(0.5), Math.PI);
      dining(p, yStart, p.y1 - m(5));
      return;
    case 'nightclub':
      p.put('stage', cx, p.y1 - m(2), Math.PI);
      p.put('barCounter', p.x0 + m(3), cx, -RIGHT);
      p.grid('seat', p.x1 - m(4), yStart + m(1), p.x1 - m(1), p.y1 - m(5), m(1), m(1.2), RIGHT);
      return;
    case 'cinema':
      p.put('screen', cx, p.y1 - m(0.6), Math.PI);
      p.grid('seat', p.x0 + m(1.5), yStart + m(2), p.x1 - m(1.5), p.y1 - m(6), m(0.7), m(1.2), Math.PI);
      return;
    case 'gym':
      p.grid('treadmill', p.x0 + m(1), yStart + m(1), p.x1 - m(1), yStart + m(4), m(1.4), m(2.6), Math.PI);
      p.grid('machine', p.x0 + m(1), yStart + m(5), p.x1 - m(1), p.y1 - m(1), m(2.6), m(2.4));
      p.alongBack('locker', p.x0 + m(1), p.x1 - m(1), m(0.6));
      return;
    case 'club':
      p.grid('table', p.x0 + m(1), yStart + m(1), p.x1 - m(1), p.y1 - m(1), m(3), m(3));
      return;
    case 'fireStation':
      if (level === 0) p.alongBack('locker', p.x0 + m(1), p.x1 - m(1), m(0.6));
      else homeUnits(p, b, true);
      return;
    case 'factory':
      p.grid('machine', p.x0 + m(1.5), yStart + m(1.5), p.x1 - m(1.5), p.y1 - m(1.5), m(4), m(4));
      return;
    case 'warehouse':
      p.grid('rack', p.x0 + m(1), yStart + m(1), p.x1 - m(1), p.y1 - m(1), m(5), m(3.5));
      p.grid('pallet', p.x0 + m(1), yStart, p.x1 - m(1), yStart + m(1.5), m(2), m(1.5));
      return;
  }
}

function lobby(p: Plan): void {
  const cx = (p.x0 + p.x1) / 2;
  p.put('counter', cx, p.y0 + m(5), Math.PI);
  p.put('sofa', p.x0 + m(2), p.y0 + m(3), -RIGHT);
  p.put('plant', p.x0 + m(1), p.y0 + m(1));
  p.put('plant', p.x1 - m(1), p.y0 + m(1));
}

/** Homes (or hotel rooms) along the floor, each a few rooms with their furniture. */
/**
 * A floor of flats, from its plan (`spaces.ts`): the corridor's two walls with
 * a door into every home, the walls between homes on the boundaries between
 * window bays, and in each home a living room with its kitchen, a bedroom and
 * a bathroom, furnished.
 */
function flatFloor(p: Plan, b: Building): boolean {
  const plan = flatPlan(b, p.v);
  if (!plan.corridor && plan.flats.length < 2) return false;
  const DOOR = m(0.5);
  for (const f of plan.flats) {
    const P = (u: number, s: number): { x: number; y: number } => ({ x: f.ox + f.tx * u + f.nx * s, y: f.oy + f.ty * u + f.ny * s });
    const line = (u0: number, s0: number, u1: number, s1: number): void => {
      const a = P(u0, s0), c = P(u1, s1);
      p.wall(a.x, a.y, c.x, c.y);
    };
    // Facing a direction given in the home's own axes.
    const facing = (du: number, ds: number): number => {
      const fx = f.tx * du + f.nx * ds, fy = f.ty * du + f.ny * ds;
      return Math.atan2(fx, -fy);
    };
    const W = f.width, D = f.depth;
    const living = W - f.bay; // the bedroom takes the last bay
    const door = Math.min(living * 0.8, living - m(0.8));
    // The wall to the corridor (or the back), with the front door.
    if (plan.corridor) {
      if (door - DOOR > 0) line(0, D, door - DOOR, D);
      line(door + DOOR, D, W, D);
    }
    // The wall to the next home, between two windows.
    line(0, 0, 0, D);
    // Bedroom off the living room, its door near the corridor end.
    const bedDoor = D - m(1.4);
    line(living, 0, living, bedDoor - DOOR);
    line(living, bedDoor + DOOR, living, D - m(2.3));
    // The bathroom in the corridor corner of the bedroom bay.
    line(living, D - m(2.3), living + m(0.9) - DOOR, D - m(2.3));
    line(living + m(0.9) + DOOR, D - m(2.3), W, D - m(2.3));
    line(living, D - m(2.3), living, D);
    const put = (kind: FurnitureKind, u: number, s: number, angle: number): void => {
      const at = P(u, s);
      p.put(kind, at.x, at.y, angle);
    };
    // Living room: the TV on the side wall, the sofa facing it, a table by
    // the window, the kitchen along the corridor wall.
    put('tv', m(0.35), D * 0.42, facing(1, 0));
    put('sofa', Math.min(living - m(0.6), m(3.4)), D * 0.42, facing(-1, 0));
    put('table', living * 0.5, m(1.5), facing(0, -1));
    put('chair', living * 0.5 - m(0.6), m(2.2), facing(0, -1));
    put('chair', living * 0.5 + m(0.6), m(2.2), facing(0, -1));
    put('fridge', m(0.5), D - m(0.45), facing(0, -1));
    put('stove', m(1.3), D - m(0.4), facing(0, -1));
    put('sink', m(2.2), D - m(0.4), facing(0, -1));
    put('plant', living - m(0.4), m(0.45), 0);
    // Bedroom: the bed's head to the far wall, a wardrobe.
    put('bed', W - m(1.15), m(2.1), facing(-1, 0));
    put('wardrobe', living + f.bay / 2, D - m(2.65), facing(0, -1));
    // Bathroom.
    put('toilet', W - m(0.4), D - m(0.5), facing(-1, 0));
    put('bath', living + m(0.5), D - m(1.0), facing(0, -1));
  }
  return true;
}

function homeUnits(p: Plan, b: Building, hotel: boolean): void {
  const floor = deriveSpaces(b).find((s) => s.volume === p.v.id && s.level === p.level);
  const units = floor?.spaces.length ? floor.spaces : [{ x: p.v.x, y: p.v.y, w: p.v.w, d: p.v.d }];
  const alongX = p.v.w >= p.v.d;
  units.forEach((unit, i) => {
    const ux0 = Math.max(p.x0, unit.x), uy0 = Math.max(p.y0, unit.y);
    const ux1 = Math.min(p.x1, unit.x + unit.w), uy1 = Math.min(p.y1, unit.y + unit.d);
    const w = ux1 - ux0, d = uy1 - uy0;
    if (w < m(3) || d < m(3)) return;
    // The wall between this home and the next.
    if (i > 0) {
      if (alongX) p.wallAlong(ux0, uy0, uy1, uy0 + d * 0.15);
      else p.wallAcross(uy0, ux0, ux1, ux0 + w * 0.15);
    }
    const mid = uy0 + d * 0.55;
    if (hotel) {
      p.put('bed', ux0 + w / 2, uy1 - m(1.2), Math.PI);
      p.put('wardrobe', ux0 + m(0.9), uy0 + m(1), 0);
      p.put('desk', ux1 - m(1), mid, RIGHT);
      return;
    }
    // Living room at the front, bedroom at the back, kitchen and bath on the side.
    p.wallAcross(mid, ux0, ux1, ux0 + w * 0.3);
    // The sofa's back to the wall behind it, facing the television on the
    // front wall, which faces it back (angle 0 faces -y).
    p.put('sofa', ux0 + w * 0.45, mid - m(1.1), 0);
    p.put('tv', ux0 + w * 0.45, uy0 + m(0.4), Math.PI);
    p.put('table', ux0 + w * 0.75, uy0 + (mid - uy0) / 2, 0);
    // Chairs at the table, facing it.
    p.put('chair', ux0 + w * 0.75 - m(0.6), uy0 + (mid - uy0) / 2 + m(0.7), 0);
    p.put('chair', ux0 + w * 0.75 + m(0.6), uy0 + (mid - uy0) / 2 + m(0.7), 0);
    p.put('fridge', ux1 - m(0.5), uy0 + m(0.5), 0);
    p.put('stove', ux1 - m(1.4), uy0 + m(0.4), 0);
    p.put('sink', ux1 - m(2.4), uy0 + m(0.4), 0);
    p.put('bed', ux0 + w * 0.35, uy1 - m(1.2), Math.PI);
    p.put('wardrobe', ux0 + w * 0.75, uy1 - m(0.4), Math.PI);
    if (w > m(6)) {
      p.wallAlong(ux1 - m(2.6), mid, uy1, mid + m(0.8));
      p.put('bath', ux1 - m(0.6), uy1 - m(1.2), 0);
      p.put('toilet', ux1 - m(1.8), uy1 - m(0.5), Math.PI);
    }
    p.put('plant', ux0 + m(0.5), uy0 + m(0.5));
  });
}

function wards(p: Plan, from: number): void {
  const cx = (p.x0 + p.x1) / 2;
  p.wallAcross(from + m(0.5), p.x0, p.x1, cx);
  p.grid('wardBed', p.x0 + m(0.5), from + m(1), p.x1 - m(0.5), p.y1 - m(0.5), m(2.2), m(3.2), Math.PI);
}

function classrooms(p: Plan, from: number): void {
  const room = m(9);
  for (let x = p.x0; x + m(5) <= p.x1; x += room) {
    const x1 = Math.min(p.x1, x + room);
    if (x > p.x0) p.wallAlong(x, from, p.y1, from + m(1));
    p.put('blackboard', (x + x1) / 2, p.y1 - m(0.2), Math.PI);
    p.put('desk', (x + x1) / 2, p.y1 - m(1.6), Math.PI);
    const before = p.items.length;
    p.grid('desk', x + m(0.5), from + m(1), x1 - m(0.5), p.y1 - m(3), m(1.8), m(1.7), Math.PI);
    // A chair at every pupil's desk, on the side the pupil sits.
    for (const it of p.items.slice(before)) if (it.kind === 'desk') p.put('chair', it.x, it.y - m(0.7), Math.PI);
  }
}

function cells(p: Plan, from: number): void {
  const cell = m(3);
  for (let x = p.x0; x + cell <= p.x1 + 1e-6; x += cell) {
    p.wall(x, p.y1 - m(3), x, p.y1);
    p.put('bars', x + cell / 2, p.y1 - m(3), 0);
    p.put('singleBed', x + cell / 2, p.y1 - m(1.1), Math.PI);
  }
  p.grid('table', p.x0 + m(1), from + m(1), p.x1 - m(1), p.y1 - m(5), m(3.5), m(3));
}

function dining(p: Plan, from: number, to: number): void {
  for (let y = from + m(1); y <= to - m(1); y += m(2.6)) {
    for (let x = p.x0 + m(1.4); x <= p.x1 - m(1.4); x += m(2.8)) {
      if (!p.put('table', x, y, 0, 0.6)) continue;
      p.put('chair', x - m(0.75), y, RIGHT);
      p.put('chair', x + m(0.75), y, -RIGHT);
    }
  }
}

function shopsAround(p: Plan, from: number): void {
  const unit = m(8);
  for (let x = p.x0; x + unit <= p.x1 + 1e-6; x += unit) {
    p.wallAlong(x, p.y1 - m(8), p.y1, p.y1 - m(4));
    p.wallAcross(p.y1 - m(8), x, x + unit, x + unit / 2);
    p.put('counter', x + unit / 2, p.y1 - m(1.5), Math.PI);
    p.put('shelf', x + m(1), p.y1 - m(5), RIGHT);
  }
  p.grid('sofa', p.x0 + m(4), from + m(3), p.x1 - m(4), p.y1 - m(11), m(8), m(6));
  p.grid('plant', p.x0 + m(2), from + m(2), p.x1 - m(2), from + m(3), m(6), m(1));
}
