import { Polyline } from '@core/polyline';
import { offsetPolyline } from '@core/offset';
import { type Vec2, angleOf, normalize, sub } from '@core/vec2';
import { MIN_RIBBON, normalizeAngle } from '@core/scalar';
import type { NodeId, SegmentId } from './ids';
import { movementKey, type JunctionControl, type RoadDoc } from './doc';
import type { Network } from './network';
import { laneOffset, roadProfile, travelLanes } from './roadTypes';
import { orientedPolyline } from './geometry';
import { type ApproachGroup, computeApproachGroups } from './approachGroups';
import { TUNNELS_DRAWN } from './structures';
import { JunctionSurface, turnPath } from './turnPaths';

/**
 * How far along a leg to look when deciding which approaches share an axis.
 *
 * Far enough that a slight kink at the node does not split an axis, near
 * enough that a real curve is not straightened away.
 */
const GROUPING_LOOKAHEAD_FRACTION = 0.2;
const GROUPING_LOOKAHEAD_MAX = 12;

export type LaneletId = string;
export type ConnectorId = string;
export type TurnKind = 'through' | 'left' | 'right' | 'uturn';

/**
 * The atomic unit of vehicle space: a directed, single-lane centreline.
 *
 * There are two kinds and no motion code distinguishes them. A `link` is one
 * lane of one direction of one segment, already trimmed at the junction
 * boundary. A `connector` is one legal movement inside a junction.
 *
 * That single representational choice removes an entire class of defect. The
 * stop line is ALWAYS `s = link.length`, because the setback was consumed when
 * the geometry was trimmed — there is no `stopAt = max(0, L - setback)` left to
 * go negative. And "inside the junction" is not a special case in the physics;
 * it just means being on a connector. The V6 monolith's pin at `progress = 0`
 * (defect 2 / 1b of RELATORIO.md) has no representation here.
 */
export interface Lanelet {
  readonly id: LaneletId;
  readonly kind: 'link' | 'connector';
  readonly centre: Polyline;
  readonly length: number;
  /** Free-flow speed in world units per second. */
  readonly speedLimit: number;

  // link fields
  readonly segment?: SegmentId;
  readonly from?: NodeId;
  readonly to?: NodeId;
  readonly laneIndex?: number;
  /** True when the far end of this link is a junction with a stop line. */
  readonly controlled: boolean;

  // connector fields
  readonly node?: NodeId;
  readonly fromLane?: LaneletId;
  readonly toLane?: LaneletId;
  readonly turn?: TurnKind;
  readonly group?: number;
}

export interface Connector {
  readonly id: ConnectorId;
  readonly lanelet: LaneletId;
  readonly node: NodeId;
  readonly fromLane: LaneletId;
  readonly toLane: LaneletId;
  readonly inSegment: SegmentId;
  readonly outSegment: SegmentId;
  readonly turn: TurnKind;
  /**
   * True when this movement is the road the node is ON carried across it -
   * a road bending at a node of two legs, or bending through a junction that
   * has no straight-on movement (`carriedPair`). Its lanes pair one to one,
   * and it has priority where the node is unsignalised. `turn` still states
   * how far it bends, which is what speed and the indicator are read from.
   */
  readonly carried: boolean;
  readonly group: number;
  readonly length: number;
}

export interface JunctionTopology {
  readonly node: NodeId;
  readonly groups: readonly ApproachGroup[];
  readonly connectors: readonly ConnectorId[];
  /** Inbound link lanelets, in deterministic order. */
  readonly inbound: readonly LaneletId[];
  readonly signalised: boolean;
  /** Explicit policy copied from the authoring node when available. */
  readonly control?: JunctionControl;
}

export const laneletId = (
  segment: SegmentId,
  from: NodeId,
  to: NodeId,
  lane: number,
): LaneletId => `${segment}:${from}>${to}:${lane}`;

export const connectorId = (from: LaneletId, to: LaneletId): ConnectorId => `${from}->${to}`;

/**
 * Classifies a movement from its heading change.
 *
 * THIS WAS MIRRORED, and it is the whole of the "signals turn the wrong way"
 * defect. It claimed +Y ran down the map; it does not. The renderer maps world
 * `(x, y)` to three's `(x, h, -y)`, which puts +Y UP on screen - measured, not
 * assumed: projecting `(0, 100)` lands 105 pixels ABOVE the origin. So the
 * frame is right-handed on screen, a positive heading change is
 * counter-clockwise, and counter-clockwise is a LEFT turn.
 *
 * Every other file already agreed with that. `laneOffset` pushes traffic onto
 * `-perp` and calls it right-hand traffic; `render/signals.ts` puts the head
 * on `-perp` and calls it the right-hand kerb. Only this function read the
 * sign the other way, and because every rule downstream is keyed on the label
 * it produces, all of them applied to the opposite movement:
 *
 *   - `laneIsPlausible` made left turns leave from the kerb lane and right
 *     turns from the innermost lane, so both crossed their own approach's
 *     through lanes;
 *   - the right-on-red exemption in `sim/signals/permission.ts` was granted to
 *     the turn that crosses oncoming traffic. Measured over 1500 s of traffic:
 *     every one of the 11 entries on red was a real LEFT turn, 4 of them while
 *     the crossing street had green;
 *   - `CRITICAL_GAP` gave the left turn the shorter gap meant for the right,
 *     and `turnSpeedFactor` the wrong speed.
 */
export function classifyTurn(inDir: Vec2, outDir: Vec2): TurnKind {
  const delta = normalizeAngle(angleOf(outDir) - angleOf(inDir));
  const deg = (delta * 180) / Math.PI;
  if (Math.abs(deg) > 150) return 'uturn';
  if (deg > 30) return 'left';
  if (deg < -30) return 'right';
  return 'through';
}

/**
 * Builds every lanelet and connector of the network.
 *
 * Link geometry is the lane centreline trimmed by the SAME asphalt trim the
 * junction mouth uses — `Network.trims` is the single source, so a stop line
 * and a junction mouth can never disagree.
 */
export class LaneletGraph {
  readonly lanelets = new Map<LaneletId, Lanelet>();
  readonly connectors = new Map<ConnectorId, Connector>();
  readonly junctions = new Map<NodeId, JunctionTopology>();
  /** Outgoing connectors of each link lanelet. */
  readonly exits = new Map<LaneletId, ConnectorId[]>();
  /** Inbound link lanelets of each node. */
  readonly inbound = new Map<NodeId, LaneletId[]>();
  /** Link lanelets leaving each node. */
  readonly outbound = new Map<NodeId, LaneletId[]>();

  revision = -1;

  build(doc: RoadDoc, net: Network): void {
    this.lanelets.clear();
    this.connectors.clear();
    this.junctions.clear();
    this.exits.clear();
    this.inbound.clear();
    this.outbound.clear();

    this.buildLinks(doc, net);
    this.buildJunctions(doc, net);
    this.revision = net.revision;
  }

  private buildLinks(doc: RoadDoc, net: Network): void {
    const ids = [...doc.segments.keys()].sort((a, b) => a - b);

    for (const segId of ids) {
      const seg = doc.requireSegment(segId);
      // A tunnel with no geometry carries no traffic. Skipping the link
      // lanelets removes the segment from the routing graph outright — no
      // lanelets, no connectors, no junction groups — so a vehicle can never
      // pass silently through a bore that is not drawn. The segment itself
      // stays in the document, authored and saved normally.
      if (seg.structure === 'tunnel' && !TUNNELS_DRAWN) continue;
      const rt = roadProfile(seg.type, seg.lanes, seg.direction);

      for (const forward of [true, false]) {
        if (!allowsDirection(seg.direction, forward)) continue;
        const lpd = travelLanes(rt, seg.direction);
        const from = forward ? seg.a : seg.b;
        const to = forward ? seg.b : seg.a;

        // A link ends at the STOP LINE, not at the junction mouth, leaving room
        // for the crossing in between. Both distances come from the same trim.
        const startTrim = net.stopLineDistance(segId, from);
        const endTrim = net.stopLineDistance(segId, to);

        const full = orientedPolyline(doc, seg, from);
        const total = full.length;

        // Consume the accessor's answer, do not re-derive it.
        //
        // This used to clamp each end independently against `total * 0.45`,
        // which is a second stop-line formula competing with the first — the
        // exact shape of defect 1.5, and it silently undid the accessor's
        // guarantee that the stop line sits beyond the crossing. Measured on a
        // boulevard with 84-unit arms: the accessor said 38.67 and the lanelet
        // still ended at 37.80, putting the line 0.87 units inside the zebra.
        //
        // The trim solver already reserves `MIN_DRIVABLE_RESERVE` between the
        // two approach zones, so the two ends normally fit. When they do not,
        // scale them JOINTLY: that keeps their ratio, degrades both ends the
        // same way, and never lets one end reach past the other.
        const wanted = startTrim + endTrim;
        const room = Math.max(0, total - MIN_RIBBON);
        const k = wanted > room && wanted > 0 ? room / wanted : 1;
        const s0 = startTrim * k;
        const s1 = Math.max(s0 + MIN_RIBBON, total - endTrim * k);
        const centreTrimmed = full.sub(s0, Math.min(s1, total));
        const pts = centreTrimmed.toPoints();

        for (let lane = 0; lane < lpd; lane++) {
          // Lane 0 is innermost; negative `perp` offset is the right of travel.
          const laneCentre = Polyline.fromPoints(
            offsetPolyline(pts, laneOffset(rt, lane, seg.direction)),
          );
          const id = laneletId(segId, from, to, lane);
          this.lanelets.set(id, {
            id,
            kind: 'link',
            centre: laneCentre,
            length: laneCentre.length,
            speedLimit: rt.speedLimit,
            segment: segId,
            from,
            to,
            laneIndex: lane,
            controlled: doc.degree(to) >= 3,
          });
          push(this.inbound, to, id);
          push(this.outbound, from, id);
        }
      }
    }
  }

  private buildJunctions(doc: RoadDoc, net: Network): void {
    for (const [nodeId, node] of doc.nodes) {
      if (node.incident.length < 2) continue;
      // The surface a turn has to stay on, built once per node and only when
      // the node actually has a movement to shape.
      let surface: JunctionSurface | null | undefined;
      const surfaceOf = (): JunctionSurface | null => (surface ??= new JunctionSurface(net, nodeId));

      const inbound = (this.inbound.get(nodeId) ?? []).slice().sort();
      const outbound = (this.outbound.get(nodeId) ?? []).slice().sort();
      if (!inbound.length || !outbound.length) continue;

      // Only a leg that brings traffic INTO the node is an approach. A one-way
      // road leaving the junction used to get a signal group of its own: a head
      // facing an empty carriageway, and a whole stage of every cycle spent
      // showing green to nobody while every real approach waited at red.
      const approaching = new Set<SegmentId>();
      for (const id of inbound) {
        const segment = this.lanelets.get(id)?.segment;
        if (segment !== undefined) approaching.add(segment);
      }
      const legs = node.incident
        .slice()
        .filter((segId) => approaching.has(segId))
        .sort((a, b) => a - b)
        .map((segId) => {
          const seg = doc.requireSegment(segId);
          const pl = orientedPolyline(doc, seg, nodeId);
          return { segment: segId, dir: smoothedDirectionFromNode(pl) };
        });

      const groups = computeApproachGroups(legs);
      const groupBySegment = new Map<SegmentId, number>();
      for (const g of groups) for (const s of g.segments) groupBySegment.set(s, g.id);

      const connectorIds: ConnectorId[] = [];
      const road = carriedPair(doc, nodeId);

      const addConnector = (
        inId: LaneletId, inLane: Lanelet, outId: LaneletId, outLane: Lanelet, turn: TurnKind, carried = false,
      ): void => {
        const cid = connectorId(inId, outId);
        if (this.connectors.has(cid)) return;
        const waiting = inbound
          .map((id) => this.lanelets.get(id))
          .filter((l): l is Lanelet => !!l && l.id !== inId);
        const path = turnPath(inLane.centre, outLane.centre, surfaceOf(), waiting);
        const lanelet: Lanelet = {
          id: cid,
          kind: 'connector',
          centre: path,
          length: path.length,
          speedLimit: Math.min(inLane.speedLimit, outLane.speedLimit) * turnSpeedFactor(turn),
          controlled: false,
          node: nodeId,
          fromLane: inId,
          toLane: outId,
          turn,
          group: groupBySegment.get(inLane.segment as SegmentId) ?? 0,
        };
        this.lanelets.set(cid, lanelet);
        this.connectors.set(cid, {
          id: cid,
          lanelet: cid,
          node: nodeId,
          fromLane: inId,
          toLane: outId,
          inSegment: inLane.segment as SegmentId,
          outSegment: outLane.segment as SegmentId,
          turn,
          carried,
          group: lanelet.group ?? 0,
          length: path.length,
        });
        push(this.exits, inId, cid);
        connectorIds.push(cid);
      };

      for (const inId of inbound) {
        const inLane = this.lanelets.get(inId);
        if (!inLane || inLane.segment === undefined) continue;
        const inDir = endDirection(inLane.centre);
        const legal: { outId: LaneletId; outLane: Lanelet; turn: TurnKind; carried: boolean }[] = [];
        // U-turns the lane-count rule above set aside. They come back only for
        // a lane that has nothing else: where two roads both run back to the
        // same node (a lens of two curves), EVERY movement classifies as a
        // U-turn, and dropping them all left the lane with no exit at all - a
        // car driving into a node it can never leave (the fuzzer's
        // `deadLanelet`).
        const dropped: typeof legal = [];

        for (const outId of outbound) {
          const outLane = this.lanelets.get(outId);
          if (!outLane || outLane.segment === undefined) continue;

          // A movement back down the segment it came from is a U-turn; allow it
          // only where there is nowhere else to go.
          const isReverse = outLane.segment === inLane.segment;
          const outDir = tangentAtStart(outLane.centre);
          const turn = isReverse ? 'uturn' : classifyTurn(inDir, outDir);
          // The road the node is ON carries its lanes across, however it bends.
          const carried = !isReverse && road !== null &&
            road.includes(inLane.segment) && road.includes(outLane.segment);
          const inSegment = doc.requireSegment(inLane.segment);
          const inLanes = travelLanes(
            roadProfile(inSegment.type, inSegment.lanes, inSegment.direction),
            inSegment.direction,
          );
          const outSegment = doc.requireSegment(outLane.segment);
          const outLanes = travelLanes(
            roadProfile(outSegment.type, outSegment.lanes, outSegment.direction),
            outSegment.direction,
          );
          if (node.blockedMovements.includes(movementKey(inLane.segment, outLane.segment))) continue;
          if (turn === 'uturn' && outbound.length > inLanes) {
            dropped.push({ outId, outLane, turn, carried });
            continue;
          }
          legal.push({ outId, outLane, turn, carried });
          if (laneIsPlausible(inLane, outLane, carried ? 'through' : turn, inLanes, outLanes)) {
            addConnector(inId, inLane, outId, outLane, turn, carried);
          }
        }

        // A wide road may feed a narrower exit. Strict lane matching is useful
        // where alternatives exist, but it must never leave an outer lane with
        // no route at all: vehicles spawned there would reach a green signal
        // with no connector to request. Merge that lane onto the best legal
        // outbound path only when the normal pairing produced none.
        if (this.exitsOf(inId).length === 0 && !legal.length) legal.push(...dropped);
        if (this.exitsOf(inId).length === 0 && legal.length) {
          legal.sort((a, b) =>
            fallbackTurnRank(a.turn) - fallbackTurnRank(b.turn) ||
            (a.outLane.laneIndex ?? 0) - (b.outLane.laneIndex ?? 0) ||
            a.outId.localeCompare(b.outId),
          );
          const fallback = legal[0]!;
          // A lane that merges into the road it is on is still that road:
          // losing `carried` here made the dropped lane give way at a node of
          // three legs, and the lane beside it never had to let it in.
          addConnector(inId, inLane, fallback.outId, fallback.outLane, fallback.turn, fallback.carried);
        }
      }

      this.junctions.set(nodeId, {
        node: nodeId,
        groups,
        connectors: connectorIds,
        inbound,
        // Signalise anything with three or more legs that carries real traffic.
        signalised: shouldSignalise(node.control, node.incident, doc),
        control: node.control,
      });
    }
  }

  exitsOf(lane: LaneletId): readonly ConnectorId[] {
    return this.exits.get(lane) ?? [];
  }

  lanelet(id: LaneletId): Lanelet | undefined {
    return this.lanelets.get(id);
  }

  /**
   * The other lanes of the same carriageway, adjacent ones first.
   *
   * Lane discipline makes each turn legal from exactly one lane, so both route
   * planning and lane changing have to be able to see across the carriageway.
   * Lane indices are contiguous from 0, so walking outward from this one and
   * stopping at the first gap enumerates the direction without needing to know
   * its width here.
   */
  siblingLanes(id: LaneletId): LaneletId[] {
    const lane = this.lanelets.get(id);
    if (
      !lane ||
      lane.kind !== 'link' ||
      lane.segment === undefined ||
      lane.from === undefined ||
      lane.to === undefined
    ) return [];

    const here = lane.laneIndex ?? 0;
    const out: LaneletId[] = [];
    for (const step of [-1, 1]) {
      for (let k = here + step; k >= 0; k += step) {
        const sibling = laneletId(lane.segment, lane.from, lane.to, k);
        if (!this.lanelets.has(sibling)) break;
        out.push(sibling);
      }
    }
    return out;
  }
}

function allowsDirection(direction: 'both' | 'aToB' | 'bToA', forward: boolean): boolean {
  return direction === 'both' || (direction === 'aToB') === forward;
}

function shouldSignalise(
  control: JunctionControl,
  incident: readonly SegmentId[],
  doc: RoadDoc,
): boolean {
  if (control === 'signal') return true;
  if (control !== 'auto') return false;
  return incident.length >= 3 &&
    (incident.length >= 4 || incident.some((s) => {
      const segment = doc.requireSegment(s);
      return roadProfile(segment.type, segment.lanes, segment.direction).lanes >= 4;
    }));
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

const turnSpeedFactor = (turn: TurnKind): number =>
  turn === 'through' ? 1 : turn === 'right' ? 0.6 : turn === 'left' ? 0.65 : 0.45;

function endDirection(pl: Polyline): Vec2 {
  if (pl.n < 2) return { x: 1, y: 0 };
  return pl.sampleAt(pl.length).t;
}

/**
 * The immediate tangent where a lane leaves its node.
 *
 * Deliberately unsmoothed. Turn classification asks what a driver does at
 * the junction, so a curve further along the block must not rotate the
 * answer — a left turn onto a road that bends right is still a left turn.
 */
function tangentAtStart(pl: Polyline): Vec2 {
  if (pl.n < 2) return { x: 1, y: 0 };
  return pl.sampleAt(0).t;
}

/** A pair of legs clearly straighter than every other pair by at least this much. */
const CARRIED_MARGIN = (15 * Math.PI) / 180;
/** A pair bending more than this is a corner between two roads, not one road. */
const CARRIED_MAX_BEND = (100 * Math.PI) / 180;
/** Below this bend a movement is already classified as straight on. */
const STRAIGHT_BEND = (30 * Math.PI) / 180;

/**
 * The two legs that are ONE ROAD carried across a node, when that road bends.
 *
 * `classifyTurn` calls anything bending more than 30 degrees a turn. For a
 * movement from one road into another that is right; for a road that simply
 * bends at a node it is only half right - it states how sharp the bend is,
 * which speed and the indicator should read - and two things keyed on the
 * label went wrong with it:
 *
 *   - lane pairing. A turn leaves from the lane on its own side and arrives in
 *     the lane on its own side, so a two-lane carriageway bending 45 degrees at
 *     a node was paired lane 0 to lane 0 only, and lane 1 was merged into lane
 *     0 by the no-route fallback: every such bend a lane drop. On a ring of
 *     streets - a roundabout drawn as a polygon, bending at every node - the
 *     circulating carriageway became a single lane with a merge at every node,
 *     and it locked solid: not one vehicle left it in five minutes;
 *   - right of way. `continues` in `sim/intersections/admission.ts` makes the
 *     road the node is on the priority road; with no straight-on movement
 *     nothing was, and every approach gave way to every other;
 *
 * A node of two legs is one road, whatever the angle. At a node of three or
 * more with no straight-on pair at all, the road is the pair that goes on most
 * nearly straight among the pairs of the highest class - and only when one
 * pair clearly does, so a symmetric Y keeps its three turns.
 */
function carriedPair(doc: RoadDoc, nodeId: NodeId): readonly SegmentId[] | null {
  const node = doc.node(nodeId);
  if (!node) return null;
  const incident = [...new Set(node.incident)];
  if (incident.length === 2) return incident;
  if (incident.length < 3) return null;
  const legs = incident.map((segment) => {
    const seg = doc.requireSegment(segment);
    return { segment, type: seg.type, dir: smoothedDirectionFromNode(orientedPolyline(doc, seg, nodeId)) };
  });
  const pairs: { members: SegmentId[]; rank: number; bend: number }[] = [];
  for (let i = 0; i < legs.length; i++) {
    for (let j = i + 1; j < legs.length; j++) {
      const a = legs[i]!;
      const b = legs[j]!;
      // Both directions point away from the node: a straight road has them
      // opposed, so the bend is what is left of a half turn.
      const between = Math.abs(normalizeAngle(angleOf(b.dir) - angleOf(a.dir)));
      const bend = Math.PI - between;
      if (bend < STRAIGHT_BEND) return null;
      pairs.push({ members: [a.segment, b.segment], rank: Math.min(a.type, b.type), bend });
    }
  }
  pairs.sort((a, b) => b.rank - a.rank || a.bend - b.bend);
  const best = pairs[0];
  if (!best || best.bend > CARRIED_MAX_BEND) return null;
  const rival = pairs.find((p) => p !== best && p.rank === best.rank);
  if (rival && rival.bend - best.bend < CARRIED_MARGIN) return null;
  return best.members;
}

/**
 * The direction of a leg once a kink at the node is smoothed away.
 *
 * Approach grouping asks a different question from turn classification:
 * which arms of a junction form one axis and can share a signal stage. A
 * slight bend right at the node must not split an otherwise straight axis,
 * so this looks ahead before deciding.
 *
 * The two therefore DISAGREE on a curved leg, and that is correct. They were
 * previously both spelled  — one local, one an unused export
 * in  — which made the disagreement look like a bug and
 * invited someone to "fix" it by unifying them.
 */
function smoothedDirectionFromNode(pl: Polyline): Vec2 {
  const look = Math.min(GROUPING_LOOKAHEAD_MAX, Math.max(1, pl.length * GROUPING_LOOKAHEAD_FRACTION));
  return normalize(sub(pl.sampleAt(look).p, pl.point(0)));
}

/**
 * Rejects lane pairings that no driver would make, so the connector set stays
 * small and turns start and finish in sensible lanes. Lane 0 is innermost.
 */
/**
 * Whether a movement from this lane to that one is one a driver would make.
 *
 * `laneIndex` 0 is the INNERMOST lane; higher indices sit progressively further
 * to the right of travel. So the innermost lane turns left and the outermost
 * lane turns right.
 *
 * THE RULE THAT MATTERS: connections leaving one approach are ORDER PRESERVING
 * and INJECTIVE — lane `i` goes to lane `i`, and no two of them ever land on
 * the same receiving lane. Two paths that keep their lane order are concentric;
 * they never cross. Two that converge do, and `ConflictIndex` then generates a
 * perfectly correct crossing point between two movements that a real layout
 * draws as parallel.
 *
 * That is not a hypothetical. The previous rule was
 *
 *   if (turn === 'right') return i === 0 || o === i;   // lane 0 -> ANY lane
 *   return o === i || Math.abs(o - i) === 1;           // through may drift one
 *
 * so `right(lane 0)` reached every receiving lane and `through` could drift
 * sideways. Measured on a 4x4 grid of four-lane avenues, 89.1 % of the conflicts
 * that stopped a vehicle at its own green light named a holder on the SAME
 * approach that was ALSO green — 56.8 % of them a second right turn, and even
 * `through(0)` against `through(1)`, which cannot cross under any geometry.
 *
 * Unequal lane counts are handled by the merge fallback in `build`, not here:
 * an inbound lane that this rule leaves with no exit at all is given one, and
 * that merge is deliberate and singular rather than an accident of pairing.
 *
 * LANE DISCIPLINE (CTB art. 38). A driver about to turn must already be in the
 * lane the turn leaves from, and must land in the corresponding lane of the
 * receiving road — never cross the carriageway to reach the turn. So a right
 * turn leaves the OUTERMOST lane and enters the outermost receiving lane, and a
 * left turn leaves the innermost and enters the innermost.
 *
 * That makes a turn reachable only from one lane, which is exactly why
 * `src/sim/vehicles/laneChange.ts` exists: a vehicle that wants a turn its
 * current lane cannot serve moves across to the lane that can, in advance, with
 * a gap. Before lane changing existed this rule was unshippable, because a left
 * turn lands a vehicle in the innermost lane and a following right turn was
 * then unreachable for the rest of its life.
 */
function laneIsPlausible(
  inLane: Lanelet,
  outLane: Lanelet,
  turn: TurnKind,
  inLanes: number,
  outLanes: number,
): boolean {
  const i = inLane.laneIndex ?? 0;
  const o = outLane.laneIndex ?? 0;
  if (turn === 'left' || turn === 'uturn') return i === 0 && o === 0;
  if (turn === 'right') return i === inLanes - 1 && o === outLanes - 1;
  return o === i;
}

/** Prefer a forward continuation when a necessary lane merge has no exact match. */
function fallbackTurnRank(turn: TurnKind): number {
  if (turn === 'through') return 0;
  if (turn === 'right') return 1;
  if (turn === 'left') return 2;
  return 3;
}

