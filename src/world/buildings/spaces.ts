import { baysOn, levelHeight } from './geometry';
import { m } from '../units';
import type { Building, BuildingUse, Space, SpaceKind, Volume } from './types';

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
      // Flats on a residential floor are laid out as its plan has them (a
      // corridor down the middle, homes either side, two or three windows
      // each), so the homes, the walls and the windows agree.
      if ((!spaces || spaces.length === 0) && (use === 'residential' || use === 'mixed') && !(level === 0 && b.volumes.some((o) => o.storeys.length > 1) && use === 'mixed')) {
        const plan = flatPlan(b, v);
        if (plan.flats.length > 1 || plan.corridor) {
          spaces = plan.flats.map((f, i) => ({ id: i + 1, x: f.x, y: f.y, w: f.w, d: f.d, kind: 'unit', use }));
        }
      }
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

/** One home on a residential floor, and how it lies. */
export interface FlatCell {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly d: number;
  /** Its facade corner and axes: `t` along the facade, `n` from the facade inwards (local frame). */
  readonly ox: number;
  readonly oy: number;
  readonly tx: number;
  readonly ty: number;
  readonly nx: number;
  readonly ny: number;
  /** Width along the facade and depth from it. */
  readonly width: number;
  readonly depth: number;
  /** Width of one window bay along the facade: walls fall between bays. */
  readonly bay: number;
}

export interface FlatPlan {
  /** The corridor down the middle, when the floor is deep enough for homes both sides. */
  readonly corridor: { readonly x0: number; readonly y0: number; readonly x1: number; readonly y1: number } | null;
  readonly flats: readonly FlatCell[];
}

/** Corridor width, and the depth from which a floor has homes on both sides. */
const CORRIDOR = m(1.6);
const DOUBLE_LOADED = m(11);

/**
 * A residential floor of one block as homes: a corridor down its long axis
 * (when it is deep enough) with homes either side, each two or three window
 * bays wide, so every wall between homes stands between two windows, never
 * across one.
 */
export function flatPlan(b: Building, v: Volume, groupBays = 2): FlatPlan {
  const alongX = v.w >= v.d;
  const L = alongX ? v.w : v.d;
  const D = alongX ? v.d : v.w;
  const bays = baysOn(b, v, alongX ? 0 : 3);
  const bay = L / bays;
  // Homes of two bays (three where an odd one is left over).
  const groups: number[] = [];
  let left = bays;
  while (left > 0) {
    // Rooms of `groupBays` bays; what is left over too narrow for one more
    // goes to the last.
    const take = left < groupBays * 2 ? left : groupBays;
    groups.push(take);
    left -= take;
  }
  const double = D >= DOUBLE_LOADED && bays >= 2;
  const rowDepth = double ? (D - CORRIDOR) / 2 : D;
  const flats: FlatCell[] = [];
  const rows: { s0: number; inward: 1 | -1 }[] = double ? [{ s0: 0, inward: 1 }, { s0: D, inward: -1 }] : [{ s0: 0, inward: 1 }];
  for (const row of rows) {
    let u = 0;
    for (const g of groups) {
      const width = g * bay;
      // Local frame: along = x (or y), across = y (or x).
      const a0 = (alongX ? v.x : v.y) + u;
      const c0 = (alongX ? v.y : v.x) + row.s0;
      const cFar = c0 + row.inward * rowDepth;
      const lo = Math.min(c0, cFar);
      const rect = alongX
        ? { x: a0, y: lo, w: width, d: rowDepth }
        : { x: lo, y: a0, w: rowDepth, d: width };
      const t = alongX ? { x: 1, y: 0 } : { x: 0, y: 1 };
      const n = alongX ? { x: 0, y: row.inward } : { x: row.inward, y: 0 };
      flats.push({
        ...rect,
        ox: alongX ? a0 : c0, oy: alongX ? c0 : a0,
        tx: t.x, ty: t.y, nx: n.x, ny: n.y,
        width, depth: rowDepth, bay,
      });
      u += width;
    }
  }
  const corridor = double
    ? (alongX
      ? { x0: v.x, y0: v.y + rowDepth, x1: v.x + v.w, y1: v.y + rowDepth + CORRIDOR }
      : { x0: v.x + rowDepth, y0: v.y, x1: v.x + rowDepth + CORRIDOR, y1: v.y + v.d })
    : null;
  return { corridor, flats };
}
