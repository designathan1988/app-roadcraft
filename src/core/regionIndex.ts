import type { Vec2 } from './vec2';

/**
 * How overlapping rings combine.
 *
 *   evenodd  inside when a ray crosses the boundary an odd number of times: a
 *            polygon with holes, as a clipper union returns it.
 *   nonzero  inside when the winding number is not zero: the union of rings
 *            that may overlap one another, as they come from the ribbons and
 *            junctions before anything merges them. Rings are wound CCW first.
 */
export type FillRule = 'evenodd' | 'nonzero';

/**
 * Point location, boundary distance and line spans over a set of rings, in
 * constant time per query.
 *
 * The boundary segments are bucketed into a uniform grid, and every cell
 * stores the winding number at its own centre, computed once by a scanline.
 * A query then only has to walk from the centre of its cell to the point —
 * across the cell horizontally, then vertically — counting the crossings of
 * the segments in that one cell. No allocation after the build, no clipper,
 * and the answer is the same as a ray cast over every ring on the map.
 *
 * Built for the pedestrian navigation (which asks, thousands of times while a
 * network is being built, where the footway begins and ends along a line
 * across it) and for the audits that check whether a body is standing on
 * what the renderer draws.
 */
export class RegionIndex {
  private readonly segs: Float64Array;
  private readonly count: number;
  private readonly x0: number;
  private readonly y0: number;
  private readonly cell: number;
  private readonly nx: number;
  private readonly ny: number;
  private readonly start: Int32Array;
  private readonly list: Int32Array;
  private readonly ref: Int32Array;
  private readonly stamps: Int32Array;
  private stamp = 0;
  private readonly rule: FillRule;
  /** Scratch for `span`: crossing parameters and winding steps. */
  private hitT = new Float64Array(64);
  private hitW = new Int8Array(64);

  private constructor(segs: Float64Array, rule: FillRule, cell: number) {
    this.segs = segs;
    this.count = segs.length / 4;
    this.rule = rule;
    this.cell = cell;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < segs.length; i += 2) {
      const x = segs[i] as number, y = segs[i + 1] as number;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    if (!Number.isFinite(minX)) { minX = 0; minY = 0; maxX = 0; maxY = 0; }
    this.x0 = minX - cell;
    this.y0 = minY - cell;
    this.nx = Math.max(1, Math.ceil((maxX - this.x0) / cell) + 1);
    this.ny = Math.max(1, Math.ceil((maxY - this.y0) / cell) + 1);
    const cells = this.nx * this.ny;
    const counts = new Int32Array(cells + 1);
    this.rasterise((c) => { counts[c + 1]!++; });
    for (let c = 0; c < cells; c++) counts[c + 1]! += counts[c]!;
    this.start = counts;
    this.list = new Int32Array(counts[cells]!);
    const fill = counts.slice(0, cells);
    this.rasterise((c, s) => { this.list[fill[c]!++] = s; });
    this.stamps = new Int32Array(this.count);
    this.ref = new Int32Array(cells);
    this.scanReference();
  }

  /** From closed rings; each need not repeat its first point. */
  static fromRings(rings: readonly (readonly Vec2[])[], rule: FillRule = 'nonzero', cell = 8): RegionIndex {
    let n = 0;
    for (const ring of rings) if (ring.length >= 3) n += ring.length;
    const segs = new Float64Array(n * 4);
    let k = 0;
    for (const ring of rings) {
      if (ring.length < 3) continue;
      let area = 0;
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        area += (ring[j]!.x - ring[i]!.x) * (ring[j]!.y + ring[i]!.y);
      }
      // Wound counter-clockwise, so that for `nonzero` overlapping rings add
      // up instead of cancelling.
      const flip = rule === 'nonzero' && area < 0;
      for (let i = 0; i < ring.length; i++) {
        const a = ring[flip ? ring.length - 1 - i : i]!;
        const b = ring[flip ? (2 * ring.length - 2 - i) % ring.length : (i + 1) % ring.length]!;
        segs[k++] = a.x; segs[k++] = a.y; segs[k++] = b.x; segs[k++] = b.y;
      }
    }
    return new RegionIndex(segs.subarray(0, k), rule, cell);
  }

  /** From a clipper multipolygon (`[x, y]` pairs, holes after the outline). */
  static fromMultiPoly(polygons: readonly (readonly (readonly (readonly number[])[])[])[],
    rule: FillRule = 'evenodd', cell = 8): RegionIndex {
    const rings: Vec2[][] = [];
    for (const polygon of polygons) {
      for (const ring of polygon) rings.push(ring.map((p) => ({ x: p[0] as number, y: p[1] as number })));
    }
    return RegionIndex.fromRings(rings, rule, cell);
  }

  private inside(w: number): boolean {
    return this.rule === 'evenodd' ? (w & 1) !== 0 : w !== 0;
  }

  /** Every (cell, segment) pair a segment's supercover touches. */
  private rasterise(visit: (cell: number, seg: number) => void): void {
    const s = this.segs;
    for (let k = 0; k < this.count; k++) {
      const ax = s[k * 4]!, ay = s[k * 4 + 1]!, bx = s[k * 4 + 2]!, by = s[k * 4 + 3]!;
      this.cellsOfSegment(ax, ay, bx, by, (c) => visit(c, k));
    }
  }

  /** Cells the segment (a, b) passes through, row by row. */
  private cellsOfSegment(ax: number, ay: number, bx: number, by: number, visit: (cell: number) => void): void {
    const c = this.cell;
    const j0 = Math.max(0, Math.floor((Math.min(ay, by) - this.y0) / c));
    const j1 = Math.min(this.ny - 1, Math.floor((Math.max(ay, by) - this.y0) / c));
    for (let j = j0; j <= j1; j++) {
      const lo = this.y0 + j * c, hi = lo + c;
      let xa: number, xb: number;
      if (Math.abs(by - ay) < 1e-12) { xa = ax; xb = bx; } else {
        const ta = Math.max(0, Math.min(1, (lo - ay) / (by - ay)));
        const tb = Math.max(0, Math.min(1, (hi - ay) / (by - ay)));
        xa = ax + (bx - ax) * ta;
        xb = ax + (bx - ax) * tb;
      }
      const i0 = Math.max(0, Math.floor((Math.min(xa, xb) - this.x0) / c));
      const i1 = Math.min(this.nx - 1, Math.floor((Math.max(xa, xb) - this.x0) / c));
      for (let i = i0; i <= i1; i++) visit(j * this.nx + i);
    }
  }

  /** The winding number at every cell centre, one scanline per row. */
  private scanReference(): void {
    const s = this.segs;
    const xs: number[] = [];
    const ds: number[] = [];
    const order: number[] = [];
    for (let j = 0; j < this.ny; j++) {
      const y = this.y0 + (j + 0.5) * this.cell;
      xs.length = 0; ds.length = 0; order.length = 0;
      this.stamp++;
      for (let i = 0; i < this.nx; i++) {
        const c = j * this.nx + i;
        for (let q = this.start[c]!; q < this.start[c + 1]!; q++) {
          const k = this.list[q]!;
          if (this.stamps[k] === this.stamp) continue;
          this.stamps[k] = this.stamp;
          const ay = s[k * 4 + 1]!, by = s[k * 4 + 3]!;
          if ((ay > y) === (by > y)) continue;
          const ax = s[k * 4]!, bx = s[k * 4 + 2]!;
          xs.push(ax + (bx - ax) * (y - ay) / (by - ay));
          ds.push(by > ay ? 1 : -1);
          order.push(order.length);
        }
      }
      order.sort((a, b) => xs[a]! - xs[b]!);
      // w(x) = sum of directions of crossings strictly to the right of x.
      let total = 0;
      for (const d of ds) total += this.rule === 'evenodd' ? 1 : d;
      let q = 0;
      let left = 0;
      for (let i = 0; i < this.nx; i++) {
        const x = this.x0 + (i + 0.5) * this.cell;
        while (q < order.length && xs[order[q]!]! <= x) {
          left += this.rule === 'evenodd' ? 1 : ds[order[q]!]!;
          q++;
        }
        this.ref[j * this.nx + i] = total - left;
      }
    }
  }

  /** Winding number at a point (evenodd: the crossing count), or NaN off the grid. */
  winding(x: number, y: number): number {
    const i = Math.floor((x - this.x0) / this.cell);
    const j = Math.floor((y - this.y0) / this.cell);
    if (i < 0 || j < 0 || i >= this.nx || j >= this.ny) return 0;
    const c = j * this.nx + i;
    const cx = this.x0 + (i + 0.5) * this.cell;
    const cy = this.y0 + (j + 0.5) * this.cell;
    let w = this.ref[c]!;
    const s = this.segs;
    const odd = this.rule === 'evenodd';
    for (let q = this.start[c]!; q < this.start[c + 1]!; q++) {
      const k = this.list[q]!;
      const ax = s[k * 4]!, ay = s[k * 4 + 1]!, bx = s[k * 4 + 2]!, by = s[k * 4 + 3]!;
      // Across the cell at the centre's height, from its centre to x.
      if ((ay > cy) !== (by > cy)) {
        const xc = ax + (bx - ax) * (cy - ay) / (by - ay);
        const up = by > ay ? 1 : -1;
        if (x < cx && xc > x && xc <= cx) w += odd ? 1 : up;
        else if (x > cx && xc > cx && xc <= x) w -= odd ? 1 : up;
      }
      // Then up or down to the point.
      if ((ax > x) !== (bx > x)) {
        const yc = ay + (by - ay) * (x - ax) / (bx - ax);
        const east = bx > ax ? 1 : -1;
        if (y > cy && yc > cy && yc <= y) w += odd ? 1 : east;
        else if (y < cy && yc > y && yc <= cy) w -= odd ? 1 : east;
      }
    }
    return w;
  }

  contains(x: number, y: number): boolean {
    return this.inside(this.winding(x, y));
  }

  /** Distance from a point to the nearest boundary segment within `reach`, or Infinity. */
  boundaryDistance(x: number, y: number, reach: number): number {
    const c = this.cell;
    const i0 = Math.max(0, Math.floor((x - reach - this.x0) / c));
    const i1 = Math.min(this.nx - 1, Math.floor((x + reach - this.x0) / c));
    const j0 = Math.max(0, Math.floor((y - reach - this.y0) / c));
    const j1 = Math.min(this.ny - 1, Math.floor((y + reach - this.y0) / c));
    this.stamp++;
    let best = Infinity;
    const s = this.segs;
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const cellId = j * this.nx + i;
      for (let q = this.start[cellId]!; q < this.start[cellId + 1]!; q++) {
        const k = this.list[q]!;
        if (this.stamps[k] === this.stamp) continue;
        this.stamps[k] = this.stamp;
        const ax = s[k * 4]!, ay = s[k * 4 + 1]!;
        const dx = s[k * 4 + 2]! - ax, dy = s[k * 4 + 3]! - ay;
        const l2 = dx * dx + dy * dy;
        let t = l2 > 1e-18 ? ((x - ax) * dx + (y - ay) * dy) / l2 : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const d = Math.hypot(x - ax - dx * t, y - ay - dy * t);
        if (d < best) best = d;
      }
    }
    return best <= reach ? best : Infinity;
  }

  /**
   * Along the line through `p` in direction `d` (a unit vector), the stretch
   * either side of `p`, within `reach`, that is on the same side of the
   * boundary as `p`: writes `lo` (<= 0) and `hi` (>= 0) into `out`, and
   * returns whether `p` is inside. A bound that is not met within `reach` is
   * written as the reach itself.
   */
  run(px: number, py: number, dx: number, dy: number, reach: number, out: { lo: number; hi: number }): boolean {
    const w0 = this.winding(px, py);
    const start = this.inside(w0);
    const ax = px - dx * reach, ay = py - dy * reach;
    const bx = px + dx * reach, by = py + dy * reach;
    let n = 0;
    this.stamp++;
    const s = this.segs;
    const odd = this.rule === 'evenodd';
    const c = this.cell;
    const j0 = Math.max(0, Math.floor((Math.min(ay, by) - this.y0) / c));
    const j1 = Math.min(this.ny - 1, Math.floor((Math.max(ay, by) - this.y0) / c));
    for (let j = j0; j <= j1; j++) {
      const lo = this.y0 + j * c, hi = lo + c;
      let xa: number, xb: number;
      if (Math.abs(by - ay) < 1e-12) { xa = ax; xb = bx; } else {
        const ta = Math.max(0, Math.min(1, (lo - ay) / (by - ay)));
        const tb = Math.max(0, Math.min(1, (hi - ay) / (by - ay)));
        xa = ax + (bx - ax) * ta;
        xb = ax + (bx - ax) * tb;
      }
      const i0 = Math.max(0, Math.floor((Math.min(xa, xb) - this.x0) / c));
      const i1 = Math.min(this.nx - 1, Math.floor((Math.max(xa, xb) - this.x0) / c));
      for (let i = i0; i <= i1; i++) {
        const cellId = j * this.nx + i;
        for (let q = this.start[cellId]!; q < this.start[cellId + 1]!; q++) {
          const k = this.list[q]!;
          if (this.stamps[k] === this.stamp) continue;
          this.stamps[k] = this.stamp;
          const sx = s[k * 4]!, sy = s[k * 4 + 1]!;
          const ex = s[k * 4 + 2]! - sx, ey = s[k * 4 + 3]! - sy;
          const den = dx * ey - dy * ex;
          if (Math.abs(den) < 1e-12) continue;
          const rx = sx - px, ry = sy - py;
          const t = (rx * ey - ry * ex) / den;
          const u = (rx * dy - ry * dx) / den;
          if (u < 0 || u >= 1 || t < -reach || t > reach) continue;
          if (n >= this.hitT.length) {
            const grownT = new Float64Array(n * 2); grownT.set(this.hitT); this.hitT = grownT;
            const grownW = new Int8Array(n * 2); grownW.set(this.hitW); this.hitW = grownW;
          }
          this.hitT[n] = t;
          // Moving along +d across this edge: from its right to its left adds one.
          this.hitW[n] = odd ? 1 : (ex * dy - ey * dx > 0 ? 1 : -1);
          n++;
        }
      }
    }
    // Insertion sort: a line across a footway crosses a handful of edges.
    for (let i = 1; i < n; i++) {
      const t = this.hitT[i]!, wv = this.hitW[i]!;
      let j = i - 1;
      while (j >= 0 && this.hitT[j]! > t) { this.hitT[j + 1] = this.hitT[j]!; this.hitW[j + 1] = this.hitW[j]!; j--; }
      this.hitT[j + 1] = t; this.hitW[j + 1] = wv;
    }
    let hi = reach;
    let w = w0;
    for (let i = 0; i < n; i++) {
      const t = this.hitT[i]!;
      if (t <= 0) continue;
      w += odd ? 1 : this.hitW[i]!;
      if (this.inside(w) !== start) { hi = t; break; }
    }
    let lo = -reach;
    w = w0;
    for (let i = n - 1; i >= 0; i--) {
      const t = this.hitT[i]!;
      if (t > 0) continue;
      // Going backwards reverses every step.
      w -= odd ? 1 : this.hitW[i]!;
      if (this.inside(w) !== start) { lo = t; break; }
    }
    out.lo = lo;
    out.hi = hi;
    return start;
  }

  /** `run`, for a point that must be inside: false, leaving `out` alone, when it is not. */
  span(px: number, py: number, dx: number, dy: number, reach: number, out: { lo: number; hi: number }): boolean {
    if (!this.contains(px, py)) return false;
    return this.run(px, py, dx, dy, reach, out);
  }
}
