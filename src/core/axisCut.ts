import type { MultiPoly, Poly, Ring } from './clipper';

/**
 * Cuts a polygon with holes along an axis-parallel line, into the part below
 * the line and the part above it.
 *
 * ## Why not the clipper
 *
 * `splitToSpan` bisects every road band down to mesh-sized pieces, and it used
 * to do each cut as a general boolean intersection with a rectangle. Measured
 * on a 144-segment map that was 46 % of the whole road-surface rebuild: the
 * sweep-line kernel pays for arbitrary input — overlapping rings, coincident
 * edges, snapping — on every level of the recursion, when every cut is a
 * straight line through a polygon the kernel itself has already cleaned.
 *
 * A straight cut needs only a walk round each ring and a sort of the points
 * where it crosses the line. The boundary of each side is the ring stretches on
 * that side, joined along the cut line; because every ring is oriented with the
 * interior on its left, the crossings sorted along the line alternate between a
 * stretch leaving that side and one re-entering it, and pairing them is all
 * the joining there is. Both sides are built from the SAME crossing points, so
 * the two pieces meet vertex for vertex along the cut.
 *
 * ## When it declines
 *
 * The cut is moved off any vertex (by a few thousandths of a unit, which does
 * not matter for where a mesh is split), so no point lies on the line and no
 * edge runs along it. Anything the pairing cannot vouch for — crossings that
 * do not alternate, two at the same place, a hole outside every piece — returns
 * `null`, and the caller does the cut the general way. It is a fast path, not
 * a second kernel.
 */

/** No vertex is allowed nearer the cut than this, in world units. */
const CLEAR = 1e-3;
/** How far each retry moves the cut, and how many it makes. */
const NUDGE = 4 * CLEAR;
const TRIES = 16;

/** A point where a ring crosses the cut line. */
interface Crossing {
  /** Position along the line. */
  readonly v: number;
  /** True where the ring passes from below the line to above it. */
  readonly rising: boolean;
  readonly point: number[];
}

/** A stretch of one ring on one side, from the crossing it enters by to the one it leaves by. */
interface Chain {
  readonly points: number[][];
  readonly exit: Crossing;
}

/**
 * The parts of `polygon` below and above the line `axis = at` (`axis` 0 is x,
 * 1 is y), or null when the input is not one this fast path can vouch for.
 */
export function cutAtAxis(polygon: Poly, axis: 0 | 1, at: number): [MultiPoly, MultiPoly] | null {
  const across = axis;
  const along = axis === 0 ? 1 : 0;

  const rings: Ring[] = [];
  for (let r = 0; r < polygon.length; r++) {
    const ring = openRing(polygon[r] as Ring);
    if (ring.length < 3) {
      if (r === 0) return null;
      continue;
    }
    // Interior on the left in (across, along): outer rings anticlockwise,
    // holes clockwise, measured in the cut's own frame.
    const twice = signedArea(ring, across, along);
    if (twice === 0) return null;
    rings.push((r === 0) === (twice > 0) ? ring : ring.slice().reverse());
  }

  const line = clearLine(rings, across, at);
  if (line === null) return null;

  const below: Chain[] = [];
  const above: Chain[] = [];
  const crossings: Crossing[] = [];
  const whole: [Ring[], Ring[]] = [[], []];
  let outerCut = false;

  for (let r = 0; r < rings.length; r++) {
    const ring = rings[r] as Ring;
    const n = ring.length;
    const side = (i: number): 0 | 1 => ((ring[i] as number[])[across] as number) < line ? 0 : 1;

    // One crossing per edge that changes side.
    const crossingAfter: (Crossing | null)[] = new Array<Crossing | null>(n).fill(null);
    let first = -1;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      if (side(i) === side(j)) continue;
      const p = ring[i] as number[];
      const q = ring[j] as number[];
      const pu = p[across] as number;
      const qu = q[across] as number;
      const t = (line - pu) / (qu - pu);
      const v = (p[along] as number) + ((q[along] as number) - (p[along] as number)) * t;
      const point = [0, 0];
      point[across] = line;
      point[along] = v;
      const crossing: Crossing = { v, rising: side(i) === 0, point };
      crossingAfter[i] = crossing;
      crossings.push(crossing);
      if (first < 0) first = i;
    }

    if (first < 0) {
      whole[side(0)].push(ring);
      continue;
    }
    if (r === 0) outerCut = true;

    // Walk once round from the first crossing, cutting the ring into chains.
    let entry = crossingAfter[first] as Crossing;
    let points: number[][] = [entry.point];
    for (let k = 1; k <= n; k++) {
      const i = (first + k) % n;
      points.push(ring[i] as number[]);
      const exit = crossingAfter[i];
      if (!exit) continue;
      // The chain after a rising crossing lies above the line.
      (entry.rising ? above : below).push({ points: [...points, exit.point], exit });
      entry = exit;
      points = [entry.point];
    }
  }

  // A hole cut while its outer ring was not is not a polygon this can split.
  if (!outerCut) return crossings.length ? null : sideOnly(polygon, rings, across, line);

  crossings.sort((a, b) => a.v - b.v);
  const next = new Map<Crossing, { below: Crossing; above: Crossing }>();
  for (let k = 0; k < crossings.length; k += 2) {
    const low = crossings[k];
    const high = crossings[k + 1];
    // Inside the polygon between each pair, outside between pairs: the lower
    // crossing of each pair rises, the upper one falls.
    if (!low || !high || !low.rising || high.rising || !(low.v < high.v)) return null;
    if (k > 0 && !((crossings[k - 1] as Crossing).v < low.v)) return null;
    // Below the line the boundary runs up the cut from a rising crossing to
    // the falling one; above it, down from the falling one to the rising one.
    next.set(low, { below: high, above: low });
    next.set(high, { below: high, above: low });
  }

  const pieces = [join(below, next, 'below'), join(above, next, 'above')];
  const result: [MultiPoly, MultiPoly] = [[], []];
  for (const side of [0, 1] as const) {
    const outers = pieces[side];
    if (outers === null || outers === undefined) return null;
    const polys: Poly[] = outers.map((ring) => [ring]);
    for (const hole of whole[side]) {
      const owner = polys.length === 1 ? polys[0] : polys.find((p) => contains(p[0] as Ring, hole[0] as number[]));
      if (!owner) return null;
      owner.push(hole);
    }
    result[side] = polys.map(worldWinding);
  }
  return result;
}

/**
 * The clipper's winding, in WORLD axes: outer rings anticlockwise, holes
 * clockwise.
 *
 * The rings above are anticlockwise in the cut's own frame, which for a cut
 * along y is the mirror of the world's, so every piece of a horizontal cut came
 * out clockwise. A mesh builder reading the winding to decide which way is up
 * then drew those pieces face down, and whole stretches of road vanished under
 * back-face culling. Give back exactly what the clipper gave.
 */
function worldWinding(polygon: Poly): Poly {
  return polygon.map((ring, r) => ((r === 0) === (signedArea(ring, 0, 1) > 0) ? ring : ring.slice().reverse()));
}

/** Joins one side's chains into closed rings along the cut. */
function join(
  chains: readonly Chain[],
  next: Map<Crossing, { below: Crossing; above: Crossing }>,
  side: 'below' | 'above',
): Ring[] | null {
  const byEntry = new Map<number[], Chain>();
  for (const chain of chains) byEntry.set(chain.points[0] as number[], chain);
  const used = new Set<Chain>();
  const rings: Ring[] = [];
  for (const start of chains) {
    if (used.has(start)) continue;
    const ring: Ring = [];
    let chain: Chain | undefined = start;
    for (let guard = 0; ; guard++) {
      if (!chain || used.has(chain) || guard > chains.length) return null;
      used.add(chain);
      for (const p of chain.points) ring.push(p);
      const link = next.get(chain.exit);
      if (!link) return null;
      const entry = link[side];
      if (entry === chain.exit) return null;
      chain = byEntry.get(entry.point);
      if (chain === start) break;
    }
    rings.push(ring);
  }
  return rings;
}

/** A polygon no ring of which reaches the line: all of it is on one side. */
function sideOnly(polygon: Poly, rings: Ring[], across: number, line: number): [MultiPoly, MultiPoly] {
  const below = (((rings[0] as Ring)[0] as number[])[across] as number) < line;
  return below ? [[polygon], []] : [[], [polygon]];
}

/**
 * The cut position nearest `at` that clears every vertex by `CLEAR`, or null.
 */
function clearLine(rings: readonly Ring[], across: number, at: number): number | null {
  for (let k = 0; k < TRIES; k++) {
    const offset = (k % 2 === 0 ? 1 : -1) * Math.ceil(k / 2) * NUDGE;
    const line = at + offset;
    let clear = true;
    for (const ring of rings) {
      for (const p of ring) {
        if (Math.abs((p[across] as number) - line) < CLEAR) {
          clear = false;
          break;
        }
      }
      if (!clear) break;
    }
    if (clear) return line;
  }
  return null;
}

/** The ring without a repeated closing point. */
function openRing(ring: Ring): Ring {
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (ring.length > 1 && first && last && first[0] === last[0] && first[1] === last[1]) {
    return ring.slice(0, -1);
  }
  return ring;
}

/** Twice the signed area in the (across, along) frame; positive is anticlockwise there. */
function signedArea(ring: Ring, across: number, along: number): number {
  let sum = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[j] as number[];
    const b = ring[i] as number[];
    sum += (a[across] as number) * (b[along] as number) - (b[across] as number) * (a[along] as number);
  }
  return sum;
}

/** Even-odd point in ring. */
function contains(ring: Ring, p: number[]): boolean {
  const x = p[0] as number;
  const y = p[1] as number;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i] as number[];
    const b = ring[j] as number[];
    const ay = a[1] as number;
    const by = b[1] as number;
    if (ay > y !== by > y) {
      const ax = a[0] as number;
      const bx = b[0] as number;
      if (x < ax + ((y - ay) * (bx - ax)) / (by - ay)) inside = !inside;
    }
  }
  return inside;
}
