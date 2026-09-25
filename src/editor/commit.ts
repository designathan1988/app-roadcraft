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
import { changedNodes, impossibleAmong, worsensAnyNode } from '@world/legAngles';
import { ROAD_TYPES } from '@world/roadTypes';
import type { RoadStructure } from '@world/structures';
import type { Anchor } from './snap';
import { COARSE_EPS, EPS } from '@core/scalar';

/** Shortest road the editor will create. */
const MIN_DRAFT_LENGTH = 24;
/** Two nodes closer than this are the same node. */
const MERGE_EPS = 2.6;

export interface DraftResult {
  readonly committed: boolean;
  readonly reason?: 'tooShort' | 'duplicate' | 'degenerate' | 'tooSharp';
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

  // The RESULT is checked, not the drag. A drag that is itself well clear of
  // everything can still split a road and leave the two halves meeting the new
  // one at a sliver, and the sliver is where the junction fails. Checking the
  // clone catches that, and rejecting here leaves the live map untouched by the
  // same atomicity that already covers a duplicate or a degenerate anchor.
  //
  // DIFFERENTIAL, never absolute. `allNodesBuildable(work)` stood here and made
  // the editor unusable: one pre-existing 7-degree node — invisible, possibly
  // thousands of units away — rejected every road drawn anywhere on the map
  // with `tooSharp`, forever, because the whole-document question can only be
  // answered `false` once such a node exists. What this edit must be judged on
  // is what this edit did.
  // Only the nodes this draft changed are re-measured, and each is compared
  // against WHAT IT WAS. Sweeping every node instead cost real time on a real
  // map — two full re-flattenings of every bezier in the document per road
  // drawn — for an answer that cannot differ anywhere the draft did not reach.
  const touched = changedNodes(doc, work);
  if (worsensAnyNode(impossibleAmong(doc, touched), impossibleAmong(work, touched))) {
    return { committed: false, reason: 'tooSharp' };
  }

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
): DraftResult {
  const endpoints = materializeEndpoints(doc, net, start, end);
  if (!endpoints || endpoints[0] === endpoints[1]) {
    return { committed: false, reason: 'degenerate' };
  }
  const [startNode, endNode] = endpoints;

  // Endpoint splitting changed the graph. Rebuild before scanning so every
  // crossing test sees current polylines and segment ids.
  net.rebuild();

  const a = start.at;
  const b = end.at;
  const draft = Polyline.fromPoints(flattenSegment(a, b, curve));
  const splitBySegment = new Map<SegmentId, ExistingCut[]>();
  const draftCuts: DraftStop[] = [];

  for (const [id, seg] of [...doc.segments]) {
    if (seg.structure !== structure) continue;
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
    if (doc.addSegment(from.node, to.node, type, pieceCurve, from.s, 'both', null, structure)) made++;
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

    resolved.set(tag, materializeFree(doc, anchor.at));
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
function materializeFree(doc: RoadDoc, at: Vec2): NodeId {
  for (const node of doc.nodes.values()) {
    if (dist({ x: node.x, y: node.y }, at) < MERGE_EPS) return node.id;
  }
  return doc.addNode(at).id;
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

/** Joins two compatible straight segments meeting at an otherwise unused node. */
export function joinSegments(doc: RoadDoc, nodeId: NodeId): boolean {
  const node = doc.node(nodeId);
  if (!node || node.incident.length !== 2) return false;
  const [firstId, secondId] = node.incident;
  if (firstId === undefined || secondId === undefined) return false;
  const first = doc.segment(firstId);
  const second = doc.segment(secondId);
  if (!first || !second || first.curve || second.curve || first.type !== second.type || first.lanes !== second.lanes ||
    first.direction !== 'both' || second.direction !== 'both') return false;
  const a = first.a === nodeId ? first.b : first.a;
  const b = second.a === nodeId ? second.b : second.a;
  if (a === b || first.structure !== second.structure || alreadyJoined(doc, a, b, null, first.structure)) return false;
  const dashOrigin = Math.min(first.dashOrigin, second.dashOrigin);
  doc.removeSegment(first.id);
  doc.removeSegment(second.id);
  doc.removeNode(nodeId);
  return doc.addSegment(a, b, first.type, null, dashOrigin, 'both', first.lanes, first.structure) !== null;
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
  const copyA = doc.addNode({ x: a.x + nx, y: a.y + ny });
  const copyB = doc.addNode({ x: b.x + nx, y: b.y + ny });
  const copy = doc.addSegment(
    copyA.id,
    copyB.id,
    segment.type,
    segment.curve ? { ...segment.curve } : null,
    segment.dashOrigin,
    segment.direction,
    segment.lanes,
    segment.structure,
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

  const nodes = interior.map((cut) => doc.addNode(cut.at));
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
    doc.addSegment(
      nodeIds[i] as NodeId,
      nodeIds[i + 1] as NodeId,
      type,
      pieceCurve,
      dashOrigin + (arcs[i] as number),
      seg.direction,
      seg.lanes,
      seg.structure,
    );
  }

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
