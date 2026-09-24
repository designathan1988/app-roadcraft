import { EPS, FINE_EPS, clamp } from './scalar';
import { type Vec2, perp } from './vec2';
import { type Aabb, fromFlat } from './aabb';

/** A position on a polyline, with its local frame. */
export interface Frame {
  /** Position in world space. */
  readonly p: Vec2;
  /** Unit tangent, pointing forward along the polyline. */
  readonly t: Vec2;
  /** Unit left normal, `perp(t)`. */
  readonly n: Vec2;
  /** Index of the containing segment. */
  readonly i: number;
  /** Parametric position within that segment, in [0,1]. */
  readonly u: number;
  /** Arc length from the start. */
  readonly s: number;
}

/**
 * An immutable polyline with lazily-built arc-length, tangent and bbox tables.
 *
 * Immutability is load-bearing: the geometry cache stores these by identity and
 * a change produces a *new* object, so "is this stale?" never has to be asked.
 * The V6 monolith rebuilt a fresh point array on every `segmentPoints()` call —
 * dozens of times per segment per frame.
 */
export class Polyline {
  /** Flat [x0,y0,x1,y1,...]. Never mutated after construction. */
  readonly xy: Float64Array;
  /** Number of points. */
  readonly n: number;

  private _cum: Float64Array | null = null;
  private _tan: Float64Array | null = null;
  private _bbox: Aabb | null = null;
  private _chunks: Float64Array | null = null;

  private constructor(xy: Float64Array) {
    this.xy = xy;
    this.n = xy.length >> 1;
  }

  static fromPoints(points: readonly Vec2[]): Polyline {
    const xy = new Float64Array(points.length * 2);
    for (let i = 0; i < points.length; i++) {
      const p = points[i] as Vec2;
      xy[i * 2] = p.x;
      xy[i * 2 + 1] = p.y;
    }
    return new Polyline(xy);
  }

  static fromFlat(xy: Float64Array): Polyline {
    return new Polyline(xy);
  }

  point(i: number): Vec2 {
    const k = i * 2;
    return { x: this.xy[k] as number, y: this.xy[k + 1] as number };
  }

  toPoints(): Vec2[] {
    const out: Vec2[] = new Array(this.n);
    for (let i = 0; i < this.n; i++) out[i] = this.point(i);
    return out;
  }

  /** cum[i] = arc length from point 0 to point i. */
  get cum(): Float64Array {
    if (this._cum) return this._cum;
    const c = new Float64Array(this.n);
    let acc = 0;
    for (let i = 1; i < this.n; i++) {
      const dx = (this.xy[i * 2] as number) - (this.xy[i * 2 - 2] as number);
      const dy = (this.xy[i * 2 + 1] as number) - (this.xy[i * 2 - 1] as number);
      acc += Math.hypot(dx, dy);
      c[i] = acc;
    }
    this._cum = c;
    return c;
  }

  /** Unit tangents, one per segment: [tx0,ty0,tx1,ty1,...] of length 2*(n-1). */
  get tan(): Float64Array {
    if (this._tan) return this._tan;
    const segs = Math.max(0, this.n - 1);
    const t = new Float64Array(segs * 2);
    for (let i = 0; i < segs; i++) {
      const dx = (this.xy[i * 2 + 2] as number) - (this.xy[i * 2] as number);
      const dy = (this.xy[i * 2 + 3] as number) - (this.xy[i * 2 + 1] as number);
      const l = Math.hypot(dx, dy);
      if (l < EPS) {
        t[i * 2] = 1;
        t[i * 2 + 1] = 0;
      } else {
        t[i * 2] = dx / l;
        t[i * 2 + 1] = dy / l;
      }
    }
    this._tan = t;
    return t;
  }

  get bbox(): Aabb {
    if (this._bbox) return this._bbox;
    this._bbox = fromFlat(this.xy, this.n);
    return this._bbox;
  }

  get length(): number {
    return this.n < 2 ? 0 : (this.cum[this.n - 1] as number);
  }

  /** Segment index containing arc length `s`, via binary search on `cum`. */
  private segmentAt(s: number): number {
    const cum = this.cum;
    let lo = 0;
    let hi = this.n - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((cum[mid + 1] as number) < s) lo = mid + 1;
      else hi = mid;
    }
    return Math.min(lo, this.n - 2);
  }

  /** Frame at arc length `s`, clamped to the polyline. */
  sampleAt(s: number): Frame {
    if (this.n === 0) {
      return { p: { x: 0, y: 0 }, t: { x: 1, y: 0 }, n: { x: 0, y: 1 }, i: 0, u: 0, s: 0 };
    }
    if (this.n === 1) {
      const p = this.point(0);
      return { p, t: { x: 1, y: 0 }, n: { x: 0, y: 1 }, i: 0, u: 0, s: 0 };
    }
    const total = this.length;
    const sc = clamp(s, 0, total);
    const i = this.segmentAt(sc);
    const cum = this.cum;
    const s0 = cum[i] as number;
    const segLen = (cum[i + 1] as number) - s0;
    const u = segLen < EPS ? 0 : (sc - s0) / segLen;
    const ax = this.xy[i * 2] as number;
    const ay = this.xy[i * 2 + 1] as number;
    const bx = this.xy[i * 2 + 2] as number;
    const by = this.xy[i * 2 + 3] as number;
    const t: Vec2 = { x: this.tan[i * 2] as number, y: this.tan[i * 2 + 1] as number };
    return {
      p: { x: ax + (bx - ax) * u, y: ay + (by - ay) * u },
      t,
      n: perp(t),
      i,
      u,
      s: sc,
    };
  }

  /** Frame at normalized position `f` in [0,1]. */
  sampleNorm(f: number): Frame {
    return this.sampleAt(clamp(f, 0, 1) * this.length);
  }

  tangentAt(s: number): Vec2 {
    return this.sampleAt(s).t;
  }

  /**
   * Sub-polyline between two arc lengths, with exact endpoints inserted.
   * Returns a polyline of at least 2 points whenever `s1 > s0`.
   */
  sub(s0: number, s1: number): Polyline {
    const total = this.length;
    const a = clamp(Math.min(s0, s1), 0, total);
    const b = clamp(Math.max(s0, s1), 0, total);
    if (this.n < 2 || b - a < EPS) {
      const f = this.sampleAt(a);
      return Polyline.fromPoints([f.p, f.p]);
    }
    const fa = this.sampleAt(a);
    const fb = this.sampleAt(b);
    const pts: Vec2[] = [fa.p];
    for (let i = fa.i + 1; i <= fb.i; i++) pts.push(this.point(i));
    pts.push(fb.p);
    return Polyline.fromPoints(dedupe(pts));
  }

  reversed(): Polyline {
    const xy = new Float64Array(this.xy.length);
    for (let i = 0; i < this.n; i++) {
      const j = this.n - 1 - i;
      xy[i * 2] = this.xy[j * 2] as number;
      xy[i * 2 + 1] = this.xy[j * 2 + 1] as number;
    }
    return new Polyline(xy);
  }

  /** Bounding boxes of runs of `CHUNK` segments: [minX, minY, maxX, maxY] each. */
  private get chunks(): Float64Array {
    if (this._chunks) return this._chunks;
    const segments = Math.max(0, this.n - 1);
    const count = Math.ceil(segments / CHUNK);
    const boxes = new Float64Array(count * 4);
    for (let c = 0; c < count; c++) {
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      const last = Math.min(this.n - 1, (c + 1) * CHUNK);
      for (let i = c * CHUNK; i <= last; i++) {
        const x = this.xy[i * 2] as number;
        const y = this.xy[i * 2 + 1] as number;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
      boxes[c * 4] = minX;
      boxes[c * 4 + 1] = minY;
      boxes[c * 4 + 2] = maxX;
      boxes[c * 4 + 3] = maxY;
    }
    this._chunks = boxes;
    return boxes;
  }

  /**
   * The segment nearest (px, py): its index, or -1 for a single point, with
   * its parameter and squared distance left in `nearest`.
   *
   * The same arithmetic as `closestOnSegment`, in the same order, so the answer
   * is bit for bit what testing every segment gives - but with no allocation,
   * and skipping every run of segments whose box is already farther away than
   * the best so far. This is the innermost call of the road height field, run
   * several times per mesh vertex: a scan of the whole centreline with two
   * objects allocated per segment was a third of a road rebuild.
   */
  private nearestSegment(px: number, py: number): number {
    const xy = this.xy;
    const segments = this.n - 1;
    const boxes = segments > CHUNK ? this.chunks : null;
    let best = -1;
    let bestSq = Infinity;
    let bestT = 0;
    for (let start = 0; start < segments; start += CHUNK) {
      if (boxes) {
        const c = (start / CHUNK) * 4;
        const dx = Math.max((boxes[c] as number) - px, 0, px - (boxes[c + 2] as number));
        const dy = Math.max((boxes[c + 1] as number) - py, 0, py - (boxes[c + 3] as number));
        // Skipped only when clearly farther, so rounding can never drop a tie.
        if (dx * dx + dy * dy > bestSq * (1 + 1e-9) + 1e-12) continue;
      }
      const end = Math.min(segments, start + CHUNK);
      for (let i = start; i < end; i++) {
        const ax = xy[i * 2] as number;
        const ay = xy[i * 2 + 1] as number;
        const abx = (xy[i * 2 + 2] as number) - ax;
        const aby = (xy[i * 2 + 3] as number) - ay;
        const l2 = abx * abx + aby * aby;
        let t = 0;
        let qx = ax;
        let qy = ay;
        if (l2 >= EPS) {
          t = ((px - ax) * abx + (py - ay) * aby) / l2;
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          qx = ax + abx * t;
          qy = ay + aby * t;
        }
        const ex = px - qx;
        const ey = py - qy;
        const distSq = ex * ex + ey * ey;
        if (distSq < bestSq) {
          bestSq = distSq;
          best = i;
          bestT = t;
        }
      }
    }
    nearest.t = bestT;
    nearest.distSq = bestSq;
    return best;
  }

  /** Nearest point on the polyline to `p`. */
  closestPoint(p: Vec2): { point: Vec2; s: number; distance: number } {
    const i = this.nearestSegment(p.x, p.y);
    if (i < 0) return { point: this.point(0), s: 0, distance: Math.sqrt(nearest.distSq) };
    const cum = this.cum;
    const t = nearest.t;
    const k = i * 2;
    const ax = this.xy[k] as number;
    const ay = this.xy[k + 1] as number;
    const point = {
      x: ax + ((this.xy[k + 2] as number) - ax) * t,
      y: ay + ((this.xy[k + 3] as number) - ay) * t,
    };
    const s = (cum[i] as number) + t * ((cum[i + 1] as number) - (cum[i] as number));
    return { point, s, distance: Math.sqrt(nearest.distSq) };
  }

  /** `closestPoint`'s arc length and distance, written into `out` without allocating. */
  closestInto(px: number, py: number, out: { s: number; distance: number }): void {
    const i = this.nearestSegment(px, py);
    out.distance = Math.sqrt(nearest.distSq);
    if (i < 0) {
      out.s = 0;
      return;
    }
    const cum = this.cum;
    out.s = (cum[i] as number) + nearest.t * ((cum[i + 1] as number) - (cum[i] as number));
  }

  /** Perpendicular distance from `p` to this polyline. */
  distanceTo(p: Vec2): number {
    this.nearestSegment(p.x, p.y);
    return Math.sqrt(nearest.distSq);
  }
}

/** Segments per bounding box in the nearest-point search. */
const CHUNK = 16;
/** Scratch result of `Polyline.nearestSegment`. */
const nearest = { t: 0, distSq: Infinity };

/** Drops consecutive duplicate points. */
export function dedupe(points: readonly Vec2[], eps = FINE_EPS): Vec2[] {
  const out: Vec2[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (!last || Math.hypot(p.x - last.x, p.y - last.y) > eps) out.push(p);
  }
  if (out.length === 1 && points.length > 1) out.push(points[points.length - 1] as Vec2);
  return out;
}

