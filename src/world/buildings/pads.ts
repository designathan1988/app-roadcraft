import type { Aabb } from '@core/aabb';
import type { Vec2 } from '@core/vec2';
import { m } from '../units';
import { type GroundAt, type PavedAt, PLINTH_MIN, floorHeight } from './foundation';
import { solidFootprints } from './geometry';
import { lotSurfaces } from './lots';
import type { Building } from './types';

/**
 * The ground graded to every building: a level platform under it, and a bank
 * at about one in three and a half from its edge back to the land - gentle
 * enough to stay grassed rather than bare soil.
 *
 * This is what a site on a slope actually gets, and what city builders do: the
 * TERRAIN is cut and filled, so the building stands on level ground and the
 * land meets it as a grassed slope. The old answer drew the difference as part
 * of the building - a stone plinth wall on the low side, with flights of steps
 * down it - which is what a builder does only where there is no room for a bank.
 *
 * The platform stands at the floor less the plinth, and the floor is worked out
 * on the NATURAL ground. Drawn on the graded ground, the same rule finds the
 * platform under the whole footprint and puts the floor back where it was: the
 * grading never feeds on itself.
 */

/** Slope of the bank: horizontal run per unit of height. */
export const PAD_BATTER = 3.5;
/** Furthest a bank may reach from its platform. */
const PAD_REACH = m(40);

interface Pad {
  readonly rings: readonly (readonly Vec2[])[];
  /** The platform's height under each ring, at a point (a car park falls with its street). */
  readonly levels: readonly ((x: number, y: number) => number)[];
  readonly box: Aabb;
}

export interface BuildingPads {
  /** The graded height at a point, and how fully it replaces the land (0 or 1). */
  shapeAt(x: number, y: number, naturalGround: number): { height: number; weight: number };
  shapeBounds(): readonly Aabb[];
  readonly count: number;
}

/** Distance from a point to a closed ring: 0 inside it. */
function ringDistance(ring: readonly Vec2[], x: number, y: number): number {
  let inside = false;
  let best = Infinity;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[j]!;
    const b = ring[i]!;
    if ((b.y > y) !== (a.y > y) && x < ((a.x - b.x) * (y - b.y)) / (a.y - b.y) + b.x) inside = !inside;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    const t = len2 > 0 ? Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / len2)) : 0;
    best = Math.min(best, Math.hypot(x - (a.x + dx * t), y - (a.y + dy * t)));
  }
  return inside ? 0 : best;
}

/**
 * The pads of every building. `apron` is the level margin round each
 * footprint: at least one cell of the ground mesh, so every cell a wall stands
 * in is level at all its corners.
 */
export function buildingPads(
  buildings: Iterable<Building>,
  naturalGround: GroundAt,
  pavedAt: PavedAt | undefined,
  apron: number,
): BuildingPads {
  const pads: Pad[] = [];
  for (const b of buildings) {
    const built = solidFootprints(b);
    const floor = floorHeight(b, naturalGround, pavedAt);
    // Under the building, level at the floor less the plinth; under its open
    // lots, the lot's own surface (`lots.ts`), which falls with the street.
    const lots = lotSurfaces(b, floor, pavedAt);
    const rings: (readonly Vec2[])[] = [...built, ...lots.map((l) => l.ring)];
    if (rings.length === 0) continue;
    const flat = floor - PLINTH_MIN;
    const levels = [...built.map(() => () => flat), ...lots.map((l) => (x: number, y: number) => l.heightAt(x, y) - PLINTH_MIN)];
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const ring of rings) {
      for (const p of ring) {
        minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
        maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
      }
    }
    const grow = apron + PAD_REACH;
    pads.push({ rings, levels, box: { minX: minX - grow, minY: minY - grow, maxX: maxX + grow, maxY: maxY + grow } });
  }
  return {
    count: pads.length,
    shapeBounds: () => pads.map((p) => p.box),
    shapeAt(x, y, ground) {
      // The nearest platform decides: two buildings side by side share the
      // strip between them as each one's own apron, split down the middle.
      let nearest = Infinity;
      let level = 0;
      for (const pad of pads) {
        if (x < pad.box.minX || x > pad.box.maxX || y < pad.box.minY || y > pad.box.maxY) continue;
        pad.rings.forEach((ring, i) => {
          const d = ringDistance(ring, x, y);
          if (d < nearest) { nearest = d; level = pad.levels[i]!(x, y); }
        });
      }
      if (nearest === Infinity) return { height: ground, weight: 0 };
      const out = Math.max(0, nearest - apron) / PAD_BATTER;
      // Fill below the platform, cut above it, and the land itself once the
      // bank has met it.
      const height = ground < level ? Math.max(ground, level - out) : Math.min(ground, level + out);
      if (Math.abs(height - ground) < 1e-3) return { height: ground, weight: 0 };
      return { height, weight: 1 };
    },
  };
}
