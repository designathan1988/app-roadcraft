import type { SimWorld } from '@sim/world';
import type { Resident } from '@sim/city/population';
import type { GestureView, PedView } from '@sim/people/view';
import { floorHeight, type GroundAt, type PavedAt } from '@world/buildings/foundation';
import { levelElevation, levelHeight, localToWorld } from '@world/buildings/geometry';
import { FURNITURE_SIZE, LAMP_KINDS, type Furniture, type FurnitureKind, interiorAt } from '@world/buildings/interior';
import type { Building } from '@world/buildings/types';
import { m } from '@world/units';
import type { CutawaySpec } from './buildings/layer';

/**
 * The residents inside the buildings that are cut open: The Sims inside
 * SimCity. Whoever the city has in a building now (`sim/city`) is drawn on
 * the floor shown, using its furniture as the hour of the day has them use
 * it - breakfast at the kitchen counter and the table, the sofa in front of
 * the television in the evening, asleep in bed at night; at work at the desks,
 * behind the counters, at the tables and in the pews, some talking, some on
 * the phone - with the same bodies that walk the streets.
 */
export interface IndoorFigure {
  readonly view: PedView;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly heading: number;
  /** Tipped on to its side (radians): somebody asleep in bed. */
  readonly lean: number;
}

/** What a place at a piece of furniture is used for. */
type Use = 'sofa' | 'seat' | 'table' | 'desk' | 'counter' | 'kitchen' | 'shelf' | 'bed' | 'pew';

interface Spot {
  /** Where, in the building's own frame (to tell whose flat it is in). */
  readonly lx: number;
  readonly ly: number;
  readonly x: number;
  readonly y: number;
  readonly heading: number;
  readonly use: Use;
  /** Height of the body's base over the floor (a mattress). */
  readonly rise: number;
  readonly lean: number;
}

const USE: Partial<Record<FurnitureKind, Use>> = {
  sofa: 'sofa', armchair: 'sofa', chair: 'seat', officeChair: 'desk', seat: 'seat', pew: 'pew',
  table: 'table', counter: 'counter', stove: 'kitchen', sink: 'kitchen', fridge: 'kitchen',
  shelf: 'shelf', bookshelf: 'shelf', machine: 'counter', rack: 'shelf', atm: 'counter',
  bed: 'bed', singleBed: 'bed', wardBed: 'bed',
};
/** Uses a body sits at. */
const SITS: ReadonlySet<Use> = new Set(['sofa', 'seat', 'pew', 'desk']);
/** Most people drawn in one building. */
const PER_BUILDING = 28;
/** Most people drawn indoors in all: they share the crowd's ceiling with the street. */
const MAX_INDOOR = 140;
/** Ids of the indoor bodies, clear of the street's people and of anyone in a car. */
const INDOOR_BASE = 1 << 23;

const SEATED: GestureView = { kind: 'bench', phase: 'seated', t: 0 };
const PHONE: GestureView = { kind: 'phone', phase: 'hold', t: 0 };
const TALK: GestureView = { kind: 'talk', phase: 'hold', t: 0 };
const LOOK: GestureView = { kind: 'look', phase: 'hold', t: 0 };

/** Every place a body can be at the furniture of one floor, in world axes. */
function spotsOf(b: Building, level: number): Spot[] {
  const out: Spot[] = [];
  const c = Math.cos(b.rotation), s = Math.sin(b.rotation);
  const worldHeading = (dx: number, dy: number): number => Math.atan2(dx * s + dy * c, dx * c - dy * s);
  for (const f of interiorAt(b, level).furniture as Furniture[]) {
    const use = USE[f.kind];
    if (!use) continue;
    // The piece's front, in the building's frame (angle 0 faces -y).
    const fx = Math.sin(f.angle), fy = -Math.cos(f.angle);
    if (use === 'bed') {
      // Lying on the side along the bed, head on the pillow (the back end).
      const footOut = f.d / 2 - m(0.15);
      const p = localToWorld(b, f.x + fx * footOut, f.y + fy * footOut);
      const back = worldHeading(-fx, -fy);
      const [, , h] = FURNITURE_SIZE[f.kind];
      out.push({ lx: f.x, ly: f.y, x: p.x, y: p.y, heading: back - Math.PI / 2, use, rise: m(h * 0.95 + 0.12), lean: Math.PI / 2 });
      continue;
    }
    if (SITS.has(use)) {
      // Where somebody stands to sit down: just in front of the seat. The
      // seated clip carries the hips back on to it (set at the seat itself,
      // the body sank into the back of the sofa).
      const ahead = f.d / 2 + m(0.12);
      const p = localToWorld(b, f.x + fx * ahead, f.y + fy * ahead);
      out.push({ lx: f.x, ly: f.y, x: p.x, y: p.y, heading: worldHeading(fx, fy), use, rise: 0, lean: 0 });
      continue;
    }
    // Standing in front of it, facing it.
    const away = f.d / 2 + m(0.45);
    const p = localToWorld(b, f.x + fx * away, f.y + fy * away);
    out.push({ lx: f.x, ly: f.y, x: p.x, y: p.y, heading: worldHeading(-fx, -fy), use, rise: 0, lean: 0 });
  }
  return out;
}

/** The uses a resident looks for, in order, by where they are and the hour. */
function wants(r: Resident, building: number, hour: number): readonly Use[] {
  const home = r.home === building;
  if (home) {
    if (hour >= 23 || hour < 6.5) return ['bed'];
    // Breakfast: cooking at the counter, or seated at the table.
    if (hour < 8.5) return r.id % 2 ? ['kitchen', 'seat', 'counter'] : ['seat', 'kitchen', 'table'];
    // Supper at the table, then the evening in front of the television.
    if (hour >= 19 && hour < 20) return ['seat', 'sofa', 'kitchen'];
    if (hour >= 19) return ['sofa', 'seat', 'table'];
    return r.id % 3 === 0 ? ['seat', 'sofa', 'kitchen'] : ['sofa', 'seat', 'kitchen'];
  }
  if (r.work === building) {
    // Staff: at a desk, behind the counter, at the shelves.
    return r.id % 4 === 0 ? ['counter', 'shelf', 'desk', 'kitchen'] : ['desk', 'counter', 'seat', 'shelf', 'kitchen'];
  }
  // Out for a meal, a film, a service, a prayer: seated where there are seats.
  return ['seat', 'pew', 'sofa', 'shelf', 'counter', 'table'];
}

export class Indoors {
  private readonly spots = new Map<string, Spot[]>();
  private readonly floors = new Map<string, number>();
  private readonly views = new Map<number, PedView>();
  private revision = -1;

  /**
   * Where the room lights go on the floors cut open: one over each group of
   * furniture (a living room, a kitchen, a row of desks), nearest the middle of
   * the view first, at most `max`.
   */
lamps(world: SimWorld, spec: CutawaySpec | null, groundAt: GroundAt, pavedAt: PavedAt, max: number): { x: number; y: number; z: number }[] {
    const out: { x: number; y: number; z: number }[] = [];
    if (!spec) return out;
    const near = [...world.doc.buildings.all()]
      .map((b) => ({ b, d: Math.hypot(b.x - spec.x, b.y - spec.y) }))
      .filter((e) => (spec.only !== undefined ? e.b.id === spec.only : e.d <= spec.radius))
      .sort((a, c) => a.d - c.d);
    for (const { b } of near) {
      const key = `${b.id}:${spec.level}`;
      let floor = this.floors.get(key);
      if (floor === undefined) {
        floor = floorHeight(b, groundAt, pavedAt) + levelElevation(b, spec.level) + m(0.05);
        this.floors.set(key, floor);
      }
      // The light is where the fittings are: placed, moved and removed by the
      // player like any other piece (`interior.ts`, the Interior tab).
      for (const f of interiorAt(b, spec.level).furniture) {
        if (!LAMP_KINDS.has(f.kind)) continue;
        if (out.length >= max) return out;
        const p = localToWorld(b, f.x, f.y);
        const up = f.kind === 'ceilingLamp' ? levelHeight(b, spec.level) - m(0.6) : f.h * 0.9;
        out.push({ x: p.x, y: p.y, z: floor + up });
      }
    }
    return out;
  }

  /** Everybody to draw inside the buildings cut open by `spec`. */
  figures(world: SimWorld, spec: CutawaySpec | null, groundAt: GroundAt, pavedAt: PavedAt): IndoorFigure[] {
    if (!spec) return [];
    if (world.doc.buildings.revision !== this.revision) {
      this.revision = world.doc.buildings.revision;
      this.spots.clear();
      this.floors.clear();
    }
    const hour = (world.city.minutes(world) % 1440) / 60;
    const out: IndoorFigure[] = [];
    // Nearest the middle of the view first: the crowd has a ceiling, and the
    // buildings in id order filled it with people nobody was looking at.
    const near = [...world.doc.buildings.all()]
      .map((b) => ({ b, d: Math.hypot(b.x - spec.x, b.y - spec.y) }))
      .filter((e) => (spec.only !== undefined ? e.b.id === spec.only : e.d <= spec.radius))
      .sort((a, c) => a.d - c.d);
    for (const { b } of near) {
      if (out.length >= MAX_INDOOR) break;
      const inside = world.city.inside(b.id);
      if (inside.length === 0) continue;
      const key = `${b.id}:${spec.level}`;
      let spots = this.spots.get(key);
      if (!spots) { spots = spotsOf(b, spec.level); this.spots.set(key, spots); }
      if (spots.length === 0) continue;
      let floor = this.floors.get(key);
      if (floor === undefined) {
        floor = floorHeight(b, groundAt, pavedAt) + levelElevation(b, spec.level) + m(0.05);
        this.floors.set(key, floor);
      }
      // Each resident takes the first free place of the uses they want, in a
      // stable order: the same people in the same places frame to frame.
      const taken = new Set<number>();
      let shown = 0;
      for (const r of inside) {
        if (shown >= PER_BUILDING) break;
        // Only the people on this floor: at home on their own floor, at work
        // on their job's, visitors on the ground floor.
        const home = r.home === b.id;
        const floorOf = home ? r.homeLevel : r.work === b.id ? r.workLevel : 0;
        if (floorOf !== spec.level) continue;
        // At home, inside their own flat.
        const flat = home ? r.homeSpace : null;
        const inFlat = (sp: Spot): boolean => !flat ||
          (sp.lx >= flat.x - 1 && sp.lx <= flat.x + flat.w + 1 && sp.ly >= flat.y - 1 && sp.ly <= flat.y + flat.d + 1);
        let pick = -1;
        for (const use of wants(r, b.id, hour)) {
          const start = (r.id * 7) % spots.length;
          for (let k = 0; k < spots.length; k++) {
            const i = (start + k) % spots.length;
            if (!taken.has(i) && spots[i]!.use === use && inFlat(spots[i]!)) { pick = i; break; }
          }
          if (pick >= 0) break;
        }
        if (pick < 0) continue;
        taken.add(pick);
        shown++;
        const spot = spots[pick]!;
        const sitting = SITS.has(spot.use);
        // Something to do: a seated pair talks, somebody checks the phone,
        // somebody at a shelf looks along it.
        const gesture = spot.use === 'bed' ? null
          : sitting ? (r.id % 5 === 0 ? PHONE : SEATED)
            : r.id % 3 === 0 ? TALK : r.id % 3 === 1 ? (spot.use === 'shelf' ? LOOK : PHONE) : null;
        // One view per resident, kept from frame to frame: the renderer keeps
        // each body's animation by its view, and a new one every frame started
        // the clip over every frame - nobody ever finished sitting down.
        let view = this.views.get(r.id);
        if (!view || view.x !== spot.x || view.y !== spot.y) {
          view = {
            id: INDOOR_BASE + r.id,
            x: spot.x, y: spot.y, heading: spot.heading,
            prev: { x: spot.x, y: spot.y, heading: spot.heading },
            v: 0, turnV: 0, age: 0,
            ageClass: r.ageClass, gender: r.seed % 2 ? 'f' : 'm',
            party: { id: INDOOR_BASE + r.id, size: 1, archetype: 'solo', hasChild: false },
            rank: 0, ground: 'open', segment: undefined, stretch: '', walking: false, kerbWait: 0, waitingFor: null,
            gesture,
          };
          this.views.set(r.id, view);
        }
        view.gesture = gesture;
        view.age = world.clock.time + (r.id % 17);
        out.push({ view, x: spot.x, y: spot.y, z: floor + spot.rise, heading: spot.heading, lean: spot.lean });
      }
    }
    return out;
  }
}
