import { Group } from 'three';

import { pointInPolygon } from '@core/polygon';
import type { Vec2 } from '@core/vec2';
import type { RoadDoc } from '@world/doc';
import type { GroundAt, PavedAt } from '@world/buildings/foundation';
import { buildingBounds, footprintRects } from '@world/buildings/geometry';
import type { Building, BuildingId } from '@world/buildings/types';
import { m } from '@world/units';
import { cutOpen } from '@world/buildings/interior';
import { type BuildingChunk, type BuildingMeshes, assembleBuildingMeshes, buildBuildingMeshes, emitChunk } from './buildingMesh';
import { type BuildingKit, createBuildingKit } from './kit';

/**
 * The buildings layer: the stored buildings and the editor's preview, each
 * rebuilt only when what it depends on moves (AGENTS.md section 4).
 *
 * The stored buildings depend on `doc.buildings.revision`, on the ground
 * (`groundKey`: the terrain revision and the renderer's world rebuild count,
 * because shaping the terrain to the roads moves it too) and on which one the
 * preview is standing in for. The preview depends on its own serial.
 */
export interface BuildingPreviewInput {
  readonly building: Building;
  readonly valid: boolean;
  readonly hides: BuildingId | null;
  readonly serial: number;
  /** Drawn in the building's own materials, not as a ghost (the interior view). */
  readonly solid?: boolean;
}

export interface BuildingLayer {
  readonly group: Group;
  readonly triangles: number;
  /** Bumped whenever the stored buildings are rebuilt. */
  readonly version: number;
  /**
   * Rebuilds what is stale. Returns true if the stored buildings were rebuilt.
   * `pavedAt` is the paving (footways, carriageways) entrances open onto.
   */
  update(doc: RoadDoc, groundAt: GroundAt, groundKey: string, pavedAt?: PavedAt): boolean;
  setPreview(preview: BuildingPreviewInput | null): void;
  /**
   * "See inside": every building within `radius` of (x, y) is drawn cut open
   * at `level`, its rooms and furniture showing; null draws them whole.
   */
  setCutaway(spec: CutawaySpec | null): void;
  /**
   * "Ocultar outros": undefined draws every building solid, null fades them
   * all, and an id fades every building but that one.
   */
  setDimmed(except: BuildingId | null | undefined): void;
  /** Whether a world point is under a building (for the scenery's plant cull). */
  covers(x: number, y: number): boolean;
  dispose(): void;
}

export interface CutawaySpec {
  readonly level: number;
  /** The way the camera looks, world and horizontal: the walls facing it come down. */
  readonly view: { readonly x: number; readonly y: number };
  readonly x: number;
  readonly y: number;
  readonly radius: number;
}

/** How far past a wall a plant is still considered under the building. */
const PLANT_MARGIN = m(2.5);
const CELL = 64;

export function createBuildingLayer(): BuildingLayer {
  const kit: BuildingKit = createBuildingKit();
  const group = new Group();
  group.name = 'buildings-layer';
  let stored: BuildingMeshes | null = null;
  let faded: BuildingMeshes | null = null;
  let dimmed: BuildingId | null | undefined = undefined;
  let ghost: BuildingMeshes | null = null;
  let storedKey = '';
  let ghostKey = '';
  let preview: BuildingPreviewInput | null = null;
  let cutaway: CutawaySpec | null = null;
  let version = 0;
  /** The buildings drawn cut open, by id and floor: only those near the camera, kept while they stay. */
  const cutChunks = new Map<string, { key: string; chunk: BuildingChunk }>();
  const cutChunkFor = (b: Building, level: number, groundAt: GroundAt, pavedAt?: PavedAt): BuildingChunk => {
    const dir = cutaway ? Math.round(Math.atan2(cutaway.view.y, cutaway.view.x) / (Math.PI / 4)) : 0;
    const id = `${b.id}|${level}|${dir}`;
    const key = `${JSON.stringify(b)}|${groundDigest(b, groundAt, pavedAt)}`;
    const known = cutChunks.get(id);
    if (known && known.key === key) return known.chunk;
    // The view snapped to eighths of a turn: the walls that come down change
    // only when the camera has really turned.
    const a = dir * (Math.PI / 4);
    const chunk = emitChunk(cutOpen(b, level, { x: Math.cos(a), y: Math.sin(a) }), groundAt, pavedAt);
    cutChunks.set(id, { key, chunk });
    return chunk;
  };
  const near = (b: Building): boolean => {
    if (!cutaway) return false;
    const box = buildingBounds(b);
    const dx = Math.max(box.minX - cutaway.x, 0, cutaway.x - box.maxX);
    const dy = Math.max(box.minY - cutaway.y, 0, cutaway.y - box.maxY);
    return Math.hypot(dx, dy) <= cutaway.radius;
  };
  const drawn = (b: Building, groundAt: GroundAt, pavedAt?: PavedAt): BuildingChunk =>
    cutaway && near(b) ? cutChunkFor(b, cutaway.level, groundAt, pavedAt) : chunkFor(b, groundAt, pavedAt);
  /**
   * Each building's emitted meshes, keyed by its record and by the ground
   * around it: an edit re-emits one building, a terrain dab only the ones
   * whose ground it moved; everything else is concatenated from here.
   */
  const chunks = new Map<BuildingId, { key: string; chunk: BuildingChunk }>();
  const chunkFor = (b: Building, groundAt: GroundAt, pavedAt?: PavedAt): BuildingChunk => {
    const key = `${JSON.stringify(b)}|${groundDigest(b, groundAt, pavedAt)}`;
    const known = chunks.get(b.id);
    if (known && known.key === key) return known.chunk;
    const chunk = emitChunk(b, groundAt, pavedAt);
    chunks.set(b.id, { key, chunk });
    return chunk;
  };
  /** Footprints bucketed on a coarse grid, for `covers`. */
  let buckets = new Map<string, Vec2[][]>();

  const index = (buildings: Iterable<Building>): void => {
    buckets = new Map();
    for (const b of buildings) {
      for (const rect of footprintRects(b, PLANT_MARGIN)) {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const p of rect) {
          minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
          maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
        }
        for (let i = Math.floor(minX / CELL); i <= Math.floor(maxX / CELL); i++) {
          for (let j = Math.floor(minY / CELL); j <= Math.floor(maxY / CELL); j++) {
            const key = `${i},${j}`;
            const list = buckets.get(key);
            if (list) list.push(rect);
            else buckets.set(key, [rect]);
          }
        }
      }
    }
  };

  return {
    group,
    get triangles() {
      return (stored?.triangles ?? 0) + (ghost?.triangles ?? 0);
    },
    get version() {
      return version;
    },
    update(doc, groundAt, groundKey, pavedAt) {
      const hides = preview?.hides ?? null;
      const dimKey = dimmed === undefined ? 'off' : String(dimmed ?? 'all');
      const cutKey = cutaway
        ? `${cutaway.level}@${Math.round(cutaway.x)},${Math.round(cutaway.y)}/${Math.round(Math.atan2(cutaway.view.y, cutaway.view.x) / (Math.PI / 4))}`
        : 'whole';
      const key = `${doc.buildings.revision}|${groundKey}|${hides}|${dimKey}|${cutKey}`;
      let rebuilt = false;
      if (key !== storedKey) {
        storedKey = key;
        for (const batch of [stored, faded]) {
          if (!batch) continue;
          group.remove(batch.group);
          batch.dispose();
        }
        const shown = [...doc.buildings.all()].filter((b) => b.id !== hides);
        for (const id of chunks.keys()) if (!doc.buildings.has(id)) chunks.delete(id);
        const solid = dimmed === undefined ? shown : shown.filter((b) => b.id === dimmed);
        const others = dimmed === undefined ? [] : shown.filter((b) => b.id !== dimmed);
        if (cutChunks.size > 64) cutChunks.clear();
        stored = assembleBuildingMeshes(solid.map((b) => drawn(b, groundAt, pavedAt)), kit);
        group.add(stored.group);
        faded = others.length > 0
          ? assembleBuildingMeshes(others.map((b) => drawn(b, groundAt, pavedAt)), kit, false, true)
          : null;
        if (faded) {
          faded.group.renderOrder = 1;
          group.add(faded.group);
        }
        index(doc.buildings.all());
        version++;
        rebuilt = true;
      }
      const wanted = preview ? `${preview.serial}|${groundKey}` : '';
      if (wanted !== ghostKey) {
        ghostKey = wanted;
        if (ghost) {
          group.remove(ghost.group);
          ghost.dispose();
          ghost = null;
        }
        if (preview) {
          if (!preview.solid) kit.setGhostValid(preview.valid);
          ghost = buildBuildingMeshes([preview.building], groundAt, kit, !preview.solid, pavedAt);
          ghost.group.renderOrder = 2;
          group.add(ghost.group);
        }
      }
      return rebuilt;
    },
    setDimmed(except) {
      dimmed = except;
    },
    setPreview(next) {
      preview = next;
    },
    setCutaway(next) {
      cutaway = next;
    },
    covers(x, y) {
      const list = buckets.get(`${Math.floor(x / CELL)},${Math.floor(y / CELL)}`);
      if (!list) return false;
      const p = { x, y };
      for (const rect of list) if (pointInPolygon(p, rect)) return true;
      return false;
    },
    dispose() {
      stored?.dispose();
      ghost?.dispose();
      kit.dispose();
      group.clear();
    },
  };
}

/**
 * A fingerprint of the ground under and around a building: a 6 x 6 grid over
 * its bounds grown by two modules (the entrance steps land out there), of the
 * land and of the paving. Any change the foundation could see changes this.
 */
function groundDigest(b: Building, groundAt: GroundAt, pavedAt?: PavedAt): string {
  const box = buildingBounds(b, b.module * 2);
  let out = '';
  for (let i = 0; i <= 5; i++) {
    for (let j = 0; j <= 5; j++) {
      const x = box.minX + ((box.maxX - box.minX) * i) / 5;
      const y = box.minY + ((box.maxY - box.minY) * j) / 5;
      out += `${groundAt(x, y).toFixed(2)}${pavedAt ? `/${pavedAt(x, y).toFixed(2)}` : ''},`;
    }
  }
  return out;
}