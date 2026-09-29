import type { Vec2 } from '@core/vec2';
import { signedArea } from '@core/polygon';
import {
  BLUEPRINTS,
  type BlueprintBody,
  DEFAULT_STOREY_HEIGHT,
  blueprintByKey,
  bodyOf,
  generateBlock,
} from '@world/buildings/blueprints';
import { FloorCache, type PavedAt, floorHeight } from '@world/buildings/foundation';
import { localFootprint } from '@world/buildings/footprints';
import { GRID } from '@world/buildings/geometry';
import { METERS_PER_UNIT } from '@world/units';
import { MIN_SIZE, baysOn, footprintBox, levelElevation, levelHeight, localDirToWorld, localToWorld, reliefAt, worldToLocal } from '@world/buildings/geometry';
import { type Handle, buildingHandles } from '@world/buildings/handles';
import { type BuildingHit, type Ray3, pickBuilding } from '@world/buildings/pick';
import { type MaterialSpec, type MaterialTarget, applyMaterial, applyStyle, materialAt } from '@world/buildings/materials';
import { elementAt, elementsAgainstBay } from '@world/buildings/elements';
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
  instantiate,
  normaliseAngle,
  opAddSetback,
  opAddWing,
  opResize,
  opRotate,
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
import { type PlanShape, type UpperMassPlacement, shapeBody, setVolumePlan, movePlanEdge, movePlanVertex, changePlanVertex, addPlanMass, addShapedUpperMass, cutPlanMass, offsetPlan } from './buildingPlans';
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
  | { kind: 'rotate'; origin: Building; centre: Vec2; z: number; startAngle: number }
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
  paintBrush: Partial<MaterialSpec> = { finish: 'brick' };
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
    const all = buildingHandles(shown, this.selection.volume, floor, nearest,
      this.activeModelTool === 'extrude' ? region : null);
    const volume = volumeById(shown, this.selection.volume);
    const detailed = (volume?.outline?.length ?? 4) <= 12;
    const selectedSide = this.selection.bay?.side;
    return all.filter((h) => h.kind === 'move' || h.kind === 'rotate' || h.kind === 'storeys' ||
      (!region && h.kind === 'side' && ((volume?.outline?.length ?? 4) <= 8 || this.selection?.bay?.side === h.side)) ||
      (!region && h.kind === 'vertex' &&
        (detailed || (h.vertex ?? 0) % 3 === 0 || h.vertex === this.selection?.vertex || h.vertex === selectedSide || h.vertex === (selectedSide ?? -2) + 1)) ||
      (this.activeModelTool === 'extrude' && h.kind === 'relief'));
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
    this.planPoints = null;
    this.planCursor = null;
    this.problem = null;
    this.setPreview(null);
    if (this.planAction === 'new') {
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
        if (!cutPlanMass(draft, s.volume, points)) return null;
      } else {
        const source = volumeById(draft, s.volume);
        if (!source) return null;
        const base = this.planAction === 'top' ? source.base + source.storeys.length : 0;
        if (addPlanMass(draft, s.volume, points, base, this.planAction === 'top' ? 2 : 1) === null) return null;
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
    const result = this.host.commit(() => replaceBuilding(this.host.context(), draft));
    this.setPreview(null);
    if (result.ok && added && this.selection) this.selection = { ...this.selection, bay: null, element: added.id };
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
    const selected = this.selected();
    if (this.mode === 'edit' && selected && this.selection) {
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
        this.hover = this.pick(screen);
        if (this.hover) this.setPreview(null);
        else if (!this.activeModelTool || this.activeModelTool === 'draw') this.hoverPlace(world);
        else this.setPreview(null);
      } else if (this.armed && this.selected()) {
        this.hover = null;
        this.hoverElement(screen, world);
      } else {
        this.hover = this.pick(screen);
      }
      this.host.changed();
      return;
    }
    if (drag.kind === 'click') {
      // A press that travels is not a click: it neither places nor selects.
      if (Math.hypot(screen.x - drag.start.x, screen.y - drag.start.y) > DRAG_START_PIXELS) drag.moved = true;
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
        placeAt(draft, snap.anchor, snap.rotation);
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
    const problem = validateBuilding(this.host.context(), draft, draft.id);
    this.problem = problem;
    this.setPreview({ building: draft, valid: problem === null, problem, hides: draft.id, serial: 0 });
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
    const result = this.host.commit(() => replaceBuilding(this.host.context(), draft));
    this.report(result);
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
    if (hit && (this.mode === 'edit' || this.hover)) {
      const wasPlacing = this.mode === 'place';
      const changedBuilding = this.selection?.building !== hit.building;
      const bay = hit.face === 'top' ? null : { storey: hit.storey, side: hit.face, index: hit.index };
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
    if (!preview.valid) {
      if (preview.problem) this.host.flash(`building.problem.${preview.problem}`);
      return;
    }
    const record = cloneBuilding(preview.building) as Building & { id?: BuildingId };
    const result = this.host.commit(() => addBuildingRecord(this.host.context(), stripId(record)));
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
    const draft = { ...instantiate(this.body, snap.anchor, snap.rotation, this.blueprintKey ?? undefined), id: PREVIEW_ID } as Building;
    const problem = validateBuilding(ctx, draft);
    this.problem = problem;
    this.setPreview({ building: draft, valid: problem === null, problem, hides: null, serial: 0 });
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
