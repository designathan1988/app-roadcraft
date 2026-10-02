/**
 * The Builder's tool catalogue: seven tabs, each showing all it offers at
 * once, in short sections. This is the single source the panel and the tool
 * state machine read, so a tool exists in exactly one place.
 *
 * It replaces three groups, nine categories and a gallery behind every
 * family: the player clicked three times to reach a window, and "Massa" and
 * "Face" said nothing about what was inside them.
 *
 * `mode` tools take the pointer (draw a plan, place a window, hang a canopy);
 * `action` tools run once on the selection. Selecting is not a tool: the
 * pointer selects whenever nothing else is in hand.
 */

import { FACADE_PATTERNS, type FacadePattern } from '@world/buildings/types';

export const BUILDER_TABS = ['models', 'draw', 'mass', 'facade', 'parts', 'roof', 'paint'] as const;
export type BuilderCategoryId = (typeof BUILDER_TABS)[number];

export type BuilderToolKind = 'mode' | 'action';

export interface BuilderToolSpec {
  /** Stable id: the i18n key is `builder.tool.<id>` and the icon is looked up by it. */
  readonly id: string;
  readonly kind: BuilderToolKind;
  readonly danger?: boolean;
}

/** What a section of a tab holds: tools, or one of the panel's own shelves. */
export type BuilderShelf = 'models' | 'patterns' | 'scope' | 'roofParams' | 'finishes';

export interface BuilderSection {
  /** `builder.section.<title>`; none for a tab with one section. */
  readonly title?: string;
  readonly tools?: readonly BuilderToolSpec[];
  readonly shelf?: BuilderShelf;
}

export interface BuilderTabSpec {
  readonly id: BuilderCategoryId;
  /** Works on a building: greyed out until one is selected. */
  readonly needsSelection: boolean;
  readonly sections: readonly BuilderSection[];
}

const mode = (id: string): BuilderToolSpec => ({ id, kind: 'mode' });
const action = (id: string): BuilderToolSpec => ({ id, kind: 'action' });

export const BUILDER_TAB_SPECS: readonly BuilderTabSpec[] = [
  { id: 'models', needsSelection: false, sections: [{ shelf: 'models' }] },
  {
    id: 'draw',
    needsSelection: false,
    sections: [{
      tools: [mode('rect'), mode('shapeL'), mode('shapeU'), mode('circle'), mode('hexagon'), mode('octagon'), mode('chamfered'), mode('sketch')],
    }],
  },
  {
    id: 'mass',
    needsSelection: true,
    sections: [
      { title: 'floors', tools: [action('storey'), action('storeyDown'), action('split'), action('setback')] },
      { title: 'volumes', tools: [mode('wing'), mode('stack'), mode('cut'), mode('moveMass')] },
      { title: 'plan', tools: [action('vertexAdd'), action('vertexRemove')] },
    ],
  },
  {
    id: 'facade',
    needsSelection: true,
    sections: [
      { title: 'pattern', shelf: 'patterns' },
      { title: 'windows', tools: [mode('window'), mode('sashWindow'), mode('wideWindow'), mode('ribbon'), mode('bayWindow'), mode('frenchWindow')] },
      { title: 'doors', tools: [mode('door'), mode('doubleDoor'), mode('garageDoor'), mode('loadingDoor')] },
      { title: 'bays', tools: [mode('balcony'), mode('shopfront'), mode('pillarBay'), mode('wallBay')] },
      { title: 'scope', shelf: 'scope' },
      { title: 'relief', tools: [action('inset'), action('outset'), action('flush')] },
    ],
  },
  {
    id: 'parts',
    needsSelection: true,
    sections: [
      { title: 'structure', tools: [mode('stair'), mode('ramp'), mode('pillar'), mode('canopy'), mode('wall'), mode('slab')] },
      { title: 'runs', tools: [mode('wallRun'), mode('fenceRun'), mode('pavementRun'), mode('railing'), mode('stairRun')] },
      { title: 'greenery', tools: [mode('tree'), mode('flowers'), mode('rocks')] },
      { title: 'furniture', tools: [mode('bench'), mode('planter'), mode('parking'), mode('ac'), mode('awning')] },
      { title: 'roofGear', tools: [mode('solar'), mode('skylight'), mode('vent'), mode('chimney'), mode('waterTank'), mode('spire')] },
    ],
  },
  {
    id: 'roof',
    needsSelection: true,
    sections: [
      { tools: [action('roofFlat'), action('roofTerrace'), action('roofGable'), action('roofHip'), action('roofShed'), action('roofSawtooth')] },
      { title: 'roofShape', shelf: 'roofParams' },
    ],
  },
  {
    id: 'paint',
    needsSelection: false,
    sections: [
      { tools: [mode('paint'), action('copyStyle')] },
      { shelf: 'finishes' },
    ],
  },
];

export function tabSpec(id: BuilderCategoryId): BuilderTabSpec {
  return BUILDER_TAB_SPECS.find((t) => t.id === id) as BuilderTabSpec;
}

/** Every tab with its tools, flat: the shape the tests and the wiring read. */
export const BUILDER_CATALOG: readonly { readonly id: BuilderCategoryId; readonly tools: readonly BuilderToolSpec[] }[] =
  BUILDER_TAB_SPECS.map((tab) => ({ id: tab.id, tools: tab.sections.flatMap((s) => s.tools ?? []) }));

/** Which tab a tool is on. */
export function tabOfTool(id: string): BuilderCategoryId | null {
  return BUILDER_CATALOG.find((tab) => tab.tools.some((t) => t.id === id))?.id ?? null;
}

/** Kept for the thumbnail studio and the icon test: families of pictured parts. */
export const BUILDER_GALLERIES: Readonly<Record<string, readonly string[]>> = {
  shapes: ['rect', 'shapeL', 'shapeU', 'circle', 'hexagon', 'octagon', 'chamfered'],
  openWindows: ['window', 'sashWindow', 'wideWindow', 'ribbon', 'bayWindow', 'frenchWindow'],
  openDoors: ['door', 'doubleDoor', 'garageDoor', 'loadingDoor'],
  runs: ['wallRun', 'fenceRun', 'pavementRun', 'railing', 'stairRun'],
  greenery: ['tree', 'flowers', 'rocks'],
  furniture: ['bench', 'planter', 'parking', 'ac', 'awning'],
  roofGear: ['solar', 'skylight', 'vent', 'chimney', 'waterTank', 'spire'],
  roofs: ['roofFlat', 'roofTerrace', 'roofGable', 'roofHip', 'roofShed', 'roofSawtooth'],
};

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
