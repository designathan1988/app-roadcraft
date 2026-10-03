import { RoadDoc, type JunctionControl, type SegmentDirection, type SerializedDoc } from '@world/doc';
import { ROAD_TYPES } from '@world/roadTypes';
import { normalizeRoadSection } from '@world/roadSection';
import { migrateStructure } from '@world/structures';
import { isTerrainMode } from '@world/terrain';
import { isSerializedBuildings } from '@world/buildings/serialize';

const KEY = 'roadcraft.world.v7';
/** Where storage the loader could not read is kept, rather than deleted. */
export const QUARANTINE_KEY = 'roadcraft.world.v7.unreadable';
const DEBOUNCE_MS = 700;
/**
 * The camera and simulation settings, on their own. They share the map's
 * entry too (older builds read them there), but a pan, a zoom or a speed change
 * writes only this small key: each one used to serialise the whole map.
 */
const SETTINGS_KEY = 'roadcraft.settings.v1';

export interface SavedSettings {
  readonly camera: {
    readonly x: number;
    readonly y: number;
    readonly zoom: number;
    /** The free camera's bearing and tilt, rad. Absent in saves older than the orbit. */
    readonly azimuth?: number;
    readonly elevation?: number;
  };
  readonly paused: boolean;
  readonly speed: number;
  readonly trafficIntensity: number;
  readonly pedestrianIntensity: number;
  readonly demandMultiplier?: number;
  readonly congestionOverlay: boolean;
}

export interface SavedSession {
  readonly document: SerializedDoc;
  readonly settings: SavedSettings;
}

interface SerializedSession extends SavedSession {
  readonly version: 2;
}

/**
 * Autosave and file export.
 *
 * The V6 monolith had no persistence at all — not a single `localStorage` call
 * in 1133 lines — so every reload dropped the entire map (defect 5.9). Only the
 * authoring document is stored; everything else is derived.
 */
export class Persistence {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pending: (() => void) | null = null;

  /**
   * Called when a write fails (storage full or refused). The autosave used to
   * fail in silence and the next reload lost everything since the last write
   * that worked.
   */
  onSaveFailed: (() => void) | null = null;

  constructor(private readonly storageKey = KEY) {}

  /**
   * Set once this instance has rejected the stored entry.
   *
   * It exists so that KEEPING unreadable bytes on disk costs nothing: the
   * loader answers from memory instead of parsing them again. That is what
   * lets `quarantine` refuse to delete anything it could not copy.
   *
   * On the instance rather than the module because the app holds exactly one
   * `Persistence`, so the lifetime is identical — while a module-level flag
   * would leak between every instance in the same process, which is both wrong
   * and untestable.
   */
  private rejected = false;

  /**
   * Stores the document, keeping whatever settings are already saved.
   *
   * This and `saveSession` write to the SAME key, so a bare-document write used
   * to silently discard the user's camera, speed and traffic settings. Reading
   * the current settings back first makes the two writers compatible instead of
   * competing.
   */
  save(doc: RoadDoc): boolean {
    return this.saveSession(doc, this.loadSession()?.settings ?? defaultSettings());
  }

  /** Coalesces rapid edits into one write. */
  saveSoon(doc: RoadDoc): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.save(doc);
    }, DEBOUNCE_MS);
  }

  saveSession(doc: RoadDoc, settings: SavedSettings): boolean {
    try {
      localStorage.setItem(this.storageKey, JSON.stringify({ version: 2, document: doc.toJSON(), settings }));
      this.writeSettings(settings);
      return true;
    } catch {
      this.onSaveFailed?.();
      return false;
    }
  }

  saveSessionSoon(doc: RoadDoc, settings: () => SavedSettings): void {
    if (this.timer) clearTimeout(this.timer);
    this.pending = () => this.saveSession(doc, settings());
    this.timer = setTimeout(() => this.flush(), DEBOUNCE_MS);
  }

  private settingsTimer: ReturnType<typeof setTimeout> | null = null;

  /** Stores the camera and simulation settings alone, coalescing rapid changes. */
  saveSettingsSoon(settings: () => SavedSettings): void {
    if (this.settingsTimer) clearTimeout(this.settingsTimer);
    this.pendingSettings = settings;
    this.settingsTimer = setTimeout(() => this.flushSettings(), DEBOUNCE_MS);
  }

  private pendingSettings: (() => SavedSettings) | null = null;

  private flushSettings(): void {
    if (this.settingsTimer) clearTimeout(this.settingsTimer);
    this.settingsTimer = null;
    const pending = this.pendingSettings;
    this.pendingSettings = null;
    if (pending) this.writeSettings(pending());
  }

  private writeSettings(settings: SavedSettings): void {
    if (this.storageKey !== KEY) return;
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch {
      /* Settings are a convenience; the map's own entry still carries them. */
    }
  }

  /** The separately stored settings, when present and readable. */
  private readSettings(): SavedSettings | null {
    if (this.storageKey !== KEY) return null;
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      if (!raw) return null;
      const parsed: unknown = JSON.parse(raw);
      return isSavedSettings(parsed) ? normalizeSettings(parsed) : null;
    } catch {
      return null;
    }
  }

  /**
   * Writes a debounced save now. The page calls it when it is hidden or torn
   * down: a phone or a background tab discarded without `beforeunload` used to
   * lose the last 700 ms of edits.
   */
  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const pending = this.pending;
    this.pending = null;
    pending?.();
    this.flushSettings();
  }

  load(): SerializedDoc | null {
    return this.loadSession()?.document ?? null;
  }

  /**
   * Reads the autosave. Never throws, whatever storage does.
   *
   * `localStorage.getItem` can throw outright — Safari private mode, blocked
   * cookies, a sandboxed frame — and not just on write. The previous shape put
   * the read inside a `try` whose `catch` called `getItem` a SECOND time, so a
   * hostile storage threw again from inside the handler and the exception
   * escaped, taking the whole boot with it. Every storage call now sits in its
   * own guard, and nothing in the recovery path touches storage again.
   */
  loadSession(): SavedSession | null {
    // Already rejected once in this page's lifetime. The bytes may still be on
    // disk — deliberately, so nothing the user made is destroyed — but there is
    // nothing to gain from parsing them again.
    if (this.rejected) return null;

    let raw: string | null;
    try {
      raw = localStorage.getItem(this.storageKey);
    } catch {
      return null;
    }
    if (!raw) return null;

    try {
      const parsed: unknown = JSON.parse(raw);
      if (isSerializedDoc(parsed)) return { document: parsed, settings: defaultSettings() };
      if (isSavedSession(parsed)) {
        return { document: parsed.document, settings: this.readSettings() ?? normalizeSettings(parsed.settings) };
      }
    } catch {
      // Unparseable. Fall through and set it aside rather than reread it.
    }

    this.rejected = true;
    quarantine(
      raw,
      this.storageKey,
      this.storageKey === KEY ? QUARANTINE_KEY : `${this.storageKey}.unreadable`,
    );
    return null;
  }

  /**
   * Sets the stored map aside after it passed validation but failed to load
   * (the loader threw). Without this a map that validates and then crashes
   * `fromJSON` was re-read, and crashed the boot, on every reload.
   */
  quarantineStored(): void {
    this.rejected = true;
    let raw: string | null;
    try {
      raw = localStorage.getItem(this.storageKey);
    } catch {
      return;
    }
    quarantine(raw, this.storageKey, this.storageKey === KEY ? QUARANTINE_KEY : `${this.storageKey}.unreadable`);
  }

  clear(): void {
    try {
      localStorage.removeItem(this.storageKey);
    } catch {
      /* ignore */
    }
  }
}

/**
 * Sets unreadable storage aside — and never destroys it to do so.
 *
 * Three shapes of this function have been wrong. Deleting outright lost the
 * user's map on any schema bump. Copy-then-delete in one `try` meant a full
 * quota skipped the delete, so the bad entry was re-read on every boot. Two
 * independent guards fixed the loop but reintroduced the data loss: the copy
 * failed, the delete ran anyway, and zero bytes survived.
 *
 * Quarantining doubles the stored bytes, so any map past roughly half the quota
 * can never be copied — and a quota-truncated write is one of the causes of
 * unreadability in the first place. So the removal is now conditional on the
 * copy, and the boot loop is prevented in memory rather than by deletion.
 * Nothing the user made is ever thrown away to keep the loader quiet.
 */
function quarantine(raw: string | null, sourceKey = KEY, quarantineKey = QUARANTINE_KEY): void {
  if (!raw) return;

  try {
    localStorage.setItem(quarantineKey, raw);
  } catch {
    // No room for a copy. Leave the original exactly where it is: the session
    // flag above already stops it being re-read, and a later save will replace
    // it. Losing someone's map to make room for a copy of that same map is not
    // a trade worth making.
    return;
  }

  try {
    localStorage.removeItem(sourceKey);
  } catch {
    /* The copy is safe; the original merely lingers. */
  }
}

/** The speeds the Simulation menu offers; anything else was never chosen there. */
const SPEEDS = [1, 2, 4];
/** The demand levels the menu offers. */
const DEMANDS = [0.55, 1, 1.55];

/**
 * Settings as the controls can show them. A file could carry any finite
 * number: a negative speed froze the simulation while it read as playing,
 * with no speed button lit.
 */
export function normalizeSettings(settings: SavedSettings): SavedSettings {
  const intensity = (value: number): number => Math.min(2, Math.max(0, value));
  const demand = settings.demandMultiplier;
  return {
    ...settings,
    speed: SPEEDS.includes(settings.speed) ? settings.speed : 1,
    trafficIntensity: intensity(settings.trafficIntensity),
    pedestrianIntensity: intensity(settings.pedestrianIntensity),
    ...(demand === undefined ? {} : { demandMultiplier: DEMANDS.reduce((best, d) => Math.abs(d - demand) < Math.abs(best - demand) ? d : best, 1) }),
  };
}

function defaultSettings(): SavedSettings {
  return { camera: { x: 0, y: 0, zoom: 1 }, paused: false, speed: 1, trafficIntensity: 1, pedestrianIntensity: 1, congestionOverlay: false };
}

function isSavedSession(value: unknown): value is SavedSession {
  if (!isRecord(value) || value.version !== 2 || !isSerializedDoc(value.document)) return false;
  return isSavedSettings(value.settings);
}

function isSavedSettings(settings: unknown): settings is SavedSettings {
  if (!isRecord(settings)) return false;
  const camera = settings.camera;
  return isRecord(camera) && isFiniteNumber(camera.x) && isFiniteNumber(camera.y) && isFiniteNumber(camera.zoom) &&
    (camera.azimuth === undefined || isFiniteNumber(camera.azimuth)) &&
    (camera.elevation === undefined || isFiniteNumber(camera.elevation)) &&
    typeof settings.paused === 'boolean' && isFiniteNumber(settings.speed) && isFiniteNumber(settings.trafficIntensity) &&
    isFiniteNumber(settings.pedestrianIntensity) && (settings.demandMultiplier === undefined || isFiniteNumber(settings.demandMultiplier)) &&
    typeof settings.congestionOverlay === 'boolean';
}

/** Offers the current map as a downloadable JSON file. */
export function exportToFile(
  doc: RoadDoc,
  settings?: SavedSettings,
  filename = 'roadcraft-map.json',
): void {
  const saved: SerializedSession | SerializedDoc = settings
    ? { version: 2, document: doc.toJSON(), settings }
    : doc.toJSON();
  const blob = new Blob([JSON.stringify(saved, null, 2)], {
    type: 'application/json',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  // Revoked a moment later: revoking synchronously can cancel the download
  // before Firefox or Safari has started it.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** What a file pick came to: a map, nothing chosen, or a file that is not one. */
export type ImportResult =
  | { readonly status: 'ok'; readonly session: SavedSession }
  | { readonly status: 'cancelled' }
  | { readonly status: 'invalid' };

/**
 * Reads a map file chosen by the user. A bad file and a cancelled dialog used
 * to both come back as `null`, so a file that was not a map did nothing at
 * all, with no word to the player.
 */
export async function importFromFile(): Promise<ImportResult> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json,.json';
    let settled = false;
    const finish = (value: ImportResult): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) {
        finish({ status: 'cancelled' });
        return;
      }
      try {
        const parsed: unknown = JSON.parse(await file.text());
        const session = readImportedSession(parsed);
        finish(session ? { status: 'ok', session } : { status: 'invalid' });
      } catch {
        finish({ status: 'invalid' });
      }
    };
    input.oncancel = () => finish({ status: 'cancelled' });
    // Browsers without a `cancel` event: the window regains focus when the
    // dialog closes; a pick that has not arrived shortly after is a cancel.
    window.addEventListener('focus', () => {
      setTimeout(() => { if (!input.files?.length) finish({ status: 'cancelled' }); }, 1000);
    }, { once: true });
    input.click();
  });
}

/** Accepts legacy geometry-only files while preserving complete session files. */
function readImportedSession(value: unknown): SavedSession | null {
  if (isSerializedDoc(value)) return { document: value, settings: defaultSettings() };
  return isSavedSession(value) ? { document: value.document, settings: normalizeSettings(value.settings) } : null;
}

/** Strict boundary validation for local storage and imported files. */
export function isSerializedDoc(value: unknown): value is SerializedDoc {
  if (!isRecord(value) || value.version !== 1) return false;
  if (!Array.isArray(value.nodes) || !Array.isArray(value.segments)) return false;

  const nodeIds = new Set<number>();
  for (const node of value.nodes) {
    if (!isRecord(node)) return false;
    if (!isId(node.id) || nodeIds.has(node.id)) return false;
    if (!isFiniteNumber(node.x) || !isFiniteNumber(node.y)) return false;
    if (node.heightOffset !== undefined && !isFiniteNumber(node.heightOffset)) return false;
    if (node.smooth !== undefined && typeof node.smooth !== 'boolean') return false;
    if (node.control !== undefined && !isJunctionControl(node.control)) return false;
    if (node.blockedMovements !== undefined && (!Array.isArray(node.blockedMovements) ||
      node.blockedMovements.some((movement) => typeof movement !== 'string'))) return false;
    nodeIds.add(node.id);
  }

  const segmentIds = new Set<number>();
  for (const segment of value.segments) {
    if (!isRecord(segment)) return false;
    if (!isId(segment.id) || segmentIds.has(segment.id)) return false;
    if (!isId(segment.a) || !isId(segment.b) || segment.a === segment.b) return false;
    if (!nodeIds.has(segment.a) || !nodeIds.has(segment.b)) return false;
    if (
      typeof segment.type !== 'number' ||
      !Number.isInteger(segment.type) ||
      segment.type < 0 ||
      segment.type >= ROAD_TYPES.length
    ) {
      return false;
    }
    if (segment.dashOrigin !== undefined && !isFiniteNumber(segment.dashOrigin)) return false;
    if (segment.direction !== undefined && !isSegmentDirection(segment.direction)) return false;
    if (segment.section !== undefined && !normalizeRoadSection(segment.section)) return false;
    if (segment.structure !== undefined && migrateStructure(segment.structure) === null) return false;
    if (segment.lanes !== undefined && segment.lanes !== null &&
      (!isFiniteNumber(segment.lanes) || !Number.isInteger(segment.lanes) || segment.lanes < 1 || segment.lanes > 8)) return false;
    if (segment.curve !== null) {
      if (!isRecord(segment.curve)) return false;
      if (!isFiniteNumber(segment.curve.t) || !isFiniteNumber(segment.curve.h)) return false;
    }
    segmentIds.add(segment.id);
  }

  if (value.terrain !== undefined) {
    if (!Array.isArray(value.terrain)) return false;
    const terrainIds = new Set<number>();
    for (const stamp of value.terrain) {
      if (!isRecord(stamp) || !isId(stamp.id) || terrainIds.has(stamp.id)) return false;
      if (!isFiniteNumber(stamp.x) || !isFiniteNumber(stamp.y) ||
        !isFiniteNumber(stamp.radius) || stamp.radius <= 0 || stamp.radius > MAX_STAMP_RADIUS ||
        (stamp.level !== undefined && !isFiniteNumber(stamp.level)) ||
        (stamp.stroke !== undefined && !isId(stamp.stroke)) ||
        !isFiniteNumber(stamp.strength) || stamp.strength < 0 ||
        !isTerrainMode(stamp.mode)) return false;
      terrainIds.add(stamp.id);
    }
  }

  // Poles and spans. Never checked before: `poles: {}` passed, then threw
  // 'not iterable' in `fromJSON` - at boot, at module top level, after the
  // entry had already been accepted, so it was never quarantined and every
  // reload crashed the same way.
  const poleIds = new Set<number>();
  if (value.poles !== undefined) {
    if (!Array.isArray(value.poles)) return false;
    for (const pole of value.poles) {
      if (!isRecord(pole) || !isId(pole.id) || poleIds.has(pole.id)) return false;
      if (!isFiniteNumber(pole.x) || !isFiniteNumber(pole.y)) return false;
      if (pole.lamp !== undefined && typeof pole.lamp !== 'boolean') return false;
      poleIds.add(pole.id);
    }
  }
  if (value.poleSpans !== undefined) {
    if (!Array.isArray(value.poleSpans)) return false;
    const spanIds = new Set<number>();
    for (const span of value.poleSpans) {
      if (!isRecord(span) || !isId(span.id) || spanIds.has(span.id)) return false;
      if (!isId(span.a) || !isId(span.b) || span.a === span.b) return false;
      if (!poleIds.has(span.a) || !poleIds.has(span.b)) return false;
      spanIds.add(span.id);
    }
  }

  // Buildings: the list itself must be a list. Each record is then repaired
  // or dropped one by one by `migrateBuilding` on load, so a damaged building
  // never quarantines the roads around it.
  if (!isSerializedBuildings(value.buildings)) return false;
  // People are normalised one by one on load; the key only has to be a list.
  if (value.people !== undefined && !Array.isArray(value.people)) return false;

  return true;
}

function isJunctionControl(value: unknown): value is JunctionControl {
  return value === 'auto' || value === 'signal' || value === 'stop' || value === 'yield' || value === 'priority' || value === 'none';
}

function isSegmentDirection(value: unknown): value is SegmentDirection {
  return value === 'both' || value === 'aToB' || value === 'bToA';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Ids stay far below 2^53: an allocator reserved past it stops counting
 * (2^53 + 1 === 2^53) and every new node overwrites the last one.
 */
const MAX_ID = 2 ** 31;
/**
 * The widest stamp a map may hold: the map itself (4 800 units across). It was
 * 180, the Radius slider's old maximum - the slider now reaches 300 and the
 * town the game opens on is shaped by stamps up to 1 400 wide, so every map
 * holding either was refused on reload and put in quarantine.
 */
const MAX_STAMP_RADIUS = 4_800;

function isId(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) > 0 && (value as number) <= MAX_ID;
}

export { RoadDoc };
