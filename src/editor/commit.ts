import {
  controlPoint,
  flattenSegment,
  shapeFromControl,
  splitQuad,
  type CurveShape,
} from '@core/bezier';
import { segSeg } from '@core/intersect';
import { Polyline } from '@core/polyline';
import { type Vec2, dist } from '@core/vec2';
import { type RoadDoc, fitRoadCurve } from '@world/doc';
import { Network } from '@world/network';
import type { NodeId, SegmentId } from '@world/ids';
import { MIN_LINK_LENGTH } from '@world/approach';
import { MAX_AUTHORED_GRADE } from '@world/elevation';
import { sameRoadSection } from '@world/roadSection';
import { ROAD_TYPES } from '@world/roadTypes';
import { roadStructure, type RoadStructure } from '@world/structures';
import type { Anchor } from './snap';
import type { RoadPathPiece } from './roadPath';
import { COARSE_EPS, EPS } from '@core/scalar';

/** Shortest road the editor will create. */
const MIN_DRAFT_LENGTH = 24;
/** Two nodes closer than this are the same node. */
const MERGE_EPS = 2.6;
/** Distinct decks at the same map point remain separate networks. */
const HEIGHT_JOIN_EPS = 0.75;
/** Vertical room required before two crossing carriageways can pass independently. */
const CROSSING_CLEARANCE = roadStructure('elevated').clearance;

export interface DraftResult {
  readonly committed: boolean;
  readonly reason?: 'tooShort' | 'duplicate' | 'degenerate' | 'tooSharp' | 'clearance';
  readonly heightLimited?: boolean;
  readonly finalHeightOffset?: number;
}

/**
 * Commits one freehand gesture as one undoable, atomic road. The gesture may
 * contain many tangent-continuous quadratics and vertical control points.
 */
export function commitRoadPath(
  doc: RoadDoc,
  net: Network,
  start: Anchor,
  end: Anchor,
  type: number,
  pieces: readonly RoadPathPiece[],
  /** Lanes for every segment laid, or null for the class's own profile. */
  lanes: number | null = null,
): DraftResult {
  if (!pieces.length || !Number.isInteger(type) || type < 0 || type >= ROAD_TYPES.length) {
    return { committed: false, reason: 'degenerate' };
  }
  pieces = joinShortPieces(pieces);
  const work = doc.clone();
  const workNet = new Network(work);
  workNet.rebuild();
  let committed = false;
  let heightLimited = false;
  let currentHeight = pieces[0]?.start.heightOffset ?? 0;
  for (let i = 0; i < pieces.length; i++) {
    const piece = pieces[i] as RoadPathPiece;
    if (!validPoint(piece.start.at) || !validPoint(piece.end.at) ||
      !Number.isFinite(piece.start.heightOffset) || !Number.isFinite(piece.end.heightOffset)) {
      return { committed: false, reason: 'degenerate' };
    }
    const from: Anchor = i === 0 ? start : { kind: 'free', at: piece.start.at };
    const to: Anchor = i === pieces.length - 1 ? end : { kind: 'free', at: piece.end.at };
    const shape = fitRoadCurve(piece.start.at, piece.end.at, piece.curve, type);
    const length = Polyline.fromPoints(flattenSegment(piece.start.at, piece.end.at, shape)).length;
    const rise = length * MAX_AUTHORED_GRADE;
    const nextHeight = Math.max(currentHeight - rise,
      Math.min(currentHeight + rise, piece.end.heightOffset));
    const limited = Math.abs(nextHeight - piece.end.heightOffset) > 1e-6;
    heightLimited ||= limited;
    if (i === pieces.length - 1 && end.kind !== 'free' && limited) {
      return { committed: false, reason: 'tooShort' };
    }
    const result = commitDraftInPlace(
      work, workNet, from, to, type, shape, 'ground',
      { start: currentHeight, end: nextHeight,
        smoothEnd: i < pieces.length - 1 },
      lanes,
    );
    if (!result.committed && result.reason !== 'duplicate') return result;
    committed ||= result.committed;
    currentHeight = nextHeight;
    workNet.rebuild();
  }
  if (!committed) return { committed: false, reason: 'duplicate' };
  doc.replaceWith(work);
  net.adopt(workNet);
  return { committed: true, heightLimited, finalHeightOffset: currentHeight };
}

/**
 * A piece too short to be a road is folded into the next one (the last into
 * the one before): left alone it was refused, and the pieces either side of
 * it ended a few metres apart - a road with a gap in it.
 */
function joinShortPieces(pieces: readonly RoadPathPiece[]): readonly RoadPathPiece[] {
  const out: RoadPathPiece[] = [];
  let carry: RoadPathPiece['start'] | null = null;
  for (const piece of pieces) {
    const start: RoadPathPiece['start'] = carry ?? piece.start;
    if (dist(start.at, piece.end.at) < MIN_LINK_LENGTH * 0.25) {
      carry = start;
      continue;
    }
    out.push(carry ? { start, end: piece.end, curve: null } : piece);
    carry = null;
  }
  if (carry) {
    const last = out.pop();
    const tail = pieces[pieces.length - 1]!;
    out.push(last ? { start: last.start, end: tail.end, curve: null } : { start: carry, end: tail.end, curve: null });
  }
  return out;
}

interface DraftStop {
  readonly node: NodeId;
  /** Quadratic parameter on the drafted road. */
  readonly q: number;
  /** Flattened arc length on the drafted road, for dash continuity. */
  readonly s: number;
}

interface ExistingCut {
  readonly at: Vec2;
  readonly s: number;
  readonly draftQ: number;
  readonly draftS: number;
}

interface TaggedCut<Tag> {
  readonly at: Vec2;
  readonly s: number;
  readonly tag: Tag;
}

/**
 * Commits a drafted road atomically, splitting anything it crosses.
 *
 * All topology work happens on a private document clone. A failed duplicate,
 * degenerate anchor or split therefore leaves the live map byte-for-byte
 * unchanged. The optional shape is the quadratic captured by curve mode.
 */
export function commitDraft(
  doc: RoadDoc,
  net: Network,
  start: Anchor,
  end: Anchor,
  type: number,
  curve: CurveShape | null = null,
  structure: RoadStructure = 'ground',
): DraftResult {
  if (dist(start.at, end.at) < MIN_DRAFT_LENGTH) {
    return { committed: false, reason: 'tooShort' };
  }
  if (
    !Number.isInteger(type) ||
    type < 0 ||
    type >= ROAD_TYPES.length ||
    !validPoint(start.at) ||
    !validPoint(end.at)
  ) {
    return { committed: false, reason: 'degenerate' };
  }
  if (curve && (!Number.isFinite(curve.t) || !Number.isFinite(curve.h))) {
    return { committed: false, reason: 'degenerate' };
  }

  // Flattened as a whole BEFORE it is cut at crossings, so the pieces stay
  // one smooth curve instead of each being fitted on its own.
  const shape = fitRoadCurve(start.at, end.at, curve, type);

  const work = doc.clone();
  const workNet = new Network(work);
  workNet.rebuild();
  const result = commitDraftInPlace(work, workNet, start, end, type, shape, structure);
  if (!result.committed) return result;

  doc.replaceWith(work);
  // `workNet` was last built BEFORE the draft's segments were added
  // (`commitDraftInPlace` rebuilds after materialising the endpoints, then only
  // adds segments). Adopting it as it stood handed back a network stamped with
  // the new revision but without the new road - no ribbon, no trim, no
  // junction - which only the caller's own later rebuild hid. The fuzzer's
  // `staleNetwork` check found it on every draw. Rebuilt once here, after the
  // draft has been accepted, and then adopted.
  workNet.rebuild();
  net.adopt(workNet);
  return result;
}

function commitDraftInPlace(
  doc: RoadDoc,
  net: Network,
  start: Anchor,
  end: Anchor,
  type: number,
  curve: CurveShape | null,
  structure: RoadStructure,
  heights?: { readonly start: number; readonly end: number; readonly smoothEnd?: boolean },
  lanes: number | null = null,
): DraftResult {
  const endpoints = materializeEndpoints(doc, net, start, end, heights);
  if (!endpoints || endpoints[0] === endpoints[1]) {
    return { committed: false, reason: 'degenerate' };
  }
  const [startNode, endNode] = endpoints;

  // Splitting an endpoint changes existing segment ids. Free or node anchors
  // only add nodes, so the cached polylines remain current and a full rebuild
  // per quadratic would make a long freehand gesture needlessly expensive.
  if (start.kind === 'segment' || end.kind === 'segment') net.rebuild();

  const a = start.at;
  const b = end.at;
  const draft = Polyline.fromPoints(flattenSegment(a, b, curve));
  const splitBySegment = new Map<SegmentId, ExistingCut[]>();
  const draftCuts: DraftStop[] = [];

  for (const [id, seg] of [...doc.segments]) {
    if (!heights && seg.structure !== structure) continue;
    const existing = net.polylines.get(doc, id);

    for (let di = 0; di + 1 < draft.n; di++) {
      const d0 = draft.point(di);
      const d1 = draft.point(di + 1);
      const draftPiece = (draft.cum[di + 1] as number) - (draft.cum[di] as number);

      for (let ei = 0; ei + 1 < existing.n; ei++) {
        const e0 = existing.point(ei);
        const e1 = existing.point(ei + 1);
        const hit = segSeg(d0, d1, e0, e1);
        if (!hit) continue;

        const existingPiece =
          (existing.cum[ei + 1] as number) - (existing.cum[ei] as number);
        const draftS = (draft.cum[di] as number) + hit.t * draftPiece;
        const existingS = (existing.cum[ei] as number) + hit.u * existingPiece;

        if (heights) {
          const drafted = heights.start +
            (heights.end - heights.start) * (draftS / Math.max(1e-6, draft.length));
          const gap = Math.abs(drafted - segmentOffsetAt(doc, seg, existingS, existing.length));
          if (gap > CROSSING_CLEARANCE) continue;
          // Too far apart in height to meet, too close to pass over: refused,
          // as moving a node already is. It was joined, and the junction had
          // a step in it - or, drawn between the two, a deck a few metres
          // over the other road with no room under it.
          if (gap > HEIGHT_JOIN_EPS) return { committed: false, reason: 'clearance' };
        }

        // The start and end anchors already materialize these contacts.
        if (draftS <= MERGE_EPS || draftS >= draft.length - MERGE_EPS) continue;

        const draftQ = (di + hit.t) / Math.max(1, draft.n - 1);

        // A crossing NEAR an existing endpoint reuses that junction node.
        //
        // The threshold used to be `MERGE_EPS`, 2.6 units, which only caught a
        // second node landing a fraction of a unit beside the first. That left
        // every cut between 2.6 and `MIN_LINK_LENGTH` free to create a stub too
        // short to be a road: at 36 units a link is already the bare minimum for
        // two approaches and a drivable middle, and both junctions on a shorter
        // one are squeezed until their geometry degenerates. Measured on a map
        // where this happened: a 10.51-unit segment between two junctions each
        // asking for about 25 units of setback, drawn as pale slivers fanning
        // across the asphalt.
        //
        // Moving the contact up to a road's length onto the existing node is
        // visible, and it is the right trade: the alternative is a junction
        // that cannot be built. This is what every city builder does with a
        // near-miss connection, and for this reason.
        if (existingS <= MIN_LINK_LENGTH) {
          draftCuts.push({ node: seg.a, q: draftQ, s: draftS });
          continue;
        }
        if (existingS >= existing.length - MIN_LINK_LENGTH) {
          draftCuts.push({ node: seg.b, q: draftQ, s: draftS });
          continue;
        }

        const cuts = splitBySegment.get(id) ?? [];
        const duplicate = cuts.some(
          (cut) =>
            Math.abs(cut.s - existingS) <= MERGE_EPS &&
            Math.abs(cut.draftS - draftS) <= MERGE_EPS,
        );
        if (!duplicate) {
          cuts.push({ at: hit.point, s: existingS, draftQ, draftS });
          splitBySegment.set(id, cuts);
        }
      }
    }
  }

  // One existing segment can be crossed more than once. Reconstruct it in a
  // single pass so every cut is expressed in the original arc coordinate.
  for (const [id, cuts] of splitBySegment) {
    const tagged = cuts.map((cut) => ({ at: cut.at, s: cut.s, tag: cut }));
    const nodes = splitSegmentAtCuts(doc, net, id, tagged);
    for (const cut of cuts) {
      const node = nodes.get(cut);
      if (node !== undefined) {
        draftCuts.push({ node, q: cut.draftQ, s: cut.draftS });
      }
    }
  }

  const ordered = normalizeDraftStops([
    { node: startNode, q: 0, s: 0 },
    ...draftCuts,
    { node: endNode, q: 1, s: draft.length },
  ]);

  let made = 0;
  for (let i = 1; i < ordered.length; i++) {
    const from = ordered[i - 1] as DraftStop;
    const to = ordered[i] as DraftStop;
    if (from.node === to.node) continue;

    const fromNode = doc.node(from.node);
    const toNode = doc.node(to.node);
    if (!fromNode || !toNode) continue;
    const fromPoint = { x: fromNode.x, y: fromNode.y };
    const toPoint = { x: toNode.x, y: toNode.y };
    if (dist(fromPoint, toPoint) < MIN_LINK_LENGTH * 0.25) continue;

    const pieceCurve = curveShapeForRange(a, b, curve, fromPoint, toPoint, from.q, to.q);
    if (alreadyJoined(doc, from.node, to.node, pieceCurve, structure)) continue;
    const direction = ROAD_TYPES[type]?.lanes === 1 ? 'aToB' : 'both';
    if (doc.addSegment(from.node, to.node, type, pieceCurve, from.s, direction, lanes, structure)) made++;
  }

  if (!made) return { committed: false, reason: 'duplicate' };
  doc.pruneOrphanNodes();
  return { committed: true };
}

function normalizeDraftStops(stops: readonly DraftStop[]): DraftStop[] {
  const sorted = [...stops].sort((left, right) => left.q - right.q || left.s - right.s);
  const out: DraftStop[] = [];
  for (const stop of sorted) {
    const previous = out[out.length - 1];
    if (previous?.node === stop.node) continue;
    // Flattened curve vertices can report the same crossing from both adjacent
    // pieces. Prefer the first materialized node for a zero-length interval.
    if (previous && Math.abs(previous.s - stop.s) < COARSE_EPS) continue;
    out.push(stop);
  }
  return out;
}

function alreadyJoined(
  doc: RoadDoc,
  a: NodeId,
  b: NodeId,
  candidate: CurveShape | null,
  structure: RoadStructure = 'ground',
): boolean {
  const node = doc.node(a);
  if (!node) return false;
  return node.incident.some((id) => {
    const seg = doc.segment(id);
    if (!seg || seg.structure !== structure || (seg.a !== b && seg.b !== b)) return false;

    const existing = seg.curve;
    if (!existing || Math.abs(existing.h) < COARSE_EPS) {
      return !candidate || Math.abs(candidate.h) < COARSE_EPS;
    }
    if (!candidate || Math.abs(candidate.h) < COARSE_EPS) return false;

    // Compare both shapes in the a->b orientation. Reversing a quadratic
    // changes t to 1-t and flips the signed normal offset.
    const storedForward = seg.a === a;
    const t = storedForward ? existing.t : 1 - existing.t;
    const h = storedForward ? existing.h : -existing.h;
    return Math.abs(t - candidate.t) < COARSE_EPS && Math.abs(h - candidate.h) < COARSE_EPS;
  });
}

/** Materializes both anchors together so two cuts on one segment stay valid. */
function materializeEndpoints(
  doc: RoadDoc,
  net: Network,
  start: Anchor,
  end: Anchor,
  heights?: { readonly start: number; readonly end: number; readonly smoothEnd?: boolean },
): [NodeId, NodeId] | null {
  type Tag = 'start' | 'end';
  const resolved = new Map<Tag, NodeId>();
  const bySegment = new Map<SegmentId, TaggedCut<Tag>[]>();

  const queue = (tag: Tag, anchor: Anchor): boolean => {
    if (anchor.kind === 'node') {
      if (anchor.node === undefined || !doc.node(anchor.node)) return false;
      resolved.set(tag, anchor.node);
      return true;
    }

    if (anchor.kind === 'segment') {
      if (
        anchor.segment === undefined ||
        anchor.s === undefined ||
        !Number.isFinite(anchor.s) ||
        !doc.segment(anchor.segment)
      ) {
        return false;
      }
      const cuts = bySegment.get(anchor.segment) ?? [];
      cuts.push({ at: anchor.at, s: anchor.s, tag });
      bySegment.set(anchor.segment, cuts);
      return true;
    }

    resolved.set(tag, materializeFree(doc, anchor.at, heights?.[tag] ?? 0,
      tag === 'end' && heights?.smoothEnd === true));
    return true;
  };

  if (!queue('start', start) || !queue('end', end)) return null;
  for (const [id, cuts] of bySegment) {
    const nodes = splitSegmentAtCuts(doc, net, id, cuts);
    for (const cut of cuts) {
      const node = nodes.get(cut.tag);
      if (node !== undefined) resolved.set(cut.tag, node);
    }
  }

  const a = resolved.get('start');
  const b = resolved.get('end');
  return a === undefined || b === undefined ? null : [a, b];
}

/**
 * The node a free anchor lands on.
 *
 * A pre-existing node within `MERGE_EPS` is reused whatever structure its roads
 * are: a road has to be able to meet a road of another level, and skipping such
 * a node is what left elevated roads as islands joined to nothing. The height
 * difference at the meeting point is the deck's problem, not the document's —
 * the raised span ramps down to the adjoining surface.
 */
function materializeFree(doc: RoadDoc, at: Vec2, heightOffset = 0, smooth = false): NodeId {
  for (const node of doc.nodes.values()) {
    if (dist({ x: node.x, y: node.y }, at) < MERGE_EPS &&
      Math.abs((node.heightOffset ?? 0) - heightOffset) <= HEIGHT_JOIN_EPS) return node.id;
  }
  return doc.addNode(at, heightOffset, smooth).id;
}

function segmentOffsetAt(doc: RoadDoc, segment: NonNullable<ReturnType<RoadDoc['segment']>>, s: number, length: number): number {
  const t = Math.max(0, Math.min(1, s / Math.max(1e-6, length)));
  const a = doc.node(segment.a)?.heightOffset ?? 0;
  const b = doc.node(segment.b)?.heightOffset ?? 0;
  return a + (b - a) * t + roadStructure(segment.structure).clearance;
}

/** Splits a segment at an arc position, returning the new or endpoint node. */
export function splitSegment(
  doc: RoadDoc,
  net: Network,
  id: SegmentId,
  s: number,
  at: Vec2,
): NodeId | null {
  const tag = Symbol('split');
  return splitSegmentAtCuts(doc, net, id, [{ at, s, tag }]).get(tag) ?? null;
}

/**
 * Makes the topology agree with a node the Move tool has just dropped.
 *
 * Drawing a road reconciles it with the network - crossings become junctions,
 * a near endpoint is reused, a stub too short to be a road is refused. A node
 * drop did none of it: it could land on its neighbour (a zero-length road), on
 * another node (two junctions at one point), or carry a road across another
 * with no junction, where no conflict zone exists and cars drive through each
 * other. Here, in order:
 *  - dropped on another node at its level: the two become one;
 *  - an incident road now shorter than a quarter of `MIN_LINK_LENGTH`: refused;
 *  - an incident road now crossing another road at its level: both are split
 *    there and joined by one node. A crossing between the join tolerance and
 *    a deck's clearance can be neither, and is refused.
 * Returns `committed: false` with a reason when the drop must be undone.
 */
export function reconcileMovedNode(doc: RoadDoc, net: Network, id: NodeId, depth = 0): DraftResult {
  if (depth > 16) return { committed: true };
  const node = doc.node(id);
  if (!node) return { committed: false, reason: 'degenerate' };

  for (const other of doc.nodes.values()) {
    if (other.id === id) continue;
    if (dist(node, other) > MERGE_EPS || Math.abs(other.heightOffset - node.heightOffset) > HEIGHT_JOIN_EPS) continue;
    // Merging along a road would fold that road to nothing.
    if (node.incident.some((sid) => { const seg = doc.segment(sid); return seg && (seg.a === other.id || seg.b === other.id); })) {
      return { committed: false, reason: 'tooShort' };
    }
    doc.mergeNodes(other.id, id);
    return { committed: true };
  }

  for (const sid of node.incident) {
    const seg = doc.segment(sid);
    const far = seg && doc.node(seg.a === id ? seg.b : seg.a);
    if (far && dist(node, far) < MIN_LINK_LENGTH * 0.25) return { committed: false, reason: 'tooShort' };
  }

  net.rebuild();
  for (const sid of [...node.incident]) {
    const moved = doc.segment(sid);
    if (!moved) continue;
    const path = net.polylines.get(doc, sid);
    for (const [otherId, other] of [...doc.segments]) {
      if (otherId === sid || other.structure !== moved.structure) continue;
      if (other.a === moved.a || other.a === moved.b || other.b === moved.a || other.b === moved.b) continue;
      const line = net.polylines.get(doc, otherId);
      for (let i = 0; i + 1 < path.n; i++) {
        let crossed = false;
        for (let j = 0; j + 1 < line.n; j++) {
          const hit = segSeg(path.point(i), path.point(i + 1), line.point(j), line.point(j + 1));
          if (!hit) continue;
          const sMoved = (path.cum[i] as number) + hit.t * ((path.cum[i + 1] as number) - (path.cum[i] as number));
          const sOther = (line.cum[j] as number) + hit.u * ((line.cum[j + 1] as number) - (line.cum[j] as number));
          if (sMoved <= MERGE_EPS || sMoved >= path.length - MERGE_EPS) continue;
          const gap = Math.abs(segmentOffsetAt(doc, moved, sMoved, path.length) - segmentOffsetAt(doc, other, sOther, line.length));
          if (gap > CROSSING_CLEARANCE) continue;
          if (gap > HEIGHT_JOIN_EPS) return { committed: false, reason: 'clearance' };
          // Near the other road's end, its junction is reused, as a drawn road does.
          const onOther = sOther <= MIN_LINK_LENGTH ? other.a
            : sOther >= line.length - MIN_LINK_LENGTH ? other.b
              : splitSegmentAtCuts(doc, net, otherId, [{ at: hit.point, s: sOther, tag: 'x' }]).get('x');
          const onMoved = splitSegmentAtCuts(doc, net, sid, [{ at: hit.point, s: sMoved, tag: 'x' }]).get('x');
          if (onOther !== undefined && onMoved !== undefined) doc.mergeNodes(onOther, onMoved);
          net.rebuild();
          crossed = true;
          break;
        }
        if (crossed) {
          // The moved road is now two pieces; what is left of it is handled
          // by a fresh pass rather than on stale arc lengths.
          return reconcileMovedNode(doc, net, id, depth + 1);
        }
      }
    }
  }
  return { committed: true };
}

/** Joins two compatible straight segments meeting at an otherwise unused node. */
export function joinSegments(doc: RoadDoc, nodeId: NodeId): boolean {
  const node = doc.node(nodeId);
  if (!node || node.incident.length !== 2) return false;
  const [firstId, secondId] = node.incident;
  if (firstId === undefined || secondId === undefined) return false;
  const first = doc.segment(firstId);
  const second = doc.segment(secondId);
  if (!first || !second || first.curve || second.curve || first.type !== second.type || first.lanes !== second.lanes ||
    !sameRoadSection(first.section, second.section) || first.direction !== 'both' || second.direction !== 'both') return false;
  const a = first.a === nodeId ? first.b : first.a;
  const b = second.a === nodeId ? second.b : second.a;
  if (a === b || first.structure !== second.structure || alreadyJoined(doc, a, b, null, first.structure)) return false;
  const dashOrigin = Math.min(first.dashOrigin, second.dashOrigin);
  const bansAtA = [...(doc.node(a)?.blockedMovements ?? [])];
  const bansAtB = [...(doc.node(b)?.blockedMovements ?? [])];
  doc.removeSegment(first.id);
  doc.removeSegment(second.id);
  doc.removeNode(nodeId);
  const joined = doc.addSegment(a, b, first.type, null, dashOrigin, 'both', first.lanes, first.structure, first.section);
  if (!joined) return false;
  doc.carryMovements(a, bansAtA, first.id, joined.id);
  doc.carryMovements(b, bansAtB, second.id, joined.id);
  return true;
}

/**
 * Creates a disconnected parallel copy of a road for rapid layout iteration.
 *
 * The copy deliberately owns new endpoints: duplicating onto the original
 * junctions would instantly create a second overlapping carriageway. Keeping
 * the same curve parameters after a lateral translation preserves the exact
 * road shape, direction and lane profile while leaving the user free to join
 * either endpoint where needed.
 */
export function duplicateSegment(doc: RoadDoc, net: Network, id: SegmentId): SegmentId | null {
  const segment = doc.segment(id);
  if (!segment) return null;
  const a = doc.node(segment.a);
  const b = doc.node(segment.b);
  if (!a || !b) return null;

  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = Math.hypot(dx, dy);
  if (length < MERGE_EPS) return null;
  const sourceWidth = net.ribbons.get(id)?.road.width ?? 12;
  const offset = Math.max(22, sourceWidth + 12);
  const nx = (-dy / length) * offset;
  const ny = (dx / length) * offset;
  const copyA = doc.addNode({ x: a.x + nx, y: a.y + ny }, a.heightOffset);
  const copyB = doc.addNode({ x: b.x + nx, y: b.y + ny }, b.heightOffset);
  const copy = doc.addSegment(
    copyA.id,
    copyB.id,
    segment.type,
    segment.curve ? { ...segment.curve } : null,
    segment.dashOrigin,
    segment.direction,
    segment.lanes,
    segment.structure,
    segment.section,
  );
  if (copy) return copy.id;

  // Source validation above makes this defensive branch unlikely, but keep
  // document invariants intact if a future segment policy rejects the copy.
  doc.removeNode(copyA.id);
  doc.removeNode(copyB.id);
  return null;
}

/**
 * Splits one original segment at any number of positions.
 *
 * Curves are reconstructed from de Casteljau sub-curves, so the two (or more)
 * resulting segments trace the same quadratic instead of becoming chords.
 */
function splitSegmentAtCuts<Tag>(
  doc: RoadDoc,
  net: Network,
  id: SegmentId,
  requests: readonly TaggedCut<Tag>[],
): Map<Tag, NodeId> {
  const result = new Map<Tag, NodeId>();
  const seg = doc.segment(id);
  if (!seg) return result;
  const pl = net.polylines.get(doc, id);

  interface InteriorCut {
    at: Vec2;
    s: number;
    q: number;
    tags: Tag[];
  }

  const interior: InteriorCut[] = [];
  const ordered = [...requests]
    .filter((request) => Number.isFinite(request.s) && validPoint(request.at))
    .sort((left, right) => left.s - right.s);

  const originalA = doc.requireNode(seg.a);
  const originalB = doc.requireNode(seg.b);
  const a = { x: originalA.x, y: originalA.y };
  const b = { x: originalB.x, y: originalB.y };
  const control = seg.curve ? controlPoint(a, b, seg.curve) : null;

  for (const request of ordered) {
    if (request.s <= MERGE_EPS) {
      result.set(request.tag, seg.a);
      continue;
    }
    if (request.s >= pl.length - MERGE_EPS) {
      result.set(request.tag, seg.b);
      continue;
    }

    const previous = interior[interior.length - 1];
    if (previous && Math.abs(previous.s - request.s) <= MERGE_EPS) {
      previous.tags.push(request.tag);
      continue;
    }

    const q = parameterAtArc(pl, request.s);
    const at = control ? splitQuad(a, control, b, q).left[2] : request.at;
    interior.push({ at, s: request.s, q, tags: [request.tag] });
  }

  if (!interior.length) return result;

  const nodes = interior.map((cut) =>
    doc.addNode(cut.at, (originalA.heightOffset ?? 0) +
      ((originalB.heightOffset ?? 0) - (originalA.heightOffset ?? 0)) *
      (cut.s / Math.max(1e-6, pl.length))));
  for (let i = 0; i < interior.length; i++) {
    const cut = interior[i] as InteriorCut;
    const node = nodes[i] as { id: NodeId };
    for (const tag of cut.tags) result.set(tag, node.id);
  }

  const nodeIds = [seg.a, ...nodes.map((node) => node.id), seg.b];
  const points = [a, ...nodes.map((node) => ({ x: node.x, y: node.y })), b];
  const params = [0, ...interior.map((cut) => cut.q), 1];
  const arcs = [0, ...interior.map((cut) => cut.s), pl.length];
  const type = seg.type;
  const dashOrigin = seg.dashOrigin;
  // The bans at the two ends name this segment; they move to the end pieces.
  const bansAtA = [...(doc.node(seg.a)?.blockedMovements ?? [])];
  const bansAtB = [...(doc.node(seg.b)?.blockedMovements ?? [])];
  const pieces: SegmentId[] = [];

  doc.removeSegment(id);
  for (let i = 0; i + 1 < nodeIds.length; i++) {
    const pieceCurve = curveShapeForRange(
      a,
      b,
      seg.curve,
      points[i] as Vec2,
      points[i + 1] as Vec2,
      params[i] as number,
      params[i + 1] as number,
    );
    const piece = doc.addSegment(
      nodeIds[i] as NodeId,
      nodeIds[i + 1] as NodeId,
      type,
      pieceCurve,
      dashOrigin + (arcs[i] as number),
      seg.direction,
      seg.lanes,
      seg.structure,
      seg.section,
    );
    if (piece) pieces.push(piece.id);
  }
  const first = pieces[0];
  const last = pieces[pieces.length - 1];
  if (first !== undefined) doc.carryMovements(seg.a, bansAtA, id, first);
  if (last !== undefined) doc.carryMovements(seg.b, bansAtB, id, last);

  return result;
}

function parameterAtArc(polyline: Polyline, s: number): number {
  const frame = polyline.sampleAt(s);
  return (frame.i + frame.u) / Math.max(1, polyline.n - 1);
}

function curveShapeForRange(
  originalA: Vec2,
  originalB: Vec2,
  curve: CurveShape | null,
  actualA: Vec2,
  actualB: Vec2,
  t0: number,
  t1: number,
): CurveShape | null {
  if (!curve || Math.abs(curve.h) < EPS) return null;
  const originalControl = controlPoint(originalA, originalB, curve);
  const range = quadRange(originalA, originalControl, originalB, t0, t1);
  const shape = shapeFromControl(actualA, actualB, range[1]);
  return Math.abs(shape.h) < EPS ? null : shape;
}

/** Returns the de Casteljau control triple over the original [t0,t1] range. */
function quadRange(
  a: Vec2,
  c: Vec2,
  b: Vec2,
  t0: number,
  t1: number,
): [Vec2, Vec2, Vec2] {
  let range: [Vec2, Vec2, Vec2] = [a, c, b];
  if (t1 < 1) range = splitQuad(range[0], range[1], range[2], t1).left;
  if (t0 > 0) {
    const local = t1 > 0 ? t0 / t1 : 0;
    range = splitQuad(range[0], range[1], range[2], local).right;
  }
  return range;
}

function validPoint(point: Vec2): boolean {
  return Number.isFinite(point.x) && Number.isFinite(point.y);
}
