import { METERS_PER_UNIT } from '@world/units';
import { type Vec2, dist } from '@core/vec2';
import { COARSE_EPS, clamp } from '@core/scalar';
import { flattenSegment, shapeFromControl, type CurveShape } from '@core/bezier';
import { RoadDoc, fitRoadCurve, type JunctionControl } from '@world/doc';
import { MIN_LINK_LENGTH } from '@world/approach';
import { MAX_AUTHORED_GRADE } from '@world/elevation';
import { Network } from '@world/network';
import { LAST_UPGRADE_CLASS, ROAD_TYPES, roadProfile, roadType } from '@world/roadTypes';
import { UNITS_PER_METER } from '@world/units';
import { MAX_TERRAIN_STAMPS, type TerrainMode } from '@world/terrain';
import type { NodeId, SegmentId } from '@world/ids';
import { POLE_HEIGHT, spanSag } from '@world/utilities';
import {
  POLE_PICK_PIXELS,
  commitPoleRun,
  planPoleRun,
  type PoleRunPlan,
} from '@editor/poles';

import { Camera } from '@view/camera';
import { type Viewport, flatViewport } from '@view/viewport';
import { CanvasSurface } from '@ui/overlay/surface';
import { INVALID, SELECTION, HOVER } from '@ui/overlay/palette';
import { createSceneRenderer, type SceneHandle } from '@render/renderer';
import { createPersonPreview } from '@render/people/personPreview';
import { createPersonCreator } from '@ui/creator/personCreator';
import { DEFAULT_AZIMUTH, DEFAULT_ELEVATION, isoZoomBounds } from '@render/isoViewport';

import { SimWorld } from '@sim/world';
import { createPeopleEngine } from '@sim/people/people';
import { rebindAgents, rebindPeds, rebindVehicles, step } from '@sim/pipeline';
import { DT, NARROW_SCREEN_SHARE, NARROW_SCREEN_WIDTH } from '@sim/params';
import { summarize } from '@sim/audit';

import {
  type Anchor, anchorForHeight as anchorAtHeight, anchorHeightOffset as anchorHeightAt, findAnchor, snapRoadEndpoint, type SnapResult,
} from '@editor/snap';
import { type DraftResult, commitRoadPath, duplicateSegment, joinSegments, reconcileMovedNode, splitSegment } from '@editor/commit';
import { roadPathFromGesture, type RoadPathPiece, type RoadPathPoint } from '@editor/roadPath';
import { History, restoreInto, restoreSnapshot } from '@editor/history';
import { type ImportResult, Persistence, exportToFile, importFromFile, type SavedSettings } from '@editor/persistence';
import { drawMinimap, minimapToWorld } from '@ui/minimap';
import { openInspector, closeInspector, refreshInspector } from '@ui/inspector';
import { focusCameFromKeyboard, initChrome } from '@ui/chrome';
import { roadSwatch } from '@ui/roadSwatch';
import { mountBuildStamp } from '@ui/buildStamp';
import { mountAbout } from '@ui/about';
import { LANGUAGES, hasKey, initLanguage, language, onLanguageChange, setLanguage, t } from '@ui/i18n';
import {
  nodeCountLabel,
  peopleCountLabel,
  roadCountLabel,
  roadTypeDescription,
  roadTypeName,
  vehicleCountLabel,
} from '@ui/labels';
import { isQualityLevel, type QualityLevel } from '@render/quality';
import { createBuildingWiring } from './buildingsWiring';
import { levelElevation, roofRise } from '@world/buildings/geometry';
import { volumeTop } from '@world/buildings/types';

type Tool =
  | 'building'
  | 'road'
  | 'terrain'
  | 'upgrade'
  | 'move'
  | 'split'
  | 'bulldoze'
  | 'control'
  | 'inspect'
  | 'pole'
  | 'person';
type Alignment = 'straight' | 'curve' | 'free';
interface RoadDraft {
  readonly start: Anchor;
  readonly startHeightOffset: number;
  readonly chained: boolean;
  readonly pressedAt: Vec2;
  snap: SnapResult;
  readonly samples: RoadPathPoint[];
  heightOffset: number;
  curveControl?: Vec2;
}

interface CurvePending {
  readonly start: Anchor;
  readonly startHeightOffset: number;
  end: Anchor;
  endHeightOffset: number;
  control: Vec2;
}

/**
 * A pole run being drawn.
 *
 * `from` is where the gesture started and `to` is the pointer. Neither is
 * where anything is BUILT: `planPoleRun` snaps both and decides the poles,
 * and the preview draws that plan rather than the raw drag, so what is under
 * the pointer is what appears on release.
 *
 * `chained` marks a run whose start came from the previous run's last pole
 * rather than from a fresh press, which is how a line is traced across a map
 * in several straight stretches without restarting the tool at every corner.
 */
interface PoleDraft {
  readonly from: Vec2;
  to: Vec2;
  readonly chained: boolean;
}

// The interface language is resolved and applied BEFORE anything reads a label,
// so no frame is ever painted in the wrong language.
initLanguage();

const canvas = document.getElementById('game') as HTMLCanvasElement;
const minimapCanvas = document.getElementById('minimap') as HTMLCanvasElement;

const doc = new RoadDoc();
const net = new Network(doc);
const camera = new Camera();
const surface = new CanvasSurface(canvas, () => requestDraw());
const history = new History();
const persistence = new Persistence();

surface.observe();

// ------------------------------------------------------------------ boot
const savedSession = persistence.loadSession();
// The game opens on an empty map. An autosave that is still an earlier build's
// untouched starter scenario is dropped too; anything the player built stays.
const saved = savedSession?.document && !isUntouchedStarter(savedSession.document)
  ? savedSession.document
  : null;
// A saved map that validates and still fails to load must not take the game
// down with it - on every reload. It is set aside (never deleted) and the game
// opens empty, saying so.
let bootFailed = false;
if (saved) {
  try {
    restoreInto(doc, saved, net);
  } catch (error) {
    console.error('The saved map could not be loaded; it was set aside.', error);
    persistence.quarantineStored();
    doc.replaceWith(new RoadDoc());
    net.rebuild();
    bootFailed = true;
  }
} else {
  net.rebuild();
}

const sim = new SimWorld(doc, net, 0x2024);
sim.rebuildTopology();
// Pedestrians are navmesh agents (the People engine); `?peds=legacy` runs the
// old sidewalk-graph model instead, for comparison while it is retired.
if (new URLSearchParams(location.search).get('peds') !== 'legacy') sim.usePedestrianEngine(createPeopleEngine());
// Vehicles are driven by Drive v2 where it has replaced a layer of the
// legacy model; `?drive=v1` runs the legacy model throughout, for comparison.
if (new URLSearchParams(location.search).get('drive') !== 'v1') sim.driveModel = 'v2';
sim.auditEnabled = true;
sim.auditLevel = 'cheap';
/** The simulation never reads the screen; the screen's size is handed to it. */
function syncPopulationShare(): void {
  sim.populationShare = window.innerWidth < NARROW_SCREEN_WIDTH ? NARROW_SCREEN_SHARE : 1;
}
syncPopulationShare();

/**
 * The zoom range the renderer we are about to boot can actually represent.
 *
 * Before the viewport exists there is nothing to ask, so this mirrors what
 * `createThreeRenderer` does with the same canvas: the iso rig takes its initial
 * half-height from `canvas.clientHeight`, so its range is
 * `isoZoomBounds(that height)`. Under `?render=2d` the flat camera's own range
 * applies instead. `view.zoomBounds` is used once a viewport exists.
 */
function bootZoomBounds(): { min: number; max: number } {
  return isoZoomBounds(Math.max(1, canvas.clientHeight || window.innerHeight));
}

if (savedSession && saved) {
  camera.x = savedSession.settings.camera.x;
  camera.y = savedSession.settings.camera.y;
  // Clamped against the ACTIVE renderer's range, not always the flat camera's.
  // A 3D session can legitimately sit at ~7.3 zoom at an 800 px viewport, and
  // the flat bounds (0.18-3.2) snapped every reload of one back to 3.2. The
  // clamp stays: it is the guard against a hand-edited or corrupt save file.
  const limits = bootZoomBounds();
  camera.zoom = clamp(savedSession.settings.camera.zoom, limits.min, limits.max);
} else {
  camera.fit(worldBounds(), surface.cssW, surface.cssH);
}

/**
 * Whether an autosave is exactly one of the starter scenarios an earlier build
 * seeded, never edited. Such a save carries nothing of the player's, so the
 * game opens on an empty map instead.
 */
function isUntouchedStarter(saved: ReturnType<RoadDoc['toJSON']>): boolean {
  // Declared here, not at module level: boot calls this before any `const`
  // below it is initialised.
  const OLD_STARTERS: readonly { readonly segments: number; readonly nodes: ReadonlySet<string> }[] = [
    // A 3x3 grid with four approach stubs.
    {
      segments: 16,
      nodes: new Set([
        ...[-360, 0, 360].flatMap((x) => [-260, 0, 260].map((y) => `${x},${y}`)),
        '0,-480', '0,480', '-580,0', '580,0',
      ]),
    },
    // An avenue crossed at a signalised crossroads, with a local street at a T.
    {
      segments: 6,
      nodes: new Set(['-560,0', '0,0', '330,0', '600,0', '0,-430', '0,430', '330,360']),
    },
  ];
  const nodes = saved.nodes ?? [];
  const segments = saved.segments ?? [];
  if ((saved.terrain ?? []).length > 0 || (saved.poles ?? []).length > 0 ||
    (saved.buildings ?? []).length > 0) return false;
  return OLD_STARTERS.some((starter) =>
    nodes.length === starter.nodes.size && segments.length === starter.segments &&
    nodes.every((n) => starter.nodes.has(`${n.x},${n.y}`)));
}

function worldBounds() {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const n of doc.nodes.values()) {
    minX = Math.min(minX, n.x);
    minY = Math.min(minY, n.y);
    maxX = Math.max(maxX, n.x);
    maxY = Math.max(maxY, n.y);
  }
  if (!Number.isFinite(minX)) return { minX: -200, minY: -200, maxX: 200, maxY: 200 };
  return { minX, minY, maxX, maxY };
}

// ------------------------------------------------------------------ state
let tool: Tool = 'road';
let roadTypeIndex = 1;
let alignment: Alignment = 'straight';
let roadHeightOffset = 0;
let roadHeightEdited = false;
let terrainMode: TerrainMode = 'raise';
let terrainRadius = 80;
let terrainStrength = 4;
let traffic = !savedSession?.settings.paused;
let congestionOverlay = savedSession?.settings.congestionOverlay ?? false;
sim.clock.paused = !traffic;
sim.clock.speed = savedSession?.settings.speed ?? 1;
sim.trafficIntensity = savedSession?.settings.trafficIntensity ?? 1;
sim.pedestrianIntensity = savedSession?.settings.pedestrianIntensity ?? 1;
sim.demandMultiplier = savedSession?.settings.demandMultiplier ?? 1;

function sessionSettings(): SavedSettings {
  const centre = view.centre;
  return {
    camera: { x: centre.x, y: centre.y, zoom: view.zoom, azimuth: view.azimuth, elevation: view.elevation },
    paused: sim.clock.paused,
    speed: sim.clock.speed,
    trafficIntensity: sim.trafficIntensity,
    pedestrianIntensity: sim.pedestrianIntensity,
    demandMultiplier: sim.demandMultiplier,
    congestionOverlay,
  };
}

let draft: RoadDraft | null = null;
let roadChain: Anchor | null = null;
let roadChainHeight = 0;
let chainPreview: RoadDraft | null = null;
let curvePending: CurvePending | null = null;
let roadPointerScreen: Vec2 | null = null;
let poleDraft: PoleDraft | null = null;
/**
 * The end of the last committed pole run, while the tool is still on it.
 *
 * A distribution line is drawn as a sequence of straight stretches, and
 * finishing one is almost never finishing the line. Holding the last pole
 * means the next press continues from it instead of starting a disconnected
 * run a few units away. Escape, a different tool or an undo drops it.
 */
let poleChain: Vec2 | null = null;
let hoverAnchor: Anchor | null = null;
let selectedSegment: SegmentId | null = null;
let selectedSegmentS: number | null = null;
let selectedNode: NodeId | null = null;

/**
 * Panning is stored as the GROUND POINT that was grabbed, not as a screen
 * origin and a camera origin.
 *
 * "Keep what I grabbed under the pointer" is the same rule in both renderers;
 * "shift the camera by the screen delta over the zoom" is only true looking
 * straight down. Storing the grabbed point means one rule, tested once, and no
 * branch here at all.
 */
let panning: {
  id: number;
  grabbed: Vec2;
  /** Where a right press began, CSS px, and whether it has since become a drag. */
  pressed?: Vec2;
  moved?: boolean;
  /** A right click that stays a click cancels the gesture in progress. */
  cancelOnClick?: boolean;
} | null = null;
/** Camera turn and tilt per CSS pixel of an orbit drag, rad: a full turn in ~1000 px. */
const ORBIT_PER_PX = 0.0063;
/**
 * Which way a twist of two fingers turns the camera, so the map turns with
 * them: a positive orbit turns the map anticlockwise on screen, and a
 * clockwise twist grows the angle between the fingers.
 */
const TWIST_SIGN = -1;
/** How far a right press may travel, CSS px, and still be a click rather than a pan. */
const CLICK_SLOP = 5;
/** Camera turn per Q/E press, rad. */
const KEY_TURN = Math.PI / 12;
/** A camera orbit in progress: the pointer and where it last was, CSS px. */
let orbiting: { id: number; last: Vec2; pressed: Vec2; moved: boolean; cancelOnClick: boolean } | null = null;
/**
 * A node being dragged, with the document as it was when the drag began. The
 * live preview edits the document, and each step through a spot where an
 * incident curve would be too tight flattened it for good (`fitCurve`); the
 * snapshot is what cancel restores and what the undo step records.
 */
let moving: { node: NodeId; origin: Vec2; before: ReturnType<RoadDoc['toJSON']> } | null = null;
/**
 * A terrain stroke in progress.
 *
 * `level` is captured ONCE, when the stroke starts, and reused for every dab in
 * it. That is what makes levelling predictable: a player drags across a slope
 * and the whole swept area comes to the height they started from, instead of
 * each dab chasing the ground under itself and leaving the slope exactly as it
 * was. `at` is kept so a held pointer keeps working the same spot.
 */
let terrainStroke: {
  pointer: number;
  last: Vec2;
  at: Vec2;
  level: number;
  /** Wall time of the last dab, for the rate limit. */
  applied: number;
} | null = null;
/** Drives the held-still repeat, so holding the button keeps digging. */
let terrainRepeat: ReturnType<typeof setInterval> | null = null;
let pinch: { d0: number; zoom0: number; world: Vec2; angle: number } | null = null;
const pointers = new Map<number, Vec2>();
canvas.dataset['tool'] = tool;

let view: Viewport = flatViewport(camera);


/**
 * The editor's overlay gets its OWN canvas, and must.
 *
 * Reusing the flat canvas looked free — a canvas hands out one context for its
 * whole life, so `getContext('2d')` would return the very context the flat
 * painter holds. But that context was created with `{ alpha: false }`
 * (`render/surface.ts`), and on an opaque context `clearRect` does not clear to
 * transparent, it clears to BLACK. Measured: the entire 3D scene disappeared
 * behind a black rectangle the moment the overlay drew its first frame.
 */
const overlayCanvas = document.createElement('canvas');
let overlayCtx: CanvasRenderingContext2D | null = null;
let previewAsphaltPattern: CanvasPattern | null = null;

/** Asphalt grain used by the live 3D-editor preview. */
function asphaltPreviewPattern(ctx: CanvasRenderingContext2D): CanvasPattern | string {
  if (previewAsphaltPattern) return previewAsphaltPattern;
  const tile = document.createElement('canvas');
  tile.width = 48;
  tile.height = 48;
  const paint = tile.getContext('2d');
  if (!paint) return '#45494b';
  paint.fillStyle = '#505456';
  paint.fillRect(0, 0, tile.width, tile.height);
  let state = 0x6d2b79f5;
  for (let i = 0; i < 150; i++) {
    state = (Math.imul(state ^ (state >>> 15), 2246822519) + 3266489917) >>> 0;
    const x = state % tile.width;
    const y = (state >>> 8) % tile.height;
    paint.globalAlpha = 0.08 + ((state >>> 17) & 15) / 100;
    paint.fillStyle = (state & 1) === 0 ? '#171a1b' : '#a4a6a3';
    paint.fillRect(x, y, 1 + ((state >>> 24) & 1), 1);
  }
  paint.globalAlpha = 1;
  previewAsphaltPattern = ctx.createPattern(tile, 'repeat');
  return previewAsphaltPattern ?? '#45494b';
}

const canvas3d = document.createElement('canvas');
canvas3d.id = 'game-scene';
canvas3d.setAttribute('aria-hidden', 'true');
canvas3d.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block;';
canvas.parentElement?.insertBefore(canvas3d, canvas);
const scene: SceneHandle = createSceneRenderer(canvas3d, { x: camera.x, y: camera.y }, camera.zoom, 'auto', requestDraw);
view = scene.viewport;
restoreOrbit(savedSession?.settings.camera);
canvas.style.opacity = '0';

overlayCanvas.id = 'game-overlay';
overlayCanvas.setAttribute('aria-hidden', 'true');
overlayCanvas.style.cssText =
  'position:absolute;inset:0;width:100%;height:100%;display:block;pointer-events:none;';
canvas.parentElement?.appendChild(overlayCanvas);
overlayCtx = overlayCanvas.getContext('2d');

window.addEventListener('resize', () => { scene.resize(); syncPopulationShare(); }, { passive: true });
canvas.dataset['render'] = 'webgl';

// Modular buildings (docs/buildings.md): the tool, its palette, its overlay
// and the road-wins rule, wired in `buildingsWiring.ts`.
const buildings = createBuildingWiring({
  doc,
  net,
  history,
  scene,
  view: () => view,
  size: () => ({ w: surface.cssW, h: surface.cssH }),
  undo: () => undoButton.click(),
  redo: () => redoButton.click(),
  focusBuilding(building) {
    const ground = building.volumes.filter((v) => v.base === 0);
    if (ground.length === 0) return;
    const cx = (Math.min(...ground.map((v) => v.x)) + Math.max(...ground.map((v) => v.x + v.w))) / 2;
    const cy = (Math.min(...ground.map((v) => v.y)) + Math.max(...ground.map((v) => v.y + v.d))) / 2;
    const c = Math.cos(building.rotation), s = Math.sin(building.rotation);
    const centre = { x: building.x + cx * c - cy * s, y: building.y + cx * s + cy * c };
    view.moveTo(centre);
    const span = Math.max(...ground.map((v) => Math.max(v.w, v.d)));
    const paletteWidth = document.getElementById('builder')?.getBoundingClientRect().width ?? 0;
    const available = Math.max(110, surface.cssW - paletteWidth - (surface.cssW < 600 ? 20 : 110));
      const corners = building.volumes.flatMap((v) => [
        [v.x, v.y], [v.x + v.w, v.y], [v.x + v.w, v.y + v.d], [v.x, v.y + v.d],
      ] as const).map(([x, y]) => view.toScreen({ x: building.x + x * c - y * s, y: building.y + x * s + y * c }, surface.cssW, surface.cssH));
      const projectedWidth = Math.max(...corners.map((p) => p.x)) - Math.min(...corners.map((p) => p.x));
      const top = Math.max(...building.volumes.map((v) => levelElevation(building, volumeTop(v)) + roofRise(building, v)
        + Math.max(0, ...(v.roofDetails ?? []).map((detail) => detail.h ?? 0))));
      const projectedRise = Math.abs(view.toScreen(centre, surface.cssW, surface.cssH, top).y
        - view.toScreen(centre, surface.cssW, surface.cssH).y);
      const projectedFootprint = Math.max(...corners.map((p) => p.y)) - Math.min(...corners.map((p) => p.y));
      const fit = Math.min(view.zoom * (available * .72) / Math.max(1, projectedWidth),
        view.zoom * (surface.cssH - 145) * .88 / Math.max(1, projectedRise + projectedFootprint));
    const ideal = Math.min(surface.cssW < 600 ? 3.2 : 7, Math.max(2.6, (surface.cssW < 600 ? 135 : 210) / span));
    const target = Math.max(view.zoomBounds.min, Math.min(view.zoomBounds.max, ideal, fit));
    view.zoomAt(surface.cssW / 2, surface.cssH / 2, target / view.zoom, surface.cssW, surface.cssH);
      const rise = Math.abs(view.toScreen(centre, surface.cssW, surface.cssH, top).y
        - view.toScreen(centre, surface.cssW, surface.cssH).y);
      view.panTo(centre, (surface.cssW - paletteWidth) / 2, surface.cssH / 2 + rise / 2 - 68, surface.cssW, surface.cssH);
  },
  afterEdit() {
    persistence.saveSessionSoon(doc, sessionSettings);
    updateHistoryButtons();
    requestDraw();
  },
  requestDraw: () => requestDraw(),
  flash: (key, params) => flashHint(key, params),
  hintChanged: () => updateHint(),
});

/** The ground the camera sees: the screen's four corners, on the ground. */
function viewFootprint(): Vec2[] {
  const { cssW: w, cssH: h } = surface;
  return [[0, 0], [w, 0], [w, h], [0, h]].map(([x, y]) => view.toWorld(x!, y!, w, h));
}

/** Puts the camera back at a saved bearing and tilt; a save without one gets the default view. */
function restoreOrbit(saved: SavedSettings['camera'] | undefined): void {
  view.setOrbit(saved?.azimuth ?? DEFAULT_AZIMUTH, saved?.elevation ?? DEFAULT_ELEVATION);
}

function syncViewFromFlatCamera(): void {
  view.moveTo({ x: camera.x, y: camera.y });
  view.zoomAt(
    surface.cssW / 2,
    surface.cssH / 2,
    camera.zoom / Math.max(0.001, view.zoom),
    surface.cssW,
    surface.cssH,
  );
}

function fitView(): void {
  camera.fit(worldBounds(), surface.cssW, surface.cssH);
  syncViewFromFlatCamera();
}

function syncFlatCameraFromView(): void {
  if (view.kind === '2d') return;
  const centre = view.centre;
  camera.x = centre.x;
  camera.y = centre.y;
  camera.zoom = view.zoom;
}

// ------------------------------------------------------------- mutations
function mutate(fn: () => boolean): void {
  mutateBuilt(fn);
}

/** `mutate`, reporting whether the edit actually changed anything. */
function mutateBuilt(fn: () => boolean): boolean {
  const before = doc.toJSON();
  if (!fn()) return false;
  // An edit that reports success without changing anything - the same lane
  // count, a split on an existing endpoint, a pole line traced over itself -
  // used to push an undo step and throw away the redo stack.
  if (JSON.stringify(before) === JSON.stringify(doc.toJSON())) return false;
  history.record(RoadDoc.fromJSON(before, { repair: false }));
  // A pole or a wire moves `doc.utilityRevision`, not `doc.revision`: the
  // network is unchanged, and rebuilding it (and, behind it, the simulation
  // topology) cost about 330 ms per pole on a large map.
  if (net.revision !== doc.revision) net.rebuild();
  // A road over a building demolishes it, in this same undo step.
  buildings.afterRoadEdit();
  // The simulation catches up in the frame AFTER the one that draws the edit
  // (see `topologyAfterDraw`), so the player sees the road first.
  topologyAfterDraw = topologyAfterDraw || sim.topologyRevision !== net.trafficRevision;
  persistence.saveSessionSoon(doc, sessionSettings);
  updateHistoryButtons();
  updateStatus();
  refreshInspector();
  requestDraw();
  return true;
}

/**
 * `snapshot`: the model's own undo/redo state, restored exactly. `import`:
 * data from outside (a file, the debug surface), where legacy repairs apply.
 */
function applySnapshot(data: ReturnType<RoadDoc['toJSON']> | null, source: 'snapshot' | 'import' = 'snapshot'): void {
  if (!data) return;
  draft = null;
  roadChain = null;
  chainPreview = null;
  curvePending = null;
  if (source === 'import') {
    restoreInto(doc, data, net);
    // A different map: nothing of the old simulation may carry over.
    sim.reset();
  } else {
    restoreSnapshot(doc, data, net);
  }
  // Only when the road plan the simulation runs on actually changed.
  if (sim.topologyRevision !== net.trafficRevision) rebuildSimulationTopology();
  buildings.restored();
  selectedSegment = null;
  selectedNode = null;
  closeInspector();
  persistence.saveSessionSoon(doc, sessionSettings);
  updateHistoryButtons();
  updateStatus();
  requestDraw();
}

/** Keeps live agents bound when the UI rebuilds topology outside a sim tick. */
function rebuildSimulationTopology(): void {
  sim.rebuildTopology();
  rebindAgents(sim);
}

// ---------------------------------------------------------------- input
/**
 * The one conversion that differs between renderers.
 *
 * Everything downstream of it — `findAnchor`, `snapEndpoint`, every editor
 * command — already works in world coordinates, so this is the entire seam
 * between a flat view and an isometric one. `src/editor` needs no change at all.
 */
/**
 * The world point under a screen position, ON THE SURFACE THAT IS THERE.
 *
 * A tilted camera projects anything raised away from the ground beneath it: a
 * deck fifteen units up lands about thirteen units off, so solving on the
 * `y = 0` plane picked open ground thirteen units from the node plainly drawn
 * under the cursor. That is why an elevated road could not be extended — the
 * snap was looking in the wrong place, and no snap radius fixes an error that
 * grows with height.
 *
 * Two or three iterations settle it: solve on the ground plane, read how high
 * the scene is there, solve again on that plane. Under an orthographic camera
 * the correction is exactly linear in height, so it converges immediately.
 */
function worldAtScreen(px: number, py: number, heightOffset?: number): Vec2 {
  let point = view.toWorld(px, py, surface.cssW, surface.cssH);
  if (view.kind === '2d') return point;
  let height = 0;
  for (let pass = 0; pass < 3; pass++) {
    const next = heightOffset === undefined
      ? sceneHeightAt(point)
      : scene.terrainHeightAt(point.x, point.y) + heightOffset;
    if (Math.abs(next - height) < 0.05) break;
    height = next;
    point = view.toWorldAt(px, py, height, surface.cssW, surface.cssH);
  }
  return point;
}

/** Whatever the player can see at a world point: a road deck, or the ground. */
function sceneHeightAt(p: Vec2): number {
  const road = scene.elevationAt(p.x, p.y);
  const ground = scene.terrainHeightAt(p.x, p.y);
  return Math.max(road, ground);
}

function pointerWorld(e: PointerEvent): Vec2 {
  const r = canvas.getBoundingClientRect();
  const authoredHeight = tool === 'road' && (draft || roadChain || curvePending)
    ? roadHeightOffset
    : undefined;
  return worldAtScreen(e.clientX - r.left, e.clientY - r.top, authoredHeight);
}

/**
 * The point a pan or pinch holds under the pointer.
 *
 * Solved on the SAME plane `view.panTo` solves on, which is the `y = 0` plane,
 * and deliberately not with `worldAtScreen`. That one lifts the point onto the
 * terrain or deck under the cursor, and `panTo` then compared a point on that
 * plane with one on `y = 0`: the two differ by `height / tan(48°)` along the
 * view, so the first move of every drag jerked the map that far — 35 px at
 * 500 %, 139 px at 2000 % on the default terrain. Under an orthographic camera
 * a horizontal shift moves every plane identically, so holding the `y = 0`
 * point under the pointer IS holding what was grabbed.
 */
function panAnchor(px: number, py: number): Vec2 {
  return view.toWorld(px, py, surface.cssW, surface.cssH);
}

function panAnchorOf(e: PointerEvent): Vec2 {
  const r = canvas.getBoundingClientRect();
  return panAnchor(e.clientX - r.left, e.clientY - r.top);
}

/**
 * Ends every gesture in progress without committing it: a road being drawn or
 * chained, a pole line, a terrain stroke, a node drag, a pan, the Builder's
 * press. ONE list for every way a gesture can be cut short - a tool switch,
 * undo/redo, Escape, the right button, a pinch - where there used to be six
 * lists that disagreed (Ctrl+Z mid-drag kept moving a node of the restored
 * map; Escape left a terrain stroke stamping).
 */
function cancelGestures(): void {
  draft = null;
  roadChain = null;
  chainPreview = null;
  curvePending = null;
  poleDraft = null;
  poleChain = null;
  endTerrainStroke();
  cancelMove();
  panning = null;
  orbiting = null;
  if (tool === 'building') buildings.pointerUp(true);
  requestDraw();
}

/** Whether anything is being drawn or dragged right now. */
function gestureInProgress(): boolean {
  return draft !== null || roadChain !== null || curvePending !== null || poleDraft !== null ||
    poleChain !== null || terrainStroke !== null || moving !== null;
}

/**
 * A press whose release will never arrive - the window lost focus, the pointer
 * capture was taken - ends what the held button was doing. A terrain stroke
 * kept stamping every 110 ms after an alt-tab with the button down.
 */
function releaseHeld(): void {
  endTerrainStroke();
  cancelMove();
  panning = null;
  orbiting = null;
  pointers.clear();
  pinch = null;
}

/** Cancels a node drag without leaving its live preview in the document. */
function cancelMove(): void {
  if (!moving) return;
  const before = moving.before;
  moving = null;
  restoreSnapshot(doc, before, net);
  if (sim.topologyRevision !== net.trafficRevision) rebuildSimulationTopology();
}

/** Height of an authored connection; open ground takes the height being drawn at. */
function anchorHeightOffset(anchor: Anchor): number {
  return anchorHeightAt(doc, net, anchor, roadHeightOffset);
}

/** A nearby road at another height is a crossing, not an accidental junction. */
function anchorForHeight(anchor: Anchor, heightOffset: number): Anchor {
  return anchorAtHeight(doc, net, anchor, heightOffset);
}

/**
 * Spacing between dabs along a drag, as a fraction of the brush radius.
 *
 * It was 0.28 and the dabs read as a string of craters rather than as a stroke.
 * A fifth of the radius overlaps enough for the smoothstep falloffs to sum into
 * one smooth channel, which is what carving a river needs.
 */
const TERRAIN_SPACING = 0.2;
/** Floor on the interval between dabs, so a fast drag cannot outrun a rebuild. */
const TERRAIN_MIN_MS = 45;
/** How often a held, stationary brush reapplies itself. */
const TERRAIN_REPEAT_MS = 110;

/**
 * The cost-aware rate limit, the same argument as `movePreviewInterval`.
 *
 * Every dab moves `terrainRevision`, which re-solves the whole road elevation
 * field and re-triangulates every band laid on the ground. On a big network
 * that is far more than a frame, and dabbing on every pointer sample simply
 * queued rebuilds until the player let go — which is exactly what "the terrain
 * tool is uncomfortable" describes. Asking the last rebuild what it cost keeps
 * the brush live on an empty map and merely coarser on a full one.
 */
function terrainPaintInterval(): number {
  // During a stroke only the ground is rebuilt (see `DrawOptions.holdRoads`),
  // so it is the ground's own cost that paces the brush.
  const cost = terrainStroke ? scene.stats.terrainMs : scene.stats.rebuildMs;
  return Math.max(TERRAIN_MIN_MS, cost * 1.4);
}

/** One dab, with no spacing or rate checks of its own. */
function stampTerrain(at: Vec2, level: number): void {
  doc.addTerrainStamp({
    x: at.x,
    y: at.y,
    radius: terrainRadius,
    strength: terrainStrength,
    mode: terrainMode,
    ...(terrainMode === 'flatten' ? { level } : {}),
  });
}

/**
 * Paints from the last dab to `at`, laying dabs along the way.
 *
 * Interpolating is the other half of a stroke feeling like a stroke: a pointer
 * sample can jump a hundred units at speed, and dabbing only where the samples
 * landed left gaps a river ran straight through.
 */
function paintTerrain(at: Vec2, force = false): void {
  const stroke = terrainStroke;
  if (!stroke) {
    stampTerrain(at, sceneHeightAt(at));
    requestDraw();
    return;
  }

  stroke.at = at;
  const now = performance.now();
  if (!force) {
    if (now - stroke.applied < terrainPaintInterval()) return;
    const moved = Math.hypot(at.x - stroke.last.x, at.y - stroke.last.y);
    if (moved < terrainRadius * TERRAIN_SPACING) return;
  }

  const spacing = Math.max(4, terrainRadius * TERRAIN_SPACING);
  const dx = at.x - stroke.last.x;
  const dy = at.y - stroke.last.y;
  const distance = Math.hypot(dx, dy);
  // Bounded, because a pointer that re-enters the canvas from far away must not
  // lay two hundred dabs in one event.
  const steps = force ? 1 : Math.min(12, Math.max(1, Math.round(distance / spacing)));
  for (let i = 1; i <= steps; i++) {
    const t = steps === 1 && force ? 1 : i / steps;
    stampTerrain({ x: stroke.last.x + dx * t, y: stroke.last.y + dy * t }, stroke.level);
  }
  stroke.last = at;
  stroke.applied = now;
  requestDraw();
}

/** Starts a stroke, capturing the level target and arming the held repeat. */
function beginTerrainStroke(pointer: number, at: Vec2): void {
  history.record(doc);
  terrainStroke = { pointer, last: at, at, level: sceneHeightAt(at), applied: 0 };
  paintTerrain(at, true);
  if (terrainRepeat !== null) clearInterval(terrainRepeat);
  terrainRepeat = setInterval(() => {
    const stroke = terrainStroke;
    if (!stroke) return;
    if (performance.now() - stroke.applied < terrainPaintInterval()) return;
    stampTerrain(stroke.at, stroke.level);
    stroke.applied = performance.now();
    requestDraw();
  }, TERRAIN_REPEAT_MS);
  updateHistoryButtons();
}

function endTerrainStroke(): void {
  const wasPainting = terrainStroke !== null;
  terrainStroke = null;
  // Past the cap the oldest sculpting is dropped to make room. Say so before
  // it happens rather than erase the player's first hills in silence.
  if (wasPainting && doc.terrainStamps.length >= MAX_TERRAIN_STAMPS * 0.9) {
    flashHint(doc.terrainStamps.length >= MAX_TERRAIN_STAMPS ? 'hint.terrain.capReached' : 'hint.terrain.capNear');
  }
  // The roads were held for the stroke; this frame re-solves them.
  requestDraw();
  if (terrainRepeat !== null) {
    clearInterval(terrainRepeat);
    terrainRepeat = null;
  }
}

canvas.addEventListener('pointerdown', (e) => {
  // The mouse's back and forward buttons are not a click: they used to fall
  // through to the tool as if they were the left button.
  if (e.pointerType === 'mouse' && e.button > 2) return;
  canvas.setPointerCapture(e.pointerId);
  const r = canvas.getBoundingClientRect();
  pointers.set(e.pointerId, { x: e.clientX - r.left, y: e.clientY - r.top });

  // A second finger promotes the gesture to pinch and cancels any draft. A
  // third finger is part of the pinch too: at size 3 it used to fall through to
  // the tool, and Bulldoze demolished the road under it.
  if (pointers.size >= 2) {
    cancelGestures();
    const [a, b] = [...pointers.values()] as [Vec2, Vec2];
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    pinch = {
      d0: Math.hypot(a.x - b.x, a.y - b.y),
      zoom0: view.zoom,
      world: panAnchor(mid.x, mid.y),
      angle: Math.atan2(b.y - a.y, b.x - a.x),
    };
    return;
  }

  // The mouse, as city builders have it: the right button dragged swings
  // the camera round and over the centre of the view (Shift with it pans);
  // a right CLICK - pressed and let go without moving - cancels whatever is
  // in progress. The middle button dragged pans. Both work mid-gesture, so a
  // road half placed can still be looked round.
  if (e.pointerType === 'mouse' && e.button === 2 && !e.shiftKey) {
    if (tool === 'building' && buildings.cancelOperation()) {
      requestDraw();
      return;
    }
    const at = { x: e.clientX - r.left, y: e.clientY - r.top };
    orbiting = { id: e.pointerId, last: at, pressed: at, moved: false, cancelOnClick: gestureInProgress() };
    return;
  }

  if (e.pointerType === 'mouse' && (e.button === 1 || e.button === 2)) {
    const at = { x: e.clientX - r.left, y: e.clientY - r.top };
    panning = { id: e.pointerId, grabbed: panAnchor(at.x, at.y) };
    return;
  }

  const world = pointerWorld(e);
  if (tool === 'road') roadPointerScreen = { x: e.clientX - r.left, y: e.clientY - r.top };
  if (tool === 'road' && curvePending) {
    const pending = curvePending;
    curvePending = null;
    const curveDraft: RoadDraft = {
      start: pending.start,
      startHeightOffset: pending.startHeightOffset,
      chained: true,
      pressedAt: world,
      snap: {
        at: pending.end.at,
        guide: pending.end.kind === 'free' ? null : 'network',
        angleDeg: 0,
        length: dist(pending.start.at, pending.end.at),
      },
      samples: [{ at: pending.start.at, heightOffset: pending.startHeightOffset }],
      heightOffset: pending.endHeightOffset,
      curveControl: world,
    };
    commitRoadGesture(curveDraft, pending.end);
    requestDraw();
    return;
  }
  const anchor = findAnchor(doc, net, world, view.zoom);

  switch (tool) {
    case 'road':
      {
      const chained = roadChain !== null;
      const start = roadChain ?? anchor;
      const startHeightOffset = chained
        ? roadChainHeight
        : start.kind === 'free' ? roadHeightOffset : anchorHeightOffset(start);
      if (!chained && start.kind !== 'free' && !roadHeightEdited) {
        roadHeightOffset = startHeightOffset;
        updateRoadHeightValue();
      }
      roadHeightEdited = false;
      chainPreview = null;
      draft = {
        start,
        startHeightOffset,
        chained,
        pressedAt: world,
        snap: snapRoadEndpoint(doc, net, start, world, view.zoom, roadHeightOffset),
        samples: [{ at: start.at, heightOffset: startHeightOffset }],
        heightOffset: roadHeightOffset,
      };
      break;
      }

    case 'terrain':
      beginTerrainStroke(e.pointerId, world);
      break;

    case 'building':
      buildings.pointerDown({ x: e.clientX - r.left, y: e.clientY - r.top }, world, e.shiftKey);
      break;

    case 'pole':
      // Shift-click removes, the way the bulldoze tool does on a road.
      //
      // Removal used to be what a plain click on a pole did, which made the
      // commonest gesture in the tool - starting a run AT an existing pole -
      // impossible: the press that should have begun the run deleted the pole
      // it was aimed at. The radius is also the same one the snap uses, so
      // anything the preview highlights can be hit.
      {
        const hit = doc.poleNear(world, poleReach());
        if (hit && e.shiftKey) {
          mutate(() => {
            doc.removePole(hit.id);
            return true;
          });
          poleChain = null;
          flashHint('hint.pole.removed');
        } else {
          const start = poleChain ?? world;
          poleDraft = { from: start, to: world, chained: poleChain !== null };
        }
      }
      break;

    case 'move':
      if (anchor.kind === 'node' && anchor.node !== undefined) {
        const node = doc.node(anchor.node);
        if (node) moving = { node: anchor.node, origin: { x: node.x, y: node.y }, before: doc.toJSON() };
      } else {
        panning = { id: e.pointerId, grabbed: panAnchorOf(e) };
      }
      break;

    case 'split':
      if (
        anchor.kind === 'segment' &&
        anchor.segment !== undefined &&
        anchor.s !== undefined
      ) {
        let node: NodeId | null = null;
        mutate(() => {
          node = splitSegment(doc, net, anchor.segment as SegmentId, anchor.s as number, anchor.at);
          return node !== null;
        });
        if (node !== null) {
          selectedSegment = null;
          selectedNode = node;
          showInspector();
        }
      }
      break;

    case 'bulldoze':
      // A building stands over whatever is under it, so it is tried first.
      if (buildings.bulldozeAt({ x: e.clientX - r.left, y: e.clientY - r.top })) break;
      // A pole is a thing standing in the world, so the tool whose job is
      // removing things has to be able to remove it. It is tried first: a
      // pole stands ON the footway of a road, so the road under it would
      // otherwise always win the click and the pole could never be hit.
      {
        const pole = doc.poleNear(world, poleReach());
        if (pole) {
          mutate(() => {
            doc.removePole(pole.id);
            return true;
          });
          flashHint('hint.pole.removed');
          break;
        }
      }
      if (anchor.kind === 'segment' && anchor.segment !== undefined) {
        const id = anchor.segment;
        mutate(() => {
          doc.removeSegment(id);
          doc.pruneOrphanNodes();
          return true;
        });
      }
      break;

    case 'upgrade':
      if (anchor.kind === 'segment' && anchor.segment !== undefined) {
        const id = anchor.segment;
        const seg = doc.segment(id);
        if (seg && seg.type < LAST_UPGRADE_CLASS) {
          mutate(() => {
            doc.setSegmentType(id, seg.type + 1);
            return true;
          });
        }
      }
      break;

    case 'control':
      if (anchor.kind === 'node' && anchor.node !== undefined) {
        cycleNodeControl(anchor.node, e.shiftKey ? -1 : 1);
      } else {
        flashHint('hint.control.miss');
      }
      break;

    case 'inspect':
      selectedSegment = anchor.kind === 'segment' ? (anchor.segment ?? null) : null;
      selectedSegmentS = anchor.kind === 'segment' ? (anchor.s ?? null) : null;
      selectedNode = anchor.kind === 'node' ? (anchor.node ?? null) : null;
      showInspector();
      break;
  }
  requestDraw();
});

window.addEventListener('blur', releaseHeld);
canvas.addEventListener('lostpointercapture', (e) => {
  // After an ordinary release the pointer is already gone from the map.
  if (pointers.has(e.pointerId)) releaseHeld();
});

canvas.addEventListener('pointermove', (e) => {
  // A mouse whose button is no longer down has ended its stroke, whether or
  // not the release reached us.
  if (e.pointerType === 'mouse' && e.buttons === 0 && terrainStroke) endTerrainStroke();
  const r = canvas.getBoundingClientRect();
  const screen: Vec2 = { x: e.clientX - r.left, y: e.clientY - r.top };
  if (tool === 'road') roadPointerScreen = screen;
  if (pointers.has(e.pointerId)) pointers.set(e.pointerId, screen);

  if (pinch && pointers.size >= 2) {
    const [a, b] = [...pointers.values()] as [Vec2, Vec2];
    const d = Math.hypot(a.x - b.x, a.y - b.y);
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const limits = view.zoomBounds;
    const targetZoom = clamp((pinch.zoom0 * d) / Math.max(1, pinch.d0), limits.min, limits.max);
    // A twist of the two fingers turns the camera with them; the pan below
    // then keeps the ground between the fingers where it was.
    const angle = Math.atan2(b.y - a.y, b.x - a.x);
    const twist = Math.atan2(Math.sin(angle - pinch.angle), Math.cos(angle - pinch.angle));
    pinch.angle = angle;
    if (d > 40) view.orbit(TWIST_SIGN * twist, 0);
    view.zoomAt(mid.x, mid.y, targetZoom / Math.max(0.001, view.zoom), surface.cssW, surface.cssH);
    view.panTo(pinch.world, mid.x, mid.y, surface.cssW, surface.cssH);
    requestDraw();
    return;
  }

  if (orbiting && orbiting.id === e.pointerId) {
    if (!orbiting.moved) {
      if (Math.hypot(screen.x - orbiting.pressed.x, screen.y - orbiting.pressed.y) < CLICK_SLOP) return;
      orbiting.moved = true;
    }
    const dx = screen.x - orbiting.last.x;
    const dy = screen.y - orbiting.last.y;
    orbiting.last = screen;
    // A turntable: the near side of the map follows the hand; dragging down
    // lifts the camera towards a plan view.
    view.orbit(dx * ORBIT_PER_PX, dy * ORBIT_PER_PX);
    persistence.saveSettingsSoon(sessionSettings);
    requestDraw();
    return;
  }

  if (panning && panning.id === e.pointerId) {
    if (panning.pressed && !panning.moved) {
      if (Math.hypot(screen.x - panning.pressed.x, screen.y - panning.pressed.y) < CLICK_SLOP) return;
      panning.moved = true;
    }
    view.panTo(panning.grabbed, screen.x, screen.y, surface.cssW, surface.cssH);
    requestDraw();
    return;
  }

  const world = pointerWorld(e);

  if (tool === 'road' && curvePending) {
    curvePending.control = world;
    requestDraw();
    return;
  }

  if (tool === 'building') {
    buildings.pointerMove(screen, world, e.shiftKey);
    return;
  }

  if (draft) {
    draft.snap = snapRoadEndpoint(doc, net, draft.start, world, view.zoom, draft.heightOffset);
    if (draft.samples.length < 256) draft.samples.push({ at: world, heightOffset: draft.heightOffset });
    requestDraw();
    return;
  }

  if (poleDraft) {
    poleDraft.to = world;
    requestDraw();
    return;
  }

  if (tool === 'pole' && poleChain) {
    // A chained run has no button held, so the preview has to follow the bare
    // pointer or the next stretch is aimed blind.
    requestDraw();
  }

  if (moving) {
    doc.moveNode(moving.node, world);
    requestDraw();
    return;
  }


  if (terrainStroke?.pointer === e.pointerId) {
    paintTerrain(world);
    return;
  }

  // The hover preview uses the same height-aware connection rule as the commit.
  const hovered = findAnchor(doc, net, world, view.zoom, undefined,
    tool === 'road' ? roadHeightOffset : undefined);
  if (tool === 'road' && roadChain) {
    chainPreview = {
      start: roadChain,
      startHeightOffset: roadChainHeight,
      chained: true,
      pressedAt: world,
      snap: snapRoadEndpoint(doc, net, roadChain, world, view.zoom, roadHeightOffset),
      samples: [{ at: roadChain.at, heightOffset: roadChainHeight }],
      heightOffset: roadHeightOffset,
    };
  }
  hoverAnchor = tool === 'terrain'
    ? { kind: 'free', at: world }
    : tool === 'road'
      ? anchorForHeight(hovered, roadHeightOffset)
      : hovered;
  requestDraw();
});

/**
 * Pick radius for a pole, in WORLD units at the current zoom.
 *
 * One definition, used by the snap, by the preview, by removal and by
 * bulldoze. When these were separate numbers the preview highlighted a pole
 * the commit then missed, which is the "does not attach to an existing line"
 * complaint: the run looked joined and was built disconnected.
 */
function poleReach(): number {
  return POLE_PICK_PIXELS / view.zoom;
}

/** What the current gesture would build, snapped. Drawn and committed alike. */
function currentPolePlan(): PoleRunPlan | null {
  if (poleDraft) return planPoleRun(doc, net, poleDraft.from, poleDraft.to, poleReach());
  if (tool === 'pole' && poleChain && hoverAnchor) {
    return planPoleRun(doc, net, poleChain, hoverAnchor.at, poleReach());
  }
  return null;
}

function commitRoadGesture(d: RoadDraft, chosenEnd?: Anchor): boolean {
  const endAnchor = chosenEnd ?? anchorForHeight(
    findAnchor(doc, net, d.snap.at, view.zoom, undefined, d.heightOffset), d.heightOffset);
  const end: Anchor = endAnchor.kind === 'free' ? { kind: 'free', at: d.snap.at } : endAnchor;
  const endHeightOffset = end.kind === 'free' ? d.heightOffset : anchorHeightOffset(end);
  const pieces = piecesForDraft(d, endHeightOffset);
  let result: ReturnType<typeof commitRoadPath> = { committed: false };
  mutate(() => {
    result = commitRoadPath(doc, net, d.start, end, roadTypeIndex, pieces, roadLanePreset);
    return result.committed;
  });
  if (!result.committed) {
    flashHint('hint.road.invalid');
    return false;
  }
  const finalHeight = result.finalHeightOffset ?? endHeightOffset;
  // Each completed placement ends the gesture. A new road begins only after
  // the player clicks a start again, including when that start is this node.
  roadChain = null;
  chainPreview = null;
  curvePending = null;
  roadChainHeight = finalHeight;
  roadHeightOffset = finalHeight;
  roadHeightEdited = false;
  updateRoadHeightValue();
  if (result.heightLimited) flashHint('hint.road.gradeLimited');
  return true;
}

function endPointer(e: PointerEvent): void {
  const cancelled = e.type === 'pointercancel';
  const wasPinching = pinch !== null;
  pointers.delete(e.pointerId);
  if (pointers.size < 2) pinch = null;
  if (panning?.id === e.pointerId) {
    const click = panning.cancelOnClick && !panning.moved;
    panning = null;
    if (click && !cancelled) {
      cancelGestures();
      return;
    }
  }
  if (orbiting?.id === e.pointerId) {
    const click = orbiting.cancelOnClick && !orbiting.moved;
    orbiting = null;
    if (click && !cancelled) {
      cancelGestures();
      return;
    }
  }
  if (terrainStroke?.pointer === e.pointerId) endTerrainStroke();
  if (tool === 'building') buildings.pointerUp(cancelled || wasPinching);

  if (draft) {
    const d = draft;
    draft = null;
    if (!cancelled && !wasPinching) {
      const traveled = d.samples.reduce((sum, sample, i) =>
        i === 0 ? 0 : sum + dist(sample.at, d.samples[i - 1]!.at), 0) +
        dist(d.samples[d.samples.length - 1]!.at, d.snap.at);
      const dragged = d.samples.slice(1).some((sample) =>
        dist(sample.at, d.pressedAt) > camera.px(7));
      if (!d.chained && traveled < camera.px(7)) {
        roadChain = d.start;
        roadChainHeight = d.startHeightOffset;
        requestDraw();
      } else if (d.chained && alignment === 'curve' && !dragged) {
        // A curve uses endpoint, then bend point. A drag still draws it at once.
        const anchor = anchorForHeight(
          findAnchor(doc, net, d.snap.at, view.zoom, undefined, d.heightOffset), d.heightOffset);
        const end = anchor.kind === 'free' ? { kind: 'free' as const, at: d.snap.at } : anchor;
        curvePending = {
          start: d.start,
          startHeightOffset: d.startHeightOffset,
          end,
          endHeightOffset: end.kind === 'free' ? d.heightOffset : anchorHeightOffset(end),
          control: { x: (d.start.at.x + end.at.x) / 2, y: (d.start.at.y + end.at.y) / 2 },
        };
        requestDraw();
      } else if (dist(d.start.at, d.snap.at) >= 1 || traveled >= 24) {
        commitRoadGesture(d);
      }
    }
  }

  if (poleDraft) {
    const run = poleDraft;
    const plan = planPoleRun(doc, net, run.from, run.to, poleReach());
    poleDraft = null;
    if (!cancelled && !wasPinching) {
      const last = plan.poles[plan.poles.length - 1];
      const built = mutateBuilt(() => commitPoleRun(doc, plan));
      // The line goes on from where it ended. A press that built nothing -
      // a click in place - starts the chain instead, so tracing a line is
      // click, click, click rather than a drag per stretch.
      if (built && last) poleChain = { x: last.at.x, y: last.at.y };
      else if (!run.chained) poleChain = { x: plan.from.at.x, y: plan.from.at.y };
      else poleChain = null;
    } else {
      poleChain = null;
    }
  }

  if (moving) {
    const m = moving;
    moving = null;
    // Record the move as one undo step, using the position it started from.
    const node = doc.node(m.node);
    if (node) {
      const now = { x: node.x, y: node.y };
      const changed = Math.hypot(now.x - m.origin.x, now.y - m.origin.y) > COARSE_EPS;
      // Back to the document as it was - curves included - then, if the drag
      // counts, one move from there to the drop point as one undo step.
      restoreSnapshot(doc, m.before, net);
      if (changed && !cancelled && !wasPinching) {
        // The drop is reconciled like a drawn road: onto a node it joins it,
        // across a road it makes a junction, and a drop that would leave a
        // stub or cross a road at the wrong height is refused.
        let refused: DraftResult['reason'] | undefined;
        mutate(() => {
          doc.moveNode(m.node, now);
          const result = reconcileMovedNode(doc, net, m.node);
          if (result.committed) return true;
          refused = result.reason;
          restoreSnapshot(doc, m.before, net);
          return false;
        });
        if (refused) flashHint(refused === 'clearance' ? 'hint.move.clearance' : 'hint.move.tooShort');
      } else if (sim.topologyRevision !== net.trafficRevision) {
        rebuildSimulationTopology();
      }
    }
  }
  persistence.saveSettingsSoon(sessionSettings);
  requestDraw();
}

canvas.addEventListener('pointerup', endPointer);
// Nothing to aim at off the map: no hover preview left behind on it.
canvas.addEventListener('pointerleave', () => {
  if (hoverAnchor) {
    hoverAnchor = null;
    requestDraw();
  }
});
canvas.addEventListener('pointercancel', endPointer);
canvas.addEventListener('contextmenu', (e) => e.preventDefault());

canvas.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault();
    // With the terrain tool up the wheel sizes the BRUSH, not the camera.
    // Reaching for a slider between every stroke is the single thing that made
    // sculpting tedious, and the camera is still one modifier away.
    if (tool === 'terrain' && !e.ctrlKey && !e.metaKey) {
      const notches = -Math.sign(e.deltaY);
      if (e.shiftKey) setTerrainStrength(terrainStrength + notches);
      else setTerrainRadius(terrainRadius + notches * 10);
      return;
    }
    const r = canvas.getBoundingClientRect();
    view.zoomAt(
      e.clientX - r.left,
      e.clientY - r.top,
      Math.exp(-e.deltaY * 0.0013),
      surface.cssW,
      surface.cssH,
    );
    persistence.saveSettingsSoon(sessionSettings);
    requestDraw();
  },
  { passive: false },
);

window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) return;
  const meta = e.ctrlKey || e.metaKey;

  // The building tool's own keys (R, +/-, Delete, Ctrl+C/V/D, 1-4) first.
  if (tool === 'building' && buildings.key(e)) {
    e.preventDefault();
    return;
  }

  if (!meta && tool === 'road' && (e.key === 'PageUp' || e.key === 'PageDown')) {
    e.preventDefault();
    stepRoadHeight(e.key === 'PageUp' ? 1 : -1);
    return;
  }

  if (!meta && tool === 'inspect' && selectedNode !== null &&
    doc.node(selectedNode)?.smooth && (e.key === 'PageUp' || e.key === 'PageDown')) {
    e.preventDefault();
    const current = doc.requireNode(selectedNode).heightOffset / UNITS_PER_METER;
    setNodeHeightMetres(selectedNode, current + (e.key === 'PageUp' ? 1 : -1));
    return;
  }

  // Turning the view is only offered where there is something to turn. The flat
  // viewport answers `rotate` with nothing rather than pretending.
  // Q/E turn the camera by 15 degrees, Shift by a quarter turn. Home (below,
  // with the arrows) puts it back where the game starts and frames the map.
  if (!meta && (e.key === 'q' || e.key === 'Q' || e.key === 'e' || e.key === 'E')) {
    const sign = e.key.toLowerCase() === 'q' ? -1 : 1;
    view.orbit(sign * (e.shiftKey ? Math.PI / 2 : KEY_TURN), 0);
    persistence.saveSettingsSoon(sessionSettings);
    requestDraw();
    return;
  }

  if (meta && e.key.toLowerCase() === 's') {
    e.preventDefault();
    (document.getElementById('saveMap') as HTMLButtonElement).click();
    return;
  }
  if (meta && e.key.toLowerCase() === 'o') {
    e.preventDefault();
    (document.getElementById('openMap') as HTMLButtonElement).click();
    return;
  }
  if (meta && e.key.toLowerCase() === 'd') {
    e.preventDefault();
    duplicateSelectedSegment();
    return;
  }

  if (meta && e.key.toLowerCase() === 'z' && !e.shiftKey) {
    e.preventDefault();
    undoButton.click();
    return;
  }
  if (meta && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) {
    e.preventDefault();
    redoButton.click();
    return;
  }

  // Delete removes what Inspect has picked: the road it shows.
  if (!meta && (e.key === 'Delete' || e.key === 'Backspace') && tool === 'inspect' && selectedSegment !== null) {
    e.preventDefault();
    const id = selectedSegment;
    (document.getElementById('closeInspector') as HTMLButtonElement).click();
    mutate(() => {
      doc.removeSegment(id);
      doc.pruneOrphanNodes();
      return true;
    });
    return;
  }

  // Space pauses and resumes, as in every simulation game. A button the
  // player reached with the keyboard keeps Space for itself; one merely
  // clicked with the mouse (and so still focused) must not swallow it.
  if (!meta && e.key === ' ') {
    const target = e.target as HTMLElement | null;
    if (target instanceof HTMLButtonElement && focusCameFromKeyboard()) return;
    e.preventDefault();
    target?.blur?.();
    trafficButton.click();
    return;
  }

  // While sculpting, the number row picks the OPERATION. The road palette is
  // hidden in that mode, so binding the digits to road classes there was a
  // shortcut to something the player cannot see.
  if (tool === 'terrain') {
    const modes: readonly TerrainMode[] = ['raise', 'lower', 'flatten', 'river'];
    const chosen = modes[Number(e.key) - 1];
    if (chosen) {
      setTerrainMode(chosen);
      return;
    }
    if (e.key === '[' || e.key === ']') {
      setTerrainRadius(terrainRadius + (e.key === ']' ? 10 : -10));
      return;
    }
    if (e.key === '-' || e.key === '_' || e.key === '=' || e.key === '+') {
      setTerrainStrength(terrainStrength + (e.key === '=' || e.key === '+' ? 1 : -1));
      return;
    }
  }

  const digit = Number(e.key);
  if (digit >= 1 && digit <= ROAD_TYPES.length) {
    // The class palette is shown only with the road tool, so choosing a class
    // from another tool also picks up the tool that draws it.
    if (tool !== 'road') setTool('road');
    selectRoadType(digit - 1);
    return;
  }

  // R is the building's rotation and nothing else; the road tool is the
  // number row, which also picks the class (above).
  const shortcuts: Record<string, Tool> = {
    u: 'upgrade',
    m: 'move',
    x: 'split',
    b: 'bulldoze',
    c: 'control',
    t: 'terrain',
    i: 'inspect',
    p: 'pole',
    h: 'building',
    k: 'person',
  };
  const next = shortcuts[e.key.toLowerCase()];
  if (next) setTool(next);
});

// -------------------------------------------------------------------- ui
const roadTypesEl = document.getElementById('roadTypes') as HTMLElement;

/** Every class, drawn: the tile shows the road the class lays. */
ROAD_TYPES.forEach((rt, i) => {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'road-type' + (i === roadTypeIndex ? ' active' : '');
  b.dataset['typeIndex'] = String(i);
  b.setAttribute('aria-pressed', String(i === roadTypeIndex));
  b.setAttribute('aria-label', `${roadTypeName(rt)}: ${roadTypeDescription(rt)}`);
  b.innerHTML = `<img class="road-type-art" src="${roadSwatch(rt)}" alt="" /><span class="road-type-name"></span>`;
  b.querySelector('.road-type-name')!.textContent = roadTypeName(rt);
  b.title = `${roadTypeName(rt)} — ${roadTypeDescription(rt)}`;
  b.onclick = () => selectRoadType(i);
  roadTypesEl.appendChild(b);
});

/**
 * What can be done to a road once it is drawn, at the end of the row of
 * classes: the same gesture a player makes, in the place they are looking.
 */
for (const [op, icon] of [
  ['upgrade', '<path d="M12 4v16M4 12h16"/><path d="m8 8 4-4 4 4"/>'],
  ['move', '<path d="M12 3v18M3 12h18"/><path d="m9 6 3-3 3 3m-6 12 3 3 3-3m3-9 3 3-3 3M6 9l-3 3 3 3"/>'],
  ['split', '<path d="M4 7h16M4 17h16"/><path d="M12 3v18"/><path d="m9 10 3 3 3-3"/>'],
  ['control', '<rect x="8" y="3" width="8" height="15" rx="2"/><path d="M12 18v3"/><circle cx="12" cy="7" r="1.4"/><circle cx="12" cy="10.6" r="1.4"/><circle cx="12" cy="14.2" r="1.4"/>'],
] as const) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'road-type road-op';
  b.dataset['roadOp'] = op;
  b.setAttribute('aria-pressed', 'false');
  b.setAttribute('aria-keyshortcuts', t(`tool.${op}`).charAt(0));
  b.innerHTML = `<span class="road-type-art op"><svg viewBox="0 0 24 24" aria-hidden="true">${icon}</svg></span><span class="road-type-name"></span>`;
  b.querySelector('.road-type-name')!.textContent = t(`tool.${op}`);
  b.title = t(`tool.${op}`);
  roadTypesEl.appendChild(b);
}

/**
 * The lanes a road is laid at. The count is stored per segment, so a street
 * can be four lanes wide while the avenue beside it is six; the last choice
 * is the class that carries a central reservation.
 */
let roadLanePreset: number | null = null;
const MEDIAN_CLASS = ROAD_TYPES.findIndex((rt) => rt.median > 0);
const roadLanesEl = document.getElementById('roadLanes') as HTMLElement;
const LANE_CHOICES: readonly { readonly id: string; readonly lanes: number | null }[] = [
  { id: '2', lanes: 2 },
  { id: '4', lanes: 4 },
  { id: '6', lanes: 6 },
  { id: 'median', lanes: null },
];
for (const choice of LANE_CHOICES) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'road-lane';
  b.dataset['laneChoice'] = choice.id;
  b.setAttribute('aria-pressed', 'false');
  const sample = choice.lanes === null
    ? roadType(MEDIAN_CLASS)
    : roadProfile(roadTypeIndex, choice.lanes);
  const laneLabel = choice.lanes === null ? t('palette.lanes.median') : t('palette.lanes.count', { count: choice.lanes });
  b.innerHTML = `<img src="${roadSwatch(sample, 74, 38)}" alt="" /><span></span>`;
  b.querySelector('span')!.textContent = laneLabel;
  b.title = laneLabel;
  b.onclick = () => {
    roadLanePreset = choice.lanes;
    if (choice.lanes === null) selectRoadType(MEDIAN_CLASS);
    updateLaneChoices();
    refreshLaneSwatches();
    requestDraw();
  };
  roadLanesEl.appendChild(b);
}

function updateLaneChoices(): void {
  for (const b of roadLanesEl.querySelectorAll<HTMLButtonElement>('.road-lane')) {
    const id = b.dataset['laneChoice'];
    const choice = LANE_CHOICES.find((c) => c.id === id);
    // With no count chosen, the class's own count is the one in hand: the row
    // says what the next road will actually be laid as.
    const on = choice !== undefined && (
      choice.lanes === null
        ? roadLanePreset === null && roadTypeIndex === MEDIAN_CLASS
        : roadTypeIndex !== MEDIAN_CLASS && choice.lanes === (roadLanePreset ?? roadType(roadTypeIndex).lanes)
    );
    b.classList.toggle('active', on);
    b.setAttribute('aria-pressed', String(on));
  }
}

/** The pictures redraw against the class in hand, so they read as its widths. */
function refreshLaneSwatches(): void {
  for (const b of roadLanesEl.querySelectorAll<HTMLButtonElement>('.road-lane')) {
    const choice = LANE_CHOICES.find((c) => c.id === b.dataset['laneChoice']);
    if (!choice) continue;
    const img = b.querySelector('img');
    if (!img) continue;
    const sample = choice.lanes === null ? roadType(MEDIAN_CLASS) : roadProfile(roadTypeIndex, choice.lanes);
    img.src = roadSwatch(sample, 74, 38);
    const label = b.querySelector('span');
    if (label) label.textContent = choice.lanes === null
      ? t('palette.lanes.median')
      : t('palette.lanes.count', { count: choice.lanes });
  }
}

/**
 * The classes roll past under the fixed plan. The arrows page the strip; when
 * every class already fits they fade out rather than disappear, so the row
 * never changes width under the pointer.
 */
const roadCarousel = roadTypesEl.parentElement as HTMLElement;
function updateCarousel(): void {
  const room = roadTypesEl.scrollWidth - roadTypesEl.clientWidth;
  roadCarousel.classList.toggle('scrollable', room > 1);
  roadCarousel.classList.toggle('at-start', roadTypesEl.scrollLeft <= 1);
  roadCarousel.classList.toggle('at-end', roadTypesEl.scrollLeft >= room - 1);
}
for (const step of document.querySelectorAll<HTMLButtonElement>('.carousel-step')) {
  step.onclick = () => {
    const page = Math.max(180, roadTypesEl.clientWidth * 0.75) * Number(step.dataset['carousel'] ?? 1);
    roadTypesEl.scrollBy({ left: page, behavior: 'smooth' });
  };
}
roadTypesEl.addEventListener('scroll', updateCarousel, { passive: true });
window.addEventListener('resize', updateCarousel);
updateCarousel();

/** Re-renders every label the road palette owns, after a language change. */
function refreshRoadTypeLabels(): void {
  for (const child of roadTypesEl.querySelectorAll<HTMLElement>('[data-type-index]')) {
    const rt = ROAD_TYPES[Number(child.dataset['typeIndex'])];
    if (!rt) continue;
    child.setAttribute('aria-label', `${roadTypeName(rt)}: ${roadTypeDescription(rt)}`);
    child.title = `${roadTypeName(rt)} — ${roadTypeDescription(rt)}`;
    const name = child.querySelector('.road-type-name');
    if (name) name.textContent = roadTypeName(rt);
  }
  for (const op of roadTypesEl.querySelectorAll<HTMLElement>('.road-op')) {
    const label = op.querySelector('.road-type-name');
    if (label && op.dataset['roadOp']) label.textContent = t(`tool.${op.dataset['roadOp']}`);
  }
  refreshLaneSwatches();
  updateLaneChoices();
}

function selectRoadType(i: number): void {
  roadTypeIndex = i;
  for (const child of roadTypesEl.querySelectorAll<HTMLElement>('[data-type-index]')) {
    const on = Number(child.dataset['typeIndex']) === i;
    child.classList.toggle('active', on);
    child.setAttribute('aria-pressed', String(on));
  }
  updateLaneChoices();
  refreshLaneSwatches();
  requestDraw();
}

function setAlignment(next: Alignment): void {
  alignment = next;
  if (next !== 'curve') curvePending = null;
  document.querySelectorAll<HTMLButtonElement>('.alignment-mode').forEach((button) => {
    const active = button.dataset['alignment'] === next;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
  updateHint();
  requestDraw();
}

document.querySelectorAll<HTMLButtonElement>('.alignment-mode').forEach((button) => {
  button.onclick = () => setAlignment((button.dataset['alignment'] as Alignment) ?? 'straight');
});

// The road's own operations, beside its classes: each one takes the pointer.
document.querySelectorAll<HTMLButtonElement>('.road-op').forEach((button) => {
  button.onclick = () => setTool((button.dataset['roadOp'] as Tool) ?? 'road');
});

function updateRoadHeightValue(): void {
  const value = document.getElementById('roadHeightValue');
  const context = document.getElementById('roadHeightContext');
  const stateKey = roadHeightOffset > 1e-6 ? 'palette.height.above'
    : roadHeightOffset < -1e-6 ? 'palette.height.below' : 'palette.height.ground';
  if (value) {
    const metres = roadHeightOffset / UNITS_PER_METER;
    value.textContent = `${Math.abs(metres - Math.round(metres)) < 1e-6
      ? Math.round(metres) : metres.toFixed(1)} m`;
  }
  if (context) {
    context.dataset['i18n'] = stateKey;
    context.textContent = t(stateKey);
  }
}

function stepRoadHeight(metres: number): void {
  roadHeightOffset += metres * UNITS_PER_METER;
  roadHeightEdited = true;
  const underPointer = roadPointerScreen
    ? worldAtScreen(roadPointerScreen.x, roadPointerScreen.y, roadHeightOffset)
    : null;
  if (draft) {
    draft.heightOffset = roadHeightOffset;
    const at = underPointer ?? draft.snap.at;
    draft.snap = snapRoadEndpoint(doc, net, draft.start, at, view.zoom, roadHeightOffset);
    draft.samples.push({ at, heightOffset: roadHeightOffset });
  }
  if (roadChain && !draft && !curvePending) {
    const at = underPointer ?? chainPreview?.snap.at ?? roadChain.at;
    chainPreview = {
      start: roadChain,
      startHeightOffset: roadChainHeight,
      chained: true,
      pressedAt: at,
      snap: snapRoadEndpoint(doc, net, roadChain, at, view.zoom, roadHeightOffset),
      samples: [{ at: roadChain.at, heightOffset: roadChainHeight }],
      heightOffset: roadHeightOffset,
    };
  }
  if (curvePending) {
    curvePending.end = anchorForHeight(curvePending.end, roadHeightOffset);
    curvePending.endHeightOffset = roadHeightOffset;
  }
  updateRoadHeightValue();
  requestDraw();
}

document.querySelectorAll<HTMLButtonElement>('.road-height-step').forEach((button) => {
  button.onclick = () => stepRoadHeight(Number(button.dataset['heightStep']));
});
updateRoadHeightValue();

const roadPalette = document.querySelector<HTMLElement>('.road-palette');
const terrainPalette = document.getElementById('terrainPalette') as HTMLElement;

function setTerrainMode(next: TerrainMode): void {
  terrainMode = next;
  document.querySelectorAll<HTMLButtonElement>('.terrain-mode').forEach((button) => {
    const active = button.dataset['terrainMode'] === next;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
  updateHint();
}

document.querySelectorAll<HTMLButtonElement>('.terrain-mode').forEach((button) => {
  button.onclick = () => setTerrainMode((button.dataset['terrainMode'] as TerrainMode) ?? 'raise');
});

const terrainRadiusInput = document.getElementById('terrainRadius') as HTMLInputElement;
const terrainStrengthInput = document.getElementById('terrainStrength') as HTMLInputElement;

/**
 * One writer for each brush number.
 *
 * The slider used to be the only way to set them, which meant every change of
 * brush size crossed the map to a panel and back. The wheel and the bracket
 * keys now go through the same function, so the slider, the readout and the
 * on-canvas ring can never disagree about the current brush.
 */
function setTerrainRadius(value: number): void {
  const min = Number(terrainRadiusInput.min);
  const max = Number(terrainRadiusInput.max);
  terrainRadius = clamp(Math.round(value), min, max);
  terrainRadiusInput.value = String(terrainRadius);
  text('terrainRadiusValue', String(terrainRadius));
  requestDraw();
}

function setTerrainStrength(value: number): void {
  const min = Number(terrainStrengthInput.min);
  const max = Number(terrainStrengthInput.max);
  terrainStrength = clamp(Math.round(value), min, max);
  terrainStrengthInput.value = String(terrainStrength);
  text('terrainStrengthValue', String(terrainStrength));
  requestDraw();
}

terrainRadiusInput.oninput = () => setTerrainRadius(Number(terrainRadiusInput.value));
terrainStrengthInput.oninput = () => setTerrainStrength(Number(terrainStrengthInput.value));
(document.getElementById('clearTerrain') as HTMLButtonElement).onclick = () => {
  if (!window.confirm(t('confirm.clearTerrain'))) return;
  history.record(doc);
  doc.clearTerrain();
  updateHistoryButtons();
  persistence.saveSessionSoon(doc, sessionSettings);
  requestDraw();
};

function setTool(next: Tool): void {
  cancelGestures();
  tool = next;
  // Improving a road, moving its points, splitting a segment and setting up a
  // junction are things done TO a road, so they are the road's own options and
  // its button stays lit while one of them is in hand.
  const roadFamily = next === 'road' || next === 'upgrade' || next === 'split'
    || next === 'control' || next === 'move';
  for (const b of document.querySelectorAll<HTMLButtonElement>('.tool')) {
    const on = b.dataset['tool'] === (roadFamily ? 'road' : next);
    b.classList.toggle('active', on);
    b.setAttribute('aria-pressed', String(on));
  }
  for (const b of document.querySelectorAll<HTMLButtonElement>('.road-op')) {
    const on = b.dataset['roadOp'] === next && next !== 'road';
    b.classList.toggle('active', on);
    b.setAttribute('aria-pressed', String(on));
  }
  if (next !== 'inspect') {
    selectedSegment = null;
    selectedNode = null;
    closeInspector();
  }
  canvas.dataset['tool'] = next;
  // Each palette is shown only with the tools it configures.
  const terrainActive = next === 'terrain';
  roadPalette?.classList.toggle('hidden', !roadFamily);
  roadPalette?.setAttribute('aria-hidden', String(!roadFamily));
  if (roadFamily) updateCarousel();
  terrainPalette.classList.toggle('hidden', !terrainActive);
  terrainPalette.setAttribute('aria-hidden', String(!terrainActive));
  // A tool with nothing to configure still fills its panel: with what it does
  // and every key it answers to. An empty shelf is a defect, not minimalism.
  renderToolHelp(roadFamily || terrainActive || next === 'building' || next === 'person' ? null : next);
  // The Person Creator fills the panel while it is the tool in hand.
  personCreator.root.hidden = next !== 'person';
  personCreator.stage.hidden = next !== 'person';
  if (next === 'person') personCreator.activate();
  else personCreator.deactivate();
  renderPanelTitle();
  // Buildings are a tool, not a mode: the game's own HUD stays up, and the
  // band's tray swaps to the Builder's categories while it is the tool in hand.
  const buildingActive = next === 'building';
  buildings.workspace.setMode(buildingActive ? 'builder' : 'road');
  if (buildingActive) buildings.activate();
  else buildings.deactivate();
  updateHint();
  requestDraw();
}

/** The Person Creator (`ui/creator/personCreator.ts`); its people are saved with the city. */
const personCreator = createPersonCreator({
  preview: (canvas) => createPersonPreview(canvas),
  people: () => doc.people,
  save: (person) => mutate(() => {
    doc.savePerson(person);
    return true;
  }),
  remove: (id) => mutate(() => {
    doc.removePerson(id);
    return true;
  }),
  nextId: () => doc.nextPersonId(),
});
personCreator.root.hidden = true;
personCreator.stage.hidden = true;
document.getElementById('app')?.appendChild(personCreator.stage);
let seenPeopleRevision = doc.peopleRevision;

/** The panel's help card, for the tools that have nothing else to show. */
const toolHelp = document.createElement('div');
toolHelp.className = 'tool-help';
toolHelp.hidden = true;
let toolHelpFor: Tool | null = null;
/** Every tool's card ends with the camera, which works the same in all of them. */
const CAMERA_KEYS = [
  ['help.key.middleDrag', 'help.do.orbit'],
  ['help.key.rightDrag', 'help.do.pan'],
  ['help.key.wheel', 'help.do.zoom'],
  ['help.key.qe', 'help.do.turn'],
  ['help.key.home', 'help.do.resetView'],
] as const;
const TOOL_KEYS: Partial<Record<Tool, readonly (readonly [string, string])[]>> = {
  bulldoze: [['help.key.click', 'help.do.remove'], ['help.key.undo', 'help.do.undo']],
  pole: [['help.key.click', 'help.do.pole'], ['help.key.shiftClick', 'help.do.removePole'], ['help.key.esc', 'help.do.endLine']],
  inspect: [['help.key.click', 'help.do.pick'], ['help.key.pageUpDown', 'help.do.nodeHeight'], ['help.key.esc', 'help.do.close']],
};
function renderToolHelp(forTool: Tool | null): void {
  toolHelpFor = forTool;
  toolHelp.hidden = forTool === null;
  toolHelp.replaceChildren();
  if (forTool === null) return;
  const what = document.createElement('p');
  what.className = 'tool-help-what';
  what.textContent = t(`help.tool.${forTool}`);
  const list = document.createElement('dl');
  list.className = 'tool-help-keys';
  const section = (key: string): void => {
    const h = document.createElement('div');
    h.className = 'tool-help-section';
    h.textContent = t(key);
    list.appendChild(h);
  };
  const row = ([key, action]: readonly [string, string]): void => {
    const dt = document.createElement('dt');
    const kbd = document.createElement('kbd');
    kbd.textContent = t(key);
    dt.appendChild(kbd);
    const dd = document.createElement('dd');
    dd.textContent = t(action);
    list.append(dt, dd);
  };
  section('help.section.tool');
  (TOOL_KEYS[forTool] ?? []).forEach(row);
  section('help.section.camera');
  CAMERA_KEYS.forEach(row);
  toolHelp.append(what, list);
}
/** The name over the panel: the tool in hand, or the road's own option. */
function renderPanelTitle(): void {
  buildings.workspace.hosts.title.textContent = t(`tool.${tool}`);
}

/**
 * ONE chrome for the whole game.
 *
 * The toolbar, the palettes, the simulation panel and the app menu are the
 * game's own elements - their handlers are wired above - moved into the
 * container's hosts, so there is one place to look for anything and nothing
 * floats over the map. The chrome is up in both modes; `setMode` decides which
 * half fills the container's tiers.
 */
function mountUnifiedChrome(): void {
  const hosts = buildings.workspace.hosts;
  const move = (element: Element | null, host: HTMLElement): void => {
    if (element) host.appendChild(element);
  };
  move(document.querySelector('.toolbar'), hosts.level1);
  move(document.querySelector('.road-palette'), hosts.level2);
  move(document.getElementById('terrainPalette'), hosts.level2);
  // What Inspect picked is shown in the panel, where the tool's card is: the
  // right-hand column belongs to the camera and the minimap.
  move(document.getElementById('inspector'), hosts.level2);
  move(toolHelp, hosts.level2);
  move(personCreator.root, hosts.level2);
  renderToolHelp(toolHelpFor);
  renderPanelTitle();
  move(document.querySelector('.simulation-controls'), hosts.simMenu);
  move(document.getElementById('topMenu'), hosts.appMenu);
  // Pausing is a speed, and every speed is inside the simulation menu: the
  // bar keeps only the camera. The button itself stays wired to the spacebar.
  move(document.getElementById('resetView'), hosts.controls);
  // The hint bar is the band's foot line now: floating over the map it landed
  // on the panel's own last row and the two sentences drew over each other.
  move(document.getElementById('hint'), hosts.hint);
  move(document.getElementById('mobileHint'), hosts.hint);
  document.getElementById('app')?.classList.add('bw-hide-legacy');
  // The panel starts in the mode of the tool in hand: at boot nothing had set
  // it, and the Builder's chips stood at the foot of the road panel.
  setTool(tool);
}
// Mounted after this module has finished evaluating: moving the toolbar and
// the panels is a layout change, and a pointer already over the canvas can fire
// a move event mid-evaluation - before the run loop's own state exists.
setTimeout(mountUnifiedChrome, 0);

document.querySelectorAll<HTMLButtonElement>('.tool').forEach((b) => {
  b.addEventListener('click', () => setTool((b.dataset['tool'] as Tool) ?? 'road'));
});
/** "Road (R)": each tool's name and key, as its tooltip - the only label a compact rail shows. */
function labelTools(): void {
  for (const b of document.querySelectorAll<HTMLButtonElement>('.tool')) {
    const name = t(`tool.${b.dataset['tool'] ?? 'road'}`);
    b.title = b.dataset['key'] ? `${name} (${b.dataset['key']})` : name;
  }
}
labelTools();

const trafficButton = document.getElementById('trafficToggle') as HTMLButtonElement;
function setPaused(paused: boolean): void {
  traffic = !paused;
  sim.clock.paused = paused;
  trafficButton.classList.toggle('active', traffic);
  trafficButton.setAttribute('aria-pressed', String(traffic));
  last = performance.now();
  persistence.saveSettingsSoon(sessionSettings);
  requestDraw();
}
// Through `setSpeed`, so the speed buttons show "Pause" pressed as well; going
// straight to `setPaused` left "1×" lit on a paused simulation.
trafficButton.onclick = () => setSpeed(traffic ? 0 : sim.clock.speed);

function setSpeed(speed: number): void {
  if (speed <= 0) setPaused(true);
  else {
    sim.clock.speed = speed;
    setPaused(false);
  }
  document.querySelectorAll<HTMLButtonElement>('[data-speed]').forEach((button) => {
    const active = Number(button.dataset['speed']) === (sim.clock.paused ? 0 : sim.clock.speed);
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
}

document.querySelectorAll<HTMLButtonElement>('[data-speed]').forEach((button) => {
  button.onclick = () => setSpeed(Number(button.dataset['speed']));
});

const trafficIntensity = document.getElementById('trafficIntensity') as HTMLInputElement;
const pedIntensity = document.getElementById('pedIntensity') as HTMLInputElement;
trafficIntensity.value = String(Math.round(sim.trafficIntensity * 100));
pedIntensity.value = String(Math.round(sim.pedestrianIntensity * 100));
function bindIntensity(input: HTMLInputElement, outputId: string, assign: (value: number) => void): void {
  const update = () => {
    const value = Number(input.value) / 100;
    assign(value);
    text(outputId, `${input.value}%`);
    persistence.saveSettingsSoon(sessionSettings);
  };
  input.oninput = update;
  update();
}
bindIntensity(trafficIntensity, 'trafficIntensityValue', (value) => { sim.trafficIntensity = value; });
bindIntensity(pedIntensity, 'pedIntensityValue', (value) => { sim.pedestrianIntensity = value; });
const demandLevel = document.getElementById('demandLevel') as HTMLSelectElement;
demandLevel.value = String(sim.demandMultiplier);
demandLevel.onchange = () => {
  sim.demandMultiplier = Number(demandLevel.value);
  persistence.saveSettingsSoon(sessionSettings);
};
document.querySelectorAll<HTMLButtonElement>('[data-speed]').forEach((button) => {
  const active = Number(button.dataset['speed']) === (sim.clock.paused ? 0 : sim.clock.speed);
  button.classList.toggle('active', active);
  button.setAttribute('aria-pressed', String(active));
});

const congestionButton = document.getElementById('congestionToggle') as HTMLButtonElement;
congestionButton.onclick = () => {
  congestionOverlay = !congestionOverlay;
  congestionButton.classList.toggle('active', congestionOverlay);
  congestionButton.setAttribute('aria-pressed', String(congestionOverlay));
  persistence.saveSettingsSoon(sessionSettings);
  requestDraw();
};
congestionButton.classList.toggle('active', congestionOverlay);
congestionButton.setAttribute('aria-pressed', String(congestionOverlay));
initChrome(requestDraw);
mountBuildStamp(document.getElementById('buildStamp'));
mountAbout();

(document.getElementById('newMap') as HTMLButtonElement).onclick = () => {
  if (!window.confirm(t('confirm.newMap'))) return;
  // Discarding the whole map is the largest edit the editor can make, so it is
  // the one that most needs to be undoable. Opening a file already records;
  // this did not, which left Ctrl+Z unable to recover a map cleared by mistake.
  history.record(doc);
  // A new map is empty.
  applySnapshot(new RoadDoc().toJSON(), 'import');
  roadHeightOffset = 0;
  roadHeightEdited = false;
  updateRoadHeightValue();
  fitView();
  flashHint('hint.newMap');
};
(document.getElementById('saveMap') as HTMLButtonElement).onclick = () => {
  exportToFile(doc, sessionSettings());
  flashHint('hint.saved');
};
/**
 * Loads a picked map. The undo entry is recorded only once the map has
 * actually loaded: recording first left a bogus step (and cleared redo) when
 * the file then failed.
 */
function openImported(result: ImportResult): boolean {
  if (result.status === 'cancelled') return false;
  if (result.status === 'invalid') {
    flashHint('hint.openFailed');
    return false;
  }
  const before = doc.toJSON();
  try {
    applySnapshot(result.session.document, 'import');
  } catch (error) {
    console.error('The map could not be loaded.', error);
    applySnapshot(before);
    flashHint('hint.openFailed');
    return false;
  }
  history.record(RoadDoc.fromJSON(before, { repair: false }));
  updateHistoryButtons();
  restoreSettings(result.session.settings);
  flashHint('hint.opened');
  return true;
}
(document.getElementById('openMap') as HTMLButtonElement).onclick = async () => {
  openImported(await importFromFile());
};

// The camera's own buttons: a step per press, and the needle keeps north.
const cameraNeedle = document.querySelector<SVGElement>('#cameraControls .camera-needle');
const TILT_STEP = Math.PI / 18;
for (const button of document.querySelectorAll<HTMLButtonElement>('#cameraControls [data-camera]')) {
  button.addEventListener('click', () => {
    switch (button.dataset['camera']) {
      case 'turnLeft': view.orbit(-KEY_TURN, 0); break;
      case 'turnRight': view.orbit(KEY_TURN, 0); break;
      case 'tiltUp': view.orbit(0, TILT_STEP); break;
      case 'tiltDown': view.orbit(0, -TILT_STEP); break;
      case 'north': view.setOrbit(DEFAULT_AZIMUTH, DEFAULT_ELEVATION); break;
    }
    persistence.saveSettingsSoon(sessionSettings);
    requestDraw();
  });
}
// A flat view has nothing to turn or tilt.
if (view.kind === '2d') (document.getElementById('cameraControls') as HTMLElement).style.display = 'none';
let needleAngle = NaN;
/** Points the needle where north lies on screen. */
function updateCameraNeedle(): void {
  if (!cameraNeedle) return;
  const { cssW: w, cssH: h } = surface;
  const c = view.centre;
  const a = view.toScreen(c, w, h);
  // North is +Y (`lanelets.ts`, `classifyTurn`): up the map.
  const b = view.toScreen({ x: c.x, y: c.y + 10 }, w, h);
  const angle = Math.round((Math.atan2(b.x - a.x, a.y - b.y) * 180) / Math.PI);
  if (angle === needleAngle) return;
  needleAngle = angle;
  cameraNeedle.style.transform = `rotate(${angle}deg)`;
}

(document.getElementById('resetView') as HTMLButtonElement).onclick = () => {
  view.setOrbit(DEFAULT_AZIMUTH, DEFAULT_ELEVATION);
  fitView();
  persistence.saveSettingsSoon(sessionSettings);
  requestDraw();
};

const undoButton = document.getElementById('undoAction') as HTMLButtonElement;
const redoButton = document.getElementById('redoAction') as HTMLButtonElement;
// An undo can change something far off screen, so the hint bar says it
// happened; Ctrl+Z and Ctrl+Y go through these buttons too.
undoButton.onclick = () => {
  // A drag or stroke in progress ends first: undoing mid-drag used to go on
  // moving a node of the restored map, and record the half-done state as redo.
  cancelGestures();
  const snapshot = history.undo(doc);
  applySnapshot(snapshot);
  if (snapshot) flashHint('hint.undone');
};
redoButton.onclick = () => {
  cancelGestures();
  const snapshot = history.redo(doc);
  applySnapshot(snapshot);
  if (snapshot) flashHint('hint.redone');
};

function updateHistoryButtons(): void {
  undoButton.disabled = !history.canUndo;
  redoButton.disabled = !history.canRedo;
  buildings.workspace.setHistory(history.canUndo, history.canRedo);
}

/** Restores the user-visible state stored beside a map without touching topology. */
function restoreSettings(settings: SavedSettings): void {
  camera.x = settings.camera.x;
  camera.y = settings.camera.y;
  // Same rule as boot, asked of the live viewport this time.
  const limits = view.zoomBounds;
  camera.zoom = clamp(settings.camera.zoom, limits.min, limits.max);
  syncViewFromFlatCamera();
  restoreOrbit(settings.camera);
  sim.clock.speed = settings.speed;
  setPaused(settings.paused);
  trafficIntensity.value = String(Math.round(settings.trafficIntensity * 100));
  pedIntensity.value = String(Math.round(settings.pedestrianIntensity * 100));
  sim.trafficIntensity = settings.trafficIntensity;
  sim.pedestrianIntensity = settings.pedestrianIntensity;
  sim.demandMultiplier = settings.demandMultiplier ?? 1;
  demandLevel.value = String(sim.demandMultiplier);
  text('trafficIntensityValue', `${trafficIntensity.value}%`);
  text('pedIntensityValue', `${pedIntensity.value}%`);
  congestionOverlay = settings.congestionOverlay;
  congestionButton.classList.toggle('active', congestionOverlay);
  congestionButton.setAttribute('aria-pressed', String(congestionOverlay));
  document.querySelectorAll<HTMLButtonElement>('[data-speed]').forEach((button) => {
    const active = Number(button.dataset['speed']) === (sim.clock.paused ? 0 : sim.clock.speed);
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
  persistence.saveSettingsSoon(sessionSettings);
  requestDraw();
}
updateHistoryButtons();

(document.getElementById('closeInspector') as HTMLButtonElement).onclick = () => {
  selectedSegment = null;
  selectedNode = null;
  closeInspector();
  requestDraw();
};

/**
 * Junction control, as a tool rather than as a form field.
 *
 * A player asked for signals to be OPTIONAL at a crossing, which they already
 * were — the setting lived in the inspector, three clicks away behind a select
 * nobody opens. Making it a tool is the difference between a setting and a
 * decision you can take while looking at the junction. The inspector's select
 * stays: it names the modes, which a cycling tool cannot.
 *
 * The order is the one a player reasons in, from "leave it to the game" through
 * the increasingly permissive real devices to nothing at all. Shift walks it
 * backwards, because the mode you want is as often the previous one as the next.
 */
const CONTROL_CYCLE: readonly JunctionControl[] = [
  'auto',
  'signal',
  'priority',
  'stop',
  'yield',
  'none',
];

function cycleNodeControl(id: NodeId, direction: 1 | -1): void {
  const node = doc.node(id);
  if (!node) return;
  // A node with fewer than three legs is not a junction: it is a kerb line or a
  // change of class, and no control device belongs there. Saying so is better
  // than silently cycling a setting that will never be read.
  if (node.incident.length < 3) {
    flashHint('hint.control.notJunction');
    return;
  }
  const at = CONTROL_CYCLE.indexOf(node.control);
  const next = CONTROL_CYCLE[
    ((at < 0 ? 0 : at) + direction + CONTROL_CYCLE.length) % CONTROL_CYCLE.length
  ] as JunctionControl;
  mutate(() => {
    doc.setNodeControl(id, next);
    return true;
  });
  selectedNode = id;
  selectedSegment = null;
  flashHint(`control.${next}`);
}

/**
 * A transient message in the hint bar.
 *
 * It reuses the hint rather than adding a toast, because the player's eyes are
 * already there and a second floating panel over an isometric map costs more
 * than it tells. `updateHint` restores the tool's own wording, so the timer
 * never has to remember what was displaced.
 */
let hintFlash: ReturnType<typeof setTimeout> | null = null;
function flashHint(key: string, params?: Readonly<Record<string, string | number>>): void {
  // Both bars: on a phone only the touch hint is visible, and it used to miss
  // every one of these answers.
  const hints = ['hint', 'mobileHint']
    .map((id) => document.getElementById(id))
    .filter((el): el is HTMLElement => el !== null);
  for (const hint of hints) {
    hint.textContent = t(key, params);
    delete hint.dataset['i18n'];
    hint.classList.add('flash');
  }
  if (hintFlash !== null) clearTimeout(hintFlash);
  hintFlash = setTimeout(() => {
    hintFlash = null;
    for (const hint of hints) hint.classList.remove('flash');
    updateHint();
  }, 1600);
}

/**
 * The hint bar, in both the desktop and the touch wording.
 *
 * The key is derived from the tool and its current mode rather than chosen from
 * a table of sentences, so adding a language is a dictionary entry and adding a
 * tool is one key in each dictionary.
 */
function hintKey(prefix: string): string {
  if (tool === 'road' && alignment === 'curve') return `${prefix}.road.curve`;
  if (tool === 'road' && alignment === 'free') return `${prefix}.road.free`;
  // Each sculpting operation gets its own sentence. Four modes behind one hint
  // meant the bar told the player nothing about the one they had selected.
  if (tool === 'terrain') return `${prefix}.terrain.${terrainMode}`;
  if (tool === 'building') return buildings.hintKey(prefix);
  return `${prefix}.${tool}`;
}

function updateHint(): void {
  const hint = document.getElementById('hint');
  const mobileHint = document.getElementById('mobileHint');
  if (hint) {
    const key = hintKey('hint');
    hint.dataset['i18n'] = key;
    hint.textContent = t(key);
  }
  if (mobileHint) {
    // A tool without touch wording of its own falls back to the desktop
    // sentence. The Builder has none, and the bar (and every screen reader,
    // through the canvas's aria-describedby) used to read the raw key.
    const touch = hintKey('hint.mobile');
    const key = hasKey(touch) ? touch : hintKey('hint');
    mobileHint.dataset['i18n'] = key;
    mobileHint.textContent = t(key);
  }
}
updateHint();
if (bootFailed) flashHint('hint.bootFailed');

// ------------------------------------------------------------- minimap
minimapCanvas.addEventListener('pointerdown', (e) => {
  minimapCanvas.setPointerCapture(e.pointerId);
  const p = minimapToWorld(minimapCanvas, doc, camera, e.clientX, e.clientY);
  if (p) {
    // Through the seam: writing the flat camera moves nothing under the 3D (three.js) viewport.
    view.moveTo(p);
    requestDraw();
  }
});
minimapCanvas.addEventListener('pointermove', (e) => {
  if (e.buttons === 0) return;
  const p = minimapToWorld(minimapCanvas, doc, camera, e.clientX, e.clientY);
  if (p) {
    // Through the seam: writing the flat camera moves nothing under the 3D (three.js) viewport.
    view.moveTo(p);
    requestDraw();
  }
});

/**
 * Arrow-key panning, through the seam and bound to the WINDOW.
 *
 * It used to be bound to the minimap's own `keydown`, so it did nothing unless
 * the player had first clicked the minimap — while the on-screen hint told them
 * the arrows move the camera. And it wrote the flat camera's `x`/`y`, which the
 * isometric renderer never reads, so even with the minimap focused it moved
 * nothing at all.
 */
const arrowPan = (e: KeyboardEvent): void => {
  const target = e.target as HTMLElement | null;
  if (target && (target.tagName === 'INPUT' || target.tagName === 'SELECT')) return;
  // Escape ends whatever is being drawn. A pole line is traced in stretches,
  // so there has to be a way to say "that is the end of this line" without
  // switching tool and back.
  if (e.key === 'Escape') {
    if (gestureInProgress()) {
      cancelGestures();
      e.preventDefault();
    } else if (selectedSegment !== null || selectedNode !== null) {
      // With nothing being drawn, Escape puts down what Inspect picked up.
      (document.getElementById('closeInspector') as HTMLButtonElement).click();
      e.preventDefault();
    }
    return;
  }
  // Along the SCREEN's axes: with the camera turned, "up" is wherever the
  // camera faces, not the map's north.
  const step = e.shiftKey ? 120 : 40;
  const { cssW: w, cssH: h } = surface;
  const along = (dx: number, dy: number): void => view.moveTo(view.toWorld(w / 2 + dx, h / 2 + dy, w, h));
  // W A S D as well as the arrows, as in every city builder; never with
  // Ctrl or Alt (Ctrl+S saves, Ctrl+D duplicates).
  const key = e.ctrlKey || e.metaKey || e.altKey ? '' : e.key.toLowerCase();
  if (e.key === 'ArrowLeft' || key === 'a') along(-step, 0);
  else if (e.key === 'ArrowRight' || key === 'd') along(step, 0);
  else if (e.key === 'ArrowUp' || key === 'w') along(0, -step);
  else if (e.key === 'ArrowDown' || key === 's') along(0, step);
  else if (e.key === 'Home') {
    view.setOrbit(DEFAULT_AZIMUTH, DEFAULT_ELEVATION);
    fitView();
  } else return;
  e.preventDefault();
  requestDraw();
};
window.addEventListener('keydown', arrowPan);

// ------------------------------------------------------------- run loop
let last = performance.now();
let pending = false;
// Seeded ABOVE their thresholds so the first frame refreshes both. The loop
// stops once nothing is moving — a paused map with no traffic ends it after one
// or two frames — and the status bar and minimap are only refreshed from inside
// that loop. Starting at zero meant a paused map kept the initial HTML readout
// for ever: measured on an all-combinations test map of 32 roads and 47 nodes,
// the status bar read "0 roads · 0 nodes" while the roads were plainly drawn,
// the minimap stayed blank.
let uiClock = 0.4;
let minimapClock = 0.1;
let lastMovePreviewRebuild = -Infinity;
/**
 * Shortest interval between geometry rebuilds while a node is being dragged.
 *
 * A preview at 20 Hz is far smoother than the eye needs for a drag, and it
 * avoids rebuilding routes, signals and spatial indexes for pointer samples that
 * will be superseded immediately.
 */
const MOVE_PREVIEW_MIN_MS = 50;
/**
 * The cap is a floor, not the whole rule: on a large network one rebuild costs
 * far more than 50 ms, and asking for another one every 50 ms simply queues
 * them until the pointer stops. The interval is therefore taken from what the
 * last rebuild ACTUALLY cost, so the preview stays responsive on a small map
 * and degrades to a slower preview on a big one instead of locking up.
 */
function movePreviewInterval(): number {
  return Math.max(MOVE_PREVIEW_MIN_MS, scene.stats.rebuildMs * 1.6);
}

/**
 * Set by an edit: draw the new geometry first, rebuild the simulation after.
 *
 * Both are rebuilt from scratch and both block the page. `mutate` used to
 * rebuild the simulation's topology inside the pointer event, and the scene
 * was rebuilt in the frame after it, so a drawn road stayed a draft line on
 * screen for the SUM of the two — measured on a 144-segment map, 2.0 s of
 * topology and then 1.7 s of meshes before anything changed. The frame that
 * draws the edit now holds the simulation still, as a node drag already does,
 * and the next one brings its topology up to date: the road appears after the
 * mesh rebuild alone, and the traffic pauses for the topology afterwards.
 */
let topologyAfterDraw = false;

function requestDraw(): void {
  if (pending) return;
  pending = true;
  requestAnimationFrame(frame);
}

function frame(now: number): void {
  pending = false;
  const wall = (now - last) / 1000;
  last = now;

  // Moving a node is an authoring preview. Freeze simulation time until the
  // gesture finishes so agents never rebuild against every intermediate shape.
  // The frame that first draws an edit is held the same way.
  let holdSim = moving || topologyAfterDraw;
  if (!holdSim && sim.topologyRevision !== net.trafficRevision) {
    // In two frames, vehicles then footways, each drawn in between: the two
    // together were one stall of up to 240 ms after every edit. The world is
    // held until both are done.
    if (sim.vehicleTopologyRevision !== net.trafficRevision) {
      sim.rebuildVehicleTopology();
      rebindVehicles(sim);
      holdSim = true;
      requestDraw();
    } else {
      sim.rebuildWalkTopology();
      rebindPeds(sim);
    }
  }
  const alpha = holdSim
    ? 1
    : sim.clock.advance(wall, () => step(sim, { traffic, pedestrians: traffic }));

  if (net.revision !== doc.revision) {
    // Geometry is still refreshed during a drag, but a 20 Hz preview is more
    // than smooth enough and avoids repeatedly rebuilding routes, signals and
    // spatial indexes for pointer samples that will be superseded immediately.
    if (!moving || now - lastMovePreviewRebuild >= movePreviewInterval()) {
      net.rebuild();
      if (moving) lastMovePreviewRebuild = now;
      else if (sim.topologyRevision !== net.trafficRevision) rebuildSimulationTopology();
    }
  }
  buildings.beforeDraw(tool === 'building');
  scene.draw(net, sim, alpha, wall, { holdRoads: terrainStroke !== null });
  drawOverlayScreen();
  updateCameraNeedle();
  // Undo, redo or a loaded map can change the saved people under the Creator.
  if (doc.peopleRevision !== seenPeopleRevision) {
    seenPeopleRevision = doc.peopleRevision;
    personCreator.refresh();
  }
  if (topologyAfterDraw) {
    topologyAfterDraw = false;
    requestDraw();
  }

  // TEN TIMES A SECOND, AND NO FASTER — panning included.
  //
  // `drawMinimap` walks every lanelet in the simulation and every ribbon in the
  // network on each call, and the clause that used to sit here forced it to run
  // on EVERY FRAME while panning, pinching, drafting or dragging a node. So the
  // one moment the main canvas most needs the frame budget — the camera moving
  // under the user's hand — was the moment a full sweep of the map was billed
  // to it as well, and the bigger the map the worse it got. That is the stall
  // felt on pan and zoom.
  //
  // A 194-by-124 overview does not need sixty updates a second. The clock alone
  // now decides, so the cost is bounded no matter what the pointer is doing.
  minimapClock += wall;
  if (minimapClock >= 0.1) {
    minimapClock = 0;
    syncFlatCameraFromView();
    drawMinimap(minimapCanvas, doc, net, sim, camera, surface, viewFootprint());
  }

  uiClock += wall;
  if (uiClock > 0.4) {
    uiClock = 0;
    updateStatus();
    // Safe while the player is using the panel: an unchanged selection only
    // rewrites the statistics block, never the control under the pointer.
    refreshInspector();
  }

  // Keep animating while anything is moving; otherwise settle.
  if (!document.hidden && (traffic || draft || moving || panning || orbiting || pinch)) requestDraw();
}

/**
 * The same hints as `drawOverlay`, projected instead of transformed.
 *
 * Under the isometric renderer there is no canvas transform that maps world to
 * screen, so every point goes through `view.toScreen` and everything is stroked
 * in CSS pixels. Widths are pixels here for the same reason: a hairline must
 * stay a hairline at any zoom, and there is no uniform scale left to divide by.
 *
 * The flat canvas sits above the 3D one and is cleared to full transparency
 * every frame, so it contributes only these strokes.
 */
/**
 * Draws a planned pole run onto the overlay.
 *
 * Taken out of `drawOverlayScreen` because it is the only part of that
 * function that has a model behind it, and because the preview and the commit
 * now share one plan - keeping the drawing beside the rest of the hairlines
 * hid that.
 */
function drawPolePlan(
  plan: PoleRunPlan | null,
  ctx: CanvasRenderingContext2D,
  at: (p: Vec2) => Vec2,
  w: number,
  h: number,
): void {
  if (!plan || plan.poles.length === 0) return;

  ctx.save();
  ctx.lineWidth = 1.5;
  ctx.lineJoin = 'round';

  // Crown of each mast, in screen space, so the wires can be strung between
  // the tops rather than along the ground.
  const feet = plan.poles.map((pole) => at(pole.at));
  const crowns = plan.poles.map((pole) =>
    view.toScreen(pole.at, w, h, sceneHeightAt(pole.at) + POLE_HEIGHT),
  );

  // The wire, sagging, between consecutive crowns. Drawn first so the masts
  // read in front of it.
  ctx.strokeStyle = SELECTION;
  ctx.globalAlpha = 0.65;
  ctx.beginPath();
  for (let i = 1; i < crowns.length; i++) {
    const a = crowns[i - 1] as Vec2;
    const b = crowns[i] as Vec2;
    const span = dist(plan.poles[i - 1]!.at, plan.poles[i]!.at);
    // The same sag the built wire will have, projected: the screen is a
    // linear map of the world here, so a drop in world units below the chord
    // is that drop times the vertical scale of one world unit.
    const drop = spanSag(span) * Math.abs(crowns[i]!.y - feet[i]!.y) / Math.max(1, POLE_HEIGHT);
    ctx.moveTo(a.x, a.y);
    ctx.quadraticCurveTo((a.x + b.x) / 2, (a.y + b.y) / 2 + drop * 2, b.x, b.y);
  }
  ctx.stroke();
  ctx.globalAlpha = 1;

  // The masts: a vertical stroke from the ground to the crown, and a short
  // cross-arm at the top, which is what makes a preview of a pole look like a
  // pole rather than like a tick on a line.
  plan.poles.forEach((pole, index) => {
    const foot = feet[index] as Vec2;
    const crown = crowns[index] as Vec2;
    // An existing pole is shown in the hover colour and a new one in the
    // build colour, so "this run will join that line" is visible before the
    // button is released - the single thing missing when a run silently
    // failed to attach.
    ctx.strokeStyle = pole.existing !== null ? HOVER : SELECTION;
    ctx.beginPath();
    ctx.moveTo(foot.x, foot.y);
    ctx.lineTo(crown.x, crown.y);
    ctx.stroke();

    const arm = Math.max(4, Math.abs(crown.y - foot.y) * 0.16);
    ctx.beginPath();
    ctx.moveTo(crown.x - arm, crown.y + arm * 0.2);
    ctx.lineTo(crown.x + arm, crown.y - arm * 0.2);
    ctx.stroke();

    if (pole.existing !== null) {
      ctx.beginPath();
      ctx.arc(foot.x, foot.y, 7, 0, Math.PI * 2);
      ctx.stroke();
    }
  });

  ctx.restore();
}

function drawOverlayScreen(): void {
  const w = overlayCanvas.clientWidth;
  const h = overlayCanvas.clientHeight;
  const ctx = overlayCtx;
  if (!ctx || w === 0 || h === 0) return;

  const dpr = window.devicePixelRatio || 1;
  if (
    overlayCanvas.width !== Math.round(w * dpr) ||
    overlayCanvas.height !== Math.round(h * dpr)
  ) {
    overlayCanvas.width = Math.round(w * dpr);
    overlayCanvas.height = Math.round(h * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  // Project at the height of whatever is UNDER the point, not at zero.
  //
  // A tilted view puts a raised deck well away from the ground directly below
  // it, so a draft line or a snap ring drawn on the ground plane floated off
  // the viaduct it belonged to — the on-screen feedback disagreed with what the
  // editor was about to build.
  const at = (p: Vec2): Vec2 => view.toScreen(p, w, h, sceneHeightAt(p));

  // The pole run being drawn.
  //
  // What was here before was a dashed line ON THE GROUND with a small ring at
  // each pole, and it was useless for the one thing a preview has to do: a
  // pole is nine metres of vertical mast, and a ground line says nothing
  // about where the masts, the arms or the wires will be. It also disagreed
  // with the commit, because it drew the RAW drag while the commit snapped.
  //
  // This draws the plan: every mast at its real height, the wire that will
  // hang between them with its real sag, and a ring round any pole the run is
  // about to tie into. If it looks right here it is right when built.
  drawPolePlan(currentPolePlan(), ctx, at, w, h);

  if (tool === 'building') buildings.drawOverlay(ctx);

  const strokeScreen = (
    points: readonly Vec2[],
    colour: string | CanvasGradient | CanvasPattern,
    width: number,
    dash: readonly number[] = [],
    projected?: readonly Vec2[],
  ): void => {
    if (points.length < 2) return;
    ctx.strokeStyle = colour;
    ctx.lineWidth = width;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.setLineDash([...dash]);
    ctx.beginPath();
    const first = projected?.[0] ?? at(points[0] as Vec2);
    ctx.moveTo(first.x, first.y);
    for (let i = 1; i < points.length; i++) {
      const p = projected?.[i] ?? at(points[i] as Vec2);
      ctx.lineTo(p.x, p.y);
    }
    ctx.stroke();
    ctx.setLineDash([]);
  };

  const ring = (centre: Vec2, radius: number, colour: string, width: number,
    projected?: Vec2): void => {
    const c = projected ?? at(centre);
    ctx.strokeStyle = colour;
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.arc(c.x, c.y, radius, 0, Math.PI * 2);
    ctx.stroke();
  };

  if (selectedSegment !== null) {
    const ribbon = net.ribbons.get(selectedSegment);
    if (ribbon) strokeScreen(ribbon.full.toPoints(), SELECTION, 3);
  }

  if (tool !== 'road' && hoverAnchor?.kind === 'segment' && hoverAnchor.segment !== undefined) {
    const ribbon = net.ribbons.get(hoverAnchor.segment);
    if (ribbon) strokeScreen(ribbon.full.toPoints(), HOVER, 2);
  }

  if (selectedNode !== null) {
    const node = doc.node(selectedNode);
    if (node) ring({ x: node.x, y: node.y }, 12, SELECTION, 2);
  }

  // The node a road would start from, when the cursor is snapping to one.
  //
  // Only then. It was drawn wherever the cursor rested - a white circle on the
  // grass, and on a road on its centre line, where a segment anchor sits -
  // with the Road tool up, which is the tool the game starts in. Players
  // reported it, twice, as a debug marker left on screen.
  if (tool === 'road' && !draft && hoverAnchor?.kind === 'node') {
    ring(hoverAnchor.at, 9, HOVER, 2);
  }

  // The brush, drawn where it will land.
  //
  // Two rings rather than one: the outer is the radius, the inner marks where
  // the smoothstep falloff still has most of its strength, which is the part
  // the player is actually aiming. The height readout is there because
  // levelling needs a number — you cannot match one slope to another by eye in
  // an isometric projection.
  if (tool === 'terrain' && hoverAnchor) {
    const brush = terrainStroke ? terrainStroke.at : hoverAnchor.at;
    const centre = at(brush);
    const xEdge = at({ x: brush.x + terrainRadius, y: brush.y });
    const yEdge = at({ x: brush.x, y: brush.y + terrainRadius });
    const rx = Math.max(4, Math.hypot(xEdge.x - centre.x, xEdge.y - centre.y));
    const ry = Math.max(4, Math.hypot(yEdge.x - centre.x, yEdge.y - centre.y));
    const colour = TERRAIN_BRUSH_COLOUR[terrainMode];
    ctx.save();
    ctx.strokeStyle = colour;
    ctx.fillStyle = TERRAIN_BRUSH_FILL[terrainMode];
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 5]);
    ctx.beginPath();
    ctx.ellipse(centre.x, centre.y, rx, ry, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    // Inner ring: the half-strength contour, scaled by the strength setting so
    // a heavier brush visibly bites deeper.
    const bite = 0.3 + 0.35 * (terrainStrength / 10);
    ctx.setLineDash([]);
    ctx.globalAlpha = 0.65;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.ellipse(centre.x, centre.y, rx * bite, ry * bite, 0, 0, Math.PI * 2);
    ctx.stroke();

    ctx.globalAlpha = 1;
    ctx.beginPath();
    ctx.moveTo(centre.x - 5, centre.y);
    ctx.lineTo(centre.x + 5, centre.y);
    ctx.moveTo(centre.x, centre.y - 5);
    ctx.lineTo(centre.x, centre.y + 5);
    ctx.stroke();

    const height = terrainStroke ? terrainStroke.level : sceneHeightAt(brush);
    const label = terrainMode === 'flatten'
      ? `${t('terrain.level')} ${height.toFixed(1)}`
      : height.toFixed(1);
    ctx.font = '600 11px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    const width = ctx.measureText(label).width + 12;
    ctx.fillStyle = 'rgba(12,18,16,0.76)';
    ctx.beginPath();
    ctx.roundRect(centre.x - width / 2, centre.y - ry - 24, width, 17, 8);
    ctx.fill();
    ctx.fillStyle = colour;
    ctx.fillText(label, centre.x, centre.y - ry - 10);
    ctx.restore();
  }

  // With the control tool up, every junction states what it is doing. The
  // setting is invisible otherwise, so choosing one meant clicking each node in
  // turn to read it back.
  if (tool === 'control') {
    ctx.font = '600 10px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const node of doc.nodes.values()) {
      if (node.incident.length < 3) continue;
      const centre = at({ x: node.x, y: node.y });
      const colour = CONTROL_COLOUR[node.control] ?? HOVER;
      const hot = hoverAnchor?.kind === 'node' && hoverAnchor.node === node.id;
      ctx.beginPath();
      ctx.arc(centre.x, centre.y, hot ? 13 : 10, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(12,18,16,0.72)';
      ctx.fill();
      ctx.strokeStyle = colour;
      ctx.lineWidth = hot ? 3 : 2;
      ctx.stroke();
      ctx.fillStyle = colour;
      ctx.fillText(CONTROL_GLYPH[node.control] ?? '?', centre.x, centre.y + 0.5);
    }
  }

  const roadPreview: RoadDraft | null = curvePending
    ? {
      start: curvePending.start,
      startHeightOffset: curvePending.startHeightOffset,
      chained: true,
      pressedAt: curvePending.control,
      snap: { at: curvePending.end.at, guide: null, angleDeg: 0,
        length: dist(curvePending.start.at, curvePending.end.at) },
      samples: [{ at: curvePending.start.at, heightOffset: curvePending.startHeightOffset }],
      heightOffset: curvePending.endHeightOffset,
      curveControl: curvePending.control,
    }
    : draft ?? chainPreview;
  if (roadPreview) {
    const rt = roadType(roadTypeIndex);
    const pieces = piecesForDraft(roadPreview);
    const points: Vec2[] = [];
    const projected: Vec2[] = [];
    const groundProjected: Vec2[] = [];
    const offsets: number[] = [];
    let previewHeight = roadPreview.startHeightOffset;
    let limited = false;
    for (const [pieceIndex, piece] of pieces.entries()) {
      const flattened = flattenSegment(piece.start.at, piece.end.at, piece.curve);
      const pieceLength = flattened.reduce((sum, p, i) =>
        i === 0 ? 0 : sum + dist(p, flattened[i - 1] as Vec2), 0);
      const reach = pieceLength * MAX_AUTHORED_GRADE;
      const nextHeight = clamp(piece.end.heightOffset,
        previewHeight - reach, previewHeight + reach);
      limited ||= Math.abs(nextHeight - piece.end.heightOffset) > 1e-6;
      for (let i = pieceIndex === 0 ? 0 : 1; i < flattened.length; i++) {
        const p = flattened[i] as Vec2;
        const t = i / Math.max(1, flattened.length - 1);
        const eased = t * t * (3 - 2 * t);
        const offset = previewHeight + (nextHeight - previewHeight) * eased;
        const ground = scene.terrainHeightAt(p.x, p.y);
        points.push(p);
        offsets.push(offset);
        groundProjected.push(view.toScreen(p, w, h, ground));
        projected.push(view.toScreen(p, w, h, ground + offset));
      }
      previewHeight = nextHeight;
    }
    const pathLength = points.reduce((sum, point, i) =>
      i === 0 ? 0 : sum + Math.hypot(point.x - (points[i - 1] as Vec2).x, point.y - (points[i - 1] as Vec2).y), 0);
    const ok = pathLength >= MIN_LINK_LENGTH * 0.25 &&
      !(limited && roadPreview.snap.guide === 'network');
    // Use the length of both projected world axes. Reading only the horizontal
    // component made the preview several pixels thinner than the committed 3D
    // road in an isometric view, especially at the far zoom.
    const origin = at({ x: 0, y: 0 });
    const xAxis = at({ x: 100, y: 0 });
    const yAxis = at({ x: 0, y: 100 });
    const pixelsPerUnit = (
      Math.hypot(xAxis.x - origin.x, xAxis.y - origin.y) +
      Math.hypot(yAxis.x - origin.x, yAxis.y - origin.y)
    ) / 200;
    const asphaltWidth = Math.max(3, rt.width * pixelsPerUnit);
    const kerbWidth = Math.max(asphaltWidth + 2, (rt.width + 1.8) * pixelsPerUnit);
    const footwayWidth = Math.max(kerbWidth + 2, (rt.width + 1.8 + rt.sidewalk * 2) * pixelsPerUnit);
    const casingWidth = Math.max(footwayWidth + 2, footwayWidth + 3 * pixelsPerUnit);

    // The editor used to paint one translucent class-colour stroke here. At a
    // distance that blended into the grass and looked like a broken, untextured
    // road even though the committed mesh was sound. Draw the same visual stack
    // as the 3D road and keep validity as a slim outer halo instead.
    ctx.save();
    if (points.length > 1 && offsets.some((offset) => Math.abs(offset) > UNITS_PER_METER * 0.5)) {
      strokeScreen(points, 'rgba(6, 19, 21, 0.52)', casingWidth + 5, [7, 7], groundProjected);
      ctx.beginPath();
      ctx.moveTo(projected[0]!.x, projected[0]!.y);
      for (const p of projected.slice(1)) ctx.lineTo(p.x, p.y);
      for (const p of [...groundProjected].reverse()) ctx.lineTo(p.x, p.y);
      ctx.closePath();
      ctx.fillStyle = previewHeight >= 0 ? 'rgba(101, 229, 195, 0.16)' : 'rgba(244, 184, 103, 0.20)';
      ctx.fill();
    }
    strokeScreen(points, ok ? SELECTION : INVALID, casingWidth + 4, [], projected);
    strokeScreen(points, '#536b47', casingWidth, [], projected);
    strokeScreen(points, '#a7a498', footwayWidth, [], projected);
    strokeScreen(points, '#87877f', kerbWidth, [], projected);
    strokeScreen(points, asphaltPreviewPattern(ctx), asphaltWidth, [], projected);
    if (rt.markings !== 'none') {
      const dash = [Math.max(4, 10 * pixelsPerUnit), Math.max(3, 8 * pixelsPerUnit)];
      strokeScreen(points, rt.line, Math.max(1, 1.1 * pixelsPerUnit), dash, projected);
    }
    ctx.restore();
    if (points.length) {
      ring(roadPreview.start.at, 7, ok ? SELECTION : INVALID, 2, projected[0]);
      ring(roadPreview.snap.at, 7, ok ? SELECTION : INVALID, 2, projected[projected.length - 1]);
      const end = projected[projected.length - 1]!;
      const groundEnd = groundProjected[groundProjected.length - 1]!;
      if (Math.abs(previewHeight) > UNITS_PER_METER * 0.5) {
        ctx.save();
        ctx.strokeStyle = previewHeight >= 0 ? '#7df7d3' : '#ffc864';
        ctx.lineWidth = 3;
        ctx.setLineDash([4, 3]);
        ctx.beginPath();
        ctx.moveTo(groundEnd.x, groundEnd.y);
        ctx.lineTo(end.x, end.y);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.arc(groundEnd.x, groundEnd.y, 5, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }
      const metres = previewHeight / UNITS_PER_METER;
      const grade = pathLength > 1
        ? Math.round(Math.abs(previewHeight - roadPreview.startHeightOffset) / pathLength * 100)
        : 0;
      const label = `${metres >= 0 ? '+' : ''}${metres.toFixed(1)} m · ${grade}%`;
      if (Math.abs(previewHeight) > 0.25 ||
        Math.abs(previewHeight - roadPreview.startHeightOffset) > 0.25) {
        const x = clamp(end.x + 16, 12, Math.max(12, w - 430));
        const y = clamp(end.y + 24, 80, h - 80);
        const baseline = y + 51;
        const levelY = (offset: number): number => baseline -
          clamp(offset / UNITS_PER_METER * 3, -22, 22);
        const startY = levelY(roadPreview.startHeightOffset);
        const endY = levelY(previewHeight);
        const colour = previewHeight >= 0 ? '#7df7d3' : '#ffc864';
        ctx.save();
        ctx.fillStyle = 'rgba(9, 27, 28, 0.94)';
        ctx.fillRect(x, y, 170, 68);
        ctx.strokeStyle = 'rgba(210, 226, 218, 0.55)';
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(x + 12, baseline);
        ctx.lineTo(x + 158, baseline);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.strokeStyle = colour;
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(x + 12, startY);
        ctx.bezierCurveTo(x + 63, startY, x + 107, endY, x + 158, endY);
        ctx.stroke();
        ctx.font = '600 11px system-ui, sans-serif';
        ctx.fillStyle = limited ? '#ffc864' : '#e7fff7';
        ctx.fillText(label, x + 11, y + 16);
        ctx.restore();
      }
    }
  }
}

/** The brush's colour, by what it does to the ground. */
const TERRAIN_BRUSH_COLOUR: Readonly<Record<TerrainMode, string>> = {
  raise: SELECTION,
  lower: '#ffc864',
  flatten: '#cfd8d4',
  river: '#73cfe7',
};

const TERRAIN_BRUSH_FILL: Readonly<Record<TerrainMode, string>> = {
  raise: 'rgba(101,229,195,0.08)',
  lower: 'rgba(255,200,100,0.08)',
  flatten: 'rgba(207,216,212,0.08)',
  river: 'rgba(70,160,190,0.12)',
};

/**
 * One glyph and one colour per control mode.
 *
 * Letters rather than icons: the overlay is a 2D canvas over an isometric
 * scene, a ten-pixel icon at that size is a smudge, and a letter survives the
 * zoom the player actually reads the map at.
 */
const CONTROL_GLYPH: Readonly<Record<JunctionControl, string>> = {
  auto: 'A',
  signal: 'S',
  priority: 'P',
  stop: '\u25A0',
  yield: '\u25BC',
  none: '\u2013',
};

const CONTROL_COLOUR: Readonly<Record<JunctionControl, string>> = {
  auto: '#8fb3a6',
  signal: '#ffd24a',
  priority: '#7ec8ff',
  stop: '#ff7a6a',
  yield: '#ffb057',
  none: '#9aa3a0',
};

function curveFromGesture(value: RoadDraft): CurveShape | null {
  const a = value.start.at;
  const b = value.snap.at;
  if (value.curveControl) {
    return fitRoadCurve(a, b, shapeFromControl(a, b, value.curveControl), roadTypeIndex);
  }
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const chord = Math.hypot(dx, dy);
  if (chord < 1) return null;
  const nx = -dy / chord;
  const ny = dx / chord;
  const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  let side = 0;
  for (const sample of value.samples) {
    const p = sample.at;
    const candidate = (p.x - mid.x) * nx + (p.y - mid.y) * ny;
    if (Math.abs(candidate) > Math.abs(side)) side = candidate;
  }
  side = clamp(side, -chord * 0.52, chord * 0.52);
  if (Math.abs(side) < camera.px(6)) return null;
  return fitRoadCurve(a, b, shapeFromControl(a, b,
    { x: mid.x + nx * side * 1.36, y: mid.y + ny * side * 1.36 }), roadTypeIndex);
}

function piecesForDraft(value: RoadDraft, endHeightOffset = value.heightOffset): RoadPathPiece[] {
  const start = { at: value.start.at, heightOffset: value.startHeightOffset };
  const end = { at: value.snap.at, heightOffset: endHeightOffset };
  if (alignment === 'free') return roadPathFromGesture(value.samples, start, end).map((piece) => ({
    ...piece,
    curve: fitRoadCurve(piece.start.at, piece.end.at, piece.curve, roadTypeIndex),
  }));
  if (Math.hypot(start.at.x - end.at.x, start.at.y - end.at.y) < 1e-6) return [];
  return [{ start, end, curve: alignment === 'curve' ? curveFromGesture(value) : null }];
}

function setNodeHeightMetres(id: NodeId, metres: number): void {
  const node = doc.node(id);
  if (!node || !Number.isFinite(metres) || node.heightOffset === metres * UNITS_PER_METER) return;
  let lower = -Infinity;
  let upper = Infinity;
  for (const segmentId of node.incident) {
    const segment = doc.segment(segmentId);
    if (!segment) continue;
    const other = doc.node(segment.a === id ? segment.b : segment.a);
    if (!other) continue;
    const rise = net.polylines.get(doc, segmentId).length * MAX_AUTHORED_GRADE;
    lower = Math.max(lower, other.heightOffset - rise);
    upper = Math.min(upper, other.heightOffset + rise);
  }
  const requested = metres * UNITS_PER_METER;
  const height = lower <= upper ? clamp(requested, lower, upper) : node.heightOffset;
  if (height === node.heightOffset) {
    if (Math.abs(height - requested) > 1e-6) flashHint('hint.road.gradeLimited');
    return;
  }
  mutate(() => {
    doc.setNodeHeightOffset(id, height);
    return true;
  });
  if (Math.abs(height - requested) > 1e-6) flashHint('hint.road.gradeLimited');
}

function showInspector(): void {
  openInspector(
    doc,
    net,
    sim,
    { segment: selectedSegment, node: selectedNode },
    {
      onUpgrade: (id) => {
        const seg = doc.segment(id);
        if (!seg || seg.type >= LAST_UPGRADE_CLASS) return;
        mutate(() => {
          doc.setSegmentType(id, seg.type + 1);
          return true;
        });
      },
      onSetType: (id, type) => {
        const seg = doc.segment(id);
        if (!seg || seg.type === type) return;
        mutate(() => {
          doc.setSegmentType(id, type);
          return true;
        });
      },
      onSetLanes: (id, lanes) => {
        if (!doc.segment(id)) return;
        mutate(() => {
          doc.setSegmentLanes(id, lanes);
          return true;
        });
      },
      onSetDirection: (id, direction) => {
        if (!doc.segment(id)) return;
        mutate(() => {
          doc.setSegmentDirection(id, direction);
          return true;
        });
      },
      onSetNodeHeight: setNodeHeightMetres,
      onReverseDirection: (id) => {
        const seg = doc.segment(id);
        if (!seg) return;
        const direction = seg.direction === 'aToB' ? 'bToA' : 'aToB';
        mutate(() => {
          doc.setSegmentDirection(id, direction);
          return true;
        });
      },
      onSplit: (id) => {
        const seg = doc.segment(id);
        if (!seg) return;
        const polyline = net.polylines.get(doc, id);
        const at = polyline.sampleAt(polyline.length / 2).p;
        mutate(() => splitSegment(doc, net, id, polyline.length / 2, at) !== null);
      },
      onAddHeightPoint: (id) => {
        if (!doc.segment(id)) return;
        const polyline = net.polylines.get(doc, id);
        if (polyline.length < 20) { flashHint('hint.road.invalid'); return; }
        const chosen = selectedSegment === id && selectedSegmentS !== null
          ? selectedSegmentS : polyline.length / 2;
        const s = chosen < 5 || chosen > polyline.length - 5
          ? polyline.length / 2 : chosen;
        let node: NodeId | null = null;
        mutate(() => {
          node = splitSegment(doc, net, id, s, polyline.sampleAt(s).p);
          if (node === null) return false;
          doc.requireNode(node).smooth = true;
          return true;
        });
        if (node !== null) {
          selectedSegment = null;
          selectedSegmentS = null;
          selectedNode = node;
          showInspector();
        }
      },
      onDuplicate: (id) => {
        duplicateSelectedSegment(id);
      },
      onSetControl: (id, control) => {
        if (!doc.node(id)) return;
        mutate(() => {
          doc.setNodeControl(id, control);
          return true;
        });
      },
      onSetMovementBlocked: (node, from, to, blocked) => {
        if (!doc.node(node)) return;
        mutate(() => {
          doc.setMovementBlocked(node, from, to, blocked);
          return true;
        });
      },
      onSetCurve: (id, curve) => {
        const seg = doc.segment(id);
        if (!seg) return;
        const unchanged =
          seg.curve === curve ||
          (seg.curve !== null && curve !== null && seg.curve.t === curve.t && seg.curve.h === curve.h);
        if (unchanged) return;
        mutate(() => {
          doc.setSegmentCurve(id, curve);
          return true;
        });
      },
      onJoin: (node) => {
        mutate(() => joinSegments(doc, node));
        selectedNode = null;
        closeInspector();
      },
      onRemoveNode: (node) => {
        mutate(() => {
          const source = doc.node(node);
          if (!source) return false;
          for (const seg of [...source.incident]) doc.removeSegment(seg);
          doc.removeNode(node);
          doc.pruneOrphanNodes();
          return true;
        });
        selectedNode = null;
        closeInspector();
      },
      onDelete: (id) => {
        mutate(() => {
          doc.removeSegment(id);
          doc.pruneOrphanNodes();
          return true;
        });
        selectedSegment = null;
        closeInspector();
      },
    },
  );
}

/** Duplicates the inspected road and keeps the copy selected for immediate editing. */
function duplicateSelectedSegment(id = selectedSegment): void {
  if (id === null) return;
  let copy: SegmentId | null = null;
  mutate(() => {
    copy = duplicateSegment(doc, net, id);
    return copy !== null;
  });
  if (copy !== null) {
    selectedSegment = copy;
    selectedNode = null;
    showInspector();
  }
}

function updateStatus(): void {
  text('roadCount', roadCountLabel(doc.segments.size));
  text('nodeCount', nodeCountLabel(doc.nodes.size));
  text('vehicleCount', vehicleCountLabel(sim.vehicles.size));
  text('pedCount', peopleCountLabel(sim.pedViews.length));
  // The city's numbers, computed all along and shown nowhere (audit P2-02).
  text('metricTrips', String(sim.completedTrips));
  text('metricLost', String(sim.entryDemandLost));
  let speedSum = 0;
  let queued = 0;
  for (const v of sim.vehicles.values()) {
    speedSum += v.v;
    if (v.v < 0.5) queued++;
  }
  text('metricSpeed', sim.vehicles.size ? `${Math.round((speedSum / sim.vehicles.size) * METERS_PER_UNIT * 3.6)} km/h` : '—');
  text('metricQueued', String(queued));
  text('zoomReadout', `${Math.round(view.zoom * 100)}%`);
  // From the seam, not the flat camera: under 3D that one never moves, so
  // the readout sat frozen at its start position through every pan and zoom.
  const centre = view.centre;
  text('coordReadout', `X ${Math.round(centre.x)} · Y ${Math.round(centre.y)}`);

  const el = document.getElementById('auditReadout');
  if (!el) return;

  const counts = summarize(sim.issues);
  if (counts.size === 0) {
    el.textContent = t('status.clear');
    el.className = 'good';
  } else {
    const parts = [...counts].map(([code, n]) => `${code}×${n}`);
    el.textContent = parts.slice(0, 2).join(' · ');
    el.className = 'bad';
  }
}

function text(id: string, value: string): void {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    // Do not let a hidden tab's elapsed wall time flood the accumulator.
    last = performance.now();
    requestDraw();
  }
});

window.addEventListener('beforeunload', () => persistence.saveSession(doc, sessionSettings()));
// A hidden or discarded tab may never see `beforeunload` (phones, tab freezing).
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') persistence.flush();
});
window.addEventListener('pagehide', () => persistence.saveSession(doc, sessionSettings()));

// A failed write says so, at most once a minute, instead of losing the map at
// the next reload in silence.
let saveWarnedAt = -Infinity;
persistence.onSaveFailed = () => {
  const now = performance.now();
  if (now - saveWarnedAt < 60_000) return;
  saveWarnedAt = now;
  flashHint('hint.saveFailed');
};

requestDraw();

// Refresh the readouts once, explicitly. The loop stops as soon as nothing is
// moving, so its UI work cannot be the only place that runs it: a map that
// loads paused ended the loop before the first status pass and kept the initial
// HTML for ever. Measured on an all-combinations map of 32 roads and 47 nodes:
// the roads drew, the status bar read "0 roads · 0 nodes", and the minimap was
// never resized from its default 300x150.
updateStatus();
syncFlatCameraFromView();
drawMinimap(minimapCanvas, doc, net, sim, camera, surface, viewFootprint());

// ------------------------------------------------------------- language & quality

const languageSelect = document.getElementById('languageSelect') as HTMLSelectElement;
for (const spec of LANGUAGES) {
  const option = document.createElement('option');
  option.value = spec.code;
  option.textContent = spec.label;
  languageSelect.appendChild(option);
}
languageSelect.value = language();
languageSelect.onchange = () => {
  const value = languageSelect.value;
  if (value === 'en' || value === 'pt-BR') setLanguage(value);
};

// Anything rendered from script rather than from markup has to be re-rendered
// when the language changes; `applyTranslations` only reaches elements that
// carry a key, and these were built by hand.
onLanguageChange(() => {
  refreshRoadTypeLabels();
  personCreator.relabel();
  labelTools();
  renderToolHelp(toolHelpFor);
  renderPanelTitle();
  buildings.languageChanged();
  updateHint();
  updateStatus();
  refreshInspector();
  requestDraw();
});

const qualitySelect = document.getElementById('qualitySelect') as HTMLSelectElement;
const QUALITY_STORAGE_KEY = 'roadcraft.quality';
const savedQuality = (() => {
  try {
    return window.localStorage.getItem(QUALITY_STORAGE_KEY);
  } catch {
    return null;
  }
})();
if (savedQuality === 'auto' || isQualityLevel(savedQuality)) {
  qualitySelect.value = savedQuality;
  if (savedQuality !== 'auto') scene.setQuality(savedQuality as QualityLevel);
}
qualitySelect.onchange = () => {
  const value = qualitySelect.value;
  if (value !== 'auto' && !isQualityLevel(value)) return;
  scene.setQuality(value === 'auto' ? 'auto' : (value as QualityLevel));
  try {
    window.localStorage.setItem(QUALITY_STORAGE_KEY, value);
  } catch {
    // Not remembering the choice is not a reason to refuse it.
  }
  requestDraw();
};
// Diagnostic surface for browser-driven checks.
(window as unknown as { __roadcraft: unknown }).__roadcraft = {
  doc,
  net,
  sim,
  camera,
  surface,
  DT,
  exportMap: () => exportToFile(doc, sessionSettings()),
  importMap: async () => openImported(await importFromFile()),
  setTraffic: (enabled: boolean) => {
    if (traffic !== enabled) trafficButton.click();
  },
  setRoadHeight: (metres: number) => {
    roadHeightOffset = metres * UNITS_PER_METER;
    roadHeightEdited = true;
    updateRoadHeightValue();
    requestDraw();
  },
  /** Replaces the map as loading a file does: document, network and simulation topology. */
  loadDoc: (data: ReturnType<RoadDoc['toJSON']>) => {
    history.record(doc);
    applySnapshot(data, 'import');
  },
  /**
   * Centres the play camera on a world point, so the next frame builds what
   * is there (the crowd and the shadow frustum follow the play view). The
   * inspection camera then photographs that frame (`scene().inspect`).
   */
  lookAt: (x: number, y: number, zoom = camera.zoom) => {
    camera.x = x;
    camera.y = y;
    camera.zoom = zoom;
    syncViewFromFlatCamera();
    requestDraw();
  },
  /** Forces one frame. Used by the browser verification harness. */
  redraw: () => requestDraw(),
  /**
   * Runs the simulation for `seconds` of SIMULATION time, immediately.
   *
   * The clock deliberately refuses to catch up more than `MAX_SUBSTEPS` per
   * frame, which is right for a game and useless for a harness: on a software
   * rasteriser at seven frames a second, waiting in wall time for a junction to
   * fill with traffic or for a signal to reach green takes minutes and is not
   * reproducible. This runs the fixed steps directly.
   */
  runSim: (seconds: number) => {
    sim.clock.run(Math.max(0, Math.round(seconds / DT)), () =>
      step(sim, { traffic: true, pedestrians: true }),
    );
    requestDraw();
  },
  pickAtScreen: (x: number, y: number) =>
    findAnchor(
      doc,
      net,
      worldAtScreen(x, y),
      view.zoom,
    ),
  // The pole tool, as the tool itself runs it: plan from two raw points, then
  // commit that plan. A harness that called the geometry directly would be
  // testing something the player cannot reach.
  utilities: {
    plan: (from: Vec2, to: Vec2, reach = POLE_PICK_PIXELS / view.zoom) =>
      planPoleRun(doc, net, from, to, reach),
    run: (from: Vec2, to: Vec2, reach = POLE_PICK_PIXELS / view.zoom) => {
      const plan = planPoleRun(doc, net, from, to, reach);
      return mutateBuilt(() => commitPoleRun(doc, plan));
    },
  },
  audit: () => [...sim.issues],
  /** The live three.js scene handle, for browser-driven checks. */
  scene: () => scene,
  /** The building tool, for browser-driven checks. */
  buildings: buildings.tool,
};
