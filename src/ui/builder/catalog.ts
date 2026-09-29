/**
 * The Builder's tool catalogue: nine categories, each with the tools its tray
 * shows. This is the single source the top bar, the tray and the tool state
 * machine read, so a tool exists in exactly one place.
 *
 * `mode` tools take the pointer (draw a footprint, place an opening, paint a
 * face); `action` tools run once, on the current selection; `menu` tools open
 * a temporary gallery (the starters, the facade patterns, the finishes).
 */

import { FACADE_PATTERNS, type FacadePattern } from '@world/buildings/types';

export const BUILDER_CATEGORIES = [
  'select',
  'draw',
  'mass',
  'face',
  'openings',
  'structure',
  'roof',
  'components',
  'finish',
] as const;
export type BuilderCategoryId = (typeof BUILDER_CATEGORIES)[number];

/**
 * What the Builder does, in three groups: build the mass, put things on it,
 * dress it. Nine flat buttons made the player read all of them to find the
 * one; three say where to start, and the row under them says what is inside.
 *
 * `select` is not here: it is a global control, like the snap and the grid.
 */
export const BUILDER_GROUPS = [
  { id: 'create', categories: ['draw', 'mass', 'face'] },
  { id: 'insert', categories: ['openings', 'structure', 'roof', 'components'] },
  { id: 'appearance', categories: ['finish'] },
] as const;

export type BuilderGroupId = (typeof BUILDER_GROUPS)[number]['id'];

export function groupOfCategory(id: BuilderCategoryId): BuilderGroupId | null {
  const group = BUILDER_GROUPS.find((g) => (g.categories as readonly string[]).includes(id));
  return group ? group.id : null;
}

export type BuilderToolKind = 'mode' | 'action' | 'menu';

export interface BuilderToolSpec {
  /** Stable id: the i18n key is `builder.tool.<id>` and the icon is looked up by it. */
  readonly id: string;
  readonly kind: BuilderToolKind;
  /** A destructive action, drawn in the danger colour. */
  readonly danger?: boolean;
}


/**
 * A family of tools behind one button: the tray shows the family, and clicking
 * it opens the variants. Twenty buttons for twenty window and door types is
 * not a toolbar, it is a wall.
 */
export const BUILDER_GALLERIES: Readonly<Record<string, readonly string[]>> = {
  floors: ['storey', 'storeyDown', 'split', 'setback'],
  volumes: ['wing', 'stack', 'cut', 'moveMass'],
  planShape: ['vertexAdd', 'vertexRemove'],
  shapes: ['rect', 'shapeL', 'shapeU', 'circle', 'hexagon', 'octagon', 'chamfered'],
  openWindows: ['window', 'sashWindow', 'wideWindow', 'ribbon', 'bayWindow', 'frenchWindow'],
  openDoors: ['door', 'doubleDoor', 'garageDoor', 'loadingDoor'],
  runs: ['wallRun', 'fenceRun', 'pavementRun', 'railing', 'stairRun'],
  greenery: ['tree', 'flowers', 'rocks'],
  furniture: ['bench', 'planter', 'parking', 'ac', 'awning'],
  roofGear: ['solar', 'skylight', 'vent', 'chimney', 'waterTank', 'spire'],
  roofs: ['roofFlat', 'roofTerrace', 'roofGable', 'roofHip', 'roofShed', 'roofSawtooth'],
};

export interface BuilderCategorySpec {
  readonly id: BuilderCategoryId;
  readonly tools: readonly BuilderToolSpec[];
}

const mode = (id: string): BuilderToolSpec => ({ id, kind: 'mode' });
const action = (id: string, danger = false): BuilderToolSpec => ({ id, kind: 'action', danger });
const menu = (id: string): BuilderToolSpec => ({ id, kind: 'menu' });

export const BUILDER_CATALOG: readonly BuilderCategorySpec[] = [
  { id: 'select', tools: [mode('select')] },
  {
    id: 'draw',
    tools: [
      menu('shapes'),
      mode('sketch'),
      menu('models'),
    ],
  },
  {
    id: 'mass',
    tools: [
      menu('floors'),
      menu('volumes'),
      menu('planShape'),
    ],
  },
  {
    id: 'face',
    tools: [
      mode('pushpull'),
      action('inset'),
      action('outset'),
      action('flush'),
      menu('patterns'),
    ],
  },
  {
    id: 'openings',
    tools: [
      menu('openWindows'),
      menu('openDoors'),
      mode('balcony'),
      mode('shopfront'),
      mode('pillarBay'),
      mode('wallBay'),
      mode('freeOpening'),
    ],
  },
  {
    id: 'structure',
    tools: [
      mode('stair'),
      mode('ramp'),
      mode('pillar'),
      mode('canopy'),
      mode('wall'),
      mode('slab'),
      menu('runs'),
    ],
  },
  {
    id: 'roof',
    tools: [
      menu('roofs'),
      menu('roofShape'),
    ],
  },
  {
    id: 'components',
    tools: [
      menu('greenery'),
      menu('furniture'),
      menu('roofGear'),
      menu('moreComponents'),
    ],
  },
  {
    id: 'finish',
    tools: [
      mode('paint'),
      menu('material'),
      menu('colour'),
      action('copyStyle'),
    ],
  },
];

export function categorySpec(id: BuilderCategoryId): BuilderCategorySpec {
  return BUILDER_CATALOG.find((c) => c.id === id) as BuilderCategorySpec;
}

export function toolSpec(id: string): { category: BuilderCategoryId; tool: BuilderToolSpec } | null {
  for (const category of BUILDER_CATALOG) {
    const tool = category.tools.find((t) => t.id === id);
    if (tool) return { category: category.id, tool };
  }
  return null;
}

/** The plans a closed outline can be recognised as, and drawn as. */
export const PLAN_SHAPES = ['rectangle', 'l', 'u', 'circle', 'hexagon', 'octagon', 'chamfered'] as const;
export type PlanShapeId = (typeof PLAN_SHAPES)[number];

/** The shape a draw tool draws. */
export const DRAW_SHAPES: Readonly<Record<string, PlanShapeId>> = {
  rect: 'rectangle',
  shapeL: 'l',
  shapeU: 'u',
  circle: 'circle',
  hexagon: 'hexagon',
  octagon: 'octagon',
  chamfered: 'chamfered',
};

/** The BayComponent an opening tool places. */
export const OPENING_COMPONENTS: Readonly<Record<string, string>> = {
  doubleDoor: 'doubleDoor',
  garageDoor: 'garageDoor',
  frenchWindow: 'frenchWindow',
  bayWindow: 'bayWindow',
  ribbon: 'ribbon',
  window: 'window',
  sashWindow: 'sashWindow',
  wideWindow: 'wideWindow',
  balcony: 'balcony',
  door: 'door',
  shopfront: 'shopfront',
  loadingDoor: 'loadingDoor',
  pillarr: 'pillar',
  pillarBay: 'pillar',
  wallBay: 'wall',
};

/** Where an opening or a pattern is applied. */
export const FACADE_SCOPES = ['bay', 'storey', 'side', 'volume'] as const;
export type FacadeScopeId = (typeof FACADE_SCOPES)[number];

export const PATTERNS: readonly FacadePattern[] = FACADE_PATTERNS;

/**
 * One precise, editable number of the current selection, for the inspector.
 * Built by the tool, rendered and applied back by the workspace; the value
 * carries its unit so the field knows what it is showing.
 */
export interface BuilderField {
  readonly id: string;
  readonly labelKey: string;
  /** In metres, degrees or a count, depending on the unit. */
  readonly value: number;
  readonly unit?: 'm' | 'deg' | 'count' | 'percent';
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
  /** A read-only row (a name, a material, a computed figure). */
  readonly text?: string;
}

/** What the inspector shows for the current selection. */
export interface BuilderSelectionInfo {
  readonly titleKey: string;
  /** e.g. "Volume 02" */
  readonly name: string;
  readonly fields: readonly BuilderField[];
  /** The material line under the fields, when the selection has one. */
  readonly material?: string | undefined;
}
