import { ARC_TOL, EPS, FINE_EPS, MIN_ITER_STEP, normalizeAngle } from './scalar';
import { type Vec2, angleOf, sub } from './vec2';
import { type Aabb, fromPoints } from './aabb';

export type RingEdge =
  | { readonly kind: 'line'; readonly to: Vec2 }
  | {
      readonly kind: 'arc';
      readonly c: Vec2;
      readonly r: number;
      readonly a0: number;
      readonly a1: number;
      /** True when the sweep goes counter-clockwise in math orientation. */
      readonly ccw: boolean;
      /** Arc endpoint, stored so `flatten` never has to recompute it. */
      readonly to: Vec2;
    };

/**
 * A closed boundary made of lines and exact arcs.
 *
 * Arcs stay exact all the way into `Path2D`, so curb returns are crisp at any
 * zoom. The flattened form exists only for validation, hit-testing and
 * containment checks.
 *
 * Winding invariant: every ring handed to the painter must have **positive
 * signed area**. Under a single nonzero fill, a reversed ring would punch a
 * hole instead of contributing to the union, so `ensurePositive()` is mandatory
 * before insertion.
 */
export class Ring {
  readonly start: Vec2;
  readonly edges: readonly RingEdge[];
  private _flat: Vec2[] | null = null;
  private _area: number | null = null;
  private _bbox: Aabb | null = null;

  constructor(start: Vec2, edges: readonly RingEdge[]) {
    this.start = start;
    this.edges = edges;
  }

  get isEmpty(): boolean {
    return this.edges.length < 2;
  }

  /**
   * Vertices approximating the ring, first point NOT repeated at the end.
   *
   * The chordal tolerance is `ARC_TOL` and is not a parameter. It used to be
   * one, but the result was memoised on first call and every later call
   * silently returned the first tolerance's points — so a caller asking for a
   * finer flattening got whatever the first caller happened to want. Since the
   * flattening tolerance is a property of the engine rather than of a call
   * site, and no caller ever passed anything but the default, the parameter is
   * gone rather than the memo.
   */
  flatten(): Vec2[] {
    if (this._flat) return this._flat;
    const tol = ARC_TOL;
    const out: Vec2[] = [this.start];
    for (const e of this.edges) {
      if (e.kind === 'line') {
        out.push(e.to);
      } else {
        const delta = arcDelta(e);
        const r = Math.abs(e.r);
        const maxStep =
          r < tol ? Math.PI : 2 * Math.acos(Math.max(-1, Math.min(1, 1 - tol / r)));
        const steps = Math.max(1, Math.ceil(Math.abs(delta) / Math.max(maxStep, MIN_ITER_STEP)));
        for (let i = 1; i <= steps; i++) {
          const a = e.a0 + (delta * i) / steps;
          out.push({ x: e.c.x + Math.cos(a) * r, y: e.c.y + Math.sin(a) * r });
        }
      }
    }
    // Drop a trailing point that coincides with the start.
    const last = out[out.length - 1];
    if (last && Math.hypot(last.x - this.start.x, last.y - this.start.y) < FINE_EPS) {
      out.pop();
    }
    this._flat = out;
    return out;
  }

  get bbox(): Aabb {
    if (this._bbox) return this._bbox;
    this._bbox = fromPoints(this.flatten());
    return this._bbox;
  }

  /** Shoelace area of the flattened ring. Positive means correct winding. */
  signedArea(): number {
    if (this._area !== null) return this._area;
    const p = this.flatten();
    let a = 0;
    for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
      const pi = p[i] as Vec2;
      const pj = p[j] as Vec2;
      a += pj.x * pi.y - pi.x * pj.y;
    }
    this._area = a / 2;
    return this._area;
  }

  /** Returns this ring, or a reversed copy, whichever has positive area. */
  ensurePositive(): Ring {
    return this.signedArea() >= 0 ? this : this.reversed();
  }

  /**
   * The same boundary traversed the other way, with arcs kept exact.
   *
   * This used to flatten and rebuild through `fromPolygon`, which emits only
   * line edges — so any ring that came out negatively wound silently lost the
   * exact curb returns this class exists to preserve, and `ensurePositive()`
   * calls `reversed()`. The loss was invisible: the flattened outline is the
   * same shape, just no longer crisp under zoom.
   *
   * Vertex `i` is where edge `i` ends and the ring closes back on `start`, so
   * walking the edges backwards and flipping each one traverses the identical
   * boundary in the opposite direction.
   */
  reversed(): Ring {
    const n = this.edges.length;
    if (n === 0) return this;

    const vertexBefore = (i: number): Vec2 =>
      i === 0 ? this.start : (this.edges[i - 1] as RingEdge).to;

    const edges: RingEdge[] = [];
    for (let k = n - 1; k >= 0; k--) {
      const e = this.edges[k] as RingEdge;
      const from = vertexBefore(k);
      if (e.kind === 'line') {
        edges.push({ kind: 'line', to: from });
      } else {
        // Same circle, swept from the far end back to the near one.
        edges.push({ kind: 'arc', c: e.c, r: e.r, a0: e.a1, a1: e.a0, ccw: !e.ccw, to: from });
      }
    }
    return new Ring(this.start, edges);
  }

  /** Builds a ring of straight edges from a closed point list. */
  static fromPolygon(points: readonly Vec2[]): Ring {
    if (points.length < 3) {
      return new Ring(points[0] ?? { x: 0, y: 0 }, []);
    }
    const edges: RingEdge[] = [];
    for (let i = 1; i < points.length; i++) {
      edges.push({ kind: 'line', to: points[i] as Vec2 });
    }
    edges.push({ kind: 'line', to: points[0] as Vec2 });
    return new Ring(points[0] as Vec2, edges);
  }

  /** Appends this ring to a Path2D as a closed subpath, arcs kept exact. */
  addToPath(path: Path2D): void {
    if (this.isEmpty) return;
    path.moveTo(this.start.x, this.start.y);
    for (const e of this.edges) {
      if (e.kind === 'line') {
        path.lineTo(e.to.x, e.to.y);
      } else {
        path.arc(e.c.x, e.c.y, Math.abs(e.r), e.a0, e.a1, !e.ccw);
      }
    }
    path.closePath();
  }
}

function arcDelta(e: Extract<RingEdge, { kind: 'arc' }>): number {
  let d = normalizeAngle(e.a1 - e.a0);
  if (e.ccw && d < 0) d += Math.PI * 2;
  if (!e.ccw && d > 0) d -= Math.PI * 2;
  return Math.abs(d) < EPS ? 0 : d;
}

/**
 * Builds an arc edge from a centre and two endpoints, choosing the sweep whose
 * central angle is less than PI. For curb returns that sweep is always unique.
 */
export function arcEdge(c: Vec2, r: number, from: Vec2, to: Vec2): RingEdge {
  const a0 = angleOf(sub(from, c));
  const a1 = angleOf(sub(to, c));
  const delta = normalizeAngle(a1 - a0);
  return { kind: 'arc', c, r: Math.abs(r), a0, a1, ccw: delta >= 0, to };
}

export const lineEdge = (to: Vec2): RingEdge => ({ kind: 'line', to });
