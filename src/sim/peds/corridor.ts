import type { Polyline } from '@core/polyline';
import { m } from '@world/units';

/** Spacing of the stations a corridor's walls are sampled at, world units. */
export const CORRIDOR_STEP = 1;
/**
 * How far a corridor reaches past each end of its path. A walker is handed
 * from one corridor to the next where the two overlap (`transfer` in `crossingFsm.ts`), so
 * this overlap is what lets a hand-off happen with the body exactly where it
 * is — no clamp, no catch-up offset, nothing drawn off the path.
 */
export const CORRIDOR_EXT = m(1.5);

/** A point with the local frame of a corridor: centreline point, tangent, left normal. */
export interface CorridorFrame { x: number; y: number; tx: number; ty: number; nx: number; ny: number }
export interface CorridorPlace { s: number; lat: number }
export interface CorridorBounds { lo: number; hi: number }

/**
 * A walking corridor: one sidewalk edge's path, a continuous frame along it,
 * and the walls either side of it.
 *
 * This is the representation the Explicit Corridor Map uses for crowd
 * navigation (Geraerts, 2010): a backbone path and, at every point along it,
 * how far the free space reaches to the left and to the right. A pedestrian's
 * position is a place in that frame — an arc position `s` and an offset
 * `lat` — and the walls are where the footway the renderer draws really ends,
 * measured from the surface polygons when the network is built. Nothing a
 * walker does can put its centre outside them.
 *
 * The frame is continuous. A polyline's own normal turns in steps at every
 * vertex, so an offset from it jumps at each one; here the normal is
 * interpolated between the bisectors at the vertices, and the map from
 * (s, lat) to the plane is continuous and invertible within the walls
 * (`place`, `locate`). Past either end the frame carries straight on for
 * `CORRIDOR_EXT`.
 *
 * Every accessor takes `rev`: true for a walker who entered the edge from its
 * `to` end, who measures `s` from that end and `lat` to their own left. No
 * reversed copy of the path is ever built — the old `orientedPath` built one
 * per call, several times per pedestrian per tick.
 *
 * Nothing here allocates after construction.
 */
export class Corridor {
  readonly length: number;
  private readonly n: number;
  private readonly px: Float64Array;
  private readonly py: Float64Array;
  private readonly cum: Float64Array;
  /** Unit tangent and left normal of each segment. */
  private readonly stx: Float64Array;
  private readonly sty: Float64Array;
  /** Unit normal at each vertex: the segment normal at the ends, the bisector between. */
  private readonly vnx: Float64Array;
  private readonly vny: Float64Array;
  /** Walls at stations `-CORRIDOR_EXT + k * CORRIDOR_STEP`. */
  readonly lo: Float64Array;
  readonly hi: Float64Array;

  constructor(path: Polyline) {
    const n = Math.max(2, path.n);
    this.n = n;
    this.px = new Float64Array(n);
    this.py = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const p = path.point(Math.min(i, path.n - 1));
      this.px[i] = p.x;
      this.py[i] = p.y;
    }
    if (path.n < 2) this.px[1] = this.px[0]! + 1e-3;
    this.cum = new Float64Array(n);
    this.stx = new Float64Array(n - 1);
    this.sty = new Float64Array(n - 1);
    for (let i = 0; i < n - 1; i++) {
      const dx = this.px[i + 1]! - this.px[i]!, dy = this.py[i + 1]! - this.py[i]!;
      const l = Math.hypot(dx, dy);
      this.cum[i + 1] = this.cum[i]! + l;
      this.stx[i] = l > 1e-12 ? dx / l : (i > 0 ? this.stx[i - 1]! : 1);
      this.sty[i] = l > 1e-12 ? dy / l : (i > 0 ? this.sty[i - 1]! : 0);
    }
    this.length = this.cum[n - 1]!;
    this.vnx = new Float64Array(n);
    this.vny = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const a = Math.max(0, i - 1), b = Math.min(n - 2, i);
      let nx = -this.sty[a]! - this.sty[b]!;
      let ny = this.stx[a]! + this.stx[b]!;
      const l = Math.hypot(nx, ny);
      if (l < 1e-9) { nx = -this.sty[b]!; ny = this.stx[b]!; } else { nx /= l; ny /= l; }
      this.vnx[i] = nx;
      this.vny[i] = ny;
    }
    const stations = Math.ceil((this.length + 2 * CORRIDOR_EXT) / CORRIDOR_STEP) + 1;
    this.lo = new Float64Array(stations);
    this.hi = new Float64Array(stations);
  }

  get stations(): number {
    return this.lo.length;
  }

  /** Arc position of station `k`, from the `from` end. */
  stationS(k: number): number {
    return -CORRIDOR_EXT + k * CORRIDOR_STEP;
  }

  /** Segment containing arc position `S` (unoriented), clamped to the path. */
  private segment(S: number): number {
    const cum = this.cum;
    let lo = 0, hi = this.n - 2;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (cum[mid]! <= S) lo = mid; else hi = mid - 1;
    }
    return lo;
  }

  /** The frame at unoriented arc position `S`. */
  private frameAt(S: number, out: CorridorFrame): void {
    if (S <= 0) {
      const tx = this.stx[0]!, ty = this.sty[0]!;
      out.x = this.px[0]! + tx * S; out.y = this.py[0]! + ty * S;
      out.nx = this.vnx[0]!; out.ny = this.vny[0]!;
    } else if (S >= this.length) {
      const k = this.n - 2;
      const tx = this.stx[k]!, ty = this.sty[k]!;
      out.x = this.px[this.n - 1]! + tx * (S - this.length); out.y = this.py[this.n - 1]! + ty * (S - this.length);
      out.nx = this.vnx[this.n - 1]!; out.ny = this.vny[this.n - 1]!;
    } else {
      const i = this.segment(S);
      const len = this.cum[i + 1]! - this.cum[i]!;
      const u = len > 1e-12 ? (S - this.cum[i]!) / len : 0;
      out.x = this.px[i]! + (this.px[i + 1]! - this.px[i]!) * u;
      out.y = this.py[i]! + (this.py[i + 1]! - this.py[i]!) * u;
      let nx = this.vnx[i]! + (this.vnx[i + 1]! - this.vnx[i]!) * u;
      let ny = this.vny[i]! + (this.vny[i + 1]! - this.vny[i]!) * u;
      const l = Math.hypot(nx, ny) || 1;
      nx /= l; ny /= l;
      out.nx = nx; out.ny = ny;
    }
    // The tangent is the normal turned back a quarter: an orthonormal frame.
    out.tx = out.ny;
    out.ty = -out.nx;
  }

  /** The frame at arc position `s` for a walker going `rev`. */
  frame(s: number, rev: boolean, out: CorridorFrame): CorridorFrame {
    this.frameAt(rev ? this.length - s : s, out);
    if (rev) { out.tx = -out.tx; out.ty = -out.ty; out.nx = -out.nx; out.ny = -out.ny; }
    return out;
  }

  /** World position of a place in the corridor. */
  place(s: number, lat: number, rev: boolean, out: CorridorFrame): CorridorFrame {
    this.frame(s, rev, out);
    out.x += out.nx * lat;
    out.y += out.ny * lat;
    return out;
  }

  /** The walls at arc position `s`, as offsets to the walker's left (`hi`) and right (`lo`). */
  bounds(s: number, rev: boolean, out: CorridorBounds): CorridorBounds {
    const S = rev ? this.length - s : s;
    const f = (S + CORRIDOR_EXT) / CORRIDOR_STEP;
    const last = this.lo.length - 1;
    let lo: number, hi: number;
    if (f <= 0) { lo = this.lo[0]!; hi = this.hi[0]!; } else if (f >= last) { lo = this.lo[last]!; hi = this.hi[last]!; } else {
      const k = Math.floor(f), u = f - k;
      lo = this.lo[k]! + (this.lo[k + 1]! - this.lo[k]!) * u;
      hi = this.hi[k]! + (this.hi[k + 1]! - this.hi[k]!) * u;
    }
    if (rev) { out.lo = -hi; out.hi = -lo; } else { out.lo = lo; out.hi = hi; }
    return out;
  }

  /** Whether arc position `s` is within the corridor's reach, ends included. */
  within(s: number): boolean {
    return s >= -CORRIDOR_EXT && s <= this.length + CORRIDOR_EXT;
  }

  /**
   * The place in the corridor of a world point: the inverse of `place`.
   * `hint` is an arc position near the answer (the walker's last one); the
   * search walks from its segment to a neighbour or two. Returns false when
   * the point is past the corridor's reach at either end.
   */
  locate(x: number, y: number, rev: boolean, hint: number, out: CorridorPlace): boolean {
    let i = this.segment(Math.max(0, Math.min(this.length, rev ? this.length - hint : hint)));
    let S = 0, lat = 0;
    let found = false;
    for (let iter = 0; iter < this.n + 1; iter++) {
      const ax = this.px[i]!, ay = this.py[i]!;
      const dx = this.px[i + 1]! - ax, dy = this.py[i + 1]! - ay;
      const n0x = this.vnx[i]!, n0y = this.vny[i]!;
      const dnx = this.vnx[i + 1]! - n0x, dny = this.vny[i + 1]! - n0y;
      const rx = x - ax, ry = y - ay;
      // cross(r - u d, n0 + u dn) = 0, a quadratic in u.
      const A = -(dx * dny - dy * dnx);
      const B = (rx * dny - ry * dnx) - (dx * n0y - dy * n0x);
      const C = rx * n0y - ry * n0x;
      let u: number;
      if (Math.abs(A) < 1e-12) u = Math.abs(B) > 1e-12 ? -C / B : 0;
      else {
        const disc = B * B - 4 * A * C;
        if (disc < 0) u = -B / (2 * A);
        else {
          const q = Math.sqrt(disc);
          const u1 = (-B - q) / (2 * A), u2 = (-B + q) / (2 * A);
          // The root nearer the segment: the other is the far side of the
          // point where the normals would meet.
          const d1 = u1 < 0 ? -u1 : u1 > 1 ? u1 - 1 : 0;
          const d2 = u2 < 0 ? -u2 : u2 > 1 ? u2 - 1 : 0;
          u = d1 <= d2 ? u1 : u2;
        }
      }
      if (u < 0 && i > 0) { i--; continue; }
      if (u > 1 && i < this.n - 2) { i++; continue; }
      const len = this.cum[i + 1]! - this.cum[i]!;
      if ((u < 0 && i === 0) || (u > 1 && i === this.n - 2)) {
        // Past an end, where the frame carries straight on.
        const end = u < 0 ? 0 : this.n - 1;
        const tx = this.stx[u < 0 ? 0 : this.n - 2]!, ty = this.sty[u < 0 ? 0 : this.n - 2]!;
        const ex = x - this.px[end]!, ey = y - this.py[end]!;
        const along = ex * tx + ey * ty;
        S = (u < 0 ? 0 : this.length) + along;
        lat = ex * this.vnx[end]! + ey * this.vny[end]!;
      } else {
        let nx = n0x + dnx * u, ny = n0y + dny * u;
        const l = Math.hypot(nx, ny) || 1;
        nx /= l; ny /= l;
        S = this.cum[i]! + u * len;
        lat = (rx - dx * u) * nx + (ry - dy * u) * ny;
      }
      found = true;
      break;
    }
    if (!found) return false;
    out.s = rev ? this.length - S : S;
    out.lat = rev ? -lat : lat;
    return S >= -CORRIDOR_EXT - 1e-9 && S <= this.length + CORRIDOR_EXT + 1e-9;
  }
}
