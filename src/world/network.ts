import { MIN_RIBBON, SEAM_OVERLAP, SURFACE_END_STEP } from '@core/scalar';
import { Ring } from '@core/ring';
import { offsetPolyline } from '@core/offset';
import { Polyline } from '@core/polyline';
import { type Vec2, dot } from '@core/vec2';
import type { RoadDoc } from './doc';
import type { SegmentDirection } from './doc';
import type { NodeId, SegmentId } from './ids';
import { PolylineCache, segmentStartsAt } from './geometry';
import {
  Level,
  SURFACE_LEVELS,
  type SurfaceLevel,
  halfWidth,
  roadProfile,
  roadType,
} from './roadTypes';
import { type Junction, buildJunction, surfaceMode } from './junction/build';
import { clampSegmentTrims } from './junction/trim';
import { TRANSITION_BEND } from './junction/transition';
import { impossibleNodes } from './legAngles';
import { WalkableSurface } from './walkable';
import {
  CROSSWALK_CAP,
  CROSSWALK_DEPTH,
  MIN_LINK_LENGTH,
  STOP_BAR_SETBACK,
  STOP_LINE_CAP,
  crosswalkDistance as crosswalkAt,
  stopLineDistance as stopLine,
} from './approach';

/** Per-level trim distances at both ends of a segment. */
export interface SegmentTrims {
  /** Trim at the `a` endpoint, indexed by surface level. */
  readonly a: Record<number, number>;
  /** Trim at the `b` endpoint, indexed by surface level. */
  readonly b: Record<number, number>;
}

export interface SegmentRibbon {
  readonly id: SegmentId;
  readonly typeIndex: number;
  readonly direction: SegmentDirection;
  /** Resolved width and marking profile, including lane overrides. */
  readonly road: ReturnType<typeof roadProfile>;
  /** Centreline trimmed for this level, in world space. */
  readonly centre: Record<number, Polyline>;
  /** Closed carriageway outline for this level. */
  readonly rings: Record<number, Ring>;
  /** Arc-length offset for dash phase continuity across splits. */
  readonly dashOrigin: number;
  /** Full untrimmed centreline, shared by every level. */
  readonly full: Polyline;
}

/**
 * All geometry derived from the authoring document.
 *
 * Everything here is rebuilt at commit time and never lazily during drawing.
 * The V6 monolith recomputed junction outlines inside the render loop — seven
 * times per node per frame, each one re-filtering every segment in the world —
 * and let `approachAxis` rebuild signal plans from the renderer (defects 5.7
 * and 3.3). Nothing in this class is reachable from a draw call.
 */
export class Network {
  private crossingWalkable: WalkableSurface | null = null;
  private readonly crossingDistances = new Map<string, number>();
  readonly junctions = new Map<NodeId, Map<SurfaceLevel, Junction>>();
  readonly ribbons = new Map<SegmentId, SegmentRibbon>();

  /**
   * Nodes the editor would refuse to create, with the gap that condemns them,
   * in radians. This is the MARK, and it is derived rather than stored.
   *
   * A flag written into the document would have to be kept in step with every
   * move, split, delete and undo, and a stale mark is worse than none: it either
   * accuses a node that has since been straightened or misses one that has just
   * been bent. Recomputed here, it cannot disagree with the geometry, and it
   * needs no migration for maps saved before the rule existed.
   */
  readonly impossible = new Map<NodeId, number>();
  readonly trims = new Map<SegmentId, SegmentTrims>();
  /**
   * Nodes where one road carries on at another width, built as a taper rather
   * than as a junction (`junction/transition.ts`).
   */
  readonly transitions = new Set<NodeId>();
  readonly polylines = new PolylineCache();

  /** Matches `RoadDoc.revision` at the time of the last rebuild. */
  revision = -1;
  /** Road plan revision; vertical-only edits leave it unchanged. */
  trafficRevision = -1;

  constructor(readonly doc: RoadDoc) {}

  /** Nodes that carry a junction surface. */
  junctionNodes(): NodeId[] {
    return [...this.junctions.keys()];
  }

  junctionAt(node: NodeId, level: SurfaceLevel): Junction | undefined {
    return this.junctions.get(node)?.get(level);
  }

  /**
   * Rebuilds every derived surface.
   *
   * Two solver passes, then a hard clamp. The first pass finds what each
   * junction wants; segments then reconcile the two ends against their own
   * length and hand back a scale factor; the second pass re-solves with curb
   * radii scaled by that factor, because a smaller radius needs a shorter run
   * and therefore a shorter trim. A final clamp guarantees the invariant even
   * where the second pass did not fully converge.
   */
  rebuild(): void {
    this.crossingWalkable = null;
    this.crossingDistances.clear();
    this.polylines.clear();
    this.junctions.clear();
    this.ribbons.clear();
    this.trims.clear();
    this.transitions.clear();

    const active = [...this.doc.nodes.keys()].filter(
      (id) => surfaceMode(this.doc, this.polylines, id) === 'junction',
    );

    // ---- pass 1: unconstrained -------------------------------------------
    let scaleBySegment = new Map<number, number>();
    const solved = this.solve(active, scaleBySegment);
    scaleBySegment = this.reconcile(solved);

    // ---- passes 2 and 3: ONLY the nodes under length pressure -------------
    //
    // Both later passes exist for one situation: a link too short to give both
    // of its junctions everything they asked for. `reconcile` reports exactly
    // which segments that happened on — `scaleBySegment` holds a segment only
    // when its own clamp bit — so a node touching none of them is re-solved to
    // the identical answer. Its radii are unscaled and its trim caps do not
    // bind, because a cap can only bind where the clamp lowered something.
    //
    // Re-solving all of them anyway is what made drawing a road stall. Measured
    // on a 205-segment map: a full rebuild took 55 ms, `commitDraft` pays for
    // three of them plus a simulation topology rebuild, and the map freezes for
    // about a fifth of a second per road — worse the bigger the map gets, which
    // is precisely the complaint. On an ordinary map almost nothing is under
    // pressure, so the two extra passes now cost almost nothing.
    const pressured2 = nodesTouching(this.doc, active, scaleBySegment);
    if (pressured2.length) {
      for (const [node, byLevel] of this.solve(pressured2, scaleBySegment)) {
        solved.set(node, byLevel);
      }
      scaleBySegment = this.reconcile(solved);
    }

    // A short link can still need a hard length clamp after its radii have
    // been reduced. Rebuild the visible junction geometry once with those
    // exact caps so a junction mouth cannot remain farther out than the ribbon
    // that butts into it.
    const pressured3 = nodesTouching(this.doc, active, scaleBySegment);
    if (pressured3.length) {
      for (const [node, byLevel] of this.solve(pressured3, scaleBySegment, true)) {
        solved.set(node, byLevel);
      }
    }

    // ---- store, applying the hard clamp -----------------------------------
    for (const [node, byLevel] of solved) {
      this.junctions.set(node, byLevel);
      if (byLevel.get(Level.Asphalt)?.transition) this.transitions.add(node);
    }

    // The third pass only lowers trims (`capTrims` is a `Math.min`), so the
    // junctions can end up tighter than the numbers `reconcile` stored on pass
    // two. Adopting the built geometry's own trims makes the mouth and the
    // ribbon read the same number BY CONSTRUCTION rather than by coincidence.
    //
    // Without this they diverged for real: a randomised sweep found a five-leg
    // node where `trims` said 20.25 while the junction had settled at 15.91,
    // which is 4.3 units of bare terrain between the mouth and the ribbon —
    // defect 1.5 arriving through the solver instead of through a second
    // formula. The road fuzzer (`tests/fuzz`, category `trimOrder`) sweeps for it.
    this.adoptSolvedTrims(solved);

    this.buildRibbons();
    this.impossible.clear();
    // The network's OWN cache, not a fresh one. Building a second cache here
    // re-flattened every bezier in the document a second time on every rebuild,
    // and a rebuild happens on every edit — pure duplicated work for a set of
    // polylines that were computed moments earlier and are still valid.
    for (const [node, gap] of impossibleNodes(this.doc, this.polylines)) {
      this.impossible.set(node, gap);
    }

    this.revision = this.doc.revision;
    this.trafficRevision = this.doc.trafficRevision;
    // A full rebuild has consumed every authoring invalidation.  Leaving ids
    // in these sets made subsequent edits to the same node look unchanged.
    this.doc.clearDirty();
  }

  /**
   * Takes over another network's derived geometry instead of recomputing it.
   *
   * `commitDraft` works on a clone, builds a network for it to find crossings
   * and splits, and then — on success — replaces the live document with the
   * clone and rebuilds the live network from scratch. That last rebuild is pure
   * repetition: the clone's network was just built from the very same segments,
   * and `RoadDoc.replaceWith` has already made the two documents equal.
   *
   * Measured on a 205-segment map: a rebuild costs about 55 ms, and drawing one
   * road paid for three of them. Dropping this one is a third of the stall the
   * user feels, and it grows with the map, which is exactly the complaint.
   *
   * The polyline cache comes across too. It is keyed by segment id, and after
   * `replaceWith` the ids and their geometry are the same objects' values, so
   * every entry in it is still the right answer.
   */
  adopt(other: Network): void {
    this.junctions.clear();
    for (const [node, byLevel] of other.junctions) this.junctions.set(node, byLevel);
    this.ribbons.clear();
    for (const [seg, ribbon] of other.ribbons) this.ribbons.set(seg, ribbon);
    this.trims.clear();
    for (const [seg, t] of other.trims) this.trims.set(seg, t);
    this.transitions.clear();
    for (const node of other.transitions) this.transitions.add(node);
    this.impossible.clear();
    for (const [node, gap] of other.impossible) this.impossible.set(node, gap);
    this.polylines.adopt(other.polylines);
    this.revision = this.doc.revision;
    this.trafficRevision = this.doc.trafficRevision;
    this.doc.clearDirty();
  }

  private solve(
    nodes: readonly NodeId[],
    radiusScaleBySegment: ReadonlyMap<number, number>,
    useReconciledTrimCaps = false,
  ): Map<NodeId, Map<SurfaceLevel, Junction>> {
    const out = new Map<NodeId, Map<SurfaceLevel, Junction>>();
    for (const node of nodes) {
      const byLevel = new Map<SurfaceLevel, Junction>();
      for (const level of SURFACE_LEVELS) {
        const maxTrimBySegment = useReconciledTrimCaps
          ? this.trimCapsAt(node, level)
          : undefined;
        const j = buildJunction(this.doc, this.polylines, node, level, {
          radiusScaleBySegment,
          ...(maxTrimBySegment ? { maxTrimBySegment } : {}),
        });
        if (j) byLevel.set(level, j);
      }
      if (byLevel.size) out.set(node, byLevel);
    }
    return out;
  }

  /** Final per-leg caps for one junction after segment-end reconciliation. */
  private trimCapsAt(node: NodeId, level: SurfaceLevel): ReadonlyMap<number, number> {
    const caps = new Map<SegmentId, number>();
    const source = this.doc.node(node);
    if (!source) return caps;
    for (const id of source.incident) {
      const segment = this.doc.segment(id);
      const trims = this.trims.get(id);
      if (!segment || !trims) continue;
      const side = segment.a === node ? trims.a : trims.b;
      caps.set(id, side[level] ?? 0);
    }
    return caps;
  }

  /**
   * Reconciles each segment's two ends against its length, per level, and
   * returns the curb-radius scale each segment should use on the next pass.
   *
   * This writes `this.trims`, so it is also what the ribbon builder and every
   * consumer of a stop line reads. There is one trim number per segment end per
   * level in the entire engine.
   */
  private reconcile(
    solved: ReadonlyMap<NodeId, Map<SurfaceLevel, Junction>>,
  ): Map<number, number> {
    const demand = new Map<SegmentId, SegmentTrims>();

    const ensure = (id: SegmentId): SegmentTrims => {
      let t = demand.get(id);
      if (!t) {
        t = { a: {}, b: {} };
        demand.set(id, t);
      }
      return t;
    };

    for (const [node, byLevel] of solved) {
      for (const [level, junction] of byLevel) {
        junction.legs.forEach((leg, i) => {
          const seg = this.doc.segment(leg.seg);
          if (!seg) return;
          const slot = ensure(leg.seg);
          const side = seg.a === node ? slot.a : slot.b;
          side[level] = Math.max(side[level] ?? 0, junction.trims[i] as number);
        });
      }
    }

    const scale = new Map<number, number>();

    for (const id of this.doc.segments.keys()) {
      const t = demand.get(id) ?? { a: {}, b: {} };
      const length = this.polylines.get(this.doc, id).length;
      let worst = 1;

      for (const level of SURFACE_LEVELS) {
        const a = t.a[level] ?? 0;
        const b = t.b[level] ?? 0;
        const clamped = clampSegmentTrims({ a, b, length });
        t.a[level] = clamped.a;
        t.b[level] = clamped.b;
        if (clamped.scale < worst) worst = clamped.scale;
      }

      this.trims.set(id, t);
      if (worst < 1) scale.set(id, worst);
    }

    return scale;
  }

  /**
   * Copies the trims the built junctions actually used back into `this.trims`.
   *
   * Only lowers: a segment end with no junction keeps whatever `reconcile`
   * decided, and an end whose junction ended up tighter adopts the tighter
   * number. Raising here would push a ribbon back out past a mouth that was
   * deliberately capped, which is the failure this exists to prevent.
   */
  private adoptSolvedTrims(
    solved: ReadonlyMap<NodeId, Map<SurfaceLevel, Junction>>,
  ): void {
    for (const [node, byLevel] of solved) {
      for (const [level, junction] of byLevel) {
        junction.legs.forEach((leg, i) => {
          const seg = this.doc.segment(leg.seg);
          const stored = this.trims.get(leg.seg);
          if (!seg || !stored) return;
          const side = seg.a === node ? stored.a : stored.b;
          side[level] = Math.min(side[level] ?? Infinity, junction.trims[i] as number);
        });
      }
    }
  }

  private buildRibbons(): void {
    for (const [id, seg] of this.doc.segments) {
      const full = this.polylines.get(this.doc, id);
      const rt = roadProfile(seg.type, seg.lanes, seg.direction);
      const t = this.trims.get(id) ?? { a: {}, b: {} };
      const length = full.length;

      const centre: Record<number, Polyline> = {};
      const rings: Record<number, Ring> = {};

      for (const level of SURFACE_LEVELS) {
        // Pull the ribbon back INTO the junction by a hair. Under a single
        // nonzero fill this overlap is invisible, and it removes any chance of
        // a hairline of terrain showing where the two surfaces meet — the seam
        // the V6 monolith produced by compositing translucent layers twice.
        const a = Math.max(0, (t.a[level] ?? 0) - SEAM_OVERLAP);
        const b = Math.max(0, (t.b[level] ?? 0) - SEAM_OVERLAP);
        const s0 = Math.min(a, Math.max(0, length - MIN_RIBBON));
        const s1 = Math.max(s0 + MIN_RIBBON * 0.5, length - b);

        const trimmed = full.sub(s0, Math.min(s1, length));
        centre[level] = trimmed;
        // The SURFACE overlaps its neighbour; the CENTRELINE above does not.
        //
        // `SEAM_OVERLAP` exists so a ribbon pushes a hair into the junction it
        // meets and nonzero fill hides the join. At a chain node — two roads of
        // one class running straight through — `surfaceMode` builds NO junction,
        // so the trims are zero, and `Math.max(0, 0 - SEAM_OVERLAP)` clamps the
        // overlap away exactly where there is no junction to hide behind. The
        // two ribbons then meet edge to edge and the surface under them shows
        // through the join as a pale line across the road, at every node where
        // one road continues into the next.
        //
        // So an end that was not trimmed is pushed OUT instead, into its
        // neighbour. `centre` keeps the honest length: it carries the dash phase
        // and every marking, and lengthening it would slide the lane lines.
        rings[level] = ribbonRing(
          overlapUntrimmedEnds(
            trimmed,
            s0 <= 0,
            s1 >= length,
            SEAM_OVERLAP + (level - Level.Casing) * SURFACE_END_STEP,
          ),
          halfWidth(rt, level),
        );
      }

      this.ribbons.set(id, {
        id,
        typeIndex: seg.type,
        direction: seg.direction,
        road: rt,
        centre,
        rings,
        dashOrigin: seg.dashOrigin,
        full,
      });
    }
  }

  /**
   * Whether a node is one road carrying on rather than an intersection: two
   * legs, and no control device the player put there.
   *
   * Such a node still has a junction outline whenever its two roads differ -
   * a change of class, of lane count, of structure, or a bend - but it has no
   * approach: no zebra, no stop line, and the lanes run to its mouth. It used
   * to get a crossing on both legs, so a street widening into a boulevard was
   * painted as a crossroads with two of its arms missing.
   */
  continues(node: NodeId): boolean {
    const record = this.doc.node(node);
    if (!record || record.incident.length !== 2) return false;
    if (record.control !== 'auto' && record.control !== 'none') return false;
    if (this.junctions.get(node)?.get(Level.Asphalt)?.transition) return true;
    // A continuous two-leg bend has no approach or zebra; the footway follows
    // its outer edge. Width-changing corners and curved alignments use the
    // transition sweep rather than a crossroads plate.
    const legs = this.junctions.get(node)?.get(Level.Asphalt)?.legs;
    if (!legs || legs.length !== 2) return true;
    return dot((legs[0] as { dir: Vec2 }).dir, (legs[1] as { dir: Vec2 }).dir) < -Math.cos(TRANSITION_BEND);
  }

  /**
   * Whether a node is a junction of three legs or more.
   *
   * A zero mouth distance is the sentinel for "no junction mouth on this end":
   * a dead end, a road bending at a node. But a junction leg can have a zero
   * mouth too - the wide arm of a fork, whose corners with the narrower arms
   * fall behind the node, needs no trim. Read as the sentinel, that arm got no
   * crossing and a stop line at the node itself, a crossing's depth past the
   * bar painted for it.
   */
  private isJunction(node: NodeId): boolean {
    return (this.doc.node(node)?.incident.length ?? 0) >= 3;
  }

  /** Distance from a node to this segment's junction mouth, at asphalt level. */
  mouthDistance(seg: SegmentId, node: NodeId): number {
    const s = this.doc.segment(seg);
    if (!s) return 0;
    const t = this.trims.get(seg);
    if (!t) return 0;
    const side = segmentStartsAt(s, node) ? t.a : t.b;
    return side[Level.Asphalt] ?? 0;
  }

  /**
   * Distance from a node at which vehicles must stop on the given segment.
   *
   * Derived from the same asphalt trim the junction mouth uses, plus the
   * approach zone that holds the crossing. There is one trim in the engine, so
   * a stop line and a junction mouth cannot disagree.
   *
   * The V6 monolith had a separate `approachSetback` formula that could exceed
   * the segment's own length, which pinned vehicles at progress zero forever
   * (defect 2 / 1b of RELATORIO.md).
   */
  stopLineDistance(seg: SegmentId, node: NodeId): number {
    const mouth = this.mouthDistance(seg, node);
    if (mouth <= 0 && !this.isJunction(node)) return 0;
    // Nothing stops where a road merely carries on: the link runs to the mouth
    // and the lanes continue across the node.
    if (this.continues(node)) return mouth;
    const length = this.polylines.get(this.doc, seg).length;
    // Never let the approach zone eat the whole segment.
    const capped = Math.min(stopLine(mouth), length * STOP_LINE_CAP);
    // ...but the fractional cap may never pull the stop line onto the zebra.
    // The crossing's position is the protected one — a kerb placed for it must
    // stay out of the carriageway — so when the two constraints disagree it is
    // the stop line that moves outward, not the crossing that moves in.
    // Without this, a boulevard with 84-unit arms put the bar 0.87 units inside
    // the far edge of its own crossing: the two distances reached their shared
    // ordering through separate clamps (0.45 and 0.49 of segment length) and
    // nothing structural kept them ordered once both bound.
    const crossing = this.crosswalkDistanceAt(seg, node);
    const behindCrossing =
      crossing > 0 ? crossing + CROSSWALK_DEPTH / 2 + STOP_BAR_SETBACK : 0;
    // ...and never inside the junction plate. On a short leg into a wide, acute
    // junction the fractional cap bit below the mouth itself (the fuzzer's
    // `trimOrder`: a 184-unit leg with an 85-unit mouth stopped its lanes at
    // 83), which ended the lanelets and started every connector ON the plate.
    return Math.max(capped, behindCrossing, mouth);
  }

  /**
   * Distance from a node to the centre of this segment's crossing.
   *
   * Clamped against the MOUTH, never against a bare fraction of the segment.
   * On a short edge beside a wide junction, a fractional cap pushes the
   * crossing back inside the junction — and any kerb placed for it then sits in
   * the carriageway, which is precisely the class of bug this rewrite exists to
   * make impossible. The crossing may end up closer to the segment's midpoint
   * than is ideal; it may never end up inside the road.
   */
  crosswalkDistanceAt(seg: SegmentId, node: NodeId): number {
    const cacheKey = `${seg}:${node}`;
    const cached = this.crossingDistances.get(cacheKey);
    if (cached !== undefined) return cached;
    if (this.doc.node(node)?.incident.some((id) => {
      const kind = this.doc.segment(id)?.type;
      return kind !== undefined &&
        (roadType(kind).id === 'highway' || roadType(kind).id === 'ramp');
    })) return 0;
    const mouth = this.mouthDistance(seg, node);
    if (mouth <= 0 && !this.isJunction(node)) return 0;
    if (this.continues(node)) return 0;
    const length = this.polylines.get(this.doc, seg).length;
    const clear = mouth + CROSSWALK_DEPTH / 2 + 1;

    // Both ends of a segment want an approach zone, and a short link cannot
    // give both. Half the drivable length is this end's share; a crossing that
    // does not leave room for its own stop line inside that share is a crossing
    // a driver would park on, so there is no crossing here at all.
    //
    // Suppressing it is what keeps the ordering unbreakable further down:
    // with the crossing capped this way, both stop lines fit without anyone
    // rescaling them, and rescaling is what used to pull the bar inside the
    // zebra on a 16-unit link between two junctions.
    const halfBudget = Math.max(0, (length - MIN_RIBBON) / 2);
    const segment = this.doc.segment(seg);
    if (!segment) return 0;
    const other = segmentStartsAt(segment, node) ? segment.b : segment.a;
    const oppositeMouth = this.mouthDistance(seg, other);
    const storageCap = length - oppositeMouth - MIN_LINK_LENGTH - CROSSWALK_DEPTH / 2 - STOP_BAR_SETBACK;
    const orderingCap = Math.min(halfBudget - CROSSWALK_DEPTH / 2 - STOP_BAR_SETBACK, storageCap);
    if (orderingCap < clear) return 0;

    const proposed = Math.min(Math.max(crosswalkAt(mouth), clear), length * CROSSWALK_CAP, orderingCap);
    const limit = Math.min(length * CROSSWALK_CAP, orderingCap);
    const profile = roadProfile(segment.type, segment.lanes, segment.direction);
    const lateral = profile.width / 2 + profile.sidewalk / 2;
    const line = this.polylines.get(this.doc, seg);
    const walkable = this.crossingWalkable ??= new WalkableSurface(this);
    const fits = (distance: number): boolean => {
      const frame = line.sampleAt(segment.a === node ? distance : length - distance);
      const nx = -frame.t.y, ny = frame.t.x;
      return walkable.footway(frame.p.x + nx * lateral, frame.p.y + ny * lateral) &&
        walkable.footway(frame.p.x - nx * lateral, frame.p.y - ny * lateral);
    };
    for (let distance = proposed; distance <= limit; distance += 0.5) {
      if (fits(distance)) {
        this.crossingDistances.set(cacheKey, distance);
        return distance;
      }
    }
    const result = fits(limit) ? limit : 0;
    this.crossingDistances.set(cacheKey, result);
    return result;
  }
}

/**
 * Closes a trimmed centreline into a carriageway outline of half-width `hw`.
 *
 * Both sides are offset with full miter compensation and loop pruning, then
 * joined by butt ends. The ends are square by design: they butt against a
 * junction mouth cut at exactly the same distance.
 */
/**
 * The nodes that touch a segment whose length clamp actually bit.
 *
 * `reconcile` returns a scale only for segments where it had to take something
 * away, so this is the exact set whose junctions can still change on a later
 * pass. Everything else is already final.
 */
function nodesTouching(
  doc: RoadDoc,
  candidates: readonly NodeId[],
  scaleBySegment: ReadonlyMap<number, number>,
): NodeId[] {
  if (scaleBySegment.size === 0) return [];
  const out: NodeId[] = [];
  for (const id of candidates) {
    const node = doc.node(id);
    if (!node) continue;
    for (const seg of node.incident) {
      if (scaleBySegment.has(seg)) {
        out.push(id);
        break;
      }
    }
  }
  return out;
}

/**
 * Pushes an untrimmed end of a ribbon `amount` past the node.
 *
 * Only ends that were not trimmed move, and they move ALONG the end tangent, so
 * the cross-section stays square to the road and the two neighbours overlap by
 * a strip rather than crossing at an angle. An end that meets a junction is
 * already handled by the subtraction that names this constant and is left
 * alone.
 */
function overlapUntrimmedEnds(
  line: Polyline,
  atStart: boolean,
  atEnd: boolean,
  amount = SEAM_OVERLAP,
): Polyline {
  if (!atStart && !atEnd) return line;
  const pts = line.toPoints();
  if (pts.length < 2) return line;

  const push = (from: Vec2, towards: Vec2): Vec2 => {
    const dx = from.x - towards.x;
    const dy = from.y - towards.y;
    const len = Math.hypot(dx, dy);
    if (len < MIN_RIBBON * 0.01) return from;
    return { x: from.x + (dx / len) * amount, y: from.y + (dy / len) * amount };
  };

  const out = [...pts];
  if (atStart) out[0] = push(out[0] as Vec2, out[1] as Vec2);
  if (atEnd) {
    const last = out.length - 1;
    out[last] = push(out[last] as Vec2, out[last - 1] as Vec2);
  }
  return Polyline.fromPoints(out);
}

export function ribbonRing(centre: Polyline, hw: number): Ring {
  if (centre.n < 2 || centre.length <= 0) {
    return new Ring({ x: 0, y: 0 }, []);
  }
  const pts = centre.toPoints();
  const left = offsetPolyline(pts, hw);
  const right = offsetPolyline(pts, -hw);
  const loop: Vec2[] = [...left, ...right.slice().reverse()];
  return Ring.fromPolygon(loop).ensurePositive();
}
