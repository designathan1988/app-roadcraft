import { m } from '../units';
import type { BuildingMaterials, VolumeMaterials } from './materials';

/**
 * The modular building model. See docs/buildings.md.
 *
 * A building is DATA: volumes of whole grid cells, storeys on levels, facades
 * of bays, each bay a replaceable component. Nothing here is a mesh, and
 * nothing here knows the editor or the renderer exists.
 */

declare const BuildingIdBrand: unique symbol;
export type BuildingId = number & { readonly [BuildingIdBrand]: true };
export const asBuildingId = (n: number): BuildingId => n as BuildingId;

/**
 * The schema written on every stored building. See `serialize.ts`.
 *
 * 1: volumes, cores and spaces measured in whole cells of `module`.
 * 2: measured in world units, any size (the editor snaps them to `GRID`).
 */
export const BUILDING_SCHEMA = 2;

export const BUILDING_USES = ['residential', 'commercial', 'industrial', 'mixed'] as const;
export type BuildingUse = (typeof BUILDING_USES)[number];

/** Replaceable facade components, one per bay. See docs/buildings.md. */
export const BAY_COMPONENTS = [
  'wall',
  'window',
  'wideWindow',
  'balcony',
  'door',
  'shopfront',
  'loadingDoor',
  'pillar',
] as const;
export type BayComponent = (typeof BAY_COMPONENTS)[number];

export const ROOF_KINDS = ['flat', 'terrace', 'gable', 'hip', 'shed', 'sawtooth'] as const;
export type RoofKind = (typeof ROOF_KINDS)[number];

/**
 * A face of a volume, in the building's local frame: 0 front (local -y, the
 * street side), 1 right (+x), 2 back (+y), 3 left (-x).
 */
export type Side = 0 | 1 | 2 | 3;
export const SIDES: readonly Side[] = [0, 1, 2, 3];

export const CORE_KINDS = ['stair', 'lift', 'stairLift'] as const;
export type CoreKind = (typeof CORE_KINDS)[number];

export const SPACE_KINDS = ['unit', 'shop', 'office', 'workshop', 'corridor', 'lobby'] as const;
export type SpaceKind = (typeof SPACE_KINDS)[number];

/**
 * A facade: the storey's default component, optional whole-side overrides,
 * and single-bay overrides keyed `"side:index"`. Resolved by `componentAt`.
 */
export interface Facade {
  fill: BayComponent;
  sides?: Partial<Record<Side, BayComponent>>;
  bays?: Record<string, BayComponent>;
}

/**
 * Extension point: a subdivision of a storey (a flat, a shop, a corridor).
 * Stored and round-tripped; nothing simulates it yet. A rectangle of the
 * building's local frame, world units.
 */
export interface Space {
  id: number;
  x: number;
  y: number;
  w: number;
  d: number;
  kind: SpaceKind;
  use?: BuildingUse;
}

export interface Storey {
  /** Overrides the building's use on this storey (mixed use). */
  use?: BuildingUse;
  facade: Facade;
  /** Extension point, see `Space`. */
  spaces?: Space[];
}

/**
 * A region of one face pushed in or out: whole bays `bay0..bay1` of `side`,
 * on storeys `storey0..storey1` of the volume, moved `depth` world units
 * along the face's outward normal - negative is a RECESS (a loggia, an inset
 * panel, a porch), positive a PROJECTION (a bay window, a raised panel, a
 * pilaster). Stored in bays and storeys, so it follows the facade when the
 * volume is resized.
 */
export interface Relief {
  side: Side;
  bay0: number;
  bay1: number;
  storey0: number;
  storey1: number;
  depth: number;
}

/** A rectangular block, standing on level `base`: a rectangle of the local frame, world units. */
export interface Volume {
  id: number;
  x: number;
  y: number;
  w: number;
  d: number;
  base: number;
  roof: RoofKind;
  /** Bottom to top: storey k occupies level `base + k`. */
  storeys: Storey[];
  /** This volume's own walls and roof, over the building's (see `materials.ts`). */
  materials?: VolumeMaterials;
  /** Faces pushed in or out (see `Relief`). */
  reliefs?: Relief[];
  /** Roof pitch in degrees, for pitched roofs; absent = the roof kind's default. */
  pitch?: number;
  /**
   * Which way a pitched roof runs. Gable and hip: the ridge along the local x
   * axis ('x') or y ('y'); absent = along the longer side. Shed: the side it
   * falls towards (absent = the front).
   */
  ridge?: 'x' | 'y';
  fall?: Side;
}

/**
 * Extension point: a vertical circulation shaft, a module square whose
 * corner is at `(x, y)` in the local frame. A lift core is drawn as an
 * overrun box on a flat roof; nothing moves in it yet.
 */
export interface Core {
  id: number;
  x: number;
  y: number;
  kind: CoreKind;
  from: number;
  to: number;
}

export interface Building {
  readonly id: BuildingId;
  schema: number;
  /** World position of the local frame's origin (cell 0,0's corner). */
  x: number;
  y: number;
  /** Radians, counter-clockwise, of the local +x axis. */
  rotation: number;
  use: BuildingUse;
  /** The width a facade bay aims at, world units: each side is shared into bays of about this. */
  module: number;
  /** Height of level 0, world units. */
  groundHeight: number;
  /** Height of every level above 0, world units. */
  storeyHeight: number;
  /** Per-level height overrides, building-wide; `null`/absent = default. */
  levels?: (number | null)[];
  /** Colour scheme: the default material of every surface (`PALETTE_MATERIALS`). */
  palette: number;
  /** Building-wide materials, over the palette (see `materials.ts`). */
  materials?: BuildingMaterials;
  volumes: Volume[];
  cores: Core[];
  nextVolumeId: number;
  name?: string;
  /** The blueprint this building was placed from, for the UI only. */
  blueprint?: string;
}

// ------------------------------------------------------------------ limits
// World units are 0.4 m (`world/units.ts`); every figure is written in metres.

export const MIN_MODULE = m(2.4);
export const MAX_MODULE = m(8);
export const DEFAULT_MODULE = m(3);
export const MIN_STOREY_HEIGHT = m(2.6);
export const MAX_STOREY_HEIGHT = m(9);
export const MAX_STOREYS = 60;
/** Widest a volume may be on either axis, world units. */
export const MAX_SIZE = m(160);
export const MAX_VOLUMES = 24;
/** Deepest a recess may go into a volume, and furthest a projection may stand out. */
export const MAX_RECESS = m(4);
export const MAX_PROJECTION = m(2.4);
export const MIN_PITCH = 5;
export const MAX_PITCH = 60;
export const PALETTE_COUNT = 8;

export const isBuildingUse = (v: unknown): v is BuildingUse =>
  (BUILDING_USES as readonly unknown[]).includes(v);
export const isBayComponent = (v: unknown): v is BayComponent =>
  (BAY_COMPONENTS as readonly unknown[]).includes(v);
export const isRoofKind = (v: unknown): v is RoofKind =>
  (ROOF_KINDS as readonly unknown[]).includes(v);
export const isSide = (v: unknown): v is Side => v === 0 || v === 1 || v === 2 || v === 3;

export const bayKey = (side: Side, index: number): string => `${side}:${index}`;

/** The component a facade puts in one bay. */
export function componentAt(facade: Facade, side: Side, index: number): BayComponent {
  return facade.bays?.[bayKey(side, index)] ?? facade.sides?.[side] ?? facade.fill;
}

/** A deep, independent copy. Buildings are small; JSON is the honest clone. */
export function cloneBuilding<T extends Building>(b: T): T {
  return JSON.parse(JSON.stringify(b)) as T;
}

/** The level a volume's roof sits on (one past its top storey). */
export const volumeTop = (v: Volume): number => v.base + v.storeys.length;

export function volumeById(b: Building, id: number): Volume | undefined {
  return b.volumes.find((v) => v.id === id);
}
