/**
 * The interface shell: behaviour of the panels themselves, as opposed to what
 * the controls inside them do.
 *
 * Kept out of `main.ts` because none of it touches the document, the network
 * or the simulation. It only folds panels, opens menus and keeps things in
 * view, so it needs nothing but the DOM and a way to ask for a frame when the
 * layout changed under the canvas.
 */

const PANEL_STORAGE_KEY = 'roadcraft.panels';

/** The width below which the phone layout applies. Mirrors `app.css`. */
const NARROW_QUERY = '(max-width: 780px)';

type PanelState = Record<string, boolean>;

function loadPanelState(): PanelState {
  try {
    const raw = window.localStorage.getItem(PANEL_STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (parsed && typeof parsed === 'object') return parsed as PanelState;
  } catch {
    // Unreadable or denied storage: every panel starts in its default state.
  }
  return {};
}

function savePanelState(state: PanelState): void {
  try {
    window.localStorage.setItem(PANEL_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Not remembering a folded panel is not a reason to refuse folding it.
  }
}

/**
 * Makes every `[data-panel]` foldable from its heading.
 *
 * A panel marked `data-collapsed-narrow` starts folded on a phone, where the
 * simulation panel and the minimap used to cover half the map before the
 * player had touched anything. Once the player folds or unfolds a panel, that
 * choice wins on every later visit.
 */
function initPanels(onLayout: () => void): void {
  const state = loadPanelState();
  const narrow = window.matchMedia?.(NARROW_QUERY).matches ?? false;
  for (const panel of document.querySelectorAll<HTMLElement>('[data-panel]')) {
    const id = panel.dataset['panel'] as string;
    const toggle = panel.querySelector<HTMLButtonElement>('.panel-toggle');
    if (!toggle) continue;
    const apply = (collapsed: boolean): void => {
      panel.classList.toggle('collapsed', collapsed);
      toggle.setAttribute('aria-expanded', String(!collapsed));
    };
    apply(state[id] ?? (narrow && panel.hasAttribute('data-collapsed-narrow')));
    toggle.addEventListener('click', () => {
      const collapsed = !panel.classList.contains('collapsed');
      apply(collapsed);
      state[id] = collapsed;
      savePanelState(state);
      onLayout();
    });
  }
}

/**
 * Keeps the pressed tool visible in the toolbar.
 *
 * On a phone the toolbar scrolls sideways, so a tool chosen by keyboard, or
 * restored on load, can be off the edge. Watching `aria-pressed` covers every
 * way a tool is chosen without `main.ts` having to call in here.
 */
function keepActiveToolVisible(): void {
  const bar = document.querySelector<HTMLElement>('.toolbar');
  if (!bar) return;
  const reveal = (): void => {
    if (bar.scrollWidth <= bar.clientWidth) return;
    const active = bar.querySelector<HTMLElement>('.tool[aria-pressed="true"]');
    if (!active) return;
    const left = active.offsetLeft - bar.clientWidth / 2 + active.offsetWidth / 2;
    bar.scrollTo({ left, behavior: 'smooth' });
  };
  new MutationObserver(reveal).observe(bar, {
    subtree: true,
    attributes: true,
    attributeFilter: ['aria-pressed'],
  });
}

/**
 * The "more" menu of the top bar on a narrow screen.
 *
 * On a desktop the menu's contents sit inline and the button is hidden, so
 * none of this is reachable there. A button inside the menu closes it once it
 * has done its job; the selectors do not, so the player sees what they chose.
 */
function initMoreMenu(): void {
  const button = document.getElementById('moreMenu');
  const menu = document.getElementById('topMenu');
  if (!button || !menu) return;
  const setOpen = (open: boolean): void => {
    menu.classList.toggle('open', open);
    button.setAttribute('aria-expanded', String(open));
  };
  button.addEventListener('click', () => setOpen(!menu.classList.contains('open')));
  menu.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).closest('button')) setOpen(false);
  });
  document.addEventListener('pointerdown', (e) => {
    const target = e.target as Node;
    if (menu.classList.contains('open') && !menu.contains(target) && !button.contains(target)) setOpen(false);
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && menu.classList.contains('open')) {
      setOpen(false);
      button.focus();
    }
  });
}

let tabbing = false;

/**
 * Whether focus was last moved with the keyboard (Tab), not the pointer.
 *
 * `:focus-visible` cannot answer this for a key handler: the moment a key is
 * pressed, the browser starts treating the focused element as keyboard
 * focused, so a button merely clicked with the mouse already matches it by
 * the time the keydown arrives.
 */
export function focusCameFromKeyboard(): boolean {
  return tabbing;
}

function trackFocusModality(): void {
  window.addEventListener('keydown', (e) => { if (e.key === 'Tab') tabbing = true; }, true);
  window.addEventListener('pointerdown', () => { tabbing = false; }, true);
}

/** Wires the interface shell. Call once, after the markup exists. */
export function initChrome(onLayout: () => void): void {
  trackFocusModality();
  initPanels(onLayout);
  initMoreMenu();
  keepActiveToolVisible();
}
