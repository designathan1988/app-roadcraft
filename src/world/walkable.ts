import { Digest } from '@core/digest';
import { RegionIndex } from '@core/regionIndex';
import type { Vec2 } from '@core/vec2';
import type { Network } from './network';
import { Level } from './roadTypes';
import { levelRings } from './surfaces';

/**
 * The ground a pedestrian may stand on: the footway and its kerb, and never
 * the carriageway or the verge beyond.
 *
 * It is the same outline the road mesh draws (`world/surfaces.ts`), read as
 * rings and answered point by point through a `RegionIndex`: inside the
 * footway level, and outside the carriageway. No clipper union is needed —
 * the rings are combined by winding number — so building it costs about as
 * much as flattening the rings.
 *
 * The pedestrian navigation reads it once per network, to fit every walking
 * corridor to the footway that is really there (`sim/peds/corridor.ts`), and
 * the audits read it to check what the player sees.
 */
export class WalkableSurface {
  private readonly outer: RegionIndex;
  private readonly road: RegionIndex;
  private readonly runA = { lo: 0, hi: 0 };
  private readonly runB = { lo: 0, hi: 0 };

  constructor(net: Network) {
    this.outer = RegionIndex.fromRings(ringsOf(levelRings(net, Level.Sidewalk)), 'nonzero');
    this.road = RegionIndex.fromRings(ringsOf(levelRings(net, Level.Asphalt)), 'nonzero');
  }

  /** On the footway or its kerb. */
  footway(x: number, y: number): boolean {
    return this.outer.contains(x, y) && !this.road.contains(x, y);
  }

  /** On the carriageway. */
  carriageway(x: number, y: number): boolean {
    return this.road.contains(x, y);
  }

  /**
   * A digest of the footway geometry the box touches, both regions together.
   *
   * `footwaySpan` answers from the footway region and the carriageway region
   * within reach of the line it is given, so an answer keyed by this digest
   * over a box that contains that line's whole reach is reusable exactly.
   */
  digest(minX: number, minY: number, maxX: number, maxY: number): number {
    return new Digest()
      .add(this.outer.digest(minX, minY, maxX, maxY))
      .add(this.road.digest(minX, minY, maxX, maxY))
      .value();
  }

  /**
   * Along the line through `p` in direction `d` (unit), the stretch of
   * footway containing `p`, within `reach`: `lo` <= 0 <= `hi`. False when
   * `p` is not on the footway.
   */
  footwaySpan(px: number, py: number, dx: number, dy: number, reach: number,
    out: { lo: number; hi: number }): boolean {
    if (!this.outer.run(px, py, dx, dy, reach, this.runA)) return false;
    if (this.road.run(px, py, dx, dy, reach, this.runB)) return false;
    out.lo = Math.max(this.runA.lo, this.runB.lo);
    out.hi = Math.min(this.runA.hi, this.runB.hi);
    return true;
  }
}

function ringsOf(polygons: readonly (readonly (readonly (readonly number[])[])[])[]): Vec2[][] {
  const out: Vec2[][] = [];
  for (const polygon of polygons) {
    for (const ring of polygon) out.push(ring.map((p) => ({ x: p[0] as number, y: p[1] as number })));
  }
  return out;
}
