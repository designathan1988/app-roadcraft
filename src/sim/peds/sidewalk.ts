import { Polyline } from '@core/polyline';
import { pointInPolygon } from '@core/polygon';
import { type Vec2, addScaled, angleOf, dist, normalize, perp, sub } from '@core/vec2';
import type { NodeId, SegmentId } from '@world/ids';
import type { RoadDoc } from '@world/doc';
import type { Network } from '@world/network';
import { Level, roadProfile } from '@world/roadTypes';
import { CROSSWALK_DEPTH } from '@world/approach';
import { orientedPolyline } from '@world/geometry';
import type { LaneletGraph, LaneletId } from '@world/lanelets';
import { makeCrossingId, type CrossingId } from '../signals/plan';
import { COARSE_EPS } from '@core/scalar';

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
}

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

  build(doc: RoadDoc, net: Network, graph: LaneletGraph): void {
    this.nodes.clear();
    this.edges.clear();
    this.adjacency.clear();
    this.crossings.clear();
    this.goalNodes.length = 0;
    this.occupancy.reset();

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
        if (legs.length === 2 && i === 1) break;
        // Leg `a`'s left kerb joins leg `b`'s right kerb, matching the
        // counter-clockwise corner convention used by the junction builder.
        const from = this.nodes.get(kerbId(nodeId, a.segId, 1));
        const to = this.nodes.get(kerbId(nodeId, b.segId, -1));
        if (!from || !to || from.id === to.id) continue;
        const path = Polyline.fromPoints([from.at, to.at]);
        this.addEdge({
          id: `C:${from.id}|${to.id}`,
          kind: 'corner',
          from: from.id,
          to: to.id,
          path,
          length: path.length,
          // A corner chord cuts between two footways of possibly different
          // widths, so it gets the narrower of the two: the wider footway can
          // spare the room, the narrower one cannot.
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
        const path = Polyline.fromPoints([from.at, ...offsetPts, to.at]);
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

    // Destinations are drawn from this pool, so it has to be ordered by
    // something other than insertion: map order depends on which legs the
    // editor happened to build first, and a seeded run may not.
    this.goalNodes.push(...[...this.nodes.keys()].sort());
  }

  private addEdge(edge: SidewalkEdge): void {
    if (edge.length < COARSE_EPS) return;
    this.edges.set(edge.id, edge);
    pushAdj(this.adjacency, edge.from, edge.id);
    pushAdj(this.adjacency, edge.to, edge.id);
  }

  edgesAt(node: SidewalkNodeId): readonly SidewalkEdgeId[] {
    return this.adjacency.get(node) ?? [];
  }

  /** The far endpoint of `edge` when entered from `from`. */
  other(edge: SidewalkEdge, from: SidewalkNodeId): SidewalkNodeId {
    return edge.from === from ? edge.to : edge.from;
  }

  /** Path oriented so it starts at `from`. */
  orientedPath(edge: SidewalkEdge, from: SidewalkNodeId): Polyline {
    return edge.from === from ? edge.path : edge.path.reversed();
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

export const kerbId = (node: NodeId, segment: SegmentId, side: Side): SidewalkNodeId =>
  `${node}:${segment}:${side}`;

function pushAdj(map: Map<string, string[]>, key: string, value: string): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

export const nodeDistance = (a: SidewalkNode, b: SidewalkNode): number => dist(a.at, b.at);
