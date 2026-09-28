import { Polyline } from '@core/polyline';
import { pointInPolygon } from '@core/polygon';
import { type Vec2, addScaled, angleOf, dist, normalize, perp, sub } from '@core/vec2';
import type { NodeId, SegmentId } from '@world/ids';
import type { RoadDoc } from '@world/doc';
import type { Network } from '@world/network';
import { Level, roadProfile } from '@world/roadTypes';
import { CROSSWALK_DEPTH } from '@world/approach';
import { m } from '@world/units';
import { orientedPolyline } from '@world/geometry';
import type { LaneletGraph, LaneletId } from '@world/lanelets';
import { makeCrossingId, type CrossingId } from '../signals/plan';
import { COARSE_EPS } from '@core/scalar';
import { WalkableSurface } from '@world/walkable';
import { Corridor, type CorridorFrame } from './corridor';
import { PED_BEHAVIOUR } from './behaviour';

export type SidewalkNodeId = string;
export type SidewalkEdgeId = string;
export type Side = -1 | 1;

export interface SidewalkNode {
  readonly id: SidewalkNodeId;
  readonly at: Vec2;
  readonly node: NodeId;
  readonly segment: SegmentId;
  readonly side: Side;
}

export type SidewalkEdgeKind = 'walk' | 'corner' | 'crossing';


export interface SidewalkEdge {
  readonly id: SidewalkEdgeId;
  readonly kind: SidewalkEdgeKind;
  readonly from: SidewalkNodeId;
  readonly to: SidewalkNodeId;
  readonly path: Polyline;
  readonly length: number;
  /**
   * Half the walkable width either side of the path, in world units.
   *
   * People do not walk on a centreline, and the width they have to spread
   * across is a property of the footway, not of the pedestrian. Carrying it on
   * the edge is what lets the same steering rule put four abreast on a
   * boulevard and single file down a lane, with no branch naming either.
   */
  readonly halfWidth: number;
  /** Crossings only: the junction and leg being crossed. */
  readonly node?: NodeId;
  readonly segment?: SegmentId;
  readonly crossing?: CrossingId;
  /** Crossings only: the vehicle lanelets this edge passes over. */
  readonly lanes?: readonly LaneletId[];
  /**
   * The walking corridor: a continuous frame along `path` and the walls
   * either side of it, fitted to the footway that is really drawn. Where a
   * pedestrian may stand on this edge is exactly what it allows.
   */
  readonly corridor: Corridor;
}

/** An edge as it is declared, before its corridor is built. */
type EdgeSpec = Omit<SidewalkEdge, 'corridor'>;

/**
 * The pedestrian network, derived from the SAME junction geometry that trims
 * the vehicle lanelets.
 *
 * Two structural facts here fix the pedestrian defects outright.
 *
 * A pedestrian's waiting position is a graph node whose world coordinate is an
 * outward offset of the carriageway — not a fraction of a road edge. The V6
 * monolith computed it as `clamp((L - reach) / L, 0.7, 0.985)`, and that 0.7
 * FLOOR parked pedestrians at 70% of a short edge, physically inside the
 * junction (defect 4.1). There is no fraction and no clamp here, so that
 * position cannot be expressed.
 *
 * And crossings are real, routable edges. In the V6 monolith a pedestrian's
 * "turn" was a bezier rounding a corner between two sidewalks on the SAME side;
 * the painted zebras were pure decoration and nobody ever crossed a road
 * (defect 4.9). The edges built here ARE the zebras.
 */
export class SidewalkGraph {
  readonly nodes = new Map<SidewalkNodeId, SidewalkNode>();
  readonly edges = new Map<SidewalkEdgeId, SidewalkEdge>();
  readonly adjacency = new Map<SidewalkNodeId, SidewalkEdgeId[]>();
  readonly crossings = new Map<CrossingId, SidewalkEdgeId>();

  /**
   * Node ids in a stable order, as the pool pedestrians draw destinations from.
   *
   * Held here rather than materialised per choice because a destination is
   * picked every time somebody reaches a junction, and building a sorted array
   * of every node each time is a per-pedestrian allocation on a hot path.
   */
  readonly goalNodes: SidewalkNodeId[] = [];

  /** Who is on which edge, rebuilt once a tick by the pedestrian step. */
  readonly occupancy = new PedEdgeIndex();

  /** The footway as drawn, which the corridors are fitted to. Null before the first build. */
  walkable: WalkableSurface | null = null;
  /** Corridor stations with no footway anywhere near them, from the last build: a diagnostic. */
  unfitted = 0;

  private readonly reversedPaths = new Map<SidewalkEdgeId, Polyline>();

  build(doc: RoadDoc, net: Network, graph: LaneletGraph): void {
    this.nodes.clear();
    this.edges.clear();
    this.adjacency.clear();
    this.crossings.clear();
    this.goalNodes.length = 0;
    this.occupancy.reset();
    this.reversedPaths.clear();
    const walkable = new WalkableSurface(net);
    this.walkable = walkable;

    // ---- kerb nodes, two per (junction node, leg) -------------------------
    for (const [nodeId, node] of doc.nodes) {
      for (const segId of node.incident) {
        const seg = doc.segment(segId);
        if (!seg) continue;
        const rt = roadProfile(seg.type, seg.lanes, seg.direction);
        const pl = orientedPolyline(doc, seg, nodeId);
        if (pl.length < 1) continue;

        const lateral = rt.width / 2 + rt.sidewalk * 0.5;
        const want = kerbDistance(
          net.crosswalkDistanceAt(segId, nodeId),
          pl.length,
          net.mouthDistance(segId, nodeId),
        );
        const crossS = clearOfJunction(net, nodeId, pl, want, lateral, pl.length);
        const frame = pl.sampleAt(crossS);
        const nrm = perp(frame.t);

        for (const side of [-1, 1] as const) {
          const id = kerbId(nodeId, segId, side);
          this.nodes.set(id, {
            id,
            at: addScaled(frame.p, nrm, lateral * side),
            node: nodeId,
            segment: segId,
            side,
          });
        }
      }
    }

    // ---- crossing edges, one per leg --------------------------------------
    for (const [nodeId, node] of doc.nodes) {
      if (node.incident.length < 2) continue;
      for (const segId of node.incident) {
        if (net.crosswalkDistanceAt(segId, nodeId) <= 0) continue;
        const right = this.nodes.get(kerbId(nodeId, segId, -1));
        const left = this.nodes.get(kerbId(nodeId, segId, 1));
        if (!right || !left) continue;

        const crossing = makeCrossingId(nodeId, segId);
        const path = Polyline.fromPoints([right.at, left.at]);
        const lanes = [...graph.lanelets.values()]
          .filter((l) => l.kind === 'link' && l.segment === segId)
          .map((l) => l.id);

        this.addEdge({
          id: `X:${crossing}`,
          kind: 'crossing',
          from: right.id,
          to: left.id,
          path,
          length: path.length,
          // The painted zebra is the whole of the width a pedestrian may use
          // here: spreading wider than the bars puts somebody on bare asphalt.
          halfWidth: CROSSWALK_DEPTH / 2,
          node: nodeId,
          segment: segId,
          crossing,
          lanes,
        });
        this.crossings.set(crossing, `X:${crossing}`);
      }
    }

    // ---- corner links, around each junction island ------------------------
    for (const [nodeId, node] of doc.nodes) {
      if (node.incident.length < 2) continue;

      const legs = node.incident
        .slice()
        .map((segId) => {
          const seg = doc.requireSegment(segId);
          const pl = orientedPolyline(doc, seg, nodeId);
          const look = Math.min(10, Math.max(0.5, pl.length * 0.2));
          const dir = normalize(sub(pl.sampleAt(look).p, pl.point(0)));
          const rt = roadProfile(seg.type, seg.lanes, seg.direction);
          return { segId, ang: angleOf(dir), footway: rt.sidewalk };
        })
        .sort((a, b) => a.ang - b.ang);

      for (let i = 0; i < legs.length; i++) {
        const a = legs[i] as { segId: SegmentId; footway: number };
        const b = legs[(i + 1) % legs.length] as { segId: SegmentId; footway: number };
        // Leg `a`'s left kerb joins leg `b`'s right kerb, matching the
        // counter-clockwise corner convention used by the junction builder.
        const from = this.nodes.get(kerbId(nodeId, a.segId, 1));
        const to = this.nodes.get(kerbId(nodeId, b.segId, -1));
        if (!from || !to || from.id === to.id) continue;
        const points = cornerPath(walkable, from.at, to.at, { x: node.x, y: node.y });
        const path = Polyline.fromPoints(points);
        this.addEdge({
          id: `C:${from.id}|${to.id}`,
          kind: 'corner',
          from: from.id,
          to: to.id,
          path,
          length: path.length,
          // A corner joins two footways of possibly different widths, so it
          // gets the narrower of the two. Its walls are the footway itself
          // (`fitCorridors`), so the whole of that width is real footway.
          halfWidth: Math.min(a.footway, b.footway) / 2,
        });
      }
    }

    // ---- sidewalk edges along each segment --------------------------------
    for (const [segId, seg] of doc.segments) {
      const rt = roadProfile(seg.type, seg.lanes, seg.direction);
      const pl = orientedPolyline(doc, seg, seg.a);
      if (pl.length < 1) continue;
      const lateral = rt.width / 2 + rt.sidewalk * 0.5;

      const s0 = kerbDistance(
        net.crosswalkDistanceAt(segId, seg.a),
        pl.length,
        net.mouthDistance(segId, seg.a),
      );
      const s1 = Math.max(
        s0 + 0.5,
        pl.length - kerbDistance(
          net.crosswalkDistanceAt(segId, seg.b),
          pl.length,
          net.mouthDistance(segId, seg.b),
        ),
      );
      const middle = pl.sub(s0, Math.min(s1, pl.length)).toPoints();

      for (const side of [-1, 1] as const) {
        // A's `+nrm` side is B's `-nrm` side, because the leg direction flips.
        const from = this.nodes.get(kerbId(seg.a, segId, side));
        const to = this.nodes.get(kerbId(seg.b, segId, (-side) as Side));
        if (!from || !to) continue;

        const offsetPts = middle.map((p, i) => {
          const t = pl.sampleAt(s0 + ((s1 - s0) * i) / Math.max(1, middle.length - 1)).t;
          return addScaled(p, perp(t), lateral * side);
        });
        const points: Vec2[] = [];
        for (const point of [from.at, ...offsetPts, to.at]) {
          if (!points.length || dist(points[points.length - 1]!, point) > 0.01) points.push(point);
        }
        const path = Polyline.fromPoints(points);
        this.addEdge({
          id: `W:${segId}:${side}`,
          kind: 'walk',
          from: from.id,
          to: to.id,
          path,
          length: path.length,
          halfWidth: rt.sidewalk / 2,
          segment: segId,
        });
      }
    }

    this.fitCorridors(walkable);

    // Destinations are drawn from this pool, so it has to be ordered by
    // something other than insertion: map order depends on which legs the
    // editor happened to build first, and a seeded run may not.
    this.goalNodes.push(...[...this.nodes.keys()].sort());
  }

  private addEdge(spec: EdgeSpec): void {
    if (spec.length < COARSE_EPS) return;
    const edge: SidewalkEdge = { ...spec, corridor: new Corridor(spec.path) };
    this.edges.set(edge.id, edge);
    pushAdj(this.adjacency, edge.from, edge.id);
    pushAdj(this.adjacency, edge.to, edge.id);
  }

  /**
   * Sets every corridor's walls from the footway that is drawn.
   *
   * At each station along a footway or corner edge the footway is measured
   * across the path, and the walls are its edges less `lateralMargin`, never
   * wider than the edge's own half-width. A zebra's walls are its painted
   * width: the carriageway either side of it is not somewhere to walk.
   *
   * A station with no footway anywhere across it (the graph runs where the
   * surface builder drew none, as over a viaduct join) keeps the edge's own
   * width, and is counted in `unfitted`.
   */
  private fitCorridors(walkable: WalkableSurface): void {
    this.unfitted = 0;
    const frame: CorridorFrame = { x: 0, y: 0, tx: 0, ty: 0, nx: 0, ny: 0 };
    const span = { lo: 0, hi: 0 };
    const margin = PED_BEHAVIOUR.lateralMargin;
    for (const edge of this.edges.values()) {
      const c = edge.corridor;
      const usable = Math.max(0, edge.halfWidth - margin);
      const fitted = new Uint8Array(c.stations);
      for (let k = 0; k < c.stations; k++) {
        c.lo[k] = -usable;
        c.hi[k] = usable;
        if (edge.kind === 'crossing') continue;
        c.frame(c.stationS(k), false, frame);
        const reach = edge.halfWidth + m(2.5);
        let found = walkable.footwaySpan(frame.x, frame.y, frame.nx, frame.ny, reach, span);
        let offset = 0;
        // The path itself is off the footway: find the footway beside it.
        for (let step = 1; !found && step * 0.25 <= reach; step++) {
          for (const side of [1, -1]) {
            offset = side * step * 0.25;
            if (walkable.footwaySpan(frame.x + frame.nx * offset, frame.y + frame.ny * offset,
              frame.nx, frame.ny, reach, span)) { found = true; break; }
          }
        }
        if (!found) { this.unfitted++; continue; }
        let lo = offset + span.lo + margin;
        let hi = offset + span.hi - margin;
        const cap = offset === 0 ? usable : edge.halfWidth + m(1);
        lo = Math.max(lo, -cap);
        hi = Math.min(hi, cap);
        if (lo > hi) { const mid = (lo + hi) / 2; lo = mid; hi = mid; }
        c.lo[k] = lo;
        c.hi[k] = hi;
        fitted[k] = 1;
      }
      // A station with no footway across it takes the walls of the nearest
      // one that has: the edge's own width there could reach into the road.
      if (edge.kind === 'crossing' || !fitted.includes(1)) continue;
      for (let k = 0; k < c.stations; k++) {
        if (fitted[k]) continue;
        let near = -1;
        for (let d = 1; near < 0 && d < c.stations; d++) {
          if (k - d >= 0 && fitted[k - d]) near = k - d;
          else if (k + d < c.stations && fitted[k + d]) near = k + d;
        }
        c.lo[k] = c.lo[near]!;
        c.hi[k] = c.hi[near]!;
      }
    }
  }

  edgesAt(node: SidewalkNodeId): readonly SidewalkEdgeId[] {
    return this.adjacency.get(node) ?? [];
  }

  /** The far endpoint of `edge` when entered from `from`. */
  other(edge: SidewalkEdge, from: SidewalkNodeId): SidewalkNodeId {
    return edge.from === from ? edge.to : edge.from;
  }

  /**
   * Path oriented so it starts at `from`. The reversed copy is built once per
   * edge and kept; the hot loop reads the corridor instead.
   */
  orientedPath(edge: SidewalkEdge, from: SidewalkNodeId): Polyline {
    if (edge.from === from) return edge.path;
    let reversed = this.reversedPaths.get(edge.id);
    if (!reversed) {
      reversed = edge.path.reversed();
      this.reversedPaths.set(edge.id, reversed);
    }
    return reversed;
  }

  crossingEdge(id: CrossingId): SidewalkEdge | undefined {
    const eid = this.crossings.get(id);
    return eid ? this.edges.get(eid) : undefined;
  }

  /** True when the two kerb nodes lie on opposite sides of their road. */
  isOppositeSide(a: SidewalkNodeId, b: SidewalkNodeId): boolean {
    const na = this.nodes.get(a);
    const nb = this.nodes.get(b);
    return !!na && !!nb && na.segment === nb.segment && na.side !== nb.side;
  }
}

/**
 * What the occupancy index needs to know about a pedestrian.
 *
 * Structural rather than an import of `Ped`, so the graph stays a description
 * of the ground and never a dependency of agent state.
 */
export interface EdgeOccupant {
  readonly id: number;
  readonly edge: SidewalkEdgeId;
  readonly entry: SidewalkNodeId;
  readonly s: number;
}

/**
 * Who is on each sidewalk edge, ordered along the edge.
 *
 * The model it replaces asked "who is ahead of me?" by scanning every
 * pedestrian in the world, once per pedestrian per tick. At the population
 * ceiling that is over two million comparisons a tick to answer fifteen
 * hundred questions whose answers were all within a metre or two.
 *
 * Ordering is by distance from the edge's `from` end, NOT by the walker's own
 * `s`: two people on one footway walking opposite ways measure `s` from
 * opposite ends, so their raw values are not comparable and sorting by them
 * interleaves nonsense. With one canonical axis, the person ahead and the
 * person coming the other way are both a short walk along the same array.
 *
 * Rebuilding is per tick and allocation-free after the first few: the arrays
 * are kept and truncated rather than replaced. The sort is an insertion sort,
 * which is quadratic in the occupants of ONE edge — bounded in practice
 * because the population is set by total road length (`PED_DENSITY`), so a
 * crowd large enough to matter comes with the edges to spread it over.
 */
export class PedEdgeIndex {
  private readonly ids = new Map<SidewalkEdgeId, number[]>();
  private readonly keys = new Map<SidewalkEdgeId, number[]>();
  private readonly slots = new Map<number, number>();
  private readonly active: SidewalkEdgeId[] = [];
  private static readonly EMPTY: readonly number[] = [];

  reset(): void {
    this.ids.clear();
    this.keys.clear();
    this.slots.clear();
    this.active.length = 0;
  }

  rebuild(graph: SidewalkGraph, occupants: readonly EdgeOccupant[]): void {
    for (const edge of this.active) {
      const ids = this.ids.get(edge);
      const keys = this.keys.get(edge);
      if (ids) ids.length = 0;
      if (keys) keys.length = 0;
    }
    this.active.length = 0;
    this.slots.clear();

    for (const o of occupants) {
      const edge = graph.edges.get(o.edge);
      if (!edge) continue;
      let ids = this.ids.get(o.edge);
      let keys = this.keys.get(o.edge);
      if (!ids || !keys) {
        ids = [];
        keys = [];
        this.ids.set(o.edge, ids);
        this.keys.set(o.edge, keys);
      }
      if (!ids.length) this.active.push(o.edge);
      ids.push(o.id);
      keys.push(o.entry === edge.from ? o.s : edge.length - o.s);
    }

    for (const edge of this.active) {
      const ids = this.ids.get(edge);
      const keys = this.keys.get(edge);
      if (!ids || !keys) continue;
      for (let i = 1; i < ids.length; i++) {
        const id = ids[i] as number;
        const key = keys[i] as number;
        let j = i - 1;
        while (j >= 0 && (keys[j] as number) > key) {
          keys[j + 1] = keys[j] as number;
          ids[j + 1] = ids[j] as number;
          j--;
        }
        keys[j + 1] = key;
        ids[j + 1] = id;
      }
      for (let i = 0; i < ids.length; i++) this.slots.set(ids[i] as number, i);
    }
  }

  /** Occupant ids of an edge, ordered from its `from` end. */
  occupants(edge: SidewalkEdgeId): readonly number[] {
    return this.ids.get(edge) ?? PedEdgeIndex.EMPTY;
  }

  /** Distance from the edge's `from` end, index-aligned with `occupants`. */
  positions(edge: SidewalkEdgeId): readonly number[] {
    return this.keys.get(edge) ?? PedEdgeIndex.EMPTY;
  }

  /** Index of an occupant within its own edge, or -1 when it is not indexed. */
  slotOf(id: number): number {
    return this.slots.get(id) ?? -1;
  }

  /** Distance to the nearest occupant of `edge` from a point on it. */
  nearestTo(edge: SidewalkEdge, position: number): number {
    const keys = this.keys.get(edge.id);
    if (!keys || !keys.length) return Infinity;
    let best = Infinity;
    for (const key of keys) {
      const d = Math.abs(key - position);
      if (d < best) best = d;
    }
    return best;
  }
}

/**
 * Clamps the crossing distance to something the segment can actually hold.
 *
 * The distance itself comes from `Network.crosswalkDistanceAt`, which derives
 * it from the SAME asphalt trim the junction mouth and the stop line use — so
 * the crossing always sits between the two, and vehicles halt behind waiting
 * pedestrians by construction.
 *
 * The V6 monolith drew its zebra at `junctionReach + 5.4` while walking
 * pedestrians at `junctionReach - 1.5`, about seven units apart, so pedestrians
 * never touched the painted crossing at all (defect 4.8).
 */
export function kerbDistance(
  crossingDistance: number,
  segmentLength: number,
  mouthDistance = 0,
): number {
  // A zero crossing distance is the network's sentinel for "no crossing fits on
  // this approach", NOT a crossing standing at the node. Reading it as a
  // distance put the kerb at the 2-unit floor below — inside the junction
  // surface — which is defect 4.1 arriving through the sentinel.
  //
  // With no crossing to stand beside, the kerb belongs at the junction mouth.
  const from = crossingDistance > 0 ? crossingDistance : mouthDistance;

  // No second cap on the crossing itself. `Network.crosswalkDistanceAt` has
  // already clamped it against the junction mouth; re-clamping against a bare
  // fraction of the segment would undo that and push the kerb back into the
  // carriageway.
  const floor = Math.max(mouthDistance, Math.min(2, segmentLength * 0.2));
  return Math.max(floor, Math.min(from, segmentLength * 0.5));
}

/**
 * Pushes a kerb outward until it is genuinely clear of the junction surface.
 *
 * Distance alone is not enough. Where a junction's legs have very unequal
 * trims — a narrow street meeting a boulevard on a short block — the corner
 * boundary sweeps between one leg's distant mouth and another's near one, and
 * can cover ground that is well past the SHORT leg's own mouth. A kerb placed
 * by distance would then still land on the carriageway.
 *
 * So the containment is tested rather than assumed, and the crossing steps
 * outward until it clears. The alternative — pushing every crossing out by the
 * junction's largest trim — would shove crossings absurdly far down narrow
 * legs for no benefit.
 */
function clearOfJunction(
  net: Network,
  node: NodeId,
  centre: Polyline,
  want: number,
  lateral: number,
  segmentLength: number,
): number {
  const junction = net.junctionAt(node, Level.Asphalt);
  if (!junction) return want;

  const surface = junction.rings.map((r) => r.flatten());
  const cap = Math.max(want, segmentLength * 0.6);
  let s = want;

  for (let attempt = 0; attempt < 14 && s < cap; attempt++) {
    const frame = centre.sampleAt(s);
    const nrm = perp(frame.t);
    const inside = ([-1, 1] as const).some((side) =>
      surface.some((poly) => pointInPolygon(addScaled(frame.p, nrm, lateral * side), poly)),
    );
    if (!inside) return s;
    s += 2;
  }
  return Math.min(s, cap);
}

/**
 * The path a corner takes round a junction, from kerb `a` to kerb `b`,
 * sweeping counter-clockwise about the junction's centre.
 *
 * Rays are cast from the centre at every step of the sweep, and each one
 * finds the stretches of footway it crosses; the path takes the middle of
 * the stretch nearest the radius it had on the ray before. So it follows the
 * footway band round whatever shape it has — a square outer corner, a rounded
 * kerb, the tip of a hairpin — continuously, from one kerb to the other.
 *
 * It used to be an arc about the centre at the kerbs' own radius, with a
 * bulge. The kerbs stand well back from the junction, at the crossings, so
 * that arc swung wide over the verge: 4.9 % of all pedestrian time on the
 * saved player map was spent on the grass beside a corner.
 */
function cornerPath(walkable: WalkableSurface, a: Vec2, b: Vec2, centre: Vec2): Vec2[] {
  const fromAngle = Math.atan2(a.y - centre.y, a.x - centre.x);
  const toAngle = Math.atan2(b.y - centre.y, b.x - centre.x);
  const sweep = ((toAngle - fromAngle) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2);
  const fromRadius = dist(a, centre);
  const toRadius = dist(b, centre);
  const reach = Math.max(fromRadius, toRadius) * 1.6 + 12;
  const count = Math.max(2, Math.ceil(sweep * reach / 0.75));
  const span = { lo: 0, hi: 0 };
  const points: Vec2[] = [a];
  let prev = fromRadius;
  for (let j = 1; j < count; j++) {
    const t = j / count;
    const angle = fromAngle + sweep * t;
    const dx = Math.cos(angle), dy = Math.sin(angle);
    // Where this ray would be if nothing were drawn: between the kerbs' radii.
    const guess = fromRadius + (toRadius - fromRadius) * t;
    let best = NaN;
    let bestCost = Infinity;
    for (let r = 0.25; r <= reach; r += 0.5) {
      const x = centre.x + dx * r, y = centre.y + dy * r;
      // Measured along the ray only a few units either way: a ray running
      // nearly parallel to a footway stays inside it for a long way, and the
      // middle of all of that is nowhere near the corner.
      if (!walkable.footwaySpan(x, y, dx, dy, 3, span)) continue;
      const mid = r + (span.lo + span.hi) / 2;
      const cost = Math.abs(mid - prev) + 0.25 * Math.abs(mid - guess);
      if (cost < bestCost) { bestCost = cost; best = mid; }
      r += Math.max(0, span.hi);
    }
    const radius = Number.isNaN(best) ? guess : best;
    prev = radius;
    points.push({ x: centre.x + dx * radius, y: centre.y + dy * radius });
  }
  points.push(b);
  // Then across the path: each point to the middle of the footway there.
  const laid = points.map((p, k) => {
    if (k === 0 || k === points.length - 1) return p;
    const before = points[Math.max(0, k - 2)]!, after = points[Math.min(points.length - 1, k + 2)]!;
    const tx = after.x - before.x, ty = after.y - before.y;
    const l = Math.hypot(tx, ty);
    if (l < 1e-9) return p;
    const nx = -ty / l, ny = tx / l;
    for (let step = 0; step <= 10; step++) {
      for (const side of step === 0 ? [0] : [1, -1]) {
        const o = side * step * 0.25;
        if (!walkable.footwaySpan(p.x + nx * o, p.y + ny * o, nx, ny, m(4), span)) continue;
        const mid = o + (span.lo + span.hi) / 2;
        return { x: p.x + nx * mid, y: p.y + ny * mid };
      }
    }
    return p;
  });
  points.splice(0, points.length, ...laid);
  // Two passes of a three-point average: the footway's own outline is a
  // polygon, and its middle steps at every vertex of it.
  for (let pass = 0; pass < 2; pass++) {
    const copy = points.map((p) => ({ ...p }));
    for (let k = 1; k < points.length - 1; k++) {
      points[k] = {
        x: (copy[k - 1]!.x + 2 * copy[k]!.x + copy[k + 1]!.x) / 4,
        y: (copy[k - 1]!.y + 2 * copy[k]!.y + copy[k + 1]!.y) / 4,
      };
    }
  }
  return dedupeClose(points);
}

function dedupeClose(points: readonly Vec2[]): Vec2[] {
  const out: Vec2[] = [];
  // The radial footway samples can briefly step backwards by a few
  // centimetres at a polygon seam. A tiny reversed segment flips the
  // corridor's normal, moving an offset walker across the path in one tick
  // and leaving them unable to advance through that apparent wall.
  const minStep = m(0.1);
  for (const p of points) if (!out.length || dist(out[out.length - 1]!, p) > minStep) out.push(p);
  // Keep the kerb endpoint even when it falls within the final sample's
  // spacing; every adjoining edge uses that exact graph node.
  const end = points[points.length - 1]!;
  if (out.length > 1 && dist(out[out.length - 1]!, end) > 1e-9) {
    if (dist(out[out.length - 1]!, end) <= minStep) out[out.length - 1] = end;
    else out.push(end);
  }
  // A short outward spike can survive spacing alone and make the tangent
  // reverse at the kerb. Remove its turning vertex before the corridor is
  // built; otherwise the normal flips and a lateral offset jumps across it.
  for (let i = 1; i < out.length - 1; i++) {
    const a = out[i - 1]!, b = out[i]!, c = out[i + 1]!;
    const ax = b.x - a.x, ay = b.y - a.y;
    const bx = c.x - b.x, by = c.y - b.y;
    const first = Math.hypot(ax, ay), second = Math.hypot(bx, by);
    if (Math.min(first, second) > m(0.5) || ax * bx + ay * by >= -0.5 * first * second) continue;
    out.splice(i, 1);
    i = Math.max(0, i - 2);
  }
  if (out.length === 1) out.push({ x: out[0]!.x + 0.1, y: out[0]!.y });
  return out;
}

export const kerbId = (node: NodeId, segment: SegmentId, side: Side): SidewalkNodeId =>
  `${node}:${segment}:${side}`;

function pushAdj(map: Map<string, string[]>, key: string, value: string): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}
