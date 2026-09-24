import { IdAllocator } from '../ids';
import { migrateBuilding, type SerializedBuilding } from './serialize';
import { type Building, type BuildingId, asBuildingId, cloneBuilding } from './types';

/**
 * The document's buildings, with their own revision clock.
 *
 * `revision` is deliberately NOT the document's: a building edit must not
 * rebuild the road network, the lanelets or the simulation, which is what
 * moving `RoadDoc.revision` does. The renderer gates the buildings layer on
 * this number (and on the terrain, which the foundations stand on).
 */
export class BuildingStore {
  private readonly items = new Map<BuildingId, Building>();
  private ids = new IdAllocator(1);
  revision = 0;

  get size(): number {
    return this.items.size;
  }

  get(id: BuildingId): Building | undefined {
    return this.items.get(id);
  }

  has(id: BuildingId): boolean {
    return this.items.has(id);
  }

  all(): IterableIterator<Building> {
    return this.items.values();
  }

  /** The id the next `add` will hand out. */
  get nextId(): BuildingId {
    return asBuildingId(this.ids.peek);
  }

  /** Stores a new building under a fresh id. The record is copied. */
  add(value: Omit<Building, 'id'>): Building {
    const id = asBuildingId(this.ids.take());
    const building = { ...cloneBuilding(value as Building), id } as Building;
    this.items.set(id, building);
    this.revision++;
    return building;
  }

  /** Replaces an existing building's record (same id). */
  put(building: Building): void {
    if (!this.items.has(building.id)) return;
    this.items.set(building.id, cloneBuilding(building));
    this.revision++;
  }

  remove(id: BuildingId): boolean {
    if (!this.items.delete(id)) return false;
    this.revision++;
    return true;
  }

  clear(): void {
    if (this.items.size === 0) return;
    this.items.clear();
    this.revision++;
  }

  toJSON(): SerializedBuilding[] {
    return [...this.items.values()].map((b) => cloneBuilding(b));
  }

  /** Loads stored buildings, repairing or dropping what cannot be read. */
  load(data: readonly unknown[] | undefined): void {
    this.items.clear();
    for (const raw of data ?? []) {
      const building = migrateBuilding(raw);
      if (!building || this.items.has(building.id)) continue;
      this.items.set(building.id, building);
      this.ids.reserve(building.id);
    }
    this.revision++;
  }

  /** Keeps id allocation monotonic across a clone (see `RoadDoc.clone`). */
  copyAllocator(from: BuildingStore): void {
    this.ids = new IdAllocator(Math.max(this.ids.peek, from.ids.peek));
  }

  /**
   * Replaces the contents from another store, moving the revision only when
   * the buildings actually differ. Drawing a road replaces the whole
   * document with an edited clone; that must not rebuild every building.
   */
  replaceWith(source: BuildingStore): void {
    this.ids = new IdAllocator(Math.max(this.ids.peek, source.ids.peek));
    if (JSON.stringify(this.toJSON()) === JSON.stringify(source.toJSON())) return;
    this.items.clear();
    for (const b of source.items.values()) this.items.set(b.id, cloneBuilding(b));
    this.revision++;
  }
}
