import type { Vec2 } from '@core/vec2';
import { signedArea } from '@core/polygon';
import { RoadDoc } from '@world/doc';
import type { Network } from '@world/network';
import { bodyOf } from '@world/buildings/blueprints';
import { DEFAULT_PITCH, baysOn, footprintBox, ridgeAlongX, topLevel } from '@world/buildings/geometry';
import { BUILDING_FUNCTIONS, type Building, type BuildingId, volumeById } from '@world/buildings/types';
import { localFootprint } from '@world/buildings/footprints';
import { FINISH_COLOUR } from '@world/buildings/materials';
import { METERS_PER_UNIT, m } from '@world/units';
import { type EditResult, clearBuildingsOnRoads, deleteBuilding } from '@editor/buildings';
import { BuildingTool, type ToolHost, type ToolView } from '@editor/buildingTool';
import type { PlanShape, Primitive } from '@editor/buildingPlans';
import { BlueprintLibrary } from '@editor/blueprintLibrary';
import type { History } from '@editor/history';
import { BUILDER_CATALOG, DRAW_SHAPES, OPENING_COMPONENTS, TIER_SHAPES, type BuilderCategoryId, type BuilderField } from '@ui/builder/catalog';
import type { Viewport } from '@view/viewport';
import type { SceneHandle } from '@render/renderer';
import { drawBuildingOverlay } from '@ui/overlay/buildingOverlay';
import { drawBuilderGizmos, type GizmoInput } from '@ui/overlay/builderGizmos';
import { type ThumbnailStudio, createThumbnailStudio } from '@render/buildings/parts';
import { initBuilderWorkspace, type BuilderActions, type BuilderState } from '@ui/builder/workspace';
import { plural, t } from '@ui/i18n';

/**
 * The building tool's share of the composition root.
 *
 * This is `main.ts`, split: the one other file allowed to wire every layer
 * together (AGENTS.md section 2), kept apart so the building feature touches
 * `main.ts` in a handful of lines. It builds the `ToolView` from the viewport,
 * the `ToolHost` from the history and the autosave, the Builder Workspace
 * (`ui/builder/`), the overlay and the road-wins rule. See docs/buildings.md.
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
  undo(): void;
  redo(): void;
}

export interface BuildingWiring {
  readonly tool: BuildingTool;
  /** The shared chrome: main.ts mounts the road toolbar and panels into it. */
  readonly workspace: ReturnType<typeof initBuilderWorkspace>;
  pointerDown(screen: Vec2, world: Vec2, shift: boolean): void;
  /** A click with nothing in hand: opens (or switches) the building seen inside; true if taken. */
  insideClick(screen: Vec2, double: boolean): boolean;
  pointerMove(screen: Vec2, world: Vec2, shift: boolean): void;
  pointerUp(cancelled: boolean): void;
  /**
   * Photographs the parts a gallery is about to show, a few per frame. The
   * pictures arrive through the workspace as they are ready; nothing here
   * blocks, and a gallery that is never opened costs nothing.
   */
  requestThumbnails(ids: readonly string[]): void;
  /** Returns true when the tool used the key. */
  key(e: KeyboardEvent): boolean;
  /** Right button: cancels the operation in progress, if any. */
  cancelOperation(): boolean;
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

  let dirty = true;
  let painting = false;
  let studio: ThumbnailStudio | null = null;
  let inspectorOpen = true;
  let category: BuilderCategoryId = 'models';
  let toolId = 'select';
  let snapMode: string = 'auto';
  let gridVisible = false;
  let hideOthers = false;
  let lastHint = '';
  /** See inside, for the whole city: on or off, and the floor seen. */
  // See inside: one building, the one clicked, cut open at a floor.
  const seeInside: { on: boolean; level: number; target: BuildingId | null } = { on: false, level: 0, target: null };
  /** What a drawn shape does: new building, joined block, block on the roof, cut. */
  let drawAction: 'new' | 'ground' | 'top' | 'cut' = 'new';

  const host: ToolHost = {
    context: () => ({ doc, net, groundAt: (x: number, y: number) => scene.terrainHeightAt(x, y) }),
    groundKey: () => `${doc.revision}:${doc.terrainRevision}`,
    commit(edit: () => EditResult): EditResult {
      const before = doc.toJSON();
      const result = edit();
      if (!result.ok) return result;
      history.record(RoadDoc.fromJSON(before, { repair: false }));
      // The camera stays where the player put it: placing a building used to
      // re-frame it, which threw the view across the map mid-gesture.
      deps.afterEdit();
      return result;
    },
    changed() {
      dirty = true;
      if (tool.builderHintKey() !== lastHint) {
        lastHint = tool.builderHintKey();
        deps.hintChanged();
      }
      // The workspace follows the tool at once, not a frame later: the panels
      // are cheap to re-render (each caches on its own signature) and a click
      // has to answer immediately.
      refresh();
      deps.requestDraw();
    },
    flash: (key) => notify(key),
    focus: () => {
      /* the camera is the player's; a stored edit never moves it */
    },
  };

  const tool = new BuildingTool(view, host);
  // Alt held frees a drag from the grid (Windows convention; the key is read
  // from the window so the pointer handlers need not pass it).
  const setFree = (free: boolean): void => {
    const wanted = free || snapMode === 'off';
    if (tool.free === wanted) return;
    tool.free = wanted;
    host.changed();
  };
  window.addEventListener('keydown', (e) => setFree(e.altKey));
  window.addEventListener('keyup', (e) => setFree(e.altKey));
  window.addEventListener('blur', () => setFree(false));

  // ------------------------------------------------------------ the workspace

  /**
   * Choosing a tool puts the previous one away: only one thing may be taking
   * the pointer at a time (the spec's rule, and the reason a plan could never
   * finish while an opening brush was still armed).
   */
  function clearArming(keep: 'component' | 'element' | 'detail' | 'model' | 'path' | null): void {
    // A plan left half-drawn when another tool is chosen is put away, or the
    // tray would keep offering Finish for a plan nobody is drawing.
    if (tool.planPoints && !tool.pathKind && keep !== 'path') tool.cancelPlan();
    tool.massMoveArmed = false;
    if (keep !== 'component') tool.armComponent(null);
    if (keep !== 'element' && tool.armed) tool.armElement(null);
    if (keep !== 'detail' && tool.roofDetailKind) tool.armRoofDetail(null);
    if (keep !== 'model') tool.armModelTool(null);
    if (tool.primitive) tool.armPrimitive(null);
    if (tool.coreKind) tool.armCore(null);
    if (tool.furnitureKind) tool.armFurniture(null);
  }

  /** The floor the floor chip shows: the picked face's storey, or the ground. */
  function floorInHand(): number {
    const building = tool.selected();
    const volume = building && tool.selection ? volumeById(building, tool.selection.volume) : undefined;
    return volume && tool.selection?.bay ? volume.base + tool.selection.bay.storey : 0;
  }

  /** The shape a draw tool draws, when it is a drag shape. */
  const shapeOfTool = (id: string): PlanShape | null => {
    const shape = DRAW_SHAPES[id];
    return shape ? (shape as PlanShape) : null;
  };

  /** Wing, stack and cut are drags too: a rectangle against the selection. */
  const planActionOfTool = (id: string): 'ground' | 'top' | 'cut' | null =>
    id === 'wing' ? 'ground' : id === 'stack' ? 'top' : id === 'cut' ? 'cut' : null;

  /** Runs an action tool, arms a mode tool, or opens a gallery (the workspace's job). */
  function runTool(id: string): void {
    switch (id) {
      case 'storey': tool.addStoreys(1); return;
      case 'storeyDown': tool.addStoreys(-1); return;
      case 'split': tool.splitAtFloor(defaultSplitFloor()); return;
      case 'setback': tool.addUpperShape('match', m(1), 2); return;
      case 'vertexAdd': tool.changeVertex('insert'); return;
      case 'vertexRemove': tool.changeVertex('remove'); return;
      case 'inset': tool.setRelief(-m(0.5)); return;
      case 'outset': tool.setRelief(m(0.5)); return;
      case 'flush': tool.setRelief(0); return;
      case 'roofFlat': tool.setRoof('flat'); return;
      case 'roofTerrace': tool.setRoof('terrace'); return;
      case 'roofGable': tool.setRoof('gable'); return;
      case 'roofHip': tool.setRoof('hip'); return;
      case 'roofShed': tool.setRoof('shed'); return;
      case 'roofSawtooth': tool.setRoof('sawtooth'); return;
      case 'copyStyle': copyStyle(); return;
      case 'blockSolid': tool.setBlockMode(null); return;
      // Inside: the building cut open at the floor in hand.
      case 'interiorView': tool.setCutLevel(tool.cutLevel === null ? floorInHand() : null); return;
      case 'floorDown': tool.setCutLevel(Math.max(0, (tool.cutLevel ?? floorInHand()) - 1)); return;
      case 'floorUp': {
        const building = tool.selected();
        const top = building ? topLevel(building) - 1 : 0;
        tool.setCutLevel(Math.min(top, (tool.cutLevel ?? floorInHand()) + 1));
        return;
      }
      // Modelling, SketchUp's and Blender's verbs on a block of storeys: one
      // metre a click, typed sizes in the selection panel.
      case 'extrudeOut': tool.extrudeFace(m(1)); return;
      case 'extrudeIn': tool.extrudeFace(-m(1)); return;
      case 'extrudeBlock': tool.extrudeFaceBlock(m(4)); return;
      case 'insetFace': tool.insetFace(m(0.6)); return;
      case 'offsetOut': tool.offsetBlock(m(1)); return;
      case 'offsetIn': tool.offsetBlock(-m(1)); return;
      case 'bevelAll': tool.bevelBlock(m(2)); return;
      case 'pointMode': tool.setPointMode(!tool.pointMode); return;
      case 'bevelCorner': {
        const corner = tool.selection?.vertex;
        if (corner === null || corner === undefined) notify('builder.pickCorner');
        else tool.bevelBlock(m(2), corner);
        return;
      }
      case 'blockVoid': tool.setBlockMode('void'); return;
      case 'blockIntersect': tool.setBlockMode('intersect'); return;
      case 'blockXor': tool.setBlockMode('xor'); return;
      case 'copyBlock': tool.copyBlock(); return;
      case 'detachBlock': tool.detachBlock(); return;
      case 'centerBlock': tool.setBlockOffset(0, 0); return;
      case 'turnBlockLeft': tool.turnBlock(15); return;
      case 'turnBlockRight': tool.turnBlock(-15); return;
      default:
        if (TIER_SHAPES[id]) {
          tool.reshapeTier(TIER_SHAPES[id] as PlanShape);
          return;
        }
        break;
    }
    // Mode tools.
    if (shapeOfTool(id)) {
      clearArming(null);
      tool.setStage('sketch');
      tool.chooseShape(shapeOfTool(id) as PlanShape);
      toolId = id;
      return;
    }
    // A basic shape in hand: each click drops one, until Escape.
    const primitive = PRIMITIVE_OF_TOOL[id];
    if (primitive) {
      clearArming(null);
      tool.armModelTool('select');
      tool.armPrimitive(primitive);
      toolId = id;
      return;
    }
    // Furnishing: a piece or a light in hand, moving, removing, turning.
    if (id === 'furnTurn') {
      tool.turnFurniture();
      return;
    }
    const furniture = id.startsWith('furn_') ? id.slice(5) : id === 'furnMove' ? 'move' : id === 'furnRemove' ? 'remove' : null;
    if (furniture) {
      clearArming(null);
      tool.armModelTool('select');
      tool.armFurniture(furniture as Parameters<typeof tool.armFurniture>[0]);
      toolId = id;
      return;
    }
    const core = id === 'coreLift' ? 'lift' : id === 'coreStair' ? 'stair' : id === 'coreBoth' ? 'stairLift' : id === 'coreRemove' ? 'remove' : null;
    if (core) {
      clearArming(null);
      tool.armModelTool('select');
      tool.armCore(core);
      toolId = id;
      return;
    }
    if (id === 'sketch') {
      // The free plan arms here and starts on the first click: opening the
      // Draw category used to leave a plan in progress, with the tray locked
      // on Finish and the shapes unreachable.
      clearArming(null);
      tool.setStage('sketch');
      toolId = id;
      return;
    }
    if (id === 'select') {
      clearArming(null);
      tool.armModelTool('select');
      toolId = id;
      return;
    }
    if (id === 'wing' || id === 'stack' || id === 'cut') {
      clearArming(null);
      tool.setStage('shape');
      toolId = id;
      return;
    }
    if (id === 'moveMass') {
      clearArming('model');
      if (tool.mode !== 'edit') tool.setMode('edit');
      tool.massMoveArmed = true;
      toolId = id;
      return;
    }
    if (id === 'pushpull') {
      clearArming('model');
      tool.armModelTool('offset');
      toolId = id;
      return;
    }
    if (id === 'paint') {
      clearArming('model');
      tool.armModelTool('paint');
      toolId = id;
      return;
    }
    const component = OPENING_COMPONENTS[id];
    if (component) {
      clearArming('component');
      tool.armModelTool('openings');
      tool.armComponent(component as never);
      toolId = id;
      return;
    }
    if (id === 'solar' || id === 'skylight' || id === 'vent' || id === 'chimney' || id === 'waterTank' || id === 'spire') {
      clearArming('detail');
      tool.armRoofDetail(id);
      toolId = id;
      return;
    }
    // Runs traced as a path: fence, wall and paving follow the line drawn,
    // one part per segment, end to end.
    if (id === 'wallRun' || id === 'fenceRun' || id === 'pavementRun' || id === 'stairRun') {
      const kind = id === 'wallRun' ? 'wall' : id === 'fenceRun' ? 'fence' : id === 'stairRun' ? 'stair' : 'pavement';
      tool.startElementRun(kind);
      toolId = id;
      return;
    }
    // The free parts (stairs, ramps, pillars, canopies, walls, slabs, paving,
    // and the things that decorate a lot: trees, benches, planters, units).
    if (
      id === 'stair' || id === 'ramp' || id === 'pillar' || id === 'canopy' || id === 'wall'
      || id === 'slab' || id === 'pavement' || id === 'tree' || id === 'bench' || id === 'ac' || id === 'planter'
      || id === 'railing' || id === 'awning' || id === 'flowers' || id === 'shrub' || id === 'hedge' || id === 'rocks' || id === 'parking' || id === 'clock'
    ) {
      clearArming('element');
      tool.armElement(id);
      toolId = id;
      return;
    }
  }

  /** Puts down whatever is in hand: the pointer selects again. */
  function backToSelect(): void {
    clearArming(null);
    tool.armModelTool('select');
    toolId = 'select';
  }

  /** Tools that make something; once it is made, the pointer selects again. */
  const CREATES = new Set(['sketch', 'place', 'wing', 'stack', 'cut', 'moveMass', ...Object.keys(DRAW_SHAPES)]);

  /**
   * After a gesture: if a creating tool just made what it makes, it is put
   * down. Left in hand, the free plan started a second plan when the player
   * reached for the new building's floor arrow.
   */
  function afterGesture(revision: number): void {
    if (doc.buildings.revision === revision || !CREATES.has(toolId) || tool.planPoints) return;
    backToSelect();
    host.changed();
  }

  function defaultSplitFloor(): number {
    const building = tool.selected();
    const volume = building && tool.selection ? volumeById(building, tool.selection.volume) : undefined;
    if (!volume) return 1;
    return volume.base + Math.max(1, Math.floor(volume.storeys.length / 2));
  }

  function copyStyle(): void {
    const material = tool.currentMaterial();
    if (!material) {
      notify('building.selectFirst');
      return;
    }
    tool.setPaintBrush({ finish: material.finish, colour: material.colour });
    notify('builder.styleCopied');
  }

  /**
   * Photographs the parts a gallery is about to show, a few per frame, and
   * hands each batch to the workspace as it is ready. Nothing blocks: the
   * eighty pictures used to be taken in one frame, which cost a third of a
   * second of freeze the moment the Builder was opened.
   */
  function requestThumbnails(ids: readonly string[]): void {
    studio ??= createThumbnailStudio(scene.gl);
    studio.request(ids, (images) => workspace.setPresetThumbnails(images));
  }

  const actions: BuilderActions = {
    requestThumbnails,
    undo: () => deps.undo(),
    redo: () => deps.redo(),
    setCategory: (id) => {
      category = id;
      // A category is a shelf, not a button: opening it arms nothing. It used
      // to arm its first tool - the free plan for Create - so the next click
      // on a house started a plan instead of selecting it. The pointer selects
      // until a tool is taken up.
      backToSelect();
      host.changed();
    },
    chooseTool: (id) => {
      runTool(id);
      host.changed();
    },
    setFloor: (level) => {
      const building = tool.selected();
      if (!building) return;
      // The floor selector points the face tools at one level: the bay the
      // selection carries moves with it.
      const volume = tool.selection ? volumeById(building, tool.selection.volume) : undefined;
      if (volume && tool.selection?.bay) {
        tool.selectFloor(level - volume.base);
      }
      // Looking inside, the floor chip chooses the floor seen.
      if (tool.cutLevel !== null) tool.setCutLevel(level);
      host.changed();
    },
    floorCommand: (command) => {
      // The floor in hand is the one the floor chip shows: the picked face's
      // storey, or the top one. Inserting used to cut the mass in two (and
      // "below" did nothing); now it adds a storey there.
      const volume = tool.selected() && tool.selection ? volumeById(tool.selected()!, tool.selection.volume) : undefined;
      const at = tool.selection?.bay?.storey ?? (volume ? volume.storeys.length - 1 : 0);
      if (command === 'insertAbove') tool.insertStorey(at, true);
      else tool.insertStorey(at, false);
      host.changed();
    },
    setSnap: (mode) => {
      snapMode = mode;
      setFree(false);
      host.changed();
    },
    toggleGrid: () => {
      gridVisible = !gridVisible;
      host.changed();
    },
    toggleHideOthers: () => {
      hideOthers = !hideOthers;
      scene.setBuildingsDimmed(hideOthers ? tool.selection?.building ?? null : undefined);
      host.changed();
    },
    toggleInspector: () => {
      inspectorOpen = !inspectorOpen;
      dirty = true;
      deps.requestDraw();
    },
    selectionAction: (name) => {
      const building = tool.selected();
      switch (name) {
        case 'duplicate':
          if (building) tool.duplicateSelected();
          break;
        case 'mirror':
          if (building) tool.mirrorSelected();
          break;
        case 'group': {
          // Group with the nearest building: its masses move into this record.
          if (!building) break;
          const centre = { x: building.x, y: building.y };
          let best: Building | null = null;
          let bestDistance = 60;
          for (const other of doc.buildings.all()) {
            if (other.id === building.id) continue;
            const d = Math.hypot(other.x - centre.x, other.y - centre.y);
            if (d < bestDistance) {
              bestDistance = d;
              best = other;
            }
          }
          if (!best) {
            notify('builder.noGroup');
            break;
          }
          if (tool.groupWith(best.id)) notify('builder.grouped');
          break;
        }
        case 'save': {
          if (!building) break;
          const name = window.prompt(t('building.blueprintName'), '');
          if (name !== null && name.trim() !== '' && library.save(name, bodyOf(building))) {
            userBlueprints = library.list();
            notify('building.blueprintSaved');
          }
          break;
        }
        case 'delete':
          if (building) tool.deleteSelected();
          break;
      }
      host.changed();
    },
    setField: (id, value) => {
      setField(id, value);
      host.changed();
    },
    choosePreset: (key) => {
      // A model in hand is placed by the next click; the plan pencil, if it
      // was the tool, is put down - with it, that click began a plan instead.
      clearArming(null);
      toolId = 'place';
      tool.chooseBlueprint(key);
      host.changed();
    },
    chooseUserBlueprint(key) {
      const blueprint = userBlueprints.find((item) => item.key === key);
      clearArming(null);
      toolId = 'place';
      if (blueprint) tool.useBody(blueprint.body, key);
      host.changed();
    },
    removeUserBlueprint(key) {
      library.remove(key);
      userBlueprints = library.list();
      host.changed();
    },
    // The finish tools paint the selected free part when there is one (a
    // stair, a pavement, a canopy), and the model's surface otherwise.
    // A finish comes in its own colour, and is what the brush carries next.
    chooseFinish: (finish) => {
      const colour = FINISH_COLOUR[finish];
      tool.setPaintBrush({ finish, colour });
      const element = tool.selectedElement();
      if (element) tool.updateElement({ material: { ...(element.material ?? {}), finish, colour } });
      else if (tool.selected()) tool.paint({ finish, colour });
      host.changed();
    },
    chooseColour: (colour) => {
      tool.setPaintBrush({ colour });
      const element = tool.selectedElement();
      if (element) tool.updateElement({ material: { ...(element.material ?? { finish: 'concrete' as const }), colour } });
      else if (tool.selected()) tool.paint({ colour });
      host.changed();
    },
    chooseStyle: (key) => {
      tool.applyStyle(key);
      host.changed();
    },
    choosePattern: (pattern) => {
      const scope = tool.scope === 'storey' || tool.scope === 'row' ? 'floor' : tool.scope === 'side' || tool.scope === 'bay' || tool.scope === 'column' ? 'face' : 'volume';
      tool.applyFacadeGrammar(pattern as never, scope);
      host.changed();
    },
    setDrawAction: (action) => {
      drawAction = action === 'ground' || action === 'top' || action === 'cut' ? action : 'new';
      host.changed();
    },
    setScope: (scope) => {
      tool.setScope(scope as never);
      host.changed();
    },
    planFinish: () => {
      const revision = doc.buildings.revision;
      tool.finishPlan();
      afterGesture(revision);
      host.changed();
    },
    planBack: () => {
      tool.backPoint();
      host.changed();
    },
    planCancel: () => {
      tool.cancelPlan();
      host.changed();
    },
    roofPitch: (delta) => {
      const building = tool.selected();
      const volume = building && tool.selection ? volumeById(building, tool.selection.volume) : undefined;
      const current = volume?.pitch ?? DEFAULT_PITCH[volume?.roof ?? ''] ?? 30;
      tool.setRoofShape({ pitch: current + delta });
      host.changed();
    },
    roofRidge: (ridge) => {
      tool.setRoofShape({ ridge });
      host.changed();
    },
    roofFall: (side) => {
      tool.setRoofShape({ fall: side as 0 | 1 | 2 | 3 });
      host.changed();
    },
    seeInside: (command) => {
      if (command === 'toggle') {
        seeInside.on = !seeInside.on;
        // Switched on from the button: the building in the middle of the view.
        if (seeInside.on && seeInside.target === null) {
          const { w, h } = deps.size();
          seeInside.target = tool.buildingAt({ x: w / 2, y: h / 2 });
        }
      }
      else if (command === 'up') seeInside.level = Math.min(60, seeInside.level + 1);
      else seeInside.level = Math.max(0, seeInside.level - 1);
      deps.requestDraw();
      return { ...seeInside };
    },
    view: (id) => {
      const { w, h } = deps.size();
      switch (id) {
        case 'frame': {
          // Asked for: the camera goes to the selection. (A stored edit never
          // moves it - `host.focus` stays quiet - but this is the player's own
          // request, and it used to do nothing at all.)
          const building = tool.selected();
          if (building) deps.focusBuilding?.(building);
          break;
        }
        case 'top':
          // A true plan view: straight down, keeping the bearing.
          deps.view().setOrbit(deps.view().azimuth, Math.PI / 2);
          break;
        case 'turnLeft':
          deps.view().rotate(-1, w / 2, h / 2, w, h);
          break;
        case 'turnRight':
          deps.view().rotate(1, w / 2, h / 2, w, h);
          break;
        default:
          break;
      }
      deps.requestDraw();
    },
  };

  const workspace = initBuilderWorkspace(actions);

  /**
   * A transient answer to an action, in the workspace's own bar: the game's
   * hint bar is hidden while the Builder is up, so a message sent there was a
   * message nobody read.
   */
  function notify(key: string, params?: Readonly<Record<string, string | number>>): void {
    const text = t(key, params);
    workspace.flash(text);
    deps.flash(key, params);
  }

  /** One inspector number, applied to the model. */
  function setField(id: string, value: number): void {
    const metres = METERS_PER_UNIT;
    switch (id) {
      case 'floors': tool.setStoreys(Math.max(1, Math.round(value))); return;
      case 'floorHeight': tool.setParameter('storeyHeight', value / metres); return;
      case 'groundHeight': tool.setGroundHeight(value / metres); return;
      case 'pitch': tool.setRoofShape({ pitch: value }); return;
      case 'relief': tool.setRelief(value / metres); return;
      case 'elementW': tool.updateElement({ w: value / metres }); return;
      case 'elementD': tool.updateElement({ d: value / metres }); return;
      case 'elementH': tool.updateElement({ h: value / metres }); return;
      case 'bays': tool.setFacadeGeometry({ bays: Math.max(1, Math.round(value)) }); return;
      case 'windowWidth': tool.setFacadeGeometry({ windowWidth: value / 100 }); return;
      case 'windowHeight': tool.setFacadeGeometry({ windowHeight: value / 100 }); return;
      case 'sill': tool.setFacadeGeometry({ sill: value / metres }); return;
      case 'pierWidth': tool.setFacadeGeometry({ pierWidth: value / metres }); return;
      case 'pierDepth': tool.setFacadeGeometry({ pierDepth: value / metres }); return;
      case 'pierEvery': tool.setFacadeGeometry({ pierEvery: Math.max(1, Math.round(value)) }); return;
      case 'detailHeight': tool.setRoofDetailHeight(value); return;
      case 'detailFlag': tool.setRoofDetailFlag((['none', 'plain', 'saoPaulo', 'saoPauloState'] as const)[value] ?? 'none'); return;
      case 'volW': tool.setVolumeSize(value / metres, null); return;
      case 'volX': tool.setBlockOffset(value / metres, null); return;
      case 'volY': tool.setBlockOffset(null, value / metres); return;
      case 'volBase': tool.setBlockBase(Math.round(value)); return;
      case 'function': tool.setFunction(value > 0 ? BUILDING_FUNCTIONS[value - 1] ?? null : null); return;
      case 'volD': tool.setVolumeSize(null, value / metres); return;
      default: return;
    }
  }

  /**
   * The sentence the hint bar shows: the plan being drawn wins, otherwise the
   * tool the tray has chosen.
   */
  function hintKey(): string {
    if (tool.planPoints) {
      return tool.planAction === 'new' ? (toolId === 'sketch' ? 'sketch' : 'draw.new') : `draw.${tool.planAction}`;
    }
    if (DRAW_SHAPES[toolId]) return 'sketch';
    return toolId;
  }

  /** The precise numbers of the current selection, for the inspector. */
  function inspectorFields(): BuilderField[] {
    const building = tool.selected();
    if (!building) return [];
    const volume = tool.selection ? volumeById(building, tool.selection.volume) : undefined;
    const fields: BuilderField[] = [];
    const metres = METERS_PER_UNIT;
    if (volume) {
      fields.push(
        { id: 'floors', labelKey: 'builder.field.storeys', value: volume.storeys.length, unit: 'count', min: 1, max: 60, step: 1 },
      );
    }
    fields.push(
      { id: 'floorHeight', labelKey: 'builder.field.storeyHeight', value: building.storeyHeight * metres, unit: 'm', min: 2.6, max: 9, step: 0.05 },
      { id: 'groundHeight', labelKey: 'builder.field.groundHeight', value: building.groundHeight * metres, unit: 'm', min: 2.6, max: 20, step: 0.1 },
    );
    if (volume) {
      const area = Math.abs(signedArea(localFootprint(volume))) * metres ** 2;
      // The block's own plan, in metres, about its centre: a setback is made
      // exact by typing its width and depth.
      if (!tool.selection?.bay && !tool.selectedElement() && tool.selectedRoofDetail === null) {
        fields.push(
          { id: 'volW', labelKey: 'builder.field.width', value: volume.w * metres, unit: 'm', min: 1, max: 400, step: 0.5 },
          { id: 'volD', labelKey: 'builder.field.depth.plan', value: volume.d * metres, unit: 'm', min: 1, max: 400, step: 0.5 },
        );
      }
      if (!tool.selection?.bay && !tool.selectedElement() && tool.selectedRoofDetail === null) {
        // Where the block sits: its centre from the centre of the block it
        // stands on (or the first block), and the level it starts on.
        const offset = tool.blockOffset();
        if (offset) {
          fields.push(
            { id: 'volX', labelKey: 'builder.field.offsetX', value: offset.x * metres, unit: 'm', min: -400, max: 400, step: 0.5 },
            { id: 'volY', labelKey: 'builder.field.offsetY', value: offset.y * metres, unit: 'm', min: -400, max: 400, step: 0.5 },
          );
        }
        // What the building is for: any building can become any of them.
        fields.push({
          id: 'function', labelKey: 'builder.field.function', value: building.function ? BUILDING_FUNCTIONS.indexOf(building.function) + 1 : 0,
          options: [{ value: 0, labelKey: 'building.fn.none' }, ...BUILDING_FUNCTIONS.map((fn, i) => ({ value: i + 1, labelKey: `building.fn.${fn}` }))],
        });
        fields.push({ id: 'volBase', labelKey: 'builder.field.baseLevel', value: volume.base, unit: 'count', min: 0, max: 99, step: 1 });
        fields.push({ id: 'mode', labelKey: 'builder.field.blockMode', value: 0, text: t(`builder.blockMode.${volume.mode ?? 'solid'}`) });
      }
      fields.push({ id: 'area', labelKey: 'builder.field.area', value: area, unit: 'm', text: `${area.toFixed(1)} m²` });
      const pitched = volume.roof === 'gable' || volume.roof === 'hip' || volume.roof === 'shed' || volume.roof === 'sawtooth';
      if (pitched) {
        fields.push({ id: 'pitch', labelKey: 'builder.field.pitch', value: volume.pitch ?? DEFAULT_PITCH[volume.roof] ?? 30, unit: 'deg', min: 5, max: 60, step: 1 });
      }
    }
    if (tool.selection?.bay && volume) {
      const bay = tool.selection.bay;
      const authored = volume.facadeGeometry?.[bay.side];
      fields.push(
        { id: 'relief', labelKey: 'builder.field.depth', value: tool.reliefDepth() * metres, unit: 'm', min: -4, max: 2.4, step: 0.05 },
        { id: 'bays', labelKey: 'builder.field.bays', value: baysOn(building, volume, bay.side), unit: 'count', min: 1, max: 40, step: 1 },
        { id: 'windowWidth', labelKey: 'builder.field.windowWidth', value: (authored?.windowWidth ?? 0.55) * 100, unit: 'percent', min: 10, max: 100, step: 1 },
        { id: 'windowHeight', labelKey: 'builder.field.windowHeight', value: (authored?.windowHeight ?? 0.6) * 100, unit: 'percent', min: 10, max: 100, step: 1 },
        { id: 'sill', labelKey: 'builder.field.sill', value: (authored?.sill ?? m(0.9)) * metres, unit: 'm', min: 0, max: 6, step: 0.05 },
        { id: 'pierWidth', labelKey: 'builder.field.pierWidth', value: (authored?.pierWidth ?? m(0.36)) * metres, unit: 'm', min: 0, max: 4, step: 0.05 },
        { id: 'pierDepth', labelKey: 'builder.field.pierDepth', value: (authored?.pierDepth ?? 0) * metres, unit: 'm', min: 0, max: 2.4, step: 0.05 },
        { id: 'pierEvery', labelKey: 'builder.field.pierEvery', value: authored?.pierEvery ?? 1, unit: 'count', min: 1, max: 16, step: 1 },
      );
    }
    const element = tool.selectedElement();
    if (element) {
      fields.push(
        { id: 'elementW', labelKey: 'builder.field.width', value: element.w * metres, unit: 'm', min: 0.1, max: 40, step: 0.05 },
        { id: 'elementD', labelKey: 'builder.field.length', value: element.d * metres, unit: 'm', min: 0.1, max: 40, step: 0.05 },
        { id: 'elementH', labelKey: 'builder.field.height', value: element.h * metres, unit: 'm', min: 0.1, max: 40, step: 0.05 },
      );
    }
    const detail = volume?.roofDetails?.find((part) => part.id === tool.selectedRoofDetail);
    if (detail?.kind === 'spire') {
      fields.push({ id: 'detailHeight', labelKey: 'builder.field.height', value: (detail.h ?? 0) * metres, unit: 'm', min: 0, max: 40, step: 0.1 });
      const flags = ['none', 'plain', 'saoPaulo', 'saoPauloState'] as const;
      fields.push({
        id: 'detailFlag', labelKey: 'builder.field.flag', value: Math.max(0, flags.indexOf(detail.flag ?? 'none')),
        options: flags.map((flag, value) => ({ value, labelKey: `builder.flag.${flag}` })),
      });
    }
    return fields;
  }

  /** What the inspector is looking at, in one line. */
  function selectionName(): string {
    const building = tool.selected();
    if (!building) return '';
    const volume = tool.selection ? volumeById(building, tool.selection.volume) : undefined;
    if (tool.selectedElement()) return t('builder.sel.element');
    if (tool.selection?.bay && volume) return `${t('builder.sel.face')} · ${t('builder.sel.floor', { n: volume.base + tool.selection.bay.storey + 1 })}`;
    if (tool.selectedRoofDetail !== null) return t('builder.sel.detail');
    if (volume) return t('builder.sel.volume', { n: volume.id });
    return t('builder.sel.building');
  }

  const materialLine = (): string | undefined => {
    const material = tool.currentMaterial();
    return material ? `${t(`building.finish.${material.finish}`)} · #${material.colour.toString(16).padStart(6, '0')}` : undefined;
  };

  const state = (): BuilderState => {
    const building = tool.selected();
    const volume = building && tool.selection ? volumeById(building, tool.selection.volume) : undefined;
    const fields = inspectorFields();
    const material = materialLine();
    return {
      category,
      tool: toolId,
      armed: tool.armed,
      ready: new Set(READY),
      floor: {
        active: volume && tool.selection?.bay ? volume.base + tool.selection.bay.storey : volume?.base ?? 0,
        total: building ? topLevel(building) : 1,
      },
      snap: snapMode,
      grid: gridVisible,
      hideOthers,
      canUndo: history.canUndo,
      canRedo: history.canRedo,
      inspectorOpen,
      busy: tool.dragging || (tool.planPoints?.length ?? 0) > 0,
      selection: building && (volume || tool.selection?.bay || tool.selectedElement() || tool.selectedRoofDetail !== null)
        ? {
          titleKey: 'builder.sel.title',
          name: selectionName(),
          fields,
          ...(material === undefined ? {} : { material }),
        }
        : null,
      hint: t(`hint.builder.${hintKey()}`),
      planning: Array.isArray(tool.planPoints) && !tool.shapeDragStart,
      planPoints: tool.planPoints?.length ?? 0,
      userBlueprints,
      pattern: building && volume ? (volume.facadePattern ?? null) : null,
      scope: tool.scope,
      roof: volume
        ? {
          pitch: volume.pitch ?? DEFAULT_PITCH[volume.roof] ?? 30,
          ridge: ridgeAlongX(volume) ? 'x' : 'y',
          fall: volume.fall ?? 0,
          pitched: volume.roof !== 'flat' && volume.roof !== 'terrace',
        }
        : null,
      material: tool.currentMaterial(),
      drawAction,
    };
  };

  function refresh(): void {
    if (!dirty) return;
    dirty = false;
    workspace.refresh(state());
  }

  /** The Builder's own layer: the construction grid and the number being typed. */
  const drawGizmos = (ctx: CanvasRenderingContext2D): void => {
    const building = tool.selected();
    const input: GizmoInput = {
      project: view.project,
      handles: [],
      hovered: null,
      grid: gridVisible && building ? { centre: { x: building.x, y: building.y }, z: tool.floorOf(building) + m(0.05) } : null,
      ring: null,
      draw: null,
      measure: null,
      numeric: null,
      snap: null,
      repeat: null,
      floorBand: null,
    };
    drawBuilderGizmos(ctx, input);
  };

  return {
    tool,
    workspace,
    /**
     * A click on the map with nothing in hand: two on a building open it (or
     * close it, on open ground); one, while a building is open, opens the
     * one clicked instead. Returns whether the click was taken.
     */
    insideClick(screen: { x: number; y: number }, double: boolean): boolean {
      const hit = tool.buildingAt(screen);
      if (double) {
        seeInside.on = hit !== null;
        seeInside.target = hit;
      } else if (seeInside.on && hit !== null) {
        seeInside.target = hit;
      } else return false;
      workspace.showInside({ on: seeInside.on, level: seeInside.level });
      deps.requestDraw();
      return true;
    },
    pointerDown(screen, world, shift) {
      if (toolId === 'paint') {
        painting = true;
        tool.paintStroke(screen);
        dirty = true;
        return;
      }
      const shape = shapeOfTool(toolId);
      if (shape || (toolId === 'sketch' && !tool.planPoints)) {
        if (drawAction !== 'new' && !tool.selected()) {
          notify('building.selectFirst');
          dirty = true;
          return;
        }
        if (shape) {
          tool.beginShapeDrag(shape, world, drawAction, screen);
          dirty = true;
          return;
        }
      }
      const action = planActionOfTool(toolId);
      if (action) {
        if (!tool.selected()) {
          notify('building.selectFirst');
          dirty = true;
          return;
        }
        tool.beginShapeDrag('rectangle', world, action, screen);
        dirty = true;
        return;
      }
      // The free plan starts on the first click of the gesture - and that click
      // is its first corner. It used to only start the plan and return, so the
      // press was never armed as a click: three corners clicked gave two
      // points, and a square came out a triangle.
      if (toolId === 'sketch' && !tool.planPoints) tool.startPlan(drawAction);
      tool.pointerDown(screen, world, shift);
      dirty = true;
    },
    pointerMove(screen, world, shift) {
      if (painting) {
        tool.paintStroke(screen);
        dirty = true;
        return;
      }
      if (tool.shapeDragStart) {
        tool.updateShapeDrag(world, screen);
        dirty = true;
        return;
      }
      tool.pointerMove(screen, world, shift);
      dirty = true;
    },
    pointerUp(cancelled) {
      if (painting) {
        painting = false;
        tool.endPaintStroke();
        dirty = true;
        return;
      }
      const revision = doc.buildings.revision;
      if (tool.shapeDragStart) tool.endShapeDrag(cancelled);
      else tool.pointerUp(cancelled);
      afterGesture(revision);
      dirty = true;
    },
    cancelOperation() {
      const used = tool.cancelOperation();
      if (used) dirty = true;
      // Nothing to cancel but a tool in hand: the right button puts it down.
      if (toolId !== 'select' && !tool.planPoints) {
        backToSelect();
        host.changed();
        return true;
      }
      return used;
    },
    key(e) {
      const ctrl = e.ctrlKey || e.metaKey;
      if (ctrl && e.key.toLowerCase() === 'c' && tool.copySelected()) {
        notify('building.copied');
        return true;
      }
      const revision = doc.buildings.revision;
      const used = tool.key(e.key, ctrl, e.shiftKey);
      if (used) {
        afterGesture(revision);
        // Escape with nothing left to put down: the pointer selects.
        if (e.key === 'Escape' && toolId !== 'select' && !tool.planPoints) backToSelect();
        dirty = true;
      }
      return used;
    },
    activate() {
      dirty = true;
      // The pointer selects on arrival: the tool used to wake up holding the
      // first model, whose ghost then followed every other tool around.
      if (toolId === 'select' && !tool.planPoints) tool.armModelTool('select');
      // Nothing in hand: open on the models, the shapes a tab away.
      if (!tool.selected() && !tool.planPoints) workspace.showGallery('models');
      refresh();
    },
    deactivate() {
      // A stroke or a shape drag left running across a tool switch came back to
      // life on return: hovering painted faces with no button held, and the
      // next release built a shape from a stale corner.
      if (painting) {
        painting = false;
        tool.endPaintStroke();
      }
      if (tool.shapeDragStart) tool.endShapeDrag(true);
      tool.deactivate();
      scene.setBuildingPreview(null);
      scene.setBuildingsDimmed(undefined);
      hideOthers = false;
    },
    beforeDraw(active) {
      // A gesture's ghost wins; otherwise, in the interior view, the building
      // cut open at its floor.
      // See inside, city-wide: the buildings around the middle of the view,
      // re-centred in steps so a pan does not rebuild them every frame.
      const { w, h } = deps.size();
      const c = deps.view().toWorld(w / 2, h / 2, w, h);
      const ahead = deps.view().toWorld(w / 2, h / 2 - 100, w, h);
      const len = Math.hypot(ahead.x - c.x, ahead.y - c.y) || 1;
      tool.cutView = { x: (ahead.x - c.x) / len, y: (ahead.y - c.y) / len };
      const target = seeInside.on && seeInside.target !== null ? doc.buildings.get(seeInside.target) : undefined;
      if (target) {
        scene.setBuildingCutaway({
          level: seeInside.level, x: target.x, y: target.y, radius: 0, only: target.id,
          view: { x: (ahead.x - c.x) / len, y: (ahead.y - c.y) / len },
        });
      } else scene.setBuildingCutaway(null);
      scene.setBuildingPreview(active ? tool.preview ?? tool.interiorPreview() : null);
      if (active) refresh();
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
        label = { text, valid: preview.valid, building: preview.building, floor: tool.floorOf(preview.building) };
      }
      drawBuildingOverlay(ctx, {
        project: view.project,
        stage: tool.stage,
        plan: tool.planPoints ? { points: tool.planPoints, cursor: tool.planCursor, groundAt: tool.planHeight === null ? view.groundAt : () => tool.planHeight! } : null,
        hover: hovered && tool.mode === 'edit' ? { building: hovered, floor: tool.floorOf(hovered) } : null,
        selected: shown && tool.selection && tool.mode === 'edit'
          ? { building: shown, volume: tool.selection.volume, floor: tool.floorOf(shown), bay: tool.selection.bay, vertex: tool.selection.vertex, region: tool.faceRegion() }
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
      drawGizmos(ctx);
    },
    restored() {
      tool.sync();
      host.changed();
    },
    afterRoadEdit() {
      const razed = clearBuildingsOnRoads({ doc, net, groundAt: null });
      if (razed > 0) {
        tool.sync();
        notify(razed === 1 ? 'building.demolished.one' : 'building.demolished.other', { count: razed });
      }
    },
    bulldozeAt(screen) {
      const hit = tool.pickAt(screen);
      if (!hit) return false;
      const result = host.commit(() => ({ ok: deleteBuilding(host.context(), hit.building) }));
      tool.sync();
      return result.ok;
    },
    requestThumbnails,
    hintKey(prefix) {
      return `${prefix}.builder.${tool.builderHintKey()}`;
    },
    languageChanged() {
      dirty = true;
      workspace.relabel();
      lastHint = '';
      refresh();
    },
  };
}

/** The basic shape each tool of the Draw tab throws. */
const PRIMITIVE_OF_TOOL: Readonly<Record<string, Primitive>> = {
  primBox: 'box',
  primCylinder: 'cylinder',
  primOctagonal: 'octagonal',
  primPrism: 'prism',
  primWedge: 'wedge',
  primPyramid: 'pyramid',
  primCone: 'cone',
  primCross: 'crossBlock',
};

/** Every tool the catalogue lists, all of them wired to the engine. */
/**
 * Every tool the catalogue lists is wired to the engine. Derived from the
 * catalogue itself, so a tool added there can never sit in the tray disabled
 * with no reason - which is exactly what happened to the first family menus.
 */
const READY: ReadonlySet<string> = new Set(BUILDER_CATALOG.flatMap((category) => category.tools.map((tool) => tool.id)));
