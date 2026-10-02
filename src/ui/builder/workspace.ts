import { BLUEPRINTS, type Blueprint } from '@world/buildings/blueprints';
import { CITY_BUILDINGS } from '@world/buildings/cityBuildings';
import { FINISHES, type Finish, STYLES } from '@world/buildings/materials';
import {
  BUILDER_TAB_SPECS,
  DRAW_ACTIONS,
  DRAW_SHAPES,
  TIER_SHAPES,
  FACADE_SCOPES,
  type BuilderCategoryId,
  type BuilderField,
  type BuilderSection,
  type BuilderSelectionInfo,
  type BuilderToolSpec,
  tabSpec,
} from './catalog';
import { FACADE_PATTERNS, ELEMENT_KINDS } from '@world/buildings/types';
import { plural, t } from '../i18n';
import { builderIconSvg } from './icons';
import { materialSwatch } from '../materialSwatch';
import { planSwatch } from '../planSwatch';
import './workspace.css';
import './construction.css';

export type { BuilderField, BuilderSelectionInfo };

/**
 * The game's chrome: a thin bar at the top for global state, a rail of modes
 * down the left edge, and beside it a panel for the mode in hand. On a phone
 * the rail runs along the bottom and the panel is a sheet standing on it.
 *
 * In Construction the panel is seven tabs - Models, Draw, Mass, Facade,
 * Parts, Roof, Colours - each showing everything it offers at once, in short
 * sections of pictures. The pointer selects whenever nothing else is in hand,
 * so there is no "Select" to find. The right side is the selection: its
 * numbers, and the actions on it (duplicate, mirror, join, save, demolish).
 *
 * This module only renders state and reports clicks: `buildingsWiring.ts` and
 * `main.ts` turn every one of them into a command.
 */

export type ChromeMode = 'road' | 'builder';

export interface BuilderState {
  readonly category: BuilderCategoryId;
  /** The active tool id (may be an action that ran once). */
  readonly tool: string;
  /** The free part the tool has armed, if any. */
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
  /** True while a gesture is running. */
  readonly busy: boolean;
  readonly selection: BuilderSelectionInfo | null;
  /** One sentence on what the pointer does now. */
  readonly hint: string;
  /** A plan is being drawn: the panel carries Finish, Back and Cancel. */
  readonly planning: boolean;
  readonly planPoints: number;
  readonly userBlueprints: readonly Blueprint[];
  /** The facade pattern of the selected mass, and where a pattern applies. */
  readonly pattern: string | null;
  readonly scope: string;
  /** The selected mass's roof, for the slope controls. */
  readonly roof: { readonly pitch: number; readonly ridge: 'x' | 'y'; readonly fall: number; readonly pitched: boolean } | null;
  /** The material the finish tools would paint now. */
  readonly material: { readonly finish: Finish; readonly colour: number } | null;
  /** What a drawn shape does now. */
  readonly drawAction: string;
}

export interface BuilderActions {
  /** Asks for pictures of the parts a tab is about to show (they arrive a few per frame). */
  requestThumbnails(ids: readonly string[]): void;
  undo(): void;
  redo(): void;
  setCategory(id: BuilderCategoryId): void;
  chooseTool(id: string): void;
  setFloor(n: number): void;
  floorCommand(command: 'insertAbove' | 'insertBelow'): void;
  setSnap(mode: string): void;
  toggleGrid(): void;
  toggleHideOthers(): void;
  toggleInspector(): void;
  selectionAction(name: 'duplicate' | 'mirror' | 'group' | 'save' | 'delete'): void;
  setField(id: string, value: number): void;
  choosePreset(key: string): void;
  chooseUserBlueprint(key: string): void;
  removeUserBlueprint(key: string): void;
  chooseFinish(finish: Finish): void;
  chooseColour(colour: number): void;
  chooseStyle(key: string): void;
  choosePattern(pattern: string): void;
  setScope(scope: string): void;
  setDrawAction(action: string): void;
  planFinish(): void;
  planBack(): void;
  planCancel(): void;
  roofPitch(delta: number): void;
  roofRidge(ridge: 'x' | 'y'): void;
  roofFall(side: number): void;
  /** A view command: frame | top | turnLeft | turnRight. */
  view(id: string): void;
}

export interface BuilderWorkspace {
  refresh(state: BuilderState): void;
  /** Which half of the game the container is driving. */
  setMode(mode: ChromeMode): void;
  /**
   * The hosts: `main.ts` mounts the road toolbar and its palettes into
   * `level1`/`level2`, and the simulation panel and the app menu into the two
   * bar menus, so the whole game shares one chrome.
   */
  readonly hosts: {
    readonly level1: HTMLElement;
    readonly level2: HTMLElement;
    readonly simMenu: HTMLElement;
    readonly appMenu: HTMLElement;
    /** Global tools and the camera, mounted by main.ts on the top bar. */
    readonly controls: HTMLElement;
    /** The panel's head line, where the game's hint bar lives. */
    readonly hint: HTMLElement;
    /** The panel's title: the name of the mode in hand, set by main.ts. */
    readonly title: HTMLElement;
  };
  flash(text: string): void;
  /** Opens a tab. */
  showGallery(category: BuilderCategoryId, gallery?: string): void;
  relabel(): void;
  setHistory(canUndo: boolean, canRedo: boolean): void;
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

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, html?: string): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (html !== undefined) node.innerHTML = html;
  return node;
};

/** A picture tile: the picture (or the glyph), the name under it. */
const tile = (id: string, label: string, on: boolean, run: () => void, thumb?: string, small = false): HTMLButtonElement => {
  const b = el('button', 'bw-tile' + (small ? ' small' : '') + (on ? ' active' : ''));
  b.type = 'button';
  b.dataset['tile'] = id;
  b.title = label;
  const art = thumb
    ? `<img class="bw-tile-art" src="${thumb}" alt="" />`
    : `<span class="bw-tile-art">${builderIconSvg(id, small ? 24 : 32)}</span>`;
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
  undo.innerHTML = builderIconSvg('undo', 16);
  undo.disabled = true;
  undo.onclick = () => actions.undo();
  const redo = el('button', 'bw-icon-button');
  redo.type = 'button';
  redo.dataset['i18nTitle'] = 'action.redo';
  redo.innerHTML = builderIconSvg('redo', 16);
  redo.disabled = true;
  redo.onclick = () => actions.redo();
  historyGroup.append(undo, redo);

  const spacer = el('span', 'bw-spacer');
  const help = el('button', 'bw-icon-button bw-help');
  help.type = 'button';
  help.dataset['i18nTitle'] = 'builder.help';
  help.innerHTML = builderIconSvg('help', 16);
  help.onclick = () => showMenu('help', help);

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
  top.append(appMenu, simMenu, help, spacer, controlsSlot, historyGroup);

  /** One drop-down below the bar; the mounted panels are shown, never moved. */
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
    dropBar.innerHTML = '';
    if (!dropBar.hidden) dropBar.appendChild(dropBodyFor(id));
    const r = anchor.getBoundingClientRect();
    drop.style.left = `${Math.max(10, Math.min(r.left, window.innerWidth - 340))}px`;
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
  document.addEventListener('pointerdown', (e) => {
    if (!openMenu) return;
    const target = e.target as Node;
    if (!drop.contains(target) && !openMenu.anchor.contains(target)) closeMenu();
  }, true);

  // ------------------------------------------------------------ the rail
  const rail = el('nav', 'bw-rail');
  const tier1 = el('div', 'bw-tier bw-tier1');
  const tier1Road = el('div', 'bw-host bw-host-road');
  tier1.append(tier1Road);
  rail.append(tier1);

  // ------------------------------------------------------------ the panel
  const dock = el('section', 'bw-dock bw-panel');
  const panelHead = el('div', 'bw-panel-head');
  const panelTitle = el('h2', 'bw-panel-title');
  const panelBody = el('div', 'bw-panel-body');
  const tier2 = el('div', 'bw-tier bw-tier2');
  const tier2Road = el('div', 'bw-host bw-host-road');
  const tier2Builder = el('div', 'bw-host bw-host-builder');

  // Construction, top down: the switches about the pointer, the seven tabs,
  // a plan's Finish/Back/Cancel while one is drawn, then the tab's shelf.
  const contextRow = el('div', 'bw-context');
  const tabsRow = el('div', 'bw-tabs');
  tabsRow.setAttribute('role', 'tablist');
  const planRow = el('div', 'bw-planrow');
  const shelf = el('div', 'bw-shelf');
  tier2Builder.append(contextRow, tabsRow, planRow, shelf);
  tier2.append(tier2Road, tier2Builder);

  const floorChip = el('button', 'bw-chip bw-floor');
  floorChip.type = 'button';
  floorChip.onclick = () => showMenu('floor', floorChip);
  const snapChip = el('button', 'bw-chip bw-snap');
  snapChip.type = 'button';
  snapChip.onclick = () => showMenu('snap', snapChip);
  const gridToggle = el('button', 'bw-chip bw-toggle');
  gridToggle.type = 'button';
  gridToggle.onclick = () => actions.toggleGrid();
  const viewChip = el('button', 'bw-chip bw-view');
  viewChip.type = 'button';
  viewChip.onclick = () => showMenu('view', viewChip);
  const hideToggle = el('button', 'bw-chip bw-toggle');
  hideToggle.type = 'button';
  hideToggle.onclick = () => actions.toggleHideOthers();
  contextRow.append(floorChip, snapChip, gridToggle, viewChip, hideToggle);

  const foot = el('div', 'bw-foot');
  const fold = el('button', 'bw-fold');
  fold.type = 'button';
  fold.dataset['i18nTitle'] = 'builder.dock.fold';
  fold.setAttribute('aria-expanded', 'true');
  fold.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 15l6-6 6 6"/></svg>';
  fold.onclick = () => {
    dock.classList.toggle('folded');
    syncDock();
  };
  const headText = el('div', 'bw-panel-text');
  headText.append(panelTitle, foot);
  panelHead.append(headText, fold);
  panelBody.append(tier2);
  dock.append(panelHead, panelBody);

  const hint = el('div', 'bw-hint');
  const mouse = el('span', 'bw-mouse');
  mouse.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="3" width="10" height="18" rx="5"/><path d="M12 6v4"/></svg>';
  foot.append(mouse, hint);

  // ------------------------------------------------------------ the selection
  // The numbers of what is selected, and what can be done to it: on the panel
  // itself, not on a bar floating over the map (it covered the building and
  // stayed on screen in every other mode).
  const inspector = el('aside', 'bw-inspector');
  inspector.hidden = true;
  const inspectorHead = el('div', 'bw-inspector-head');
  const inspectorTitle = el('span', 'bw-inspector-title');
  const inspectorToggle = el('button', 'bw-icon-button bw-collapse');
  inspectorToggle.type = 'button';
  inspectorToggle.dataset['i18nTitle'] = 'builder.inspector.toggle';
  inspectorToggle.onclick = () => actions.toggleInspector();
  inspectorHead.append(inspectorTitle, inspectorToggle);
  const inspectorActions = el('div', 'bw-inspector-actions');
  const actionButtons = new Map<string, HTMLButtonElement>();
  for (const [name, icon] of [
    ['duplicate', 'duplicate'],
    ['mirror', 'mirror'],
    ['group', 'group'],
    ['save', 'models'],
    ['delete', 'trash'],
  ] as const) {
    const b = el('button', 'bw-icon-button bw-action' + (name === 'delete' ? ' danger' : ''));
    b.type = 'button';
    b.dataset['selectionAction'] = name;
    b.innerHTML = builderIconSvg(icon, 16);
    b.onclick = () => actions.selectionAction(name);
    inspectorActions.appendChild(b);
    actionButtons.set(name, b);
  }
  const inspectorBody = el('div', 'bw-inspector-body');
  inspector.append(inspectorHead, inspectorActions, inspectorBody);

  root.append(top, drop, rail, dock, inspector);

  // ------------------------------------------------------------ state
  let mode: ChromeMode = 'road';
  let lastState: BuilderState | null = null;
  const thumbnails = new Map<string, string>();
  let hintBase = '';
  let flashTimer: ReturnType<typeof setTimeout> | null = null;

  const syncDock = (): void => {
    const folded = dock.classList.contains('folded');
    panelBody.hidden = folded;
    fold.setAttribute('aria-expanded', String(!folded));
    root.dataset['dock'] = folded ? 'folded' : 'open';
  };

  // ------------------------------------------------------------ bar menus
  function dropBodyFor(id: string): HTMLElement {
    const wrap = el('div', 'bw-drop-body');
    if (id === 'snap') {
      const grid = el('div', 'bw-drop-grid');
      for (const snap of SNAP_MODES) {
        grid.appendChild(menuItem(t(`builder.snap.${snap}`), lastState?.snap === snap, () => actions.setSnap(snap)));
      }
      wrap.append(grid);
      return wrap;
    }
    if (id === 'floor') {
      const grid = el('div', 'bw-drop-grid floors');
      const total = Math.max(1, lastState?.floor.total ?? 1);
      for (let i = 0; i < total; i++) {
        grid.appendChild(menuItem(String(i + 1), lastState?.floor.active === i, () => actions.setFloor(i)));
      }
      const row = el('div', 'bw-drop-row');
      row.appendChild(menuItem(t('builder.floor.insertAbove'), false, () => actions.floorCommand('insertAbove')));
      row.appendChild(menuItem(t('builder.floor.insertBelow'), false, () => actions.floorCommand('insertBelow')));
      wrap.append(grid, row);
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

  const menuItem = (label: string, active: boolean, run: () => void, close = true): HTMLButtonElement => {
    const b = el('button', 'bw-menu-item' + (active ? ' active' : ''));
    b.type = 'button';
    b.textContent = label;
    b.onclick = () => {
      run();
      if (close) closeMenu();
    };
    return b;
  };

  // ------------------------------------------------------------ the tabs
  const hasSelection = (state: BuilderState): boolean => state.selection !== null;

  function renderTabs(state: BuilderState): void {
    const signature = `${state.category}|${hasSelection(state)}`;
    if (tabsRow.dataset['signature'] === signature) return;
    tabsRow.dataset['signature'] = signature;
    tabsRow.innerHTML = '';
    for (const tab of BUILDER_TAB_SPECS) {
      const on = tab.id === state.category;
      const b = el('button', 'bw-tab' + (on ? ' active' : ''));
      b.type = 'button';
      b.dataset['builderTab'] = tab.id;
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', String(on));
      const label = t(`builder.category.${tab.id}`);
      b.innerHTML = `${builderIconSvg(`tab-${tab.id}`, 18)}<span></span>`;
      (b.querySelector('span') as HTMLElement).textContent = label;
      // A tab that works on a building says so, rather than opening onto an
      // empty shelf.
      const locked = tab.needsSelection && !hasSelection(state);
      b.disabled = locked;
      b.title = locked ? `${label} - ${t('builder.needsSelection')}` : label;
      b.onclick = () => actions.setCategory(tab.id);
      tabsRow.appendChild(b);
    }
  }

  /** Finish / Back / Cancel, while a plan is being drawn. */
  function renderPlan(state: BuilderState): void {
    const signature = `${state.planning}|${state.planPoints}`;
    if (planRow.dataset['signature'] === signature) return;
    planRow.dataset['signature'] = signature;
    planRow.innerHTML = '';
    planRow.hidden = !state.planning;
    if (!state.planning) return;
    const count = el('span', 'bw-plan-count');
    count.textContent = plural('builder.plan.points', state.planPoints);
    const button = (icon: string, key: string, run: () => void, cls = ''): HTMLButtonElement => {
      const b = el('button', `bw-tool ${cls}`);
      b.type = 'button';
      b.innerHTML = `${builderIconSvg(icon, 15)}<span></span>`;
      (b.querySelector('span') as HTMLElement).textContent = t(key);
      b.onclick = run;
      return b;
    };
    const finish = button('check', 'builder.plan.finish', () => actions.planFinish(), 'bw-plan-finish');
    finish.disabled = state.planPoints < 3;
    planRow.append(count, finish, button('undo', 'builder.plan.back', () => actions.planBack()),
      button('close', 'builder.plan.cancel', () => actions.planCancel(), 'danger'));
  }

  /** The shelf of the tab in hand: its sections, every option visible. */
  function renderShelf(state: BuilderState): void {
    const signature = [
      state.category,
      state.tool,
      state.armed,
      hasSelection(state),
      state.material?.finish ?? '',
      state.material?.colour ?? '',
      state.pattern ?? '',
      state.scope,
      state.drawAction,
      state.roof?.pitch ?? '',
      state.roof?.ridge ?? '',
      state.roof?.fall ?? '',
      state.userBlueprints.map((b) => b.key).join(','),
      thumbnails.size,
    ].join('|');
    if (shelf.dataset['signature'] === signature) return;
    shelf.dataset['signature'] = signature;
    shelf.innerHTML = '';
    const spec = tabSpec(state.category);
    if (spec.needsSelection && !hasSelection(state)) {
      const p = el('p', 'bw-empty');
      p.textContent = t('builder.needsSelection');
      shelf.appendChild(p);
      return;
    }
    requestPictures(state.category, state);
    for (const section of spec.sections) shelf.appendChild(sectionOf(section, state));
  }

  function requestPictures(tab: BuilderCategoryId, state: BuilderState): void {
    const ids: string[] = [];
    for (const section of tabSpec(tab).sections) {
      for (const tool of section.tools ?? []) ids.push(tool.id);
      if (section.shelf === 'models') ids.push(...CITY_BUILDINGS.map((c) => `city:${c.fn}`), ...BLUEPRINTS.map((bp) => bp.key), ...state.userBlueprints.map((bp) => bp.key));
      if (section.shelf === 'patterns') ids.push(...FACADE_PATTERNS);
      if (section.shelf === 'finishes') ids.push(...FINISHES);
    }
    const known = new Set<string>([...CITY_BUILDINGS.map((c) => `city:${c.fn}`), ...ELEMENT_KINDS, ...FACADE_PATTERNS, ...FINISHES, ...BLUEPRINTS.map((bp) => bp.key),
      ...state.userBlueprints.map((bp) => bp.key), 'window', 'sashWindow', 'wideWindow', 'ribbon', 'bayWindow', 'frenchWindow',
      'door', 'doubleDoor', 'garageDoor', 'loadingDoor', 'solar', 'skylight', 'vent', 'chimney', 'waterTank', 'spire',
      'roofFlat', 'roofShed', 'roofGable', 'roofHip', 'roofSawtooth', 'roofTerrace', 'wallRun', 'fenceRun', 'pavementRun', 'stairRun',
      'balcony', 'shopfront']);
    const wanted = ids.filter((id) => known.has(id) && !thumbnails.has(id));
    if (wanted.length) actions.requestThumbnails(wanted);
  }

  function sectionOf(section: BuilderSection, state: BuilderState): HTMLElement {
    const box = el('div', 'bw-section-box');
    if (section.title) {
      const h = el('div', 'bw-shelf-title');
      h.textContent = t(`builder.section.${section.title}`);
      box.appendChild(h);
    }
    if (section.tools) box.appendChild(toolGrid(section.tools, state));
    if (section.shelf === 'models') box.appendChild(modelsShelf(state));
    if (section.shelf === 'patterns') box.appendChild(patternsShelf(state));
    if (section.shelf === 'scope') box.appendChild(scopeRow(state));
    if (section.shelf === 'drawAction') box.appendChild(drawActionRow(state));
    if (section.shelf === 'roofParams') box.appendChild(roofParams(state));
    if (section.shelf === 'finishes') box.appendChild(finishesShelf(state));
    return box;
  }

  function toolGrid(tools: readonly BuilderToolSpec[], state: BuilderState): HTMLElement {
    const grid = el('div', 'bw-tiles small');
    for (const tool of tools) {
      const on = tool.kind === 'mode' && (state.tool === tool.id || state.armed === tool.id);
      const shape = DRAW_SHAPES[tool.id] ?? TIER_SHAPES[tool.id];
      const thumb = thumbnails.get(tool.id) ?? (shape ? planSwatch(shape) : undefined);
      const b = tile(tool.id, t(`builder.tool.${tool.id}`), on, () => {
        actions.chooseTool(tool.id);
        renderShelfNow();
      }, thumb, true);
      b.disabled = !state.ready.has(tool.id);
      b.dataset['builderTool'] = tool.id;
      grid.appendChild(b);
    }
    return grid;
  }

  function modelsShelf(state: BuilderState): HTMLElement {
    const wrap = el('div', 'bw-gallery');
    // The city's buildings, by what they are for: homes, public services,
    // shops and places to eat and go out, work, leisure. Each is blocks, and
    // edited like any building once placed.
    for (const category of ['homes', 'public', 'commerce', 'work', 'leisure'] as const) {
      const title = el('div', 'bw-shelf-title');
      title.textContent = t(`builder.city.${category}`);
      const cityGrid = el('div', 'bw-tiles small');
      for (const model of CITY_BUILDINGS.filter((c) => c.category === category)) {
        const key = `city:${model.fn}`;
        const b = tile(key, t(`building.fn.${model.fn}`), false, () => actions.choosePreset(key), thumbnails.get(key), true);
        b.dataset['preset'] = key;
        cityGrid.appendChild(b);
      }
      wrap.append(title, cityGrid);
    }
    const genericTitle = el('div', 'bw-shelf-title');
    genericTitle.textContent = t('builder.city.generic');
    wrap.appendChild(genericTitle);
    const grid = el('div', 'bw-tiles small');
    for (const bp of BLUEPRINTS) {
      const label = bp.nameKey ? t(bp.nameKey) : bp.key;
      const b = tile(bp.key, label, false, () => actions.choosePreset(bp.key), thumbnails.get(bp.key), true);
      b.dataset['preset'] = bp.key;
      grid.appendChild(b);
    }
    for (const bp of state.userBlueprints) {
      const b = tile('user', bp.name ?? bp.key, false, () => actions.chooseUserBlueprint(bp.key), thumbnails.get(bp.key));
      b.dataset['userPreset'] = bp.key;
      // Its own way out: a saved model can be thrown away.
      const remove = el('span', 'bw-tile-remove');
      remove.textContent = '×';
      remove.title = t('builder.models.remove');
      remove.setAttribute('role', 'button');
      remove.onclick = (e) => {
        e.stopPropagation();
        actions.removeUserBlueprint(bp.key);
      };
      b.appendChild(remove);
      grid.appendChild(b);
    }
    wrap.append(grid);
    return wrap;
  }

  function patternsShelf(state: BuilderState): HTMLElement {
    const grid = el('div', 'bw-tiles small');
    for (const pattern of FACADE_PATTERNS) {
      grid.appendChild(tile(pattern, t(`creator.pattern.${pattern}`), state.pattern === pattern,
        () => actions.choosePattern(pattern), thumbnails.get(pattern), true));
    }
    return grid;
  }

  function scopeRow(state: BuilderState): HTMLElement {
    const row = el('div', 'bw-params');
    for (const scope of FACADE_SCOPES) {
      row.appendChild(menuItem(t(`creator.dock.scope.${scope}`), state.scope === scope, () => {
        actions.setScope(scope);
      }, false));
    }
    return row;
  }

  /**
   * Any shape, any operation: the same rectangle, cross or free polygon makes
   * a new building, a block joined to the selected one, a block on its roof,
   * or a cut out of it. The operations are what compose any building.
   */
  function drawActionRow(state: BuilderState): HTMLElement {
    const row = el('div', 'bw-params bw-draw-actions');
    for (const action of DRAW_ACTIONS) {
      const b = menuItem(t(`builder.drawAction.${action}`), state.drawAction === action, () => actions.setDrawAction(action), false);
      b.dataset['drawAction'] = action;
      b.disabled = action !== 'new' && !hasSelection(state);
      row.appendChild(b);
    }
    return row;
  }

  function roofParams(state: BuilderState): HTMLElement {
    const roof = state.roof;
    const row = el('div', 'bw-params');
    const pitch = el('div', 'bw-params-group');
    const pitchLabel = el('span', 'bw-params-label');
    pitchLabel.textContent = `${t('builder.field.pitch')}: ${roof?.pitch ?? 30}°`;
    pitch.append(pitchLabel, menuItem('− 5°', false, () => actions.roofPitch(-5), false), menuItem('+ 5°', false, () => actions.roofPitch(5), false));
    row.appendChild(pitch);
    if (roof?.pitched) {
      const ridge = el('div', 'bw-params-group');
      const ridgeLabel = el('span', 'bw-params-label');
      ridgeLabel.textContent = t('builder.roof.ridge.label');
      ridge.appendChild(ridgeLabel);
      for (const r of ['x', 'y'] as const) {
        ridge.appendChild(menuItem(t(`builder.roof.ridge.${r}`), roof.ridge === r, () => actions.roofRidge(r), false));
      }
      const fall = el('div', 'bw-params-group');
      const fallLabel = el('span', 'bw-params-label');
      fallLabel.textContent = t('builder.roof.side.label');
      fall.appendChild(fallLabel);
      for (const [side, key] of [[0, 'front'], [1, 'right'], [2, 'back'], [3, 'left']] as const) {
        fall.appendChild(menuItem(t(`builder.roof.side.${key}`), roof.fall === side, () => actions.roofFall(side), false));
      }
      row.append(ridge, fall);
    }
    return row;
  }

  function finishesShelf(state: BuilderState): HTMLElement {
    const wrap = el('div', 'bw-gallery');
    const grid = el('div', 'bw-tiles small');
    for (const finish of FINISHES) {
      grid.appendChild(tile('finish', t(`building.finish.${finish}`), state.material?.finish === finish,
        () => actions.chooseFinish(finish), materialSwatch(finish), true));
    }
    const swatches = el('div', 'bw-swatches');
    for (const colour of SWATCHES) {
      const b = el('button', 'bw-swatch' + (state.material?.colour === colour ? ' active' : ''));
      b.type = 'button';
      b.style.setProperty('--swatch', hexOf(colour));
      b.setAttribute('aria-label', hexOf(colour));
      b.onclick = () => actions.chooseColour(colour);
      swatches.appendChild(b);
    }
    const custom = el('input', 'bw-swatch custom');
    custom.type = 'color';
    custom.onchange = () => actions.chooseColour(parseInt(custom.value.slice(1), 16));
    swatches.appendChild(custom);
    const stylesTitle = el('div', 'bw-shelf-title');
    stylesTitle.textContent = t('builder.section.styles');
    const styles = el('div', 'bw-tiles small');
    for (const style of STYLES) {
      const b = tile('style', t(`building.style.${style.key}`), false, () => actions.chooseStyle(style.key), undefined, true);
      const chips = el('span', 'chips');
      for (const c of [style.materials.wall.colour, style.materials.trim.colour, style.materials.roof.colour]) {
        const i = el('i');
        i.style.background = hexOf(c);
        chips.appendChild(i);
      }
      b.querySelector('.bw-tile-art')?.replaceWith(chips);
      styles.appendChild(b);
    }
    wrap.append(grid, swatches, stylesTitle, styles);
    return wrap;
  }

  const renderShelfNow = (): void => {
    if (!lastState) return;
    shelf.dataset['signature'] = '';
    renderShelf(lastState);
  };

  function renderDock(state: BuilderState | null): void {
    if (!state) return;
    renderTabs(state);
    renderPlan(state);
    renderShelf(state);
    syncDock();
    updateHintText();
  }

  // ------------------------------------------------------------ inspector
  function renderInspector(state: BuilderState): void {
    const info = state.selection;
    inspector.hidden = info === null || mode !== 'builder';
    inspector.classList.toggle('collapsed', !state.inspectorOpen);
    inspectorToggle.innerHTML = builderIconSvg(state.inspectorOpen ? 'collapse' : 'expand', 14);
    for (const [name, b] of actionButtons) {
      const key = `builder.quick.${name}`;
      b.title = t(key);
      b.setAttribute('aria-label', t(key));
    }
    if (!state.inspectorOpen || !info) return;
    const signature = `${info.titleKey}|${info.name}|${info.material ?? ''}|${info.fields.map((f) => `${f.id}:${f.text ?? f.value}`).join(',')}`;
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
      if (field.options) {
        const select = el('select', 'bw-field-input bw-field-select');
        select.dataset['field'] = field.id;
        for (const option of field.options) {
          const o = el('option');
          o.value = String(option.value);
          o.textContent = t(option.labelKey);
          o.selected = option.value === field.value;
          select.appendChild(o);
        }
        select.onchange = () => actions.setField(field.id, Number(select.value));
        row.appendChild(select);
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
      // Live: every step of the arrows or the wheel shows on the building at
      // once, not only when the field is left.
      input.oninput = () => {
        const n = Number(input.value);
        if (Number.isFinite(n)) actions.setField(field.id, n);
      };
      input.onkeydown = (e) => {
        if (e.key === 'Enter') input.blur();
        e.stopPropagation();
      };
      row.appendChild(input);
      const unit = el('span', 'bw-field-unit');
      unit.textContent = field.unit === 'deg' ? '°' : field.unit === 'm' ? 'm' : field.unit === 'percent' ? '%' : '';
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
    const signature = [state.floor.active, state.floor.total, state.snap, state.grid, state.hideOthers, state.canUndo, state.canRedo].join('|');
    if (top.dataset['signature'] === signature) return;
    top.dataset['signature'] = signature;
    undo.disabled = !state.canUndo;
    redo.disabled = !state.canRedo;
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
  };

  const updateHintText = (): void => {
    if (!lastState) return;
    hintBase = lastState.hint;
    if (flashTimer === null) {
      hint.textContent = hintBase;
      hint.title = hintBase;
    }
  };

  const refresh = (state: BuilderState): void => {
    lastState = state;
    root.dataset['category'] = state.category;
    root.dataset['selection'] = state.selection === null ? 'none' : 'some';
    // A tab that needs a building gives way when the selection goes.
    if (state.selection === null && !state.planning && tabSpec(state.category).needsSelection && !state.armed) {
      actions.setCategory('models');
      return;
    }
    renderTop(state);
    renderDock(state);
    renderInspector(state);
  };

  const flash = (text: string): void => {
    hint.textContent = text;
    hint.title = text;
    hint.classList.add('flash');
    if (flashTimer !== null) clearTimeout(flashTimer);
    flashTimer = setTimeout(() => {
      flashTimer = null;
      hint.classList.remove('flash');
      hint.textContent = hintBase;
      hint.title = hintBase;
    }, 2200);
  };

  const relabel = (): void => {
    inspectorBody.dataset['signature'] = '';
    tabsRow.dataset['signature'] = '';
    planRow.dataset['signature'] = '';
    shelf.dataset['signature'] = '';
    top.dataset['signature'] = '';
    (simMenu.querySelector('span') as HTMLElement).textContent = t('builder.menu.simulation');
    (appMenu.querySelector('span') as HTMLElement).textContent = t('builder.menu.app');
    if (lastState) refresh(lastState);
  };

  return {
    refresh,
    setMode(next) {
      mode = next;
      root.dataset['mode'] = next;
      for (const host of root.querySelectorAll<HTMLElement>('.bw-tier2 > .bw-host-road')) host.hidden = next !== 'road';
      for (const host of root.querySelectorAll<HTMLElement>('.bw-host-builder')) host.hidden = next !== 'builder';
      // The selection panel belongs to Construction: it stayed on screen over
      // the road tools.
      if (next !== 'builder') inspector.hidden = true;
      renderDock(lastState);
      syncDock();
    },
    hosts: { level1: tier1Road, level2: tier2Road, simMenu: simSlot, appMenu: appSlot, controls: controlsSlot, hint: foot, title: panelTitle },
    flash,
    relabel,
    showGallery(category) {
      actions.setCategory(category);
      renderDock(lastState);
    },
    setHistory(canUndo: boolean, canRedo: boolean) {
      undo.disabled = !canUndo;
      redo.disabled = !canRedo;
    },
    root,
    setPresetThumbnails(images) {
      for (const [key, url] of images) thumbnails.set(key, url);
      renderDock(lastState);
    },
  };
}
