import type { Vec2 } from '@core/vec2';
import { signedArea } from '@core/polygon';
import {
  BLUEPRINTS,
  type BlueprintBody,
  DEFAULT_STOREY_HEIGHT,
  blueprintByKey,
  bodyOf,
  generateBlock,
  instantiate,
} from '@world/buildings/blueprints';
import { cityBuilding } from '@world/buildings/cityBuildings';
import { FURNITURE_SIZE, type FurnitureKind, cutOpen, furnishingOf } from '@world/buildings/interior';
import { FloorCache, type PavedAt, floorHeight } from '@world/buildings/foundation';
import { edgeFrame, localFootprint, overlapArea } from '@world/buildings/footprints';
import { GRID } from '@world/buildings/geometry';
import { METERS_PER_UNIT, m } from '@world/units';
import { MIN_SIZE, topLevel, baysOn, footprintBox, levelElevation, levelHeight, localDirToWorld, localToWorld, reliefAt, worldToLocal } from '@world/buildings/geometry';
import { type Handle, buildingHandles } from '@world/buildings/handles';
import { type BuildingHit, type Ray3, pickBuilding } from '@world/buildings/pick';
import { FINISH_COLOUR, type MaterialSpec, type MaterialTarget, applyMaterial, applyStyle, materialAt } from '@world/buildings/materials';
import { ELEMENT_DEFAULTS, elementAt, elementsAgainstBay } from '@world/buildings/elements';
import { type BuildingProblem, validateBuilding } from '@world/buildings/validate';
import {
  type BayComponent,
  type Building,
  type BuildingElement,
  type BuildingId,
  type ElementKind,
  type RoofKind,
  type RoofDetailKind,
  type FacadePattern,
  type FacadeGeometry,
  type FaceId,
  type Side,
  type Volume,
  type BlockMode,
  type BuildingFunction,
  type CoreKind,
  DEFAULT_MODULE,
  asBuildingId,
  isSide,
  cloneBuilding,
  volumeById,
} from '@world/buildings/types';
import {
  type BuildingContext,
  type EditResult,
  type FacadeScope,
  addBuildingRecord,
  deleteBuilding,
  duplicateBuilding,
  editBuilding,
  normaliseAngle,
  opAddSetback,
  opAddWing,
  opResize,
  opRotate,
  opScalePlan,
  opSetComponent,
  opAddElement,
  opMirror,
  opRemoveElement,
  opRepeatElement,
  opSetParameters,
  opSetLevelHeight,
  opSetRelief,
  opUpdateElement,
  type ElementPatch,
  opSetRoof,
  opSetRoofShape,
  type FaceRegion,
  type RoofShape,
  opSetStoreys,
  removeVolume,
  replaceBuilding,
} from './buildings';
import { footprintSize, snapPlacement } from './buildingSnap';
import { blockSnap, clipRing, groupInto, opMoveBlock, opFuseElement, weldInto } from './buildings';
import { type PlanShape, type Primitive, PRIMITIVES, type UpperMassPlacement, shapeBody, shapePoints, setVolumePlan, movePlanEdge, movePlanVertex, changePlanVertex, addPlanMass, addShapedUpperMass, offsetPlan, bevelPlan } from './buildingPlans';
import { applyFacadePattern, updateFacadeGeometry, type FacadeTarget } from './buildingFacade';
import { addRoofDetail, removeRoofDetail, updateRoofDetail } from './buildingRoofs';
import { splitVolumeAtFloor, reshapeTier as reshapeTierPlan } from './buildingProfile';

/**
 * The building tool, as a state machine in world coordinates.
 *
 * It knows neither the DOM nor three.js: `main.ts` hands it a `ToolView` for
 * the few things only the viewport can answer, and a `ToolHost` whose
 * `commit` records the undo snapshot and stores the edit. Every gesture here
 * previews on a COPY of the building (shown by the renderer as a ghost) and
 * commits once, on release, through the same validated commands a test calls.
 */
export interface ToolView {
  /** Screen position (CSS px) of a world point at absolute height `z`. */
  project(x: number, y: number, z: number): Vec2;
  /** World point under a screen position, on the horizontal plane at `z`. */
  planeAt(screen: Vec2, z: number): Vec2;
  /** The pick ray through a screen position. */
  ray(screen: Vec2): Ray3;
  /** The height the terrain is drawn at. */
  groundAt(x: number, y: number): number;
  /** The paving an entrance opens onto (NaN off the roads); none in a headless test. */
  readonly pavedAt?: PavedAt;
  /** Handle hit radius, CSS px. */
  readonly pickPixels: number;
}

export interface ToolHost {
  context(): BuildingContext;
  /** A key that changes whenever the ground under any building may have. */
  groundKey(): string;
  /** Records history, runs the edit, stores it; returns the edit's result. */
  commit(edit: () => EditResult): EditResult;
  /** Something the screen or the panel shows has changed. */
  changed(): void;
  /** A transient message in the hint bar (a translation key). */
  flash(key: string): void;
  focus?(building: Building): void;
}

export type BuildingToolMode = 'place' | 'edit';
export type PlanAction = 'new' | 'ground' | 'top' | 'cut';
export type CreatorTool = 'sketch' | 'shape' | 'facade' | 'roof';
export type BuildingModelTool = 'select' | 'draw' | 'extrude' | 'offset' | 'bevel' | 'cut' | 'paint' | 'openings';

/** What a material pick paints: the whole building, the selected volume, one face of it, or its roof. */
export type MaterialScope = 'building' | 'volume' | 'face' | 'floor' | 'roof';

export interface BuildingPreview {
  readonly building: Building;
  readonly valid: boolean;
  readonly problem: BuildingProblem | null;
  /** The stored building this preview stands in for, hidden meanwhile. */
  readonly hides: BuildingId | null;
  /** Bumped on every change, so the renderer can gate its rebuild. */
  readonly serial: number;
  /** Drawn in the building's own materials (the interior view), not as a ghost. */
  readonly solid?: boolean;
}

export interface BaySelection {
  readonly storey: number;
  readonly side: FaceId;
  readonly index: number;
}

export interface BuildingSelection {
  readonly building: BuildingId;
  readonly volume: number;
  readonly bay: BaySelection | null;
  /** With Shift, a second bay of the same face: the picked region runs from `bay` to it. */
  readonly bayEnd?: BaySelection | null;
  /** A free element of the building, when one was clicked. */
  readonly element?: number | null;
  readonly vertex?: number | null;
}

/** Parameters of the generated block (the sliders); lengths in world units. */
export interface PlaceParameters {
  width: number;
  depth: number;
  storeys: number;
  storeyHeight: number;
  module: number;
}

type Drag =
  | { kind: 'vertex'; origin: Building; volume: number; vertex: number; z: number }
  | { kind: 'storeys'; origin: Building; volume: number; start: Vec2; pixelsPerStorey: number; count: number }
  | { kind: 'side'; origin: Building; volume: number; side: FaceId; start: Vec2; z: number; dir: Vec2; wing: boolean }
  | { kind: 'offset'; origin: Building; volume: number; start: Vec2; z: number; dir: Vec2 }
  | { kind: 'move'; origin: Building; start: Vec2; z: number }
  | { kind: 'massMove'; origin: Building; volume: number; start: Vec2; z: number }
  | { kind: 'rotate'; origin: Building; centre: Vec2; z: number; startAngle: number }
  | { kind: 'scale'; origin: Building; centre: Vec2; z: number; startDist: number; width: number }
  | { kind: 'relief'; origin: Building; volume: number; region: FaceRegion; start: Vec2; z: number; dir: Vec2; depth: number }
  | { kind: 'click'; hit: BuildingHit | null; start: Vec2; moved: boolean; shift: boolean; at: number };

const PREVIEW_ID = asBuildingId(-1);
/** A press held this long without moving counts as a long press. */
const LONG_PRESS_MS = 450;
const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());
const DRAG_START_PIXELS = 4;
const ROTATE_STEP = Math.PI / 12;

export class BuildingTool {
  mode: BuildingToolMode = 'place';
  stage: CreatorTool = 'sketch';
  activeModelTool: BuildingModelTool | null = null;
  planPoints: Vec2[] | null = null;
  planCursor: Vec2 | null = null;
  planAction: PlanAction = 'new';
  /** What a click in place mode builds. */
  body: BlueprintBody;
  blueprintKey: string | null;
  params: PlaceParameters = {
    width: 4 * DEFAULT_MODULE,
    depth: 3 * DEFAULT_MODULE,
    storeys: 2,
    storeyHeight: DEFAULT_STOREY_HEIGHT,
    module: DEFAULT_MODULE,
  };
  /** Rotation the player has asked for; snapping may override it. */
  rotation = 0;
  selection: BuildingSelection | null = null;
  /** The component the picker has armed: a click on a bay puts it there. */
  component: BayComponent | null = null;
  scope: FacadeScope = 'bay';
  materialScope: MaterialScope = 'building';
  paintBrush: Partial<MaterialSpec> = { finish: 'brick', colour: FINISH_COLOUR.brick };
  /** Alt held: drags follow the pointer freely, without snapping to the grid. */
  free = false;
  /**
   * What the gesture in progress measures, for the overlay to show beside
   * it: a length or a depth (world units) at a world point, or a count.
   */
  measure: { readonly kind: 'length' | 'depth' | 'floors'; readonly value: number; readonly x: number; readonly y: number; readonly z: number } | null = null;
  /** The kind of free element the palette has armed: the pointer places one. */
  armed: ElementKind | null = null;
  roofDetailKind: RoofDetailKind | null = null;
  selectedRoofDetail: number | null = null;
  preview: BuildingPreview | null = null;
  hover: BuildingHit | null = null;
  hoverHandle: Handle | null = null;
  clipboard: BlueprintBody | null = null;
  /** The last problem a gesture reported, for the overlay's label. */
  problem: BuildingProblem | null = null;

  private drag: Drag | null = null;
  private serial = 0;
  private readonly floors = new FloorCache();
  private lastScreen: Vec2 | null = null;
  private lastWorld: Vec2 | null = null;

  constructor(private readonly view: ToolView, private readonly host: ToolHost) {
    const first = BLUEPRINTS[0];
    this.body = first ? first.body : generateBlock(4 * DEFAULT_MODULE, 3 * DEFAULT_MODULE, 2);
    this.blueprintKey = first ? first.key : null;
  }

  // ------------------------------------------------------------ queries

  /** Ground-floor height: cached for stored buildings, measured for a preview. */
  floorOf(b: Building): number {
    if (this.preview && b === this.preview.building) return floorHeight(b, this.view.groundAt, this.view.pavedAt);
    const key = `${this.host.groundKey()}:${this.host.context().doc.buildings.revision}`;
    return this.floors.floorOf(b, this.view.groundAt, key, this.view.pavedAt);
  }

  selected(): Building | null {
    if (!this.selection) return null;
    return this.host.context().doc.buildings.get(this.selection.building) ?? null;
  }

  /** Drops a selection whose building or volume no longer exists (after an undo). */
  sync(): void {
    if (!this.selection) return;
    const b = this.selected();
    if (!b) {
      this.selection = null;
      return;
    }
    if (!volumeById(b, this.selection.volume)) {
      this.selection = { building: b.id, volume: (b.volumes[0] as { id: number }).id, bay: null };
    }
  }

  /** The handles of the selection, in world 3D. Only in edit mode. */
  handles(): Handle[] {
    if (this.mode !== 'edit' || !this.selection) return [];
    const shown = this.preview?.hides === this.selection.building ? this.preview.building : this.selected();
    if (!shown) return [];
    const floor = this.floorOf(shown);
    // Move and rotate go on the two footprint corners nearest the viewer.
    const nearest = (corners: readonly Vec2[]): number[] =>
      corners
        .map((p, i) => ({ i, y: this.view.project(p.x, p.y, floor).y }))
        .sort((a, b) => b.y - a.y)
        .map((c) => c.i);
    const region = this.faceRegion();
    const all = buildingHandles(shown, this.selection.volume, floor, nearest, region);
    const volume = volumeById(shown, this.selection.volume);
    const detailed = (volume?.outline?.length ?? 4) <= 12;
    const selectedSide = this.selection.bay?.side;
    // A building picked: its arrows, its corners, move, turn, scale. A face
    // picked (the second click): the push-pull arrow on it, and nothing that
    // would compete with it. The corner dots only on a plan with more than
    // four corners - on a box they sat on top of the scale and move handles.
    const corners = volume?.outline?.length ?? 4;
    return all.filter((h) => h.kind === 'move' || h.kind === 'rotate' || h.kind === 'storeys' ||
      (!region && h.kind === 'scale') ||
      (!region && h.kind === 'side' && (corners <= 8 || this.selection?.bay?.side === h.side)) ||
      // The picked face can be pushed or pulled whole by its own arrow.
      (region !== null && h.kind === 'side' && h.side === region.side) ||
      (this.pointMode && h.kind === 'vertex') ||
      (!region && corners > 4 && h.kind === 'vertex' &&
        (detailed || (h.vertex ?? 0) % 3 === 0 || h.vertex === this.selection?.vertex || h.vertex === selectedSide || h.vertex === (selectedSide ?? -2) + 1)) ||
      (region !== null && h.kind === 'relief'));
  }

  /** The tool is put away: no ghost, no gesture, no hover. The selection stays. */
  deactivate(): void {
    this.drag = null;
    this.planPoints = null;
    this.planCursor = null;
    this.hover = null;
    this.hoverHandle = null;
    this.setPreview(null);
  }

  /** The building face under a screen point, if any (the bulldozer asks). */
  pickAt(screen: Vec2): BuildingHit | null {
    return this.pick(screen);
  }

  /**
   * A key for the workspace's hint sentence: `hint.builder.<key>` in the
   * dictionaries. The plan being drawn has its own sentence per shape, the
   * rest follow the stage or the tool the model palette has armed.
   */
  builderHintKey(): string {
    if (this.pathKind) return `run.${this.pathKind}`;
    if (this.planPoints) return `draw.${this.stage === 'sketch' ? 'sketch' : this.planAction}`;
    if (this.armed) return this.armed;
    if (this.roofDetailKind) return this.roofDetailKind;
    if (this.activeModelTool) return this.activeModelTool;
    return this.stage;
  }

  /** Right button, or Escape: ends whatever the tool is doing, staying in the Builder. */
  cancelOperation(): boolean {
    if (this.planPoints) {
      this.cancelPlan();
      return true;
    }
    if (this.drag) {
      this.pointerUp(true);
      return true;
    }
    if (this.armed) {
      this.armElement(null);
      return true;
    }
    if (this.roofDetailKind) {
      this.armRoofDetail(null);
      return true;
    }
    if (this.component) {
      this.armComponent(null);
      return true;
    }
    if (this.activeModelTool && this.activeModelTool !== 'select') {
      this.armModelTool('select');
      return true;
    }
    return false;
  }

  /** Points the face tools at one floor of the selected volume. */
  selectFloor(storey: number): void {
    const s = this.selection;
    if (!s) return;
    const building = this.selected();
    const volume = building ? volumeById(building, s.volume) : undefined;
    if (!volume) return;
    const index = Math.max(0, Math.min(volume.storeys.length - 1, Math.round(storey)));
    const bay = s.bay ?? { storey: index, side: 0 as Side, index: 0 };
    this.selection = { ...s, bay: { ...bay, storey: index } };
    this.host.changed();
  }

  /**
   * Agrupar: every volume of another building moves into this record, brought
   * into its frame; the emptied record goes. One undo step.
   */
  groupWith(otherId: BuildingId): boolean {
    const building = this.selected();
    if (!building) return false;
    const result = this.host.commit(() => groupInto(this.host.context(), building.id, otherId));
    this.report(result);
    return result.ok;
  }

  /**
   * The Draw tools: a preset footprint sized by dragging on the ground.
   * Click one corner, drag, release - the shape fills the rectangle drawn,
   * and the map shows the same ghost it will place.
   */
  shapeDragStart: Vec2 | null = null;
  shapeDragShape: PlanShape | null = null;
  shapeDragAction: PlanAction = 'new';
  /**
   * The screen's own axes on the ground, as an angle: the rectangle the player
   * drags is the one they see. Measured along the map's axes instead, a
   * diagonal drag under a turned camera built a long thin sliver (P1-03).
   */
  private shapeDragAngle = 0;
  /**
   * The ground height the drag started on: the cursor is read on that level.
   * Read off the drawn world, it landed on the ghost's own roof as the shape
   * grew under it, and the far corner was dragged back towards the viewer.
   */
  private shapeDragZ = 0;

  /** The drag's span from `start` to `at`, in the screen-aligned frame. */
  private shapeDragSpan(start: Vec2, at: Vec2): { a0: number; b0: number; w: number; d: number } {
    const c = Math.cos(this.shapeDragAngle);
    const s = Math.sin(this.shapeDragAngle);
    const dx = at.x - start.x;
    const dy = at.y - start.y;
    const a = dx * c + dy * s;
    const b = -dx * s + dy * c;
    return { a0: Math.min(0, a), b0: Math.min(0, b), w: Math.max(m(2), Math.abs(a)), d: Math.max(m(2), Math.abs(b)) };
  }

  beginShapeDrag(shape: PlanShape, at: Vec2, action: PlanAction = 'new', screen: Vec2 | null = this.lastScreen): void {
    this.shapeDragShape = shape;
    this.shapeDragZ = this.view.groundAt(at.x, at.y);
    // A mass stacked on a roof is drawn on the roof: read on the ground, the
    // rectangle landed behind the building and was always "without support".
    const b = this.selected();
    const source = b && this.selection ? volumeById(b, this.selection.volume) : undefined;
    if (action === 'top' && b && source) {
      this.shapeDragZ = this.floorOf(b) + levelElevation(b, source.base + source.storeys.length);
    }
    this.shapeDragStart = screen ? this.view.planeAt(screen, this.shapeDragZ) : at;
    at = this.shapeDragStart;
    if (screen) {
      const a = this.view.planeAt(screen, 0);
      const b = this.view.planeAt({ x: screen.x + 40, y: screen.y }, 0);
      this.shapeDragAngle = Math.atan2(b.y - a.y, b.x - a.x);
    } else {
      this.shapeDragAngle = 0;
    }
    this.shapeDragAction = action;
    this.stage = 'sketch';
    this.mode = 'place';
    this.planPoints = action === 'new' ? null : [];
    this.planAction = action;
    this.chooseShape(shape);
    if (action === 'new') this.placeDrawn(at, at);
    this.host.changed();
  }

  /** The shape's outline, fitted into the rectangle the drag has drawn. */
  private shapeDragRing(): Vec2[] {
    const start = this.shapeDragStart;
    const shape = this.shapeDragShape;
    const last = this.planCursor ?? this.lastWorld;
    if (!start || !shape || !last) return [];
    const { a0, b0, w, d } = this.shapeDragSpan(start, last);
    const c = Math.cos(this.shapeDragAngle);
    const s = Math.sin(this.shapeDragAngle);
    return shapePoints(shape).map((p) => {
      const a = a0 + p.x * w;
      const b = b0 + p.y * d;
      return { x: start.x + a * c - b * s, y: start.y + a * s + b * c };
    });
  }

  updateShapeDrag(world: Vec2, screen?: Vec2): void {
    if (!this.shapeDragStart || !this.shapeDragShape) return;
    const start = this.shapeDragStart;
    const at = screen ? this.view.planeAt(screen, this.shapeDragZ) : world;
    const { w, d } = this.shapeDragSpan(start, at);
    this.planCursor = at;
    if (this.shapeDragAction === 'new') {
      this.params.width = w;
      this.params.depth = d;
      // Square to the screen, as it was drawn.
      this.rotation = normaliseAngle(this.shapeDragAngle);
      this.chooseShape(this.shapeDragShape);
      this.placeDrawn(start, at);
    } else {
      // The wing, the stack and the cut are plans: the drag writes the
      // outline, and the ordinary plan preview and finish do the rest.
      this.planPoints = this.shapeDragRing();
      this.updatePlanPreview();
    }
    this.host.changed();
  }

  /** Releases the drag: the shape is built where the ghost stands. */
  endShapeDrag(cancelled: boolean): void {
    const dragging = this.shapeDragStart !== null;
    const action = this.shapeDragAction;
    // Read before the drag is put away: the ring is drawn from its start, and
    // read afterwards it was empty - every wing, stack and cut ended with no
    // points and built nothing.
    const ring = this.shapeDragRing();
    this.shapeDragStart = null;
    this.shapeDragShape = null;
    this.shapeDragAction = 'new';
    if (!dragging || cancelled) {
      if (action !== 'new') this.planPoints = null;
      this.planCursor = null;
      this.setPreview(null);
      this.host.changed();
      return;
    }
    if (action !== 'new') {
      this.planPoints = ring;
      this.finishPlan();
      this.planCursor = null;
      this.host.changed();
      return;
    }
    if (!this.preview || !this.preview.valid) {
      if (this.preview?.problem) this.host.flash(`building.problem.${this.preview.problem}`);
      this.setPreview(null);
      this.host.changed();
      return;
    }
    this.placeHere();
    this.host.changed();
  }

  get dragging(): boolean {
    return this.drag !== null && this.drag.kind !== 'click';
  }

  // ------------------------------------------------------------ panel commands

  setMode(mode: BuildingToolMode): void {
    this.mode = mode;
    if (mode === 'edit' && this.stage === 'sketch' && !this.planPoints) this.stage = 'shape';
    this.drag = null;
    this.setPreview(null);
    if (mode === 'place' && this.lastScreen && this.lastWorld && !this.planPoints) this.hoverPlace(this.lastWorld);
    this.host.changed();
  }

  setStage(stage: CreatorTool): void {
    this.stage = stage;
    if (stage === 'roof') this.materialScope = 'roof';
    else if (stage === 'facade' && this.materialScope === 'roof') this.materialScope = 'volume';
    if (stage !== 'roof') this.roofDetailKind = null;
    if (stage !== 'shape') this.armed = null;
    if (stage !== 'facade') this.component = null;
    this.problem = null;
    this.host.changed();
  }

  armModelTool(tool: BuildingModelTool | null): void {
    this.activeModelTool = tool;
    if (tool === 'select') {
      this.mode = 'edit';
      this.drag = null;
      this.planPoints = null;
      this.planCursor = null;
      this.armed = null;
      this.roofDetailKind = null;
      this.setPreview(null);
    }
    if (tool !== 'openings') this.component = null;
    this.problem = null;
    this.host.changed();
  }

  chooseShape(shape: PlanShape): void {
    this.planPoints = null;
    this.body = shapeBody(shape, this.params.width, this.params.depth, this.params.storeys);
    this.blueprintKey = null;
    this.stage = 'sketch';
    this.setMode('place');
  }

  startPlan(action: PlanAction = 'new'): void {
    if (action !== 'new' && !this.selected()) return;
    this.planAction = action;
    this.mode = 'place';
    this.stage = 'sketch';
    this.planPoints = [];
    this.planCursor = null;
    this.problem = null;
    this.setPreview(null);
    this.host.changed();
  }

  cancelPlan(): void {
    const wasRun = this.pathKind !== null;
    this.pathKind = null;
    this.planPoints = null;
    this.planCursor = null;
    this.problem = null;
    this.setPreview(null);
    if (wasRun) this.mode = 'edit';
    else if (this.planAction === 'new') {
      if (this.lastWorld) this.hoverPlace(this.lastWorld);
    } else this.mode = 'edit';
    this.host.changed();
  }

  backPoint(): void {
    if (!this.planPoints) return;
    this.planPoints.pop();
    this.updatePlanPreview();
  }

  /** Validates the actual building on the terrain, then commits one undo step. */
  finishPlan(): void {
    if (this.pathKind) {
      if (this.planPoints && this.planPoints.length >= 2) this.finishElementRun();
      return;
    }
    if (!this.planPoints || this.planPoints.length < 3) return;
    const draft = this.planBuilding();
    if (!draft) { this.problem = this.planAction === 'cut' ? 'cut' : 'outline'; this.host.changed(); return; }
    const problem = validateBuilding(this.host.context(), draft, this.planAction === 'new' ? undefined : draft.id);
    if (problem) { this.problem = problem; this.host.changed(); return; }
    const result = this.host.commit(() => this.planAction === 'new'
      ? addBuildingRecord(this.host.context(), stripId(draft))
      : replaceBuilding(this.host.context(), draft));
    if (result.ok && result.id !== undefined) {
      const volume = this.planAction === 'ground' || this.planAction === 'top'
        ? draft.nextVolumeId - 1 : this.planAction === 'cut' ? this.selection?.volume ?? draft.volumes[0]!.id : draft.volumes[0]!.id;
      this.selection = { building: result.id, volume, bay: null };
      this.mode = 'edit';
      this.stage = 'shape';
      this.planPoints = null;
      this.planCursor = null;
      this.setPreview(null);
      this.host.flash('building.placed');
    }
    this.report(result);
  }

  private planBuilding(): Building | null {
    if (!this.planPoints || this.planPoints.length < 3) return null;
    if (this.planAction !== 'new') {
      const existing = this.selected();
      const s = this.selection;
      if (!existing || !s) return null;
      const draft = cloneBuilding(existing);
      const points = this.planPoints.map((p) => worldToLocal(draft, p));
      if (this.planAction === 'cut') {
        // A cut is a block too - a void one, as tall as the block it is drawn
        // on: it takes its space out when drawn, and stays a block that can be
        // moved, reshaped or deleted, the cut going with it.
        const source = volumeById(draft, s.volume);
        if (!source) return null;
        const id = addPlanMass(draft, s.volume, points, source.base, source.storeys.length);
        if (id === null) return null;
        const cut = volumeById(draft, id);
        if (!cut) return null;
        cut.mode = 'void';
        cut.roof = 'flat';
      } else {
        const source = volumeById(draft, s.volume);
        if (!source) return null;
        const top = this.planAction === 'top';
        const base = top ? source.base + source.storeys.length : 0;
        // On a roof the mass is kept to the roof; on the ground it is as tall
        // as the mass it grows from, so the two read as one building.
        const ring = top ? clipRing(points, localFootprint(source)) : points;
        if (!ring) return null;
        // A block added to the building: whole, overlapping or not - nothing
        // of it or of its neighbours is cut away, so it can be moved, pulled
        // or taken off again later.
        if (addPlanMass(draft, s.volume, ring, base, top ? 2 : source.storeys.length) === null) return null;
      }
      return draft;
    }
    const body = JSON.parse(JSON.stringify(this.body)) as BlueprintBody;
    const first = body.volumes[0];
    if (!first) return null;
    body.volumes = [first];
    body.cores = [];
    delete body.elements;
    if (!setVolumePlan(first, this.planPoints)) return null;
    return { ...body, id: PREVIEW_ID, x: 0, y: 0, rotation: 0 };
  }

  private updatePlanPreview(): void {
    const draft = this.planBuilding();
    this.problem = draft ? validateBuilding(this.host.context(), draft, this.planAction === 'new' ? undefined : draft.id)
      : this.planPoints && this.planPoints.length >= 3 ? this.planAction === 'cut' ? 'cut' : 'outline' : null;
    this.setPreview(draft ? { building: draft, valid: this.problem === null, problem: this.problem,
      hides: this.planAction === 'new' ? null : draft.id, serial: 0 } : null);
    this.host.changed();
  }

  selectVolume(id: number): void {
    const b = this.selected();
    if (!b || !volumeById(b, id)) return;
    this.selection = { building: b.id, volume: id, bay: null };
    if (this.materialScope === 'face' || this.materialScope === 'floor') this.materialScope = 'volume';
    this.selectedRoofDetail = null;
    this.host.changed();
  }

  focusSelected(): void {
    const building = this.selected();
    if (building) this.host.focus?.(building);
  }

  changeVertex(action: 'insert' | 'remove'): void {
    const s = this.selection;
    if (!s) return;
    const index = action === 'insert' ? s.bay?.side : s.vertex;
    if (index === undefined || index === null) return;
    const result = this.onSelected((draft) => changePlanVertex(draft, s.volume, index, action === 'remove'));
    if (result.ok) this.selection = { ...s, bay: null, vertex: action === 'insert' ? index + 1 : null };
    this.report(result);
  }

  applyFacadeGrammar(pattern: FacadePattern, scope: FacadeTarget['scope']): void {
    const selected = this.selection;
    if (!selected) return;
    if ((scope === 'face' || scope === 'floor') && !selected.bay) {
      this.host.flash('building.material.pickFace');
      return;
    }
    const target: FacadeTarget = scope === 'building' ? { scope: 'building' }
      : scope === 'face' && selected.bay ? { scope: 'face', volume: selected.volume, face: selected.bay.side }
      : scope === 'floor' ? { scope: 'floor', volume: selected.volume, floor: selected.bay?.storey ?? 0 }
      : { scope: 'volume', volume: selected.volume };
    this.report(this.onSelected((draft) => applyFacadePattern(draft, target, pattern)));
  }

  setFacadeGeometry(patch: Partial<FacadeGeometry>): void {
    const s = this.selection, face = s?.bay?.side;
    if (!s || face === undefined) return;
    const result = this.onSelected((draft) => updateFacadeGeometry(draft, s.volume, face, patch));
    if (result.ok && patch.bays !== undefined && s.bay) {
      this.selection = { ...s, bay: { ...s.bay, index: Math.min(s.bay.index, Math.round(patch.bays) - 1) }, bayEnd: null };
      this.host.changed();
    }
  }

  armRoofDetail(kind: RoofDetailKind | null): void {
    this.roofDetailKind = this.roofDetailKind === kind ? null : kind;
    this.problem = null;
    this.host.changed();
  }

  selectRoofDetail(id: number): void {
    const volume = this.selected()?.volumes.find((v) => v.id === this.selection?.volume);
    if (!volume?.roofDetails?.some((part) => part.id === id)) return;
    this.selectedRoofDetail = id;
    this.host.changed();
  }

  turnRoofDetail(): void {
    const s = this.selection, id = this.selectedRoofDetail;
    if (!s || id === null) return;
    const part = this.selected()?.volumes.find((v) => v.id === s.volume)?.roofDetails?.find((detail) => detail.id === id);
    if (part) this.report(this.onSelected((draft) => updateRoofDetail(draft, s.volume, id, { rotation: part.rotation + Math.PI / 2 })));
  }

  moveRoofDetail(dx: number, dy: number): void {
    const s = this.selection, id = this.selectedRoofDetail;
    if (!s || id === null) return;
    const part = this.selected()?.volumes.find((v) => v.id === s.volume)?.roofDetails?.find((detail) => detail.id === id);
    if (part) this.report(this.onSelected((draft) => updateRoofDetail(draft, s.volume, id, { x: part.x + dx, y: part.y + dy })));
  }

  deleteRoofDetail(): void {
    const s = this.selection, id = this.selectedRoofDetail;
    if (!s || id === null) return;
    const result = this.onSelected((draft) => removeRoofDetail(draft, s.volume, id));
    if (result.ok) this.selectedRoofDetail = null;
    this.report(result);
  }

  setRoofDetailHeight(metres: number): void {
    const s = this.selection, id = this.selectedRoofDetail;
    if (!s || id === null || !Number.isFinite(metres)) return;
    this.onSelected((draft) => updateRoofDetail(draft, s.volume, id, { h: metres / METERS_PER_UNIT }));
  }

  /**
   * The selected block's width and depth (world units, null keeps one), about
   * its centre: a setback typed to size stays centred on what carries it.
   */
  setVolumeSize(w: number | null, d: number | null): void {
    const s = this.selection;
    if (!s) return;
    this.onSelected((draft) => {
      const v = volumeById(draft, s.volume);
      if (!v) return false;
      if (w !== null && Number.isFinite(w) && w > 0) {
        v.x += (v.w - w) / 2;
        v.w = w;
      }
      if (d !== null && Number.isFinite(d) && d > 0) {
        v.y += (v.d - d) / 2;
        v.d = d;
      }
      delete v.reliefs;
      return true;
    });
  }

  /**
   * The block a block is measured from: the one it stands on (the most floor
   * shared on the level under it), or for a block on the ground the first
   * ground block. Null for that first block itself.
   */
  referenceOf(b: Building, v: Volume): Volume | null {
    if (v.base === 0) {
      const first = b.volumes.find((o) => o.base === 0);
      return first && first.id !== v.id ? first : null;
    }
    let best: Volume | null = null;
    let area = 0;
    for (const o of b.volumes) {
      if (o.id === v.id || !(o.base < v.base && o.base + o.storeys.length >= v.base)) continue;
      const a = overlapArea(localFootprint(o), localFootprint(v));
      if (a > area) { area = a; best = o; }
    }
    return best;
  }

  /** The selected block's centre, as an offset from its reference block's centre (world units). */
  blockOffset(): { x: number; y: number } | null {
    const b = this.selected();
    const v = b && this.selection ? volumeById(b, this.selection.volume) : undefined;
    const r = b && v ? this.referenceOf(b, v) : null;
    if (!v || !r) return null;
    return { x: v.x + v.w / 2 - (r.x + r.w / 2), y: v.y + v.d / 2 - (r.y + r.d / 2) };
  }

  /** Puts the selected block's centre at an offset from its reference block's centre. */
  setBlockOffset(x: number | null, y: number | null): void {
    const s = this.selection;
    if (!s) return;
    this.onSelected((draft) => {
      const v = volumeById(draft, s.volume);
      const r = v ? this.referenceOf(draft, v) : null;
      if (!v || !r) return false;
      if (x !== null && Number.isFinite(x)) v.x = r.x + r.w / 2 + x - v.w / 2;
      if (y !== null && Number.isFinite(y)) v.y = r.y + r.d / 2 + y - v.d / 2;
      return true;
    });
  }

  /** Turns the selected block about its own centre by `degrees` (the block, not the building). */
  turnBlock(degrees: number): void {
    const s = this.selection;
    if (!s) return;
    this.onSelected((draft) => {
      const v = volumeById(draft, s.volume);
      if (!v) return false;
      const cx = v.x + v.w / 2;
      const cy = v.y + v.d / 2;
      const a = (degrees * Math.PI) / 180;
      const c = Math.cos(a);
      const sn = Math.sin(a);
      const ring = localFootprint(v).map((p) => ({
        x: cx + (p.x - cx) * c - (p.y - cy) * sn,
        y: cy + (p.x - cx) * sn + (p.y - cy) * c,
      }));
      if (!setVolumePlan(v, ring)) return false;
      delete v.reliefs;
      delete v.facadeGeometry;
      return true;
    });
  }

  /** The level the selected block starts on. */
  setBlockBase(level: number): void {
    const s = this.selection;
    if (!s) return;
    this.onSelected((draft) => {
      const v = volumeById(draft, s.volume);
      if (!v || !Number.isInteger(level) || level < 0) return false;
      v.base = level;
      return true;
    });
  }

  /**
   * A copy of the selected block, set beside it on its free side (or on top
   * when it stands alone): the way a symmetric wing or a repeated tower is
   * made. It joins the building; any overlap is cut out of the copy.
   */
  copyBlock(): void {
    const s = this.selection;
    if (!s) return;
    let made: number | null = null;
    const result = this.onSelected((draft) => {
      const v = volumeById(draft, s.volume);
      if (!v) return false;
      const copy = structuredClone(v);
      copy.id = draft.nextVolumeId++;
      copy.x += v.w;
      draft.volumes.push(copy);
      made = copy.id;
      return true;
    });
    if (result.ok && made !== null) this.selection = { building: s.building, volume: made, bay: null };
    this.host.changed();
  }

  // ------------------------------------------------------------ interior

  /** The interior view: the selected building drawn cut open above this level, or null. */
  cutLevel: number | null = null;
  /** The way the camera looks (world, horizontal), set by the wiring each frame. */
  cutView: { x: number; y: number } = { x: 0, y: 1 };
  /** A core in hand (lift or stair), or 'remove': the next click on the cut floor places or removes one. */
  coreKind: CoreKind | 'remove' | null = null;
  private cutKey = '';
  private cutPreview: BuildingPreview | null = null;

  setCutLevel(level: number | null): void {
    this.cutLevel = level;
    this.host.changed();
  }

  armCore(kind: CoreKind | 'remove' | null): void {
    this.coreKind = kind;
    if (kind !== null && this.cutLevel === null) this.cutLevel = 0;
    this.host.changed();
  }

  /** The selected building cut open at the interior level, drawn solid in place of the stored one. */
  interiorPreview(): BuildingPreview | null {
    const b = this.selected();
    if (this.cutLevel === null || !b) return null;
    const level = Math.max(0, Math.min(this.cutLevel, topLevel(b) - 1));
    const dir = Math.round(Math.atan2(this.cutView.y, this.cutView.x) / (Math.PI / 4));
    const key = `${JSON.stringify(b)}|${level}|${dir}`;
    if (key !== this.cutKey) {
      this.cutKey = key;
      const a = dir * (Math.PI / 4);
      const cut = cutOpen(cloneBuilding(b), level, { x: Math.cos(a), y: Math.sin(a) });
      this.serial++;
      this.cutPreview = { building: cut, valid: true, problem: null, hides: b.id, serial: this.serial, solid: true };
    }
    return this.cutPreview;
  }

  /** Places a core where the cut floor is clicked, through every level of the building; or removes the one clicked. */
  private placeCore(screen: Vec2): void {
    const b = this.selected();
    const kind = this.coreKind;
    if (!b || !kind) return;
    const level = this.cutLevel ?? 0;
    const p = worldToLocal(b, this.view.planeAt(screen, this.floorOf(b) + levelElevation(b, level)));
    const u = b.module;
    this.onSelected((draft) => {
      if (kind === 'remove') {
        const before = draft.cores.length;
        draft.cores = draft.cores.filter((c) => {
          const w = c.kind === 'stair' ? 2 * u : u;
          return !(p.x >= c.x && p.x <= c.x + w && p.y >= c.y && p.y <= c.y + u);
        });
        return draft.cores.length !== before;
      }
      const w = kind === 'stair' ? 2 * u : u;
      const id = draft.cores.reduce((n, c) => Math.max(n, c.id), 0) + 1;
      draft.cores.push({
        id, kind,
        x: Math.round((p.x - w / 2) / GRID) * GRID,
        y: Math.round((p.y - u / 2) / GRID) * GRID,
        from: 0, to: Math.max(0, topLevel(draft) - 1),
      });
      return true;
    });
  }

  /**
   * Furnishing, as in The Sims: a piece (or a light) in hand is put down where
   * the cut floor is clicked; 'move' picks a piece up with one click and puts
   * it down with the next; 'remove' takes away the one clicked. R turns the
   * piece in hand, or the one being moved, a quarter turn.
   */
  furnitureKind: FurnitureKind | 'move' | 'remove' | null = null;
  furnitureAngle = 0;
  /** The piece picked up by 'move', by index on the floor shown. */
  private carried: number | null = null;

  armFurniture(kind: FurnitureKind | 'move' | 'remove' | null): void {
    this.furnitureKind = kind;
    this.carried = null;
    if (kind !== null && this.cutLevel === null) this.cutLevel = 0;
    this.host.changed();
  }

  /** A quarter turn for the piece in hand, or for the one being moved. */
  turnFurniture(): void {
    this.furnitureAngle = (this.furnitureAngle + Math.PI / 2) % (Math.PI * 2);
    const carried = this.carried;
    if (carried !== null) {
      const level = this.cutLevel ?? 0;
      this.onSelected((draft) => {
        const list = [...(draft.furnishing?.[String(level)] ?? furnishingOf(draft, level))];
        const it = list[carried];
        if (!it) return false;
        list[carried] = { ...it, angle: (it.angle + Math.PI / 2) % (Math.PI * 2) };
        draft.furnishing = { ...(draft.furnishing ?? {}), [String(level)]: list };
        return true;
      });
    }
    this.host.changed();
  }

  private editFurniture(screen: Vec2): void {
    const b = this.selected();
    const kind = this.furnitureKind;
    if (!b || !kind) return;
    const level = this.cutLevel ?? 0;
    const p = worldToLocal(b, this.view.planeAt(screen, this.floorOf(b) + levelElevation(b, level)));
    const snap = (v: number): number => Math.round(v / (GRID / 2)) * (GRID / 2);
    // The piece under the pointer: the nearest whose footprint holds it.
    const under = (list: readonly { kind: string; x: number; y: number }[]): number => {
      let best = -1;
      let bestD = Infinity;
      list.forEach((it, i) => {
        const size = FURNITURE_SIZE[it.kind as FurnitureKind];
        const reach = size ? m(Math.max(size[0], size[1])) / 2 + m(0.25) : m(0.6);
        const d = Math.hypot(it.x - p.x, it.y - p.y);
        if (d < reach && d < bestD) { best = i; bestD = d; }
      });
      return best;
    };
    if (kind === 'move' && this.carried === null) {
      const list = b.furnishing?.[String(level)] ?? furnishingOf(b, level);
      const i = under(list);
      if (i >= 0) this.carried = i;
      this.host.changed();
      return;
    }
    const carried = this.carried;
    this.onSelected((draft) => {
      // The first change to a floor keeps what was there: the arrangement made
      // for the building's function becomes the player's own.
      const list = [...(draft.furnishing?.[String(level)] ?? furnishingOf(draft, level))];
      if (kind === 'remove') {
        const i = under(list);
        if (i < 0) return false;
        list.splice(i, 1);
      } else if (kind === 'move') {
        const it = carried === null ? undefined : list[carried];
        if (!it) return false;
        list[carried!] = { ...it, x: snap(p.x), y: snap(p.y) };
      } else {
        list.push({ kind, x: snap(p.x), y: snap(p.y), angle: this.furnitureAngle });
      }
      draft.furnishing = { ...(draft.furnishing ?? {}), [String(level)]: list };
      return true;
    });
    if (kind === 'move') this.carried = null;
  }

  /** A basic shape in hand: the next click drops it on a roof, against a wall, or on the ground. */
  primitive: Primitive | null = null;

  armPrimitive(p: Primitive | null): void {
    this.primitive = p;
    if (!p) this.setPreview(null);
    this.host.changed();
  }

  /**
   * The basic shape in hand, placed where the pointer is - on a roof it stands
   * on that roof, centred there; against a wall it stands out from the wall,
   * from the block's floor up to the floor pointed at; on open ground it is a
   * new building - as a draft: the ghost while it is carried, the edit when it
   * is dropped. Null when there is nothing to put it on.
   */
  private primitiveDraft(hit: BuildingHit | null, world: Vec2): { draft: Building; existing: BuildingId | null; made: number | null } | null {
    const p = this.primitive;
    if (!p) return null;
    const spec = PRIMITIVES[p];
    const size = m(6);
    const ring = (cx: number, cy: number, w: number, d: number, angle = 0): Vec2[] => {
      const c = Math.cos(angle);
      const s = Math.sin(angle);
      return shapePoints(spec.shape).map((q) => {
        const lx = (q.x - 0.5) * w;
        const ly = (q.y - 0.5) * d;
        return { x: cx + lx * c - ly * s, y: cy + lx * s + ly * c };
      });
    };
    const shape = (v: Volume): void => {
      v.roof = spec.roof;
      if (spec.roof !== 'flat') v.pitch = spec.pitch;
    };
    if (!hit) {
      const body = shapeBody(spec.shape, size, size, 3);
      const draft = { ...instantiate(body, world, 0), id: PREVIEW_ID } as Building;
      const v = draft.volumes[0];
      if (v) shape(v);
      return { draft, existing: null, made: v?.id ?? null };
    }
    const building = this.host.context().doc.buildings.get(hit.building);
    const source = building ? volumeById(building, hit.volume) : undefined;
    if (!building || !source) return null;
    const draft = cloneBuilding(building);
    const local = worldToLocal(building, { x: hit.x, y: hit.y });
    let made: number | null;
    if (hit.face === 'top') {
      made = addPlanMass(draft, source.id, ring(local.x, local.y, size, size), source.base + source.storeys.length, 2);
    } else {
      const f = edgeFrame(source, hit.face);
      const depth = m(4);
      const along = (local.x - f.x) * f.tx + (local.y - f.y) * f.ty;
      const cx = f.x + f.tx * along + f.nx * depth / 2;
      const cy = f.y + f.ty * along + f.ny * depth / 2;
      const angle = Math.atan2(f.ty, f.tx);
      made = addPlanMass(draft, source.id, ring(cx, cy, size, depth, angle), source.base, Math.max(1, hit.storey + 1));
    }
    const v = made !== null ? volumeById(draft, made) : undefined;
    if (v) {
      shape(v);
      if (hit.face !== 'top') v.base = source.base;
    }
    // Dropped on top, the roof under it stays as it was: blocks never change
    // one another.
    const under = volumeById(draft, source.id);
    if (under && hit.face === 'top') under.roof = source.roof;
    return made !== null ? { draft, existing: building.id, made } : null;
  }

  /** The ghost of the basic shape in hand, where it would land. */
  private hoverPrimitive(screen: Vec2, world: Vec2): void {
    const found = this.primitiveDraft(this.pick(screen), world);
    if (!found) { this.setPreview(null); return; }
    const problem = validateBuilding(this.host.context(), found.draft, found.existing ?? undefined);
    this.setPreview({ building: found.draft, valid: problem === null, problem, hides: found.existing, serial: 0 });
  }

  /** Drops the basic shape in hand where the pointer is (see `primitiveDraft`). It lands as a block, edited like any other. */
  private dropPrimitive(hit: BuildingHit | null, world: Vec2): void {
    const found = this.primitiveDraft(hit, world);
    if (!found) return;
    this.setPreview(null);
    const { draft, existing, made } = found;
    const result = existing === null
      ? this.host.commit(() => addBuildingRecord(this.host.context(), stripId(draft)))
      : this.host.commit(() => editBuilding(this.host.context(), existing, (d) => {
        d.volumes = draft.volumes;
        return true;
      }));
    if (result.ok) {
      const id = existing ?? result.id;
      if (id !== undefined && made !== null) this.selection = { building: id, volume: made, bay: null };
    }
    this.report(result);
    this.host.changed();
  }

  /** Point mode: every corner of the selected block is a handle, boxes included. */
  pointMode = false;

  setPointMode(on: boolean): void {
    this.pointMode = on;
    this.host.changed();
  }

  /** Grows (or with a negative distance shrinks) the selected block's whole plan. */
  offsetBlock(distance: number): void {
    const s = this.selection;
    if (!s) return;
    this.onSelected((draft) => {
      const v = volumeById(draft, s.volume);
      return v ? offsetPlan(v, distance, false) : false;
    });
  }

  /** Bevels every corner of the selected block, or only the picked corner in point mode. */
  bevelBlock(distance: number, corner?: number): void {
    const s = this.selection;
    if (!s) return;
    this.onSelected((draft) => {
      const v = volumeById(draft, s.volume);
      return v ? bevelPlan(v, distance, corner) : false;
    });
    if (corner !== undefined) this.selection = { ...s, vertex: null };
  }

  /** The face in hand: the picked bay's side, or the side nearest the camera's pick. */
  private faceInHand(): number | null {
    return this.selection?.bay?.side ?? null;
  }

  /** Extrudes the picked face along its normal: positive out, negative in (push/pull). */
  extrudeFace(distance: number): void {
    const s = this.selection;
    const side = this.faceInHand();
    if (!s || side === null) {
      this.host.flash('builder.pickFace');
      return;
    }
    this.onSelected((draft) => {
      const v = volumeById(draft, s.volume);
      if (!v) return false;
      if (v.outline) return movePlanEdge(v, side, distance, false);
      return isSide(side) ? opResize(draft, v.id, side, distance, false) : false;
    });
  }

  /**
   * Extrudes the picked face as a NEW block: a brick the face's width and
   * the block's height, set against it - then edited like any other block.
   */
  extrudeFaceBlock(depth: number): void {
    const s = this.selection;
    const side = this.faceInHand();
    const b = this.selected();
    if (!s || side === null || !b) {
      this.host.flash('builder.pickFace');
      return;
    }
    let made: number | null = null;
    const result = this.onSelected((draft) => {
      const v = volumeById(draft, s.volume);
      if (!v) return false;
      const f = edgeFrame(v, side);
      const ring = [
        { x: f.x, y: f.y },
        { x: f.x + f.tx * f.length, y: f.y + f.ty * f.length },
        { x: f.x + f.tx * f.length + f.nx * depth, y: f.y + f.ty * f.length + f.ny * depth },
        { x: f.x + f.nx * depth, y: f.y + f.ny * depth },
      ];
      made = addPlanMass(draft, v.id, ring, v.base, v.storeys.length);
      const block = made !== null ? volumeById(draft, made) : undefined;
      if (block) {
        block.base = v.base;
        block.roof = v.roof;
      }
      return made !== null;
    });
    if (result.ok && made !== null) this.selection = { building: s.building, volume: made, bay: null };
    this.host.changed();
  }

  /**
   * Insets the picked face: its bays, all but a frame of one bay at each end
   * and the top and bottom storeys, set back `depth` - a recessed panel, a
   * loggia front.
   */
  insetFace(depth: number): void {
    const s = this.selection;
    const side = this.faceInHand();
    const b = this.selected();
    const v = b && s ? volumeById(b, s.volume) : undefined;
    if (!s || side === null || !b || !v) {
      this.host.flash('builder.pickFace');
      return;
    }
    const bays = baysOn(b, v, side);
    const storeys = v.storeys.length;
    const region: FaceRegion = {
      side,
      bay0: bays > 2 ? 1 : 0,
      bay1: bays > 2 ? bays - 2 : bays - 1,
      storey0: storeys > 2 ? 1 : 0,
      storey1: storeys > 2 ? storeys - 2 : storeys - 1,
    };
    this.onSelected((draft) => opSetRelief(draft, v.id, region, -Math.abs(depth), false));
  }

  /** What the selected building is for (null: nothing in particular). */
  setFunction(fn: BuildingFunction | null): void {
    this.onSelected((draft) => {
      if (fn) draft.function = fn;
      else delete draft.function;
      return true;
    });
  }

  /** How the selected block combines with the others: solid (null), void, intersect or exclusive. */
  setBlockMode(mode: BlockMode | null): void {
    const s = this.selection;
    if (!s) return;
    this.onSelected((draft) => {
      const v = volumeById(draft, s.volume);
      if (!v) return false;
      if (mode) v.mode = mode;
      else delete v.mode;
      // A building keeps at least one block of mass.
      return draft.volumes.some((o) => !o.mode || o.mode === 'xor');
    });
  }

  /**
   * Takes the selected block - and what stands on it - out of the building
   * into a building of its own, in the same place: what was joined can be
   * unjoined.
   */
  detachBlock(): void {
    const s = this.selection;
    const b = this.selected();
    if (!s || !b || b.volumes.length < 2) return;
    const v = volumeById(b, s.volume);
    if (!v) return;
    const moving = new Set<number>([v.id]);
    for (let grew = true; grew;) {
      grew = false;
      for (const o of b.volumes) {
        if (moving.has(o.id)) continue;
        if (b.volumes.some((u) => moving.has(u.id) && o.base === u.base + u.storeys.length &&
          overlapArea(localFootprint(o), localFootprint(u)) > 1e-6)) {
          moving.add(o.id);
          grew = true;
        }
      }
    }
    if (moving.size === b.volumes.length) return;
    const lowest = Math.min(...b.volumes.filter((o) => moving.has(o.id)).map((o) => o.base));
    let newId: BuildingId | null = null;
    const result = this.host.commit(() => {
      const ctx = this.host.context();
      const rest = cloneBuilding(b);
      rest.volumes = rest.volumes.filter((o) => !moving.has(o.id));
      const own = cloneBuilding(b);
      own.volumes = own.volumes.filter((o) => moving.has(o.id)).map((o) => ({ ...o, base: o.base - lowest }));
      delete own.elements;
      const kept = replaceBuilding(ctx, rest, []);
      if (!kept.ok) return kept;
      const added = addBuildingRecord(ctx, stripId(own), [b.id]);
      if (added.ok) newId = added.id ?? null;
      return added;
    });
    if (result.ok && newId !== null) this.selection = { building: newId, volume: (volumeById(this.selected() ?? b, v.id) ?? v).id, bay: null };
    this.report(result);
    this.host.changed();
  }

  setRoofDetailFlag(flag: 'none' | 'plain' | 'saoPaulo' | 'saoPauloState'): void {
    const s = this.selection, id = this.selectedRoofDetail;
    if (!s || id === null) return;
    this.onSelected((draft) => updateRoofDetail(draft, s.volume, id, { flag }));
  }

  get planArea(): number {
    const b = this.selected();
    if (!b) return 0;
    return b.volumes.filter((v) => v.base === 0).reduce((area, v) => area + Math.abs(signedArea(localFootprint(v))) * METERS_PER_UNIT ** 2, 0);
  }

  get planHeight(): number | null {
    if (this.planAction === 'new' || this.planAction === 'ground') return null;
    const building = this.selected();
    const volume = building && this.selection ? volumeById(building, this.selection.volume) : undefined;
    if (!building || !volume) return null;
    const level = this.planAction === 'top' ? volume.base + volume.storeys.length : volume.base;
    return this.floorOf(building) + levelElevation(building, level);
  }

  private pointOnPlan(screen: Vec2, world: Vec2, free: boolean): Vec2 {
    const height = this.planHeight;
    const p = height === null ? world : this.view.planeAt(screen, height);
    if (free) return p;
    const building = this.selected();
    let closest: Vec2 | null = null;
    let best = this.view.pickPixels * .8;
    if (building) for (const volume of building.volumes) {
      const ring = localFootprint(volume).map((point) => localToWorld(building, point.x, point.y));
      const screenAt = (point: Vec2): Vec2 => this.view.project(point.x, point.y,
        height ?? this.view.groundAt(point.x, point.y));
      for (const vertex of ring) {
        const q = screenAt(vertex), distance = Math.hypot(q.x - screen.x, q.y - screen.y);
        if (distance < best) { best = distance; closest = vertex; }
      }
      if (closest) continue;
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i]!, b = ring[(i + 1) % ring.length]!;
        const dx = b.x - a.x, dy = b.y - a.y, length2 = dx * dx + dy * dy;
        if (length2 < 1e-9) continue;
        const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / length2));
        const q = { x: a.x + dx * t, y: a.y + dy * t };
        const projected = screenAt(q), distance = Math.hypot(projected.x - screen.x, projected.y - screen.y);
        if (distance < best) { best = distance; closest = q; }
      }
    }
    return closest ?? { x: Math.round(p.x / GRID) * GRID, y: Math.round(p.y / GRID) * GRID };
  }

  chooseBlueprint(key: string): void {
    // A building of the city's catalogue (`city:<function>`), or a plain model.
    const city = key.startsWith('city:') ? cityBuilding(key.slice(5)) : undefined;
    if (city) {
      this.useBody(city.body, key);
      return;
    }
    const bp = blueprintByKey(key);
    if (!bp) return;
    this.useBody(bp.body, key);
  }

  /** Places from an arbitrary body (a user blueprint, the clipboard). */
  useBody(body: BlueprintBody, key: string | null): void {
    this.body = JSON.parse(JSON.stringify(body)) as BlueprintBody;
    this.blueprintKey = key;
    this.stage = 'sketch';
    this.component = null;
    // Picking a model puts the plan pencil down: with it still in hand, the
    // click meant to set the house on the ground started a plan instead.
    this.activeModelTool = null;
    this.planPoints = null;
    this.setMode('place');
  }

  /** The generator: a neutral block of the current parameters. */
  generate(patch: Partial<PlaceParameters> = {}): void {
    Object.assign(this.params, patch);
    const p = this.params;
    this.useBody(generateBlock(p.width, p.depth, p.storeys, { module: p.module, storeyHeight: p.storeyHeight }), 'block');
  }

  /** Runs a validated command on the selected building, as one undo step. */
  private onSelected(op: (draft: Building) => boolean): EditResult {
    const b = this.selected();
    if (!b) return { ok: false, problem: 'missing' };
    const result = this.host.commit(() => editBuilding(this.host.context(), b.id, op));
    this.report(result);
    return result;
  }

  private report(result: EditResult): void {
    this.problem = result.ok ? null : (result.problem === 'missing' ? null : result.problem ?? null);
    if (!result.ok && result.problem && result.problem !== 'missing') this.host.flash(`building.problem.${result.problem}`);
    this.sync();
    this.host.changed();
  }

  addStoreys(delta: number): void {
    const s = this.selection;
    if (!s) return;
    this.onSelected((draft) => {
      const v = volumeById(draft, s.volume);
      return v ? opSetStoreys(draft, s.volume, v.storeys.length + delta) : false;
    });
  }

  setStoreys(count: number): void {
    const s = this.selection;
    if (!s) return;
    this.onSelected((draft) => opSetStoreys(draft, s.volume, count));
  }

  resize(side: Side, delta: number): void {
    const s = this.selection;
    if (!s) return;
    this.onSelected((draft) => opResize(draft, s.volume, side, delta));
  }

  addWing(side: FaceId): void {
    const s = this.selection;
    if (!s) return;
    let created: number | null = null;
    const result = this.onSelected((draft) => {
      created = opAddWing(draft, s.volume, side);
      return created !== null;
    });
    if (result.ok && created !== null) this.selection = { building: s.building, volume: created, bay: null };
    this.host.changed();
  }

  addSetback(inset?: number, storeys?: number): void {
    const s = this.selection;
    if (!s) return;
    let created: number | null = null;
    const result = this.onSelected((draft) => {
      created = opAddSetback(draft, s.volume, inset, storeys);
      return created !== null;
    });
    if (result.ok && created !== null) this.selection = { building: s.building, volume: created, bay: null };
    if (!result.ok && created === null) this.problem = 'setback';
    if (result.ok) { const building = this.selected(); if (building) this.host.focus?.(building); }
    this.host.changed();
  }

  /**
   * One more storey in the selected mass, a copy of storey `at`, put in at
   * `at` (below it) or `at + 1` (above it); whatever stands on the mass rises.
   */
  insertStorey(at: number, above: boolean): void {
    const s = this.selection;
    if (!s) return;
    this.onSelected((draft) => {
      const v = volumeById(draft, s.volume);
      if (!v) return false;
      const index = Math.max(0, Math.min(v.storeys.length - 1, at));
      const copy = structuredClone(v.storeys[index]!);
      if (!opSetStoreys(draft, v.id, v.storeys.length + 1)) return false;
      v.storeys.pop();
      v.storeys.splice(above ? index + 1 : index, 0, copy);
      return true;
    });
  }

  splitAtFloor(afterFloor: number): void {
    const s = this.selection;
    if (!s) return;
    let created: number | null = null;
    const result = this.onSelected((draft) => {
      created = splitVolumeAtFloor(draft, s.volume, afterFloor);
      return created !== null;
    });
    if (result.ok && created !== null) this.selection = { building: s.building, volume: created, bay: null };
    if (result.ok) this.focusSelected();
    this.host.changed();
  }

  reshapeTier(shape: PlanShape): void {
    const s = this.selection, volume = this.selected()?.volumes.find((v) => v.id === s?.volume);
    if (!s || !volume) return;
    if (volume.reliefs?.length) { this.host.flash('building.reshapeRelief'); return; }
    const result = this.onSelected((draft) => reshapeTierPlan(draft, s.volume, shape));
    if (result.ok) this.selection = { building: s.building, volume: s.volume, bay: null };
    this.host.changed();
  }

  setGroundHeight(height: number): void {
    this.onSelected((draft) => opSetParameters(draft, { groundHeight: height }));
  }

  setLevelHeight(level: number, height: number | null): void {
    this.onSelected((draft) => opSetLevelHeight(draft, level, height));
  }

  addUpperShape(shape: PlanShape | 'match', inset: number, storeys: number, placement: UpperMassPlacement = {}): void {
    const s = this.selection;
    if (!s) return;
    let created: number | null = null;
    const result = this.onSelected((draft) => {
      created = addShapedUpperMass(draft, s.volume, shape, inset, storeys, placement);
      return created !== null;
    });
    if (result.ok && created !== null) this.selection = { building: s.building, volume: created, bay: null };
    if (!result.ok && created === null) this.problem = 'setback';
    if (result.ok) { const building = this.selected(); if (building) this.host.focus?.(building); }
    this.host.changed();
  }

  removeVolume(): void {
    const s = this.selection;
    if (!s) return;
    const result = this.host.commit(() => removeVolume(this.host.context(), s.building, s.volume));
    this.report(result);
  }

  setRoof(roof: RoofKind): void {
    const s = this.selection;
    if (!s) return;
    this.onSelected((draft) => opSetRoof(draft, s.volume, roof));
  }

  setParameter(name: keyof PlaceParameters, value: number): void {
    if (this.mode === 'edit' && this.selection) {
      const s = this.selection;
      switch (name) {
        case 'storeys':
          this.setStoreys(value);
          return;
        case 'width':
        case 'depth':
          this.onSelected((draft) => {
            const v = volumeById(draft, s.volume);
            if (!v) return false;
            return opResize(draft, s.volume, name === 'width' ? 1 : 2, value - (name === 'width' ? v.w : v.d));
          });
          return;
        case 'storeyHeight':
          this.onSelected((draft) => opSetParameters(draft, { storeyHeight: value }));
          return;
        case 'module':
          this.onSelected((draft) => opSetParameters(draft, { module: value }));
          return;
      }
    }
    this.generate({ [name]: value } as Partial<PlaceParameters>);
  }

  cyclePalette(): void {
    this.onSelected((draft) => opSetParameters(draft, { palette: draft.palette + 1 }));
  }

  setMaterialScope(scope: MaterialScope): void {
    this.materialScope = scope;
    this.host.changed();
  }

  /** The surface a material pick paints now, or null (a face scope needs a clicked facade). */
  materialTarget(): MaterialTarget | null {
    const s = this.selection;
    if (!s) return null;
    switch (this.materialScope) {
      case 'building': return { scope: 'building', slot: 'wall' };
      case 'volume': return { scope: 'volume', volume: s.volume, slot: 'wall' };
      case 'roof': return { scope: 'volume', volume: s.volume, slot: 'roof' };
      case 'face': return s.bay ? { scope: 'side', volume: s.volume, side: s.bay.side } : null;
      case 'floor': return { scope: 'floor', volume: s.volume, floor: s.bay?.storey ?? 0, face: s.bay?.side ?? 0 };
    }
  }

  /** The material the current target is built in. */
  currentMaterial(): MaterialSpec | null {
    const b = this.selected();
    const target = this.materialTarget();
    return b && target ? materialAt(b, target) : null;
  }

  /** Dresses the whole selected building in a factory style. */
  applyStyle(key: string): void {
    this.onSelected((draft) => applyStyle(draft, key));
  }

  /** Paints the current target: a new finish keeps its colour, a new colour keeps its finish. */
  paint(patch: Partial<MaterialSpec>): void {
    const target = this.materialTarget();
    if (!target) {
      this.host.flash('building.material.pickFace');
      return;
    }
    this.onSelected((draft) => {
      const current = materialAt(draft, target);
      if (!current) return false;
      return applyMaterial(draft, target, { ...current, ...patch });
    });
  }

  /**
   * The canvas paint tool as a BRUSH: whatever the pointer is over is painted,
   * and a drag paints face after face without ever stopping to select one.
   * One commit per face crossed, so undo steps back wall by wall.
   */
  private lastPaintKey: string | null = null;

  paintStroke(screen: Vec2): boolean {
    if (this.activeModelTool !== 'paint') return false;
    const hit = this.pick(screen);
    if (!hit) return false;
    const building = this.host.context().doc.buildings.get(hit.building);
    if (!building) return false;
    const key = `${hit.building}:${hit.volume}:${String(hit.face)}:${hit.storey}:${hit.index}`;
    if (key === this.lastPaintKey) return false;
    this.lastPaintKey = key;
    const bay = hit.face === 'top' ? null : { storey: hit.storey, side: hit.face, index: hit.index };
    this.selection = { building: hit.building, volume: hit.volume, bay };
    if (this.mode === 'place') this.setMode('edit');
    // A roof face paints the roof; a wall face paints that wall (the whole
    // side, so one drag down a facade is one decision, not one per bay).
    this.materialScope = hit.face === 'top' ? 'roof' : 'face';
    this.paint(this.paintBrush);
    this.host.changed();
    return true;
  }

  /** The stroke is over: the next press starts a new one. */
  endPaintStroke(): void {
    this.lastPaintKey = null;
  }

  /** Sets the swatch carried by the canvas paint tool; the edit happens on a face click. */
  setPaintBrush(patch: Partial<MaterialSpec>): void {
    this.paintBrush = { ...this.paintBrush, ...patch };
    this.host.changed();
  }

  // ------------------------------------------------------------ free elements

  /** Arms (or with the same kind again, disarms) a free element to place on the selected building. */
  armElement(kind: ElementKind | null): void {
    this.armed = this.armed === kind ? null : kind;
    if (this.armed) {
      this.component = null;
      if (this.mode !== 'edit') this.setMode('edit');
    }
    this.setPreview(null);
    this.host.changed();
  }

  /**
   * A run of fence, wall or paving, traced as a path: the points are clicked
   * like a plan's, and finishing lays one part per segment, end to end - the
   * way a road is drawn, not a part at a time.
   */
  pathKind: ElementKind | null = null;

  /** The Move block tool: the press takes hold of the selected mass itself. */
  massMoveArmed = false;

  startElementRun(kind: ElementKind): void {
    if (!this.selected()) {
      this.host.flash('building.selectFirst');
      return;
    }
    this.clearArmingFor('path');
    this.pathKind = kind;
    this.planAction = 'new';
    this.planPoints = [];
    this.planCursor = null;
    this.stage = 'shape';
    this.mode = 'place';
    this.problem = null;
    this.setPreview(null);
    this.host.changed();
  }

  /** Straightens the run while the pointer moves, so a path follows the hand. */
  private finishElementRun(): void {
    const points = this.planPoints ?? [];
    const kind = this.pathKind;
    this.pathKind = null;
    this.planPoints = null;
    this.planCursor = null;
    const building = this.selected();
    if (!kind || !building || points.length < 2) {
      this.setPreview(null);
      this.host.changed();
      return;
    }
    const local = points.map((p) => worldToLocal(building, p));
    // A stair laid along the path climbs the floor being edited, its rise
    // spread over the segments in proportion to their length: the run turns
    // where the trace turns and still lands on the floor above.
    const selection = this.selection;
    const volume = volumeById(building, selection?.volume ?? 0) ?? building.volumes[0];
    const level = volume ? volume.base + (selection?.bay?.storey ?? 0) : 0;
    const startZ = levelElevation(building, level);
    const rise = Math.max(m(0.5), levelElevation(building, level + 1) - startZ);
    const lengths: number[] = [];
    let total = 0;
    for (let i = 1; i < local.length; i++) {
      const a = local[i - 1] as Vec2;
      const b = local[i] as Vec2;
      const run = Math.hypot(b.x - a.x, b.y - a.y);
      lengths.push(run);
      total += run;
    }
    let climbed = 0;
    const result = this.host.commit(() => editBuilding(this.host.context(), building.id, (draft) => {
      let added = 0;
      const [dw, dd, dh] = ELEMENT_DEFAULTS[kind];
      for (let i = 1; i < local.length; i++) {
        const a = local[i - 1] as Vec2;
        const b = local[i] as Vec2;
        const run = lengths[i - 1] as number;
        if (run < m(0.4)) continue;
        const angle = Math.atan2(b.y - a.y, b.x - a.x);
        if (kind === 'stair') {
          const step = (rise * run) / Math.max(1e-6, total);
          opAddElement(draft, {
            kind,
            x: (a.x + b.x) / 2,
            y: (a.y + b.y) / 2,
            facing: 0,
            w: Math.max(dw, m(1.2)),
            d: run,
            z: startZ + climbed,
            h: Math.max(m(0.2), step),
            angle,
          });
          climbed += step;
          added++;
          continue;
        }
        // A paving run is a band: its traced length along, its own width across.
        const across = kind === 'pavement' ? Math.max(dd, m(1.6)) : Math.max(dd, m(0.12));
        const along = kind === 'pavement' || kind === 'wall' || kind === 'slab' ? run : Math.max(dw, run);
        opAddElement(draft, {
          kind,
          x: (a.x + b.x) / 2,
          y: (a.y + b.y) / 2,
          facing: 0,
          w: along,
          d: across,
          z: 0,
          h: Math.max(dh, m(0.12)),
          angle,
        });
        added++;
      }
      return added > 0;
    }));
    if (result.ok) this.host.flash('builder.runPlaced');
    this.report(result);
  }

  private clearArmingFor(keep: 'path'): void {
    void keep;
    this.armed = null;
    this.roofDetailKind = null;
    this.component = null;
    this.activeModelTool = null;
  }

  /** The selected free element, if one is. */
  selectedElement(): BuildingElement | null {
    const id = this.selection?.element;
    if (id === undefined || id === null) return null;
    return this.selected()?.elements?.find((e) => e.id === id) ?? null;
  }

  /**
   * The ghost of the armed element under the pointer: against the facade bay
   * it points at (the first candidate that fits - a stair that cannot run out
   * turns along the facade), or on the ground around the building.
   */
  private hoverElement(screen: Vec2, world: Vec2): void {
    const b = this.selected();
    const kind = this.armed;
    if (!b || !kind) return;
    const hit = pickBuilding([b], this.view.ray(screen), (x) => this.floorOf(x));
    let candidates: Omit<BuildingElement, 'id'>[];
    const v = hit && hit.face !== 'top' && hit.element === undefined ? volumeById(b, hit.volume) : undefined;
    if (hit && v && hit.face !== 'top') {
      candidates = elementsAgainstBay(b, v, { volume: v.id, side: hit.face, index: hit.index, storey: hit.storey }, kind);
    } else {
      const local = worldToLocal(b, world);
      const f = footprintBox(b);
      // Facing away from the building, towards the side the pointer is off.
      const dx = local.x < f.x0 ? f.x0 - local.x : local.x > f.x1 ? local.x - f.x1 : 0;
      const dy = local.y < f.y0 ? f.y0 - local.y : local.y > f.y1 ? local.y - f.y1 : 0;
      const facing: Side = dx > dy ? (local.x < f.x0 ? 3 : 1) : local.y > f.y1 ? 2 : 0;
      candidates = [elementAt(b, kind, local, facing)];
    }
    let first: { building: Building; problem: ReturnType<typeof validateBuilding> } | null = null;
    for (const candidate of candidates) {
      const draft = cloneBuilding(b);
      opAddElement(draft, candidate);
      // A stair or a ramp lands at a way in: the bay it serves gets a door.
      if (v && hit && hit.face !== 'top' && (kind === 'stair' || kind === 'ramp') && hit.storey > 0) {
        opSetComponent(draft, v.id, hit.storey, hit.face, hit.index, 'door', 'bay');
      }
      const problem = validateBuilding(this.host.context(), draft, draft.id);
      if (!problem) {
        first = { building: draft, problem: null };
        break;
      }
      first ??= { building: draft, problem };
    }
    if (!first) return;
    this.problem = first.problem;
    this.setPreview({ building: first.building, valid: first.problem === null, problem: first.problem, hides: b.id, serial: 0 });
  }

  /** Stores the armed element's ghost, if it is valid. */
  private placeElement(): void {
    const preview = this.preview;
    if (!preview || preview.hides === null) return;
    if (!preview.valid) {
      if (preview.problem) this.host.flash(`building.problem.${preview.problem}`);
      return;
    }
    const draft = preview.building;
    const added = draft.elements?.[draft.elements.length - 1];
    // A part placed against an identical one is a continuation of it: two
    // flights side by side are one wide flight, not two with a gap.
    if (added) opFuseElement(draft, added.id);
    const result = this.host.commit(() => replaceBuilding(this.host.context(), draft));
    this.setPreview(null);
    if (result.ok && added && this.selection) {
      const still = draft.elements?.find((e) => e.id === added.id);
      this.selection = { ...this.selection, bay: null, element: still ? added.id : null };
    }
    this.report(result);
  }

  /** Mirrors the selected building left to right, in place. */
  mirrorSelected(): void {
    this.onSelected((draft) => opMirror(draft));
  }

  /** Repeats the selected element in a row along the building. */
  repeatElement(): void {
    const id = this.selection?.element;
    if (id === undefined || id === null) return;
    const result = this.onSelected((draft) => opRepeatElement(draft, id) > 0);
    if (!result.ok && !result.problem) this.host.flash('building.element.noRoom');
  }

  /** Resizes or turns the selected element. */
  updateElement(patch: ElementPatch): void {
    const id = this.selection?.element;
    if (id === undefined || id === null) return;
    this.onSelected((draft) => opUpdateElement(draft, id, patch));
  }

  removeElement(): void {
    const s = this.selection;
    const id = s?.element;
    if (!s || id === undefined || id === null) return;
    const result = this.onSelected((draft) => opRemoveElement(draft, id));
    if (result.ok) this.selection = { ...s, element: null };
    this.host.changed();
  }

  /** The picked rectangle of bays and storeys of one face, or null. */
  faceRegion(): FaceRegion | null {
    const s = this.selection;
    const b = this.selected();
    const v = b && s ? volumeById(b, s.volume) : undefined;
    if (!s?.bay || !b || !v) return null;
    const end = s.bayEnd && s.bayEnd.side === s.bay.side ? s.bayEnd : s.bay;
    const last = baysOn(b, v, s.bay.side) - 1;
    const top = v.storeys.length - 1;
    const clampTo = (x: number, hi: number): number => Math.max(0, Math.min(hi, x));
    return {
      side: s.bay.side,
      bay0: clampTo(Math.min(s.bay.index, end.index), last),
      bay1: clampTo(Math.max(s.bay.index, end.index), last),
      storey0: clampTo(Math.min(s.bay.storey, end.storey), top),
      storey1: clampTo(Math.max(s.bay.storey, end.storey), top),
    };
  }

  /** How far the picked region is pushed now (0 when flush or nothing is picked). */
  reliefDepth(): number {
    const region = this.faceRegion();
    const b = this.selected();
    const v = b && this.selection ? volumeById(b, this.selection.volume) : undefined;
    return region && v ? reliefAt(v, region.side, region.bay0, region.storey0)?.depth ?? 0 : 0;
  }

  /** Pushes the picked region out (positive) or in (negative); 0 flattens it. */
  setRelief(depth: number): void {
    const region = this.faceRegion();
    const s = this.selection;
    if (!region || !s) {
      this.host.flash('building.relief.pickFace');
      return;
    }
    this.onSelected((draft) => opSetRelief(draft, s.volume, region, depth));
  }

  /** Changes the selected volume's roof pitch, ridge or fall. */
  setRoofShape(shape: RoofShape): void {
    const s = this.selection;
    if (!s) return;
    this.onSelected((draft) => opSetRoofShape(draft, s.volume, shape));
  }

  armComponent(component: BayComponent | null): void {
    this.component = component;
    if (component) this.setMode('edit');
    this.host.changed();
  }

  setScope(scope: FacadeScope): void {
    this.scope = scope;
    this.host.changed();
  }

  /** Applies the armed component to the selected bay, with the current scope. */
  applyToSelectedBay(component: BayComponent): void {
    const s = this.selection;
    if (!s?.bay) return;
    const bay = s.bay;
    this.onSelected((draft) => opSetComponent(draft, s.volume, bay.storey, bay.side, bay.index, component, this.scope));
  }

  rotateSelected(angle: number): void {
    this.onSelected((draft) => opRotate(draft, angle));
  }

  duplicateSelected(): void {
    const s = this.selection;
    if (!s) return;
    const result = this.host.commit(() => duplicateBuilding(this.host.context(), s.building));
    if (result.ok && result.id !== undefined) this.selection = { building: result.id, volume: s.volume, bay: null };
    this.report(result);
  }

  deleteSelected(): void {
    const s = this.selection;
    if (!s) return;
    const result = this.host.commit(() => ({ ok: deleteBuilding(this.host.context(), s.building) }));
    if (result.ok) this.selection = null;
    this.host.changed();
  }

  copySelected(): boolean {
    const b = this.selected();
    if (!b) return false;
    this.clipboard = bodyOf(b);
    return true;
  }

  paste(): boolean {
    if (!this.clipboard) return false;
    this.rotation = this.selected()?.rotation ?? this.rotation;
    this.useBody(this.clipboard, null);
    return true;
  }

  // ------------------------------------------------------------ pointer

  private pick(screen: Vec2): BuildingHit | null {
    const doc = this.host.context().doc;
    const hides = this.preview?.hides ?? null;
    const buildings = [...doc.buildings.all()].filter((b) => b.id !== hides);
    return pickBuilding(buildings, this.view.ray(screen), (b) => this.floorOf(b));
  }

  private handleAt(screen: Vec2): Handle | null {
    let best: Handle | null = null;
    let bestDistance = this.view.pickPixels;
    for (const h of this.handles()) {
      const p = this.view.project(h.x, h.y, h.z);
      const d = Math.hypot(p.x - screen.x, p.y - screen.y);
      const reach = h.kind === 'vertex' ? Math.min(5, this.view.pickPixels)
        : h.kind === 'side' ? Math.min(6, this.view.pickPixels)
          : this.view.pickPixels;
      if (d <= Math.min(bestDistance, reach)) {
        bestDistance = d;
        best = h;
      }
    }
    return best;
  }

  /** Returns true when the tool used the press. */
  pointerDown(screen: Vec2, world: Vec2, shift: boolean): boolean {
    this.lastScreen = screen;
    this.lastWorld = world;
    if (!this.planPoints && this.activeModelTool === 'draw') {
      const hit = this.pick(screen);
      if (hit) {
        this.selection = { building: hit.building, volume: hit.volume, bay: null };
        this.mode = 'edit';
      }
      this.startPlan(hit ? hit.face === 'top' ? 'top' : 'ground' : 'new');
      this.planCursor = this.pointOnPlan(screen, world, shift || this.free);
      this.drag = { kind: 'click', hit: null, start: screen, moved: false, shift, at: now() };
      return true;
    }
    if (this.planPoints) this.planCursor = this.pointOnPlan(screen, world, shift || this.free);
    // Move block: the press takes hold of the selected mass.
    if (this.massMoveArmed && this.selection) {
      const building = this.selected();
      const volume = building && volumeById(building, this.selection.volume);
      if (building && volume) {
        const z = this.floorOf(building) + levelElevation(building, volume.base) + m(0.1);
        this.drag = {
          kind: 'massMove',
          origin: cloneBuilding(building),
          volume: volume.id,
          start: this.view.planeAt(screen, z),
          z,
        };
        return true;
      }
    }
    const selected = this.selected();
    // A part in hand goes where it is clicked: the handles stand aside (the
    // floor arrow, just over a small roof, swallowed the click meant for it).
    if (this.mode === 'edit' && selected && this.selection && !this.roofDetailKind && !this.armed && !this.component && !this.primitive && !this.coreKind && !this.furnitureKind) {
      const handle = this.handleAt(screen);
      if (handle) {
        this.hoverHandle = handle;
        this.beginHandleDrag(handle, selected, screen, shift);
        return true;
      }
    }
    this.drag = { kind: 'click', hit: this.pick(screen), start: screen, moved: false, shift, at: now() };
    return true;
  }

  private beginHandleDrag(handle: Handle, b: Building, screen: Vec2, shift: boolean): void {
    const origin = cloneBuilding(b);
    const volumeId = this.selection?.volume ?? (b.volumes[0]?.id ?? 1);
    const v = volumeById(origin, volumeId);
    switch (handle.kind) {
      case 'vertex':
        if (handle.vertex !== undefined) {
          this.selection = { ...this.selection!, vertex: handle.vertex, bay: null };
          this.drag = { kind: 'vertex', origin, volume: volumeId, vertex: handle.vertex, z: handle.z };
          this.host.changed();
        }
        break;
      case 'storeys': {
        const top = this.view.project(handle.x, handle.y, handle.z);
        const level = v ? v.base + v.storeys.length : 1;
        const below = this.view.project(handle.x, handle.y, handle.z - levelHeight(origin, level));
        this.drag = {
          kind: 'storeys',
          origin,
          volume: volumeId,
          start: screen,
          pixelsPerStorey: Math.max(6, Math.abs(below.y - top.y)),
          count: v?.storeys.length ?? 1,
        };
        break;
      }
      case 'side':
        if (this.activeModelTool === 'offset') this.drag = {
          kind: 'offset', origin, volume: volumeId,
          start: this.view.planeAt(screen, handle.z), z: handle.z,
          dir: { x: handle.dx, y: handle.dy },
        };
        else this.drag = {
          kind: 'side', origin, volume: volumeId, side: handle.side ?? 1, wing: shift,
          start: this.view.planeAt(screen, handle.z), z: handle.z,
          dir: { x: handle.dx, y: handle.dy },
        };
        break;
      case 'move':
        this.drag = { kind: 'move', origin, start: this.view.planeAt(screen, handle.z), z: handle.z };
        break;
      case 'relief': {
        const region = this.faceRegion();
        if (!region) break;
        const current = v ? reliefAt(v, region.side, region.bay0, region.storey0)?.depth ?? 0 : 0;
        this.drag = {
          kind: 'relief',
          origin,
          volume: volumeId,
          region,
          start: this.view.planeAt(screen, handle.z),
          z: handle.z,
          dir: { x: handle.dx, y: handle.dy },
          depth: current,
        };
        break;
      }
      case 'rotate': {
        const f = footprintBox(origin);
        const c = localDirToWorld(origin, (f.x0 + f.x1) / 2, (f.y0 + f.y1) / 2);
        const centre = { x: origin.x + c.x, y: origin.y + c.y };
        const p = this.view.planeAt(screen, handle.z);
        this.drag = { kind: 'rotate', origin, centre, z: handle.z, startAngle: Math.atan2(p.y - centre.y, p.x - centre.x) };
        break;
      }
      case 'scale': {
        const f = footprintBox(origin);
        const c = localDirToWorld(origin, (f.x0 + f.x1) / 2, (f.y0 + f.y1) / 2);
        const centre = { x: origin.x + c.x, y: origin.y + c.y };
        const p = this.view.planeAt(screen, handle.z);
        this.drag = {
          kind: 'scale', origin, centre, z: handle.z,
          startDist: Math.max(1e-3, Math.hypot(p.x - centre.x, p.y - centre.y)), width: f.x1 - f.x0,
        };
        break;
      }
    }
  }

  pointerMove(screen: Vec2, world: Vec2, shift: boolean): void {
    this.lastScreen = screen;
    this.lastWorld = world;
    if (this.planPoints) {
      this.hoverHandle = null;
      this.planCursor = this.pointOnPlan(screen, world, shift || this.free);
      this.host.changed();
      return;
    }
    const drag = this.drag;
    if (!drag) {
      this.hoverHandle = this.mode === 'edit' ? this.handleAt(screen) : null;
      if (this.mode === 'place') {
        // A model in hand follows the pointer everywhere, over a building
        // too: that is how a block is set against a house to join it. It used
        // to vanish there, and the click selected the house instead.
        this.hover = null;
        if (!this.activeModelTool || this.activeModelTool === 'draw') this.hoverPlace(world);
        else this.setPreview(null);
      } else if (this.armed && this.selected()) {
        this.hover = null;
        this.hoverElement(screen, world);
      } else if (this.primitive) {
        this.hover = null;
        this.hoverPrimitive(screen, world);
      } else {
        this.hover = this.pick(screen);
      }
      this.host.changed();
      return;
    }
    if (drag.kind === 'click') {
      // A press that travels is not a click: it neither places nor selects.
      if (Math.hypot(screen.x - drag.start.x, screen.y - drag.start.y) > DRAG_START_PIXELS) drag.moved = true;
      // ... unless it took hold of the selected building: then it carries it,
      // the way any object is moved - press on it and drag.
      // A block is a brick: pressed on and dragged, the block under the
      // pointer goes (and what stands on it); a building of one block goes
      // whole. The building as a whole moves by its move handle.
      const held = this.selected();
      const hit = drag.hit;
      if (drag.moved && held && hit && hit.building === held.id && this.mode === 'edit' && this.freeHand()) {
        const block = volumeById(held, hit.volume);
        if (held.volumes.length > 1 && block) {
          const z = this.floorOf(held) + levelElevation(held, block.base);
          this.selection = { building: held.id, volume: block.id, bay: null };
          this.drag = { kind: 'massMove', origin: cloneBuilding(held), volume: block.id, start: this.view.planeAt(drag.start, z), z };
        } else {
          const z = this.floorOf(held);
          this.drag = { kind: 'move', origin: cloneBuilding(held), start: this.view.planeAt(drag.start, z), z };
        }
        this.pointerMove(screen, world, shift);
      }
      return;
    }
    const draft = cloneBuilding(drag.origin);
    switch (drag.kind) {
      case 'vertex': {
        const p = this.view.planeAt(screen, drag.z);
        const local = worldToLocal(draft, p);
        movePlanVertex(draft, drag.volume, drag.vertex, local, !this.free);
        break;
      }
      case 'storeys': {
        const steps = Math.round((drag.start.y - screen.y) / drag.pixelsPerStorey);
        opSetStoreys(draft, drag.volume, drag.count + steps);
        const v = volumeById(draft, drag.volume);
        const top = this.handles().find((h) => h.kind === 'storeys');
        if (v && top) this.measure = { kind: 'floors', value: v.storeys.length, x: top.x, y: top.y, z: top.z };
        break;
      }
      case 'side': {
        const p = this.view.planeAt(screen, drag.z);
        const along = (p.x - drag.start.x) * drag.dir.x + (p.y - drag.start.y) * drag.dir.y;
        // Push and pull by the grid; with Shift the pull grows a new wing instead.
        if (drag.wing || shift) {
          if (along >= MIN_SIZE) opAddWing(draft, drag.volume, drag.side, along);
        } else {
          if (volumeById(draft, drag.volume)?.outline) movePlanEdge(volumeById(draft, drag.volume)!, drag.side, along, !this.free);
          else if (isSide(drag.side)) opResize(draft, drag.volume, drag.side, along, !this.free);
        }
        const v = volumeById(draft, drag.volume);
        if (v) this.measure = { kind: 'length', value: drag.side === 1 || drag.side === 3 ? v.w : v.d, x: p.x, y: p.y, z: drag.z };
        break;
      }
      case 'offset': {
        const p = this.view.planeAt(screen, drag.z);
        const along = (p.x - drag.start.x) * drag.dir.x + (p.y - drag.start.y) * drag.dir.y;
        const volume = volumeById(draft, drag.volume);
        if (volume && offsetPlan(volume, along, !this.free)) {
          this.measure = { kind: 'length', value: along, x: p.x, y: p.y, z: drag.z };
        }
        break;
      }
      case 'move': {
        const p = this.view.planeAt(screen, drag.z);
        const f = footprintBox(draft);
        const c = localDirToWorld(draft, (f.x0 + f.x1) / 2, (f.y0 + f.y1) / 2);
        const centre = { x: draft.x + c.x + p.x - drag.start.x, y: draft.y + c.y + p.y - drag.start.y };
        const ctx = this.host.context();
        const snap = snapPlacement(ctx.doc, ctx.net, footprintSize(draft), centre, draft.rotation, draft.id);
        if (snap.kind === 'road') {
          // Near a street it faces the street, as a new building does.
          placeAt(draft, snap.anchor, snap.rotation);
        } else {
          // Anywhere else it keeps the bearing the player gave it: snapped to
          // a neighbour's, moving undid every turn.
          const step = this.free ? 0 : GRID;
          const dx = p.x - drag.start.x;
          const dy = p.y - drag.start.y;
          draft.x += step ? Math.round(dx / step) * step : dx;
          draft.y += step ? Math.round(dy / step) * step : dy;
        }
        break;
      }
      case 'scale': {
        const p = this.view.planeAt(screen, drag.z);
        let factor = Math.hypot(p.x - drag.centre.x, p.y - drag.centre.y) / drag.startDist;
        // The width lands on the half-metre grid, so walls still meet.
        if (!this.free) factor = Math.max(GRID, Math.round((drag.width * factor) / GRID) * GRID) / drag.width;
        opScalePlan(draft, factor);
        const f = footprintBox(draft);
        this.measure = { kind: 'length', value: f.x1 - f.x0, x: p.x, y: p.y, z: drag.z };
        break;
      }
      case 'massMove': {
        // One block of the building, dragged in its own plan: the block goes
        // where it is put, and the validator says whether it still stands.
        const p = this.view.planeAt(screen, drag.z);
        const a = worldToLocal(draft, drag.start);
        const b = worldToLocal(draft, p);
        opMoveBlock(draft, drag.volume, b.x - a.x, b.y - a.y, !this.free);
        // It clicks into place against the other blocks, like a brick.
        if (!this.free) {
          const fit = blockSnap(draft, drag.volume, m(1.2));
          if (fit.dx || fit.dy) opMoveBlock(draft, drag.volume, fit.dx, fit.dy, false);
        }
        const v = volumeById(draft, drag.volume);
        if (v) this.measure = { kind: 'length', value: v.w, x: p.x, y: p.y, z: drag.z };
        break;
      }
      case 'relief': {
        // Push-pull: out along the face's normal is a projection, in a recess.
        const p = this.view.planeAt(screen, drag.z);
        const along = (p.x - drag.start.x) * drag.dir.x + (p.y - drag.start.y) * drag.dir.y;
        opSetRelief(draft, drag.volume, drag.region, drag.depth + along, !this.free);
        const v = volumeById(draft, drag.volume);
        const depth = v ? reliefAt(v, drag.region.side, drag.region.bay0, drag.region.storey0)?.depth ?? 0 : 0;
        this.measure = { kind: 'depth', value: depth, x: p.x, y: p.y, z: drag.z };
        break;
      }
      case 'rotate': {
        const p = this.view.planeAt(screen, drag.z);
        let angle = Math.atan2(p.y - drag.centre.y, p.x - drag.centre.x) - drag.startAngle;
        if (!shift) angle = Math.round(angle / ROTATE_STEP) * ROTATE_STEP;
        opRotate(draft, normaliseAngle(angle));
        break;
      }
    }
    // A drag that lands on another building welds on release: the ghost reads
    // what the release will do, weld included.
    const blocking = this.verdict(draft, draft.id);
    this.problem = blocking;
    this.setPreview({ building: draft, valid: blocking === null, problem: blocking, hides: draft.id, serial: 0 });
    this.host.changed();
  }

  pointerUp(cancelled: boolean): void {
    const drag = this.drag;
    this.drag = null;
    this.measure = null;
    if (!drag) return;
    if (cancelled) {
      this.setPreview(this.mode === 'place' ? this.preview : null);
      this.host.changed();
      return;
    }
    if (drag.kind === 'click') {
      // A long press is Shift's touch equivalent: it widens a facade pick.
      if (!drag.moved) this.click(drag.hit, drag.shift || now() - drag.at >= LONG_PRESS_MS);
      return;
    }
    const preview = this.preview;
    this.setPreview(null);
    if (!preview || preview.hides === null) {
      this.host.changed();
      return;
    }
    if (JSON.stringify(preview.building) === JSON.stringify(drag.origin)) {
      this.host.changed();
      return;
    }
    const draft = preview.building;
    // Dragged against another building? It welds: the neighbour's masses come
    // into this record and the overlap is cut away, in the same undo step.
    const result = this.host.commit(() => {
      const ctx = this.host.context();
      const absorbed = weldInto(ctx, draft, []);
      const stored = replaceBuilding(ctx, draft, absorbed);
      if (!stored.ok) return stored;
      for (const id of absorbed) ctx.doc.buildings.remove(id);
      if (absorbed.length > 0) this.host.flash('builder.welded');
      return stored;
    });
    this.report(result);
  }

  /**
   * What a drop of `draft` will meet, weld included: the same question the
   * release asks. The ghost used to call any overlap with another building
   * green ("they will weld"), and the release then refused it - a green
   * ghost that would not build.
   */
  private verdict(draft: Building, self: BuildingId | undefined): BuildingProblem | null {
    const ctx = this.host.context();
    const problem = validateBuilding(ctx, draft, self);
    if (problem !== 'building') return problem;
    const trial = cloneBuilding(draft);
    const absorbed = weldInto(ctx, trial, []);
    if (absorbed.length === 0) return problem;
    return validateBuilding(ctx, trial, self === undefined ? absorbed : [self, ...absorbed]);
  }

  /** Nothing is in hand: the pointer selects, and drags what it selected. */
  freeHand(): boolean {
    return !this.coreKind && !this.furnitureKind && !this.primitive && !this.component && !this.armed && !this.roofDetailKind && !this.massMoveArmed && !this.planPoints &&
      (this.activeModelTool === null || this.activeModelTool === 'select');
  }

  private click(hit: BuildingHit | null, shift = false): void {
    if (this.planPoints) {
      const point = this.planCursor ?? this.lastWorld;
      if (!point) return;
      const first = this.planPoints[0];
      if (first && this.planPoints.length >= 3 && this.lastScreen) {
        const screen = this.view.project(first.x, first.y, this.planHeight ?? this.view.groundAt(first.x, first.y));
        if (Math.hypot(screen.x - this.lastScreen.x, screen.y - this.lastScreen.y) < this.view.pickPixels) {
          this.finishPlan();
          return;
        }
      }
      this.planPoints.push(point);
      this.updatePlanPreview();
      return;
    }
    if (this.primitive) {
      this.dropPrimitive(hit, this.lastWorld ?? { x: 0, y: 0 });
      return;
    }
    if (this.furnitureKind && this.lastScreen) {
      this.editFurniture(this.lastScreen);
      return;
    }
    if (this.coreKind && this.lastScreen) {
      this.placeCore(this.lastScreen);
      return;
    }
    if (this.roofDetailKind && hit?.face !== 'top') {
      this.problem = 'roofSpace';
      this.host.changed();
      return;
    }
    if (this.roofDetailKind && hit?.face === 'top') {
      const building = this.host.context().doc.buildings.get(hit.building);
      if (!building) return;
      const local = worldToLocal(building, { x: hit.x, y: hit.y });
      const kind = this.roofDetailKind;
      let created: number | null = null;
      const result = this.host.commit(() => editBuilding(this.host.context(), building.id, (draft) => {
        created = addRoofDetail(draft, hit.volume, kind, local);
        return created !== null;
      }));
      if (result.ok && created !== null) {
        this.selection = { building: building.id, volume: hit.volume, bay: null };
        this.selectedRoofDetail = created;
        this.roofDetailKind = null;
      }
      this.report(result);
      if (created === null) {
        this.problem = 'roofSpace';
        this.host.changed();
      }
      return;
    }
    const s = this.selection;
    if (this.armed && this.mode === 'edit' && s) {
      this.placeElement();
      return;
    }
    if (hit?.element !== undefined && this.mode === 'edit') {
      this.selection = { building: hit.building, volume: hit.volume, bay: null, element: hit.element };
      this.host.changed();
      return;
    }
    // Shift on another bay of the picked face: the region grows to it.
    if (hit && shift && this.activeModelTool !== 'paint' && this.activeModelTool !== 'openings' && this.mode === 'edit' && s?.bay && hit.face !== 'top' &&
      hit.building === s.building && hit.volume === s.volume && hit.face === s.bay.side) {
      this.selection = { ...s, bayEnd: { storey: hit.storey, side: hit.face, index: hit.index } };
      this.host.changed();
      return;
    }
    // A model in hand is set down where its ghost stands, over a building or
    // not: overlapping, the two join.
    if (this.mode === 'place' && !this.activeModelTool && this.preview && this.preview.hides === null) {
      this.placeHere();
      return;
    }
    if (hit && (this.mode === 'edit' || this.hover)) {
      const wasPlacing = this.mode === 'place';
      const changedBuilding = this.selection?.building !== hit.building;
      const faceHit = hit.face === 'top' ? null : { storey: hit.storey, side: hit.face, index: hit.index };
      // The first click picks the building (the mass clicked); a second click
      // on the same mass picks the face under the pointer. Tools that work on
      // a face - windows, paint - take the face at once.
      const wantsFace = this.component !== null || this.activeModelTool === 'paint';
      const again = !changedBuilding && this.selection?.volume === hit.volume && !this.selection?.element;
      const bay = wantsFace || again ? faceHit : null;
      this.selection = { building: hit.building, volume: hit.volume, bay };
      if (this.stage === 'facade' && bay) this.materialScope = 'face';
      else if (!bay && (this.materialScope === 'face' || this.materialScope === 'floor')) this.materialScope = 'volume';
      if (this.mode === 'place') this.setMode('edit');
      if (wasPlacing || changedBuilding) {
        const building = this.selected();
        if (building) this.host.focus?.(building);
      }
      if (this.component && bay) this.applyToSelectedBay(this.component);
      if (this.activeModelTool === 'paint') {
        this.materialScope = hit.face === 'top' ? 'roof' : shift ? 'volume' : 'face';
        this.paint(this.paintBrush);
      }
      this.host.changed();
      return;
    }
    if (this.mode === 'place') {
      if (this.activeModelTool) return;
      this.placeHere();
      return;
    }
    this.selection = null;
    if (this.materialScope === 'face' || this.materialScope === 'floor') this.materialScope = 'volume';
    this.host.changed();
  }

  private placeHere(): void {
    const preview = this.preview;
    if (!preview) return;
    const ctx = this.host.context();
    const record = cloneBuilding(preview.building) as Building & { id?: BuildingId };
    const problem = validateBuilding(ctx, record);
    // Standing on another building is not a refusal any more: the two weld.
    if (problem && problem !== 'building') {
      this.host.flash(`building.problem.${problem}`);
      return;
    }
    const result = this.host.commit(() => {
      const absorbed = weldInto(ctx, record, []);
      const stored = addBuildingRecord(ctx, stripId(record), absorbed);
      if (!stored.ok) return stored;
      for (const id of absorbed) ctx.doc.buildings.remove(id);
      if (absorbed.length > 0) this.host.flash('builder.welded');
      return stored;
    });
    if (!result.ok && result.problem) this.host.flash(`building.problem.${result.problem}`);
    if (result.ok && result.id !== undefined) {
      this.selection = { building: result.id, volume: record.volumes[0]?.id ?? 1, bay: null };
      this.setPreview(null);
      this.mode = 'edit';
      this.stage = 'shape';
      this.host.flash('building.placed');
    }
    this.report(result);
  }

  /** Recomputes the placement ghost for the pointer at `world`. */
  hoverPlace(world: Vec2): void {
    if (this.planPoints) return;
    const ctx = this.host.context();
    const size = footprintSize(this.body);
    const snap = snapPlacement(ctx.doc, ctx.net, size, world, this.rotation);
    this.ghostAt(snap.anchor, snap.rotation);
  }

  /**
   * The ghost of a dragged shape: exactly the rectangle drawn, square to the
   * screen, its front towards the viewer. Snapped like a model it was pulled
   * onto the nearest kerb and turned to face it, nowhere near the drag.
   */
  private placeDrawn(start: Vec2, at: Vec2): void {
    const { a0, b0, w } = this.shapeDragSpan(start, at);
    const c = Math.cos(this.shapeDragAngle);
    const s = Math.sin(this.shapeDragAngle);
    // The anchor is the front-centre; the front is the edge at `b0`.
    const a = a0 + w / 2;
    this.ghostAt({ x: start.x + a * c - b0 * s, y: start.y + a * s + b0 * c }, this.shapeDragAngle);
  }

  private ghostAt(anchor: Vec2, rotation: number): void {
    const draft = { ...instantiate(this.body, anchor, rotation, this.blueprintKey ?? undefined), id: PREVIEW_ID } as Building;
    // Overlapping another building is a weld, not a refusal - when the weld
    // works: the ghost is green only if the drop will build.
    const blocking = this.verdict(draft, undefined);
    this.problem = blocking;
    this.setPreview({ building: draft, valid: blocking === null, problem: blocking, hides: null, serial: 0 });
  }

  private setPreview(preview: BuildingPreview | null): void {
    if (preview === null && this.preview === null) return;
    this.serial++;
    this.preview = preview ? { ...preview, serial: this.serial } : null;
  }

  // ------------------------------------------------------------ keys

  /** Returns true when the tool used the key. */
  key(key: string, ctrl: boolean, shift: boolean): boolean {
    const lower = key.toLowerCase();
    if (this.furnitureKind) {
      if (lower === 'r') { this.turnFurniture(); return true; }
      if (key === 'Escape') { this.armFurniture(null); return true; }
    }
    if (this.planPoints) {
      if (key === 'Enter') { this.finishPlan(); return true; }
      if (key === 'Escape') { this.cancelPlan(); return true; }
      if (key === 'Backspace') { this.backPoint(); return true; }
      return false;
    }
    if (ctrl) {
      if (lower === 'c') return this.copySelected();
      if (lower === 'v') return this.paste();
      if (lower === 'd' && this.selection) {
        this.duplicateSelected();
        return true;
      }
      return false;
    }
    const tools: Record<string, CreatorTool> = { '1': 'sketch', '2': 'shape', '3': 'facade', '4': 'roof' };
    if (tools[key]) { this.setStage(tools[key]); return true; }
    if (lower === 'r') {
      if (this.stage === 'roof' && this.selectedRoofDetail !== null) {
        this.turnRoofDetail();
        return true;
      }
      const angle = shift ? ROTATE_STEP : Math.PI / 2;
      if (this.mode === 'place') {
        this.rotation = normaliseAngle(this.rotation + angle);
        if (this.lastWorld) this.hoverPlace(this.lastWorld);
        this.host.changed();
      } else if (this.selection) {
        this.rotateSelected(angle);
      }
      return true;
    }
    if (key === 'Escape') {
      if (this.drag) {
        this.pointerUp(true);
      } else if (this.roofDetailKind) {
        this.roofDetailKind = null;
      } else if (this.armed) {
        this.armed = null;
        this.setPreview(null);
      } else if (this.component) {
        this.component = null;
      } else if (this.selectedRoofDetail !== null) {
        this.selectedRoofDetail = null;
      } else if (this.mode === 'place') {
        this.setMode('edit');
      } else if (this.activeModelTool) this.activeModelTool = null;
      // Nothing else in hand: Escape puts the building down, and the panel
      // goes back to the ways to create.
      else if (this.selection) this.selection = null;
      this.host.changed();
      return true;
    }
    if (!this.selection) return false;
    if (key === 'PageUp' || key === '+' || key === '=') {
      this.addStoreys(1);
      return true;
    }
    if (key === 'PageDown' || key === '-' || key === '_') {
      this.addStoreys(-1);
      return true;
    }
    if (key === 'Delete' || key === 'Backspace') {
      if (this.stage === 'roof' && this.selectedRoofDetail !== null) {
        this.deleteRoofDetail();
        return true;
      }
      if (this.selectedElement()) this.removeElement();
      else this.removeVolume();
      return true;
    }
    return false;
  }
}

/** Moves a building so its front-centre anchor is at `anchor`, at `rotation`. */
export function placeAt(b: Building, anchor: Vec2, rotation: number): void {
  b.rotation = normaliseAngle(rotation);
  const f = footprintBox(b);
  const offset = localDirToWorld(b, (f.x0 + f.x1) / 2, f.y0);
  b.x = anchor.x - offset.x;
  b.y = anchor.y - offset.y;
}

function stripId(b: Building & { id?: BuildingId }): Omit<Building, 'id'> {
  const copy = { ...b } as Partial<Building>;
  delete (copy as { id?: BuildingId }).id;
  return copy as Omit<Building, 'id'>;
}
