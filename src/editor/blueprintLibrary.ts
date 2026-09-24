import type { Blueprint, BlueprintBody } from '@world/buildings/blueprints';
import { migrateBuilding } from '@world/buildings/serialize';

/**
 * The player's own blueprints: a building saved from the map, reusable on any
 * map. Kept in `localStorage`, beside the autosave, and read through the same
 * `migrateBuilding` door as every stored building, so a blueprint written by
 * an older build loads repaired rather than not at all.
 *
 * Every storage call is guarded: a private window or blocked storage makes the
 * library empty and read-only, never a crash.
 */
const KEY = 'roadcraft.blueprints.v1';
const LIMIT = 48;

interface StoredBlueprint {
  readonly key: string;
  readonly name: string;
  readonly body: unknown;
}

export class BlueprintLibrary {
  constructor(private readonly storageKey = KEY) {}

  list(): Blueprint[] {
    let raw: string | null;
    try {
      raw = localStorage.getItem(this.storageKey);
    } catch {
      return [];
    }
    if (!raw) return [];
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      const out: Blueprint[] = [];
      for (const entry of parsed as StoredBlueprint[]) {
        if (!entry || typeof entry.key !== 'string' || typeof entry.name !== 'string') continue;
        const body = readBody(entry.body);
        if (body) out.push({ key: entry.key, name: entry.name, body });
      }
      return out;
    } catch {
      return [];
    }
  }

  /** Saves a body under a name; returns the stored blueprint, or null. */
  save(name: string, body: BlueprintBody): Blueprint | null {
    const list = this.list();
    const key = `user-${Date.now().toString(36)}-${list.length}`;
    const entry: Blueprint = { key, name: name.trim().slice(0, 40) || 'Blueprint', body };
    const next = [entry, ...list].slice(0, LIMIT);
    try {
      localStorage.setItem(this.storageKey, JSON.stringify(next.map((b) => ({ key: b.key, name: b.name, body: b.body }))));
      return entry;
    } catch {
      return null;
    }
  }

  remove(key: string): void {
    const next = this.list().filter((b) => b.key !== key);
    try {
      localStorage.setItem(this.storageKey, JSON.stringify(next.map((b) => ({ key: b.key, name: b.name, body: b.body }))));
    } catch {
      /* read-only storage: nothing to remove from */
    }
  }
}

/** A stored body, repaired through `migrateBuilding` (placement fields are dummies). */
function readBody(raw: unknown): BlueprintBody | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const building = migrateBuilding({ ...(raw as object), id: 1, x: 0, y: 0, rotation: 0 });
  if (!building) return null;
  const body = JSON.parse(JSON.stringify(building)) as Record<string, unknown>;
  for (const key of ['id', 'x', 'y', 'rotation']) delete body[key];
  return body as unknown as BlueprintBody;
}
