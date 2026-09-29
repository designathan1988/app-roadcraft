import { BLUEPRINTS, type Blueprint } from '@world/buildings/blueprints';
import { FINISHES, type Finish, STYLES } from '@world/buildings/materials';
import {
  BUILDER_GALLERIES,
  BUILDER_GROUPS,
  DRAW_SHAPES,
  FACADE_SCOPES,
  type BuilderCategoryId,
  type BuilderField,
  type BuilderSelectionInfo,
  categorySpec,
  groupOfCategory,
} from './catalog';
import { FACADE_PATTERNS, ELEMENT_KINDS } from '@world/buildings/types';
import { t } from '../i18n';
import { builderIconSvg } from './icons';
import { materialSwatch } from '../materialSwatch';
import { planSwatch } from '../planSwatch';
import './workspace.css';

export type { BuilderField, BuilderSelectionInfo };

/**
 * The game's chrome, in one paradigm: a thin bar at the top for global state,
 * and an expanding container at the bottom that grows upward in three tiers -
 * the categories, the sub-tools of the chosen one, and a visual gallery of
 * what can be placed. The centre of the screen belongs to the map, always.
 *
 * The same container drives the whole game: on the road it carries the road
 * tools and their palettes (which `main.ts` mounts into the tier hosts), and
 * in the Builder it carries the building categories, their tools and their
 * galleries. The right side stays a thin inspector of nothing but numbers.
 *
 * This module only renders state and reports clicks: `buildingsWiring.ts` and
 * `main.ts` turn every one of them into a command. Nothing here reads the
 * document.
 */

export type ChromeMode = 'road' | 'builder';

export interface BuilderState {
  readonly category: BuilderCategoryId;
  /** The active tool id (may be an action that ran once). */
  readonly tool: string;
  /** The mode tool currently taking the pointer, if any. */
  readonly armed: string | null;
  /** Tool ids that are implemented and clickable right now. */
  readonly ready: ReadonlySet<string>;
  readonly floor: { readonly active: number; readonly total: number };
  readonly snap: string;
  readonly grid: boolean;
  readonly hideOthers: boolean;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly inspectorOpen: boolean;
  /** True while a gesture is running: the gallery folds down to give the map room. */
  readonly busy: boolean;
  readonly selection: BuilderSelectionInfo | null;
  /** Screen position of the selection's quick actions bar, or null. */
  readonly quickBar: { readonly x: number; readonly y: number } | null;
  /** One sentence on what the active tool does now. */
  readonly hint: string;
  /** A plan is being drawn: the trays carry Finish, Back and Cancel. */
  readonly planning: boolean;
  /** How many points the plan has, for the count beside those controls. */
  readonly planPoints: number;
  readonly userBlueprints: readonly Blueprint[];
  /** The facade pattern the Face category would apply, and where. */
  readonly pattern: string | null;
  readonly scope: string;
  /** The selected mass's roof, for the ridge and slope gallery. */
  readonly roof: { readonly pitch: number; readonly ridge: 'x' | 'y'; readonly fall: number; readonly pitched: boolean } | null;
  /** The material the finish tools would paint now. */
  readonly material: { readonly finish: Finish; readonly colour: number } | null;
}

export interface BuilderActions {
  undo(): void;
  redo(): void;
  setCategory(id: BuilderCategoryId): void;
  chooseTool(id: string): void;
  setFloor(n: number): void;
  floorCommand(command: 'duplicate' | 'insertAbove' | 'insertBelow'): void;
  setSnap(mode: string): void;
  toggleGrid(): void;
  toggleHideOthers(): void;
  toggleInspector(): void;
  selectionAction(name: 'duplicate' | 'mirror' | 'group' | 'delete'): void;
  setField(id: string, value: number): void;
  choosePreset(key: string): void;
  chooseUserBlueprint(key: string): void;
  removeUserBlueprint(key: string): void;
  chooseFinish(finish: Finish): void;
  chooseColour(colour: number): void;
  chooseStyle(key: string): void;
  choosePattern(pattern: string): void;
  setScope(scope: string): void;
  saveBlueprint(name: string): void;
  planFinish(): void;
  planBack(): void;
  planCancel(): void;
  roofPitch(delta: number): void;
  roofRidge(ridge: 'x' | 'y'): void;
  roofFall(side: number): void;
  /** A view command from the Vista menu: frame | top | turnLeft | turnRight. */
  view(id: string): void;
}

export interface BuilderWorkspace {
  refresh(state: BuilderState): void;
  /** Which half of the game the container is driving. */
  setMode(mode: ChromeMode): void;
  /**
   * The tier hosts: `main.ts` mounts the road toolbar and its palettes into
   * `level1`/`level2`, and the simulation panel and the app menu into the two
   * bar menus, so the whole game shares one chrome.
   */
  readonly hosts: {
    readonly level1: HTMLElement;
    readonly level2: HTMLElement;
    readonly simMenu: HTMLElement;
    readonly appMenu: HTMLElement;
    /** Pause and framing, mounted by main.ts on the global bar. */
    readonly controls: HTMLElement;
    /** The band's foot line, where the game's hint bar lives. */
    readonly hint: HTMLElement;
  };
  /** A transient sentence in the chrome's own hint bar. */
  flash(text: string): void;
  /** Re-labels everything after a language change. */
  relabel(): void;
  /** Paints the gallery's pictures once they are rendered. */
  setPresetThumbnails(images: ReadonlyMap<string, string>): void;
  readonly root: HTMLElement;
}

export const SNAP_MODES = ['auto', 'grid', 'edge', 'face', 'centre', 'building', 'road', 'off'] as const;

/** Colours offered at a click; a picker covers the rest. */
const SWATCHES: readonly number[] = [
  0xf2efe8, 0xe6d8bd, 0xd8c297, 0xc98f5a, 0xa4563f, 0x72412f, 0x9c6b43,
  0xbdbcb4, 0x8f9ba5, 0x55585c, 0x2f3134, 0x7d8c6a, 0x5d7a8f, 0x9fb8c4,
];

const hexOf = (colour: number): string => `#${colour.toString(16).padStart(6, '0')}`;

const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  html?: string,
): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (html !== undefined) node.innerHTML = html;
  return node;
};

const chevron = (): string =>
  '<svg class="bw-chevron" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 6l6 6-6 6"/></svg>';

/** A gallery tile: the glyph large, the name under it. */
const tile = (id: string, label: string, on: boolean, run: () => void, thumb?: string): HTMLButtonElement => {
  const b = el('button', 'bw-tile' + (on ? ' active' : ''));
  b.type = 'button';
  b.dataset['tile'] = id;
  b.title = label;
  const art = thumb
    ? `<img class="bw-tile-art" src="${thumb}" alt="" />`
    : `<span class="bw-tile-art">${builderIconSvg(id, 32)}</span>`;
  b.innerHTML = `${art}<span class="bw-tile-name"></span>`;
  (b.querySelector('.bw-tile-name') as HTMLElement).textContent = label;
  b.onclick = run;
  return b;
};

export function initBuilderWorkspace(actions: BuilderActions): BuilderWorkspace {
  const root = document.getElementById('builder') as HTMLElement;

  // ------------------------------------------------------------ the top bar
  const top = el('div', 'bw-top');

  const historyGroup = el('div', 'bw-group');
  const undo = el('button', 'bw-icon-button');
  undo.type = 'button';
  undo.dataset['i18nTitle'] = 'action.undo';
  undo.onclick = () => actions.undo();
  const redo = el('button', 'bw-icon-button');
  redo.type = 'button';
  redo.dataset['i18nTitle'] = 'action.redo';
  redo.onclick = () => actions.redo();
  historyGroup.append(undo, redo);

  const spacer = el('span', 'bw-spacer');
  const help = el('button', 'bw-icon-button bw-help');
  help.type = 'button';
  help.dataset['i18nTitle'] = 'builder.help';
  help.onclick = () => showMenu('help', help);

  // Two menus belong to the whole game and are filled by `main.ts`.
  const controlsSlot = el('div', 'bw-controls');
  const simMenu = el('button', 'bw-chip');
  simMenu.type = 'button';
  simMenu.innerHTML = `${builderIconSvg('sim', 15)}<span></span><i class="bw-caret"></i>`;
  (simMenu.querySelector('span') as HTMLElement).textContent = t('builder.menu.simulation');
  simMenu.onclick = () => showMenu('sim', simMenu);
  const appMenu = el('button', 'bw-chip');
  appMenu.type = 'button';
  appMenu.innerHTML = `${builderIconSvg('menu', 15)}<span></span><i class="bw-caret"></i>`;
  (appMenu.querySelector('span') as HTMLElement).textContent = t('builder.menu.app');
  appMenu.onclick = () => showMenu('app', appMenu);

  // Menu first, then the simulation, then the help: the two that open panels
  // and the one that explains them, at the left where the eye starts.
  top.append(appMenu, simMenu, help, spacer, historyGroup, controlsSlot);

  /**
   * One drop-down below the bar. Three children live in it for good - the
   * bar's own menus, the simulation panel and the app menu main.ts mounts -
   * and showing one is a visibility change, never a move: moving a mounted
   * panel out of its slot destroys it the moment another menu opens.
   */
  const drop = el('div', 'bw-drop');
  drop.hidden = true;
  const dropBar = el('div', 'bw-drop-body');
  const simSlot = el('div', 'bw-slot');
  const appSlot = el('div', 'bw-slot');
  drop.append(dropBar, simSlot, appSlot);
  let openMenu: { id: string; anchor: HTMLElement } | null = null;

  const showMenu = (id: string, anchor: HTMLElement): void => {
    if (openMenu?.id === id) {
      closeMenu();
      return;
    }
    openMenu = { id, anchor };
    dropBar.hidden = id === 'sim' || id === 'app';
    simSlot.hidden = id !== 'sim';
    appSlot.hidden = id !== 'app';
    if (dropBar.hidden) dropBar.innerHTML = '';
    else dropBar.appendChild(dropBodyFor(id));
    const r = anchor.getBoundingClientRect();
    drop.style.left = `${Math.max(10, Math.min(r.left, window.innerWidth - 340))}px`;
    // Hung from the chip that opened it: left to itself an absolute box sits at
    // the top of the overlay, over the bar it belongs to.
    drop.style.top = `${Math.round(r.bottom + 6)}px`;
    drop.hidden = false;
  };
  const closeMenu = (): void => {
    drop.hidden = true;
    dropBar.innerHTML = '';
    simSlot.hidden = true;
    appSlot.hidden = true;
    openMenu = null;
  };
  document.addEventListener(
    'pointerdown',
    (e) => {
      if (!openMenu) return;
      const target = e.target as Node;
      if (!drop.contains(target) && !top.contains(target)) closeMenu();
    },
    true,
  );

  // ------------------------------------------------------------ the dock
  const dock = el('div', 'bw-dock');
  // Tier 1 is the game's toolbar, and nothing else, in every tool: the band is
  // the same band whether a road or a wall is being placed.
  const tier1 = el('div', 'bw-tier bw-tier1');
  const tier1Road = el('div', 'bw-host bw-host-road');
  tier1.append(tier1Road);

  // Tier 2 is the tray of the tool in hand: the road palette, the terrain
  // palette, or the Builder's categories. The Builder is not a mode - its
  // categories and their tools live here, where the road classes live.
  const tier2 = el('div', 'bw-tier bw-tier2');
  const tier2Road = el('div', 'bw-host bw-host-road');
  const tier2Builder = el('div', 'bw-host bw-host-builder');
  const tray = el('div', 'bw-tray');
  // Reading down: what is global, then the three groups, then the tools of the
  // group in hand, then the entries of the tool. Content comes last, and keeps
  // the room the commands used to take.
  const globalsRow = el('div', 'bw-globals');
  const groupsRow = el('div', 'bw-groups');
  const toolsRow = el('div', 'bw-tools');
  const familiesRow = el('div', 'bw-families');
  const contextRow = el('div', 'bw-context');
  globalsRow.append(contextRow);
  tray.append(globalsRow, groupsRow, toolsRow, familiesRow);
  tier2Builder.append(tray);
  tier2.append(tier2Road, tier2Builder);

  // The Builder's own controls sit at the end of the category row, and only
  // while the building tool is the one in hand.
  const floorChip = el('button', 'bw-chip bw-floor');
  floorChip.type = 'button';
  floorChip.onclick = () => showMenu('floor', floorChip);
  const snapChip = el('button', 'bw-chip bw-snap');
  snapChip.type = 'button';
  snapChip.onclick = () => showMenu('snap', snapChip);
  const gridToggle = el('button', 'bw-chip bw-toggle');
  gridToggle.type = 'button';
  gridToggle.onclick = () => actions.toggleGrid();
  const viewChip = el('button', 'bw-chip');
  viewChip.type = 'button';
  viewChip.onclick = () => showMenu('view', viewChip);
  const hideToggle = el('button', 'bw-chip bw-toggle');
  hideToggle.type = 'button';
  hideToggle.onclick = () => actions.toggleHideOthers();
  // Selecting is not one of the three groups: it is the pointer's own tool,
  // and it sits with the snap and the grid, which are also about the pointer.
  const selectButton = el('button', 'bw-chip bw-select');
  selectButton.type = 'button';
  selectButton.dataset['builderSelect'] = 'select';
  selectButton.innerHTML = `${builderIconSvg('select', 16)}<span></span>`;
  (selectButton.querySelector('span') as HTMLElement).textContent = t('builder.category.select');
  selectButton.onclick = () => {
    openGallery = null;
    actions.setCategory('select');
  };
  contextRow.append(selectButton, floorChip, snapChip, gridToggle, viewChip, hideToggle);

  const tier3 = el('div', 'bw-tier bw-tier3');
  tier3.hidden = true;
  const foot = el('div', 'bw-foot');
  const fold = el('button', 'bw-fold');
  fold.type = 'button';
  fold.dataset['i18nTitle'] = 'builder.dock.fold';
  fold.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 15l6-6 6 6"/></svg>';
  fold.onclick = () => {
    dock.classList.toggle('folded');
    syncDock();
  };
  // The band reads top down like the panel it is: the tools, the tray of the
  // one in hand, the gallery it opens, and one line of hint along the bottom.
  dock.append(tier1, tier2, tier3, foot, fold);

  const quick = el('div', 'bw-quick');
  const hint = el('div', 'bw-hint');
  // The hint line is about the pointer, so it wears one.
  const mouse = el('span', 'bw-mouse');
  mouse.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="3" width="10" height="18" rx="5"/><path d="M12 6v4"/></svg>';
  foot.append(mouse, hint);

  const inspector = el('aside', 'bw-inspector');
  const inspectorHead = el('div', 'bw-inspector-head');
  const inspectorTitle = el('span', 'bw-inspector-title');
  const inspectorToggle = el('button', 'bw-icon-button bw-collapse');
  inspectorToggle.type = 'button';
  inspectorToggle.dataset['i18nTitle'] = 'builder.inspector.toggle';
  inspectorToggle.onclick = () => actions.toggleInspector();
  inspectorHead.append(inspectorTitle, inspectorToggle);
  const inspectorBody = el('div', 'bw-inspector-body');
  inspector.append(inspectorHead, inspectorBody);

  root.append(top, drop, dock, inspector, quick);

  const quickButtons = new Map<string, HTMLButtonElement>();
  for (const [name, icon] of [
    ['duplicate', 'duplicate'],
    ['mirror', 'mirror'],
    ['group', 'group'],
    ['delete', 'trash'],
  ] as const) {
    const b = el('button', 'bw-quick-button' + (name === 'delete' ? ' danger' : ''));
    b.type = 'button';
    b.innerHTML = builderIconSvg(icon, 16);
    b.onclick = () => actions.selectionAction(name);
    quick.appendChild(b);
    quickButtons.set(name, b);
  }

  // ------------------------------------------------------------ state
  let openGallery: string | null = null;
  let lastState: BuilderState | null = null;
  const thumbnails = new Map<string, string>();
  let hintBase = '';
  let flashTimer: ReturnType<typeof setTimeout> | null = null;

  const syncDock = (): void => {
    // Tier 3 only exists when there is something in it.
    const hasThird = tier3.childElementCount > 0;
    const folded = dock.classList.contains('folded');
    dock.classList.toggle('has-third', hasThird);
    tier2.hidden = folded;
    tier3.hidden = folded || !hasThird;
    root.dataset['dock'] = folded ? 'folded' : 'open';
  };

  const closeGalleryAnd = (run: () => void): (() => void) => () => {
    run();
    openGallery = null;
    renderDock(lastState);
  };

  // ------------------------------------------------------------ bar menus
  function dropBodyFor(id: string): HTMLElement {
    const wrap = el('div', 'bw-drop-body');
    if (id === 'snap') {
      const grid = el('div', 'bw-drop-grid');
      for (const snap of SNAP_MODES) {
        grid.appendChild(menuItem(t(`builder.snap.${snap}`), lastState?.snap === snap, () => actions.setSnap(snap)));
      }
      wrap.append(grid, menuNote('builder.snap.note'));
      return wrap;
    }
    if (id === 'floor') {
      const grid = el('div', 'bw-drop-grid floors');
      const total = Math.max(1, lastState?.floor.total ?? 1);
      for (let i = 0; i < total; i++) {
        grid.appendChild(menuItem(String(i + 1), lastState?.floor.active === i, () => actions.setFloor(i)));
      }
      const row = el('div', 'bw-drop-row');
      for (const [command, key] of [
        ['duplicate', 'builder.floor.duplicate'],
        ['insertAbove', 'builder.floor.insertAbove'],
        ['insertBelow', 'builder.floor.insertBelow'],
      ] as const) {
        row.appendChild(menuItem(t(key), false, () => actions.floorCommand(command)));
      }
      wrap.append(grid, row, menuNote('builder.floor.note'));
      return wrap;
    }
    if (id === 'view') {
      const grid = el('div', 'bw-drop-grid');
      for (const [id2, key] of [
        ['frame', 'builder.view.frame'],
        ['top', 'builder.view.top'],
        ['turnLeft', 'builder.view.turnLeft'],
        ['turnRight', 'builder.view.turnRight'],
      ] as const) {
        grid.appendChild(menuItem(t(key), false, () => actions.view(id2)));
      }
      wrap.appendChild(grid);
      return wrap;
    }
    if (id === 'help') {
      wrap.classList.add('bw-help-body');
      for (const [title, body] of [
        ['builder.help.select', 'builder.help.select.text'],
        ['builder.help.gizmo', 'builder.help.gizmo.text'],
        ['builder.help.numeric', 'builder.help.numeric.text'],
        ['builder.help.keys', 'builder.help.keys.text'],
        ['builder.help.cancel', 'builder.help.cancel.text'],
      ] as const) {
        const row = el('div', 'bw-help-row');
        const h = el('strong');
        h.textContent = t(title);
        const p = el('span');
        p.textContent = t(body);
        row.append(h, p);
        wrap.appendChild(row);
      }
      return wrap;
    }
    return wrap;
  }

  const menuNote = (key: string): HTMLElement => {
    const p = el('p', 'bw-note');
    p.textContent = t(key);
    return p;
  };

  const menuItem = (label: string, active: boolean, run: () => void): HTMLButtonElement => {
    const b = el('button', 'bw-menu-item' + (active ? ' active' : ''));
    b.type = 'button';
    b.textContent = label;
    b.onclick = () => {
      run();
      closeMenu();
    };
    return b;
  };

  // ------------------------------------------------------------ the tiers
  /** The one global of the Builder's tray that is a tool: the pointer itself. */
  function renderGlobals(state: BuilderState): void {
    const on = state.category === 'select';
    selectButton.classList.toggle('active', on);
    selectButton.setAttribute('aria-pressed', String(on));
  }

  /** The three groups: create, insert, appearance. */
  function renderGroups(state: BuilderState): void {
    const active = groupOfCategory(state.category);
    const signature = `${active ?? 'none'}|${state.category}`;
    if (groupsRow.dataset['signature'] === signature) return;
    groupsRow.dataset['signature'] = signature;
    groupsRow.innerHTML = '';
    for (const group of BUILDER_GROUPS) {
      const on = group.id === active;
      const b = el('button', 'bw-section' + (on ? ' active' : ''));
      b.type = 'button';
      b.dataset['builderGroup'] = group.id;
      b.setAttribute('aria-pressed', String(on));
      const label = t(`builder.group.${group.id}`);
      b.innerHTML = `${builderIconSvg(group.id, 18)}<span></span>${chevron()}`;
      (b.querySelector('span') as HTMLElement).textContent = label;
      b.title = label;
      // Opening a group opens its first tool: the row below is never empty.
      b.onclick = () => {
        openGallery = null;
        actions.setCategory(group.categories[0]);
      };
      groupsRow.appendChild(b);
    }
  }

  /** The tools of the group in hand. */
  function renderToolTabs(state: BuilderState): void {
    const group = BUILDER_GROUPS.find((g) => g.id === groupOfCategory(state.category));
    const signature = `${group?.id ?? 'none'}|${state.category}|${[...state.ready].join(',')}`;
    if (toolsRow.dataset['signature'] === signature) return;
    toolsRow.dataset['signature'] = signature;
    toolsRow.innerHTML = '';
    for (const id of group?.categories ?? []) {
      const on = id === state.category;
      const b = el('button', 'bw-tool' + (on ? ' active' : ''));
      b.type = 'button';
      b.dataset['builderCategory'] = id;
      b.setAttribute('aria-pressed', String(on));
      b.innerHTML = `${builderIconSvg(id, 16)}<span></span>`;
      (b.querySelector('span') as HTMLElement).textContent = t(`builder.category.${id}`);
      b.title = t(`builder.category.${id}`);
      b.onclick = () => {
        openGallery = null;
        actions.setCategory(id);
      };
      toolsRow.appendChild(b);
    }
  }

  /** Under the tools: what the one in hand can do, and the gallery it opens. */
  function renderFamilies(state: BuilderState): void {
    const spec = categorySpec(state.category);
    const signature = `${state.category}|${state.tool}|${state.armed}|${state.planning}|${state.planPoints}|${openGallery ?? ''}`;
    if (familiesRow.dataset['signature'] === signature) return;
    familiesRow.dataset['signature'] = signature;
    familiesRow.innerHTML = '';
    if (state.planning) {
      familiesRow.appendChild(planControls(state));
      return;
    }
    const row = el('div', 'bw-row');
    for (const tool of spec.tools) {
      const b = el('button', 'bw-tool' + (tool.danger ? ' danger' : ''));
      b.type = 'button';
      b.dataset['builderTool'] = tool.id;
      const on = state.tool === tool.id && (tool.kind !== 'mode' || state.armed === tool.id);
      b.classList.toggle('active', on);
      b.disabled = !state.ready.has(tool.id);
      b.setAttribute('aria-pressed', String(on));
      const label = t(`builder.tool.${tool.id}`);
      const gallery = tool.kind === 'menu';
      b.innerHTML = `${builderIconSvg(tool.id, 16)}<span></span>${gallery ? chevron() : ''}`;
      (b.querySelector('span') as HTMLElement).textContent = label;
      b.title = label;
      b.classList.toggle('open', gallery && openGallery === tool.id);
      b.onclick = () => {
        if (gallery) {
          openGallery = openGallery === tool.id ? null : tool.id;
          renderDock(lastState);
          return;
        }
        openGallery = null;
        actions.chooseTool(tool.id);
        renderDock(lastState);
      };
      row.appendChild(b);
    }
    familiesRow.appendChild(row);
  }

  /** Tier 3: the gallery of whatever the chosen sub-tool opens. */
  function renderTier3(state: BuilderState): void {
    tier3.innerHTML = '';
    if (!openGallery || state.planning) return;
    const box = el('div', 'bw-gallery');
    const family = BUILDER_GALLERIES[openGallery];
    if (family) {
      const grid = el('div', 'bw-tiles');
      for (const id of family) {
        const on = state.tool === id || state.armed === id;
        const shape = DRAW_SHAPES[id];
        const thumb = thumbnails.get(id) ?? (shape ? planSwatch(shape) : undefined);
        grid.appendChild(tile(id, t(`builder.tool.${id}`), on, closeGalleryAnd(() => actions.chooseTool(id)), thumb));
      }
      box.append(grid, menuNote(`builder.family.${openGallery}`));
      // A window or a door also asks where it goes.
      if (openGallery === 'openWindows' || openGallery === 'openDoors') box.appendChild(scopeRow(state));
      tier3.appendChild(box);
      return;
    }
    if (openGallery === 'models') {
      const grid = el('div', 'bw-tiles');
      for (const bp of BLUEPRINTS) {
        const label = bp.nameKey ? t(bp.nameKey) : bp.key;
        const thumb = thumbnails.get(bp.key);
        const b = tile(bp.key, label, false, closeGalleryAnd(() => actions.choosePreset(bp.key)), thumb);
        b.dataset['preset'] = bp.key;
        grid.appendChild(b);
      }
      for (const bp of state.userBlueprints) {
        const b = tile('user', bp.name ?? bp.key, false, closeGalleryAnd(() => actions.chooseUserBlueprint(bp.key)));
        b.dataset['userPreset'] = bp.key;
        (b.querySelector('.bw-tile-name') as HTMLElement).textContent = `${bp.name ?? bp.key} ×`;
        grid.appendChild(b);
      }
      box.append(grid, menuNote('builder.models.note'));
      const saveRow = el('div', 'bw-row');
      const save = el('button', 'bw-tool');
      save.type = 'button';
      save.innerHTML = `${builderIconSvg('models', 16)}<span></span>`;
      (save.querySelector('span') as HTMLElement).textContent = t('building.saveBlueprint');
      save.onclick = () => {
        const name = window.prompt(t('building.blueprintName'), '');
        if (name !== null && name.trim() !== '') actions.saveBlueprint(name);
      };
      saveRow.appendChild(save);
      box.appendChild(saveRow);
      tier3.appendChild(box);
      return;
    }
    if (openGallery === 'material' || openGallery === 'colour') {
      const grid = el('div', 'bw-tiles');
      for (const finish of FINISHES) {
        const on = state.material?.finish === finish;
        grid.appendChild(tile(
          'finish',
          t(`building.finish.${finish}`),
          on,
          closeGalleryAnd(() => actions.chooseFinish(finish)),
          materialSwatch(finish),
        ));
      }
      const swatches = el('div', 'bw-swatches');
      for (const colour of SWATCHES) {
        const b = el('button', 'bw-swatch' + (state.material?.colour === colour ? ' active' : ''));
        b.type = 'button';
        b.style.setProperty('--swatch', hexOf(colour));
        b.setAttribute('aria-label', hexOf(colour));
        b.onclick = closeGalleryAnd(() => actions.chooseColour(colour));
        swatches.appendChild(b);
      }
      const custom = el('input', 'bw-swatch custom');
      custom.type = 'color';
      custom.onchange = () => actions.chooseColour(parseInt(custom.value.slice(1), 16));
      swatches.appendChild(custom);
      const styles = el('div', 'bw-tiles');
      for (const style of STYLES) {
        const b = tile('style', t(`building.style.${style.key}`), false, closeGalleryAnd(() => actions.chooseStyle(style.key)));
        const chips = el('span', 'chips');
        for (const c of [style.materials.wall.colour, style.materials.trim.colour, style.materials.roof.colour]) {
          const i = el('i');
          i.style.background = hexOf(c);
          chips.appendChild(i);
        }
        b.querySelector('.bw-tile-art')?.replaceWith(chips);
        styles.appendChild(b);
      }
      box.append(grid, swatches, styles, menuNote('builder.finish.note'));
      tier3.appendChild(box);
      return;
    }
    if (openGallery === 'patterns') {
      const grid = el('div', 'bw-tiles');
      for (const pattern of FACADE_PATTERNS) {
        grid.appendChild(tile(pattern, t(`creator.pattern.${pattern}`), state.pattern === pattern, closeGalleryAnd(() => actions.choosePattern(pattern))));
      }
      box.append(grid, scopeRow(state), menuNote('builder.pattern.note'));
      tier3.appendChild(box);
      return;
    }
    if (openGallery === 'roofShape') {
      // Pictures of what a roof can be, and its numbers in the band below.
      const grid = el('div', 'bw-tiles');
      for (const id of ['roofFlat', 'roofShed', 'roofGable', 'roofHip', 'roofSawtooth', 'roofTerrace']) {
        grid.appendChild(tile(
          id,
          t(`builder.tool.${id}`),
          false,
          closeGalleryAnd(() => actions.chooseTool(id)),
          thumbnails.get(id),
        ));
      }
      box.append(grid, roofParams(state), menuNote('builder.roofShape.note'));
      tier3.appendChild(box);
      return;
    }
    if (openGallery === 'moreComponents') {
      const grid = el('div', 'bw-tiles');
      for (const kind of ELEMENT_KINDS) {
        grid.appendChild(tile(kind, t(`building.element.${kind}`), state.tool === kind, closeGalleryAnd(() => actions.chooseTool(kind))));
      }
      box.append(grid, menuNote('builder.components.note'));
      tier3.appendChild(box);
      return;
    }
  }

  /**
   * The band under the pictures: the parameters of whatever is in hand, and
   * nothing at all when the family has none. A window says where it is applied;
   * a roof says its pitch, its ridge and the side it falls to.
   */
  function scopeRow(state: BuilderState): HTMLElement {
    const row = el('div', 'bw-params');
    const label = el('span', 'bw-params-label');
    label.textContent = t('creator.dock.scope');
    row.appendChild(label);
    for (const scope of FACADE_SCOPES) {
      row.appendChild(menuItem(t(`creator.dock.scope.${scope}`), state.scope === scope, () => {
        actions.setScope(scope);
        renderDock(lastState);
      }));
    }
    return row;
  }

  function roofParams(state: BuilderState): HTMLElement {
    const roof = state.roof;
    const row = el('div', 'bw-params');
    const pitch = el('div', 'bw-params-group');
    const pitchLabel = el('span', 'bw-params-label');
    pitchLabel.textContent = `${t('builder.field.pitch')}: ${roof?.pitch ?? 30}°`;
    pitch.append(pitchLabel, menuItem('− 5°', false, () => actions.roofPitch(-5)), menuItem('+ 5°', false, () => actions.roofPitch(5)));
    const ridge = el('div', 'bw-params-group');
    const ridgeLabel = el('span', 'bw-params-label');
    ridgeLabel.textContent = t('builder.roof.ridge.label');
    ridge.appendChild(ridgeLabel);
    for (const r of ['x', 'y'] as const) {
      ridge.appendChild(menuItem(t(`builder.roof.ridge.${r}`), roof?.ridge === r, () => actions.roofRidge(r)));
    }
    const fall = el('div', 'bw-params-group');
    const fallLabel = el('span', 'bw-params-label');
    fallLabel.textContent = t('builder.roof.side.label');
    fall.appendChild(fallLabel);
    for (const [side, key] of [[0, 'front'], [1, 'right'], [2, 'back'], [3, 'left']] as const) {
      fall.appendChild(menuItem(t(`builder.roof.side.${key}`), roof?.fall === side, () => actions.roofFall(side)));
    }
    row.append(pitch, ridge, fall);
    return row;
  }

  /** Finish / Back / Cancel, while a plan is being drawn. */
  function planControls(state: BuilderState): HTMLElement {
    const row = el('div', 'bw-row bw-plan-body');
    const count = el('span', 'bw-plan-count');
    count.textContent = t('builder.plan.points', { count: state.planPoints });
    const finish = el('button', 'bw-tool bw-plan-finish');
    finish.type = 'button';
    finish.innerHTML = `${builderIconSvg('check', 15)}<span></span>`;
    (finish.querySelector('span') as HTMLElement).textContent = t('builder.plan.finish');
    finish.disabled = state.planPoints < 3;
    finish.onclick = () => actions.planFinish();
    const back = el('button', 'bw-tool');
    back.type = 'button';
    back.innerHTML = `${builderIconSvg('undo', 15)}<span></span>`;
    (back.querySelector('span') as HTMLElement).textContent = t('builder.plan.back');
    back.onclick = () => actions.planBack();
    const cancel = el('button', 'bw-tool danger');
    cancel.type = 'button';
    cancel.innerHTML = `${builderIconSvg('close', 15)}<span></span>`;
    (cancel.querySelector('span') as HTMLElement).textContent = t('builder.plan.cancel');
    cancel.onclick = () => actions.planCancel();
    row.append(count, finish, back, cancel);
    return row;
  }

  function renderDock(state: BuilderState | null): void {
    if (!state) return;
    renderGlobals(state);
    renderGroups(state);
    renderToolTabs(state);
    renderFamilies(state);
    renderTier3(state);
    syncDock();
  }

  // ------------------------------------------------------------ inspector
  function renderInspector(state: BuilderState): void {
    inspector.classList.toggle('collapsed', !state.inspectorOpen);
    inspectorToggle.innerHTML = builderIconSvg(state.inspectorOpen ? 'collapse' : 'expand', 14);
    const info = state.selection;
    if (!state.inspectorOpen || !info) {
      if (inspectorBody.dataset['signature'] !== 'empty') {
        inspectorBody.dataset['signature'] = 'empty';
        inspectorBody.innerHTML = '';
        inspectorTitle.textContent = t('builder.inspector.title');
        const empty = el('p', 'bw-inspector-empty');
        empty.textContent = t('builder.inspector.empty');
        inspectorBody.appendChild(empty);
      }
      return;
    }
    const signature = `${info.titleKey}|${info.name}|${info.fields.map((f) => `${f.id}:${f.text ?? f.value}`).join(',')}`;
    if (inspectorBody.dataset['signature'] === signature) return;
    const focused = document.activeElement;
    inspectorBody.dataset['signature'] = signature;
    inspectorBody.innerHTML = '';
    inspectorTitle.textContent = t(info.titleKey);
    const name = el('div', 'bw-inspector-name');
    name.textContent = info.name;
    inspectorBody.appendChild(name);
    for (const field of info.fields) {
      const row = el('label', 'bw-field');
      const label = el('span', 'bw-field-label');
      label.textContent = t(field.labelKey);
      row.appendChild(label);
      if (field.text !== undefined) {
        const value = el('span', 'bw-field-text');
        value.textContent = field.text;
        row.appendChild(value);
        inspectorBody.appendChild(row);
        continue;
      }
      const input = el('input', 'bw-field-input');
      input.type = 'number';
      if (field.min !== undefined) input.min = String(field.min);
      if (field.max !== undefined) input.max = String(field.max);
      input.step = String(field.step ?? (field.unit === 'count' ? 1 : 0.05));
      input.value = field.unit === 'count' ? String(Math.round(field.value)) : field.value.toFixed(2);
      input.dataset['field'] = field.id;
      input.onchange = () => actions.setField(field.id, Number(input.value));
      input.onkeydown = (e) => {
        if (e.key === 'Enter') {
          actions.setField(field.id, Number(input.value));
          input.blur();
        }
        e.stopPropagation();
      };
      row.appendChild(input);
      const unit = el('span', 'bw-field-unit');
      unit.textContent = field.unit === 'deg' ? '°' : field.unit === 'm' ? 'm' : '';
      row.appendChild(unit);
      inspectorBody.appendChild(row);
    }
    if (info.material !== undefined) {
      const materialRow = el('div', 'bw-field bw-field-material');
      const label = el('span', 'bw-field-label');
      label.textContent = t('builder.field.material');
      const value = el('span', 'bw-field-text');
      value.textContent = info.material;
      materialRow.append(label, value);
      inspectorBody.appendChild(materialRow);
    }
    if (focused instanceof HTMLInputElement && focused.dataset['field']) {
      const again = inspectorBody.querySelector<HTMLInputElement>(`[data-field="${focused.dataset['field']}"]`);
      again?.focus();
    }
  }

  const renderTop = (state: BuilderState): void => {
    undo.innerHTML = builderIconSvg('undo', 16);
    redo.innerHTML = builderIconSvg('redo', 16);
    undo.disabled = !state.canUndo;
    redo.disabled = !state.canRedo;
    // The globals are the pointer's, not the building's: an icon and the value
    // that matters - a floor number, a snap mode - never a sentence. What each
    // one is lives in its tooltip.
    floorChip.innerHTML = `${builderIconSvg('floor', 15)}<span></span><i class="bw-caret"></i>`;
    (floorChip.querySelector('span') as HTMLElement).textContent = `${state.floor.active + 1}/${Math.max(1, state.floor.total)}`;
    floorChip.title = t('builder.floor.title');
    snapChip.innerHTML = `${builderIconSvg('snap', 15)}<span></span><i class="bw-caret"></i>`;
    (snapChip.querySelector('span') as HTMLElement).textContent = t(`builder.snap.${state.snap}`);
    snapChip.title = `${t('builder.snap.label')}: ${t(`builder.snap.${state.snap}`)}`;
    gridToggle.classList.toggle('active', state.grid);
    gridToggle.setAttribute('aria-pressed', String(state.grid));
    gridToggle.innerHTML = builderIconSvg('grid', 15);
    gridToggle.title = t('builder.grid');
    viewChip.innerHTML = `${builderIconSvg('view', 15)}<i class="bw-caret"></i>`;
    viewChip.title = t('builder.view');
    hideToggle.classList.toggle('active', state.hideOthers);
    hideToggle.setAttribute('aria-pressed', String(state.hideOthers));
    hideToggle.innerHTML = builderIconSvg('hide', 15);
    hideToggle.title = t('builder.hideOthers');
    help.innerHTML = builderIconSvg('help', 16);
  };

  const renderQuick = (state: BuilderState): void => {
    const anchor = state.quickBar;
    const has = anchor !== null && state.selection !== null;
    quick.hidden = !has;
    if (!has || !anchor) return;
    quick.style.left = `${anchor.x}px`;
    quick.style.top = `${anchor.y}px`;
    for (const [name, key] of [
      ['duplicate', 'builder.quick.duplicate'],
      ['mirror', 'builder.quick.mirror'],
      ['group', 'builder.quick.group'],
      ['delete', 'builder.quick.delete'],
    ] as const) {
      const b = quickButtons.get(name);
      if (!b) continue;
      b.title = t(key);
      b.setAttribute('aria-label', t(key));
    }
  };

  const refresh = (state: BuilderState): void => {
    lastState = state;
    root.dataset['category'] = state.category;
    renderTop(state);
    renderDock(state);
    renderInspector(state);
    renderQuick(state);
    hintBase = state.hint;
    if (flashTimer === null) hint.textContent = hintBase;
  };

  const flash = (text: string): void => {
    hint.textContent = text;
    hint.classList.add('flash');
    if (flashTimer !== null) clearTimeout(flashTimer);
    flashTimer = setTimeout(() => {
      flashTimer = null;
      hint.classList.remove('flash');
      hint.textContent = hintBase;
    }, 1700);
  };

  const relabel = (): void => {
    inspectorBody.dataset['signature'] = '';
    groupsRow.dataset['signature'] = '';
    toolsRow.dataset['signature'] = '';
    familiesRow.dataset['signature'] = '';
    (simMenu.querySelector('span') as HTMLElement).textContent = t('builder.menu.simulation');
    (appMenu.querySelector('span') as HTMLElement).textContent = t('builder.menu.app');
    if (lastState) refresh(lastState);
  };

  return {
    refresh,
    // Which tool is in hand: the Builder's tray takes the road palettes' place
    // while a building is being edited, and the game's own HUD stays up.
    setMode(next) {
      root.dataset['mode'] = next;
      for (const host of root.querySelectorAll<HTMLElement>('.bw-host-road')) host.hidden = next !== 'road';
      for (const host of root.querySelectorAll<HTMLElement>('.bw-host-builder')) host.hidden = next !== 'builder';
      openGallery = null;
      renderDock(lastState);
      syncDock();
    },
    hosts: { level1: tier1Road, level2: tier2Road, simMenu: simSlot, appMenu: appSlot, controls: controlsSlot, hint: foot },
    flash,
    relabel,
    root,
    setPresetThumbnails(images) {
      for (const [key, url] of images) thumbnails.set(key, url);
      if (openGallery === 'models') renderDock(lastState);
    },
  };
}
