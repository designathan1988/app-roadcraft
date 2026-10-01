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
/** Half the narrowest passage the mesh keeps open for body centres, u (so passages under 0.4 m between walls close). */
export const NAV_PINCH = 0.5; // 0.2 m

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
  /**
   * The kerb stone beside each deck's footway: walkable, but a route keeps
   * off it (`KERB`) - walkers only step onto it to get past somebody.
   */
  readonly kerbs?: readonly MultiPoly[];
  /** The deck each zebra lies on, an index into `layers`. */
  readonly crossingLayers: readonly number[];
  /** The road surface a zebra may cover: carriageway plus kerb. */
  readonly road: MultiPoly;
  readonly crossings: readonly NavCrossingInput[];
  readonly obstacles: readonly NavObstacle[];
  /** Solid footprints (buildings), as rings. */
  readonly solids: readonly (readonly { x: number; y: number }[])[];
  /** Paths across open ground, from the footway to a door: walkable, not footway. */
  readonly paths?: readonly NavStrip[];
}

/** A straight walkable strip, `halfWidth` either side of a to b. */
export interface NavStrip {
  readonly ax: number;
  readonly ay: number;
  readonly bx: number;
  readonly by: number;
  readonly halfWidth: number;
}

/** A triangle's region: footway, open ground, or the zebra with this index in `NavMesh.crossings`. */
export const FOOTWAY = -1;
export const OPEN = -2;
export const KERB = -3;
/** Whether a region is a zebra: a gate that has to be granted. */
export const isZebra = (region: number): boolean => region >= 0;

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
  /**
   * Per triangle: the connected piece of walkable ground it belongs to. Two
   * triangles in different pieces have no route between them, known at once:
   * a search for one used to expand thousands of triangles to find that out,
   * one tick in eight, and those were the long ticks.
   */
  readonly piece: Int32Array;
  private readonly grid = new Map<number, number[]>();
  /** Every wall: the edges no portal leads through, 4 numbers each. */
  private readonly walls: number[] = [];
  /** Per wall: the unit normal pointing into the triangle it bounds, and that triangle's deck. */
  private readonly wallNormals: number[] = [];
  private readonly wallLayer: number[] = [];
  private readonly wallGrid = new Map<number, number[]>();

  constructor(tri: number[], region: number[], layer: number[], portals: NavPortal[][], crossings: readonly NavCrossingInput[]) {
    this.tri = Float64Array.from(tri);
    this.region = Int32Array.from(region);
    this.layer = Int32Array.from(layer);
    this.portals = portals;
    this.crossings = crossings;
    this.count = region.length;
    this.piece = new Int32Array(this.count).fill(-1);
    {
      // Portals taken both ways: a piece may be too generous, never too strict.
      const near: number[][] = Array.from({ length: this.count }, () => []);
      for (let t = 0; t < this.count; t++) for (const p of portals[t]!) { near[t]!.push(p.to); near[p.to]?.push(t); }
      let pieces = 0;
      const stack: number[] = [];
      for (let t0 = 0; t0 < this.count; t0++) {
        if (this.piece[t0] !== -1) continue;
        this.piece[t0] = pieces;
        stack.push(t0);
        while (stack.length) {
          const t = stack.pop()!;
          for (const u of near[t]!) if (this.piece[u] === -1) { this.piece[u] = pieces; stack.push(u); }
        }
        pieces++;
      }
    }
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
          const cx = (this.tri[o]! + this.tri[o + 2]! + this.tri[o + 4]!) / 3, cy = (this.tri[o + 1]! + this.tri[o + 3]! + this.tri[o + 5]!) / 3;
          const inward = (cx - ax) * -uy + (cy - ay) * ux >= 0 ? 1 : -1;
          this.wallNormals.push(-uy * inward, ux * inward);
          this.wallLayer.push(this.layer[t]!);
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
    const d1 = (bx - ax) * (y - ay) - (by - ay) * (x - ax);
    const d2 = (cx - bx) * (y - by) - (cy - by) * (x - bx);
    const d3 = (ax - cx) * (y - cy) - (ay - cy) * (x - cx);
    if (d1 >= 0 && d2 >= 0 && d3 >= 0) return true;
    // Outside: near enough only if near the triangle itself. Measured against
    // the lines of its edges instead, a thin triangle took in points far out
    // past its sharp ends, and a body stepping there was pulled back 1 m.
    const q = closestOnTriangle(this.tri, t, x, y);
    return (q.x - x) ** 2 + (q.y - y) ** 2 <= eps * eps;
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

  /** Every zebra mouth: an edge from walkable ground onto a zebra (x0 y0 x1 y1 nx ny, the normal pointing off the zebra), and its crossing. */
  private mouths: number[] | null = null;
  private mouthCrossing: number[] = [];
  private mouthLayer: number[] = [];
  private readonly mouthGrid = new Map<number, number[]>();

  private indexMouths(): void {
    const m: number[] = [];
    for (let t = 0; t < this.count; t++) {
      if (isZebra(this.region[t]!)) continue;
      const c = this.centroid(t);
      for (const p of this.portals[t]!) {
        const z = this.region[p.to]!;
        if (!isZebra(z)) continue;
        const ex = p.rx - p.lx, ey = p.ry - p.ly;
        const len = Math.hypot(ex, ey) || 1;
        let nx = -ey / len, ny = ex / len;
        if ((c.x - p.lx) * nx + (c.y - p.ly) * ny < 0) { nx = -nx; ny = -ny; }
        const i = m.length / 6;
        m.push(p.lx, p.ly, p.rx, p.ry, nx, ny);
        this.mouthCrossing.push(z);
        this.mouthLayer.push(this.layer[t]!);
        for (let cx = wcell(Math.min(p.lx, p.rx)); cx <= wcell(Math.max(p.lx, p.rx)); cx++) {
          for (let cy = wcell(Math.min(p.ly, p.ry)); cy <= wcell(Math.max(p.ly, p.ry)); cy++) {
            const key = cellKey(cx, cy);
            const list = this.mouthGrid.get(key);
            if (list) list.push(i); else this.mouthGrid.set(key, [i]);
          }
        }
      }
    }
    this.mouths = m;
  }

  /**
   * Calls `visit` with the ends of every wall segment of deck `layer` that
   * comes within `reach` of the point, and its normal pointing into the
   * walkable side. Only that deck's: seen from above, the walls of a bridge
   * lie across the pavement under it.
   */
  wallSegmentsNear(x: number, y: number, reach: number, layer: number, visit: (ax: number, ay: number, bx: number, by: number, nx: number, ny: number) => void): void {
    // Every person asks every tick: a visit stamp instead of a Set, and the
    // distance worked out in place (as `closestOnSegment` does it).
    const stamp = this.nextStamp();
    const seen = this.wallSeen ??= new Uint32Array(this.walls.length / 4);
    const w = this.walls;
    for (let cx = wcell(x - reach); cx <= wcell(x + reach); cx++) {
      for (let cy = wcell(y - reach); cy <= wcell(y + reach); cy++) {
        const list = this.wallGrid.get(cellKey(cx, cy));
        if (!list) continue;
        for (const i of list) {
          if (seen[i] === stamp) continue;
          seen[i] = stamp;
          if (this.wallLayer[i] !== layer) continue;
          const ax = w[i * 4]!, ay = w[i * 4 + 1]!, bx = w[i * 4 + 2]!, by = w[i * 4 + 3]!;
          if (segmentDistance(ax, ay, bx, by, x, y) < reach) visit(ax, ay, bx, by, this.wallNormals[i * 2]!, this.wallNormals[i * 2 + 1]!);
        }
      }
    }
  }

  private wallSeen: Uint32Array | null = null;
  private mouthSeen: Uint32Array | null = null;
  private stamp = 0;
  private nextStamp(): number {
    if (++this.stamp === 0xffffffff) {
      this.stamp = 1;
      this.wallSeen?.fill(0);
      this.mouthSeen?.fill(0);
    }
    return this.stamp;
  }

  /** Like `mouthsNear`, with the mouth's ends: `visit(crossing, ax, ay, bx, by, nx, ny)`, the normal pointing off the zebra. */
  mouthSegmentsNear(x: number, y: number, reach: number, layer: number, visit: (crossing: number, ax: number, ay: number, bx: number, by: number, nx: number, ny: number) => void): void {
    if (!this.mouths) this.indexMouths();
    const m = this.mouths!;
    const stamp = this.nextStamp();
    const seen = this.mouthSeen ??= new Uint32Array(m.length / 6);
    for (let cx = wcell(x - reach); cx <= wcell(x + reach); cx++) {
      for (let cy = wcell(y - reach); cy <= wcell(y + reach); cy++) {
        const list = this.mouthGrid.get(cellKey(cx, cy));
        if (!list) continue;
        for (const i of list) {
          if (seen[i] === stamp) continue;
          seen[i] = stamp;
          if (this.mouthLayer[i] !== layer) continue;
          if (segmentDistance(m[i * 6]!, m[i * 6 + 1]!, m[i * 6 + 2]!, m[i * 6 + 3]!, x, y) < reach) visit(this.mouthCrossing[i]!, m[i * 6]!, m[i * 6 + 1]!, m[i * 6 + 2]!, m[i * 6 + 3]!, m[i * 6 + 4]!, m[i * 6 + 5]!);
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

/** Distance from (x, y) to the segment a-b: `closestOnSegment`'s arithmetic, without the object. */
function segmentDistance(ax: number, ay: number, bx: number, by: number, x: number, y: number): number {
  const dx = bx - ax, dy = by - ay;
  const len = dx * dx + dy * dy;
  const t = len > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len)) : 0;
  return Math.hypot(ax + dx * t - x, ay + dy * t - y);
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

/** A point surely inside a simple ring: the middle of its first triangle of ear clipping. */
function interiorPoint(ring: PathD): { x: number; y: number } {
  const flat: number[] = [];
  for (const p of ring) flat.push(p.x, p.y);
  const idx = earcut(flat);
  if (idx.length < 3) return ring[0] ?? { x: 0, y: 0 };
  const [a, b, c] = [idx[0]!, idx[1]!, idx[2]!];
  return { x: (flat[a * 2]! + flat[b * 2]! + flat[c * 2]!) / 3, y: (flat[a * 2 + 1]! + flat[b * 2 + 1]! + flat[c * 2 + 1]!) / 3 };
}

function insideRing(ring: PathD, x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]!, b = ring[j]!;
    if ((a.y > y) !== (b.y > y) && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

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

interface Tri {
  pts: number[];
  region: number;
  layer: number;
  /** the polygon it was cut from */
  poly: number;
  /** Its corners' vertex numbers, unique across the mesh: shared corners share a number. */
  v: [number, number, number];
}

/** Next free vertex number, while one mesh is built. */
let nextVertex = 0;

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
  const K = 1 << 20;
  for (let r = 0; r < poly.length; r++) {
    const ring = poly[r]!;
    if (ring.length < 3) continue;
    if (r > 0) holes.push(flat.length / 2);
    for (let i = 0; i < ring.length; i++) {
      const p = ring[i]!, q = ring[(i + 1) % ring.length]!;
      flat.push(p.x, p.y);
      const pieces = Math.ceil(Math.hypot(q.x - p.x, q.y - p.y) / MAX_EDGE);
      for (let j = 1; j < pieces; j++) flat.push(p.x + ((q.x - p.x) * j) / pieces, p.y + ((q.y - p.y) * j) / pieces);
    }
  }
  const X = (v: number): number => flat[v * 2]!;
  const Y = (v: number): number => flat[v * 2 + 1]!;
  const orient = (a: number, b: number, c: number): number => (X(b) - X(a)) * (Y(c) - Y(a)) - (X(c) - X(a)) * (Y(b) - Y(a));
  const idx = earcut(flat, holes.length ? holes : undefined, 2);
  // Triangles as corner triples, and for each edge the triangle across it
  // (-1 on the polygon's own outline, which is exactly what stays fixed).
  const corners: number[] = [];
  for (let i = 0; i < idx.length; i += 3) {
    const a = idx[i]!, b = idx[i + 1]!, c = idx[i + 2]!;
    const o = orient(a, b, c);
    // Three points of one split edge: no area, nothing to stand on.
    if (Math.abs(o) < 2e-6) continue;
    if (o > 0) corners.push(a, b, c); else corners.push(a, c, b);
  }
  const T = Int32Array.from(corners);
  const count = T.length / 3;
  const across = new Int32Array(T.length).fill(-1);
  const half = new Map<number, number>();
  for (let h = 0; h < T.length; h++) half.set(T[h]! * K + T[h - (h % 3) + ((h % 3) + 1) % 3]!, h);
  for (let h = 0; h < T.length; h++) {
    const twin = half.get(T[h - (h % 3) + ((h % 3) + 1) % 3]! * K + T[h]!);
    if (twin !== undefined) across[h] = twin;
  }
  const inCircle = (a: number, b: number, c: number, d: number): number => {
    const ax = X(a) - X(d), ay = Y(a) - Y(d);
    const bx = X(b) - X(d), by = Y(b) - Y(d);
    const cx = X(c) - X(d), cy = Y(c) - Y(d);
    return (ax * ax + ay * ay) * (bx * cy - cx * by) - (bx * bx + by * by) * (ax * cy - cx * ay) +
      (cx * cx + cy * cy) * (ax * by - bx * ay);
  };
  // Half-edge h = 3t + i runs T[3t+i] -> T[3t+(i+1)%3]; across[h] is its twin.
  const next = (h: number): number => h - (h % 3) + ((h % 3) + 1) % 3;
  const prev = (h: number): number => h - (h % 3) + ((h % 3) + 2) % 3;
  const link2 = (h: number, g: number): void => { across[h] = g; if (g >= 0) across[g] = h; };
  const stack: number[] = [];
  for (let h = 0; h < T.length; h++) if (across[h]! > h) stack.push(h);
  let budget = count * 30;
  while (stack.length && budget-- > 0) {
    const h = stack.pop()!;
    const g = across[h]!;
    if (g < 0) continue;
    // t = (a, b, c) with h = a -> b; u = (b, a, d) with g = b -> a.
    const a = T[h]!, b = T[next(h)]!, c = T[prev(h)]!, d = T[prev(g)]!;
    if (T[g] !== b || T[next(g)] !== a) continue;
    if (inCircle(a, b, c, d) <= 1e-9) continue;
    if (orient(a, d, c) <= 1e-12 || orient(d, b, c) <= 1e-12) continue;
    const t0 = h - (h % 3), u0 = g - (g % 3);
    // Outer neighbours before the flip.
    const bc = across[next(h)]!, ca = across[prev(h)]!, ad = across[next(g)]!, db = across[prev(g)]!;
    // New t = (a, d, c), new u = (d, b, c).
    T[t0] = a; T[t0 + 1] = d; T[t0 + 2] = c;
    T[u0] = d; T[u0 + 1] = b; T[u0 + 2] = c;
    link2(t0, ad); link2(t0 + 1, u0 + 2); link2(t0 + 2, ca);
    link2(u0, db); link2(u0 + 1, bc);
    stack.push(t0, t0 + 2, u0, u0 + 1);
  }
  const tris: [number, number, number][] = [];
  for (let i = 0; i < count; i++) tris.push([T[i * 3]!, T[i * 3 + 1]!, T[i * 3 + 2]!]);
  const base = nextVertex;
  nextVertex += flat.length / 2;
  for (const [a, b, c] of tris) {
    out.push({ pts: [X(a), Y(a), X(b), Y(b), X(c), Y(c)], region, layer, poly: id, v: [base + a, base + b, base + c] });
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
  const V = 1 << 24;
  const twins = new Map<number, [number, number]>();
  for (let t = 0; t < tris.length; t++) {
    const v = tris[t]!.v;
    for (let e = 0; e < 3; e++) twins.set(v[e]! * V + v[(e + 1) % 3]!, [t, e]);
  }
  const boundary: [number, number][] = [];
  for (let t = 0; t < tris.length; t++) {
    const v = tris[t]!.v;
    for (let e = 0; e < 3; e++) {
      const [ax, ay, bx, by] = edge(t, e);
      const twin = twins.get(v[(e + 1) % 3]! * V + v[e]!);
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
  const strips = (input.paths ?? []).map((s) => rect({ id: '', ...s }, 0));
  const kerbs = (input.kerbs ?? []).map((k) => unionD(toPaths(k), [], FillRule.NonZero, PRECISION));
  const walk = unionD([...input.layers.flatMap(toPaths), ...kerbs.flat(), ...crossings.map((c) => rect(c, INTO_FOOTWAY)), ...strips], [], FillRule.NonZero, PRECISION);
  const blocked: PathsD = [
    ...input.obstacles.map((o) => disc(o.x, o.y, o.r)),
    ...input.solids.map((ring) => ccw(ring.map((p) => ({ x: p.x, y: p.y })))),
  ];
  const open = blocked.length ? differenceD(walk, unionD(blocked, [], FillRule.NonZero, PRECISION), FillRule.NonZero, PRECISION) : walk;
  // Shrunk by a body's radius, and then by a little more and grown back by
  // that little (a morphological opening): any passage narrower than a body
  // can walk is closed. Without it a hair-wide gap was left between a street
  // tree and the kerb, routes squeezed through it, and walkers stuck there
  // jerking to get out.
  const shrunk = inflatePathsD(open, -(NAV_RADIUS + NAV_PINCH), JoinType.Round, EndType.Polygon, 2, PRECISION, 0.05);
  const eroded = inflatePathsD(shrunk, NAV_PINCH, JoinType.Round, EndType.Polygon, 2, PRECISION, 0.05);

  const tris: Tri[] = [];
  let polyId = 0;
  nextVertex = 0;
  const allKerbs = kerbs.length ? unionD(kerbs.flat(), [], FillRule.NonZero, PRECISION) : [];
  const onFoot = differenceD(eroded, allZebras, FillRule.NonZero, PRECISION);
  const footway = allKerbs.length ? differenceD(onFoot, allKerbs, FillRule.NonZero, PRECISION) : onFoot;
  kerbs.forEach((kerb, layer) => {
    for (const poly of polygons(intersectD(onFoot, kerb, FillRule.NonZero, PRECISION))) triangulate(poly, KERB, layer, polyId++, tris);
  });
  input.layers.forEach((deck, layer) => {
    // One deck is the whole footway; only with several is each cut out.
    const part = input.layers.length === 1 ? footway
      : intersectD(footway, unionD(toPaths(deck), [], FillRule.NonZero, PRECISION), FillRule.NonZero, PRECISION);
    for (const poly of polygons(part)) triangulate(poly, FOOTWAY, layer, polyId++, tris);
  });
  // Every zebra at once, each piece then told which zebra it is by where it
  // lies: one clip instead of one per crossing.
  const bands = crossings.map((c) => rect(c, INTO_FOOTWAY));
  for (const poly of polygons(intersectD(eroded, allZebras, FillRule.NonZero, PRECISION))) {
    const probe = interiorPoint(poly[0]!);
    let which = 0;
    for (let i = 0; i < bands.length; i++) if (insideRing(bands[i]!, probe.x, probe.y)) { which = i; break; }
    triangulate(poly, which, input.crossingLayers[which] ?? 0, polyId++, tris);
  }
  // Open ground: a path to a door, wherever it is not footway.
  if (strips.length) {
    const footwayRings = input.layers.flatMap(toPaths);
    for (const t of tris) {
      if (t.region !== FOOTWAY) continue;
      const cx = (t.pts[0]! + t.pts[2]! + t.pts[4]!) / 3, cy = (t.pts[1]! + t.pts[3]! + t.pts[5]!) / 3;
      if (!strips.some((s) => insideRing(s, cx, cy))) continue;
      let inside = false;
      for (const ring of footwayRings) if (insideRing(ring, cx, cy)) inside = !inside;
      if (!inside) t.region = OPEN;
    }
  }
  const portals = link(tris);
  const flat: number[] = [];
  for (const t of tris) flat.push(...t.pts);
  return new NavMesh(flat, tris.map((t) => t.region), tris.map((t) => t.layer), portals, crossings);
}
