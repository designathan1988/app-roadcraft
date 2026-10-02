/**
 * The Builder's icon set: one stroked 24x24 glyph per tool and per top-bar
 * action, drawn in the current colour so active state is a CSS change. Kept
 * deliberately plain - a single 1.6 stroke, no fills - so fifty small buttons
 * read as one family.
 */

const P = {
  // --- categories
  select: '<path d="M6 3l12 7-5 1.6L11 17Z"/>',
  draw: '<path d="M4 20l3-8 9-9 5 5-9 9Z"/><path d="M7 12l5 5"/>',
  mass: '<path d="M4 9l8-4 8 4v9l-8 4-8-4Z"/><path d="M4 9l8 4 8-4M12 13v9"/>',
  face: '<path d="M4 6h16v12H4Z"/><path d="M9 6v12M4 12h16"/>',
  openings: '<path d="M5 4h14v16H5Z"/><path d="M9 9h6v11H9Z"/><path d="M9 4v3h6V4"/>',
  structure: '<path d="M5 20V9m14 11V9M3 9h18M3 5h18"/><path d="M12 9v11"/>',
  roof: '<path d="M3 13 12 5l9 8"/><path d="M6 13v7h12v-7"/><path d="M12 12v8"/>',
  components: '<path d="M4 10h7v10H4Z"/><path d="M11 10h9v5h-9Z"/><path d="M14 15v5"/>',
  finish: '<path d="M4 20h16"/><path d="M6 16 16 6l2 2L8 18l-3 1Z"/><path d="M14 8l2 2"/>',

  // --- top bar
  exit: '<path d="M10 5H5v14h5"/><path d="M14 8l-4 4 4 4"/><path d="M10 12h10"/>',
  undo: '<path d="M9 7 4 12l5 5"/><path d="M5 12h8a6 6 0 0 1 6 6"/>',
  redo: '<path d="m15 7 5 5-5 5"/><path d="M19 12h-8a6 6 0 0 0-6 6"/>',
  floor: '<path d="M3 9h18M3 15h18"/><path d="M7 9v6m10-6v6"/>',
  snap: '<path d="M12 3v4m0 10v4M3 12h4m10 0h4"/><path d="M9 9h6v6H9Z"/>',
  grid: '<path d="M4 4h16v16H4Z"/><path d="M10 4v16M16 4v16M4 10h16M4 16h16"/>',
  view: '<path d="M2 12s4-6 10-6 10 6 10 6-4 6-10 6-10-6-10-6Z"/><circle cx="12" cy="12" r="2.6"/>',
  hide: '<path d="M3 3l18 18"/><path d="M10.6 6.2A10 10 0 0 1 12 6c6 0 10 6 10 6a17 17 0 0 1-3.2 3.6M6.2 7.6A16 16 0 0 0 2 12s4 6 10 6a10 10 0 0 0 3.4-.6"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.4 2.3c-.6.3-.9.8-.9 1.4v.4"/><path d="M12 16.6v.4"/>',

  sim: '<path d="M7 5.5v13l6-4 2.5 1.6V7.9L13 9.5Z"/><path d="M18 6v12"/>',

  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',

  // --- selection bar
  duplicate: '<path d="M9 9h11v11H9Z"/><path d="M15 5H5v10"/>',
  mirror: '<path d="M12 3v18"/><path d="M9 7 4 12l5 5Z"/><path d="m15 7 5 5-5 5Z"/>',
  group: '<path d="M4 4h7v7H4Z"/><path d="M13 13h7v7h-7Z"/><path d="M8 11v4h3M17 13v-4"/><path d="M17 13h-3"/>',
  trash: '<path d="M5 7h14"/><path d="M9 7V5h6v2"/><path d="M7 7l1 13h8l1-13"/>',

  // --- draw
  rect: '<path d="M4 6h16v12H4Z"/>',
  polygon: '<path d="M5 8l6-4 8 4-2 9-9 2Z"/>',
  line: '<path d="M4 19 20 5"/>',
  arc: '<path d="M4 18a13 13 0 0 1 16-11"/><path d="M4 18h2M20 7v2"/>',
  freeform: '<path d="M4 15c3-6 5 4 8-2s4 3 8-1"/>',
  shapeL: '<path d="M5 5v14h13"/><path d="M5 5h4v10h9"/>',
  shapeU: '<path d="M5 5v14h14V5"/><path d="M9 5v10h6V5"/>',
  shapeT: '<path d="M4 5h16v4h-6v10h-4V9H4Z"/>',
  models: '<path d="M4 20V9l8-5 8 5v11Z"/><path d="M9 20v-6h6v6"/>',

  // --- mass
  addVolume: '<path d="M4 10l7-4 7 4v7l-7 4-7-4Z"/><path d="M18 5v6m-3-3h6"/>',
  union: '<path d="M4 4h10v10H4Z"/><path d="M10 10h10v10H10Z"/>',
  subtract: '<path d="M4 4h10v10H4Z"/><path d="M10 10h10v10H10Z" fill="currentColor" opacity=".45"/>',
  storey: '<path d="M4 20h16V9l-8-5-8 5Z"/><path d="M4 13h16M4 17h16"/>',
  setback: '<path d="M3 20h18v-4H7l-4-3Z"/><path d="M7 13V9l6-3 6 3v7"/>',

  // --- face
  pushpull: '<path d="M6 18V6h6"/><path d="M12 6h8v12h-8" stroke-dasharray="2 2"/><path d="M12 11v6m-2.5-3h5"/>',
  inset: '<path d="M4 4h16v16H4Z"/><path d="M8 8h8v8H8Z"/>',
  outset: '<path d="M8 8h8v8H8Z"/><path d="M4 4h16v16H4Z" stroke-dasharray="2 2"/>',
  split: '<path d="M4 5h16v14H4Z"/><path d="M12 5v14" stroke-dasharray="2 2"/>',
  bevel: '<path d="M4 20V8l6-4h10v16Z"/><path d="M4 8h6V4"/>',
  voidGap: '<path d="M4 4h16v16H4Z"/><path d="M9 15V9h6v6Z" fill="currentColor" opacity=".4"/>',

  // --- openings
  door: '<path d="M5 4h14v16H5Z"/><path d="M9 20V9h6v11"/><circle cx="13.4" cy="14" r=".6"/>',
  window: '<path d="M5 4h14v16H5Z"/><path d="M9 9h6v7H9Z"/><path d="M12 9v7M9 12.5h6"/>',
  shopfront: '<path d="M4 20V9h16v11"/><path d="M4 9l2-4h12l2 4"/><path d="M7 20v-6h10v6"/>',
  loadingDoor: '<path d="M4 4h16v16H4Z"/><path d="M7 8h10v12H7Z"/><path d="M7 11h10M7 14h10M7 17h10"/>',
  freeOpening: '<path d="M4 4h7v16H4Z"/><path d="M13 4h7v16h-7Z" stroke-dasharray="2 2"/>',

  // --- structure
  levelSlab: '<path d="M3 12l9-4 9 4-9 4Z"/><path d="M3 12v2l9 4 9-4v-2"/>',
  slab: '<path d="M3 13l9-4 9 4-9 4Z"/><path d="M6 13.5v3l6 3 6-3v-3"/>',
  pillar: '<path d="M8 4h8v3H8Z"/><path d="M9 7v13m6-13v13"/><path d="M6 20h12"/>',
  beam: '<path d="M3 8h18v4H3Z"/><path d="M6 12v4m12-4v4"/>',
  stair: '<path d="M4 20h4v-4h4v-4h4V8h4"/><path d="M4 20V8"/>',
  ramp: '<path d="M3 19h18L3 11Z"/>',
  wall: '<path d="M3 9h18v9H3Z"/><path d="M3 13.5h18M9 9v4.5m6 0V18"/>',

  // --- roof
  roofFlat: '<path d="M4 18V10h16v8"/><path d="M4 10V8h16v2"/>',
  roofShed: '<path d="M4 18V11l16-5v12"/>',
  roofGable: '<path d="M4 18v-7l8-6 8 6v7"/>',
  roofHip: '<path d="M4 18v-6l4-5h8l4 5v6"/>',
  roofSawtooth: '<path d="M3 18v-7l5-4v4l5-4v4l5-4v11"/>',
  roofMansard: '<path d="M3 18v-4l4-5h10l4 5v4"/><path d="M7 14h10l2-3"/>',
  roofCustom: '<path d="M3 18l5-6 4 3 4-7 5 5"/><path d="M3 18h18"/>',

  // --- components
  balcony: '<path d="M4 11h16"/><path d="M5 11v6m4-6v6m6-6v6m4-6v6"/><path d="M3 17h18"/>',
  canopy: '<path d="M4 6v14"/><path d="M4 9h15l-2 3H4"/>',
  railing: '<path d="M3 17h18"/><path d="M6 17V8m5 9V8m5 9V8m5 9V8"/><path d="M4 8h16"/>',
  parapet: '<path d="M3 17V9h18v8"/><path d="M3 12h18M7 9v3m5-3v3m5-3v3"/>',
  chimney: '<path d="M7 20V7h5v13"/><path d="M6 7h7l-1.5-3h-4Z"/><path d="M13 12h4v8h-4Z"/>',
  duct: '<path d="M6 4h4v16H6Z"/><path d="M14 4h4v6h-4Z"/><path d="M14 13h4v7h-4Z"/>',
  dock: '<path d="M3 15h18v3H3Z"/><path d="M6 15V9h8l4 3"/><path d="M3 18v3m18-3v3"/>',
  moreComponents: '<circle cx="5" cy="12" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="19" cy="12" r="1.4"/>',

  // --- finish
  material: '<path d="M4 4h16v16H4Z"/><path d="M4 9h16M4 15h16M9 4v16m6-16v16"/>',
  colour: '<path d="M12 3s6 7 6 11a6 6 0 0 1-12 0c0-4 6-11 6-11Z"/>',
  copyStyle: '<path d="M5 5h9v9H5Z"/><path d="M9 9h10v10H9Z"/><path d="M12 12h4v4"/>',
  paintFace: '<path d="M4 12 12 4l8 8-8 8Z"/><path d="M7 12h10"/>',
  paintVolume: '<path d="M4 9l8-4 8 4v9l-8 4-8-4Z"/><path d="M4 9l8 4 8-4"/>',
  paintBuilding: '<path d="M5 20V6h14v14"/><path d="M3 20h18"/><path d="M9 20v-5h6v5"/>',

  // --- the family buttons, and the variants behind them. Every id the
  // catalogue can show has a glyph: a gallery of identical squares named the
  // options without picturing them.
  floors: '<path d="M4 20V6l8-3 8 3v14"/><path d="M4 11h16M4 15.5h16"/><path d="M10 20v-2.5h4V20"/>',
  storeyDown: '<path d="M4 19h16V8l-8-5-8 5Z"/><path d="M4 12h16"/><path d="M12 14v4m-2-1.6 2 2 2-2"/>',
  volumes: '<path d="M3 11l5-3 5 3v5l-5 3-5-3Z"/><path d="M13 8l4-2.4 4 2.4v5l-4 2.4-4-2.4Z"/>',
  wing: '<path d="M3 5h8v14H3Z"/><path d="M11 9h10v10H11Z"/><path d="M5.5 9h3M5.5 12.5h3"/>',
  stack: '<path d="M7 3h10v5.5H7Z"/><path d="M5 9.5h14V15H5Z"/><path d="M7 16h10v5H7Z"/>',
  cut: '<path d="M4 6h11v12H4Z"/><path d="M15 6h5v12h-5Z" stroke-dasharray="2 2"/><path d="M15 6v12"/>',
  moveMass: '<path d="M3 14l5-2.6 5 2.6v4l-5 2.6-5-2.6Z"/><path d="M18 4v6m-2.4-2.4L18 10l2.4-2.4"/>',
  planShape: '<path d="M5 7l7-4.4L19 7v10l-7 4.4L5 17Z"/><circle cx="5" cy="7" r="1.5" fill="currentColor" stroke="none"/><circle cx="19" cy="17" r="1.5" fill="currentColor" stroke="none"/><circle cx="19" cy="7" r="1.5" fill="currentColor" stroke="none"/>',
  vertexAdd: '<path d="M5 7l7-4.4L19 7v10l-7 4.4L5 17Z"/><path d="M12 9v6m-3-3h6"/>',
  vertexRemove: '<path d="M5 7l7-4.4L19 7v10l-7 4.4L5 17Z"/><path d="M9 12h6"/>',
  shapes: '<path d="M3 8h6v6H3Z"/><circle cx="17" cy="6.5" r="3.2"/><path d="M12 21l3.4-5.4L18.8 21Z"/>',
  sketch: '<path d="M3 17c4-7 6 2 9-3s3 2 9-4"/><path d="M3 21h18"/>',
  circle: '<circle cx="12" cy="12" r="8.2"/><path d="M12 3.8v16.4"/>',
  hexagon: '<path d="M8.5 3.6h7L20 12l-4.5 8.4h-7L4 12Z"/>',
  octagon: '<path d="M9 3.8h6L20 9v6l-5 5.2H9L4 15V9Z"/>',
  chamfered: '<path d="M4 6.5h10.5L20 12v5.5H4Z"/><path d="M14.5 6.5 20 12"/>',
  openWindows: '<path d="M4 4h16v16H4Z"/><path d="M8.5 8.5h7v7h-7Z" stroke-dasharray="2 2"/><path d="M12 8.5v7M8.5 12h7"/>',
  sashWindow: '<path d="M5 4h14v16H5Z"/><path d="M9 9h6v10H9Z"/><path d="M9 14h6M12 9v10"/>',
  wideWindow: '<path d="M3 7h18v10H3Z"/><path d="M9 7v10m6-10v10"/>',
  ribbon: '<path d="M3 8h18v8H3Z"/><path d="M7.5 8v8m4.5-8v8m4.5-8v8"/>',
  bayWindow: '<path d="M7 6.5h10v11H7Z"/><path d="M7 6.5 4 10v4l3 3.5M17 6.5 20 10v4l-3 3.5"/>',
  frenchWindow: '<path d="M5 4h14v16H5Z"/><path d="M12 4v16"/><path d="M9 4V2.4m6 1.6V2.4"/><circle cx="10.4" cy="12" r=".7" fill="currentColor"/><circle cx="13.6" cy="12" r=".7" fill="currentColor"/>',
  openDoors: '<path d="M4 4h16v16H4Z"/><path d="M9 20V8.5h6V20" stroke-dasharray="2 2"/><circle cx="13.4" cy="14" r=".7" fill="currentColor"/>',
  doubleDoor: '<path d="M4 4h16v16H4Z"/><path d="M12 4v16"/><circle cx="10.3" cy="13" r=".7" fill="currentColor"/><circle cx="13.7" cy="13" r=".7" fill="currentColor"/>',
  garageDoor: '<path d="M4 4h16v16H4Z"/><path d="M7 8h10M7 11.2h10M7 14.4h10M7 17.6h10"/>',
  runs: '<path d="M3 18.5h18" stroke-dasharray="3 2.4"/><path d="M6.5 18.5V9m5.5 9.5V6m5.5 12.5V9"/>',
  wallRun: '<path d="M3 9.5h18v9H3Z"/><path d="M3 14h18M9 9.5V14m6 0v4.5"/>',
  fenceRun: '<path d="M4.5 20V8m5 12V8m5 12V8m5 12V8"/><path d="M3 12.5h18M3 16.5h18"/>',
  pavementRun: '<path d="M3 15.5h18v5H3Z"/><path d="M7 15.5v5m5-5v5m5-5v5"/>',
  stairRun: '<path d="M3 20.5h4.5V16H12v-4.5h4.5V7H21"/><path d="M4 20.5V7"/>',
  tree: '<path d="M12 3l5.2 7.4h-3.1L18.4 17H5.6l4.3-6.6H6.8Z"/><path d="M12 17v4"/>',
  flowers: '<circle cx="12" cy="8.6" r="2.5"/><path d="M12 3.4v2.5M12 11.1v2.5M6.6 8.6H9m6 0h2.4M8.2 5.4l1.6 1.7m4.4 3 1.6 1.7M15.8 5.4l-1.6 1.7m-4.4 3L8.2 12.1"/><path d="M12 13v8"/>',
  rocks: '<path d="M3 18c0-3.2 2.2-5.4 5-5.4s4.4 1.8 4.6 4.4"/><path d="M11.4 17c.4-2.8 2.2-4.4 4.6-4.4 2.6 0 4.6 2.2 4.6 5.4Z"/><path d="M2.6 18h18.8"/>',
  bench: '<path d="M4 10.5h16V14H4Z"/><path d="M6 14v6.4m12-6.4v6.4"/><path d="M4 14h16"/>',
  planter: '<path d="M5.6 13h12.8l-1.6 8H7.2Z"/><path d="M12 13V8.6"/><path d="M9 8.8C9 6.4 10.3 5 12 5s3 1.4 3 3.8"/>',
  parking: '<path d="M4 4h16v16H4Z"/><path d="M10 17.5V7h3.2a2.8 2.8 0 0 1 0 5.6H10"/>',
  ac: '<path d="M5 5.5h14v8.5H5Z"/><path d="M8 14v4.4m4-4.4v4.4m4-4.4v4.4"/><path d="M8 9h8"/>',
  awning: '<path d="M4 10l1.8-5h12.4L20 10"/><path d="M4 10c1.4 1.7 2.8 1.7 4 0 1.4 1.7 2.8 1.7 4 0 1.4 1.7 2.8 1.7 4 0 1.2 1.7 2.6 1.7 4 0"/><path d="M5.6 10.6V20h12.8v-9.4"/>',
  roofGear: '<path d="M3 14.4 18.6 10 21 12.6 5.4 17Z"/><path d="M7.6 15.2 9.8 16M11.4 14.2l2.2.8M15.2 13.2l2.2.8"/>',
  solar: '<path d="M3 8.6h18v9H3Z"/><path d="M9 8.6v9m6-9v9M3 13.1h18"/>',
  skylight: '<path d="M3 14.6 12 9l9 5.6"/><path d="M7.4 12.8 12 10l4.6 2.8"/><path d="M12 14.6v6.4"/>',
  vent: '<path d="M6.5 4h11v3.6h-11Z"/><path d="M8.6 7.6v12.4m3.4-12.4v12.4m3.4-12.4v12.4"/>',
  waterTank: '<path d="M6 8.4h12v11.6H6Z"/><path d="M9 8.4V5h6v3.4"/><path d="M6 13h12"/>',
  spire: '<path d="M12 2.4 15 10h-6Z"/><path d="M12 10v10"/><path d="M8.4 20h7.2"/>',
  roofs: '<path d="M3 13.6 12 6l9 7.6"/><path d="M6 13.6V20h12v-6.4"/><path d="M12 13v7"/>',
  roofTerrace: '<path d="M4 16.4V9h16v7.4"/><path d="M3.4 16.4h17.2"/><path d="M8 9V5.6m8 3.4V5.6"/>',
  roofShape: '<path d="M4 18.4V10l8-6 8 6v8.4"/><path d="M12 4v14.4" stroke-dasharray="2 2"/>',
  patterns: '<path d="M4 4h16v16H4Z"/><path d="M12 4v16M4 12h16"/><path d="M4 4h8v8H4Z" fill="currentColor" stroke="none" opacity=".35"/>',
  paint: '<path d="M9.6 14.6 18 6.2l3 3-8.4 8.4Z"/><path d="M9.6 14.6 7.6 20l-4.2 1.4L4.8 17Z"/>',
  flush: '<path d="M3.6 5h16.8"/><path d="M7 9h10v11H7Z"/><path d="M10 12.6h4"/>',
  pavement: '<path d="M3 14.6h18v5.4H3Z"/><path d="M8 14.6v5.4m5-5.4v5.4"/>',
  greenery: '<path d="M8.4 3 12 8h-2.6L13 13.4H3.8L7.4 8H4.8Z"/><path d="M8.4 13.4V18"/><path d="M14.6 18c0-2 1.4-3.4 3.2-3.4S21.4 16 21.4 18Z"/>',
  furniture: '<path d="M3.6 11h9.4v3H3.6Z"/><path d="M5.4 14v6m5.8-6v6"/><path d="M15.4 12.4h5l-1 7.6h-3Z"/>',
  pillarBay: '<path d="M10 6h4v12h-4Z"/><path d="M4 6h3v12H4Z" stroke-dasharray="2 2"/><path d="M7 20h10"/>',
  wallBay: '<path d="M4 6h16v12H4Z"/><path d="M12 6v12" stroke-dasharray="2 2"/><path d="M4 10h8M4 14h8"/>',
  fence: '<path d="M5 20.4V7.6m4.6 12.8V7.6m4.8 12.8V7.6m4.6 12.8V7.6"/><path d="M3.4 12h17.2M3.4 16h17.2"/>',

  // --- the three groups the categories live in
  create: '<path d="M4 20V7l8-3 8 3v13Z"/><path d="M4 11h16"/><path d="M10 20v-5h4v5"/>',
  insert: '<path d="M12 3v10"/><path d="m8 9 4 4 4-4"/><path d="M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/>',
  appearance: '<path d="M12 3s6 7 6 11a6 6 0 0 1-12 0c0-4 6-11 6-11Z"/><path d="M9.5 14.5c.5 1.4 1.3 2.1 2.5 2.4"/>',

  // --- misc (bottom tray)
  check: '<path d="m5 13 4 4L19 7"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  collapse: '<path d="M14 6l-6 6 6 6"/>',
  expand: '<path d="M10 6l6 6-6 6"/>',
  caret: '<path d="m6 9 6 6 6-6"/>',
};

export type BuilderIconId = keyof typeof P;

const FALLBACK = '<path d="M4 4h16v16H4Z"/>';

/** The seven tabs of Construction, drawn with the glyph of what they hold. */
const TAB_ICON: Readonly<Record<string, BuilderIconId>> = {
  'tab-models': 'create',
  'tab-draw': 'draw',
  'tab-mass': 'mass',
  'tab-facade': 'face',
  'tab-parts': 'components',
  'tab-roof': 'roof',
  'tab-paint': 'appearance',
};

/** The glyph body for an id, ready to drop inside an `<svg>`. */
export function builderIcon(id: string): string {
  const alias = TAB_ICON[id];
  return P[(alias ?? id) as BuilderIconId] ?? FALLBACK;
}

/** A complete inline SVG for an id. */
export function builderIconSvg(id: string, size = 18): string {
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${builderIcon(id)}</svg>`;
}
