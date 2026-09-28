import type { Vec2 } from '@core/vec2';
import { edgeFrame, localFootprint, offsetRing, supportedBy, overlapArea, roofDetailRing } from '@world/buildings/footprints';
import { setVolumePlan } from './buildingPlans';
import { clamp } from '@core/scalar';
import { METERS_PER_UNIT } from '@world/units';
import {
  type BlueprintBody,
  DEFAULT_PALETTE,
  defaultFacade,
  storeyUse,
  upperStoreyFrom,
} from '@world/buildings/blueprints';
import { MAX_ELEMENT, MIN_ELEMENT, elementClash, elementRing, onGround, runFor, takeElementId } from '@world/buildings/elements';
import {
  GRID,
  MIN_SIZE,
  SIDE_NORMAL,
  baysOn,
  footprintBox,
  footprintCentre,
  footprintRects,
  isSupported,
  localDirToWorld,
  planOverlap,
} from '@world/buildings/geometry';
import {
  type BuildingProblem,
  type SiteContext,
  touchesRoad,
  validateBuilding,
} from '@world/buildings/validate';
import {
  type BayComponent,
  type Building,
  type BuildingElement,
  type BuildingId,
  type BuildingUse,
  type Facade,
  type Relief,
  type RoofKind,
  type FaceId,
  type Side,
  type Storey,
  type Volume,
  SIDES,
  MAX_MODULE,
  MAX_PITCH,
  MAX_PROJECTION,
  MAX_RECESS,
  MAX_SIZE,
  MIN_PITCH,
  MAX_STOREYS,
  MAX_STOREY_HEIGHT,
  MAX_GROUND_HEIGHT,
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

/** A length snapped to the editor's grid. */
export const snapLength = (v: number): number => Math.round(v / GRID) * GRID;

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
function shiftBays(v: Volume, sides: readonly FaceId[], shift: number): void {
  if (shift === 0) return;
  for (const storey of v.storeys) {
    const bays = storey.facade.bays;
    if (!bays) continue;
    const next: Record<string, BayComponent> = {};
    for (const [key, value] of Object.entries(bays)) {
      const [s, i] = key.split(':').map(Number) as [number, number];
      if (sides.includes(s)) {
        const moved = i + shift;
        if (moved >= 0) next[bayKey(s, moved)] = value;
      } else {
        next[key] = value;
      }
    }
    storey.facade.bays = next;
  }
}

/**
 * Moves one side of a volume by `delta` world units (out is positive),
 * snapped to the grid. Bays re-divide the new length; a side that grew at its
 * start keeps its single-bay overrides on the bays they were set on.
 */
export function opResize(b: Building, volumeId: number, side: Side, delta: number, snap = true): boolean {
  const v = volumeById(b, volumeId);
  if (!v || delta === 0) return false;
  const along = side === 1 || side === 3 ? 'w' : 'd';
  // Snapped to the grid unless the player holds Alt; free, to the centimetre.
  const size = clamp(snap ? snapLength(v[along] + delta) : Math.round((v[along] + delta) * METERS_PER_UNIT * 100) / 100 / METERS_PER_UNIT, MIN_SIZE, MAX_SIZE);
  const change = size - v[along];
  if (Math.abs(change) < 1e-9) return false;
  // The sides that run along the one moved, whose bays recount.
  const runs: [Side, Side] = along === 'w' ? [0, 2] : [1, 3];
  const before = baysOn(b, v, runs[0]);
  v[along] = size;
  if (side === 3) {
    v.x -= change;
    shiftBays(v, runs, baysOn(b, v, runs[0]) - before);
  } else if (side === 0) {
    v.y -= change;
    shiftBays(v, runs, baysOn(b, v, runs[0]) - before);
  }
  return true;
}

/** Copies a volume's storeys for a new volume, keeping the facade fill. */
function copyStoreys(v: Volume, count = v.storeys.length): Storey[] {
  const out: Storey[] = [];
  for (let k = 0; k < count; k++) {
    const source = v.storeys[Math.min(k, v.storeys.length - 1)] as Storey;
    const facade: Facade = { fill: source.facade.fill };
    if (source.facade.pattern) facade.pattern = source.facade.pattern;
    if (source.facade.patterns) facade.patterns = { ...source.facade.patterns };
    if (source.facade.sides) facade.sides = { ...source.facade.sides };
    const storey: Storey = { facade };
    if (source.use) storey.use = source.use;
    if (source.materials) storey.materials = structuredClone(source.materials);
    out.push(storey);
  }
  return out;
}

/**
 * Adds a wing against `side` of a volume: same base and height, `depth` world
 * units out, `length` along the side (default: about half of it, centred),
 * both snapped to the grid. Returns the new volume's id, or null.
 */
export function opAddWing(b: Building, volumeId: number, side: FaceId, depth?: number, length?: number): number | null {
  const v = volumeById(b, volumeId);
  if (!v) return null;
  if (v.outline) {
    const f = edgeFrame(v, side);
    const len = Math.min(f.length, Math.max(MIN_SIZE, snapLength(length ?? f.length * .6)));
    const out = Math.max(MIN_SIZE, snapLength(depth ?? 3 * b.module));
    const a = (f.length - len) / 2;
    const p0 = { x: f.x + f.tx * a, y: f.y + f.ty * a };
    const p1 = { x: p0.x + f.tx * len, y: p0.y + f.ty * len };
    const wing: Volume = { id: b.nextVolumeId++, x: 0, y: 0, w: 1, d: 1, base: v.base,
      roof: v.roof === 'terrace' ? 'flat' : v.roof, storeys: copyStoreys(v) };
    if (!setVolumePlan(wing, [p1, p0,
      { x: p0.x + f.nx * out, y: p0.y + f.ny * out },
      { x: p1.x + f.nx * out, y: p1.y + f.ny * out }])) return null;
    if (v.materials) wing.materials = JSON.parse(JSON.stringify(v.materials)) as NonNullable<Volume['materials']>;
    if (v.facadePattern) wing.facadePattern = v.facadePattern;
    if (wing.base === 0 && wing.storeys[0]) wing.storeys[0].facade.bays = { [bayKey(2, Math.floor(baysOn(b, wing, 2) / 2))]: 'door' };
    b.volumes.push(wing);
    return wing.id;
  }
  const sideLength = side === 0 || side === 2 ? v.w : v.d;
  const half = Math.max(2 * b.module, Math.ceil(sideLength / 2 / b.module) * b.module);
  const len = clamp(snapLength(Math.min(sideLength, length ?? half)), MIN_SIZE, MAX_SIZE);
  const out = clamp(snapLength(depth ?? 3 * b.module), MIN_SIZE, MAX_SIZE);
  const offset = snapLength((sideLength - len) / 2);
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
  if (v.facadePattern) wing.facadePattern = v.facadePattern;
  switch (side) {
    case 0: Object.assign(wing, { x: v.x + offset, y: v.y - out, w: len, d: out }); break;
    case 2: Object.assign(wing, { x: v.x + offset, y: v.y + v.d, w: len, d: out }); break;
    case 1: Object.assign(wing, { x: v.x + v.w, y: v.y + offset, w: out, d: len }); break;
    case 3: Object.assign(wing, { x: v.x - out, y: v.y + offset, w: out, d: len }); break;
  }
  // A wing's ground floor gets its own way in, on its outer face.
  if (wing.base === 0 && wing.storeys[0]) {
    const facade = wing.storeys[0].facade;
    facade.bays = { [bayKey(side, Math.floor(baysOn(b, wing, side) / 2))]: 'door' };
  }
  b.volumes.push(wing);
  return wing.id;
}

/**
 * Stacks a setback on a volume: inset by `inset` world units (default one
 * module) where the volume is wide enough, `storeys` tall. The roof it stands
 * on becomes a terrace.
 */
export function opAddSetback(b: Building, volumeId: number, inset?: number, storeys = 2): number | null {
  const v = volumeById(b, volumeId);
  if (!v) return null;
  const requested = Math.max(0, snapLength(inset ?? b.module));
  const step = v.outline && inset === undefined
    ? Math.min(requested, Math.max(GRID, snapLength(Math.min(v.w, v.d) * .1)))
    : requested;
  const ix = v.w - 2 * step >= MIN_SIZE ? step : 0;
  const iy = v.d - 2 * step >= MIN_SIZE ? step : 0;
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
  if (v.outline) {
    const ring = offsetRing(localFootprint(v), -step);
    if (!setVolumePlan(volume, ring) || !supportedBy(localFootprint(volume), [localFootprint(v)])) return null;
  }
  if (v.materials) volume.materials = JSON.parse(JSON.stringify(v.materials)) as NonNullable<Volume['materials']>;
  if (v.facadePattern) volume.facadePattern = v.facadePattern;
  if (v.facadeGeometry) volume.facadeGeometry = structuredClone(v.facadeGeometry);
  v.roof = 'terrace';
  if (v.roofDetails) v.roofDetails = v.roofDetails.filter((part) =>
    overlapArea(roofDetailRing(part), localFootprint(volume)) < 1e-5);
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
    for (const v of b.volumes) {
      if (!isSupported(b, v)) {
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
  if (p.groundHeight !== undefined) set('groundHeight', clamp(p.groundHeight, MIN_STOREY_HEIGHT, MAX_GROUND_HEIGHT));
  if (p.storeyHeight !== undefined) set('storeyHeight', clamp(p.storeyHeight, MIN_STOREY_HEIGHT, MAX_STOREY_HEIGHT));
  if (p.palette !== undefined) set('palette', ((Math.round(p.palette) % PALETTE_COUNT) + PALETTE_COUNT) % PALETTE_COUNT);
  return changed;
}

/** Overrides one level's height for the whole building; null restores the default. */
export function opSetLevelHeight(b: Building, level: number, height: number | null): boolean {
  if (level < 0 || level >= MAX_STOREYS) return false;
  const levels = b.levels ? [...b.levels] : [];
  while (levels.length <= level) levels.push(null);
  const value = height === null ? null : clamp(height, MIN_STOREY_HEIGHT, level === 0 ? MAX_GROUND_HEIGHT : MAX_STOREY_HEIGHT);
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
  side: FaceId,
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
  const f = footprintBox(b);
  const centreLocal = { x: (f.x0 + f.x1) / 2, y: (f.y0 + f.y1) / 2 };
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
  const f = footprintBox(draft as Building);
  const local = { x: (f.x0 + f.x1) / 2, y: f.y0 };
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
  const f = footprintBox(source);
  const width = f.x1 - f.x0;
  const depth = f.y1 - f.y0;
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
    if (footprintRects(b, -0.05).some((rect) => touchesRoad(ctx.net!, rect))) {
      doomed.push(b.id);
      continue;
    }
    // A stair or a wall the road now crosses goes; the building stays.
    const hit = (b.elements ?? []).filter((e) => onGround(e) && touchesRoad(ctx.net!, elementRing(b, e, -0.05)));
    if (hit.length > 0) {
      const draft = cloneBuilding(b);
      for (const e of hit) opRemoveElement(draft, e.id);
      ctx.doc.buildings.put(draft);
    }
  }
  for (const id of doomed) ctx.doc.buildings.remove(id);
  return doomed.length;
}

// =============================================================== faces and roofs

/** A rectangle of whole bays and storeys on one face of a volume, inclusive. */
export interface FaceRegion {
  readonly side: FaceId;
  readonly bay0: number;
  readonly bay1: number;
  readonly storey0: number;
  readonly storey1: number;
}

/** Depths a relief snaps to: five centimetres. */
export const RELIEF_STEP = 0.125;

/**
 * What is left of a relief once `region` is cut out of it: up to four
 * rectangles of bays and storeys, each keeping the relief's depth.
 */
function cutRelief(r: Relief, region: FaceRegion): Relief[] {
  if (r.side !== region.side || r.bay0 > region.bay1 || region.bay0 > r.bay1 || r.storey0 > region.storey1 || region.storey0 > r.storey1) {
    return [r];
  }
  const out: Relief[] = [];
  // Below and above the region, full width; then left and right of it, beside it.
  if (r.storey0 < region.storey0) out.push({ ...r, storey1: region.storey0 - 1 });
  if (r.storey1 > region.storey1) out.push({ ...r, storey0: region.storey1 + 1 });
  const storey0 = Math.max(r.storey0, region.storey0);
  const storey1 = Math.min(r.storey1, region.storey1);
  if (r.bay0 < region.bay0) out.push({ ...r, storey0, storey1, bay1: region.bay0 - 1 });
  if (r.bay1 > region.bay1) out.push({ ...r, storey0, storey1, bay0: region.bay1 + 1 });
  return out;
}

/**
 * Pushes a region of a face out (positive `depth`) or in (negative), in world
 * units snapped to `RELIEF_STEP`; 0 flattens it again. A relief the region
 * overlaps keeps the part of it outside the region.
 */
export function opSetRelief(b: Building, volumeId: number, region: FaceRegion, depth: number, snap = true): boolean {
  const v = volumeById(b, volumeId);
  if (!v) return false;
  const step = snap ? RELIEF_STEP : 0.025;
  const d = clamp(Math.round(depth / step) * step, -MAX_RECESS, MAX_PROJECTION);
  const before = JSON.stringify(v.reliefs ?? []);
  const kept = (v.reliefs ?? []).flatMap((r) => cutRelief(r, region));
  if (Math.abs(d) > 1e-9) kept.push({ ...region, depth: d });
  if (kept.length > 0) v.reliefs = kept;
  else delete v.reliefs;
  return JSON.stringify(v.reliefs ?? []) !== before;
}

export interface RoofShape {
  /** Degrees; null restores the roof kind's default. */
  readonly pitch?: number | null;
  readonly ridge?: 'x' | 'y' | null;
  readonly fall?: Side | null;
}

/** Changes the pitch, the ridge direction or the fall of a volume's roof. */
export function opSetRoofShape(b: Building, volumeId: number, shape: RoofShape): boolean {
  const v = volumeById(b, volumeId);
  if (!v) return false;
  const before = JSON.stringify([v.pitch, v.ridge, v.fall]);
  if (shape.pitch !== undefined) {
    if (shape.pitch === null) delete v.pitch;
    else v.pitch = clamp(Math.round(shape.pitch), MIN_PITCH, MAX_PITCH);
  }
  if (shape.ridge !== undefined) {
    if (shape.ridge === null) delete v.ridge;
    else v.ridge = shape.ridge;
  }
  if (shape.fall !== undefined) {
    if (shape.fall === null) delete v.fall;
    else v.fall = shape.fall;
  }
  return JSON.stringify([v.pitch, v.ridge, v.fall]) !== before;
}

// =============================================================== free elements

/** Adds a free element (validated with the building by the caller); returns its id. */
export function opAddElement(b: Building, element: Omit<BuildingElement, 'id'>): number {
  const id = takeElementId(b);
  b.elements = [...(b.elements ?? []), { ...element, id }];
  return id;
}

export type ElementPatch = Partial<Pick<BuildingElement, 'w' | 'd' | 'h' | 'z' | 'facing' | 'material'>>;

/**
 * Changes an element's size, height or facing. A stair or a ramp keeps the
 * run its rise needs: setting its rise sets its run.
 */
export function opUpdateElement(b: Building, id: number, patch: ElementPatch): boolean {
  const e = b.elements?.find((x) => x.id === id);
  if (!e) return false;
  const before = JSON.stringify(e);
  const size = (v: number): number => clamp(Math.round(v / RELIEF_STEP) * RELIEF_STEP, MIN_ELEMENT, MAX_ELEMENT);
  if (patch.w !== undefined) e.w = size(patch.w);
  if (patch.d !== undefined) e.d = size(patch.d);
  if (patch.h !== undefined) {
    e.h = size(patch.h);
    if ((e.kind === 'stair' || e.kind === 'ramp') && patch.d === undefined) {
      // The run grows from the top: the foot moves, the head stays at the door.
      const run = runFor(e.kind, e.h);
      const n = SIDE_NORMAL[e.facing];
      e.x += (n.x * (run - e.d)) / 2;
      e.y += (n.y * (run - e.d)) / 2;
      e.d = run;
    }
  }
  if (patch.z !== undefined) e.z = Math.max(0, patch.z);
  if (patch.facing !== undefined) e.facing = patch.facing;
  if (patch.material !== undefined) e.material = patch.material;
  return JSON.stringify(e) !== before;
}

export function opRemoveElement(b: Building, id: number): boolean {
  const list = b.elements ?? [];
  const next = list.filter((e) => e.id !== id);
  if (next.length === list.length) return false;
  if (next.length > 0) b.elements = next;
  else delete b.elements;
  return true;
}

// =============================================================== mirror and repeat

const MIRROR_SIDE: Readonly<Record<Side, Side>> = { 0: 0, 1: 3, 2: 2, 3: 1 };

/**
 * Mirrors a building left to right in its own frame - volumes, bays and their
 * overrides, reliefs, per-face materials, elements, cores and a shed's fall -
 * keeping its footprint's centre where it was.
 */
export function opMirror(b: Building): boolean {
  const before = footprintCentre(b);
  const flipSide = (side: Side): Side => MIRROR_SIDE[side];
  for (const v of b.volumes) {
    const sidesCount = v.outline?.length ?? 4;
    const flipFace = (side: FaceId): FaceId => {
      if (v.outline) return (sidesCount - 2 - side + sidesCount) % sidesCount;
      const cardinal = SIDES.find((candidate) => candidate === side);
      return cardinal === undefined ? side : flipSide(cardinal);
    };
    const previousCounts = Array.from({ length: sidesCount }, (_, side) => baysOn(b, v, side));
    const count = (side: FaceId): number => previousCounts[side] ?? 1;
    v.x = -(v.x + v.w);
    if (v.outline) v.outline = v.outline.map((p) => ({ x: 1 - p.x, y: p.y })).reverse();
    for (const storey of v.storeys) {
      const facade = storey.facade;
      if (facade.sides) {
        const sides: Partial<Record<FaceId, BayComponent>> = {};
        for (const [key, value] of Object.entries(facade.sides)) sides[flipFace(Number(key))] = value;
        facade.sides = sides;
      }
      if (facade.patterns) {
        const patterns: NonNullable<Facade['patterns']> = {};
        for (const [key, value] of Object.entries(facade.patterns)) patterns[flipFace(Number(key))] = value;
        facade.patterns = patterns;
      }
      if (facade.bays) {
        const bays: Record<string, BayComponent> = {};
        for (const [key, value] of Object.entries(facade.bays)) {
          const [s, i] = key.split(':').map(Number) as [FaceId, number];
          const side = flipFace(s);
          bays[bayKey(side, v.outline || side === 0 || side === 2 ? count(s) - 1 - i : i)] = value;
        }
        facade.bays = bays;
      }
      for (const space of storey.spaces ?? []) space.x = -(space.x + space.w);
    }
    for (const r of v.reliefs ?? []) {
      r.side = flipFace(r.side);
      if (v.outline || r.side === 0 || r.side === 2) {
        const n = count(flipFace(r.side));
        [r.bay0, r.bay1] = [n - 1 - r.bay1, n - 1 - r.bay0];
      }
    }
    if (v.materials?.sides) {
      const sides: Partial<Record<FaceId, NonNullable<Volume['materials']>['wall']>> = {};
      for (const [key, value] of Object.entries(v.materials.sides)) sides[flipFace(Number(key))] = value;
      v.materials.sides = sides as NonNullable<NonNullable<Volume['materials']>['sides']>;
    }
    if (v.facadeGeometry) {
      const controls: NonNullable<Volume['facadeGeometry']> = {};
      for (const [key, value] of Object.entries(v.facadeGeometry)) controls[flipFace(Number(key))] = value;
      v.facadeGeometry = controls;
    }
    if (v.fall !== undefined) v.fall = flipSide(v.fall);
  }
  for (const e of b.elements ?? []) {
    e.x = -e.x;
    e.facing = flipSide(e.facing);
  }
  for (const core of b.cores) core.x = -(core.x + b.module);
  const after = footprintCentre(b);
  b.x += before.x - after.x;
  b.y += before.y - after.y;
  return true;
}

/**
 * Repeats an element in a row across its facing - pillars along a facade, a
 * run of canopies - every `spacing` world units, as many times as fit within
 * the building's extent on that axis without standing inside a volume.
 * Returns how many copies were added.
 */
export function opRepeatElement(b: Building, id: number, spacing?: number): number {
  const e = b.elements?.find((x) => x.id === id);
  if (!e) return 0;
  const alongX = e.facing === 0 || e.facing === 2;
  const step = snapLength(spacing ?? Math.max(e.w * 2, b.module));
  const box = footprintBox(b);
  // Out to the building's corners: a row of pillars ends on them.
  const lo = alongX ? box.x0 : box.y0;
  const hi = alongX ? box.x1 : box.y1;
  const start = alongX ? e.x : e.y;
  let added = 0;
  for (const dir of [1, -1]) {
    for (let k = 1; k < 64; k++) {
      const at = start + dir * k * step;
      if (at < lo - 1e-6 || at > hi + 1e-6) break;
      const copy = { ...e, x: alongX ? at : e.x, y: alongX ? e.y : at };
      if (elementClash(b, { ...copy, id: -1 })) break;
      opAddElement(b, copy);
      added++;
    }
  }
  return added;
}
