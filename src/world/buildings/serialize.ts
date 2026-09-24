import { clamp } from '@core/scalar';
import {
  type BayComponent,
  type Building,
  type Core,
  type Facade,
  type Side,
  type Space,
  type Storey,
  type Volume,
  BUILDING_SCHEMA,
  CORE_KINDS,
  DEFAULT_MODULE,
  MAX_CELLS,
  MAX_MODULE,
  MAX_STOREYS,
  MAX_STOREY_HEIGHT,
  MIN_MODULE,
  MIN_STOREY_HEIGHT,
  PALETTE_COUNT,
  SPACE_KINDS,
  asBuildingId,
  isBayComponent,
  isBuildingUse,
  isRoofKind,
} from './types';
import { DEFAULT_GROUND_HEIGHT, DEFAULT_STOREY_HEIGHT } from './blueprints';

/**
 * The stored shape of a building is the model itself, as plain JSON, with
 * `schema` naming its version. `migrateBuilding` is the ONE door every stored
 * building comes in through: from `localStorage`, from a file, from an undo
 * snapshot, from a blueprint. It repairs what it can and returns null for what
 * it cannot, so one damaged record never costs the player the rest of the map.
 *
 * Fields it does not know are carried through untouched (the spread below), so
 * data a newer build wrote survives a round trip through this one.
 */
export type SerializedBuilding = Building;

type Loose = Record<string, unknown>;

const isRecord = (v: unknown): v is Loose => typeof v === 'object' && v !== null && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const int = (v: unknown, fallback: number): number => (finite(v) ? Math.round(v) : fallback);

function migrateFacade(raw: unknown): Facade {
  if (!isRecord(raw)) return { fill: 'window' };
  const facade: Facade = { fill: isBayComponent(raw.fill) ? raw.fill : 'window' };
  if (isRecord(raw.sides)) {
    const sides: Partial<Record<Side, BayComponent>> = {};
    for (const side of [0, 1, 2, 3] as const) {
      const value = raw.sides[String(side)];
      if (isBayComponent(value)) sides[side] = value;
    }
    if (Object.keys(sides).length > 0) facade.sides = sides;
  }
  if (isRecord(raw.bays)) {
    const bays: Record<string, BayComponent> = {};
    for (const [key, value] of Object.entries(raw.bays)) {
      if (/^[0-3]:\d{1,3}$/.test(key) && isBayComponent(value)) bays[key] = value;
    }
    if (Object.keys(bays).length > 0) facade.bays = bays;
  }
  return facade;
}

function migrateSpace(raw: unknown): Space | null {
  if (!isRecord(raw) || !finite(raw.id)) return null;
  const kind = (SPACE_KINDS as readonly unknown[]).includes(raw.kind) ? (raw.kind as Space['kind']) : 'unit';
  const space: Space = {
    ...raw,
    id: Math.round(raw.id),
    x: int(raw.x, 0),
    y: int(raw.y, 0),
    w: Math.max(1, int(raw.w, 1)),
    d: Math.max(1, int(raw.d, 1)),
    kind,
  };
  if (isBuildingUse(raw.use)) space.use = raw.use;
  else delete space.use;
  return space;
}

function migrateStorey(raw: unknown): Storey {
  const source = isRecord(raw) ? raw : {};
  const storey: Storey = { ...source, facade: migrateFacade(source.facade) };
  if (isBuildingUse(source.use)) storey.use = source.use;
  else delete storey.use;
  if (Array.isArray(source.spaces)) {
    storey.spaces = source.spaces.map(migrateSpace).filter((s): s is Space => s !== null);
  } else {
    delete storey.spaces;
  }
  return storey;
}

function migrateVolume(raw: unknown): Volume | null {
  if (!isRecord(raw) || !Array.isArray(raw.storeys) || raw.storeys.length === 0) return null;
  const base = Math.max(0, int(raw.base, 0));
  const storeys = raw.storeys.slice(0, Math.max(1, MAX_STOREYS - base)).map(migrateStorey);
  return {
    ...raw,
    id: Math.max(1, int(raw.id, 1)),
    x: int(raw.x, 0),
    y: int(raw.y, 0),
    w: clamp(int(raw.w, 1), 1, MAX_CELLS),
    d: clamp(int(raw.d, 1), 1, MAX_CELLS),
    base,
    roof: isRoofKind(raw.roof) ? raw.roof : 'flat',
    storeys,
  };
}

function migrateCore(raw: unknown): Core | null {
  if (!isRecord(raw) || !finite(raw.id)) return null;
  const kind = (CORE_KINDS as readonly unknown[]).includes(raw.kind) ? (raw.kind as Core['kind']) : 'stair';
  return {
    ...raw,
    id: Math.round(raw.id),
    x: int(raw.x, 0),
    y: int(raw.y, 0),
    kind,
    from: Math.max(0, int(raw.from, 0)),
    to: Math.max(0, int(raw.to, 1)),
  };
}

const height = (v: unknown, fallback: number): number =>
  clamp(finite(v) ? v : fallback, MIN_STOREY_HEIGHT, MAX_STOREY_HEIGHT);

/** Any stored building, of any schema this build knows, as a current one. */
export function migrateBuilding(raw: unknown): Building | null {
  if (!isRecord(raw)) return null;
  if (!finite(raw.id) || raw.id < 1 || !Number.isInteger(raw.id)) return null;
  if (!finite(raw.x) || !finite(raw.y)) return null;
  if (!Array.isArray(raw.volumes)) return null;

  const volumes: Volume[] = [];
  const seen = new Set<number>();
  let nextVolumeId = Math.max(1, int(raw.nextVolumeId, 1));
  for (const entry of raw.volumes) {
    const volume = migrateVolume(entry);
    if (!volume) continue;
    // Duplicate volume ids would make every "which volume" question
    // ambiguous; renumber rather than drop.
    if (seen.has(volume.id)) volume.id = Math.max(nextVolumeId, ...seen) + 1;
    seen.add(volume.id);
    nextVolumeId = Math.max(nextVolumeId, volume.id + 1);
    volumes.push(volume);
  }
  if (volumes.length === 0) return null;

  const building: Building = {
    ...raw,
    id: asBuildingId(raw.id),
    schema: BUILDING_SCHEMA,
    x: raw.x,
    y: raw.y,
    rotation: finite(raw.rotation) ? raw.rotation : 0,
    use: isBuildingUse(raw.use) ? raw.use : 'residential',
    module: clamp(finite(raw.module) ? raw.module : DEFAULT_MODULE, MIN_MODULE, MAX_MODULE),
    groundHeight: height(raw.groundHeight, DEFAULT_GROUND_HEIGHT),
    storeyHeight: height(raw.storeyHeight, DEFAULT_STOREY_HEIGHT),
    palette: clamp(int(raw.palette, 0), 0, PALETTE_COUNT - 1),
    volumes,
    cores: Array.isArray(raw.cores) ? raw.cores.map(migrateCore).filter((c): c is Core => c !== null) : [],
    nextVolumeId,
  };
  if (Array.isArray(raw.levels)) {
    building.levels = raw.levels.slice(0, MAX_STOREYS).map((v) => (finite(v) ? height(v, v) : null));
  } else {
    delete building.levels;
  }
  if (typeof raw.name === 'string') building.name = raw.name.slice(0, 80);
  else delete building.name;
  if (typeof raw.blueprint === 'string') building.blueprint = raw.blueprint.slice(0, 80);
  else delete building.blueprint;
  return building;
}

/** Boundary check used by `editor/persistence.ts`: an array, or absent. */
export const isSerializedBuildings = (value: unknown): boolean => value === undefined || Array.isArray(value);
