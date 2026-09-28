import type { Vec2 } from '@core/vec2';
import { signedArea } from '@core/polygon';
import { RoadDoc } from '@world/doc';
import type { Network } from '@world/network';
import { bodyOf } from '@world/buildings/blueprints';
import { DEFAULT_PITCH, baysOn, footprintBox, ridgeAlongX, topLevel } from '@world/buildings/geometry';
import { type Building, volumeById } from '@world/buildings/types';
import { localFootprint } from '@world/buildings/footprints';
import { METERS_PER_UNIT, m } from '@world/units';
import { type EditResult, clearBuildingsOnRoads, deleteBuilding } from '@editor/buildings';
import { BuildingTool, type ToolHost, type ToolView } from '@editor/buildingTool';
import { detectPlanShape } from '@editor/buildingPlans';
import { BlueprintLibrary } from '@editor/blueprintLibrary';
import type { History } from '@editor/history';
import type { Viewport } from '@view/viewport';
import type { SceneHandle } from '@render/renderer';
import { initBuildingCreatorPanel } from '@ui/buildingCreatorPanel';
import { drawBuildingOverlay } from '@ui/overlay/buildingOverlay';
import { plural, t } from '@ui/i18n';

/**
 * The building tool's share of the composition root.
 *
 * This is `main.ts`, split: the one other file allowed to wire every layer
 * together (AGENTS.md section 2), kept apart so the building feature touches
 * `main.ts` in a handful of lines. It builds the `ToolView` from the viewport,
 * the `ToolHost` from the history and the autosave, the palette, the overlay
 * and the road-wins rule. See docs/buildings.md.
 */
export interface BuildingWiringDeps {
  readonly doc: RoadDoc;
  readonly net: Network;
  readonly history: History;
  readonly scene: SceneHandle;
  view(): Viewport;
  size(): { readonly w: number; readonly h: number };
  /** After a stored edit: autosave, history buttons, redraw. */
  afterEdit(): void;
  requestDraw(): void;
  focusBuilding?(building: Building): void;
  flash(key: string, params?: Readonly<Record<string, string | number>>): void;
  /** The tool's mode changed, so the hint bar's sentence did. */
  hintChanged(): void;
}

export interface BuildingWiring {
  readonly tool: BuildingTool;
  pointerDown(screen: Vec2, world: Vec2, shift: boolean): void;
  pointerMove(screen: Vec2, world: Vec2, shift: boolean): void;
  pointerUp(cancelled: boolean): void;
  /** Returns true when the tool used the key. */
  key(e: KeyboardEvent): boolean;
  activate(): void;
  deactivate(): void;
  /** Before each draw: hands the preview to the renderer. */
  beforeDraw(active: boolean): void;
  drawOverlay(ctx: CanvasRenderingContext2D): void;
  /** After an undo, a redo or a load. */
  restored(): void;
  /** After a road edit, inside the same undo step: the road-wins rule. */
  afterRoadEdit(): void;
  /** The bulldozer: demolishes the building under a screen point, if any. */
  bulldozeAt(screen: Vec2): boolean;
  hintKey(prefix: string): string;
  languageChanged(): void;
}

export function createBuildingWiring(deps: BuildingWiringDeps): BuildingWiring {
  const { doc, net, history, scene } = deps;
  const library = new BlueprintLibrary();
  let userBlueprints = library.list();

  const view: ToolView = {
    project: (x, y, z) => deps.view().toScreen({ x, y }, deps.size().w, deps.size().h, z),
    planeAt: (s, z) => deps.view().toWorldAt(s.x, s.y, z, deps.size().w, deps.size().h),
    ray(s) {
      // Two points on the pixel's line of sight, at two heights, give it.
      const { w, h } = deps.size();
      const low = deps.view().toWorldAt(s.x, s.y, 0, w, h);
      const high = deps.view().toWorldAt(s.x, s.y, 100, w, h);
      const dx = low.x - high.x;
      const dy = low.y - high.y;
      const dz = -100;
      const len = Math.hypot(dx, dy, dz);
      const back = 20;
      return {
        ox: high.x - dx * back,
        oy: high.y - dy * back,
        oz: 100 - dz * back,
        dx: dx / len,
        dy: dy / len,
        dz: dz / len,
      };
    },
    groundAt: (x, y) => scene.terrainHeightAt(x, y),
    pavedAt: (x, y) => scene.pavedHeightAt(x, y),
    pickPixels: 16,
  };

  let panelDirty = true;
  let lastMode = 'place';
  let lastStage = 'sketch';
  const host: ToolHost = {
    context: () => ({ doc, net, groundAt: (x: number, y: number) => scene.terrainHeightAt(x, y) }),
    groundKey: () => `${doc.revision}:${doc.terrainRevision}`,
    commit(edit: () => EditResult): EditResult {
      const before = doc.toJSON();
      const size = doc.buildings.size;
      const result = edit();
      if (!result.ok) return result;
      history.record(RoadDoc.fromJSON(before));
      if (doc.buildings.size > size && result.id !== undefined) {
        const created = doc.buildings.get(result.id);
        if (created) deps.focusBuilding?.(created);
      }
      deps.afterEdit();
      return result;
    },
    changed() {
      panelDirty = true;
      if (tool.mode !== lastMode || tool.stage !== lastStage) {
        lastMode = tool.mode;
        lastStage = tool.stage;
        deps.hintChanged();
      }
      deps.requestDraw();
    },
    flash: (key) => deps.flash(key),
    focus: (building) => deps.focusBuilding?.(building),
  };

  const tool = new BuildingTool(view, host);
  // Alt held frees a drag from the grid (Windows convention; the key is read
  // from the window so the pointer handlers need not pass it).
  const setFree = (free: boolean): void => {
    if (tool.free === free) return;
    tool.free = free;
    host.changed();
  };
  window.addEventListener('keydown', (e) => setFree(e.altKey));
  window.addEventListener('keyup', (e) => setFree(e.altKey));
  window.addEventListener('blur', () => setFree(false));

  const panel = initBuildingCreatorPanel({
    modelTool: (kind) => tool.armModelTool(tool.activeModelTool === kind ? null : kind),
    tool: (stage) => tool.setStage(stage),
    frame: () => tool.focusSelected(),
    draw: (action) => tool.startPlan(action),
    shape: (shape) => tool.chooseShape(shape),
    tierShape: (shape) => tool.reshapeTier(shape),
    starter: (key) => tool.chooseBlueprint(key),
    saveBlueprint(name) {
      const building = tool.selected();
      if (building && library.save(name, bodyOf(building))) {
        userBlueprints = library.list();
        deps.flash('building.blueprintSaved');
        host.changed();
      }
    },
    useBlueprint(key) {
      const blueprint = userBlueprints.find((item) => item.key === key);
      if (blueprint) tool.useBody(blueprint.body, key);
    },
    deleteBlueprint(key) {
      library.remove(key);
      userBlueprints = library.list();
      host.changed();
    },
    finishPlan: () => tool.finishPlan(),
    cancelPlan: () => tool.cancelPlan(),
    backPoint: () => tool.backPoint(),
    mass: (id) => tool.selectVolume(id),
    floors: (delta) => tool.addStoreys(delta),
    floorCount: (count) => tool.setStoreys(count),
    floorHeight: (metres) => tool.setParameter('storeyHeight', metres / METERS_PER_UNIT),
    groundHeight: (metres) => tool.setGroundHeight(metres / METERS_PER_UNIT),
    split: (afterFloor) => tool.splitAtFloor(afterFloor),
    setback: (shape, metres, floors, placement) => tool.addUpperShape(shape, metres / METERS_PER_UNIT, floors, {
        ...(placement.width === undefined ? {} : { width: placement.width / METERS_PER_UNIT }),
        ...(placement.depth === undefined ? {} : { depth: placement.depth / METERS_PER_UNIT }),
        offsetX: placement.offsetX / METERS_PER_UNIT, offsetY: placement.offsetY / METERS_PER_UNIT,
      }),
    vertex: (action) => tool.changeVertex(action),
    element: (kind) => tool.armElement(kind),
    elementSize: (name, metres) => tool.updateElement({ [name]: metres / METERS_PER_UNIT }),
    turnElement() {
      const part = tool.selectedElement();
      if (part) tool.updateElement({ facing: ((part.facing + 1) % 4) as 0 | 1 | 2 | 3 });
    },
    repeatElement: () => tool.repeatElement(),
    removeElement: () => tool.removeElement(),
    pattern: (value, scope) => tool.applyFacadeGrammar(value, scope),
    opening(component) {
      tool.armComponent(component);
      if (tool.selection?.bay) tool.applyToSelectedBay(component);
    },
    openingScope: (scope) => tool.setScope(scope),
    target(scope) {
      tool.setMaterialScope(scope === 'building' ? 'building' : scope === 'face' ? 'face' : scope === 'floor' ? 'floor' : 'volume');
    },
    finish: (value) => tool.paint({ finish: value }),
    color: (value) => tool.paint({ colour: value }),
    roof: (value) => tool.setRoof(value),
    pitch: (value) => tool.setRoofShape({ pitch: value }),
    ridge: (value) => tool.setRoofShape({ ridge: value }),
    fall: (value) => tool.setRoofShape({ fall: value }),
    roofFinish: (value) => tool.paint({ finish: value }),
    roofColor: (value) => tool.paint({ colour: value }),
    roofDetail: (value) => tool.armRoofDetail(value),
    selectDetail: (id) => tool.selectRoofDetail(id),
    turnDetail: () => tool.turnRoofDetail(),
    moveDetail: (dx, dy) => tool.moveRoofDetail(dx, dy),
    deleteDetail: () => tool.deleteRoofDetail(),
    detailHeight: (metres) => tool.setRoofDetailHeight(metres),
    detailFlag: (flag) => tool.setRoofDetailFlag(flag),
    relief: (metres) => tool.setRelief(metres / METERS_PER_UNIT),
    geometry: (name, value) => tool.setFacadeGeometry({ [name]:
      name === 'windowWidth' || name === 'windowHeight' ? value / 100
        : name === 'sill' || name === 'pierWidth' || name === 'pierDepth' ? value / METERS_PER_UNIT : value }),
  });

  const refreshPanel = (): void => {
    if (!panelDirty) return;
    panelDirty = false;
    const building = tool.mode === 'edit' || (tool.planPoints && tool.planAction !== 'new') ? tool.selected() : null;
    const volume = building && tool.selection ? volumeById(building, tool.selection.volume) : undefined;
    panel.refresh({
      modelTool: tool.activeModelTool === 'draw' || tool.activeModelTool === 'extrude' ? tool.activeModelTool : null,
      tool: tool.stage,
      drawing: tool.planPoints?.length ?? null,
      action: tool.planAction,
      selected: !!building,
      current: tool.selection?.volume ?? null,
      masses: building?.volumes.map((mass) => ({ id: mass.id, base: mass.base, floors: mass.storeys.length })) ?? [],
      blueprints: userBlueprints.map((item) => ({ key: item.key, name: item.name ?? item.key })),
      selectedFace: !!tool.selection?.bay,
      selectedFloor: tool.selection?.bay && volume ? volume.base + tool.selection.bay.storey + 1 : null,
      reliefDepth: tool.reliefDepth(),
      geometry: (() => {
        const bay = tool.selection?.bay;
        if (!building || !volume || !bay) return null;
        const authored = volume.facadeGeometry?.[bay.side];
        const facade = volume.storeys[bay.storey]?.facade;
        const grammar = facade?.patterns?.[bay.side] ?? facade?.pattern ?? volume.facadePattern;
        return { bays: baysOn(building, volume, bay.side), windowWidth: authored?.windowWidth ?? .55,
          windowHeight: authored?.windowHeight ?? .6, sill: authored?.sill ?? m(.9),
          pierWidth: authored?.pierWidth ?? (grammar === 'artDecoCrown' ? m(.65) : m(.36)),
          pierDepth: authored?.pierDepth ?? (grammar === 'artDecoCrown' ? m(.65) : grammar === 'artDeco' ? m(.3) : 0),
          pierEvery: authored?.pierEvery ?? 1 };
      })(),
      scope: tool.materialScope === 'face' ? 'face' : tool.materialScope === 'floor' ? 'floor' : tool.materialScope === 'building' ? 'building' : 'volume',
      openingScope: tool.scope,
      width: volume?.w ?? 0,
      depth: volume?.d ?? 0,
      selectedVertex: tool.selection?.vertex !== undefined && tool.selection.vertex !== null,
      armedElement: tool.armed,
      element: (() => {
        const part = tool.selectedElement();
        return part ? { kind: part.kind, w: part.w, d: part.d, h: part.h } : null;
      })(),
      floors: volume?.storeys.length ?? 0,
      floorHeight: building?.storeyHeight ?? 0,
      groundHeight: building?.groundHeight ?? 0,
      splitMin: volume ? volume.base + 1 : 1,
      splitMax: volume ? volume.base + volume.storeys.length - 1 : 0,
      splitDefault: volume ? volume.base + Math.max(1, Math.floor(volume.storeys.length / 2)) : 1,
      tierShape: volume ? detectPlanShape(volume) : null,
      area: volume ? Math.abs(signedArea(localFootprint(volume))) * METERS_PER_UNIT ** 2 : 0,
      roof: volume?.roof ?? null,
      pitch: volume?.pitch ?? DEFAULT_PITCH[volume?.roof ?? ''] ?? 30,
      ridge: volume ? ridgeAlongX(volume) ? 'x' : 'y' : null,
      fall: volume?.fall ?? null,
      facadePattern: (() => {
        const selectedBay = tool.selection?.bay;
        const facade = selectedBay ? volume?.storeys[selectedBay.storey]?.facade : undefined;
        if (tool.materialScope === 'face' && selectedBay)
          return facade?.patterns?.[selectedBay.side] ?? facade?.pattern ?? volume?.facadePattern ?? null;
        if (tool.materialScope === 'floor') return facade?.pattern ?? volume?.facadePattern ?? null;
        if (tool.materialScope === 'building' && building?.volumes.some((mass) => mass.facadePattern !== volume?.facadePattern)) return null;
        return volume?.facadePattern ?? null;
      })(),
      component: tool.component,
      material: tool.currentMaterial(),
      details: volume?.roofDetails?.map((part) => ({ id: part.id, kind: part.kind,
        ...(part.h === undefined ? {} : { h: part.h }), ...(part.flag === undefined ? {} : { flag: part.flag }) })) ?? [],
      selectedDetail: tool.selectedRoofDetail,
      armedDetail: tool.roofDetailKind,
      problem: tool.problem,
    });
  };

  const floorOf = tool.floorOf.bind(tool);

  return {
    tool,
    pointerDown(screen, world, shift) {
      tool.pointerDown(screen, world, shift);
    },
    pointerMove(screen, world, shift) {
      tool.pointerMove(screen, world, shift);
    },
    pointerUp(cancelled) {
      tool.pointerUp(cancelled);
    },
    key(e) {
      const ctrl = e.ctrlKey || e.metaKey;
      if (ctrl && e.key.toLowerCase() === 'c' && tool.copySelected()) {
        deps.flash('building.copied');
        return true;
      }
      return tool.key(e.key, ctrl, e.shiftKey);
    },
    activate() {
      panelDirty = true;
      refreshPanel();
    },
    deactivate() {
      tool.deactivate();
      scene.setBuildingPreview(null);
    },
    beforeDraw(active) {
      scene.setBuildingPreview(active ? tool.preview : null);
      if (active) refreshPanel();
    },
    drawOverlay(ctx) {
      const selected = tool.selected();
      const preview = tool.preview;
      const shown = selected && preview?.hides === selected.id ? preview.building : selected;
      const hoverHit = tool.hover;
      const hovered = hoverHit ? doc.buildings.get(hoverHit.building) ?? null : null;
      let label: Parameters<typeof drawBuildingOverlay>[1]['label'] = null;
      if (preview) {
        const floors = topLevel(preview.building);
        const f = footprintBox(preview.building);
        const size = `${((f.x1 - f.x0) * METERS_PER_UNIT).toFixed(1)} × ${((f.y1 - f.y0) * METERS_PER_UNIT).toFixed(1)} m`;
        const text = preview.problem
          ? t(`building.problem.${preview.problem}`)
          : `${plural('building.floors', floors)} · ${size}`;
        label = { text, valid: preview.valid, building: preview.building, floor: floorOf(preview.building) };
      }
      drawBuildingOverlay(ctx, {
        project: view.project,
        stage: tool.stage,
        plan: tool.planPoints ? { points: tool.planPoints, cursor: tool.planCursor, groundAt: tool.planHeight === null ? view.groundAt : () => tool.planHeight! } : null,
        hover: hovered && tool.mode === 'edit' ? { building: hovered, floor: floorOf(hovered) } : null,
        selected: shown && tool.selection && tool.mode === 'edit'
          ? { building: shown, volume: tool.selection.volume, floor: floorOf(shown), bay: tool.selection.bay, vertex: tool.selection.vertex, region: tool.faceRegion() }
          : null,
        handles: tool.handles(),
        activeHandle: tool.hoverHandle,
        label,
        measure: tool.measure
          ? {
            text: tool.measure.kind === 'floors'
              ? plural('building.floors', tool.measure.value)
              : `${(tool.measure.value * METERS_PER_UNIT).toFixed(tool.measure.kind === 'depth' ? 2 : 1)} m`,
            x: tool.measure.x,
            y: tool.measure.y,
            z: tool.measure.z,
          }
          : null,
      });
    },
    restored() {
      tool.sync();
      host.changed();
    },
    afterRoadEdit() {
      const razed = clearBuildingsOnRoads({ doc, net, groundAt: null });
      if (razed > 0) {
        tool.sync();
        deps.flash(razed === 1 ? 'building.demolished.one' : 'building.demolished.other', { count: razed });
      }
    },
    bulldozeAt(screen) {
      const hit = tool.pickAt(screen);
      if (!hit) return false;
      const result = host.commit(() => ({ ok: deleteBuilding(host.context(), hit.building) }));
      tool.sync();
      return result.ok;
    },
    hintKey(prefix) {
      return tool.planPoints ? `${prefix}.building.draw` : `${prefix}.building.${tool.stage}`;
    },
    languageChanged() {
      panelDirty = true;
      refreshPanel();
    },
  };
}
