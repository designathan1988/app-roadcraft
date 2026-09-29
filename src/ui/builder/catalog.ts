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

export type BuilderToolKind = 'mode' | 'action' | 'menu';

export interface BuilderToolSpec {
  /** Stable id: the i18n key is `builder.tool.<id>` and the icon is looked up by it. */
  readonly id: string;
  readonly kind: BuilderToolKind;
  /** A destructive action, drawn in the danger colour. */
  readonly danger?: boolean;
}

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
      mode('rect'),
      mode('shapeL'),
      mode('shapeU'),
      mode('circle'),
      mode('hexagon'),
      mode('octagon'),
      mode('chamfered'),
      mode('sketch'),
      menu('models'),
    ],
  },
  {
    id: 'mass',
    tools: [
      action('storey'),
      action('storeyDown'),
      mode('wing'),
      mode('stack'),
      mode('cut'),
      action('split'),
      action('setback'),
      action('vertexAdd'),
      action('vertexRemove'),
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
      mode('window'),
      mode('sashWindow'),
      mode('wideWindow'),
      mode('balcony'),
      mode('door'),
      mode('shopfront'),
      mode('loadingDoor'),
      mode('pillarBay'),
      mode('wallBay'),
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
    ],
  },
  {
    id: 'roof',
    tools: [
      action('roofFlat'),
      action('roofTerrace'),
      action('roofGable'),
      action('roofHip'),
      action('roofShed'),
      action('roofSawtooth'),
      menu('roofShape'),
    ],
  },
  {
    id: 'components',
    tools: [
      mode('solar'),
      mode('skylight'),
      mode('vent'),
      mode('chimney'),
      mode('waterTank'),
      mode('spire'),
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
