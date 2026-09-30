import earcut from 'earcut';
import {
  ClipType, EndType, FillRule, JoinType, PolyTreeD, type PolyPathD, booleanOpDWithPolyTree, differenceD, inflatePathsD, intersectD, unionD,
  type PathD, type PathsD,
} from 'clipper2-ts';
import type { MultiPoly } from '@core/clipper';

/**
 * WHERE PEOPLE CAN STAND, as one mesh of triangles.
 *
 * The walkable surface is the footway plus the zebras, minus everything a body
 * cannot stand in (street furniture, signal posts, poles, buildings), shrunk
 * by a body's radius so that a body CENTRE anywhere on the mesh is a body
 * clear of every wall and obstacle. "Never inside an obstacle, never in the
 * road except on a zebra" is then one question: is the centre on the mesh.
 *
 * Zebras are separate regions joined to the footway by portals, so a path
 * that crosses the road passes through a gate the agent must be allowed
 * through (`docs/design/agency-architecture.md` §2).
 */

/** A body's radius: how far the mesh keeps a person's centre from any wall, u. */
export const NAV_RADIUS = 0.625; // 0.25 m

export interface NavObstacle {
  readonly x: number;
  readonly y: number;
  readonly r: number;
}

export interface NavCrossingInput {
  readonly id: string;
  /** Kerb to kerb, footway centre to footway centre. */
  readonly ax: number;
  readonly ay: number;
  readonly bx: number;
  readonly by: number;
  /** Half the painted band's depth, u. */
  readonly halfWidth: number;
}

export interface NavInput {
  /**
   * The footway, without the kerb or the carriageway, one entry per deck
   * (ground, raised, bridge). Decks are triangulated apart, so a footway on a
   * bridge is never joined to the one it passes over; where two decks meet at
   * a ramp their edges coincide and a portal joins them.
   */
  readonly layers: readonly MultiPoly[];
  /** The deck each zebra lies on, an index into `layers`. */
  readonly crossingLayers: readonly number[];
  /** The road surface a zebra may cover: carriageway plus kerb. */
  readonly road: MultiPoly;
  readonly crossings: readonly NavCrossingInput[];
  readonly obstacles: readonly NavObstacle[];
  /** Solid footprints (buildings), as rings. */
  readonly solids: readonly (readonly { x: number; y: number }[])[];
}

/** A triangle's region: footway, or the zebra with this index in `NavMesh.crossings`. */
export const FOOTWAY = -1;

export interface NavPortal {
  /** The triangle on the other side. */
  readonly to: number;
  /** The shared segment's ends, on the left and on the right of somebody crossing it from this triangle. */
  readonly lx: number;
  readonly ly: number;
  readonly rx: number;
  readonly ry: number;
}

export class NavMesh {
  /** Triangle corners, 6 numbers per triangle (x0 y0 x1 y1 x2 y2). */
  readonly tri: Float64Array;
  /** Per triangle: FOOTWAY or a crossing index. */
  readonly region: Int32Array;
  /** Per triangle: the deck, an index into `NavInput.layers`. */
  readonly layer: Int32Array;
  readonly portals: NavPortal[][];
  readonly crossings: readonly NavCrossingInput[];
  readonly count: number;
  private readonly grid = new Map<number, number[]>();
  /** Every wall: the edges no portal leads through, 4 numbers each. */
  private readonly walls: number[] = [];
  private readonly wallGrid = new Map<number, number[]>();

  constructor(tri: number[], region: number[], layer: number[], portals: NavPortal[][], crossings: readonly NavCrossingInput[]) {
    this.tri = Float64Array.from(tri);
    this.region = Int32Array.from(region);
    this.layer = Int32Array.from(layer);
    this.portals = portals;
    this.crossings = crossings;
    this.count = region.length;
    for (let t = 0; t < this.count; t++) {
      for (let e = 0; e < 3; e++) {
        const o = t * 6;
        const ax = this.tri[o + e * 2]!, ay = this.tri[o + e * 2 + 1]!;
        const bx = this.tri[o + ((e + 1) % 3) * 2]!, by = this.tri[o + ((e + 1) % 3) * 2 + 1]!;
        // Open where a portal covers it; what is left of the edge is wall.
        const len = Math.hypot(bx - ax, by - ay);
        if (len < 1e-9) continue;
        const ux = (bx - ax) / len, uy = (by - ay) / len;
        const open: [number, number][] = [];
        for (const p of portals[t]!) {
          const s1 = (p.rx - ax) * ux + (p.ry - ay) * uy, s2 = (p.lx - ax) * ux + (p.ly - ay) * uy;
          const off = Math.abs((p.rx - ax) * -uy + (p.ry - ay) * ux) + Math.abs((p.lx - ax) * -uy + (p.ly - ay) * ux);
          if (off < 0.02) open.push([Math.min(s1, s2), Math.max(s1, s2)]);
        }
        open.sort((a, b) => a[0] - b[0]);
        let at = 0;
        const addWall = (s0: number, s1: number): void => {
          if (s1 - s0 < 1e-3) return;
          const i = this.walls.length / 4;
          this.walls.push(ax + ux * s0, ay + uy * s0, ax + ux * s1, ay + uy * s1);
          const x0 = Math.min(ax + ux * s0, ax + ux * s1), x1 = Math.max(ax + ux * s0, ax + ux * s1);
          const y0 = Math.min(ay + uy * s0, ay + uy * s1), y1 = Math.max(ay + uy * s0, ay + uy * s1);
          for (let cx = wcell(x0); cx <= wcell(x1); cx++) {
            for (let cy = wcell(y0); cy <= wcell(y1); cy++) {
              const key = cellKey(cx, cy);
              const list = this.wallGrid.get(key);
              if (list) list.push(i);
              else this.wallGrid.set(key, [i]);
            }
          }
        };
        for (const [s0, s1] of open) { if (s0 > at) addWall(at, s0); at = Math.max(at, s1); }
        if (at < len) addWall(at, len);
      }
    }
    for (let t = 0; t < this.count; t++) {
      const [x0, y0, x1, y1] = this.bounds(t);
      for (let cx = cell(x0); cx <= cell(x1); cx++) {
        for (let cy = cell(y0); cy <= cell(y1); cy++) {
          const key = cellKey(cx, cy);
          const list = this.grid.get(key);
          if (list) list.push(t);
          else this.grid.set(key, [t]);
        }
      }
    }
  }

  private bounds(t: number): [number, number, number, number] {
    const o = t * 6;
    const xs = [this.tri[o]!, this.tri[o + 2]!, this.tri[o + 4]!];
    const ys = [this.tri[o + 1]!, this.tri[o + 3]!, this.tri[o + 5]!];
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  }

  /**
   * Whether the point is inside triangle `t`, or outside it by no more than
   * `eps` (a distance, u). The triangle is counter-clockwise.
   */
  contains(t: number, x: number, y: number, eps = 1e-6): boolean {
    const o = t * 6;
    const ax = this.tri[o]!, ay = this.tri[o + 1]!, bx = this.tri[o + 2]!, by = this.tri[o + 3]!;
    const cx = this.tri[o + 4]!, cy = this.tri[o + 5]!;
    const d1 = ((bx - ax) * (y - ay) - (by - ay) * (x - ax)) / (Math.hypot(bx - ax, by - ay) || 1);
    const d2 = ((cx - bx) * (y - by) - (cy - by) * (x - bx)) / (Math.hypot(cx - bx, cy - by) || 1);
    const d3 = ((ax - cx) * (y - cy) - (ay - cy) * (x - cx)) / (Math.hypot(ax - cx, ay - cy) || 1);
    return d1 >= -eps && d2 >= -eps && d3 >= -eps;
  }

  /** The triangle under a point anywhere on the mesh, or -1. */
  locate(x: number, y: number): number {
    for (const t of this.grid.get(cellKey(cell(x), cell(y))) ?? []) if (this.contains(t, x, y)) return t;
    return -1;
  }

  /**
   * The triangle under a point that was reached by walking from triangle
   * `from`: that triangle, a neighbour or a neighbour's neighbour. -1 when the
   * point is off the mesh there. Walking never jumps to a far triangle that
   * happens to lie under the same point (a footway below a bridge).
   */
  step(from: number, x: number, y: number, eps = 1e-6): number {
    if (from < 0) return this.locate(x, y);
    if (this.contains(from, x, y, eps)) return from;
    for (const p of this.portals[from]!) if (this.contains(p.to, x, y, eps)) return p.to;
    for (const p of this.portals[from]!) {
      for (const q of this.portals[p.to]!) if (q.to !== from && this.contains(q.to, x, y, eps)) return q.to;
    }
    // Round a vertex shared by many thin triangles the one under the point
    // can be further than two steps: any triangle of the same deck there,
    // touching the one walked from, is the one stepped into.
    for (const t of this.grid.get(cellKey(cell(x), cell(y))) ?? []) {
      if (this.layer[t] === this.layer[from] && this.contains(t, x, y, eps) && this.touches(t, from)) return t;
    }
    return -1;
  }

  /** Whether two triangles share at least one corner. */
  private touches(a: number, b: number): boolean {
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        if (Math.abs(this.tri[a * 6 + i * 2]! - this.tri[b * 6 + j * 2]!) < 1e-6 &&
            Math.abs(this.tri[a * 6 + i * 2 + 1]! - this.tri[b * 6 + j * 2 + 1]!) < 1e-6) return true;
      }
    }
    return false;
  }

  /**
   * Walks the straight segment from (x0, y0) in triangle `from` towards
   * (x1, y1), triangle by triangle through the portals it crosses. Returns the
   * triangle reached and the share of the segment walked: 1 when the whole of
   * it lies on the mesh, less when it runs into a wall first.
   */
  walk(from: number, x0: number, y0: number, x1: number, y1: number): { tri: number; share: number } {
    // Start from inside the triangle the segment actually sets off into: a
    // point on a vertex or an edge belongs to every triangle round it, and
    // the one it was filed under may face the other way (measured: a body
    // standing on a mesh corner saw no way out of it).
    const len = Math.hypot(x1 - x0, y1 - y0);
    if (len < 1e-9) return { tri: from, share: 1 };
    const lead = Math.min(1e-3, len / 2) / len;
    const probe = this.step(from, x0 + (x1 - x0) * lead, y0 + (y1 - y0) * lead);
    if (probe < 0) return { tri: from, share: 0 };
    let t = probe;
    x0 += (x1 - x0) * lead;
    y0 += (y1 - y0) * lead;
    let entered = -1;
    for (let guard = 0; guard < 64; guard++) {
      if (this.contains(t, x1, y1, 1e-9)) return { tri: t, share: 1 };
      // The edge of `t` the segment leaves by: the one it crosses furthest along.
      const o = t * 6;
      let exit = -1;
      let exitAt = -Infinity;
      for (let e = 0; e < 3; e++) {
        const ax = this.tri[o + e * 2]!, ay = this.tri[o + e * 2 + 1]!;
        const bx = this.tri[o + ((e + 1) % 3) * 2]!, by = this.tri[o + ((e + 1) % 3) * 2 + 1]!;
        const at = segmentHit(x0, y0, x1, y1, ax, ay, bx, by);
        if (at !== null && at > exitAt) {
          // Going out through this edge: the end lies to its right (outside a CCW triangle).
          const side = (bx - ax) * (y1 - ay) - (by - ay) * (x1 - ax);
          if (side < 0) { exit = e; exitAt = at; }
        }
      }
      if (exit < 0) return { tri: t, share: 0 };
      const ex = x0 + (x1 - x0) * exitAt, ey = y0 + (y1 - y0) * exitAt;
      let next = -1;
      for (const p of this.portals[t]!) {
        if (p.to === entered) continue;
        if (onSegment(p.lx, p.ly, p.rx, p.ry, ex, ey, 1e-3)) { next = p.to; break; }
      }
      if (next < 0) return { tri: t, share: Math.max(0, exitAt) };
      entered = t;
      t = next;
    }
    return { tri: t, share: 0 };
  }

  /**
   * Calls `visit` with the closest point of every wall within `reach` of the
   * point, and the distance to it.
   */
  wallsNear(x: number, y: number, reach: number, visit: (qx: number, qy: number, d: number) => void): void {
    const seen = new Set<number>();
    for (let cx = wcell(x - reach); cx <= wcell(x + reach); cx++) {
      for (let cy = wcell(y - reach); cy <= wcell(y + reach); cy++) {
        for (const i of this.wallGrid.get(cellKey(cx, cy)) ?? []) {
          if (seen.has(i)) continue;
          seen.add(i);
          const q = closestOnSegment(this.walls[i * 4]!, this.walls[i * 4 + 1]!, this.walls[i * 4 + 2]!, this.walls[i * 4 + 3]!, x, y);
          const d = Math.hypot(q.x - x, q.y - y);
          if (d < reach) visit(q.x, q.y, d);
        }
      }
    }
  }

  /** The nearest point on the mesh within `reach`, and its triangle; null if none. */
  nearest(x: number, y: number, reach: number): { x: number; y: number; t: number } | null {
    let best: { x: number; y: number; t: number } | null = null;
    let bestD = reach * reach;
    const seen = new Set<number>();
    for (let cx = cell(x - reach); cx <= cell(x + reach); cx++) {
      for (let cy = cell(y - reach); cy <= cell(y + reach); cy++) {
        for (const t of this.grid.get(cellKey(cx, cy)) ?? []) {
          if (seen.has(t)) continue;
          seen.add(t);
          const q = closestOnTriangle(this.tri, t, x, y);
          const d = (q.x - x) ** 2 + (q.y - y) ** 2;
          if (d < bestD) { bestD = d; best = { x: q.x, y: q.y, t }; }
        }
      }
    }
    return best;
  }

  /** The point of triangle `t` nearest (x, y): the point itself when inside. */
  clampTo(t: number, x: number, y: number): { x: number; y: number } {
    return closestOnTriangle(this.tri, t, x, y);
  }

  centroid(t: number): { x: number; y: number } {
    const o = t * 6;
    return { x: (this.tri[o]! + this.tri[o + 2]! + this.tri[o + 4]!) / 3, y: (this.tri[o + 1]! + this.tri[o + 3]! + this.tri[o + 5]!) / 3 };
  }

  area(t: number): number {
    const o = t * 6;
    return Math.abs((this.tri[o + 2]! - this.tri[o]!) * (this.tri[o + 5]! - this.tri[o + 1]!) -
      (this.tri[o + 4]! - this.tri[o]!) * (this.tri[o + 3]! - this.tri[o + 1]!)) / 2;
  }
}

const CELL = 8;
const cell = (v: number): number => Math.floor(v / CELL);
const WALL_CELL = 2;
const wcell = (v: number): number => Math.floor(v / WALL_CELL);
const cellKey = (cx: number, cy: number): number => (cx + 32768) * 65536 + (cy + 32768);

function closestOnTriangle(tri: Float64Array, t: number, x: number, y: number): { x: number; y: number } {
  const o = t * 6;
  const pts = [[tri[o]!, tri[o + 1]!], [tri[o + 2]!, tri[o + 3]!], [tri[o + 4]!, tri[o + 5]!]] as const;
  // Inside: the point itself.
  const [a, b, c] = pts;
  const d1 = (b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0]);
  const d2 = (c[0] - b[0]) * (y - b[1]) - (c[1] - b[1]) * (x - b[0]);
  const d3 = (a[0] - c[0]) * (y - c[1]) - (a[1] - c[1]) * (x - c[0]);
  if ((d1 >= 0 && d2 >= 0 && d3 >= 0) || (d1 <= 0 && d2 <= 0 && d3 <= 0)) return { x, y };
  let best = { x: a[0], y: a[1] };
  let bestD = Infinity;
  for (let i = 0; i < 3; i++) {
    const p = pts[i]!, q = pts[(i + 1) % 3]!;
    const q2 = closestOnSegment(p[0], p[1], q[0], q[1], x, y);
    const d = (q2.x - x) ** 2 + (q2.y - y) ** 2;
    if (d < bestD) { bestD = d; best = q2; }
  }
  return best;
}

/** Where along p0->p1 (0..1) it crosses segment a-b, or null. */
function segmentHit(x0: number, y0: number, x1: number, y1: number, ax: number, ay: number, bx: number, by: number): number | null {
  const rx = x1 - x0, ry = y1 - y0, sx = bx - ax, sy = by - ay;
  const den = rx * sy - ry * sx;
  if (Math.abs(den) < 1e-12) return null;
  const t = ((ax - x0) * sy - (ay - y0) * sx) / den;
  const u = ((ax - x0) * ry - (ay - y0) * rx) / den;
  if (t < -1e-9 || t > 1 + 1e-9 || u < -1e-6 || u > 1 + 1e-6) return null;
  return t;
}

function onSegment(ax: number, ay: number, bx: number, by: number, x: number, y: number, eps: number): boolean {
  const q = closestOnSegment(ax, ay, bx, by, x, y);
  return Math.hypot(q.x - x, q.y - y) <= eps;
}

export function closestOnSegment(ax: number, ay: number, bx: number, by: number, x: number, y: number): { x: number; y: number; t: number } {
  const dx = bx - ax, dy = by - ay;
  const len = dx * dx + dy * dy;
  const t = len > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len)) : 0;
  return { x: ax + dx * t, y: ay + dy * t, t };
}

// ----------------------------------------------------------------- building

const toPaths = (mp: MultiPoly): PathsD => {
  const out: PathsD = [];
  for (const poly of mp) for (const ring of poly) out.push(ring.map(([x, y]) => ({ x: x!, y: y! })));
  return out;
};

const disc = (x: number, y: number, r: number): PathD => {
  const n = 10;
  const out: PathD = [];
  // Circumscribed: the polygon contains the whole disc.
  const R = r / Math.cos(Math.PI / n);
  for (let i = 0; i < n; i++) out.push({ x: x + R * Math.cos((2 * Math.PI * i) / n), y: y + R * Math.sin((2 * Math.PI * i) / n) });
  return ccw(out);
};

/**
 * Counter-clockwise, whatever it was drawn as. Every shape here is merged with
 * the non-zero rule, under which a clockwise band laid over a
 * counter-clockwise footway cancels it: the overlap came out as a HOLE, right
 * where each zebra meets the kerb.
 */
const ccw = (path: PathD): PathD => {
  let area = 0;
  for (let i = 0, j = path.length - 1; i < path.length; j = i++) area += (path[j]!.x - path[i]!.x) * (path[j]!.y + path[i]!.y);
  return area < 0 ? [...path].reverse() : path;
};

/** The zebra's band, run on `extend` past each kerb end. */
const rect = (c: NavCrossingInput, extend = 0): PathD => {
  const dx = c.bx - c.ax, dy = c.by - c.ay;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len, uy = dy / len;
  const nx = -uy * c.halfWidth, ny = ux * c.halfWidth;
  const ax = c.ax - ux * extend, ay = c.ay - uy * extend, bx = c.bx + ux * extend, by = c.by + uy * extend;
  return ccw([
    { x: ax + nx, y: ay + ny }, { x: bx + nx, y: by + ny },
    { x: bx - nx, y: by - ny }, { x: ax - nx, y: ay - ny },
  ]);
};
/** How far a zebra's band is run into the footway, so the two overlap instead of touching, u. */
const INTO_FOOTWAY = 2.5;

const PRECISION = 3;

/** Polygons with holes out of a clipper path set, via a PolyTree. */
function polygons(paths: PathsD): PathD[][] {
  const tree = new PolyTreeD();
  booleanOpDWithPolyTree(ClipType.Union, paths, null, tree, FillRule.NonZero, PRECISION);
  const out: PathD[][] = [];
  const visit = (node: PolyPathD): void => {
    for (let i = 0; i < node.count; i++) {
      const outer = node.child(i);
      const poly: PathD[] = [outer.poly ?? []];
      for (let j = 0; j < outer.count; j++) {
        const hole = outer.child(j);
        poly.push(hole.poly ?? []);
        visit(hole);
      }
      out.push(poly);
    }
  };
  visit(tree);
  return out;
}

interface Tri { pts: number[]; region: number; layer: number; /** the polygon it was cut from */ poly: number }

/** Longest a polygon edge may be before it is split for triangulating, u. */
const MAX_EDGE = 3;

/**
 * Triangulates one polygon with holes into well-shaped triangles.
 *
 * Ear clipping alone made slivers: along a straight footway it joined
 * vertices eighty units apart into triangles a hair wide, and a body in one
 * could not be told which way was out (a route's portal half the street away,
 * a vertex shared by a fan of dozens). So long edges are split first, and the
 * ear-clipped triangles are then flipped until no triangle's circumcircle
 * holds the far corner of its neighbour (Lawson's algorithm), with the
 * polygon's own edges held fixed: a constrained Delaunay triangulation.
 */
function triangulate(poly: PathD[], region: number, layer: number, id: number, out: Tri[]): void {
  const flat: number[] = [];
  const holes: number[] = [];
  const fixed = new Set<number>();
  const K = 1 << 20;
  const key = (a: number, b: number): number => (a < b ? a * K + b : b * K + a);
  for (let r = 0; r < poly.length; r++) {
    const ring = poly[r]!;
    if (ring.length < 3) continue;
    if (r > 0) holes.push(flat.length / 2);
    const start = flat.length / 2;
    for (let i = 0; i < ring.length; i++) {
      const p = ring[i]!, q = ring[(i + 1) % ring.length]!;
      flat.push(p.x, p.y);
      const pieces = Math.ceil(Math.hypot(q.x - p.x, q.y - p.y) / MAX_EDGE);
      for (let j = 1; j < pieces; j++) flat.push(p.x + ((q.x - p.x) * j) / pieces, p.y + ((q.y - p.y) * j) / pieces);
    }
    const end = flat.length / 2;
    for (let v = start; v < end; v++) fixed.add(key(v, v + 1 < end ? v + 1 : start));
  }
  const X = (v: number): number => flat[v * 2]!;
  const Y = (v: number): number => flat[v * 2 + 1]!;
  const orient = (a: number, b: number, c: number): number => (X(b) - X(a)) * (Y(c) - Y(a)) - (X(c) - X(a)) * (Y(b) - Y(a));
  const idx = earcut(flat, holes.length ? holes : undefined, 2);
  const tris: [number, number, number][] = [];
  for (let i = 0; i < idx.length; i += 3) {
    const a = idx[i]!, b = idx[i + 1]!, c = idx[i + 2]!;
    const o = orient(a, b, c);
    // Three points of one split edge: no area, nothing to stand on.
    if (Math.abs(o) < 2e-6) continue;
    tris.push(o > 0 ? [a, b, c] : [a, c, b]);
  }
  // Which triangles hold each edge.
  const edges = new Map<number, number[]>();
  const addEdges = (t: number): void => {
    const [a, b, c] = tris[t]!;
    for (const [u, v] of [[a, b], [b, c], [c, a]] as const) {
      const k = key(u, v);
      const list = edges.get(k);
      if (list) list.push(t); else edges.set(k, [t]);
    }
  };
  const dropEdges = (t: number): void => {
    const [a, b, c] = tris[t]!;
    for (const [u, v] of [[a, b], [b, c], [c, a]] as const) {
      const list = edges.get(key(u, v));
      if (list) { const i = list.indexOf(t); if (i >= 0) list.splice(i, 1); }
    }
  };
  for (let t = 0; t < tris.length; t++) addEdges(t);
  const inCircle = (a: number, b: number, c: number, d: number): number => {
    const ax = X(a) - X(d), ay = Y(a) - Y(d);
    const bx = X(b) - X(d), by = Y(b) - Y(d);
    const cx = X(c) - X(d), cy = Y(c) - Y(d);
    return (ax * ax + ay * ay) * (bx * cy - cx * by) - (bx * bx + by * by) * (ax * cy - cx * ay) +
      (cx * cx + cy * cy) * (ax * by - bx * ay);
  };
  const queue: number[] = [...edges.keys()].filter((k) => !fixed.has(k));
  let budget = tris.length * 20;
  while (queue.length && budget-- > 0) {
    const k = queue.pop()!;
    if (fixed.has(k)) continue;
    const pair = edges.get(k);
    if (!pair || pair.length !== 2) continue;
    const [t1, t2] = pair as [number, number];
    // t1 = (a, b, c) with the shared edge a -> b; t2 holds b -> a and d.
    const r1 = tris[t1]!, r2 = tris[t2]!;
    let a = -1, b = -1, c = -1, d = -1;
    for (let i = 0; i < 3; i++) {
      const u = r1[i]!, v = r1[(i + 1) % 3]!;
      if (key(u, v) === k) { a = u; b = v; c = r1[(i + 2) % 3]!; }
    }
    for (let i = 0; i < 3; i++) if (r2[i] !== a && r2[i] !== b) d = r2[i]!;
    if (a < 0 || d < 0) continue;
    if (inCircle(a, b, c, d) <= 1e-9) continue;
    // Only a convex quadrilateral can be flipped.
    if (orient(a, d, c) <= 1e-12 || orient(d, b, c) <= 1e-12) continue;
    dropEdges(t1); dropEdges(t2);
    tris[t1] = [a, d, c];
    tris[t2] = [d, b, c];
    addEdges(t1); addEdges(t2);
    for (const e of [key(a, d), key(d, b), key(b, c), key(c, a)]) if (!fixed.has(e)) queue.push(e);
  }
  for (const [a, b, c] of tris) {
    out.push({ pts: [X(a), Y(a), X(b), Y(b), X(c), Y(c)], region, layer, poly: id });
  }
}

/**
 * Joins triangles along shared edges. Triangles of one polygon share exact
 * vertices; the footway and a zebra were cut from the same shape along the
 * same line, so their edges lie on one line without sharing vertices. Any two
 * collinear, overlapping edges of different triangles become a portal over
 * their overlap.
 */
function link(tris: Tri[]): NavPortal[][] {
  const portals: NavPortal[][] = tris.map(() => []);
  const edge = (t: number, e: number): [number, number, number, number] => {
    const p = tris[t]!.pts;
    const i = e * 2, j = ((e + 1) % 3) * 2;
    return [p[i]!, p[i + 1]!, p[j]!, p[j + 1]!];
  };
  // Inside one polygon, triangles share exact vertices: an edge and its twin
  // are the same two points the other way round. Matching them exactly keeps
  // a sliver - earcut leaves long thin ones along straight footways - from
  // being mistaken for the edge beside it, which is what a tolerance did.
  const vkey = (x: number, y: number): string => `${x},${y}`;
  const twins = new Map<string, [number, number]>();
  for (let t = 0; t < tris.length; t++) {
    for (let e = 0; e < 3; e++) {
      const [ax, ay, bx, by] = edge(t, e);
      twins.set(`${tris[t]!.poly}|${vkey(ax, ay)}|${vkey(bx, by)}`, [t, e]);
    }
  }
  const boundary: [number, number][] = [];
  for (let t = 0; t < tris.length; t++) {
    for (let e = 0; e < 3; e++) {
      const [ax, ay, bx, by] = edge(t, e);
      const twin = twins.get(`${tris[t]!.poly}|${vkey(bx, by)}|${vkey(ax, ay)}`);
      // Seen from t (counter-clockwise) the edge runs a -> b with the
      // triangle on its left; walking out across it, b is on the left.
      if (twin) portals[t]!.push({ to: twin[0], lx: bx, ly: by, rx: ax, ry: ay });
      else boundary.push([t, e]);
    }
  }
  // Between polygons (the footway and a zebra, two decks at a ramp) the
  // pieces were cut along one line without sharing vertices: boundary edges
  // that lie on one line, the other way round, are joined over their overlap.
  const EDGE_CELL = 4;
  const buckets = new Map<number, [number, number][]>();
  for (const [t, e] of boundary) {
    const [ax, ay, bx, by] = edge(t, e);
    const key = cellKey(Math.floor((ax + bx) / 2 / EDGE_CELL), Math.floor((ay + by) / 2 / EDGE_CELL));
    const list = buckets.get(key);
    if (list) list.push([t, e]);
    else buckets.set(key, [[t, e]]);
  }
  // Clipping rounds to 1e-3; two edges cut along one line may sit that far apart.
  const EPS = 1e-2;
  const MIN_OVERLAP = 0.05;
  for (const [t, e] of boundary) {
    const [ax, ay, bx, by] = edge(t, e);
    const len = Math.hypot(bx - ax, by - ay);
    if (len < MIN_OVERLAP) continue;
    const ux = (bx - ax) / len, uy = (by - ay) / len;
    const x0 = Math.min(ax, bx), x1 = Math.max(ax, bx), y0 = Math.min(ay, by), y1 = Math.max(ay, by);
    for (let cx = Math.floor(x0 / EDGE_CELL) - 1; cx <= Math.floor(x1 / EDGE_CELL) + 1; cx++) {
      for (let cy = Math.floor(y0 / EDGE_CELL) - 1; cy <= Math.floor(y1 / EDGE_CELL) + 1; cy++) {
        for (const [u, f] of buckets.get(cellKey(cx, cy)) ?? []) {
          if (tris[u]!.poly === tris[t]!.poly) continue;
          const [cxp, cyp, dxp, dyp] = edge(u, f);
          const off1 = (cxp - ax) * -uy + (cyp - ay) * ux;
          const off2 = (dxp - ax) * -uy + (dyp - ay) * ux;
          if (Math.abs(off1) > EPS || Math.abs(off2) > EPS) continue;
          const s1 = (cxp - ax) * ux + (cyp - ay) * uy;
          const s2 = (dxp - ax) * ux + (dyp - ay) * uy;
          if (s1 <= s2) continue; // same winding: not across the edge from us
          const lo = Math.max(0, s2), hi = Math.min(len, s1);
          if (hi - lo < MIN_OVERLAP) continue;
          portals[t]!.push({ to: u, lx: ax + ux * hi, ly: ay + uy * hi, rx: ax + ux * lo, ry: ay + uy * lo });
        }
      }
    }
  }
  return portals;
}

/** Builds the mesh. Pure: the same input gives the same triangles in the same order. */
export function buildNavMesh(input: NavInput): NavMesh {
  const crossings = input.crossings;
  const road = toPaths(input.road);
  const zebras: PathsD[] = crossings.map((c) => intersectD([rect(c, INTO_FOOTWAY)], road, FillRule.NonZero, PRECISION));
  const allZebras = unionD(zebras.flat(), [], FillRule.NonZero, PRECISION);
  // The walkable union takes each zebra's whole band, which runs on into the
  // footway at both ends: the zebra cut to the road only TOUCHES the footway
  // along the kerb, and a touch that rounding opens by a hair became, once the
  // mesh was shrunk by a body's radius, a gap nobody could step across -
  // measured, 24 of 55 zebras joined to the footway at one end only.
  const walk = unionD([...input.layers.flatMap(toPaths), ...crossings.map((c) => rect(c, INTO_FOOTWAY))], [], FillRule.NonZero, PRECISION);
  const blocked: PathsD = [
    ...input.obstacles.map((o) => disc(o.x, o.y, o.r)),
    ...input.solids.map((ring) => ccw(ring.map((p) => ({ x: p.x, y: p.y })))),
  ];
  const open = blocked.length ? differenceD(walk, unionD(blocked, [], FillRule.NonZero, PRECISION), FillRule.NonZero, PRECISION) : walk;
  const eroded = inflatePathsD(open, -NAV_RADIUS, JoinType.Round, EndType.Polygon, 2, PRECISION, 0.05);

  const tris: Tri[] = [];
  let polyId = 0;
  const footway = differenceD(eroded, allZebras, FillRule.NonZero, PRECISION);
  input.layers.forEach((deck, layer) => {
    const part = intersectD(footway, unionD(toPaths(deck), [], FillRule.NonZero, PRECISION), FillRule.NonZero, PRECISION);
    for (const poly of polygons(part)) triangulate(poly, FOOTWAY, layer, polyId++, tris);
  });
  zebras.forEach((zebra, i) => {
    const part = intersectD(eroded, zebra, FillRule.NonZero, PRECISION);
    for (const poly of polygons(part)) triangulate(poly, i, input.crossingLayers[i] ?? 0, polyId++, tris);
  });
  const portals = link(tris);
  const flat: number[] = [];
  for (const t of tris) flat.push(...t.pts);
  return new NavMesh(flat, tris.map((t) => t.region), tris.map((t) => t.layer), portals, crossings);
}
