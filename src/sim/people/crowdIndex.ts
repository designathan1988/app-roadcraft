import type { Aabb } from '@core/aabb';
import type { Walkway } from '@world/walkways';
import { m } from '@world/units';
import type { Narrow, Zebra } from './crowdNav';

const EMPTY: readonly never[] = [];
const EVERYWHERE: Aabb = { minX: -Infinity, minY: -Infinity, maxX: Infinity, maxY: Infinity };

/** A conservative broad phase. Returned candidates keep their original order,
 * because the first matching crossing or passage determines intent. Geometry
 * and its exact predicates remain the authority, including at cell boundaries.
 */
export class CrowdPointIndex<T> {
  private readonly buckets = new Map<string, T[]>();
  private readonly oversized: T[] = [];
  private readonly order = new Map<T, number>();

  constructor(private readonly items: readonly T[], bounds: (item: T) => Aabb, private readonly cell = m(8)) {
    if (!(cell > 0) || !Number.isFinite(cell)) throw new Error('Crowd index cell must be positive and finite');
    items.forEach((item, ordinal) => {
      this.order.set(item, ordinal);
      const box = bounds(item);
      const x0 = Math.floor(box.minX / cell), x1 = Math.floor(box.maxX / cell);
      const y0 = Math.floor(box.minY / cell), y1 = Math.floor(box.maxY / cell);
      // Long map-wide geometry must not allocate a map-wide grid. It remains
      // a candidate everywhere; the caller still applies the original test.
      if (![x0, x1, y0, y1].every(Number.isFinite) || (x1 - x0 + 1) * (y1 - y0 + 1) > 4096) {
        this.oversized.push(item);
        return;
      }
      for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
        const key = `${x}:${y}`;
        const bucket = this.buckets.get(key);
        if (bucket) bucket.push(item);
        else this.buckets.set(key, [item]);
      }
    });
  }

  /** No allocation for the common case of a point and ordinary-sized geometry. */
  at(x: number, y: number): readonly T[] {
    const bucket = this.buckets.get(`${Math.floor(x / this.cell)}:${Math.floor(y / this.cell)}`);
    if (!this.oversized.length) return bucket ?? EMPTY;
    if (!bucket) return this.oversized;
    return this.ordered([...bucket, ...this.oversized]);
  }

  /** Candidates intersecting a square, deduplicated and in source order. */
  around(x: number, y: number, radius: number): readonly T[] {
    const x0 = Math.floor((x - radius) / this.cell), x1 = Math.floor((x + radius) / this.cell);
    const y0 = Math.floor((y - radius) / this.cell), y1 = Math.floor((y + radius) / this.cell);
    if (![x0, x1, y0, y1].every(Number.isFinite) || (x1 - x0 + 1) * (y1 - y0 + 1) > 4096) return this.items;
    const found = new Set(this.oversized);
    for (let ix = x0; ix <= x1; ix++) for (let iy = y0; iy <= y1; iy++) {
      for (const item of this.buckets.get(`${ix}:${iy}`) ?? EMPTY) found.add(item);
    }
    return this.ordered([...found]);
  }

  private ordered(items: T[]): T[] {
    return items.sort((a, b) => this.order.get(a)! - this.order.get(b)!);
  }
}

export interface CrowdSpatial {
  readonly zebras: CrowdPointIndex<Zebra>;
  readonly narrows: CrowdPointIndex<Narrow>;
  readonly narrowCentres: CrowdPointIndex<Narrow>;
  readonly ways: CrowdPointIndex<Walkway>;
}

/** These indices belong to one nav build; replacing the nav replaces all of
 * them. They only reject distant geometry, never decide movement or access.
 */
export function buildCrowdSpatial(
  zebras: readonly Zebra[], narrows: readonly Narrow[], ways: readonly Walkway[], bodyRadius: number,
): CrowdSpatial {
  return {
    zebras: new CrowdPointIndex(zebras, (z) => z.a.x === z.b.x && z.a.y === z.b.y ? EVERYWHERE : ({
      minX: Math.min(z.a.x, z.b.x) - z.half, maxX: Math.max(z.a.x, z.b.x) + z.half,
      minY: Math.min(z.a.y, z.b.y) - z.half, maxY: Math.max(z.a.y, z.b.y) + z.half,
    })),
    narrows: new CrowdPointIndex(narrows, (n) => {
      // Merged passages retain the first passage's axis. Their endpoints
      // need not lie on it: bound the actual dot-product predicate, not the
      // line between those endpoints. Divide by |dir|² for the inverse frame.
      const length = Math.hypot(n.b.x - n.a.x, n.b.y - n.a.y);
      const norm = n.dir.x * n.dir.x + n.dir.y * n.dir.y;
      if (norm === 0) return EVERYWHERE;
      const middle = length / 2;
      const half = middle + 2 * bodyRadius;
      const cx = n.a.x + n.dir.x * middle / norm, cy = n.a.y + n.dir.y * middle / norm;
      const dx = (Math.abs(n.dir.x) * half + Math.abs(n.dir.y) * n.reach) / norm;
      const dy = (Math.abs(n.dir.y) * half + Math.abs(n.dir.x) * n.reach) / norm;
      // Roundoff may otherwise put a predicate's closed boundary just beyond
      // its reconstructed box. Extra candidates still use the exact predicate.
      const pad = 1e-10 * Math.max(1, Math.abs(cx), Math.abs(cy), dx, dy);
      return {
        minX: cx - dx - pad, maxX: cx + dx + pad,
        minY: cy - dy - pad, maxY: cy + dy + pad,
      };
    }),
    narrowCentres: new CrowdPointIndex(narrows, (n) => ({
      minX: (n.a.x + n.b.x) / 2, maxX: (n.a.x + n.b.x) / 2,
      minY: (n.a.y + n.b.y) / 2, maxY: (n.a.y + n.b.y) / 2,
    })),
    ways: new CrowdPointIndex(ways, (way) => ({
      minX: way.path.bbox.minX - m(4), maxX: way.path.bbox.maxX + m(4),
      minY: way.path.bbox.minY - m(4), maxY: way.path.bbox.maxY + m(4),
    })),
  };
}
