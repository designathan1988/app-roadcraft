import { pointInPolygon } from '@core/polygon';
import type { Vec2 } from '@core/vec2';
import { m } from '../units';
import { localFootprint } from './footprints';
import { baysOn } from './geometry';
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
  'ceilingLamp', 'floorLamp', 'tableLamp', 'stairs', 'stairwell',
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
  // A flight to the floor above (its foot at the front), and the opening it arrives through.
  stairs: [1, 3.4, 2.9], stairwell: [1.15, 3.5, 1],
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
      // A block of flats is laid out as flats, a house as a house, a hotel as rooms.
      if ((fn === 'apartments' || fn === 'residentialTower') && level > 0 && flatFloor(p, b)) break;
      if (fn === 'hotel' && level > 0 && roomsFloor(p, b, 1, hotelRoom)) break;
      if (fn === 'house' || fn === 'townhouse') { houseFloor(p, b, level); break; }
      if (fn === 'hotel' || level > 0) homeUnits(p, b, fn === 'hotel');
      else lobby(p);
      return;
    case 'office': case 'cityHall': case 'police': case 'courthouse': case 'postOffice':
      if (level === 0) {
        lobby(p);
        p.put(fn === 'postOffice' ? 'counter' : 'desk', cx, p.y0 + m(4), Math.PI);
        if (fn === 'police') { p.wallAcross(p.y1 - m(3), p.x0, p.x1, cx); p.grid('bars', p.x0, p.y1 - m(3), p.x1, p.y1 - m(2.9), m(3.2), m(0.2)); }
        if (fn === 'courthouse') { p.put('altar', cx, p.y1 - m(2), Math.PI); p.grid('pew', p.x0 + m(1), yStart + m(3), p.x1 - m(1), p.y1 - m(5), m(3.6), m(1.4)); }
      } else if (!roomsFloor(p, b, 2, officeRoom)) {
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
      if (level === 0 || !roomsFloor(p, b, 2, wardRoom)) wards(p, level === 0 ? p.y0 + m(10) : p.y0);
      return;
    case 'school': case 'university':
      if (!roomsFloor(p, b, 3, classRoom)) classrooms(p, yStart);
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
    case 'shop': case 'pharmacy': case 'bakery': case 'gasStation': {
      // Flats over the shop; on the street, the shop and its stockroom.
      if (level > 0 && flatFloor(p, b)) return;
      const back = backRoom(p, m(4));
      p.put('counter', cx, back - m(1.3), Math.PI);
      p.alongSide('shelf', 'left', yStart + m(1), back - m(1.5), m(2.2));
      p.alongSide('shelf', 'right', yStart + m(1), back - m(1.5), m(2.2));
      p.grid('shelf', p.x0 + m(2), yStart + m(1), p.x1 - m(2), back - m(2.6), m(3), m(2.4), RIGHT);
      if (back < p.y1) {
        for (let x = p.x0 + m(1); x <= p.x1 - m(2.6); x += m(2.6)) p.put('rack', x, p.y1 - m(0.9), face(0, -1));
        p.put('desk', p.x1 - m(1.3), back + m(1.2), face(0, 1));
        p.put('toilet', p.x1 - m(0.4), p.y1 - m(0.5), face(-1, 0));
      }
      return;
    }
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
    case 'restaurant': case 'snackBar': {
      if (level > 0 && flatFloor(p, b)) return;
      // The dining room, the counter, and the kitchen behind its wall.
      const back = backRoom(p, m(4.5));
      p.put('counter', cx, back - m(1.2), Math.PI);
      if (back < p.y1) kitchen(p, back);
      dining(p, p.y0 + m(0.6), back - m(2.4));
      return;
    }
    case 'bar': {
      if (level > 0 && flatFloor(p, b)) return;
      const back = backRoom(p, m(3.5));
      p.put('barCounter', cx, back - m(1.4), Math.PI);
      p.grid('seat', cx - m(1.8), back - m(2.7), cx + m(1.8), back - m(2.2), m(0.9), m(0.5), Math.PI);
      if (back < p.y1) kitchen(p, back);
      dining(p, p.y0 + m(0.6), back - m(3.4));
      return;
    }
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

/** One room off a corridor, as `roomsFloor` hands it to be furnished. */
interface RoomCell {
  readonly index: number;
  readonly count: number;
  readonly width: number;
  readonly depth: number;
  readonly bay: number;
  readonly corridor: boolean;
  /** Puts a piece at (u along the facade, s in from it), facing (du, ds) in those axes. */
  put(kind: FurnitureKind, u: number, s: number, du: number, ds: number): void;
  /** A wall from (u0, s0) to (u1, s1). */
  wall(u0: number, s0: number, u1: number, s1: number): void;
}

/**
 * A floor as rooms off a corridor, like the flats (`spaces.flatPlan`): rooms
 * `groupBays` window bays wide, walls between them on the bay boundaries, a
 * door from each to the corridor; `fill` furnishes each room for what it is.
 */
function roomsFloor(p: Plan, b: Building, groupBays: number, fill: (room: RoomCell) => void): boolean {
  const plan = flatPlan(b, p.v, groupBays);
  if (!plan.corridor && plan.flats.length < 2) return false;
  const DOOR = m(0.5);
  plan.flats.forEach((f, index) => {
    const P = (u: number, s: number): { x: number; y: number } => ({ x: f.ox + f.tx * u + f.nx * s, y: f.oy + f.ty * u + f.ny * s });
    const wall = (u0: number, s0: number, u1: number, s1: number): void => {
      const a = P(u0, s0), c = P(u1, s1);
      p.wall(a.x, a.y, c.x, c.y);
    };
    const W = f.width, D = f.depth;
    const door = Math.max(m(0.9), W - m(1.2));
    if (plan.corridor) {
      if (door - DOOR > 0) wall(0, D, door - DOOR, D);
      if (door + DOOR < W) wall(door + DOOR, D, W, D);
    }
    wall(0, 0, 0, D);
    fill({
      index, count: plan.flats.length, width: W, depth: D, bay: f.bay, corridor: !!plan.corridor,
      put(kind, u, s, du, ds) {
        const at = P(u, s);
        const fx = f.tx * du + f.nx * ds, fy = f.ty * du + f.ny * ds;
        p.put(kind, at.x, at.y, Math.atan2(fx, -fy));
      },
      wall,
    });
  });
  return true;
}

/**
 * An office room: rows of desks from the windows back, chairs behind them, a
 * shelf on the side wall; the first room a meeting room, the last the toilets
 * (cubicles along the corridor end, basins by the door).
 */
function officeRoom(r: RoomCell): void {
  if (r.index === 0) {
    const s = Math.min(r.depth / 2, m(4));
    r.put('table', r.width / 2, s, 0, -1);
    for (const side of [-1, 1]) for (const k of [-1, 0, 1]) r.put('chair', r.width / 2 + k * m(0.9), s + side * m(0.8), 0, -side);
    r.put('shelf', m(0.35), s, 1, 0);
    r.put('plant', m(0.4), m(0.4), 0, -1);
    deskRows(r, s + m(3));
    return;
  }
  if (r.index === r.count - 1) {
    const back = r.depth - m(1.6);
    r.wall(0, back, r.width - m(1.4), back);
    for (let u = m(0.6); u < r.width - m(1.6); u += m(1.1)) r.put('toilet', u, r.depth - m(0.5), 0, -1);
    r.put('sink', m(0.5), back - m(0.4), 0, -1);
    r.put('sink', m(1.8), back - m(0.4), 0, -1);
    deskRows(r, m(1.2), back - m(2.2));
    return;
  }
  deskRows(r, m(1.2));
  r.put('shelf', r.width - m(0.35), r.depth - m(1.2), -1, 0);
  r.put('plant', m(0.4), r.depth - m(0.6), 0, -1);
}

/** Rows of desks facing the windows, from `s0` in to `s1` (the corridor side by default). */
function deskRows(r: RoomCell, s0: number, s1 = r.depth - m(1.6)): void {
  for (let s = s0; s + m(0.8) <= s1; s += m(2.6)) {
    for (let u = m(1); u + m(0.8) <= r.width; u += m(1.8)) {
      r.put('desk', u, s, 0, -1);
      r.put('officeChair', u, s + m(0.9), 0, -1);
    }
  }
}

/** A classroom: the board on the side wall, desks and chairs facing it, the teacher's desk. */
function classRoom(r: RoomCell): void {
  r.put('blackboard', m(0.2), r.depth / 2, 1, 0);
  r.put('desk', m(1.6), r.depth / 2, 1, 0);
  for (let u = m(3.2); u + m(1.2) <= r.width; u += m(1.8)) {
    for (let s = m(1.2); s + m(0.6) <= r.depth - m(0.6); s += m(1.8)) {
      r.put('desk', u, s, -1, 0);
      r.put('chair', u + m(0.85), s, -1, 0);
    }
  }
}

/** A ward: beds along the side walls, heads to the wall, a chair by each. */
function wardRoom(r: RoomCell): void {
  for (let s = m(1.4); s + m(1) <= r.depth; s += m(2.4)) {
    r.put('wardBed', m(1.25), s, 1, 0);
    r.put('chair', m(2.55), s + m(1), -1, 0);
    if (r.width > m(5)) {
      r.put('wardBed', r.width - m(1.25), s, -1, 0);
      r.put('chair', r.width - m(2.55), s + m(1), 1, 0);
    }
  }
  r.put('plant', r.width / 2, m(0.4), 0, 1);
}

/** A hotel room: the bed, a desk by the window, a wardrobe, a bathroom by the corridor. */
function hotelRoom(r: RoomCell): void {
  // The bed's head to the side wall, the TV on the wall facing it.
  const bed = Math.min(m(3), r.depth / 2 - m(0.5));
  r.put('bed', m(1.1), bed, 1, 0);
  r.put('tv', r.width - m(0.3), bed, -1, 0);
  r.put('desk', r.width - m(0.8), m(0.6), 0, -1);
  r.put('wardrobe', r.width - m(0.35), r.depth - m(3), -1, 0);
  if (r.corridor) {
    r.wall(0, r.depth - m(2.2), r.width - m(1.6), r.depth - m(2.2));
    r.put('toilet', m(0.5), r.depth - m(0.5), 1, 0);
    r.put('bath', m(1.6), r.depth - m(1), 0, -1);
  }
}

/** The way a piece faces, as a direction in the floor's own axes (+y is the back). */
const face = (dx: number, dy: number): number => Math.atan2(dx, -dy);

/**
 * A room across the back of the floor, `depth` deep, behind a wall with a
 * door near its end: a stockroom, a kitchen. Returns where the wall stands
 * (the floor's back, when the floor is too shallow for one).
 */
function backRoom(p: Plan, depth: number): number {
  if (p.y1 - p.y0 < depth + m(6)) return p.y1;
  const y = p.y1 - depth;
  p.wallAcross(y, p.x0, p.x1, p.x1 - m(1.6));
  return y;
}

/** A kitchen behind `wall`: cooking along the back, a prep table. */
function kitchen(p: Plan, wall: number): void {
  for (let x = p.x0 + m(0.8); x <= p.x1 - m(2.5); x += m(1)) {
    const k = Math.round((x - p.x0) / m(1)) % 3;
    p.put(k === 0 ? 'stove' : k === 1 ? 'sink' : 'fridge', x, p.y1 - m(0.45), face(0, -1));
  }
  p.put('table', (p.x0 + p.x1) / 2, (wall + p.y1) / 2 - m(0.3), 0, 0.8);
}

/**
 * A floor of a house: walls on the bays' boundaries, so no wall cuts a
 * window. Downstairs the living room at the front (the sofa facing the TV
 * across it), the kitchen and the table behind; upstairs two bedrooms over
 * the front and a bathroom behind. A one-storey house has it all on one
 * floor; a garage holds its shelves; a small wing is a study.
 */
function houseFloor(p: Plan, b: Building, level: number): void {
  const v = p.v;
  const bays = Object.values(v.storeys[level - v.base]?.facade.bays ?? {});
  if (bays.includes('garageDoor')) {
    p.put('rack', p.x0 + m(0.5), (p.y0 + p.y1) / 2, face(1, 0));
    p.put('shelf', (p.x0 + p.x1) / 2, p.y1 - m(0.35), face(0, -1));
    return;
  }
  const W = p.x1 - p.x0, D = p.y1 - p.y0;
  if (W < m(5) || D < m(5)) {
    p.put('desk', (p.x0 + p.x1) / 2, p.y1 - m(0.6), face(0, -1));
    p.put('officeChair', (p.x0 + p.x1) / 2, p.y1 - m(1.4), face(0, 1));
    p.put('bookshelf', p.x0 + m(0.3), (p.y0 + p.y1) / 2, face(1, 0));
    return;
  }
  // The middle wall stands on a boundary between two front windows.
  const n = Math.max(1, baysOn(b, v, 0));
  const bay = v.w / n;
  const mid = Math.min(p.x1 - m(2.5), Math.max(p.x0 + m(2.5), v.x + Math.max(1, Math.round(n / 2)) * bay));
  const single = v.storeys.length === 1;
  const top = level === v.base + v.storeys.length - 1;
  // The stairs: along the back wall of the right-hand side, the foot towards
  // the middle; the same place on every floor, the opening over it above.
  const stairs0 = p.x1 - m(3.7);
  const stairX = p.x1 - m(1.85), stairY = p.y1 - m(0.6);
  const stairs = (): void => {
    if (!single) p.put(top ? 'stairwell' : 'stairs', stairX, stairY, face(-1, 0));
  };
  if (level === v.base) {
    const split = p.y0 + D * 0.5;
    p.wallAcross(split, p.x0, p.x1, mid);
    // Living room: the TV on a side wall, the sofa across from it.
    const ly = (p.y0 + split) / 2;
    p.put('tv', p.x0 + m(0.3), ly, face(1, 0));
    p.put('sofa', Math.min(p.x1 - m(0.8), p.x0 + m(3.6)), ly, face(-1, 0));
    p.put('armchair', Math.min(p.x1 - m(0.8), p.x0 + m(2.2)), p.y0 + m(0.8), face(0, 1));
    p.put('plant', p.x1 - m(0.5), p.y0 + m(0.5), 0);
    p.put('bookshelf', p.x1 - m(0.3), ly + m(0.6), face(-1, 0));
    stairs();
    // Kitchen along the back, the table in the middle of it.
    const kx1 = single ? mid - m(0.3) : Math.min(mid, stairs0) - m(0.2);
    for (const [kind, x] of [['fridge', p.x0 + m(0.5)], ['stove', p.x0 + m(1.4)], ['sink', p.x0 + m(2.4)]] as const) {
      if (x < kx1 - m(0.4)) p.put(kind, x, p.y1 - m(0.45), face(0, -1));
    }
    const tx = (p.x0 + kx1) / 2, ty = (split + p.y1) / 2 - m(0.4);
    p.put('table', tx, ty, 0);
    for (const dx of [-0.6, 0.6]) for (const dy of [-0.9, 0.9]) p.put('chair', tx + m(dx), ty + m(dy), face(0, dy > 0 ? -1 : 1));
    if (single) {
      // A one-storey house: the bedroom and the bathroom at the back.
      p.wallAlong(mid, split, p.y1, split + m(0.8));
      const bathY = p.y1 - m(2.2);
      p.wallAcross(bathY, mid, p.x1, mid + m(0.9));
      p.put('bed', p.x1 - m(1.15), (split + bathY) / 2, face(-1, 0));
      p.put('wardrobe', mid + m(0.4), (split + bathY) / 2 + m(0.6), face(1, 0));
      p.put('bath', p.x1 - m(0.5), p.y1 - m(1), face(0, -1));
      p.put('toilet', mid + m(0.5), p.y1 - m(0.45), face(0, -1));
    }
    return;
  }
  // Upstairs: two bedrooms at the front, each with its door on the landing
  // across the middle; behind it the bathroom (its door on the landing too)
  // and the stairs.
  const split = p.y0 + D * 0.5;
  const hall = split + m(1.2);
  const DOOR = m(0.5);
  const doors = [mid - m(1), mid + m(1)];
  let from = p.x0;
  for (const d of doors) {
    p.wall(from, split, d - DOOR, split);
    from = d + DOOR;
  }
  p.wall(from, split, p.x1, split);
  p.wall(mid, p.y0, mid, split);
  p.wallAcross(hall, p.x0, stairs0, stairs0 - m(1));
  p.wall(stairs0, hall, stairs0, p.y1);
  const by = (p.y0 + split) / 2;
  p.put('bed', p.x0 + m(1.15), by, face(1, 0));
  p.put('wardrobe', mid - m(0.4), p.y0 + m(1), face(-1, 0));
  p.put('bed', p.x1 - m(1.15), by, face(-1, 0));
  p.put('desk', mid + m(1), p.y0 + m(0.45), face(0, -1));
  p.put('bath', p.x0 + m(0.5), p.y1 - m(1), face(0, -1));
  p.put('toilet', stairs0 - m(0.5), p.y1 - m(0.45), face(0, -1));
  p.put('sink', (p.x0 + stairs0) / 2 + m(0.3), hall + m(0.4), face(0, 1));
  stairs();
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
      p.put('chair', x - m(0.9), y, RIGHT);
      p.put('chair', x + m(0.9), y, -RIGHT);
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
