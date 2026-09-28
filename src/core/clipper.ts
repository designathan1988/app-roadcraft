import { Clipper64, ClipType, FillRule, PathType, PolyTree64, type Path64, type Paths64, type PolyPath64 } from 'clipper2-ts';
import clipping from 'polygon-clipping';

/** A ring need not repeat its first point or use a particular winding. */
export type Ring = number[][];
/** The first ring is the exterior; subsequent rings are holes. */
export type Poly = Ring[];
export type MultiPoly = Poly[];

/** Shared integer grid: one step is 0.04 mm at the game's world scale. */
const SCALE = 10_000;
type KernelMultiPoly = ReturnType<typeof clipping.union>;

function signedDoubleArea(path: Path64): number {
  let sum = 0;
  for (let i = 0, j = path.length - 1; i < path.length; j = i++) {
    const a = path[j]!, b = path[i]!;
    sum += a.x * b.y - b.x * a.y;
  }
  return sum;
}

function input(polygons: MultiPoly): Paths64 {
  const paths: Paths64 = [];
  for (const polygon of polygons) {
    for (let ringIndex = 0; ringIndex < polygon.length; ringIndex++) {
      const ring = polygon[ringIndex]!;
      if (ring.length < 3) continue;
      const path: Path64 = [];
      for (const point of ring) {
        const x = point[0], y = point[1];
        if (x === undefined || y === undefined || !Number.isFinite(x) || !Number.isFinite(y)) {
          throw new Error('Polygon coordinate must be finite');
        }
        const p = { x: Math.round(x * SCALE), y: Math.round(y * SCALE) };
        const prev = path[path.length - 1];
        if (!prev || prev.x !== p.x || prev.y !== p.y) path.push(p);
      }
      if (path.length > 1 && path[0]!.x === path[path.length - 1]!.x &&
          path[0]!.y === path[path.length - 1]!.y) path.pop();
      if (path.length < 3) continue;
      // NonZero fills overlapping exteriors as a union. Holes have the
      // opposite winding, regardless of authored input order.
      const positive = signedDoubleArea(path) > 0;
      if (positive !== (ringIndex === 0)) path.reverse();
      paths.push(path);
    }
  }
  return paths;
}

function ringOf(path: Path64): Ring {
  return path.map((p) => [p.x / SCALE, p.y / SCALE]);
}

function output(tree: PolyTree64): MultiPoly {
  const result: MultiPoly = [];
  const visit = (node: PolyPath64): void => {
    if (node.poly && !node.isHole) {
      const polygon: Poly = [ringOf(node.poly)];
      for (let i = 0; i < node.count; i++) {
        const child = node.child(i);
        if (child.isHole && child.poly) polygon.push(ringOf(child.poly));
      }
      result.push(polygon);
    }
    for (let i = 0; i < node.count; i++) visit(node.child(i));
  };
  visit(tree);
  return result;
}

function run(kind: ClipType, a: MultiPoly, b: MultiPoly = []): MultiPoly {
  const subjects = input(a);
  if (!subjects.length) return [];
  const clip = new Clipper64();
  clip.addPaths(subjects, PathType.Subject);
  const clips = input(b);
  if (clips.length) clip.addPaths(clips, PathType.Clip);
  const tree = new PolyTree64();
  if (!clip.execute(kind, FillRule.NonZero, tree)) {
    throw new Error(`Polygon clipping failed (${ClipType[kind]})`);
  }
  return output(tree);
}

function legacyInput(polygons: MultiPoly): KernelMultiPoly {
  const result: KernelMultiPoly = [];
  for (const polygon of polygons) {
    const rings: KernelMultiPoly[number] = [];
    for (const ring of polygon) {
      if (ring.length < 3) continue;
      rings.push(ring.map((point) => {
        const x = point[0], y = point[1];
        if (x === undefined || y === undefined || !Number.isFinite(x) || !Number.isFinite(y)) {
          throw new Error('Polygon coordinate must be finite');
        }
        return [Math.round(x * SCALE), Math.round(y * SCALE)];
      }));
    }
    if (rings.length) result.push(rings);
  }
  return result;
}

function legacyOutput(polygons: KernelMultiPoly): MultiPoly {
  return polygons.map((polygon) => polygon.map((ring) => {
    const end = ring.length > 1 && ring[0]![0] === ring[ring.length - 1]![0] &&
      ring[0]![1] === ring[ring.length - 1]![1] ? ring.length - 1 : ring.length;
    return ring.slice(0, end).map(([x, y]) => [x / SCALE, y / SCALE]);
  }));
}

/** Retain the game's established fill semantics, with Clipper2 for kernel failures. */
function compatibleRun(kind: ClipType, a: MultiPoly, b: MultiPoly = []): MultiPoly {
  const subjects = legacyInput(a);
  if (!subjects.length) return [];
  const clips = legacyInput(b);
  try {
    if (kind === ClipType.Union) return legacyOutput(clipping.union([...subjects, ...clips]));
    if (kind === ClipType.Difference) return legacyOutput(clipping.difference(subjects, clips));
    return legacyOutput(clipping.intersection(subjects, clips));
  } catch {
    // Martinez can fail to locate a sweep segment or grow its event queue
    // indefinitely on a valid cluster of nearly coincident road ribbons.
    // Clipper2's integer kernel is a bounded recovery path for that edit.
    return run(kind, a, b);
  }
}

/** Boolean set operations preserve outer/hole membership through PolyTree. */
export function union(a: MultiPoly, b: MultiPoly = []): MultiPoly {
  return compatibleRun(ClipType.Union, a, b);
}

export function difference(a: MultiPoly, b: MultiPoly): MultiPoly {
  return compatibleRun(b.length ? ClipType.Difference : ClipType.Union, a, b);
}

export function intersection(a: MultiPoly, b: MultiPoly): MultiPoly {
  if (!b.length) return [];
  return compatibleRun(ClipType.Intersection, a, b);
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
