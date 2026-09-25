import type { Vec2 } from '@core/vec2';
import type { RoadDoc } from './doc';
import type { NodeId } from './ids';
import { COARSE_EPS } from '@core/scalar';
import { PolylineCache } from './geometry';

/**
 * How sharply two roads may meet at one node, and where that is decided.
 *
 * ONE definition, reachable from the model. It used to live in
 * `editor/commit.ts` and be checked in exactly one place — inside
 * `commitDraft` — which meant it governed only the act of DRAWING. Every other
 * way a node comes into being walked straight past it: `localStorage` on boot,
 * opening a file, importing, undo, redo, and dragging a node with the move
 * tool. So the rule was real and never reached the map the user actually had.
 *
 * Below this angle `acuteSetback` — the distance at which two carriageways stop
 * overlapping — grows without bound, the trim goes from about 30 units to about
 * 185, and `legTongue` paints a finger of kerb and footway that long across
 * open grass with no asphalt beside it. Measured by a probe script since removed:
 * a 7-degree hairpin gives trims of 246 and a tongue 16.6 times the road's
 * half-width, against 2.0 for a healthy cross or T.
 */
export const MIN_LEG_ANGLE = (25 * Math.PI) / 180;

/**
 * Outgoing directions of a node's legs, in radians, sorted.
 *
 * Taken from each segment's own polyline one flattened step in from the node —
 * its TANGENT there — not from the straight line to the far node. On a tight
 * curve those disagree by tens of degrees, and the junction builder uses the
 * tangent, so measuring anything else would refuse drags that build correctly
 * and accept drags that do not.
 */
export function legAngles(doc: RoadDoc, cache: PolylineCache, node: NodeId): number[] {
  const source = doc.node(node);
  if (!source) return [];

  const out: number[] = [];
  for (const segId of source.incident) {
    const segment = doc.segment(segId);
    if (!segment) continue;
    const points = cache.get(doc, segId).toPoints();
    if (points.length < 2) continue;
    const startsHere = segment.a === node;
    const at = (startsHere ? points[0] : points[points.length - 1]) as Vec2;
    const next = (startsHere ? points[1] : points[points.length - 2]) as Vec2;
    const dx = next.x - at.x;
    const dy = next.y - at.y;
    if (dx === 0 && dy === 0) continue;
    out.push(Math.atan2(dy, dx));
  }
  out.sort((p, q) => p - q);
  return out;
}

/**
 * Smallest angle between any two of these legs, in radians.
 *
 * `Infinity` for a node with fewer than two legs: a stub cannot be too sharp.
 * The angles must arrive sorted, which `legAngles` guarantees.
 */
export function smallestGap(angles: readonly number[]): number {
  if (angles.length < 2) return Infinity;
  let worst = Infinity;
  for (let i = 0; i < angles.length; i++) {
    let gap = (angles[(i + 1) % angles.length] as number) - (angles[i] as number);
    // The last pair wraps past the branch cut of `atan2`.
    if (i === angles.length - 1) gap += Math.PI * 2;
    if (gap < worst) worst = gap;
  }
  return worst;
}

/** True when no pair of legs at this node is sharper than the minimum. */
export function nodeIsBuildable(doc: RoadDoc, cache: PolylineCache, node: NodeId): boolean {
  return smallestGap(legAngles(doc, cache, node)) >= MIN_LEG_ANGLE;
}

/** True when NO node in the document is too sharp. */
export function allNodesBuildable(doc: RoadDoc): boolean {
  const cache = new PolylineCache();
  for (const node of doc.nodes.keys()) {
    if (!nodeIsBuildable(doc, cache, node)) return false;
  }
  return true;
}

/**
 * Every node that cannot be built, with the gap that condemns it.
 *
 * This is the sweep a LOAD uses. Loading must never refuse — refusing to open a
 * map destroys the user's work, which `.claude/rules/editor-and-app.md`
 * forbids — so the map comes in whole and the offenders are reported instead.
 */
export function impossibleNodes(doc: RoadDoc, cache = new PolylineCache()): Map<NodeId, number> {
  const out = new Map<NodeId, number>();
  for (const node of doc.nodes.keys()) {
    const gap = smallestGap(legAngles(doc, cache, node));
    if (gap < MIN_LEG_ANGLE) out.set(node, gap);
  }
  return out;
}

/**
 * How much sharper a gap has to get before the change counts as a worsening.
 *
 * Splitting a segment near a node re-flattens its polyline, so a gap that
 * nothing touched can still move by a few ulps between two rebuilds. Without a
 * floor, that noise reads as damage and refuses an edit that changed nothing.
 * `COARSE_EPS` is the right one and not a new constant: this gap came out of an
 * `atan2` on a flattened polyline, which is exactly the "already been through
 * arithmetic" case that tolerance exists for. Far below anything a mouse can
 * express, far above flattening noise.
 */
const GAP_NOISE = COARSE_EPS;

/**
 * Did this edit make the map WORSE, judged node by node?
 *
 * This is the question the editor has to ask, and the reason it is not
 * `allNodesBuildable`. That one asks whether the whole document is clean, which
 * is a different question with a catastrophic answer: a map that already holds
 * one hairpin — and every map does, because LOADING is not allowed to refuse
 * one — fails it forever, so every subsequent road anywhere on the map is
 * rejected as `tooSharp`. Measured: a 7-degree node parked 5000 units away
 * blocked a road drawn at the origin, on an otherwise empty document. The
 * editor was bricked by a node the user could not even see.
 *
 * So the test is DIFFERENTIAL. An edit is refused when it creates a node too
 * sharp to build, or when it makes an already-condemned node sharper still.
 * Damage that was already there is not this edit's fault and does not stand in
 * the way of repairing it.
 */
export function worsensAnyNode(
  before: ReadonlyMap<NodeId, number>,
  after: ReadonlyMap<NodeId, number>,
): boolean {
  for (const [node, gap] of after) {
    const was = before.get(node);
    if (was === undefined) return true;
    if (gap < was - GAP_NOISE) return true;
  }
  return false;
}

/**
 * The gaps at exactly these nodes, keyed the same way `impossibleNodes` keys
 * its own, so the two can be compared by `worsensAnyNode`.
 *
 * Only offenders are recorded. A node above the minimum is absent from the map,
 * which is what makes "absent before, present after" mean "this edit broke it".
 */
export function impossibleAmong(
  doc: RoadDoc,
  nodes: Iterable<NodeId>,
  cache = new PolylineCache(),
): Map<NodeId, number> {
  const out = new Map<NodeId, number>();
  for (const node of nodes) {
    if (!doc.node(node)) continue;
    const gap = smallestGap(legAngles(doc, cache, node));
    if (gap < MIN_LEG_ANGLE) out.set(node, gap);
  }
  return out;
}

/**
 * The nodes this edit actually changed — the only ones worth re-measuring.
 *
 * Sweeping the whole document twice per commit is what made drawing a road
 * visibly slow on a real map: every node's every leg re-flattened through its
 * bezier, twice, for a gesture that touched three of them. A leg's direction
 * can only change if the set of segments meeting there changed, and splitting a
 * road issues fresh segment ids at both of its ends, so the incident set is a
 * complete witness — nothing that moved can hide from it.
 */
export function changedNodes(before: RoadDoc, after: RoadDoc): NodeId[] {
  const out: NodeId[] = [];
  for (const [id, node] of after.nodes) {
    const was = before.node(id);
    if (!was) {
      out.push(id);
      continue;
    }
    if (was.incident.length !== node.incident.length) {
      out.push(id);
      continue;
    }
    const had = new Set(was.incident);
    for (const seg of node.incident) {
      if (!had.has(seg)) {
        out.push(id);
        break;
      }
    }
  }
  return out;
}
