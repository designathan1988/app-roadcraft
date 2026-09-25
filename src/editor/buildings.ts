import type { Vec2 } from '@core/vec2';
import { clamp } from '@core/scalar';
import {
  type BlueprintBody,
  DEFAULT_PALETTE,
  defaultFacade,
  storeyUse,
  upperStoreyFrom,
} from '@world/buildings/blueprints';
import { footprintCells, footprintRects, localDirToWorld, occupancy } from '@world/buildings/geometry';
import {
  type BuildingProblem,
  type SiteContext,
  touchesRoad,
  validateBuilding,
} from '@world/buildings/validate';
import {
  type BayComponent,
  type Building,
  type BuildingId,
  type BuildingUse,
  type Facade,
  type RoofKind,
  type Side,
  type Storey,
  type Volume,
  MAX_CELLS,
  MAX_MODULE,
  MAX_STOREYS,
  MAX_STOREY_HEIGHT,
  MIN_MODULE,
  MIN_STOREY_HEIGHT,
  PALETTE_COUNT,
  bayKey,
  cloneBuilding,
  componentAt,
  volumeById,
  volumeTop,
} from '@world/buildings/types';

/**
 * The building commands. See docs/buildings.md section 4.
 *
 * Two halves. The OPERATIONS (`op*`) change a draft building in place and say
 * whether they changed anything; they know nothing about the document, so the
 * tool can run them on a copy for a live preview. The COMMANDS run an
 * operation on a copy of a stored building, validate the copy, and only then
 * write it back. `main.ts` wraps every command in `mutateBuildings`, which
 * records the undo snapshot first.
 */

export type BuildingContext = SiteContext;

export interface EditResult {
  readonly ok: boolean;
  readonly problem?: BuildingProblem | 'missing';
  readonly id?: BuildingId;
  readonly volume?: number;
}

const FAIL_MISSING: EditResult = { ok: false, problem: 'missing' };
const UNCHANGED: EditResult = { ok: false };

// =============================================================== operations

/**
 * Storeys copied up when a volume is pulled taller: the top one, in the
 * building's own style. A ground storey's doors and shopfronts belong on the
 * street, so above it they become the windows that go with them.
 */
function storeyTemplate(v: Volume): Storey {
  const top = v.storeys[v.storeys.length - 1];
  if (!top) return { facade: { fill: 'window' } };
  if (v.base + v.storeys.length - 1 === 0) return upperStoreyFrom(top);
  return JSON.parse(JSON.stringify(top)) as Storey;
}

/** Whether two volumes share any cell in plan. */
const planOverlap = (a: Volume, c: Volume): boolean =>
  a.x < c.x + c.w && c.x < a.x + a.w && a.y < c.y + c.d && c.y < a.y + a.d;

/** Moves every volume standing on `v`'s old roof by `delta` levels, recursively. */
function rideWith(b: Building, v: Volume, oldTop: number, delta: number, seen = new Set<number>()): void {
  if (delta === 0) return;
  seen.add(v.id);
  for (const other of b.volumes) {
    if (seen.has(other.id) || other.base !== oldTop || !planOverlap(v, other)) continue;
    const otherTop = volumeTop(other);
    other.base += delta;
    rideWith(b, other, otherTop, delta, seen);
  }
}

/** Sets a volume's storey count; volumes stacked on it ride up or down with it. */
export function opSetStoreys(b: Building, volumeId: number, count: number): boolean {
  const v = volumeById(b, volumeId);
  if (!v) return false;
  const next = clamp(Math.round(count), 1, Math.max(1, MAX_STOREYS - v.base));
  if (next === v.storeys.length) return false;
  const oldTop = volumeTop(v);
  while (v.storeys.length < next) v.storeys.push(storeyTemplate(v));
  v.storeys.length = next;
  rideWith(b, v, oldTop, volumeTop(v) - oldTop);
  return true;
}

/** Re-indexes single-bay overrides on `sides` by `shift` (a side grew at its start). */
function shiftBays(v: Volume, sides: readonly Side[], shift: number): void {
  if (shift === 0) return;
  for (const storey of v.storeys) {
    const bays = storey.facade.bays;
    if (!bays) continue;
    const next: Record<string, BayComponent> = {};
    for (const [key, value] of Object.entries(bays)) {
      const [s, i] = key.split(':').map(Number) as [number, number];
      if (sides.includes(s as Side)) {
        const moved = i + shift;
        if (moved >= 0) next[bayKey(s as Side, moved)] = value;
      } else {
        next[key] = value;
      }
    }
    storey.facade.bays = next;
  }
}

/** Moves one side of a volume by `delta` whole modules (out is positive). */
export function opResize(b: Building, volumeId: number, side: Side, delta: number): boolean {
  const v = volumeById(b, volumeId);
  if (!v || delta === 0) return false;
  const along = side === 1 || side === 3 ? 'w' : 'd';
  const size = clamp(v[along] + Math.round(delta), 1, MAX_CELLS);
  const change = size - v[along];
  if (change === 0) return false;
  v[along] = size;
  if (side === 3) {
    v.x -= change;
    shiftBays(v, [0, 2], change);
  } else if (side === 0) {
    v.y -= change;
    shiftBays(v, [1, 3], change);
  }
  return true;
}

/** Copies a volume's storeys for a new volume, keeping the facade fill. */
function copyStoreys(v: Volume, count = v.storeys.length): Storey[] {
  const out: Storey[] = [];
  for (let k = 0; k < count; k++) {
    const source = v.storeys[Math.min(k, v.storeys.length - 1)] as Storey;
    const facade: Facade = { fill: source.facade.fill };
    if (source.facade.sides) facade.sides = { ...source.facade.sides };
    const storey: Storey = { facade };
    if (source.use) storey.use = source.use;
    out.push(storey);
  }
  return out;
}

/**
 * Adds a wing against `side` of a volume: same base and height, `depth` cells
 * out, `length` cells along the side (default: about half of it, centred).
 * Returns the new volume's id, or null.
 */
export function opAddWing(b: Building, volumeId: number, side: Side, depth = 3, length?: number): number | null {
  const v = volumeById(b, volumeId);
  if (!v) return null;
  const sideLength = side === 0 || side === 2 ? v.w : v.d;
  const len = clamp(Math.round(length ?? Math.max(2, Math.ceil(sideLength / 2))), 1, MAX_CELLS);
  const out = clamp(Math.round(depth), 1, MAX_CELLS);
  const offset = Math.floor((sideLength - len) / 2);
  const wing: Volume = {
    id: b.nextVolumeId++,
    x: 0,
    y: 0,
    w: 1,
    d: 1,
    base: v.base,
    roof: v.roof === 'terrace' ? 'flat' : v.roof,
    storeys: copyStoreys(v),
  };
  // A wing is built in what its volume is built in.
  if (v.materials) wing.materials = JSON.parse(JSON.stringify(v.materials)) as NonNullable<Volume['materials']>;
  switch (side) {
    case 0: Object.assign(wing, { x: v.x + offset, y: v.y - out, w: len, d: out }); break;
    case 2: Object.assign(wing, { x: v.x + offset, y: v.y + v.d, w: len, d: out }); break;
    case 1: Object.assign(wing, { x: v.x + v.w, y: v.y + offset, w: out, d: len }); break;
    case 3: Object.assign(wing, { x: v.x - out, y: v.y + offset, w: out, d: len }); break;
  }
  // A wing's ground floor gets its own way in, on its outer face.
  if (wing.base === 0 && wing.storeys[0]) {
    const facade = wing.storeys[0].facade;
    const outer = side;
    const count = outer === 0 || outer === 2 ? wing.w : wing.d;
    facade.bays = { [bayKey(outer, Math.floor(count / 2))]: 'door' };
  }
  b.volumes.push(wing);
  return wing.id;
}

/**
 * Stacks a setback on a volume: inset by `inset` cells where the volume is
 * wide enough, `storeys` tall. The roof it stands on becomes a terrace.
 */
export function opAddSetback(b: Building, volumeId: number, inset = 1, storeys = 2): number | null {
  const v = volumeById(b, volumeId);
  if (!v) return null;
  const ix = v.w - 2 * inset >= 1 ? inset : 0;
  const iy = v.d - 2 * inset >= 1 ? inset : 0;
  const base = volumeTop(v);
  const template = storeyTemplate(v);
  const count = clamp(Math.round(storeys), 1, Math.max(1, MAX_STOREYS - base));
  const volume: Volume = {
    id: b.nextVolumeId++,
    x: v.x + ix,
    y: v.y + iy,
    w: v.w - 2 * ix,
    d: v.d - 2 * iy,
    base,
    roof: v.roof === 'terrace' ? 'flat' : v.roof,
    storeys: copyStoreys({ ...v, storeys: [template] }, count),
  };
  if (v.materials) volume.materials = JSON.parse(JSON.stringify(v.materials)) as NonNullable<Volume['materials']>;
  v.roof = 'terrace';
  b.volumes.push(volume);
  return volume.id;
}

/**
 * Removes a volume and everything that loses its support with it. Returns
 * false if nothing would be left standing on the ground (delete the building).
 */
export function opRemoveVolume(b: Building, volumeId: number): boolean {
  const index = b.volumes.findIndex((v) => v.id === volumeId);
  if (index < 0) return false;
  const remaining = b.volumes.filter((v) => v.id !== volumeId);
  if (!remaining.some((v) => v.base === 0)) return false;
  b.volumes = remaining;
  // Anything now hanging over nothing goes too, repeatedly: a tower on a
  // podium goes with the podium.
  for (let changed = true; changed;) {
    changed = false;
    const occ = occupancy(b);
    for (const v of b.volumes) {
      if (v.base === 0) continue;
      let supported = true;
      for (let i = v.x; i < v.x + v.w && supported; i++) {
        for (let j = v.y; j < v.y + v.d; j++) {
          if (occ.at(i, j, v.base - 1) === undefined) {
            supported = false;
            break;
          }
        }
      }
      if (!supported) {
        b.volumes = b.volumes.filter((u) => u.id !== v.id);
        changed = true;
        break;
      }
    }
  }
  return true;
}

export function opSetRoof(b: Building, volumeId: number, roof: RoofKind): boolean {
  const v = volumeById(b, volumeId);
  if (!v || v.roof === roof) return false;
  v.roof = roof;
  return true;
}

/** Changes the building's use; with `regenerate`, every facade is re-derived for it. */
export function opSetUse(b: Building, use: BuildingUse, regenerate = true): boolean {
  if (b.use === use && !regenerate) return false;
  b.use = use;
  b.palette = DEFAULT_PALETTE[use];
  if (regenerate) {
    for (const v of b.volumes) {
      v.storeys = v.storeys.map((storey, k) => {
        const level = v.base + k;
        const next: Storey = { facade: defaultFacade(use, level, v.w) };
        const own = storeyUse(use, level);
        if (own) next.use = own;
        if (storey.spaces) next.spaces = storey.spaces;
        return next;
      });
    }
  }
  return true;
}

export interface BuildingParameters {
  module?: number;
  groundHeight?: number;
  storeyHeight?: number;
  palette?: number;
}

export function opSetParameters(b: Building, p: BuildingParameters): boolean {
  let changed = false;
  const set = <K extends keyof BuildingParameters>(key: K, value: number): void => {
    if (b[key] !== value) {
      (b as unknown as Record<string, number>)[key] = value;
      changed = true;
    }
  };
  if (p.module !== undefined) set('module', clamp(p.module, MIN_MODULE, MAX_MODULE));
  if (p.groundHeight !== undefined) set('groundHeight', clamp(p.groundHeight, MIN_STOREY_HEIGHT, MAX_STOREY_HEIGHT));
  if (p.storeyHeight !== undefined) set('storeyHeight', clamp(p.storeyHeight, MIN_STOREY_HEIGHT, MAX_STOREY_HEIGHT));
  if (p.palette !== undefined) set('palette', ((Math.round(p.palette) % PALETTE_COUNT) + PALETTE_COUNT) % PALETTE_COUNT);
  return changed;
}

/** Overrides one level's height for the whole building; null restores the default. */
export function opSetLevelHeight(b: Building, level: number, height: number | null): boolean {
  if (level < 0 || level >= MAX_STOREYS) return false;
  const levels = b.levels ? [...b.levels] : [];
  while (levels.length <= level) levels.push(null);
  const value = height === null ? null : clamp(height, MIN_STOREY_HEIGHT, MAX_STOREY_HEIGHT);
  if (levels[level] === value) return false;
  levels[level] = value;
  while (levels.length > 0 && levels[levels.length - 1] === null) levels.pop();
  if (levels.length === 0) delete b.levels;
  else b.levels = levels;
  return true;
}

/** Where a component is applied when a bay is clicked. */
export type FacadeScope = 'bay' | 'storey' | 'side' | 'volume';

/**
 * Puts a component into the facade. `scope` widens the click: the one bay,
 * every bay of that storey, that side of every storey, or the whole volume.
 */
export function opSetComponent(
  b: Building,
  volumeId: number,
  storey: number,
  side: Side,
  index: number,
  component: BayComponent,
  scope: FacadeScope = 'bay',
): boolean {
  const v = volumeById(b, volumeId);
  const target = v?.storeys[storey];
  if (!v || !target) return false;
  const before = JSON.stringify(v.storeys);
  switch (scope) {
    case 'bay': {
      const key = bayKey(side, index);
      const bays = { ...(target.facade.bays ?? {}) };
      delete bays[key];
      const inherited = componentAt({ ...target.facade, bays }, side, index);
      if (inherited !== component) bays[key] = component;
      if (Object.keys(bays).length > 0) target.facade.bays = bays;
      else delete target.facade.bays;
      break;
    }
    case 'storey':
      target.facade = { fill: component };
      break;
    case 'side':
      for (const s of v.storeys) {
        s.facade.sides = { ...(s.facade.sides ?? {}), [side]: component };
        if (s.facade.bays) {
          for (const key of Object.keys(s.facade.bays)) if (key.startsWith(`${side}:`)) delete s.facade.bays[key];
        }
      }
      break;
    case 'volume':
      for (const s of v.storeys) s.facade = { fill: component };
      break;
  }
  return JSON.stringify(v.storeys) !== before;
}

export function opMove(b: Building, x: number, y: number): boolean {
  if (b.x === x && b.y === y) return false;
  b.x = x;
  b.y = y;
  return true;
}

/** Turns the building by `angle` about a world pivot (default: its footprint centre). */
export function opRotate(b: Building, angle: number, pivot?: Vec2): boolean {
  if (angle === 0) return false;
  const f = footprintCells(b);
  const centreLocal = { x: ((f.x0 + f.x1) / 2) * b.module, y: ((f.y0 + f.y1) / 2) * b.module };
  const toCentre = localDirToWorld(b, centreLocal.x, centreLocal.y);
  const p = pivot ?? { x: b.x + toCentre.x, y: b.y + toCentre.y };
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const dx = b.x - p.x;
  const dy = b.y - p.y;
  b.x = p.x + dx * c - dy * s;
  b.y = p.y + dx * s + dy * c;
  b.rotation = normaliseAngle(b.rotation + angle);
  return true;
}

export const normaliseAngle = (a: number): number => {
  const tau = Math.PI * 2;
  let r = a % tau;
  if (r > Math.PI) r -= tau;
  if (r <= -Math.PI) r += tau;
  return Math.abs(r) < 1e-12 ? 0 : r;
};

/**
 * A building record for a blueprint, placed so the middle of its FRONT edge
 * (the street side) is at `anchor`.
 */
export function instantiate(body: BlueprintBody, anchor: Vec2, rotation: number, blueprint?: string): Omit<Building, 'id'> {
  const draft = { ...(JSON.parse(JSON.stringify(body)) as BlueprintBody), x: 0, y: 0, rotation } as Omit<Building, 'id'>;
  const f = footprintCells(draft as Building);
  const local = { x: ((f.x0 + f.x1) / 2) * draft.module, y: f.y0 * draft.module };
  const offset = localDirToWorld(draft as Building, local.x, local.y);
  draft.x = anchor.x - offset.x;
  draft.y = anchor.y - offset.y;
  if (blueprint) draft.blueprint = blueprint;
  return draft;
}

// =============================================================== commands

/** Places a new building. The record is validated before it is stored. */
export function placeBuilding(
  ctx: BuildingContext,
  body: BlueprintBody,
  anchor: Vec2,
  rotation: number,
  blueprint?: string,
): EditResult {
  const draft = { ...instantiate(body, anchor, rotation, blueprint), id: ctx.doc.buildings.nextId } as Building;
  const problem = validateBuilding(ctx, draft);
  if (problem) return { ok: false, problem };
  const stored = ctx.doc.buildings.add(draft);
  return { ok: true, id: stored.id };
}

/** Stores an already-built record (a preview the tool validated) as a new building. */
export function addBuildingRecord(ctx: BuildingContext, record: Omit<Building, 'id'>): EditResult {
  const draft = { ...record, id: ctx.doc.buildings.nextId } as Building;
  const problem = validateBuilding(ctx, draft);
  if (problem) return { ok: false, problem };
  return { ok: true, id: ctx.doc.buildings.add(draft).id };
}

/**
 * Runs an operation on a copy of a stored building, validates the copy and
 * stores it. Nothing is written unless the result is valid.
 */
export function editBuilding(ctx: BuildingContext, id: BuildingId, op: (draft: Building) => boolean): EditResult {
  const current = ctx.doc.buildings.get(id);
  if (!current) return FAIL_MISSING;
  const draft = cloneBuilding(current);
  if (!op(draft)) return UNCHANGED;
  const problem = validateBuilding(ctx, draft, id);
  if (problem) return { ok: false, problem };
  ctx.doc.buildings.put(draft);
  return { ok: true, id };
}

/** Stores a complete replacement record for a building (the tool's drag result). */
export function replaceBuilding(ctx: BuildingContext, draft: Building): EditResult {
  if (!ctx.doc.buildings.has(draft.id)) return FAIL_MISSING;
  const problem = validateBuilding(ctx, draft, draft.id);
  if (problem) return { ok: false, problem };
  ctx.doc.buildings.put(draft);
  return { ok: true, id: draft.id };
}

export function deleteBuilding(ctx: BuildingContext, id: BuildingId): boolean {
  return ctx.doc.buildings.remove(id);
}

/** Removes a volume; the last volume on the ground removes the building. */
export function removeVolume(ctx: BuildingContext, id: BuildingId, volumeId: number): EditResult {
  const current = ctx.doc.buildings.get(id);
  if (!current) return FAIL_MISSING;
  const draft = cloneBuilding(current);
  if (!opRemoveVolume(draft, volumeId)) {
    ctx.doc.buildings.remove(id);
    return { ok: true };
  }
  const problem = validateBuilding(ctx, draft, id);
  if (problem) return { ok: false, problem };
  ctx.doc.buildings.put(draft);
  return { ok: true, id };
}

/**
 * A copy of a building beside it: tried to the right, left, behind and in
 * front, flush against the original (so a copied house makes a terrace).
 */
export function duplicateBuilding(ctx: BuildingContext, id: BuildingId): EditResult {
  const source = ctx.doc.buildings.get(id);
  if (!source) return FAIL_MISSING;
  const f = footprintCells(source);
  const width = (f.x1 - f.x0) * source.module;
  const depth = (f.y1 - f.y0) * source.module;
  let last: EditResult = { ok: false, problem: 'building' };
  for (const [lx, ly] of [[width, 0], [-width, 0], [0, depth], [0, -depth], [width * 2, 0], [-width * 2, 0]] as const) {
    const shift = localDirToWorld(source, lx, ly);
    const copy = cloneBuilding(source) as Omit<Building, 'id'> & { id?: BuildingId };
    delete copy.id;
    copy.x += shift.x;
    copy.y += shift.y;
    last = addBuildingRecord(ctx, copy);
    if (last.ok) return last;
  }
  return last;
}

/**
 * The road-wins rule (docs/buildings.md section 3): every building a road now
 * overlaps is removed. Returns how many were. Run after a road edit, inside
 * the same undo step.
 */
export function clearBuildingsOnRoads(ctx: BuildingContext): number {
  if (!ctx.net || ctx.doc.buildings.size === 0) return 0;
  const doomed: BuildingId[] = [];
  for (const b of ctx.doc.buildings.all()) {
    if (footprintRects(b, -0.05).some((rect) => touchesRoad(ctx.net!, rect))) doomed.push(b.id);
  }
  for (const id of doomed) ctx.doc.buildings.remove(id);
  return doomed.length;
}
