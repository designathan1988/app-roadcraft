import type { Vec2 } from '@core/vec2';
import { RoadDoc } from '@world/doc';
import type { Network } from '@world/network';
import { bodyOf } from '@world/buildings/blueprints';
import { footprintCells, topLevel } from '@world/buildings/geometry';
import { type BuildingUse, BUILDING_USES, volumeById } from '@world/buildings/types';
import { METERS_PER_UNIT } from '@world/units';
import { type EditResult, clearBuildingsOnRoads, deleteBuilding } from '@editor/buildings';
import { BuildingTool, type ToolHost, type ToolView } from '@editor/buildingTool';
import { BlueprintLibrary } from '@editor/blueprintLibrary';
import type { History } from '@editor/history';
import type { Viewport } from '@view/viewport';
import type { SceneHandle } from '@render/renderer';
import { type BuildingPanelState, initBuildingPanel, refreshBuildingPanelLabels } from '@ui/buildingPanel';
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
    pickPixels: 16,
  };

  let panelDirty = true;
  let lastMode = 'place';
  const host: ToolHost = {
    context: () => ({ doc, net, groundAt: (x: number, y: number) => scene.terrainHeightAt(x, y) }),
    groundKey: () => `${doc.revision}:${doc.terrainRevision}`,
    commit(edit: () => EditResult): EditResult {
      const before = doc.toJSON();
      const result = edit();
      if (!result.ok) return result;
      history.record(RoadDoc.fromJSON(before));
      deps.afterEdit();
      return result;
    },
    changed() {
      panelDirty = true;
      if (tool.mode !== lastMode) {
        lastMode = tool.mode;
        deps.hintChanged();
      }
      deps.requestDraw();
    },
    flash: (key) => deps.flash(key),
  };

  const tool = new BuildingTool(view, host);

  const panel = initBuildingPanel({
    setMode: (mode) => tool.setMode(mode),
    setUse: (use) => tool.setUse(use),
    chooseBlueprint: (key) => tool.chooseBlueprint(key),
    chooseUserBlueprint(key) {
      const bp = library.list().find((b) => b.key === key);
      if (bp) tool.useBody(bp.body, bp.key);
    },
    removeUserBlueprint(key) {
      library.remove(key);
      host.changed();
    },
    setParameter(name, value, commit) {
      // In place mode a slider regenerates the ghost as it moves; on a
      // selected building only the release is an edit (one undo step).
      if (tool.mode === 'edit' && tool.selection && !commit) return;
      tool.setParameter(name, value);
    },
    action(name) {
      switch (name) {
        case 'storeyUp': tool.addStoreys(1); break;
        case 'storeyDown': tool.addStoreys(-1); break;
        case 'setback': tool.addSetback(); break;
        case 'removeVolume': tool.removeVolume(); break;
        case 'rotate': tool.rotateSelected(Math.PI / 2); break;
        case 'duplicate': tool.duplicateSelected(); break;
        case 'colour': tool.cyclePalette(); break;
        case 'delete': tool.deleteSelected(); break;
        case 'saveBlueprint': {
          const b = tool.selected();
          if (!b) break;
          const name = window.prompt(t('building.blueprintName'), b.blueprint ? t(`building.preset.${b.blueprint}`) : '');
          if (name === null) break;
          if (library.save(name, bodyOf(b))) deps.flash('building.blueprintSaved');
          host.changed();
          break;
        }
      }
    },
    addWing: (side) => tool.addWing(side),
    setRoof: (roof) => tool.setRoof(roof),
    armComponent(component) {
      tool.armComponent(component);
      // A component picked while a bay is already selected goes straight in.
      if (component && tool.selection?.bay) tool.applyToSelectedBay(component);
    },
    setScope: (scope) => tool.setScope(scope),
  });

  const panelState = (): BuildingPanelState => {
    const b = tool.mode === 'edit' ? tool.selected() : null;
    const v = b && tool.selection ? volumeById(b, tool.selection.volume) : undefined;
    const body = tool.body;
    const first = body.volumes.find((x) => x.base === 0) ?? body.volumes[0];
    const params = b && v
      ? { width: v.w, depth: v.d, storeys: v.storeys.length, storeyHeight: b.storeyHeight, module: b.module }
      : {
        width: first?.w ?? tool.params.width,
        depth: first?.d ?? tool.params.depth,
        storeys: first?.storeys.length ?? tool.params.storeys,
        storeyHeight: body.storeyHeight,
        module: body.module,
      };
    let selection: BuildingPanelState['selection'] = null;
    if (b && v) {
      const f = footprintCells(b);
      selection = {
        floors: topLevel(b),
        width: (f.x1 - f.x0) * b.module,
        depth: (f.y1 - f.y0) * b.module,
        volumes: b.volumes.length,
        roof: v.roof,
      };
    }
    return {
      mode: tool.mode,
      use: b?.use ?? body.use,
      blueprintKey: tool.blueprintKey,
      userBlueprints: library.list(),
      params,
      selection,
      component: tool.component,
      scope: tool.scope,
    };
  };

  const refreshPanel = (): void => {
    if (!panelDirty) return;
    panelDirty = false;
    panel.refresh(panelState());
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
      if (!ctrl && /^[1-4]$/.test(e.key)) {
        tool.setUse(BUILDING_USES[Number(e.key) - 1] as BuildingUse);
        return true;
      }
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
        const f = footprintCells(preview.building);
        const size = `${((f.x1 - f.x0) * preview.building.module * METERS_PER_UNIT).toFixed(0)} × ${((f.y1 - f.y0) * preview.building.module * METERS_PER_UNIT).toFixed(0)} m`;
        const text = preview.problem
          ? t(`building.problem.${preview.problem}`)
          : `${plural('building.floors', floors)} · ${size}`;
        label = { text, valid: preview.valid, building: preview.building, floor: floorOf(preview.building) };
      }
      drawBuildingOverlay(ctx, {
        project: view.project,
        hover: hovered && tool.mode === 'edit' ? { building: hovered, floor: floorOf(hovered) } : null,
        selected: shown && tool.selection && tool.mode === 'edit'
          ? { building: shown, volume: tool.selection.volume, floor: floorOf(shown), bay: tool.selection.bay }
          : null,
        handles: tool.handles(),
        label,
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
      return `${prefix}.building.${tool.mode}`;
    },
    languageChanged() {
      refreshBuildingPanelLabels();
      panelDirty = true;
      refreshPanel();
    },
  };
}
