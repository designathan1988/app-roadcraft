import { BLUEPRINTS, type Blueprint } from '@world/buildings/blueprints';
import { FINISHES, type Finish, STYLES } from '@world/buildings/materials';
import {
  BUILDER_CATALOG,
  BUILDER_GALLERIES,
  FACADE_SCOPES,
  type BuilderCategoryId,
  type BuilderField,
  type BuilderSelectionInfo,
  categorySpec,
} from './catalog';
import { FACADE_PATTERNS, ELEMENT_KINDS } from '@world/buildings/types';
import { t } from '../i18n';
import { builderIconSvg } from './icons';
import './workspace.css';

export type { BuilderField, BuilderSelectionInfo };

/**
 * The Builder Workspace: the whole interface of the buildings module.
 *
 * The top of the screen carries everything the player picks from: the status
 * row (exit, history, floor, snap, grid, view, hide, help), the rail of the
 * nine categories under it, and - dropping below the rail - the panel of the
 * chosen category. A category opens its tools, a tool with a chevron opens its
 * variants in that same panel, and the inspector on the right carries the
 * precise numbers of whatever is selected. The map owns the middle.
 *
 * Everything is in the flow of the page, so nothing can be cut off by the edge
 * of the window; the rail scrolls with its own arrows when the catalogue
 * outgrows the width.
 *
 * This module only renders state and reports clicks: `buildingsWiring.ts` turns
 * every one of them into a tool command. Nothing here reads the document.
 */

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
  /** True while a gesture is running: the panel folds down to give the map room. */
  readonly busy: boolean;
  readonly selection: BuilderSelectionInfo | null;
  /** Screen position of the selection's quick actions bar, or null. */
  readonly quickBar: { readonly x: number; readonly y: number } | null;
  /** One sentence on what the active tool does now. */
  readonly hint: string;
  /** A plan is being drawn: the panel carries Finish, Back and Cancel. */
  readonly planning: boolean;
  /** How many points the plan has, for the count beside those controls. */
  readonly planPoints: number;
  readonly userBlueprints: readonly Blueprint[];
  /** The facade pattern the Face category would apply, and where. */
  readonly pattern: string | null;
  readonly scope: string;
  /** The selected mass's roof, for the ridge and slope panel. */
  readonly roof: { readonly pitch: number; readonly ridge: 'x' | 'y'; readonly fall: number; readonly pitched: boolean } | null;
  /** The material the finish tools would paint now. */
  readonly material: { readonly finish: Finish; readonly colour: number } | null;
}

export interface BuilderActions {
  exit(): void;
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
  /** A view command from the Vista panel: frame | top | turnLeft | turnRight. */
  view(id: string): void;
  /** A preset thumbnail was rendered off screen. */
  presetThumbnails(images: ReadonlyMap<string, string>): void;
}

export interface BuilderWorkspace {
  refresh(state: BuilderState): void;
  /** A transient sentence in the workspace's own hint bar. */
  flash(text: string): void;
  /** Re-labels everything after a language change. */
  relabel(): void;
  /** Paints the preset gallery's pictures once they are rendered. */
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

const caret = (): string =>
  '<svg class="bw-chevron" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 6l6 6-6 6"/></svg>';

export function initBuilderWorkspace(actions: BuilderActions): BuilderWorkspace {
  const root = document.getElementById('builder') as HTMLElement;

  // ------------------------------------------------------------ top bar
  const top = el('div', 'bw-top');

  const exit = el('button', 'bw-button bw-exit');
  exit.type = 'button';
  exit.onclick = () => actions.exit();

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

  const floorChip = el('button', 'bw-chip bw-floor');
  floorChip.type = 'button';
  floorChip.onclick = () => showPanel('floor');

  const snapChip = el('button', 'bw-chip bw-snap');
  snapChip.type = 'button';
  snapChip.onclick = () => showPanel('snap');

  const gridToggle = el('button', 'bw-chip bw-toggle');
  gridToggle.type = 'button';
  gridToggle.onclick = () => actions.toggleGrid();

  const viewChip = el('button', 'bw-chip');
  viewChip.type = 'button';
  viewChip.onclick = () => showPanel('view');

  const hideToggle = el('button', 'bw-chip bw-toggle');
  hideToggle.type = 'button';
  hideToggle.onclick = () => actions.toggleHideOthers();

  const help = el('button', 'bw-icon-button bw-help');
  help.type = 'button';
  help.dataset['i18nTitle'] = 'builder.help';
  help.onclick = () => showPanel('help');

  const spacer = el('span', 'bw-spacer');
  top.append(exit, historyGroup, spacer, floorChip, snapChip, gridToggle, viewChip, hideToggle, help);

  // ------------------------------------------------------------ rail + panel
  const head = el('div', 'bw-head');
  const railWrap = el('div', 'bw-rail-wrap');
  const rail = el('div', 'bw-rail');
  const arrow = (dir: -1 | 1): HTMLButtonElement => {
    const b = el('button', 'bw-rail-arrow');
    b.type = 'button';
    b.innerHTML = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${dir < 0 ? 'M14 6l-6 6 6 6' : 'M10 6l6 6-6 6'}"/></svg>`;
    b.setAttribute('aria-label', t(dir < 0 ? 'builder.rail.left' : 'builder.rail.right'));
    b.onclick = () => rail.scrollBy({ left: dir * 200, behavior: 'smooth' });
    return b;
  };
  const railLeft = arrow(-1);
  const railRight = arrow(1);
  railWrap.append(railLeft, rail, railRight);
  const panel = el('div', 'bw-panel');
  head.append(top, railWrap, panel);

  const quick = el('div', 'bw-quick');
  const hint = el('div', 'bw-hint');

  for (const category of BUILDER_CATALOG) {
    const button = el('button', 'bw-cat');
    button.type = 'button';
    button.dataset['category'] = category.id;
    button.onclick = () => {
      closePanel();
      actions.setCategory(category.id);
    };
    rail.appendChild(button);
  }

  /** The arrows only show when the rail actually overflows. */
  const syncRailArrows = (): void => {
    const over = rail.scrollWidth > rail.clientWidth + 2;
    railLeft.hidden = !over;
    railRight.hidden = !over;
  };

  // ------------------------------------------------------------ inspector
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

  root.append(head, inspector, quick, hint);

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

  // ------------------------------------------------------------ the panel
  /** Which panel is open below the rail: a family, a gallery, or nothing. */
  let panelId: string | null = null;
  let lastState: BuilderState | null = null;

  const closePanel = (): void => {
    panelId = null;
  };

  const showPanel = (id: string): void => {
    panelId = panelId === id ? null : id;
    renderPanel(lastState);
  };

  const closeAfter = (run: () => void): (() => void) => () => {
    run();
    closePanel();
    renderPanel(lastState);
  };

  const note = (key: string): HTMLElement => {
    const p = el('p', 'bw-panel-note');
    p.dataset['i18n'] = key;
    p.textContent = t(key);
    return p;
  };

  const item = (label: string, active: boolean, run: () => void): HTMLButtonElement => {
    const b = el('button', 'bw-panel-item' + (active ? ' active' : ''));
    b.type = 'button';
    b.textContent = label;
    b.onclick = closeAfter(run);
    return b;
  };

  /** The panel's own header: a back arrow and the family's name. */
  const panelHead = (titleKey: string): HTMLElement => {
    const row = el('div', 'bw-panel-head');
    const back = el('button', 'bw-panel-back');
    back.type = 'button';
    back.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 6l-6 6 6 6"/></svg>';
    back.setAttribute('aria-label', t('builder.panel.back'));
    back.onclick = closeAfter(() => undefined);
    const title = el('span', 'bw-panel-title');
    title.textContent = t(titleKey);
    row.append(back, title);
    return row;
  };

  function panelSnap(): HTMLElement {
    const wrap = el('div', 'bw-panel-body');
    const grid = el('div', 'bw-panel-grid');
    for (const mode of SNAP_MODES) {
      grid.appendChild(item(t(`builder.snap.${mode}`), lastState?.snap === mode, () => actions.setSnap(mode)));
    }
    wrap.append(grid, note('builder.snap.note'));
    return wrap;
  }

  function panelFloor(): HTMLElement {
    const state = lastState;
    const wrap = el('div', 'bw-panel-body');
    const list = el('div', 'bw-panel-grid floors');
    const total = Math.max(1, state?.floor.total ?? 1);
    for (let i = 0; i < total; i++) {
      list.appendChild(item(String(i + 1), state?.floor.active === i, () => actions.setFloor(i)));
    }
    const commands = el('div', 'bw-panel-row');
    for (const [command, key] of [
      ['duplicate', 'builder.floor.duplicate'],
      ['insertAbove', 'builder.floor.insertAbove'],
      ['insertBelow', 'builder.floor.insertBelow'],
    ] as const) {
      commands.appendChild(item(t(key), false, () => actions.floorCommand(command)));
    }
    wrap.append(list, commands, note('builder.floor.note'));
    return wrap;
  }

  function panelView(): HTMLElement {
    const wrap = el('div', 'bw-panel-body');
    const list = el('div', 'bw-panel-grid');
    for (const [id, key] of [
      ['frame', 'builder.view.frame'],
      ['top', 'builder.view.top'],
      ['turnLeft', 'builder.view.turnLeft'],
      ['turnRight', 'builder.view.turnRight'],
    ] as const) {
      list.appendChild(item(t(key), false, () => actions.view(id)));
    }
    wrap.appendChild(list);
    return wrap;
  }

  function panelHelp(): HTMLElement {
    const wrap = el('div', 'bw-panel-body bw-help-body');
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

  function panelModels(): HTMLElement {
    const wrap = el('div', 'bw-panel-body');
    const grid = el('div', 'bw-presets');
    grid.id = 'bwPresetGrid';
    for (const bp of BLUEPRINTS) {
      const b = el('button', 'bw-preset');
      b.type = 'button';
      b.dataset['preset'] = bp.key;
      b.innerHTML = `${builderIconSvg('models', 22)}<span class="bw-preset-name"></span>`;
      b.onclick = closeAfter(() => actions.choosePreset(bp.key));
      grid.appendChild(b);
    }
    const mine = el('div', 'bw-presets');
    mine.dataset['userPresets'] = '';
    wrap.append(grid, mine, note('builder.models.note'));
    if (lastState) {
      renderUserPresets(mine, lastState);
      labelPresets(wrap);
      if (thumbnails.size > 0) paintThumbnails(thumbnails, wrap);
    }
    return wrap;
  }

  function panelFinishes(): HTMLElement {
    const wrap = el('div', 'bw-panel-body');
    const grid = el('div', 'bw-finishes');
    for (const finish of FINISHES) {
      const b = el('button', 'bw-finish');
      b.type = 'button';
      b.dataset['finish'] = finish;
      b.onclick = closeAfter(() => actions.chooseFinish(finish));
      grid.appendChild(b);
    }
    const swatches = el('div', 'bw-swatches');
    for (const colour of SWATCHES) {
      const b = el('button', 'bw-swatch');
      b.type = 'button';
      b.dataset['colour'] = String(colour);
      b.style.setProperty('--swatch', hexOf(colour));
      b.setAttribute('aria-label', hexOf(colour));
      b.onclick = closeAfter(() => actions.chooseColour(colour));
      swatches.appendChild(b);
    }
    const custom = el('input', 'bw-swatch custom');
    custom.type = 'color';
    // One pick, one undo step.
    custom.onchange = () => actions.chooseColour(parseInt(custom.value.slice(1), 16));
    swatches.appendChild(custom);
    const styles = el('div', 'bw-styles');
    for (const style of STYLES) {
      const b = el('button', 'bw-style');
      b.type = 'button';
      b.dataset['style'] = style.key;
      const chip = (c: number): string => `<i style="background:${hexOf(c)}"></i>`;
      b.innerHTML = `<span class="chips">${chip(style.materials.wall.colour)}${chip(style.materials.trim.colour)}${chip(style.materials.roof.colour)}</span><span class="name"></span>`;
      b.onclick = closeAfter(() => actions.chooseStyle(style.key));
      styles.appendChild(b);
    }
    wrap.append(grid, swatches, styles, note('builder.finish.note'));
    if (lastState) markFinishes(wrap, lastState);
    return wrap;
  }

  /** A family of tools: the rail keeps the families, the variants open here. */
  function panelFamily(family: string): HTMLElement {
    const members = BUILDER_GALLERIES[family] ?? [];
    const wrap = el('div', 'bw-panel-body');
    const grid = el('div', 'bw-panel-grid');
    for (const id of members) {
      const b = el('button', 'bw-panel-item bw-family-item');
      b.type = 'button';
      b.dataset['familyTool'] = id;
      const on = lastState?.tool === id || lastState?.armed === id;
      b.classList.toggle('active', on);
      b.innerHTML = `${builderIconSvg(id, 16)}<span></span>`;
      (b.querySelector('span') as HTMLElement).textContent = t(`builder.tool.${id}`);
      b.title = t(`builder.tool.${id}`);
      b.onclick = closeAfter(() => actions.chooseTool(id));
      grid.appendChild(b);
    }
    wrap.append(grid, note(`builder.family.${family}`));
    return wrap;
  }

  function panelMore(): HTMLElement {
    const wrap = el('div', 'bw-panel-body');
    const grid = el('div', 'bw-panel-grid');
    for (const kind of ELEMENT_KINDS) {
      grid.appendChild(item(t(`building.element.${kind}`), lastState?.tool === kind, () => actions.chooseTool(kind)));
    }
    wrap.append(grid, note('builder.components.note'));
    return wrap;
  }

  /** Ridge, slope and pitch of the selected mass's roof. */
  function panelRoofShape(): HTMLElement {
    const wrap = el('div', 'bw-panel-body');
    const roof = lastState?.roof ?? null;
    const pitchRow = el('div', 'bw-panel-row');
    const pitchLabel = el('span', 'bw-panel-note');
    pitchLabel.textContent = `${t('builder.field.pitch')}: ${roof?.pitch ?? 30}°`;
    pitchRow.append(
      item('− 5°', false, () => actions.roofPitch(-5)),
      pitchLabel,
      item('+ 5°', false, () => actions.roofPitch(5)),
    );
    const ridgeRow = el('div', 'bw-panel-row');
    for (const ridge of ['x', 'y'] as const) {
      ridgeRow.appendChild(item(t(`builder.roof.ridge.${ridge}`), roof?.ridge === ridge, () => actions.roofRidge(ridge)));
    }
    const fallRow = el('div', 'bw-panel-row');
    for (const [side, key] of [[0, 'front'], [1, 'right'], [2, 'back'], [3, 'left']] as const) {
      fallRow.appendChild(item(t(`builder.roof.side.${key}`), roof?.fall === side, () => actions.roofFall(side)));
    }
    wrap.append(pitchRow, ridgeRow, fallRow, note('builder.roofShape.note'));
    return wrap;
  }

  /** The facade patterns, applied to a bay, a floor, a face or the volume. */
  function panelPatterns(): HTMLElement {
    const wrap = el('div', 'bw-panel-body');
    const grid = el('div', 'bw-panel-grid');
    for (const pattern of FACADE_PATTERNS) {
      grid.appendChild(item(t(`creator.pattern.${pattern}`), lastState?.pattern === pattern, () => actions.choosePattern(pattern)));
    }
    const scopes = el('div', 'bw-panel-row');
    for (const scope of FACADE_SCOPES) {
      scopes.appendChild(item(t(`creator.dock.scope.${scope}`), lastState?.scope === scope, () => actions.setScope(scope)));
    }
    wrap.append(grid, scopes, note('builder.pattern.note'));
    return wrap;
  }

  function panelTitleKey(id: string): string | null {
    if (id.startsWith('family:')) return `builder.tool.${id.slice('family:'.length)}`;
    if (id === 'more') return 'builder.tool.moreComponents';
    if (id === 'roofShape') return 'builder.tool.roofShape';
    if (id === 'patterns') return 'builder.tool.patterns';
    if (id === 'models') return 'builder.tool.models';
    if (id === 'finishes') return 'builder.tool.material';
    if (id === 'help') return 'builder.help';
    if (id === 'view') return 'builder.view';
    if (id === 'snap') return 'builder.snap.label';
    if (id === 'floor') return 'builder.floor.title';
    return null;
  }

  /** Finish / Back / Cancel, while a plan is being drawn. */
  function planControls(state: BuilderState): HTMLElement {
    const wrap = el('div', 'bw-panel-body bw-plan-body');
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
    wrap.append(count, finish, back, cancel);
    return wrap;
  }

  // ------------------------------------------------------------ rendering
  function renderUserPresets(container: HTMLElement, state: BuilderState): void {
    const signature = state.userBlueprints.map((b) => b.key).join('|');
    if (container.dataset['signature'] === signature) return;
    container.dataset['signature'] = signature;
    container.innerHTML = '';
    if (state.userBlueprints.length === 0) return;
    const heading = el('div', 'bw-panel-heading');
    heading.textContent = t('building.myBlueprints');
    container.appendChild(heading);
    for (const bp of state.userBlueprints) {
      const b = el('button', 'bw-preset');
      b.type = 'button';
      b.innerHTML = `${builderIconSvg('models', 20)}<span class="bw-preset-name"></span><span class="remove">×</span>`;
      (b.querySelector('.bw-preset-name') as HTMLElement).textContent = bp.name ?? bp.key;
      b.onclick = closeAfter(() => actions.chooseUserBlueprint(bp.key));
      (b.querySelector('.remove') as HTMLElement).onclick = (e) => {
        e.stopPropagation();
        actions.removeUserBlueprint(bp.key);
      };
      container.appendChild(b);
    }
  }

  function labelPresets(wrap: HTMLElement): void {
    wrap.querySelectorAll<HTMLButtonElement>('.bw-preset[data-preset]').forEach((b) => {
      const key = b.dataset['preset'] ?? '';
      const bp = BLUEPRINTS.find((x) => x.key === key);
      const label = bp?.nameKey ? t(bp.nameKey) : key;
      const span = b.querySelector('.bw-preset-name');
      if (span) span.textContent = label;
      b.title = label;
    });
  }

  function paintThumbnails(images: ReadonlyMap<string, string>, scope: ParentNode = panel): void {
    scope.querySelectorAll<HTMLButtonElement>('.bw-preset[data-preset]').forEach((b) => {
      const url = images.get(b.dataset['preset'] ?? '');
      if (!url) return;
      const icon = b.querySelector('svg, img');
      if (!icon) return;
      const img = document.createElement('img');
      img.src = url;
      img.alt = '';
      img.className = 'bw-thumb';
      icon.replaceWith(img);
    });
  }

  const thumbnails = new Map<string, string>();

  function markFinishes(scope: HTMLElement, state: BuilderState): void {
    const finish = state.material?.finish ?? null;
    const colour = state.material ? String(state.material.colour) : null;
    scope.querySelectorAll<HTMLButtonElement>('.bw-finish').forEach((b) => {
      b.classList.toggle('active', b.dataset['finish'] === finish);
      const span = b.querySelector('span');
      if (span) span.textContent = t(`building.finish.${b.dataset['finish']}`);
      b.title = t(`building.finish.${b.dataset['finish']}`);
    });
    scope.querySelectorAll<HTMLButtonElement>('.bw-swatch[data-colour]').forEach((b) => {
      b.classList.toggle('active', b.dataset['colour'] === colour);
    });
    scope.querySelectorAll<HTMLButtonElement>('.bw-style').forEach((b) => {
      const name = b.querySelector('.name');
      if (name) name.textContent = t(`building.style.${b.dataset['style']}`);
    });
  }

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

  function renderRail(state: BuilderState): void {
    rail.querySelectorAll<HTMLButtonElement>('.bw-cat').forEach((b) => {
      const id = b.dataset['category'] as BuilderCategoryId;
      const on = id === state.category;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', String(on));
      b.innerHTML = `${builderIconSvg(id, 17)}<span></span>`;
      (b.querySelector('span') as HTMLElement).textContent = t(`builder.category.${id}`);
      b.title = t(`builder.category.${id}`);
    });
    syncRailArrows();
  }

  /** The tools of the chosen category, in the row below the rail. */
  function toolsRow(state: BuilderState): HTMLElement {
    const spec = categorySpec(state.category);
    const row = el('div', 'bw-panel-row bw-tools');
    for (const tool of spec.tools) {
      const b = el('button', 'bw-tool' + (tool.danger ? ' danger' : ''));
      b.type = 'button';
      b.dataset['builderTool'] = tool.id;
      const on = state.tool === tool.id && (tool.kind !== 'mode' || state.armed === tool.id);
      b.classList.toggle('active', on);
      b.disabled = !state.ready.has(tool.id);
      b.setAttribute('aria-pressed', String(on));
      const label = t(`builder.tool.${tool.id}`);
      const family = tool.kind === 'menu' && BUILDER_GALLERIES[tool.id] ? `family:${tool.id}` : null;
      b.innerHTML = `${builderIconSvg(tool.id, 16)}<span></span>${tool.kind === 'menu' ? caret() : ''}`;
      (b.querySelector('span') as HTMLElement).textContent = label;
      b.title = label;
      b.classList.toggle('open', family !== null && panelId === family);
      b.onclick = () => {
        if (tool.kind === 'menu') {
          if (family) showPanel(family);
          else if (tool.id === 'models') showPanel('models');
          else if (tool.id === 'material' || tool.id === 'colour') showPanel('finishes');
          else if (tool.id === 'patterns') showPanel('patterns');
          else if (tool.id === 'roofShape') showPanel('roofShape');
          else showPanel('more');
          return;
        }
        closePanel();
        actions.chooseTool(tool.id);
        renderPanel(lastState);
      };
      row.appendChild(b);
    }
    return row;
  }

  /**
   * The drop-down under the rail: the tools of the chosen category, and - when
   * one is open - the panel of the chosen family or gallery below them.
   */
  function renderPanel(state: BuilderState | null): void {
    if (!state) return;
    const signature = `${state.category}|${state.tool}|${state.armed}|${state.planning}|${state.planPoints}|${panelId ?? ''}|${[...state.ready].join(',')}`;
    if (panel.dataset['signature'] === signature) return;
    panel.dataset['signature'] = signature;
    panel.innerHTML = '';
    panel.hidden = false;
    if (state.planning) {
      panel.appendChild(planControls(state));
      return;
    }
    panel.appendChild(toolsRow(state));
    if (!panelId) return;
    const body = panelBody(panelId);
    if (!body) return;
    const wrap = el('div', 'bw-panel-drop');
    const titleKey = panelTitleKey(panelId);
    if (titleKey) wrap.appendChild(panelHead(titleKey));
    wrap.appendChild(body);
    panel.appendChild(wrap);
  }

  function panelBody(id: string): HTMLElement | null {
    if (id === 'snap') return panelSnap();
    if (id === 'floor') return panelFloor();
    if (id === 'view') return panelView();
    if (id === 'help') return panelHelp();
    if (id === 'models') return panelModels();
    if (id === 'finishes') return panelFinishes();
    if (id === 'more') return panelMore();
    if (id === 'roofShape') return panelRoofShape();
    if (id === 'patterns') return panelPatterns();
    if (id.startsWith('family:')) return panelFamily(id.slice('family:'.length));
    return null;
  }

  function renderTop(state: BuilderState): void {
    exit.innerHTML = `${builderIconSvg('exit', 15)}<span></span>`;
    (exit.querySelector('span') as HTMLElement).textContent = t('builder.exit');
    exit.title = t('builder.exit');
    undo.innerHTML = builderIconSvg('undo', 16);
    redo.innerHTML = builderIconSvg('redo', 16);
    undo.disabled = !state.canUndo;
    redo.disabled = !state.canRedo;
    floorChip.innerHTML = `${builderIconSvg('floor', 15)}<span></span><i class="bw-caret"></i>`;
    (floorChip.querySelector('span') as HTMLElement).textContent = t('builder.floor.of', {
      n: state.floor.active + 1,
      total: Math.max(1, state.floor.total),
    });
    floorChip.title = t('builder.floor.title');
    snapChip.innerHTML = `${builderIconSvg('snap', 15)}<span></span><i class="bw-caret"></i>`;
    (snapChip.querySelector('span') as HTMLElement).textContent =
      `${t('builder.snap.label')}: ${t(`builder.snap.${state.snap}`)}`;
    gridToggle.classList.toggle('active', state.grid);
    gridToggle.setAttribute('aria-pressed', String(state.grid));
    gridToggle.innerHTML = `${builderIconSvg('grid', 15)}<span></span>`;
    (gridToggle.querySelector('span') as HTMLElement).textContent = t('builder.grid');
    gridToggle.title = t('builder.grid');
    viewChip.innerHTML = `${builderIconSvg('view', 15)}<span></span><i class="bw-caret"></i>`;
    (viewChip.querySelector('span') as HTMLElement).textContent = t('builder.view');
    hideToggle.classList.toggle('active', state.hideOthers);
    hideToggle.setAttribute('aria-pressed', String(state.hideOthers));
    hideToggle.innerHTML = `${builderIconSvg('hide', 15)}<span></span>`;
    (hideToggle.querySelector('span') as HTMLElement).textContent = t('builder.hideOthers');
    hideToggle.title = t('builder.hideOthers');
    help.innerHTML = builderIconSvg('help', 16);
  }

  function renderQuick(state: BuilderState): void {
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
  }

  let hintBase = '';
  let flashTimer: ReturnType<typeof setTimeout> | null = null;

  const refresh = (state: BuilderState): void => {
    lastState = state;
    root.dataset['category'] = state.category;
    renderTop(state);
    renderRail(state);
    renderPanel(state);
    // The inspector follows the head's real height: on a phone the status row
    // wraps and the head grows, and a fixed offset put the two on top of each
    // other.
    const headHeight = head.getBoundingClientRect().height;
    if (headHeight > 0) inspector.style.top = `${Math.round(headHeight + 20)}px`;
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
    panel.dataset['signature'] = '';
    if (lastState) refresh(lastState);
  };

  return {
    refresh,
    flash,
    relabel,
    root,
    setPresetThumbnails(images) {
      for (const [key, url] of images) thumbnails.set(key, url);
      paintThumbnails(images, panel);
    },
  };
}
