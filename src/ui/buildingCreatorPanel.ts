import { t } from './i18n';
import { METERS_PER_UNIT } from '@world/units';
import { BAY_COMPONENTS, FACADE_PATTERNS, ROOF_DETAIL_KINDS, ROOF_KINDS,
  ELEMENT_KINDS, type BayComponent, type ElementKind, type FacadePattern, type RoofDetailKind, type RoofKind } from '@world/buildings/types';
import type { FacadeGeometry } from '@world/buildings/types';
import { FINISHES, type Finish, type MaterialSpec } from '@world/buildings/materials';
/** Presentation commands are mapped to editor commands by buildingsWiring. */
type CreatorTool = 'sketch' | 'shape' | 'facade' | 'roof';
type DrawAction = 'new' | 'ground' | 'top' | 'cut';
type PlanShape = 'rectangle' | 'l' | 'u' | 'circle' | 'hexagon' | 'octagon' | 'chamfered';
type FacadeScope = 'building' | 'volume' | 'face' | 'floor';
type OpeningScope = 'bay' | 'storey' | 'side' | 'volume';

export interface CreatorActions {
  tool(value: CreatorTool): void;
  frame(): void;
  draw(action: DrawAction): void;
  shape(value: PlanShape): void;
  tierShape(value: PlanShape): void;
  starter(key: 'house' | 'apartments' | 'tower' | 'courtyard' | 'factory'): void;
  saveBlueprint(name: string): void;
  useBlueprint(key: string): void;
  deleteBlueprint(key: string): void;
  finishPlan(): void;
  cancelPlan(): void;
  backPoint(): void;
  mass(id: number): void;
  floors(delta: number): void;
  floorCount(count: number): void;
  floorHeight(metres: number): void;
  groundHeight(metres: number): void;
  split(afterFloor: number): void;
  setback(shape: PlanShape | 'match', insetMetres: number, floors: number,
    placement: { width?: number; depth?: number; offsetX: number; offsetY: number }): void;
  vertex(action: 'insert' | 'remove'): void;
  element(kind: ElementKind): void;
  elementSize(name: 'w' | 'd' | 'h', metres: number): void;
  turnElement(): void;
  repeatElement(): void;
  removeElement(): void;
  pattern(value: FacadePattern, scope: FacadeScope): void;
  target(scope: FacadeScope): void;
  opening(value: BayComponent): void;
  openingScope(value: OpeningScope): void;
  finish(value: Finish): void;
  color(value: number): void;
  roof(value: RoofKind): void;
  pitch(value: number): void;
  ridge(value: 'x' | 'y'): void;
  fall(value: 0 | 1 | 2 | 3): void;
  roofFinish(value: Finish): void;
  roofColor(value: number): void;
  roofDetail(value: RoofDetailKind): void;
  selectDetail(id: number): void;
  turnDetail(): void;
  moveDetail(dx: number, dy: number): void;
  deleteDetail(): void;
  detailHeight(metres: number): void;
  detailFlag(flag: 'none' | 'plain' | 'saoPaulo' | 'saoPauloState'): void;
  relief(metres: number): void;
  geometry(name: keyof FacadeGeometry, value: number): void;
}

export interface CreatorState {
  tool: CreatorTool;
  drawing: number | null;
  action: DrawAction;
  selected: boolean;
  current: number | null;
  masses: { id: number; base: number; floors: number }[];
  blueprints: { key: string; name: string }[];
  selectedFace: boolean;
  selectedFloor: number | null;
  reliefDepth: number;
  geometry: Required<FacadeGeometry> | null;
  scope: FacadeScope;
  openingScope: OpeningScope;
  width: number;
  depth: number;
  selectedVertex: boolean;
  armedElement: ElementKind | null;
  element: { kind: ElementKind; w: number; d: number; h: number } | null;
  floors: number;
  floorHeight: number;
  groundHeight: number;
  splitMin: number;
  splitMax: number;
  splitDefault: number;
  tierShape: PlanShape | null;
  area: number;
  roof: RoofKind | null;
  pitch: number;
  ridge: 'x' | 'y' | null;
  fall: 0 | 1 | 2 | 3 | null;
  facadePattern: FacadePattern | null;
  component: BayComponent | null;
  material: MaterialSpec | null;
  details: { id: number; kind: RoofDetailKind; h?: number; flag?: 'none' | 'plain' | 'saoPaulo' | 'saoPauloState' }[];
  selectedDetail: number | null;
  armedDetail: RoofDetailKind | null;
  problem: string | null;
}

const SHAPES: readonly PlanShape[] = ['rectangle', 'l', 'u', 'circle', 'hexagon', 'octagon', 'chamfered'];
const SHAPE_PATHS: Record<PlanShape, string> = {
  rectangle: 'M3 3H29V27H3Z', l: 'M3 3H13V17H29V27H3Z',
  u: 'M3 3H11V18H21V3H29V27H3Z', circle: 'M16 3a13 13 0 1 0 0 26a13 13 0 1 0 0-26',
  hexagon: 'M9 3H23L30 15L23 27H9L2 15Z',
  octagon: 'M10 2H22L30 10V22L22 30H10L2 22V10Z',
  chamfered: 'M8 2h16l6 6v16l-6 6H8l-6-6V8Z',
};
const TOOL_PATHS: Record<CreatorTool, string> = {
  sketch: 'M3 25 22 6l4 4L7 29H3Zm15-15 4 4',
  shape: 'M4 5h24v22H4ZM4 17h10v10',
  facade: 'M6 28V5l10-3 10 3v23M4 28h24M10 9h3m6 0h3M10 14h3m6 0h3M10 19h3m6 0h3',
  roof: 'M2 18 16 4l14 14M5 17v12h22V17',
};

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className = ''): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  node.className = className;
  return node;
};

/** Owns its markup outright. No legacy panel nodes are moved or reused. */
export function initBuildingCreatorPanel(actions: CreatorActions): { refresh(state: CreatorState): void } {
  const root = document.getElementById('buildingPalette')!;
  const rail = document.getElementById('creatorRail')!;
  const dock = document.getElementById('creatorDock')!;
  const dockSecondary = document.getElementById('creatorDockSecondary')!;
  const dockPopover = document.getElementById('creatorDockPopover')!;
  dock.prepend(rail);
  const get = (id: string): HTMLElement => document.getElementById(id)!;
  const title = get('creatorTitle'), description = get('creatorDescription');
  const frameButton = get('creatorFrame');
  const start = get('creatorStart'), sketch = get('creatorSketch'), shape = get('creatorShape');
  const facade = get('creatorFacade'), roof = get('creatorRoof');
  const drawing = get('creatorDrawing'), drawingActions = get('creatorSketchActions');
  const pointCount = get('creatorPointCount'), error = get('creatorError'), hint = get('creatorHint');
  const masses = get('creatorMasses'), shapeMasses = get('creatorShapeMasses');
  const blueprintName = get('creatorBlueprintName') as HTMLInputElement;
  const savedModels = get('creatorSavedModels'), userBlueprints = get('creatorUserBlueprints');
  const shapeSummary = get('creatorShapeSummary');
  const elementEditor = get('creatorElementEditor'), elementHint = get('creatorElementHint');
  const elementsBox = get('creatorElementsBox') as HTMLDetailsElement;
  const pitchLabel = get('creatorPitchLabel'), pitch = get('creatorPitch') as HTMLInputElement;
  const pitchValue = get('creatorPitchValue');
  const ridgeGroup = get('creatorRidgeGroup');
  const fallLabel = get('creatorFallLabel'), fall = get('creatorFall') as HTMLSelectElement;
  const roofFinish = get('creatorRoofFinish') as HTMLSelectElement;
  const roofColor = get('creatorRoofColor') as HTMLInputElement;
  const floorCount = get('creatorFloorCount') as HTMLInputElement;
  const floorHeight = get('creatorFloorHeight') as HTMLInputElement;
  const groundHeight = get('creatorGroundHeight') as HTMLInputElement;
  const splitAt = get('creatorSplitAt') as HTMLInputElement;
  const splitButton = get('creatorSplit') as HTMLButtonElement;
  const upperShape = get('creatorUpperShape') as HTMLSelectElement;
  const upperInset = get('creatorUpperInset') as HTMLInputElement;
  const upperFloors = get('creatorUpperFloors') as HTMLInputElement;
  const upperAdvanced = get('creatorUpperAdvanced') as HTMLDetailsElement;
  const upperWidth = get('creatorUpperWidth') as HTMLInputElement;
  const upperDepth = get('creatorUpperDepth') as HTMLInputElement;
  const upperOffsetX = get('creatorUpperOffsetX') as HTMLInputElement;
  const upperOffsetY = get('creatorUpperOffsetY') as HTMLInputElement;
  const spireHeightLabel = get('creatorSpireHeightLabel');
  const spireHeight = get('creatorSpireHeight') as HTMLInputElement;
  const spireFlagLabel = get('creatorSpireFlagLabel');
  const spireFlag = get('creatorSpireFlag') as HTMLSelectElement;
  const faceScope = get('creatorFacadeScope') as HTMLSelectElement;
  const selectedFloor = get('creatorSelectedFloor');
  const reliefBox = get('creatorReliefBox');
  const geometryBox = get('creatorFacadeGeometry');
  const reliefDepth = get('creatorReliefDepth') as HTMLInputElement;
  const finish = get('creatorFinish') as HTMLSelectElement;
  const color = get('creatorColor') as HTMLInputElement;
  const details = get('creatorDetailList');
  let listKey = '';
  let blueprintsKey = '';
  let detailsKey = '';
  let profileKey = '';
  let lastStage = '';
  let dockKey = '';
  let dockSubmode: 'patterns' | 'openings' | 'materials' = 'patterns';
  let latest: CreatorState | null = null;

  const makeButton = (key: string, onClick: () => void, value?: string): HTMLButtonElement => {
    const button = el('button');
    button.type = 'button';
    button.dataset['i18n'] = key;
    button.textContent = t(key);
    if (value) button.dataset['value'] = value;
    button.onclick = onClick;
    return button;
  };

  const icon = (path: string): SVGSVGElement => {
    const image = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    image.setAttribute('viewBox', '0 0 32 32');
    image.setAttribute('fill', 'none');
    image.setAttribute('stroke', 'currentColor');
    image.setAttribute('stroke-linejoin', 'round');
    image.setAttribute('stroke-linecap', 'round');
    image.setAttribute('aria-hidden', 'true');
    const shape = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    shape.setAttribute('d', path);
    image.append(shape);
    return image;
  };

  const dockButton = (key: string, path: string, onClick: () => void, pressed = false): HTMLButtonElement => {
    const button = el('button');
    button.type = 'button';
    button.title = t(key);
    button.setAttribute('aria-label', t(key));
    button.setAttribute('aria-pressed', String(pressed));
    button.append(icon(path), el('span'));
    button.lastElementChild!.textContent = t(key);
    button.onclick = onClick;
    return button;
  };

  const dockUpper = {
    shape: get('dockUpperShape') as HTMLSelectElement,
    floors: get('dockUpperFloors') as HTMLInputElement,
    width: get('dockUpperWidth') as HTMLInputElement,
    depth: get('dockUpperDepth') as HTMLInputElement,
    inset: get('dockUpperInset') as HTMLInputElement,
    x: get('dockUpperX') as HTMLInputElement,
    y: get('dockUpperY') as HTMLInputElement,
  };
  let upperFor = '';
  const showUpper = (state: CreatorState): void => {
    const key = `${state.current}:${state.width}:${state.depth}`;
    if (upperFor !== key) {
      upperFor = key;
      dockUpper.width.value = String(Math.max(2, Math.round((state.width * METERS_PER_UNIT - 2) * 10) / 10));
      dockUpper.depth.value = String(Math.max(2, Math.round((state.depth * METERS_PER_UNIT - 2) * 10) / 10));
    }
    dockPopover.hidden = !dockPopover.hidden;
  };
  get('dockUpperApply').onclick = () => {
    const shape = dockUpper.shape.value as PlanShape | 'match';
    const width = Number(dockUpper.width.value), depth = Number(dockUpper.depth.value);
    actions.setback(shape, Number(dockUpper.inset.value), Number(dockUpper.floors.value), {
      ...(Number.isFinite(width) && width > 0 ? { width } : {}),
      ...(Number.isFinite(depth) && depth > 0 ? { depth } : {}),
      offsetX: Number(dockUpper.x.value), offsetY: Number(dockUpper.y.value),
    });
    dockPopover.hidden = true;
  };

  const renderDock = (state: CreatorState): void => {
    latest = state;
    const key = JSON.stringify([state.tool, state.selected, state.drawing, state.problem,
      state.current, state.selectedFace, state.facadePattern, state.roof, state.component,
      state.openingScope, state.material, dockSubmode]);
    if (key === dockKey) return;
    dockKey = key;
    rail.hidden = !state.selected || state.drawing !== null;
    if (state.tool !== 'shape') dockPopover.hidden = true;
    dockSecondary.replaceChildren();
    const add = (key: string, path: string, run: () => void, pressed = false): void => {
      dockSecondary.append(dockButton(key, path, run, pressed));
    };
    if (state.drawing !== null) {
      add('creator.finish', 'M5 12l5 5L20 6', actions.finishPlan);
      add('creator.back', 'M9 7 4 12l5 5M5 12h14', actions.backPoint);
      add('creator.cancel', 'M5 5l14 14M19 5 5 19', actions.cancelPlan);
      const finish = dockSecondary.firstElementChild as HTMLButtonElement;
      finish.disabled = state.drawing < 3 || !!state.problem;
    } else if (!state.selected) {
      add('creator.dock.draw', 'M4 20l5-.8L20 8l-4-4L5 15zM14 6l4 4', () => actions.draw('new'));
      add('creator.start.house', 'M3 11l9-7 9 7v10H3zM9 21v-7h6v7', () => actions.starter('house'));
      add('creator.start.tower', 'M5 21V8h5v13M10 21V3h9v18M13 7h3m-3 4h3m-3 4h3', () => actions.starter('tower'));
      add('creator.start.courtyard', 'M3 3h18v18H3zM8 8h8v8H8z', () => actions.starter('courtyard'));
      add('creator.dock.rectangle', 'M3 5h18v14H3z', () => actions.shape('rectangle'));
    } else if (state.tool === 'sketch') {
      add('creator.drawNew', 'M3 5h18v14H3zM12 8v8m-4-4h8', () => actions.draw('new'));
      add('creator.attach', 'M3 4h11v16H3zM14 10h7v10h-7z', () => actions.draw('ground'));
      add('creator.stack', 'M4 18h16M6 12h12M9 6h6', () => actions.draw('top'));
    } else if (state.tool === 'shape') {
      add('creator.dock.wing', 'M3 4h10v16H3zM13 11h8v9h-8z', () => actions.draw('ground'));
      add('creator.dock.upper', 'M5 20h14v-9H5zM8 8V4h8v4m-4-5v9', () => showUpper(state));
      add('creator.dock.cut', 'M4 4h16v16H4zM13 4v9h7M6 18l12-12', () => actions.draw('cut'));
      add('creator.floorDown', 'M4 12h16M5 18h14', () => actions.floors(-1));
      add('creator.floorUp', 'M4 18h16M5 12h14m-7-7v13', () => actions.floors(1));
    } else if (state.tool === 'facade') {
      if (dockSubmode === 'patterns') {
        for (const pattern of ['residential', 'storefront', 'office', 'industrial'] as const) {
          add(`creator.pattern.${pattern}`, 'M4 21V3h16v18M8 7h3v3H8zm6 0h3v3h-3zM8 14h3v3H8zm6 0h3v3h-3z',
            () => actions.pattern(pattern, state.selectedFace ? 'face' : 'volume'), state.facadePattern === pattern);
        }
        add('creator.dock.openings', 'M3 21V3h18v18M8 8h8v9H8z', () => { dockSubmode = 'openings'; dockKey = ''; renderDock(latest!); });
        add('creator.dock.paint', 'M3 17l9-12 9 12M5 18h14v3H5z', () => { dockSubmode = 'materials'; dockKey = ''; renderDock(latest!); });
      } else if (dockSubmode === 'openings') {
        const scope = el('select');
        scope.setAttribute('aria-label', t('creator.dock.scope'));
        scope.title = t('creator.dock.scope');
        for (const value of ['bay', 'storey', 'side', 'volume'] as const) {
          const option = el('option'); option.value = value; option.textContent = t(`creator.dock.scope.${value}`); scope.append(option);
        }
        scope.value = state.openingScope;
        scope.onchange = () => actions.openingScope(scope.value as OpeningScope);
        dockSecondary.append(scope);
        for (const component of ['window', 'wideWindow', 'balcony', 'door', 'wall'] as const)
          add(`building.component.${component}`, 'M4 21V3h16v18M8 8h8v9H8z', () => actions.opening(component), state.component === component);
        add('creator.dock.back', 'M13 5 6 12l7 7', () => { dockSubmode = 'patterns'; dockKey = ''; renderDock(latest!); });
      } else {
        for (const finishName of FINISHES) {
          const button = dockButton(`building.finish.${finishName}`, 'M4 5h16v14H4z', () => actions.finish(finishName), state.material?.finish === finishName);
          button.classList.add('creator-dock-finish');
          button.dataset['finish'] = finishName;
          dockSecondary.append(button);
        }
        const swatch = el('input'); swatch.type = 'color'; swatch.title = t('creator.color'); swatch.setAttribute('aria-label', t('creator.color'));
        swatch.value = `#${(state.material?.colour ?? 0xffffff).toString(16).padStart(6, '0')}`;
        swatch.onchange = () => actions.color(Number.parseInt(swatch.value.slice(1), 16));
        dockSecondary.append(swatch);
        add('creator.dock.back', 'M13 5 6 12l7 7', () => { dockSubmode = 'patterns'; dockKey = ''; renderDock(latest!); });
      }
    } else if (state.tool === 'roof') {
      for (const kind of ['flat', 'terrace', 'gable', 'hip'] as const)
        add(`building.roof.${kind}`, 'M3 16 12 6l9 10M5 16v5h14v-5', () => actions.roof(kind), state.roof === kind);
      add('creator.detail.solar', 'M3 7h18v11H3zM9 7l-2 11m10-11-2 11M3 12h18', () => actions.roofDetail('solar'), state.armedDetail === 'solar');
      const swatch = el('input'); swatch.type = 'color'; swatch.title = t('creator.roofColor'); swatch.setAttribute('aria-label', t('creator.roofColor'));
      swatch.value = `#${(state.material?.colour ?? 0x888888).toString(16).padStart(6, '0')}`;
      swatch.onchange = () => actions.roofColor(Number.parseInt(swatch.value.slice(1), 16));
      dockSecondary.append(swatch);
    }
  };

  rail.querySelectorAll<HTMLButtonElement>('[data-creator-tool]').forEach((button) => {
    const value = button.dataset['creatorTool'] as CreatorTool;
    button.prepend(icon(TOOL_PATHS[value]));
    button.onclick = () => { dockSubmode = 'patterns'; actions.tool(value); };
  });
  get('creatorDraw').onclick = () => actions.draw('new');
  frameButton.onclick = actions.frame;
  get('creatorSaveBlueprint').onclick = () => {
    const name = blueprintName.value.trim();
    if (!name) { blueprintName.focus(); return; }
    actions.saveBlueprint(name);
    blueprintName.value = '';
  };
  for (const value of SHAPES) {
    const button = makeButton(`creator.shape.${value}`, () => actions.shape(value), value);
    button.prepend(icon(SHAPE_PATHS[value]));
    get('creatorShapes').append(button);
    const tier = makeButton(`creator.shape.${value}`, () => actions.tierShape(value), value);
    tier.prepend(icon(SHAPE_PATHS[value]));
    get('creatorTierShapes').append(tier);
  }
  for (const [key, label] of [
    ['house', 'creator.start.house'], ['apartments', 'creator.start.apartments'],
    ['tower', 'creator.start.tower'], ['courtyard', 'creator.start.courtyard'],
    ['factory', 'creator.start.factory'],
  ] as const) {
    get('creatorStarters').append(makeButton(label, () => actions.starter(key), key));
  }
  root.querySelectorAll<HTMLButtonElement>('[data-creator-action]').forEach((button) => {
    button.onclick = () => {
      switch (button.dataset['creatorAction']) {
        case 'draw-new': actions.draw('new'); break;
        case 'draw-ground': actions.draw('ground'); break;
        case 'draw-top': actions.draw('top'); break;
        case 'attach': actions.draw('ground'); break;
        case 'stack': actions.draw('top'); break;
        case 'finish': actions.finishPlan(); break;
        case 'back': actions.backPoint(); break;
        case 'cancel': actions.cancelPlan(); break;
        case 'floor-up': actions.floors(1); break;
        case 'floor-down': actions.floors(-1); break;
        case 'cut': actions.draw('cut'); break;
        case 'setback': actions.setback(upperShape.value as PlanShape | 'match', Number(upperInset.value), Number(upperFloors.value), {
          ...(upperWidth.value ? { width: Number(upperWidth.value) } : {}),
          ...(upperDepth.value ? { depth: Number(upperDepth.value) } : {}),
          offsetX: Number(upperOffsetX.value), offsetY: Number(upperOffsetY.value),
        }); break;
        case 'insert-point': actions.vertex('insert'); break;
        case 'remove-point': actions.vertex('remove'); break;
        case 'relief-in': actions.relief(-.5); break;
        case 'relief-out': actions.relief(.5); break;
        case 'relief-flat': actions.relief(0); break;
        case 'element-turn': actions.turnElement(); break;
        case 'element-repeat': actions.repeatElement(); break;
        case 'element-remove': actions.removeElement(); break;
      }
    };
  });
  for (const pattern of FACADE_PATTERNS) get('creatorPatterns').append(
    makeButton(`creator.pattern.${pattern}`, () => actions.pattern(pattern, faceScope.value as FacadeScope), pattern));
  for (const opening of BAY_COMPONENTS) get('creatorOpenings').append(
    makeButton(`building.component.${opening}`, () => actions.opening(opening), opening));
  for (const kind of ROOF_KINDS) get('creatorRoofKinds').append(
    makeButton(`building.roof.${kind}`, () => actions.roof(kind), kind));
  for (const kind of ELEMENT_KINDS) get('creatorElements').append(
    makeButton(`building.element.${kind}`, () => actions.element(kind), kind));
  elementEditor.querySelectorAll<HTMLInputElement>('[data-creator-element-size]').forEach((input) => {
    input.onchange = () => actions.elementSize(input.dataset['creatorElementSize'] as 'w' | 'd' | 'h', Number(input.value));
  });
  for (const kind of ROOF_DETAIL_KINDS) get('creatorRoofDetails').append(
    makeButton(`creator.detail.${kind}`, () => actions.roofDetail(kind), kind));
  ridgeGroup.querySelectorAll<HTMLButtonElement>('[data-creator-ridge]').forEach((button) => {
    button.onclick = () => actions.ridge(button.dataset['creatorRidge'] as 'x' | 'y');
  });
  for (const material of FINISHES) {
    const option = el('option');
    option.value = material;
    option.textContent = t(`building.finish.${material}`);
    finish.append(option);
    const roofOption = el('option');
    roofOption.value = material;
    roofOption.textContent = t(`building.finish.${material}`);
    roofFinish.append(roofOption);
  }
  finish.onchange = () => actions.finish(finish.value as Finish);
  faceScope.onchange = () => actions.target(faceScope.value as FacadeScope);
  color.onchange = () => actions.color(Number.parseInt(color.value.slice(1), 16));
  pitch.onchange = () => actions.pitch(Number(pitch.value));
  fall.onchange = () => actions.fall(Number(fall.value) as 0 | 1 | 2 | 3);
  roofFinish.onchange = () => actions.roofFinish(roofFinish.value as Finish);
  roofColor.onchange = () => actions.roofColor(Number.parseInt(roofColor.value.slice(1), 16));
  floorCount.onchange = () => actions.floorCount(Number(floorCount.value));
  floorHeight.onchange = () => actions.floorHeight(Number(floorHeight.value));
  groundHeight.onchange = () => actions.groundHeight(Number(groundHeight.value));
  splitButton.onclick = () => actions.split(Number(splitAt.value));
  spireHeight.onchange = () => actions.detailHeight(Number(spireHeight.value));
  spireFlag.onchange = () => actions.detailFlag(spireFlag.value as 'none' | 'plain' | 'saoPaulo' | 'saoPauloState');
  reliefDepth.onchange = () => actions.relief(Number(reliefDepth.value));
  geometryBox.querySelectorAll<HTMLInputElement>('[data-creator-geometry]').forEach((input) => {
    input.onchange = () => actions.geometry(input.dataset['creatorGeometry'] as keyof FacadeGeometry, Number(input.value));
  });
  upperShape.onchange = () => { upperAdvanced.hidden = upperShape.value === 'match'; };
  upperAdvanced.hidden = true;

  const renderMasses = (host: HTMLElement, list: CreatorState['masses'], current: number | null): void => {
    host.replaceChildren();
    for (const [index, mass] of list.entries()) {
      const button = makeButton('creator.mass', () => actions.mass(mass.id));
      button.removeAttribute('data-i18n');
      const name = mass.base > 0 ? `${t('creator.mass.upper')} ${mass.id}`
        : index === 0 ? t('creator.mass.base') : `${t('creator.mass.wing')} ${mass.id}`;
      button.textContent = `${name} · ${t('creator.mass.levelRange', { from: mass.base + 1, to: mass.base + mass.floors })}`;
      button.setAttribute('aria-pressed', String(mass.id === current));
      host.append(button);
    }
  };

  const update = (next: CreatorState): void => {
    root.hidden = !next.selected || next.drawing !== null;
    root.dataset['creatorTool'] = next.tool;
    rail.querySelectorAll<HTMLButtonElement>('[data-creator-tool]').forEach((button) => {
      button.setAttribute('aria-pressed', String(button.dataset['creatorTool'] === next.tool));
      button.disabled = (button.dataset['creatorTool'] !== 'sketch' && !next.selected) ||
        (next.drawing !== null && button.dataset['creatorTool'] !== 'sketch');
    });
    const active = next.drawing !== null ? 'drawing' : next.selected ? next.tool : 'start';
    if (active !== lastStage) { root.scrollTop = 0; lastStage = active; }
    title.textContent = t(`creator.guide.${active}.title`);
    description.textContent = t(`creator.guide.${active}.body`);
    frameButton.hidden = !next.selected || next.drawing !== null;
    start.hidden = next.tool !== 'sketch' || next.selected || next.drawing !== null;
    sketch.hidden = next.tool !== 'sketch' || (!next.selected && next.drawing === null);
    shape.hidden = next.tool !== 'shape' || !next.selected;
    facade.hidden = next.tool !== 'facade' || !next.selected;
    roof.hidden = next.tool !== 'roof' || !next.selected;
    drawing.hidden = next.drawing === null;
    drawingActions.hidden = next.drawing !== null;
    pointCount.textContent = t('creator.points', { count: next.drawing ?? 0 });
    drawing.querySelector<HTMLButtonElement>('[data-creator-action="finish"]')!.disabled = (next.drawing ?? 0) < 3 || !!next.problem;
    shapeSummary.textContent = t('creator.shapeSummary', { floors: next.floors, area: next.area.toFixed(1) });
    if (document.activeElement !== floorCount) floorCount.value = String(next.floors);
    if (document.activeElement !== floorHeight) floorHeight.value = String(Math.round(next.floorHeight * METERS_PER_UNIT * 10) / 10);
    if (document.activeElement !== groundHeight) groundHeight.value = String(Math.round(next.groundHeight * METERS_PER_UNIT * 10) / 10);
    const nextProfileKey = `${next.current}:${next.splitMin}:${next.splitMax}`;
    if (profileKey !== nextProfileKey && document.activeElement !== splitAt) {
      profileKey = nextProfileKey;
      splitAt.value = String(next.splitDefault);
    }
    splitAt.min = String(next.splitMin);
    splitAt.max = String(next.splitMax);
    splitAt.disabled = next.splitMax < next.splitMin;
    splitButton.disabled = splitAt.disabled;
    shape.querySelectorAll<HTMLButtonElement>('#creatorTierShapes button').forEach((button) =>
      button.setAttribute('aria-pressed', String(button.dataset['value'] === next.tierShape)));
    shape.querySelector<HTMLButtonElement>('[data-creator-action="insert-point"]')!.disabled = !next.selectedFace;
    shape.querySelector<HTMLButtonElement>('[data-creator-action="remove-point"]')!.disabled = !next.selectedVertex;
    root.querySelectorAll<HTMLButtonElement>('#creatorElements button').forEach((button) =>
      button.setAttribute('aria-pressed', String(button.dataset['value'] === next.armedElement)));
    elementEditor.hidden = next.element === null;
    elementHint.hidden = next.element !== null;
    if (next.armedElement || next.element) elementsBox.open = true;
    if (next.element) {
      get('creatorElementName').textContent = t(`building.element.${next.element.kind}`);
      elementEditor.querySelectorAll<HTMLInputElement>('[data-creator-element-size]').forEach((input) => {
        if (document.activeElement === input) return;
        const value = next.element![input.dataset['creatorElementSize'] as 'w' | 'd' | 'h'] * METERS_PER_UNIT;
        input.value = String(Math.round(value * 10) / 10);
        const output = input.nextElementSibling as HTMLOutputElement;
        output.textContent = `${value.toFixed(1)} m`;
      });
    }
    sketch.querySelector<HTMLButtonElement>('[data-creator-action="draw-top"]')!.disabled = !next.selected;
    const key = JSON.stringify([next.masses, next.current, t('creator.mass.base'), t('creator.mass.wing'), t('creator.mass.upper')]);
    if (key !== listKey) {
      listKey = key;
      renderMasses(masses, next.masses, next.current);
      renderMasses(shapeMasses, next.masses, next.current);
    }
    const userKey = JSON.stringify([next.blueprints, t('creator.remove')]);
    if (userKey !== blueprintsKey) {
      blueprintsKey = userKey;
      userBlueprints.replaceChildren();
      for (const blueprint of next.blueprints) {
        const row = el('div', 'creator-blueprint-row');
        const use = makeButton('creator.myModels', () => actions.useBlueprint(blueprint.key));
        use.removeAttribute('data-i18n');
        use.textContent = blueprint.name;
        const remove = makeButton('creator.remove', () => actions.deleteBlueprint(blueprint.key));
        remove.setAttribute('aria-label', `${t('creator.remove')} ${blueprint.name}`);
        row.append(use, remove);
        userBlueprints.append(row);
      }
    }
    savedModels.hidden = next.blueprints.length === 0;
    error.hidden = !next.problem;
    error.textContent = next.problem ? t(`building.problem.${next.problem}`) : '';
    hint.textContent = t(`creator.tip.${next.tool}`);
    root.querySelectorAll<HTMLButtonElement>('#creatorPatterns button').forEach((button) =>
      button.setAttribute('aria-pressed', String(button.dataset['value'] === next.facadePattern)));
    for (const value of ['face', 'floor'] as const) {
      const option = faceScope.querySelector<HTMLOptionElement>(`option[value="${value}"]`);
      if (option) option.disabled = !next.selectedFace;
    }
    if (document.activeElement !== faceScope) faceScope.value = next.scope;
    selectedFloor.hidden = next.selectedFloor === null;
    if (next.selectedFloor !== null) selectedFloor.textContent = t('creator.selectedFloor', { floor: next.selectedFloor });
    reliefBox.hidden = !next.selectedFace;
    if (document.activeElement !== reliefDepth) reliefDepth.value = String(Math.round(next.reliefDepth * METERS_PER_UNIT * 1000) / 1000);
    geometryBox.hidden = !next.selectedFace;
    if (next.geometry) geometryBox.querySelectorAll<HTMLInputElement>('[data-creator-geometry]').forEach((input) => {
      if (document.activeElement === input) return;
      const name = input.dataset['creatorGeometry'] as keyof FacadeGeometry;
      const value = next.geometry![name];
      input.value = String(Math.round((name === 'windowWidth' || name === 'windowHeight' ? value * 100
        : name === 'sill' || name === 'pierWidth' || name === 'pierDepth' ? value * METERS_PER_UNIT : value) * 100) / 100);
    });
    root.querySelectorAll<HTMLButtonElement>('#creatorOpenings button').forEach((button) =>
      button.setAttribute('aria-pressed', String(button.dataset['value'] === next.component)));
    root.querySelectorAll<HTMLButtonElement>('#creatorRoofKinds button').forEach((button) =>
      button.setAttribute('aria-pressed', String(button.dataset['value'] === next.roof)));
    root.querySelectorAll<HTMLButtonElement>('#creatorRoofDetails button').forEach((button) =>
      button.setAttribute('aria-pressed', String(button.dataset['value'] === next.armedDetail)));
    pitchLabel.hidden = next.roof === 'flat' || next.roof === 'terrace' || next.roof === null;
    ridgeGroup.hidden = next.roof !== 'gable' && next.roof !== 'hip';
    ridgeGroup.querySelectorAll<HTMLButtonElement>('[data-creator-ridge]').forEach((button) =>
      button.setAttribute('aria-pressed', String(button.dataset['creatorRidge'] === next.ridge)));
    fallLabel.hidden = next.roof !== 'shed';
    if (document.activeElement !== fall) fall.value = String(next.fall ?? 0);
    if (document.activeElement !== pitch) pitch.value = String(next.pitch);
    pitchValue.textContent = `${next.pitch}°`;
    const selectedPart = next.details.find((part) => part.id === next.selectedDetail);
    spireHeightLabel.hidden = selectedPart?.kind !== 'spire';
    spireFlagLabel.hidden = selectedPart?.kind !== 'spire';
    if (selectedPart?.kind === 'spire' && document.activeElement !== spireHeight)
      spireHeight.value = String(Math.round((selectedPart.h ?? 0) * METERS_PER_UNIT * 10) / 10);
    if (selectedPart?.kind === 'spire' && document.activeElement !== spireFlag) spireFlag.value = selectedPart.flag ?? 'none';
    if (next.material) {
      if (document.activeElement !== finish) finish.value = next.material.finish;
      if (document.activeElement !== color) color.value = `#${next.material.colour.toString(16).padStart(6, '0')}`;
      if (document.activeElement !== roofFinish) roofFinish.value = next.material.finish;
      if (document.activeElement !== roofColor) roofColor.value = `#${next.material.colour.toString(16).padStart(6, '0')}`;
    }
    for (const option of finish.options) option.textContent = t(`building.finish.${option.value}`);
    for (const option of roofFinish.options) option.textContent = t(`building.finish.${option.value}`);
    const newDetailsKey = JSON.stringify([next.details, next.selectedDetail, t('creator.turn'), next.details.map((part) => t(`creator.detail.${part.kind}`))]);
    if (newDetailsKey !== detailsKey) {
      detailsKey = newDetailsKey;
      details.replaceChildren();
      for (const part of next.details) {
        const button = makeButton(`creator.detail.${part.kind}`, () => actions.selectDetail(part.id));
        button.removeAttribute('data-i18n');
        button.textContent = `${t(`creator.detail.${part.kind}`)} ${part.id}`;
        button.setAttribute('aria-pressed', String(part.id === next.selectedDetail));
        details.append(button);
      }
      if (next.selectedDetail !== null) {
        const controls = el('div', 'creator-buttons');
        controls.append(
          makeButton('creator.turn', actions.turnDetail),
          makeButton('creator.moveLeft', () => actions.moveDetail(-1.25, 0)),
          makeButton('creator.moveRight', () => actions.moveDetail(1.25, 0)),
          makeButton('creator.remove', actions.deleteDetail),
        );
        details.append(controls);
      }
    }
    renderDock(next);
  };
  return { refresh: update };
}
