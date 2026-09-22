import { Clipper, ClipType, FillRule, Point64 } from 'clipper2-js';

/**
 * Polygon booleans and offsetting, in world units.
 *
 * The surface union in `src/render` is not a polygon — it is a painting effect,
 * one `Path2D` per level filled with the nonzero rule, where overlap disappears
 * because every colour is opaque. That works for a canvas and cannot work for a
 * mesh: a mesh needs the outline as DATA. This is where that data comes from.
 *
 * Clipper2 works in integers, and that is the reason it was chosen over the
 * Martinez implementations. This engine already loses rings to exact
 * floating-point tangency — `ACUTE_CLEARANCE` exists purely to push two mouths
 * 2 % apart, because the simplicity test reads a touching pair of edges as an
 * intersection. Snapping to a fixed grid removes that whole class rather than
 * nudging around it.
 */

/**
 * Integer grid the clipper works on, in steps per world unit.
 *
 * One world unit is 0.4 m, so this resolves 0.04 mm. Fine enough that snapping
 * is invisible at any zoom, coarse enough that a map spanning a million units
 * still lands inside exact double-integer range.
 */
const SCALE = 10_000;

/**
 * What the library hands back.
 *
 * Taken from the library's own return type rather than named directly: it
 * distinguishes `Point64` from the `IPoint64` its results actually contain, and
 * spelling that out here would pin an internal detail this module has no reason
 * to know.
 */
type ClipperPaths = ReturnType<typeof Clipper.Union>;

/** A closed ring, as [x, y] pairs. Not required to be wound any way round. */
export type Ring = number[][];

/** A polygon: its outer ring first, then any holes. */
export type Poly = Ring[];

/** Zero or more polygons. */
export type MultiPoly = Poly[];

const toPaths = (mp: MultiPoly): Point64[][] =>
  mp.flatMap((poly) =>
    poly
      .filter((ring) => ring.length >= 3)
      .map((ring) =>
        ring.map(
          (p) =>
            new Point64(
              Math.round((p[0] as number) * SCALE),
              Math.round((p[1] as number) * SCALE),
            ),
        ),
      ),
  );

/**
 * Re-nests a flat list of rings into polygons with holes.
 *
 * Clipper returns rings, not a hierarchy: an outer boundary is wound positively
 * and a hole negatively. Each hole belongs to the SMALLEST positive ring that
 * contains it — smallest, because a hole inside an island inside a lake would
 * otherwise be handed to the lake.
 */
function nest(paths: ClipperPaths): MultiPoly {
  const rings = paths
    .map((path) => ({
      ring: path.map((p) => [Number(p.x) / SCALE, Number(p.y) / SCALE]),
      area: Clipper.area(path) / (SCALE * SCALE),
    }))
    .filter((r) => r.ring.length >= 3);

  const outers = rings.filter((r) => r.area > 0).sort((a, b) => a.area - b.area);
  const holes = rings.filter((r) => r.area <= 0);

  const polys: MultiPoly = outers.map((o) => [o.ring]);
  for (const hole of holes) {
    // A point STRICTLY INSIDE the hole, never one of its vertices.
    //
    // `hole.ring[0]` stood here, and a hole's vertex is the one class of point
    // that cannot answer this question. Every band these surfaces produce —
    // footway minus kerb, kerb minus carriageway — has holes that TOUCH their
    // outer boundary wherever the band pinches to nothing, so the probe landed
    // exactly on the outer's own edge and the crossing-number test came back a
    // coin toss. Lose the toss and the hole goes to the wrong outer or, when
    // nothing claims it, is dropped — and a band that loses its hole is FILLED
    // SOLID. That is the pale slab lying across the carriageway: not a geometry
    // fault at all, a hole that fell on the floor.
    const probe = interiorPoint(hole.ring);
    const index = outers.findIndex((o) =>
      pointInRing(probe[0] as number, probe[1] as number, o.ring),
    );
    if (index >= 0) (polys[index] as Poly).push(hole.ring);
  }
  return polys;
}

/**
 * A point strictly inside a simple ring.
 *
 * The lowest-then-leftmost vertex of a simple polygon is always a CONVEX
 * corner, so the centroid of it and its two neighbours lies inside the polygon
 * and off every edge. Exact, and free of the tolerance a "nudge along the
 * normal" would need.
 */
function interiorPoint(ring: Ring): number[] {
  let at = 0;
  for (let i = 1; i < ring.length; i++) {
    const p = ring[i] as number[];
    const best = ring[at] as number[];
    if (
      (p[1] as number) < (best[1] as number) ||
      ((p[1] as number) === (best[1] as number) && (p[0] as number) < (best[0] as number))
    ) {
      at = i;
    }
  }
  const prev = ring[(at - 1 + ring.length) % ring.length] as number[];
  const here = ring[at] as number[];
  const next = ring[(at + 1) % ring.length] as number[];
  return [
    ((prev[0] as number) + (here[0] as number) + (next[0] as number)) / 3,
    ((prev[1] as number) + (here[1] as number) + (next[1] as number)) / 3,
  ];
}

/** Crossing-number test. Used only to decide which outer ring owns a hole. */
function pointInRing(x: number, y: number, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i] as number[];
    const b = ring[j] as number[];
    const ay = a[1] as number;
    const by = b[1] as number;
    if (ay > y === by > y) continue;
    const ax = a[0] as number;
    const bx = b[0] as number;
    if (x < ((bx - ax) * (y - ay)) / (by - ay) + ax) inside = !inside;
  }
  return inside;
}

/**
 * Union.
 *
 * `NonZero` rather than `EvenOdd`, deliberately: two overlapping carriageways
 * of the same road must merge, and under even-odd their overlap would cancel to
 * a hole. That is the same rule the canvas painter already fills with, so the
 * boolean agrees with the picture instead of contradicting it.
 */
export function union(a: MultiPoly, b: MultiPoly = []): MultiPoly {
  return nest(Clipper.Union(toPaths(a), toPaths(b), FillRule.NonZero));
}

export function difference(a: MultiPoly, b: MultiPoly): MultiPoly {
  return nest(Clipper.Difference(toPaths(a), toPaths(b), FillRule.NonZero));
}

export function intersection(a: MultiPoly, b: MultiPoly): MultiPoly {
  return nest(Clipper.Intersect(toPaths(a), toPaths(b), FillRule.NonZero));
}

/**
 * NO OFFSET HERE, deliberately.
 *
 * `Clipper.InflatePaths` is broken in both published versions of this package,
 * measured rather than assumed. On 1.2.4 a plain 60x60 square offset outward by
 * 5 comes back with one edge unmoved — bounds `x -35..30` against `y -35..35` —
 * and an area of 4225 where arithmetic says 4900. On 1.2.3 the same call throws
 * `Cannot read properties of undefined` out of `crossProduct`. Upstream
 * Clipper2 has the matching report, issue 733: InflatePaths regressed in 1.2.4
 * on exactly this shape.
 *
 * Nothing here needs it. This engine already builds a ring per surface level
 * from that level's own half-width — that is what `halfWidth(rt, level)` and
 * `offsetPolyline` are for, and those are tested. A band is therefore the
 * DIFFERENCE of two levels that already exist, not an offset of one of them:
 *
 *   kerb    = difference(level Curb, level Asphalt)
 *   footway = difference(level Sidewalk, level Curb)
 *
 * That reuses geometry the project already proves, keeps one source for every
 * width, and asks this library only for the two operations it gets right.
 */

/** Signed area, holes subtracted, in square world units. */
export function area(mp: MultiPoly): number {
  let total = 0;
  for (const poly of mp) {
    for (let i = 0; i < poly.length; i++) {
      const ring = poly[i] as Ring;
      const a = Math.abs(shoelace(ring));
      total += i === 0 ? a : -a;
    }
  }
  return total;
}

function shoelace(ring: Ring): number {
  let sum = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const p = ring[i] as number[];
    const q = ring[j] as number[];
    sum += ((q[0] as number) + (p[0] as number)) * ((q[1] as number) - (p[1] as number));
  }
  return sum / 2;
}

/** `ClipType` is re-exported so callers can name an operation without importing the library. */
export { ClipType };
