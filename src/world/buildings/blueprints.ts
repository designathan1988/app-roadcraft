import type { Vec2 } from '@core/vec2';
import { footprintBox, localDirToWorld } from './geometry';
import { m } from '../units';
import {
  type BayComponent,
  type Building,
  type BuildingUse,
  type Core,
  type Facade,
  type RoofKind,
  type Storey,
  type Volume,
  BUILDING_SCHEMA,
  DEFAULT_MODULE,
  bayKey,
  componentAt,
} from './types';

/**
 * Reusable building definitions: everything a building is except where it
 * stands. The built-in presets are here; the player's own live in
 * `editor/blueprintLibrary.ts` and have exactly the same shape.
 */
export type BlueprintBody = Omit<Building, 'id' | 'x' | 'y' | 'rotation'>;

export interface Blueprint {
  readonly key: string;
  /** Translation key for a built-in preset; user blueprints carry `name`. */
  readonly nameKey?: string;
  readonly name?: string;
  readonly body: BlueprintBody;
}

/**
 * A building record for a blueprint, placed so the middle of its FRONT edge
 * (the street side) is at `anchor`.
 *
 * Here rather than with the editing commands because it is only arithmetic on
 * a record: the tool, the placement command and the gallery's photographs all
 * want it, and the renderer may not reach into `editor/`.
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

export const DEFAULT_GROUND_HEIGHT = m(3.6);
export const DEFAULT_STOREY_HEIGHT = m(3.1);

/** The default facade of one storey, by use and level. */
export function defaultFacade(use: BuildingUse, level: number, width: number, rich = true): Facade {
  const door = Math.floor(width / 2);
  const front: Record<string, BayComponent> = {};
  switch (use) {
    case 'residential':
      if (level === 0) {
        front[bayKey(0, door)] = 'door';
        return { fill: 'window', bays: front };
      }
      return rich && width >= 3 ? { fill: 'window', sides: { 0: 'balcony' } } : { fill: 'window' };
    case 'commercial':
      if (level === 0) {
        front[bayKey(0, door)] = 'door';
        return { fill: 'window', sides: { 0: 'shopfront' }, bays: front };
      }
      return { fill: 'wideWindow' };
    case 'industrial':
      if (level === 0) {
        for (let i = 0; i < width; i += 2) front[bayKey(0, i)] = 'loadingDoor';
        front[bayKey(0, width - 1)] = 'door';
        return { fill: 'wall', sides: { 1: 'window', 3: 'window' }, bays: front };
      }
      return { fill: 'window' };
    case 'mixed':
      return level === 0 ? defaultFacade('commercial', 0, width) : defaultFacade('residential', level, width, rich);
  }
}

/** The use a storey of a building of `use` has at `level`. */
export const storeyUse = (use: BuildingUse, level: number): BuildingUse | undefined =>
  use === 'mixed' ? (level === 0 ? 'commercial' : 'residential') : undefined;

export function defaultStorey(use: BuildingUse, level: number, width: number): Storey {
  const storey: Storey = { facade: defaultFacade(use, level, width) };
  const own = storeyUse(use, level);
  if (own) storey.use = own;
  return storey;
}

export function defaultRoof(use: BuildingUse, storeys: number): RoofKind {
  if (use === 'industrial') return storeys === 1 ? 'sawtooth' : 'flat';
  if (use === 'residential') return storeys <= 3 ? 'gable' : 'flat';
  return 'flat';
}

export const DEFAULT_PALETTE: Readonly<Record<BuildingUse, number>> = {
  residential: 0,
  commercial: 2,
  industrial: 7,
  mixed: 3,
};

/** Whole bays along a length, at about one module each. */
const bayCount = (length: number, module: number): number => Math.max(1, Math.round(length / module));

/** `n` default modules, world units: how the presets below are measured. */
const bays = (n: number): number => n * DEFAULT_MODULE;

/**
 * The parametric generator: a single volume `w x d` world units and `storeys`
 * storeys, with the facades and roof its use implies. The presets start from
 * this.
 */
export function generateBody(
  use: BuildingUse,
  w: number,
  d: number,
  storeys: number,
  options: { module?: number; groundHeight?: number; storeyHeight?: number; roof?: RoofKind; palette?: number } = {},
): BlueprintBody {
  const across = bayCount(w, options.module ?? DEFAULT_MODULE);
  const volume: Volume = {
    id: 1,
    x: 0,
    y: 0,
    w,
    d,
    base: 0,
    roof: options.roof ?? defaultRoof(use, storeys),
    storeys: Array.from({ length: storeys }, (_, level) => defaultStorey(use, level, across)),
  };
  return {
    schema: BUILDING_SCHEMA,
    use,
    module: options.module ?? DEFAULT_MODULE,
    groundHeight: options.groundHeight ?? (use === 'industrial' ? m(6) : DEFAULT_GROUND_HEIGHT),
    storeyHeight: options.storeyHeight ?? DEFAULT_STOREY_HEIGHT,
    palette: options.palette ?? DEFAULT_PALETTE[use],
    volumes: [volume],
    cores: [],
    nextVolumeId: 2,
  };
}

/** What an access component becomes on a storey above the street. */
const ABOVE_STREET: Partial<Record<BayComponent, BayComponent>> = {
  door: 'window',
  shopfront: 'wideWindow',
  loadingDoor: 'window',
};

/**
 * A storey for above `source`, in the building's own style rather than a
 * category's: the same facade, with every way in (a door, a shopfront, a
 * loading door) turned into the window that belongs above it.
 */
export function upperStoreyFrom(source: Storey): Storey {
  const lift = (c: BayComponent): BayComponent => ABOVE_STREET[c] ?? c;
  const facade: Facade = { fill: lift(source.facade.fill) };
  if (source.facade.pattern) facade.pattern = source.facade.pattern;
  if (source.facade.patterns) facade.patterns = { ...source.facade.patterns };
  if (source.facade.sides) {
    facade.sides = Object.fromEntries(Object.entries(source.facade.sides).map(([k, c]) => [k, lift(c ?? facade.fill)]));
  }
  if (source.facade.bays) {
    // A single-bay override that now says what its side says anyway is dropped.
    const kept = Object.entries(source.facade.bays)
      .map(([key, c]) => [key, lift(c)] as const)
      .filter(([key, c]) => c !== componentAt({ ...facade, bays: {} }, Number(key.split(':')[0]), 0));
    if (kept.length > 0) facade.bays = Object.fromEntries(kept);
  }
  const storey: Storey = { facade };
  if (source.use) storey.use = source.use;
  if (source.materials) storey.materials = structuredClone(source.materials);
  return storey;
}

/**
 * The neutral starting block: no category, just a mass of `w x d` units and
 * `storeys` storeys with windows all round, a door in the middle of the
 * front and a flat roof. Everything else is shaped from here.
 */
export function generateBlock(
  w: number,
  d: number,
  storeys: number,
  options: { module?: number; groundHeight?: number; storeyHeight?: number; roof?: RoofKind; palette?: number } = {},
): BlueprintBody {
  const across = bayCount(w, options.module ?? DEFAULT_MODULE);
  const ground: Storey = { facade: { fill: 'window', bays: { [bayKey(0, Math.floor(across / 2))]: 'door' } } };
  const volume: Volume = {
    id: 1,
    x: 0,
    y: 0,
    w,
    d,
    base: 0,
    roof: options.roof ?? 'flat',
    storeys: Array.from({ length: storeys }, (_, level) => (level === 0 ? ground : upperStoreyFrom(ground))),
  };
  return {
    schema: BUILDING_SCHEMA,
    use: 'mixed',
    module: options.module ?? DEFAULT_MODULE,
    groundHeight: options.groundHeight ?? DEFAULT_GROUND_HEIGHT,
    storeyHeight: options.storeyHeight ?? DEFAULT_STOREY_HEIGHT,
    palette: options.palette ?? 4,
    volumes: [volume],
    cores: [],
    nextVolumeId: 2,
  };
}

function withCore(body: BlueprintBody, core: Omit<Core, 'id'>): BlueprintBody {
  body.cores.push({ id: body.cores.length + 1, ...core });
  return body;
}

function house(): BlueprintBody {
  return generateBody('residential', bays(3), bays(3), 2, { palette: 0, roof: 'gable' });
}

function rowhouse(): BlueprintBody {
  const body = generateBody('residential', bays(2), bays(4), 3, { palette: 1, roof: 'gable' });
  const v = body.volumes[0] as Volume;
  v.storeys[0] = { facade: { fill: 'window', bays: { [bayKey(0, 0)]: 'door' } } };
  for (let k = 1; k < v.storeys.length; k++) v.storeys[k] = { facade: { fill: 'window', bays: { [bayKey(0, 1)]: 'balcony' } } };
  return body;
}

function apartments(): BlueprintBody {
  const body = generateBody('residential', bays(6), bays(4), 5, { palette: 4, roof: 'flat' });
  const v = body.volumes[0] as Volume;
  for (let k = 1; k < v.storeys.length; k++) {
    const front: Record<string, BayComponent> = {};
    for (let i = 0; i < 6; i++) front[bayKey(0, i)] = i % 2 === 0 ? 'balcony' : 'window';
    for (let i = 0; i < 6; i++) front[bayKey(2, i)] = i % 2 === 1 ? 'balcony' : 'window';
    v.storeys[k] = { facade: { fill: 'window', bays: front } };
  }
  return withCore(body, { x: bays(3), y: bays(2), kind: 'stairLift', from: 0, to: 5 });
}

function tower(): BlueprintBody {
  const body = generateBody('mixed', bays(7), bays(6), 2, { palette: 2, roof: 'terrace' });
  const podium = body.volumes[0] as Volume;
  podium.storeys[1] = { use: 'commercial', facade: { fill: 'wideWindow' } };
  const storeys: Storey[] = Array.from({ length: 12 }, () => ({
    use: 'residential',
    facade: { fill: 'window', sides: { 0: 'balcony', 2: 'balcony' } },
  }));
  body.volumes.push({ id: 2, x: bays(1), y: bays(1), w: bays(5), d: bays(4), base: 2, roof: 'flat', storeys });
  body.nextVolumeId = 3;
  return withCore(body, { x: bays(3), y: bays(3), kind: 'stairLift', from: 0, to: 14 });
}

function shop(): BlueprintBody {
  const body = generateBody('commercial', bays(4), bays(3), 2, { palette: 3, roof: 'flat' });
  (body.volumes[0] as Volume).storeys[1] = { facade: { fill: 'window' } };
  return body;
}

function office(): BlueprintBody {
  const body = generateBody('commercial', bays(6), bays(5), 8, { palette: 6, roof: 'flat' });
  const v = body.volumes[0] as Volume;
  v.storeys[0] = { facade: { fill: 'wideWindow', sides: { 0: 'pillar' }, bays: { [bayKey(0, 3)]: 'door' } } };
  return withCore(body, { x: bays(3), y: bays(3), kind: 'stairLift', from: 0, to: 8 });
}

function mixedBlock(): BlueprintBody {
  const body = generateBody('mixed', bays(5), bays(4), 4, { palette: 5, roof: 'hip' });
  return body;
}

/** Four individually editable wings around an open, ground-level courtyard. */
function courtyard(): BlueprintBody {
  const body = generateBlock(bays(8), bays(2), 3, { roof: 'flat', palette: 4 });
  body.use = 'residential';
  const front = body.volumes[0]!;
  const wing = (id: number, x: number, y: number, w: number, d: number): Volume => ({
    ...structuredClone(front), id, x, y, w, d,
    storeys: front.storeys.map((storey, level) => level === 0
      ? { facade: { fill: 'window' } } : structuredClone(storey)),
  });
  body.volumes.push(
    wing(2, 0, bays(2), bays(2), bays(4)),
    wing(3, bays(6), bays(2), bays(2), bays(4)),
    wing(4, 0, bays(6), bays(8), bays(2)),
  );
  body.nextVolumeId = 5;
  return body;
}

function warehouse(): BlueprintBody {
  return generateBody('industrial', bays(8), bays(6), 1, { palette: 7, roof: 'sawtooth', groundHeight: m(7) });
}

function factory(): BlueprintBody {
  const body = generateBody('industrial', bays(8), bays(5), 1, { palette: 7, roof: 'sawtooth', groundHeight: m(5.5) });
  body.volumes.push({
    id: 2,
    x: -bays(3),
    y: 0,
    w: bays(3),
    d: bays(3),
    base: 0,
    roof: 'flat',
    storeys: [
      { use: 'commercial', facade: { fill: 'window', bays: { [bayKey(0, 1)]: 'door' } } },
      { use: 'commercial', facade: { fill: 'window' } },
    ],
  });
  body.nextVolumeId = 3;
  return body;
}

/** The built-in presets, in palette order. Names are `building.preset.<key>`. */
export const BLUEPRINTS: readonly Blueprint[] = [
  { key: 'block', nameKey: 'building.preset.block', body: generateBlock(bays(4), bays(3), 2) },
  { key: 'house', nameKey: 'building.preset.house', body: house() },
  { key: 'rowhouse', nameKey: 'building.preset.rowhouse', body: rowhouse() },
  { key: 'apartments', nameKey: 'building.preset.apartments', body: apartments() },
  { key: 'tower', nameKey: 'building.preset.tower', body: tower() },
  { key: 'shop', nameKey: 'building.preset.shop', body: shop() },
  { key: 'office', nameKey: 'building.preset.office', body: office() },
  { key: 'mixed', nameKey: 'building.preset.mixed', body: mixedBlock() },
  { key: 'courtyard', nameKey: 'building.preset.courtyard', body: courtyard() },
  { key: 'warehouse', nameKey: 'building.preset.warehouse', body: warehouse() },
  { key: 'factory', nameKey: 'building.preset.factory', body: factory() },
];

/** The use each preset is filed under in the palette. */
export const blueprintUse = (bp: Blueprint): BuildingUse => bp.body.use;

export function blueprintByKey(key: string): Blueprint | undefined {
  return BLUEPRINTS.find((bp) => bp.key === key);
}

/** A blueprint's body with a building's placement stripped off. */
export function bodyOf(b: Building): BlueprintBody {
  const copy = JSON.parse(JSON.stringify(b)) as Record<string, unknown>;
  for (const key of ['id', 'x', 'y', 'rotation']) delete copy[key];
  return copy as unknown as BlueprintBody;
}
