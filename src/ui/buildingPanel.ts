import { BLUEPRINTS, type Blueprint } from '@world/buildings/blueprints';
import {
  BAY_COMPONENTS,
  type BayComponent,
  ROOF_KINDS,
  type RoofKind,
  type Side,
} from '@world/buildings/types';
import { FINISHES, type Finish, type MaterialSpec } from '@world/buildings/materials';
import { METERS_PER_UNIT } from '@world/units';
import { plural, t } from './i18n';

/**
 * The building palette (docs/buildings.md section 4): mode, type, presets,
 * parameters, and - with a building selected - its volumes, roof and facade
 * components. It only renders state and reports clicks; `main.ts` turns the
 * clicks into tool commands.
 */

export type BuildingScope = 'bay' | 'storey' | 'side' | 'volume';
export type MaterialScope = 'building' | 'volume' | 'face' | 'roof';
export type BuildingParam = 'width' | 'depth' | 'storeys' | 'storeyHeight' | 'module';

export interface BuildingPanelActions {
  setMode(mode: 'place' | 'edit'): void;
  chooseBlueprint(key: string): void;
  chooseUserBlueprint(key: string): void;
  removeUserBlueprint(key: string): void;
  /** `commit` is false while a slider is being dragged, true on release. */
  setParameter(name: BuildingParam, value: number, commit: boolean): void;
  action(name: 'storeyUp' | 'storeyDown' | 'setback' | 'removeVolume' | 'rotate' | 'duplicate' | 'colour' | 'saveBlueprint' | 'delete' | 'ridge' | 'fall'): void;
  /** Pushes the picked face region to `depth` world units (negative: in). */
  setRelief(depth: number): void;
  /** Roof pitch, degrees; `commit` false while the slider is dragged. */
  setPitch(degrees: number, commit: boolean): void;
  addWing(side: Side): void;
  setRoof(roof: RoofKind): void;
  armComponent(component: BayComponent | null): void;
  setScope(scope: BuildingScope): void;
  setMaterialScope(scope: MaterialScope): void;
  /** A new finish keeps the current colour, a new colour the current finish. */
  paint(patch: Partial<MaterialSpec>): void;
}

export interface BuildingPanelState {
  readonly mode: 'place' | 'edit';
  readonly blueprintKey: string | null;
  readonly userBlueprints: readonly Blueprint[];
  /** Slider values, world units for lengths, cells for counts. */
  readonly params: Readonly<Record<BuildingParam, number>>;
  readonly selection: null | {
    readonly floors: number;
    readonly width: number;
    readonly depth: number;
    readonly volumes: number;
    readonly roof: RoofKind;
  };
  readonly component: BayComponent | null;
  readonly scope: BuildingScope;
  readonly materialScope: MaterialScope;
  /** The picked face region: its size and how far it is pushed; null when none. */
  readonly face: { readonly bays: number; readonly storeys: number; readonly depth: number } | null;
  /** The selected volume's roof: its pitch and which shape controls apply. */
  readonly roofShape: { readonly pitch: number; readonly pitched: boolean; readonly ridge: boolean; readonly fall: boolean } | null;
  /** What the current material target is built in; null when there is none (a face scope with no face picked). */
  readonly material: MaterialSpec | null;
}

export interface BuildingPanel {
  refresh(state: BuildingPanelState): void;
}

const ICON_PRESET: Readonly<Record<string, string>> = {
  block: '<path d="M4 8l8-4 8 4v10l-8 4-8-4Z"/><path d="M4 8l8 4 8-4M12 12v10"/>',
  house: '<path d="M4 20V11l8-6 8 6v9Z"/><path d="M10 20v-5h4v5"/>',
  rowhouse: '<path d="M3 20V9l4-3 4 3v11M11 20V9l4-3 4 3v11"/>',
  apartments: '<path d="M5 20V5h14v15"/><path d="M8 8h2m4 0h2M8 12h2m4 0h2M8 16h2m4 0h2"/>',
  tower: '<path d="M4 20v-6h16v6"/><path d="M8 14V3h8v11"/><path d="M10 6h1m2 0h1m-4 3h1m2 0h1"/>',
  shop: '<path d="M4 20V9h16v11"/><path d="M4 9l2-4h12l2 4"/><path d="M7 20v-6h10v6"/>',
  office: '<path d="M6 20V3h12v17"/><path d="M6 7h12M6 11h12M6 15h12"/>',
  mixed: '<path d="M4 20V6l8-3 8 3v14"/><path d="M4 16h16"/><path d="M8 9h2m4 0h2"/>',
  warehouse: '<path d="M3 20V10l4-3v3l4-3v3l4-3v3l4-3v13Z"/>',
  factory: '<path d="M3 20V11h5V8l4 3V8l4 3h5v9Z"/><path d="M17 11V4h2v7"/>',
};

const ICON_COMPONENT: Readonly<Record<BayComponent, string>> = {
  wall: '<rect x="5" y="4" width="14" height="16" rx="1"/>',
  window: '<rect x="5" y="4" width="14" height="16" rx="1"/><rect x="9" y="8" width="6" height="7"/><path d="M12 8v7"/>',
  wideWindow: '<rect x="5" y="4" width="14" height="16" rx="1"/><rect x="6.5" y="5.5" width="11" height="13"/><path d="M12 5.5v13M6.5 11h11"/>',
  balcony: '<rect x="5" y="4" width="14" height="16" rx="1"/><rect x="9" y="7" width="6" height="10"/><path d="M4 17h16M6 13v4m4-4v4m4-4v4m4-4v4M4 13h16"/>',
  door: '<rect x="5" y="4" width="14" height="16" rx="1"/><rect x="9.5" y="9" width="5" height="11"/>',
  shopfront: '<rect x="5" y="4" width="14" height="16" rx="1"/><rect x="6.5" y="10" width="11" height="8"/><path d="M5 9l2-2h10l2 2Z"/>',
  loadingDoor: '<rect x="5" y="4" width="14" height="16" rx="1"/><rect x="7" y="8" width="10" height="12"/><path d="M7 11h10M7 14h10M7 17h10"/>',
  pillar: '<path d="M5 4h14v4H5z"/><path d="M9 8v12m6-12v12"/>',
};

const ICON_ROOF: Readonly<Record<RoofKind, string>> = {
  flat: '<path d="M4 18V10h16v8"/><path d="M4 10V8h16v2"/>',
  terrace: '<path d="M4 18v-6h16v6"/><path d="M4 12V9m4 3V9m4 3V9m4 3V9m4 3V9M4 9h16"/>',
  gable: '<path d="M4 18v-7l8-6 8 6v7"/>',
  hip: '<path d="M4 18v-6l4-5h8l4 5v6"/>',
  shed: '<path d="M4 18V11l16-5v12"/>',
  sawtooth: '<path d="M3 18v-7l5-4v4l5-4v4l5-4v11"/>',
};

const ICON_FINISH: Readonly<Record<Finish, string>> = {
  plaster: '<rect x="4" y="4" width="16" height="16" rx="1"/><path d="M7 9c2-1 3 1 5 0s3-1 5 0M7 14c2-1 3 1 5 0s3-1 5 0"/>',
  brick: '<rect x="4" y="4" width="16" height="16" rx="1"/><path d="M4 9h16M4 14h16M10 4v5M15 9v5M9 14v6"/>',
  stone: '<rect x="4" y="4" width="16" height="16" rx="1"/><path d="M4 10h16M4 15h16M12 4v6M8 10v5M16 10v5M12 15v5"/>',
  concrete: '<rect x="4" y="4" width="16" height="16" rx="1"/><path d="M12 4v16M4 12h16"/><circle cx="8" cy="8" r=".6"/><circle cx="16" cy="16" r=".6"/>',
  wood: '<rect x="4" y="4" width="16" height="16" rx="1"/><path d="M8 4v16M12 4v16M16 4v16"/>',
  metal: '<path d="M4 20V4m4 16V4m4 16V4m4 16V4m4 16V4"/><path d="M4 4h16M4 20h16"/>',
  glass: '<rect x="4" y="4" width="16" height="16" rx="1"/><path d="M12 4v16M4 12h16M7 7l3-3M14 14l3-3"/>',
  tile: '<path d="M3 17c2-3 4-3 6 0 2-3 4-3 6 0 2-3 4-3 6 0M3 11c2-3 4-3 6 0 2-3 4-3 6 0 2-3 4-3 6 0"/>',
};

/** Colours offered at a click; any other comes from the colour picker. */
const SWATCHES: readonly number[] = [
  0xf2efe8, 0xe6d8bd, 0xd8c297, 0xc98f5a, 0xa4563f, 0x72412f, 0x9c6b43,
  0xbdbcb4, 0x8f9ba5, 0x55585c, 0x2f3134, 0x7d8c6a, 0x5d7a8f, 0x9fb8c4,
];

const hexOf = (colour: number): string => `#${colour.toString(16).padStart(6, '0')}`;

const svg = (body: string): string =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

const PARAMS: readonly BuildingParam[] = ['width', 'depth', 'storeys', 'storeyHeight', 'module'];
/** Lengths are shown and entered in metres; the model works in world units. */
const IN_METRES: ReadonlySet<BuildingParam> = new Set(['width', 'depth', 'storeyHeight', 'module']);

export function initBuildingPanel(actions: BuildingPanelActions): BuildingPanel {
  const root = document.getElementById('buildingPalette') as HTMLElement;
  const presets = document.getElementById('buildingPresets') as HTMLElement;
  const userPresets = document.getElementById('buildingUserPresets') as HTMLElement;
  const roofs = document.getElementById('buildingRoofs') as HTMLElement;
  const components = document.getElementById('buildingComponents') as HTMLElement;
  const summary = document.getElementById('buildingSummary') as HTMLElement;
  const edit = document.getElementById('buildingEdit') as HTMLElement;
  const scope = document.getElementById('buildingScope') as HTMLSelectElement;
  const params = document.getElementById('buildingParams') as HTMLElement;

  root.querySelectorAll<HTMLButtonElement>('[data-building-mode]').forEach((b) => {
    b.onclick = () => actions.setMode(b.dataset['buildingMode'] === 'edit' ? 'edit' : 'place');
  });
  root.querySelectorAll<HTMLButtonElement>('[data-building-action]').forEach((b) => {
    b.onclick = () => actions.action(b.dataset['buildingAction'] as Parameters<BuildingPanelActions['action']>[0]);
  });
  root.querySelectorAll<HTMLButtonElement>('[data-building-wing]').forEach((b) => {
    b.onclick = () => actions.addWing(Number(b.dataset['buildingWing']) as Side);
  });
  scope.onchange = () => actions.setScope(scope.value as BuildingScope);
  root.querySelectorAll<HTMLButtonElement>('[data-material-scope]').forEach((b) => {
    b.onclick = () => actions.setMaterialScope(b.dataset['materialScope'] as MaterialScope);
  });
  const finishes = document.getElementById('buildingFinishes') as HTMLElement;
  for (const finish of FINISHES) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'building-component building-finish';
    b.dataset['finish'] = finish;
    b.innerHTML = `${svg(ICON_FINISH[finish])}<span></span>`;
    b.onclick = () => actions.paint({ finish });
    finishes.appendChild(b);
  }
  const swatches = document.getElementById('buildingSwatches') as HTMLElement;
  for (const colour of SWATCHES) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'building-swatch';
    b.dataset['colour'] = String(colour);
    b.style.setProperty('--swatch', hexOf(colour));
    b.setAttribute('aria-label', hexOf(colour));
    b.onclick = () => actions.paint({ colour });
    swatches.appendChild(b);
  }
  const custom = document.createElement('input');
  custom.type = 'color';
  custom.className = 'building-swatch custom';
  // `change` only: one pick, one undo step, not one per drag of the picker.
  custom.onchange = () => actions.paint({ colour: parseInt(custom.value.slice(1), 16) });
  swatches.appendChild(custom);
  const materialNote = document.getElementById('buildingMaterialNote') as HTMLElement;
  const faceBox = document.getElementById('buildingFace') as HTMLElement;
  const faceNote = document.getElementById('buildingFaceNote') as HTMLElement;
  const faceSummary = document.getElementById('buildingFaceSummary') as HTMLElement;
  const reliefDepth = document.getElementById('buildingReliefDepth') as HTMLInputElement;
  const reliefDepthValue = document.getElementById('buildingReliefDepthValue') as HTMLOutputElement;
  reliefDepth.oninput = () => {
    reliefDepthValue.textContent = Number(reliefDepth.value).toFixed(2);
  };
  // One release, one edit (and one undo step).
  reliefDepth.onchange = () => actions.setRelief(Number(reliefDepth.value) / METERS_PER_UNIT);
  root.querySelectorAll<HTMLButtonElement>('[data-building-relief]').forEach((b) => {
    b.onclick = () => actions.setRelief(Number(b.dataset['buildingRelief']) / METERS_PER_UNIT);
  });
  const roofShape = document.getElementById('buildingRoofShape') as HTMLElement;
  const pitch = document.getElementById('buildingPitch') as HTMLInputElement;
  const pitchValue = document.getElementById('buildingPitchValue') as HTMLOutputElement;
  pitch.oninput = () => {
    pitchValue.textContent = `${pitch.value}°`;
    actions.setPitch(Number(pitch.value), false);
  };
  pitch.onchange = () => actions.setPitch(Number(pitch.value), true);

  for (const bp of BLUEPRINTS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'building-preset';
    b.dataset['preset'] = bp.key;
    b.innerHTML = `${svg(ICON_PRESET[bp.key] ?? ICON_PRESET['house']!)}<span></span>`;
    b.onclick = () => actions.chooseBlueprint(bp.key);
    presets.appendChild(b);
  }
  for (const roof of ROOF_KINDS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset['roof'] = roof;
    b.innerHTML = `${svg(ICON_ROOF[roof])}`;
    b.onclick = () => actions.setRoof(roof);
    roofs.appendChild(b);
  }
  for (const component of BAY_COMPONENTS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'building-component';
    b.dataset['component'] = component;
    b.innerHTML = `${svg(ICON_COMPONENT[component])}<span></span>`;
    b.onclick = () => actions.armComponent(b.classList.contains('active') ? null : component);
    components.appendChild(b);
  }

  const inputs = new Map<BuildingParam, HTMLInputElement>();
  const outputs = new Map<BuildingParam, HTMLOutputElement>();
  const ids: Record<BuildingParam, string> = {
    width: 'buildingWidth',
    depth: 'buildingDepth',
    storeys: 'buildingStoreys',
    storeyHeight: 'buildingStoreyHeight',
    module: 'buildingModule',
  };
  for (const name of PARAMS) {
    const input = document.getElementById(ids[name]) as HTMLInputElement;
    const output = document.getElementById(`${ids[name]}Value`) as HTMLOutputElement;
    inputs.set(name, input);
    outputs.set(name, output);
    const read = (): number => {
      const value = Number(input.value);
      return IN_METRES.has(name) ? value / METERS_PER_UNIT : value;
    };
    input.oninput = () => {
      output.textContent = input.value;
      actions.setParameter(name, read(), false);
    };
    input.onchange = () => actions.setParameter(name, read(), true);
  }

  refreshBuildingPanelLabels();

  const renderUserPresets = (list: readonly Blueprint[], active: string | null): void => {
    const signature = list.map((b) => b.key).join('|') + `#${active}`;
    if (userPresets.dataset['signature'] === signature) return;
    userPresets.dataset['signature'] = signature;
    userPresets.innerHTML = '';
    if (list.length === 0) return;
    const heading = document.createElement('div');
    heading.className = 'building-label';
    heading.style.gridColumn = '1 / -1';
    heading.textContent = t('building.myBlueprints');
    userPresets.appendChild(heading);
    for (const bp of list) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'building-preset' + (bp.key === active ? ' active' : '');
      b.innerHTML = `${svg(ICON_PRESET['apartments']!)}<span></span><span class="remove" role="button">×</span>`;
      (b.querySelector('span') as HTMLElement).textContent = bp.name ?? bp.key;
      const remove = b.querySelector('.remove') as HTMLElement;
      remove.title = t('building.removeBlueprint');
      remove.onclick = (e) => {
        e.stopPropagation();
        actions.removeUserBlueprint(bp.key);
      };
      b.onclick = () => actions.chooseUserBlueprint(bp.key);
      userPresets.appendChild(b);
    }
  };

  const refresh = (state: BuildingPanelState): void => {
    const toggle = (selector: string, attribute: string, value: string | null): void => {
      root.querySelectorAll<HTMLButtonElement>(selector).forEach((b) => {
        const on = b.getAttribute(attribute) === value;
        b.classList.toggle('active', on);
        b.setAttribute('aria-pressed', String(on));
      });
    };
    toggle('[data-building-mode]', 'data-building-mode', state.mode);
    toggle('.building-preset[data-preset]', 'data-preset', state.mode === 'place' ? state.blueprintKey : null);
    toggle('.building-component', 'data-component', state.component);
    toggle('[data-roof]', 'data-roof', state.selection?.roof ?? null);
    renderUserPresets(state.userBlueprints, state.mode === 'place' ? state.blueprintKey : null);
    for (const name of PARAMS) {
      const input = inputs.get(name) as HTMLInputElement;
      const output = outputs.get(name) as HTMLOutputElement;
      if (document.activeElement === input) continue;
      const raw = state.params[name];
      const value = IN_METRES.has(name) ? Math.round(raw * METERS_PER_UNIT * 10) / 10 : Math.round(raw);
      input.value = String(value);
      output.textContent = IN_METRES.has(name) ? value.toFixed(1) : String(value);
    }
    if (scope.value !== state.scope) scope.value = state.scope;
    toggle('[data-material-scope]', 'data-material-scope', state.materialScope);
    toggle('.building-finish', 'data-finish', state.material?.finish ?? null);
    toggle('.building-swatch[data-colour]', 'data-colour', state.material ? String(state.material.colour) : null);
    if (state.material && document.activeElement !== custom) custom.value = hexOf(state.material.colour);
    materialNote.hidden = !(state.materialScope === 'face' && state.material === null && state.selection !== null);
    faceBox.hidden = state.face === null;
    faceNote.hidden = state.face !== null;
    if (state.face) {
      faceSummary.textContent = t('building.face.summary', {
        bays: plural('building.bays', state.face.bays),
        floors: plural('building.floors', state.face.storeys),
      });
      if (document.activeElement !== reliefDepth) {
        const metres = state.face.depth * METERS_PER_UNIT;
        reliefDepth.value = String(Math.round(metres * 20) / 20);
        reliefDepthValue.textContent = metres.toFixed(2);
      }
    }
    roofShape.hidden = !state.roofShape?.pitched;
    if (state.roofShape) {
      if (document.activeElement !== pitch) {
        pitch.value = String(state.roofShape.pitch);
        pitchValue.textContent = `${state.roofShape.pitch}°`;
      }
      (roofShape.querySelector('[data-building-action="ridge"]') as HTMLButtonElement).hidden = !state.roofShape.ridge;
      (roofShape.querySelector('[data-building-action="fall"]') as HTMLButtonElement).hidden = !state.roofShape.fall;
    }
    // Each mode shows its own sections: presets to place, the selection to edit.
    // Presets stay reachable while editing, as a compact row of icons.
    root.classList.toggle('editing', state.mode === 'edit');
    edit.hidden = state.mode !== 'edit';
    params.hidden = state.mode === 'edit' && state.selection === null;
    edit.classList.toggle('disabled', state.selection === null);
    if (state.selection) {
      const s = state.selection;
      summary.removeAttribute('data-i18n');
      summary.textContent = t('building.summary', {
        floors: plural('building.floors', s.floors),
        width: (s.width * METERS_PER_UNIT).toFixed(1),
        depth: (s.depth * METERS_PER_UNIT).toFixed(1),
        volumes: plural('building.volumes', s.volumes),
      });
    } else {
      summary.dataset['i18n'] = 'building.none';
      summary.textContent = t('building.none');
    }
  };

  return { refresh };
}

/** Re-renders the script-built labels after a language change. */
export function refreshBuildingPanelLabels(): void {
  const presets = document.getElementById('buildingPresets');
  presets?.querySelectorAll<HTMLButtonElement>('.building-preset').forEach((b) => {
    const bp = BLUEPRINTS.find((x) => x.key === b.dataset['preset']);
    const label = bp?.nameKey ? t(bp.nameKey) : '';
    (b.querySelector('span') as HTMLElement).textContent = label;
    b.title = label;
  });
  document.querySelectorAll<HTMLButtonElement>('#buildingRoofs button').forEach((b) => {
    const label = t(`building.roof.${b.dataset['roof']}`);
    b.title = label;
    b.setAttribute('aria-label', label);
  });
  document.querySelectorAll<HTMLButtonElement>('#buildingFinishes .building-finish').forEach((b) => {
    const label = t(`building.finish.${b.dataset['finish']}`);
    (b.querySelector('span') as HTMLElement).textContent = label;
    b.title = label;
  });
  const picker = document.querySelector<HTMLInputElement>('#buildingSwatches input');
  if (picker) picker.title = t('building.colourPick');
  document.querySelectorAll<HTMLButtonElement>('#buildingComponents .building-component').forEach((b) => {
    const label = t(`building.component.${b.dataset['component']}`);
    (b.querySelector('span') as HTMLElement).textContent = label;
    b.title = label;
  });
  const user = document.getElementById('buildingUserPresets');
  if (user) delete user.dataset['signature'];
}
