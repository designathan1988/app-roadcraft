import type { SimWorld } from '@sim/world';
import type { GestureView, PedView } from '@sim/people/view';
import { floorHeight, type GroundAt, type PavedAt } from '@world/buildings/foundation';
import { levelElevation, localToWorld } from '@world/buildings/geometry';
import { type Furniture, type FurnitureKind, interiorAt } from '@world/buildings/interior';
import type { Building } from '@world/buildings/types';
import { m } from '@world/units';
import type { CutawaySpec } from './buildings/layer';

/**
 * The residents inside the buildings that are cut open: The Sims inside
 * SimCity. Whoever the city has in a building now (`sim/city`) is drawn on
 * the floor shown, at its furniture - sitting on the sofas, at the desks, at
 * the tables and in the pews, standing at the counters and the shelves - with
 * the same bodies that walk the streets.
 */
export interface IndoorFigure {
  readonly view: PedView;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly heading: number;
}

/** Furniture people sit at, and furniture they stand at. */
const SEATS: ReadonlySet<FurnitureKind> = new Set(['sofa', 'armchair', 'chair', 'officeChair', 'seat', 'pew', 'bench' as FurnitureKind]);
const STANDS: ReadonlySet<FurnitureKind> = new Set(['counter', 'shelf', 'bookshelf', 'fridge', 'stove', 'sink', 'desk', 'table', 'machine', 'rack', 'atm', 'tv']);
/** Most people drawn in one building: a stadium's crowd is not this layer's job. */
const PER_BUILDING = 24;
/** Ids of the indoor bodies, clear of the street's people and of anyone in a car. */
const INDOOR_BASE = 1 << 23;

interface Spot { readonly x: number; readonly y: number; readonly heading: number; readonly sit: boolean }

const SEATED: GestureView = { kind: 'bench', phase: 'seated', t: 0 };
const PHONE: GestureView = { kind: 'phone', phase: 'hold', t: 0 };

/** Where people can be on one floor of a building, in world axes. */
function spotsOf(b: Building, level: number): Spot[] {
  const out: Spot[] = [];
  const turn = (f: Furniture): { fx: number; fy: number } => ({ fx: Math.sin(f.angle), fy: -Math.cos(f.angle) });
  for (const f of interiorAt(b, level).furniture) {
    const { fx, fy } = turn(f);
    let lx: number, ly: number, sit: boolean;
    if (SEATS.has(f.kind)) {
      // On the seat, facing the way it faces.
      lx = f.x; ly = f.y; sit = true;
    } else if (STANDS.has(f.kind)) {
      // In front of it, facing it.
      const out0 = f.d / 2 + m(0.5);
      lx = f.x + fx * out0; ly = f.y + fy * out0; sit = false;
    } else continue;
    const p = localToWorld(b, lx, ly);
    // Facing out of a seat; facing in to a counter. World heading of the
    // local direction, turned with the building.
    const dx = sit ? fx : -fx, dy = sit ? fy : -fy;
    const c = Math.cos(b.rotation), s = Math.sin(b.rotation);
    out.push({ x: p.x, y: p.y, heading: Math.atan2(dx * s + dy * c, dx * c - dy * s), sit });
  }
  return out;
}

export class Indoors {
  private readonly spots = new Map<string, Spot[]>();
  private readonly floors = new Map<string, number>();
  private revision = -1;

  /** Everybody to draw inside the buildings cut open by `spec`. */
  figures(world: SimWorld, spec: CutawaySpec | null, groundAt: GroundAt, pavedAt: PavedAt): IndoorFigure[] {
    if (!spec) return [];
    if (world.doc.buildings.revision !== this.revision) {
      this.revision = world.doc.buildings.revision;
      this.spots.clear();
      this.floors.clear();
    }
    const out: IndoorFigure[] = [];
    for (const b of world.doc.buildings.all()) {
      if (Math.hypot(b.x - spec.x, b.y - spec.y) > spec.radius) continue;
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
      // The same people in the same places from one frame to the next: by
      // resident, round the spots of the floor.
      const shown = Math.min(inside.length, spots.length, PER_BUILDING);
      for (let k = 0; k < shown; k++) {
        const r = inside[k]!;
        const spot = spots[(r.id * 7 + k) % spots.length]!;
        const view: PedView = {
          id: INDOOR_BASE + r.id,
          x: spot.x, y: spot.y, heading: spot.heading,
          prev: { x: spot.x, y: spot.y, heading: spot.heading },
          v: 0, turnV: 0, age: 30 + (r.id % 17),
          ageClass: r.ageClass, gender: r.seed % 2 ? 'f' : 'm',
          party: { id: INDOOR_BASE + r.id, size: 1, archetype: 'solo', hasChild: false },
          rank: 0, ground: 'open', segment: undefined, stretch: '', walking: false, kerbWait: 0, waitingFor: null,
          gesture: spot.sit ? SEATED : r.id % 4 === 0 ? PHONE : null,
        };
        out.push({ view, x: spot.x, y: spot.y, z: floor, heading: spot.heading });
      }
    }
    return out;
  }
}
