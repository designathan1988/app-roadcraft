import { type Vec2, dist } from '@core/vec2';
import { Ring, type RingEdge, arcEdge, lineEdge } from '@core/ring';
import { convexHull, isSimple } from '@core/polygon';
import { inForwardSlab } from '@core/intersect';
import { type Leg, mouthLeft, mouthRight } from './legs';
import type { Corner } from './corners';
import { COARSE_EPS, FINE_EPS } from '@core/scalar';

export interface JunctionRing {
  /**
   * The corner boundary: mouth cuts joined by curb returns. This is the shape
   * that gives the junction its outline.
   */
  readonly ring: Ring;
  /**
   * One rectangle per leg, spanning the node cross-section out to that leg's
   * mouth.
   *
   * These exist because the corner ring alone does not always reach the node.
   * At an acute fork the separation setback pushes every mouth far out along
   * its leg, so all of the corner ring's vertices sit far from the node and the
   * area beside the node is left bare. Rather than attempting a true polygon
   * union — which canvas cannot do natively — each leg contributes its own
   * carriageway rectangle. The painter fills every ring of a level into one
   * `Path2D` with the nonzero rule, so overlap between these and the corner
   * ring costs nothing and is invisible.
   */
  readonly tongues: readonly Ring[];
  /** Every ring of this junction: the corner boundary plus the leg tongues. */
  readonly rings: readonly Ring[];
  /** True when the simplicity validator had to fall back to a convex hull. */
  readonly usedHullFallback: boolean;
  /** Mouth corner points, for containment assertions and detail placement. */
  readonly mouths: readonly { readonly right: Vec2; readonly left: Vec2 }[];
}

/**
 * Absolute reach of a junction ring: three times the widest road at the node.
 *
 * A universal ceiling, not a special case for acute angles. Every rule this
 * builder had before was local — this corner's arc, that leg's setback — and a
 * local rule cannot see that the sum of its own correct decisions has produced
 * a slab of asphalt the size of a block. Each of the three escapes below is
 * geometrically valid on its own; the ceiling is what decides between them, and
 * it decides the same way for a T, a five-leg star and a shallow fork.
 *
 * Widths are 15/22/34/46 units, so the ceiling runs from 90 to 276 units — far
 * wider than any real kerb return needs, which is the point: it fires only when
 * something has genuinely run away.
 */
const RING_REACH_FACTOR = 3;

/** The node itself. `leg.origin` is back-projected so every leg agrees on it. */
function nodeCentre(legs: readonly Leg[]): Vec2 {
  let x = 0;
  let y = 0;
  for (const leg of legs) {
    x += leg.origin.x;
    y += leg.origin.y;
  }
  return { x: x / legs.length, y: y / legs.length };
}

/**
 * Farthest a vertex of this junction may sit from the node.
 *
 * Three road widths, OR the farthest mouth if that is further — and the second
 * term is not a let-out, it is the difference between a ceiling and a wish.
 * Measured: the bare three-width rule sent 45 % of five thousand random
 * junctions to the hull fallback, against a guarded rate below 1 %. A shallow
 * fork at 15 degrees puts its mouths 86 units out on a 22-unit street, past a
 * 66-unit ceiling, and a mouth CANNOT move — the road ribbon butts against it,
 * and the separation setback is the distance at which the two carriageways stop
 * overlapping. Worse, the fallback is a hull OF THE MOUTHS, so it contains
 * every one of the offending vertices: falling back reduces the reach by
 * exactly nothing. A rule whose remedy cannot satisfy it is not a rule.
 *
 * So the ceiling binds what is discretionary — how far an arc or a chord may
 * wander past the mouths it joins — and leaves alone what the road structure
 * has already decided.
 */
function ringReach(legs: readonly Leg[], mouthReach: number): number {
  let widest = 0;
  for (const leg of legs) widest = Math.max(widest, leg.hw * 2);
  return Math.max(RING_REACH_FACTOR * widest, mouthReach);
}

/**
 * Farthest point of a circular arc from `centre`.
 *
 * Checking only the two tangencies misses the belly: an arc bulges away from
 * its chord, and on a wide return the bulge is what breaks the ceiling while
 * both endpoints sit comfortably inside it.
 */
function arcReach(c: Vec2, r: number, ta: Vec2, tb: Vec2, centre: Vec2): number {
  const ax = ta.x - c.x;
  const ay = ta.y - c.y;
  const bx = tb.x - c.x;
  const by = tb.y - c.y;
  const la = Math.hypot(ax, ay) || 1;
  const lb = Math.hypot(bx, by) || 1;
  let mx = ax / la + bx / lb;
  let my = ay / la + by / lb;
  const lm = Math.hypot(mx, my);
  // Tangencies diametrically opposed: the bisector is degenerate and the two
  // endpoints already bound the arc as well as anything can.
  if (lm < FINE_EPS) return Math.max(dist(ta, centre), dist(tb, centre));
  mx /= lm;
  my /= lm;
  const mid = { x: c.x + mx * r, y: c.y + my * r };
  return Math.max(dist(ta, centre), dist(tb, centre), dist(mid, centre));
}

/** Rectangle covering a leg's carriageway from the node out to its mouth. */
function legTongue(leg: Leg, trim: number): Ring | null {
  if (trim <= COARSE_EPS) return null;
  const base = leg.origin;
  const tip = { x: base.x + leg.dir.x * trim, y: base.y + leg.dir.y * trim };
  const nx = leg.nrm.x * leg.hw;
  const ny = leg.nrm.y * leg.hw;
  return Ring.fromPolygon([
    { x: base.x - nx, y: base.y - ny },
    { x: tip.x - nx, y: tip.y - ny },
    { x: tip.x + nx, y: tip.y + ny },
    { x: base.x + nx, y: base.y + ny },
  ]).ensurePositive();
}

/** Points on the circle approximating a node cap. */
const CAP_STEPS = 24;

/**
 * A rounded cap over the node, for junctions whose legs all leave on one side.
 *
 * Every other ring here is built FORWARD from the node: the corner boundary
 * joins mouths that lie along the legs, and each tongue is a rectangle running
 * from the node out to its own mouth. Nothing covers the ground BEHIND the
 * node — and behind is only empty when the legs surround it.
 *
 * They do not at a bend. Two legs leaving at 60 and 105 degrees — a hairpin on
 * a saved map — leave a reflex gap of 315 degrees, and the two tongues meet
 * there in a point at the node itself. Measured on that node, the surface had
 * zero extent over the whole outer side of the turn: the asphalt, the kerb and
 * the footway all stopped dead on a straight cut, the two cuts met at a spike,
 * and the outside of the bend was a vertical face onto the grass with no kerb
 * on it at all.
 *
 * The cap is a disc of the level's own half-width. Its radius therefore nests
 * exactly like every other ring — casing over footway over kerb over
 * carriageway — so the bands wrap the outside of the bend instead of ending,
 * and the outer edge becomes an arc rather than a point. Inside the tongues it
 * is invisible, which is why it can be a full circle rather than a sector: the
 * union is what decides how much of it shows.
 *
 * Only for a reflex gap. A T has a straight 180-degree back and needs no cap,
 * and a crossroads has no gap over 180 at all.
 */
function nodeCap(legs: readonly Leg[], centre: Vec2): Ring | null {
  const n = legs.length;
  if (n < 2) return null;

  const bearings = legs.map((leg) => Math.atan2(leg.dir.y, leg.dir.x)).sort((a, b) => a - b);
  let widest = 0;
  for (let i = 0; i < n; i++) {
    const from = bearings[i] as number;
    const to = i + 1 < n ? (bearings[i + 1] as number) : (bearings[0] as number) + 2 * Math.PI;
    widest = Math.max(widest, to - from);
  }
  // A hair over a straight back, so a T is left exactly as it was.
  if (widest <= Math.PI + COARSE_EPS) return null;

  let r = 0;
  for (const leg of legs) r = Math.max(r, leg.hw);
  if (r <= COARSE_EPS) return null;

  const points: Vec2[] = [];
  for (let i = 0; i < CAP_STEPS; i++) {
    const a = (i / CAP_STEPS) * 2 * Math.PI;
    points.push({ x: centre.x + Math.cos(a) * r, y: centre.y + Math.sin(a) * r });
  }
  return Ring.fromPolygon(points).ensurePositive();
}

/**
 * Assembles the junction boundary for one surface level.
 *
 * Walking counter-clockwise, each leg contributes a straight mouth cut from its
 * right corner to its left corner, and each corner contributes either a curb
 * return arc or a straight chord. Because a leg's trim is the max over BOTH of
 * its adjacent corners, the mouth can sit further out than one corner's
 * tangency; the boundary then runs back along the leg's own boundary line to
 * reach the arc. That indentation is correct: a mouth must be a single straight
 * cut across the full width, or the road ribbon cannot butt against it.
 */
export function buildJunctionRing(
  legs: readonly Leg[],
  corners: readonly Corner[],
  trims: readonly number[],
): JunctionRing {
  const n = legs.length;
  const mouths = legs.map((leg, i) => ({
    right: mouthRight(leg, trims[i] as number),
    left: mouthLeft(leg, trims[i] as number),
  }));

  const tongues = legs
    .map((leg, i) => legTongue(leg, trims[i] as number))
    .filter((r): r is Ring => r !== null);

  if (n < 2) {
    const empty = new Ring({ x: 0, y: 0 }, []);
    return { ring: empty, tongues, rings: tongues, usedHullFallback: false, mouths };
  }

  const centre = nodeCentre(legs);
  const cap = nodeCap(legs, centre);
  /** Everything the corner boundary does not cover on its own. */
  const fill = cap ? [...tongues, cap] : tongues;
  let mouthReach = 0;
  for (const m of mouths) {
    mouthReach = Math.max(mouthReach, dist(m.right, centre), dist(m.left, centre));
  }
  const reach = ringReach(legs, mouthReach);

  const start = (mouths[0] as { right: Vec2 }).right;
  const edges: RingEdge[] = [];
  let cursor = start;

  const push = (e: RingEdge, to: Vec2): void => {
    if (dist(cursor, to) > FINE_EPS) {
      edges.push(e);
      cursor = to;
    }
  };

  for (let i = 0; i < n; i++) {
    const mouth = mouths[i] as { right: Vec2; left: Vec2 };
    if (i > 0) push(lineEdge(mouth.right), mouth.right);
    push(lineEdge(mouth.left), mouth.left);

    const corner = corners.find((c) => c.i === i);
    if (!corner) continue;

    // Route via the legs' own boundary lines rather than cutting a chord
    // straight from this mouth to the next one.
    //
    // A leg's trim is the max over BOTH of its corners, so it can sit far
    // beyond what this particular corner demands. A direct chord from one
    // mouth to the next is then a long diagonal, and in a fan of legs it slices
    // right through an intermediate leg's carriageway — which is how the ring
    // stopped being simple. Running back along the boundary line to the
    // corner's own feature point, and out along the next leg's boundary line,
    // keeps the boundary outside every carriageway by construction.
    // THE CEILING, first escape: an arc that reaches past it is discarded and
    // the corner is chorded straight between its tangencies instead. The arc is
    // not wrong — it is what the two kerb lines demand — but a return that
    // reaches three road widths from the node has stopped being a kerb return.
    const overreaching =
      corner.mode === 'fillet' &&
      corner.fillet !== null &&
      arcReach(corner.fillet.c, corner.fillet.r, corner.fillet.ta, corner.fillet.tb, centre) >
        reach;

    if (corner.mode === 'fillet' && corner.fillet && !overreaching) {
      // Run to the arc's OWN tangency, not to the trim the corner reported.
      //
      // They are the same number whenever the corner is free to demand what its
      // arc needs. They differ when the arc has been grown to reach a mouth
      // that another corner set further out: the reported trim is then clamped,
      // so that growth cannot lengthen the leg, and the tangency is the only
      // point actually on the circle. Running to anything else starts the arc
      // off its own centre.
      const { ta, tb, c, r } = corner.fillet;
      push(lineEdge(ta), ta);
      edges.push(arcEdge(c, r, cursor, tb));
      cursor = tb;
    } else {
      const pi = mouthLeft(legs[i] as Leg, corner.trimI);
      const pj = mouthRight(legs[corner.j] as Leg, corner.trimJ);
      push(lineEdge(pi), pi);
      push(lineEdge(pj), pj);
    }
    // The next iteration emits R_j, which is a straight run along the same
    // boundary line we just arrived on.
  }

  // Close the loop.
  if (dist(cursor, start) > FINE_EPS) edges.push(lineEdge(start));

  const ring = new Ring(start, edges).ensurePositive();

  // ---------------------------------------------------------------- validate
  const flat = ring.flatten();

  // THE CEILING, second escape. The chord replacing a runaway arc can itself
  // land past the ceiling, and so can a mouth, because a leg's trim is the max
  // over both its corners and nothing here may move a mouth — the road ribbon
  // butts against it. When the shape still overreaches, the hull below is the
  // honest answer: it is simple, it contains every mouth, and it is visibly a
  // junction rather than a slab pretending to be one.
  let overreaches = false;
  for (const p of flat) {
    if (dist(p, centre) > reach) {
      overreaches = true;
      break;
    }
  }

  if (flat.length >= 3 && isSimple(flat) && !overreaches) {
    return { ring, tongues, rings: [ring, ...fill], usedHullFallback: false, mouths };
  }

  // Last resort. A hull is always simple and always contains every mouth, so a
  // validation failure degrades to "slightly too generous" rather than the
  // bowtie the V6 monolith produced. A fuzz test asserts this never fires.
  const hullPoints = mouths.flatMap((m) => [m.right, m.left]);
  const hullRing = Ring.fromPolygon(convexHull(hullPoints)).ensurePositive();
  return {
    ring: hullRing,
    tongues,
    rings: [hullRing, ...fill],
    usedHullFallback: true,
    mouths,
  };
}

/**
 * Checks that no leg's mouth corner falls inside a non-adjacent leg's
 * carriageway. Only bites when a junction has four or more legs of very uneven
 * width; the caller responds by pushing the offending trim outward.
 */
export function findSlabViolations(
  legs: readonly Leg[],
  trims: readonly number[],
): number[] {
  const n = legs.length;
  if (n < 3) return [];
  const bad = new Set<number>();

  for (let i = 0; i < n; i++) {
    const leg = legs[i] as Leg;
    const t = trims[i] as number;
    const pts = [mouthRight(leg, t), mouthLeft(leg, t)];
    for (let j = 0; j < n; j++) {
      if (j === i || j === (i + 1) % n || (j + 1) % n === i) continue;
      const other = legs[j] as Leg;
      for (const q of pts) {
        if (inForwardSlab(q, other.origin, other.dir, other.hw)) {
          bad.add(i);
          break;
        }
      }
    }
  }
  return [...bad];
}
