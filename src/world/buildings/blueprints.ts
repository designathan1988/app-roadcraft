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

/**
 * The parametric generator: a single volume of `w x d` cells and `storeys`
 * storeys, with the facades and roof its use implies. Every preset and the
 * "type" buttons start from this.
 */
export function generateBody(
  use: BuildingUse,
  w: number,
  d: number,
  storeys: number,
  options: { module?: number; groundHeight?: number; storeyHeight?: number; roof?: RoofKind; palette?: number } = {},
): BlueprintBody {
  const volume: Volume = {
    id: 1,
    x: 0,
    y: 0,
    w,
    d,
    base: 0,
    roof: options.roof ?? defaultRoof(use, storeys),
    storeys: Array.from({ length: storeys }, (_, level) => defaultStorey(use, level, w)),
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

function withCore(body: BlueprintBody, core: Omit<Core, 'id'>): BlueprintBody {
  body.cores.push({ id: body.cores.length + 1, ...core });
  return body;
}

function house(): BlueprintBody {
  return generateBody('residential', 3, 3, 2, { palette: 0, roof: 'gable' });
}

function rowhouse(): BlueprintBody {
  const body = generateBody('residential', 2, 4, 3, { palette: 1, roof: 'gable' });
  const v = body.volumes[0] as Volume;
  v.storeys[0] = { facade: { fill: 'window', bays: { [bayKey(0, 0)]: 'door' } } };
  for (let k = 1; k < v.storeys.length; k++) v.storeys[k] = { facade: { fill: 'window', bays: { [bayKey(0, 1)]: 'balcony' } } };
  return body;
}

function apartments(): BlueprintBody {
  const body = generateBody('residential', 6, 4, 5, { palette: 4, roof: 'flat' });
  const v = body.volumes[0] as Volume;
  for (let k = 1; k < v.storeys.length; k++) {
    const bays: Record<string, BayComponent> = {};
    for (let i = 0; i < v.w; i++) bays[bayKey(0, i)] = i % 2 === 0 ? 'balcony' : 'window';
    for (let i = 0; i < v.w; i++) bays[bayKey(2, i)] = i % 2 === 1 ? 'balcony' : 'window';
    v.storeys[k] = { facade: { fill: 'window', bays } };
  }
  return withCore(body, { x: 3, y: 2, kind: 'stairLift', from: 0, to: 5 });
}

function tower(): BlueprintBody {
  const body = generateBody('mixed', 7, 6, 2, { palette: 2, roof: 'terrace' });
  const podium = body.volumes[0] as Volume;
  podium.storeys[1] = { use: 'commercial', facade: { fill: 'wideWindow' } };
  const storeys: Storey[] = Array.from({ length: 12 }, () => ({
    use: 'residential',
    facade: { fill: 'window', sides: { 0: 'balcony', 2: 'balcony' } },
  }));
  body.volumes.push({ id: 2, x: 1, y: 1, w: 5, d: 4, base: 2, roof: 'flat', storeys });
  body.nextVolumeId = 3;
  return withCore(body, { x: 3, y: 3, kind: 'stairLift', from: 0, to: 14 });
}

function shop(): BlueprintBody {
  const body = generateBody('commercial', 4, 3, 2, { palette: 3, roof: 'flat' });
  (body.volumes[0] as Volume).storeys[1] = { facade: { fill: 'window' } };
  return body;
}

function office(): BlueprintBody {
  const body = generateBody('commercial', 6, 5, 8, { palette: 6, roof: 'flat' });
  const v = body.volumes[0] as Volume;
  v.storeys[0] = { facade: { fill: 'wideWindow', sides: { 0: 'pillar' }, bays: { [bayKey(0, 3)]: 'door' } } };
  return withCore(body, { x: 3, y: 3, kind: 'stairLift', from: 0, to: 8 });
}

function mixedBlock(): BlueprintBody {
  const body = generateBody('mixed', 5, 4, 4, { palette: 5, roof: 'hip' });
  return body;
}

function warehouse(): BlueprintBody {
  return generateBody('industrial', 8, 6, 1, { palette: 7, roof: 'sawtooth', groundHeight: m(7) });
}

function factory(): BlueprintBody {
  const body = generateBody('industrial', 8, 5, 1, { palette: 7, roof: 'sawtooth', groundHeight: m(5.5) });
  body.volumes.push({
    id: 2,
    x: -3,
    y: 0,
    w: 3,
    d: 3,
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
  { key: 'house', nameKey: 'building.preset.house', body: house() },
  { key: 'rowhouse', nameKey: 'building.preset.rowhouse', body: rowhouse() },
  { key: 'apartments', nameKey: 'building.preset.apartments', body: apartments() },
  { key: 'tower', nameKey: 'building.preset.tower', body: tower() },
  { key: 'shop', nameKey: 'building.preset.shop', body: shop() },
  { key: 'office', nameKey: 'building.preset.office', body: office() },
  { key: 'mixed', nameKey: 'building.preset.mixed', body: mixedBlock() },
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
