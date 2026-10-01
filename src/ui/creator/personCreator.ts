import { ageFromYears, yearsFromAge, type MacroParams } from '@people/body/macro';
import {
  CLOTH_COLOURS, EYE_COLOURS, HAIR_COLOURS, SKIN_TONES, defaultPerson, randomPerson,
  type BottomStyle, type HairStyle, type PersonLook, type PersonSpec, type TopStyle,
} from '@people/spec';
import { t } from '../i18n';
import './personCreator.css';

/**
 * The Person Creator: build anybody - any sex, age, body, skin, face, hair and
 * clothes - see them in 3D as the sliders move, and save them with the city.
 *
 * It lives in the side panel like every other tool. The MakeHuman packs are
 * fetched the first time it opens, never at boot. The preview has its own
 * small renderer, drawn only when something changed or the person is being
 * turned.
 */

/** The 3D preview, made by the renderer (`render/people/personPreview.ts`) and handed in. */
export interface PersonPreviewPort {
  setActive(active: boolean): void;
  readonly ready: Promise<void>;
  show(person: PersonSpec): void;
  setLook(look: PersonLook): void;
  setWalking(walking: boolean): void;
  turn(delta: number): void;
  zoom(delta: number): void;
  readonly height: number;
}

export interface PersonCreatorHost {
  /** Makes the preview on the creator's own canvas. */
  preview(canvas: HTMLCanvasElement): PersonPreviewPort;
  people(): readonly PersonSpec[];
  save(person: PersonSpec): void;
  remove(id: number): void;
  nextId(): number;
}

export interface PersonCreator {
  /** The controls: mounted in the side panel. */
  readonly root: HTMLElement;
  /**
   * The 3D preview: mounted outside the panel, beside it (above the sheet on
   * a phone), so it stays in view however far down the controls are scrolled.
   */
  readonly stage: HTMLElement;
  activate(): void;
  deactivate(): void;
  /** The saved list changed elsewhere (undo, a loaded map). */
  refresh(): void;
  relabel(): void;
}

/** Face and body detail sliders offered, by MakeHuman regional slider name. */
const FACE_SLIDERS = [
  'head-fat-decr-incr', 'head-scale-vert-decr-incr', 'nose-scale-horiz-decr-incr', 'nose-scale-vert-decr-incr',
  'nose-curve-concave-convex', 'mouth-scale-horiz-decr-incr', 'mouth-lowerlip-volume-decr-incr', 'eye-scale-decr-incr',
  'ear-scale-decr-incr', 'chin-width-decr-incr', 'chin-prominent-decr-incr', 'cheek-bones-decr-incr',
] as const;
const BODY_SLIDERS = [
  'measure-shoulder-dist-decr-incr', 'measure-waist-circ-decr-incr', 'measure-hips-circ-decr-incr',
  'stomach-pregnant-decr-incr', 'torso-vshape-decr-incr', 'upperarm-muscle-decr-incr',
  'upperlegs-height-decr-incr', 'measure-neck-height-decr-incr',
] as const;

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};
const hex = (c: number): string => `#${c.toString(16).padStart(6, '0')}`;

export function createPersonCreator(host: PersonCreatorHost): PersonCreator {
  const root = el('div', 'person-creator');
  let person: PersonSpec = defaultPerson(host.nextId());
  let loaded = false;

  // ------------------------------------------------------------ preview
  const stage = el('div', 'pc-stage');
  const canvas = el('canvas', 'pc-canvas');
  const status = el('div', 'pc-status');
  const heightTag = el('div', 'pc-height');
  // Walk on the spot: the person as the street will see them move.
  const walkButton = el('button', 'pc-walk');
  walkButton.type = 'button';
  walkButton.setAttribute('aria-pressed', 'false');
  let walking = false;
  walkButton.addEventListener('click', () => {
    walking = !walking;
    walkButton.setAttribute('aria-pressed', String(walking));
    walkButton.classList.toggle('active', walking);
    walkButton.textContent = t(walking ? 'person.stand' : 'person.walk');
    preview.setWalking(walking);
  });
  stage.append(canvas, status, heightTag, walkButton);
  const preview = host.preview(canvas);
  void preview.ready.then(() => {
    loaded = true;
    status.textContent = '';
    reshape();
  }, () => {
    status.textContent = t('person.loadFailed');
  });

  let dragging: { id: number; x: number } | null = null;
  canvas.addEventListener('pointerdown', (e) => {
    dragging = { id: e.pointerId, x: e.clientX };
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!dragging || dragging.id !== e.pointerId) return;
    preview.turn(-(e.clientX - dragging.x) * 0.012);
    dragging.x = e.clientX;
  });
  const endDrag = (): void => {
    dragging = null;
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    preview.zoom(-Math.sign(e.deltaY));
  }, { passive: false });

  // ------------------------------------------------------------ morphing
  let shapeQueued = false;
  const reshape = (): void => {
    shapeQueued = false;
    preview.show(person);
    if (!loaded) return;
    heightTag.textContent = `${preview.height.toFixed(2)} m · ${Math.round(yearsFromAge(person.body.age))} ${t('person.years')}`;
  };
  const queueShape = (): void => {
    if (shapeQueued) return;
    shapeQueued = true;
    requestAnimationFrame(reshape);
  };

  const setBody = (patch: Partial<MacroParams>): void => {
    person = { ...person, body: { ...person.body, ...patch } };
    queueShape();
  };
  const setFeature = (name: string, value: number): void => {
    const features = { ...person.features };
    if (value === 0) delete features[name];
    else features[name] = value;
    person = { ...person, features };
    queueShape();
  };
  const setLook = (patch: Partial<PersonLook>): void => {
    person = { ...person, look: { ...person.look, ...patch } };
    preview.setLook(person.look);
    renderControls();
  };

  // ------------------------------------------------------------ controls
  const actions = el('div', 'pc-actions');
  const nameInput = el('input', 'pc-name');
  nameInput.type = 'text';
  nameInput.maxLength = 40;
  nameInput.addEventListener('input', () => {
    person = { ...person, name: nameInput.value };
  });
  const randomButton = el('button', 'pc-button');
  randomButton.type = 'button';
  randomButton.addEventListener('click', () => {
    person = { ...randomPerson(person.id, (Math.random() * 2 ** 31) >>> 0), name: person.name };
    preview.setLook(person.look);
    queueShape();
    renderControls();
  });
  const saveButton = el('button', 'pc-button primary');
  saveButton.type = 'button';
  saveButton.addEventListener('click', () => {
    host.save({ ...person, name: nameInput.value.trim() });
    renderSaved();
    flashSaved();
  });
  const newButton = el('button', 'pc-button');
  newButton.type = 'button';
  newButton.addEventListener('click', () => {
    person = defaultPerson(host.nextId());
    nameInput.value = '';
    preview.setLook(person.look);
    queueShape();
    renderControls();
    renderSaved();
  });
  actions.append(nameInput, randomButton, saveButton, newButton);

  const controls = el('div', 'pc-controls');
  const saved = el('div', 'pc-saved');

  const section = (key: string, open = true): HTMLElement => {
    const box = el('details', 'pc-section');
    box.open = open;
    const summary = el('summary', 'pc-section-title', t(key));
    box.appendChild(summary);
    controls.appendChild(box);
    return box;
  };
  const slider = (into: HTMLElement, label: string, value: number, min: number, max: number, step: number,
    onInput: (v: number) => void, format: (v: number) => string): void => {
    const row = el('label', 'pc-slider');
    const name = el('span', 'pc-slider-name', label);
    const input = el('input');
    input.type = 'range';
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.value = String(value);
    input.setAttribute('aria-label', label);
    const out = el('span', 'pc-slider-value', format(value));
    input.addEventListener('input', () => {
      const v = Number(input.value);
      out.textContent = format(v);
      onInput(v);
    });
    row.append(name, input, out);
    into.appendChild(row);
  };
  const swatches = (into: HTMLElement, label: string, colours: readonly number[], current: number, onPick: (c: number) => void): void => {
    const row = el('div', 'pc-swatch-row');
    row.appendChild(el('span', 'pc-slider-name', label));
    const list = el('div', 'pc-swatches');
    for (const c of colours) {
      const b = el('button', 'pc-swatch' + (c === current ? ' active' : ''));
      b.type = 'button';
      b.style.background = hex(c);
      b.setAttribute('aria-label', `${label} ${hex(c)}`);
      b.setAttribute('aria-pressed', String(c === current));
      b.addEventListener('click', () => onPick(c));
      list.appendChild(b);
    }
    const custom = el('input', 'pc-swatch custom');
    custom.type = 'color';
    custom.value = hex(current);
    custom.setAttribute('aria-label', `${label} ${t('person.custom')}`);
    custom.addEventListener('input', () => onPick(parseInt(custom.value.slice(1), 16)));
    list.appendChild(custom);
    row.appendChild(list);
    into.appendChild(row);
  };
  const chips = <T extends string>(into: HTMLElement, label: string, options: readonly T[], current: T, onPick: (v: T) => void): void => {
    const row = el('div', 'pc-swatch-row');
    row.appendChild(el('span', 'pc-slider-name', label));
    const list = el('div', 'pc-chips');
    for (const o of options) {
      const b = el('button', 'pc-chip' + (o === current ? ' active' : ''), t(`person.option.${o}`));
      b.type = 'button';
      b.setAttribute('aria-pressed', String(o === current));
      b.addEventListener('click', () => onPick(o));
      list.appendChild(b);
    }
    row.appendChild(list);
    into.appendChild(row);
  };
  const pct = (v: number): string => `${Math.round(v * 100)}%`;
  const signed = (v: number): string => (v === 0 ? '0' : `${v > 0 ? '+' : ''}${Math.round(v * 100)}`);
  const openSections = new Set(['person.section.body']);

  const renderControls = (): void => {
    const opened = new Set<string>();
    for (const d of controls.querySelectorAll<HTMLDetailsElement>('details')) if (d.open) opened.add(d.dataset['key'] ?? '');
    if (controls.childElementCount) {
      openSections.clear();
      for (const k of opened) openSections.add(k);
    }
    controls.replaceChildren();
    const sec = (key: string): HTMLElement => {
      const s = section(key, openSections.has(key));
      s.dataset['key'] = key;
      return s;
    };
    const b = person.body;

    const bodyBox = sec('person.section.body');
    slider(bodyBox, t('person.sex'), b.gender, 0, 1, 0.01, (v) => setBody({ gender: v }),
      (v) => (v < 0.35 ? t('person.female') : v > 0.65 ? t('person.male') : t('person.between')));
    slider(bodyBox, t('person.age'), Math.round(yearsFromAge(b.age)), 1, 90, 1, (v) => setBody({ age: ageFromYears(v) }), (v) => `${v}`);
    slider(bodyBox, t('person.muscle'), b.muscle, 0, 1, 0.01, (v) => setBody({ muscle: v }), pct);
    slider(bodyBox, t('person.weight'), b.weight, 0, 1, 0.01, (v) => setBody({ weight: v }), pct);
    slider(bodyBox, t('person.height'), b.height, 0, 1, 0.01, (v) => setBody({ height: v }), pct);
    slider(bodyBox, t('person.proportions'), b.proportions, 0, 1, 0.01, (v) => setBody({ proportions: v }), pct);
    if (b.gender < 0.65) {
      slider(bodyBox, t('person.bust'), b.cupsize, 0, 1, 0.01, (v) => setBody({ cupsize: v }), pct);
    }

    const origin = sec('person.section.origin');
    for (const key of ['african', 'asian', 'caucasian'] as const) {
      slider(origin, t(`person.${key}`), b[key], 0, 1, 0.01, (v) => setBody({ [key]: v }), pct);
    }

    const skin = sec('person.section.skin');
    swatches(skin, t('person.skin'), SKIN_TONES, person.look.skin, (c) => setLook({ skin: c }));
    swatches(skin, t('person.eyes'), EYE_COLOURS, person.look.eyes, (c) => setLook({ eyes: c }));

    const hair = sec('person.section.hair');
    chips<HairStyle>(hair, t('person.style'), ['none', 'short', 'long'], person.look.hairStyle, (v) => setLook({ hairStyle: v }));
    swatches(hair, t('person.colour'), HAIR_COLOURS, person.look.hair, (c) => setLook({ hair: c }));

    const clothes = sec('person.section.clothes');
    chips<TopStyle>(clothes, t('person.top'), ['none', 'tank', 'tshirt', 'longsleeve'], person.look.top, (v) => setLook({ top: v }));
    swatches(clothes, t('person.topColour'), CLOTH_COLOURS, person.look.topColour, (c) => setLook({ topColour: c }));
    chips<BottomStyle>(clothes, t('person.bottom'), ['trousers', 'shorts', 'skirt'], person.look.bottom, (v) => setLook({ bottom: v }));
    swatches(clothes, t('person.bottomColour'), CLOTH_COLOURS, person.look.bottomColour, (c) => setLook({ bottomColour: c }));
    swatches(clothes, t('person.shoes'), CLOTH_COLOURS, person.look.shoes, (c) => setLook({ shoes: c }));

    const face = sec('person.section.face');
    for (const name of FACE_SLIDERS) {
      slider(face, t(`person.f.${name}`), person.features[name] ?? 0, -1, 1, 0.02, (v) => setFeature(name, v), signed);
    }
    const shape = sec('person.section.shape');
    for (const name of BODY_SLIDERS) {
      slider(shape, t(`person.f.${name}`), person.features[name] ?? 0, -1, 1, 0.02, (v) => setFeature(name, v), signed);
    }
  };

  const renderSaved = (): void => {
    saved.replaceChildren();
    const people = host.people();
    saved.appendChild(el('div', 'pc-section-title', `${t('person.saved')} (${people.length})`));
    if (people.length === 0) {
      saved.appendChild(el('p', 'pc-note', t('person.savedNone')));
      return;
    }
    const list = el('div', 'pc-saved-list');
    for (const p of people) {
      const card = el('div', 'pc-card' + (p.id === person.id ? ' active' : ''));
      const open = el('button', 'pc-card-open');
      open.type = 'button';
      const chip = el('span', 'pc-card-chip');
      chip.style.background = `linear-gradient(90deg, ${hex(p.look.skin)} 0 34%, ${hex(p.look.topColour)} 34% 67%, ${hex(p.look.bottomColour)} 67%)`;
      open.append(chip, el('span', 'pc-card-name', p.name || `${t('person.unnamed')} ${p.id}`));
      open.addEventListener('click', () => {
        person = p;
        nameInput.value = p.name;
        preview.setLook(p.look);
        queueShape();
        renderControls();
        renderSaved();
      });
      const remove = el('button', 'pc-card-remove', '×');
      remove.type = 'button';
      remove.setAttribute('aria-label', `${t('person.remove')} ${p.name || p.id}`);
      remove.addEventListener('click', () => {
        host.remove(p.id);
        renderSaved();
      });
      card.append(open, remove);
      list.appendChild(card);
    }
    saved.appendChild(list);
  };
  const flashSaved = (): void => {
    saveButton.textContent = t('person.savedFlash');
    setTimeout(() => {
      saveButton.textContent = t('person.save');
    }, 1300);
  };

  const relabel = (): void => {
    nameInput.placeholder = t('person.namePlaceholder');
    nameInput.setAttribute('aria-label', t('person.name'));
    randomButton.textContent = t('person.random');
    walkButton.textContent = t(walking ? 'person.stand' : 'person.walk');
    saveButton.textContent = t('person.save');
    newButton.textContent = t('person.new');
    if (!loaded) status.textContent = t('person.loading');
    renderControls();
    renderSaved();
    if (loaded) reshape();
  };

  root.append(actions, controls, saved);
  relabel();

  return {
    root,
    stage,
    activate() {
      preview.setActive(true);
      preview.show(person);
      if (!loaded) status.textContent = t('person.loading');
      renderSaved();
    },
    deactivate() {
      preview.setActive(false);
    },
    refresh() {
      renderSaved();
    },
    relabel,
  };
}
