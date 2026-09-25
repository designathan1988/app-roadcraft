import { levelHeight } from './geometry';
import type { Building, BuildingUse, Space, SpaceKind } from './types';

/**
 * Extension point for interiors and occupants (docs/buildings.md section 1).
 *
 * A storey that stores its own `spaces` is authoritative. One that does not
 * gets the default subdivision below: one space per volume per storey, split
 * along the long axis into flats of up to four modules for residential use.
 * A future occupancy model, lift or service simulation reads this; nothing in
 * the game does yet.
 */
export interface StoreySpaces {
  readonly volume: number;
  readonly storey: number;
  readonly level: number;
  readonly use: BuildingUse;
  readonly height: number;
  readonly spaces: readonly Space[];
}

const KIND: Readonly<Record<BuildingUse, SpaceKind>> = {
  residential: 'unit',
  commercial: 'shop',
  industrial: 'workshop',
  mixed: 'unit',
};

export function deriveSpaces(b: Building): StoreySpaces[] {
  const out: StoreySpaces[] = [];
  for (const v of b.volumes) {
    v.storeys.forEach((storey, k) => {
      const level = v.base + k;
      const use = storey.use ?? (b.use === 'mixed' ? (level === 0 ? 'commercial' : 'residential') : b.use);
      let spaces = storey.spaces;
      if (!spaces || spaces.length === 0) {
        const kind = level > 0 && use === 'commercial' ? 'office' : KIND[use];
        const alongX = v.w >= v.d;
        const length = alongX ? v.w : v.d;
        const split = use === 'residential' ? Math.max(1, Math.ceil(length / (4 * b.module) - 1e-9)) : 1;
        spaces = [];
        let start = 0;
        for (let n = 0; n < split; n++) {
          const size = ((n + 1) * length) / split - start;
          spaces.push(alongX
            ? { id: n + 1, x: v.x + start, y: v.y, w: size, d: v.d, kind, use }
            : { id: n + 1, x: v.x, y: v.y + start, w: v.w, d: size, kind, use });
          start += size;
        }
      }
      out.push({ volume: v.id, storey: k, level, use, height: levelHeight(b, level), spaces });
    });
  }
  return out;
}

/** Gross floor area, in square world units: every storey of every volume. */
export function floorArea(b: Building): number {
  let area = 0;
  for (const v of b.volumes) area += v.w * v.d * v.storeys.length;
  return area;
}
