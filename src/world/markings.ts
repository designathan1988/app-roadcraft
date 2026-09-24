import {
  EDGE_LINE_DARK,
  EDGE_LINE_LIGHT,
  Level,
  type RoadType,
  laneWidth,
  lanesPerDirection,
  markingColor,
} from '@world/roadTypes';
import type { Network, SegmentRibbon } from '@world/network';
import { offsetPolyline } from '@core/offset';
import type { Vec2 } from '@core/vec2';
import { type Aabb, intersects } from '@core/aabb';
import type { Junction } from '@world/junction/build';
import type { Leg } from '@world/junction/legs';
import { TransitionAxis, taperEase } from '@world/junction/transition';
import type { NodeId } from '@world/ids';
import {
  CROSSWALK_DEPTH,
  STOP_BAR_WIDTH,
  crosswalkDistance,
  stopLineDistance,
} from '@world/approach';

export interface StrokeSpec {
  readonly points: readonly Vec2[];
  readonly width: number;
  readonly color: string;
  /** Dash pattern in WORLD units, or null for a solid line. */
  readonly dash: readonly number[] | null;
  /** Dash phase in world units, so a split does not reflow the pattern. */
  readonly dashOffset: number;
}

/** Dash pattern used for every broken line, in world units. */
export const DASH: readonly number[] = [8, 8];
const DASH_PERIOD = 16;

/**
 * Lane markings for one segment.
 *
 * Dash phase is anchored to `segment.dashOrigin`, the arc-length offset of this
 * segment within the road it was originally drawn as. The V6 monolith restarted
 * the pattern at each render chain, so building a crossing — which splits the
 * road automatically — visibly reflowed every dash on it (defect 1.10).
 */
export function segmentMarkings(ribbon: SegmentRibbon, startS: number): StrokeSpec[] {
  const rt = ribbon.road;
  const centre = ribbon.centre[Level.Asphalt];
  if (!centre || centre.n < 2) return [];

  const pts = centre.toPoints();
  const out: StrokeSpec[] = [];
  const phase = -((ribbon.dashOrigin + startS) % DASH_PERIOD);

  // Edge lines, just inside the kerb on each side.
  out.push({
    points: offsetPolyline(pts, -(rt.width / 2 - 0.5)),
    width: 0.5,
    color: EDGE_LINE_LIGHT,
    dash: null,
    dashOffset: 0,
  });
  out.push({
    points: offsetPolyline(pts, rt.width / 2 - 0.5),
    width: 0.5,
    color: EDGE_LINE_DARK,
    dash: null,
    dashOffset: 0,
  });

  if (ribbon.direction === 'both' && rt.markings === 'center') {
    out.push({
      points: pts,
      width: 0.9,
      color: markingColor(rt),
      dash: DASH,
      dashOffset: phase,
    });
  }

  if (ribbon.direction !== 'both') {
    const lw = laneWidth(rt);
    for (let i = 1; i < rt.lanes; i++) {
      out.push({
        points: offsetPolyline(pts, -rt.width / 2 + lw * i),
        width: 0.7,
        color: markingColor(rt),
        dash: DASH,
        dashOffset: phase,
      });
    }
  } else if (rt.markings === 'lanes') {
    // A four-lane road without a median still needs a centreline separating the
    // two directions. The V6 monolith drew only the two lane dividers, so an
    // avenue had no centre line at all.
    if (rt.median === 0) {
      out.push({
        points: pts,
        width: 0.9,
        color: markingColor(rt),
        dash: null,
        dashOffset: 0,
      });
    }
    const lpd = lanesPerDirection(rt);
    const lw = laneWidth(rt);
    for (let i = 1; i < lpd; i++) {
      const off = rt.median / 2 + lw * i;
      out.push({
        points: offsetPolyline(pts, off),
        width: 0.7,
        color: markingColor(rt),
        dash: DASH,
        dashOffset: phase,
      });
      out.push({
        points: offsetPolyline(pts, -off),
        width: 0.7,
        color: markingColor(rt),
        dash: DASH,
        dashOffset: phase,
      });
    }
  }

  return out;
}

export interface Bar {
  readonly a: Vec2;
  readonly b: Vec2;
  readonly width: number;
}

const BAR_WIDTH = 1.0;
const BAR_GAP = 1.0;

/**
 * Stop bar for one approach, spanning only the lanes entering the junction.
 *
 * The V6 monolith drew no stop bar anywhere, despite the simulation having a
 * stop position.
 */
export function stopBar(
  origin: Vec2,
  dir: Vec2,
  nrm: Vec2,
  rt: RoadType,
  trim: number,
): Bar | null {
  // Beyond the junction mouth, past the crossing: the order an approaching
  // driver meets is stop line, then zebra, then junction.
  const s = stopLineDistance(trim);
  if (s <= 0) return null;
  const cx = origin.x + dir.x * s;
  const cy = origin.y + dir.y * s;
  // Right-hand traffic: the approaching side is the `+nrm` half.
  const inner = rt.median / 2;
  const outer = rt.width / 2;
  return {
    a: { x: cx + nrm.x * inner, y: cy + nrm.y * inner },
    b: { x: cx + nrm.x * outer, y: cy + nrm.y * outer },
    width: STOP_BAR_WIDTH,
  };
}

/**
 * Zebra bars for one approach.
 *
 * Bars repeat along the direction of travel over `CROSSWALK_DEPTH`, and each
 * bar crosses the carriageway from kerb to kerb. A central reservation splits
 * every bar into two strokes, leaving the refuge island clear.
 */
export function crosswalkBars(
  origin: Vec2,
  dir: Vec2,
  nrm: Vec2,
  rt: RoadType,
  trim: number,
): Bar[] {
  const mid = crosswalkDistance(trim);
  if (mid - CROSSWALK_DEPTH / 2 <= 0) return [];

  const pitch = BAR_WIDTH + BAR_GAP;
  const count = Math.max(1, Math.floor((CROSSWALK_DEPTH + BAR_GAP) / pitch));
  const used = count * BAR_WIDTH + (count - 1) * BAR_GAP;
  const start = mid - used / 2 + BAR_WIDTH / 2;
  const outer = rt.width / 2;
  const inner = rt.median / 2;

  const bars: Bar[] = [];
  for (let i = 0; i < count; i++) {
    const along = start + i * pitch;
    const cx = origin.x + dir.x * along;
    const cy = origin.y + dir.y * along;
    const addSpan = (from: number, to: number): void => {
      bars.push({
        a: { x: cx + nrm.x * from, y: cy + nrm.y * from },
        b: { x: cx + nrm.x * to, y: cy + nrm.y * to },
        width: BAR_WIDTH,
      });
    };
    if (inner > 0) {
      addSpan(-outer, -inner);
      addSpan(inner, outer);
    } else {
      addSpan(-outer, outer);
    }
  }
  return bars;
}

/**
 * Whether any of a junction's painted detail can reach the view.
 *
 * The detail of one leg occupies the band from the near edge of the zebra to
 * the stop line, spanning the carriageway laterally. Both distances are
 * measured from the leg's virtual origin along its direction, and a large trim
 * puts that band a long way from the node — which is exactly what the previous
 * origin-only test missed.
 */
function junctionDetailReachesView(junction: Junction, view: Aabb): boolean {
  return junction.legs.some((leg, i) => {
    const trim = junction.trims[i] as number;
    const near = crosswalkDistance(trim) - CROSSWALK_DEPTH / 2;
    const far = stopLineDistance(trim);
    const a = { x: leg.origin.x + leg.dir.x * near, y: leg.origin.y + leg.dir.y * near };
    const b = { x: leg.origin.x + leg.dir.x * far, y: leg.origin.y + leg.dir.y * far };
    // The band spans the carriageway, so grow the segment's box by half a road.
    const half = leg.road.width / 2;
    const band: Aabb = {
      minX: Math.min(a.x, b.x) - half,
      minY: Math.min(a.y, b.y) - half,
      maxX: Math.max(a.x, b.x) + half,
      maxY: Math.max(a.y, b.y) + half,
    };
    return intersects(band, view);
  });
}

/**
 * Collects stop bars and crosswalks for every junction approach.
 *
 * `view`, when given, skips junctions whose legs all fall outside it. The bars
 * are rebuilt every frame, so building them for a junction nobody can see is
 * pure waste. Omit it to collect everything, which is what tests want.
 */
export function junctionDetail(net: Network, view?: Aabb): { stops: Bar[]; zebras: Bar[] } {
  const stops: Bar[] = [];
  const zebras: Bar[] = [];

  for (const [node, byLevel] of net.junctions) {
    const junction = byLevel.get(Level.Asphalt);
    if (!junction) continue;

    // Cull against where the bars are actually painted, not where the leg
    // starts.
    //
    // This used to test `containsPoint(view, leg.origin)`, and for a straight
    // leg `leg.origin` IS the node — while the bars it gates sit at
    // `trim + stopLineDistance` along the leg. `buildJunction` allows a trim of
    // up to 40x the half-width because a shallow fork legitimately needs a very
    // long gore, so on a 3-leg fork at 0/8/180 degrees the trims reach 336
    // units and every marking vanished while the asphalt under it still
    // painted, the cached scene paths not being culled at all.
    if (view && !junctionDetailReachesView(junction, view)) continue;

    // A stop line exists because movements conflict, which needs three legs.
    // A crossing exists because a pedestrian has to get to the other side,
    // which needs only two — and `SidewalkGraph` builds routable crossing edges
    // from two legs upward. Gating both on three legs left a corner node with
    // pedestrians walking over a carriageway that had no zebra painted on it.
    const movementsConflict = junction.legs.length >= 3;

    junction.legs.forEach((leg, i) => {
      const rt = leg.road;
      const trim = junction.trims[i] as number;
      // A stop line only means something where traffic arrives. A one-way leg
      // carrying only departing traffic gets a crossing but no bar.
      // Ask the network where the crossing is, do not re-derive it from the
      // trim. On a short link between two junctions the network suppresses the
      // crossing entirely — there is no room for one a driver would not park
      // on — and a painter computing its own `crosswalkDistance(trim)` would
      // cheerfully paint a zebra the model says is not there.
      const crossing = net.crosswalkDistanceAt(leg.seg, node);
      if (movementsConflict && leg.approaching) {
        const bar = stopBar(leg.origin, leg.dir, leg.nrm, rt, trim);
        if (bar) stops.push(bar);
      }
      if (crossing > 0) {
        zebras.push(...crosswalkBars(leg.origin, leg.dir, leg.nrm, rt, trim));
      }
    });
  }

  return { stops, zebras };
}

/**
 * The paint across a taper where one road carries on at another width.
 *
 * Marked the way a road designer marks a lane gain or a lane drop: the edge
 * lines follow the kerb as it swings out or in, the lanes the two roads share
 * keep their dividers straight through, and the line between the directions is
 * solid - no overtaking while the road changes shape - splitting to either side
 * of a central reservation where one begins. A lane that exists on one side
 * only gets its divider on its own road, starting where the taper ends.
 *
 * It used to be bare asphalt between two zebra crossings.
 */
export function transitionMarkings(net: Network, node: NodeId): StrokeSpec[] {
  const junction = net.junctions.get(node)?.get(Level.Asphalt);
  if (!junction || !junction.transition || junction.legs.length !== 2) return [];
  const a = junction.legs[0] as Leg;
  const b = junction.legs[1] as Leg;
  const ra = a.road;
  const rb = b.road;
  const axis = new TransitionAxis(a, junction.trims[0] as number, b, junction.trims[1] as number);
  const mix = (p: number, q: number) => (u: number): number => p + (q - p) * taperEase(u);
  const half = mix(ra.width / 2, rb.width / 2);
  const out: StrokeSpec[] = [];
  const solid = (offset: (u: number) => number, width: number, color: string): void => {
    out.push({ points: axis.offset(offset), width, color, dash: null, dashOffset: 0 });
  };

  // Travel from `a` to `b` keeps to the right, the negative side of the axis.
  solid((u) => -(half(u) - 0.5), 0.5, EDGE_LINE_LIGHT);
  solid((u) => half(u) - 0.5, 0.5, EDGE_LINE_DARK);

  if (a.direction !== 'both' || b.direction !== 'both') return out;
  if (ra.markings === 'none' && rb.markings === 'none') return out;

  const median = mix(ra.median / 2, rb.median / 2);
  const lined = rb.markings === 'lanes' ? rb : ra.markings === 'lanes' ? ra : rb.markings !== 'none' ? rb : ra;
  if (ra.median > 0 || rb.median > 0) {
    // The two directions part to either side of the reservation's nose.
    const colour = markingColor(rb.median > 0 ? rb : ra);
    solid((u) => median(u), 0.7, colour);
    solid((u) => -median(u), 0.7, colour);
  } else {
    // One solid line, in each road's own colour on its own half of the taper.
    const line = axis.offset(() => 0);
    const mid = Math.floor(line.length / 2);
    const first = ra.markings === 'none' ? rb : ra;
    const second = rb.markings === 'none' ? ra : rb;
    out.push({ points: line.slice(0, mid + 1), width: 0.9, color: markingColor(first), dash: null, dashOffset: 0 });
    out.push({ points: line.slice(mid), width: 0.9, color: markingColor(second), dash: null, dashOffset: 0 });
  }

  // The lanes both roads have run straight through.
  const shared = Math.min(lanesPerDirection(ra), lanesPerDirection(rb));
  const lane = mix(laneWidth(ra), laneWidth(rb));
  for (let k = 1; k < shared; k++) {
    for (const side of [-1, 1]) {
      out.push({
        points: axis.offset((u) => side * (median(u) + lane(u) * k)),
        width: 0.7,
        color: markingColor(lined),
        dash: DASH,
        dashOffset: 0,
      });
    }
  }
  return out;
}
