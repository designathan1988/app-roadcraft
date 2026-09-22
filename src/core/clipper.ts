import clipping from 'polygon-clipping';

/** A ring need not repeat its first point or use a particular winding. */
export type Ring = number[][];
/** The first ring is the exterior; subsequent rings are holes. */
export type Poly = Ring[];
export type MultiPoly = Poly[];

/** Shared input grid: one step is 0.04 mm at the game's world scale. */
const SCALE = 10_000;
type KernelMultiPoly = ReturnType<typeof clipping.union>;

function input(polygons: MultiPoly): KernelMultiPoly {
  const result: KernelMultiPoly = [];
  for (const polygon of polygons) {
    if (!polygon[0] || polygon[0].length < 3) continue;
    const rings: KernelMultiPoly[number] = [];
    for (const ring of polygon) {
      if (ring.length < 3) continue;
      rings.push(ring.map(point => {
        const x = point[0], y = point[1];
        if (x === undefined || y === undefined || !Number.isFinite(x) || !Number.isFinite(y)) {
          throw new Error('Polygon coordinate must be finite');
        }
        return [Math.round(x * SCALE), Math.round(y * SCALE)];
      }));
    }
    result.push(rings);
  }
  return result;
}

function output(polygons: KernelMultiPoly): MultiPoly {
  return polygons.map(polygon => polygon.map(ring => {
    // The kernel closes rings explicitly. Consumers here close them themselves.
    const end = ring.length > 1 && ring[0]![0] === ring[ring.length - 1]![0]
      && ring[0]![1] === ring[ring.length - 1]![1] ? ring.length - 1 : ring.length;
    return ring.slice(0, end).map(([x, y]) => [x / SCALE, y / SCALE]);
  }));
}

/**
 * Set operations preserve polygon/hole membership through the kernel.
 * No point-probe nesting or overlapping-ring fallback is used. A missed region
 * must fail a coverage test rather than be hidden by drawing it twice.
 */
export function union(a: MultiPoly, b: MultiPoly = []): MultiPoly {
  const subjects = [...input(a), ...input(b)];
  return subjects.length ? output(clipping.union(subjects)) : [];
}

export function difference(a: MultiPoly, b: MultiPoly): MultiPoly {
  const subjects = input(a), clips = input(b);
  if (!subjects.length) return [];
  return output(clips.length ? clipping.difference(subjects, clips) : clipping.union(subjects));
}

export function intersection(a: MultiPoly, b: MultiPoly): MultiPoly {
  const subjects = input(a), clips = input(b);
  if (!subjects.length || !clips.length) return [];
  return output(clipping.intersection(subjects, clips));
}

/** Signed area of the set, with explicit holes subtracted. */
export function area(polygons: MultiPoly): number {
  let total = 0;
  for (const polygon of polygons) {
    for (let ringIndex = 0; ringIndex < polygon.length; ringIndex++) {
      const ring = polygon[ringIndex]!;
      let twice = 0;
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const a = ring[j]!, b = ring[i]!;
        twice += a[0]! * b[1]! - b[0]! * a[1]!;
      }
      total += (ringIndex === 0 ? 1 : -1) * Math.abs(twice) / 2;
    }
  }
  return total;
}
