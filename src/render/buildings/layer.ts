import { Group } from 'three';

import { pointInPolygon } from '@core/polygon';
import type { Vec2 } from '@core/vec2';
import type { RoadDoc } from '@world/doc';
import type { GroundAt } from '@world/buildings/foundation';
import { footprintRects } from '@world/buildings/geometry';
import type { Building, BuildingId } from '@world/buildings/types';
import { m } from '@world/units';
import { type BuildingMeshes, buildBuildingMeshes } from './buildingMesh';
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
}

export interface BuildingLayer {
  readonly group: Group;
  readonly triangles: number;
  /** Bumped whenever the stored buildings are rebuilt. */
  readonly version: number;
  /** Rebuilds what is stale. Returns true if the stored buildings were rebuilt. */
  update(doc: RoadDoc, groundAt: GroundAt, groundKey: string): boolean;
  setPreview(preview: BuildingPreviewInput | null): void;
  /** Whether a world point is under a building (for the scenery's plant cull). */
  covers(x: number, y: number): boolean;
  dispose(): void;
}

/** How far past a wall a plant is still considered under the building. */
const PLANT_MARGIN = m(1.2);
const CELL = 64;

export function createBuildingLayer(): BuildingLayer {
  const kit: BuildingKit = createBuildingKit();
  const group = new Group();
  group.name = 'buildings-layer';
  let stored: BuildingMeshes | null = null;
  let ghost: BuildingMeshes | null = null;
  let storedKey = '';
  let ghostKey = '';
  let preview: BuildingPreviewInput | null = null;
  let version = 0;
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
    update(doc, groundAt, groundKey) {
      const hides = preview?.hides ?? null;
      const key = `${doc.buildings.revision}|${groundKey}|${hides}`;
      let rebuilt = false;
      if (key !== storedKey) {
        storedKey = key;
        if (stored) {
          group.remove(stored.group);
          stored.dispose();
        }
        const shown = [...doc.buildings.all()].filter((b) => b.id !== hides);
        stored = buildBuildingMeshes(shown, groundAt, kit);
        group.add(stored.group);
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
          kit.setGhostValid(preview.valid);
          ghost = buildBuildingMeshes([preview.building], groundAt, kit, true);
          ghost.group.renderOrder = 2;
          group.add(ghost.group);
        }
      }
      return rebuilt;
    },
    setPreview(next) {
      preview = next;
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
