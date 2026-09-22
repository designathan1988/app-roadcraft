import { Polyline } from '@core/polyline';
import { flattenSegment } from '@core/bezier';
import { type Vec2, neg, perp } from '@core/vec2';
import type { RoadDoc, RoadSegment } from './doc';
import type { NodeId, SegmentId } from './ids';

/** A cross-section frame taken at some distance from one end of a segment. */
export interface LegFrame {
  /** Position on the centreline. */
  readonly p: Vec2;
  /** Unit direction pointing AWAY from the reference node. */
  readonly dir: Vec2;
  /** Unit left normal of `dir`. */
  readonly nrm: Vec2;
  /** Total arc length of the segment. */
  readonly length: number;
}

/**
 * Flattened centreline of a segment, in world space, oriented a -> b.
 *
 * Straight segments return their two endpoints exactly — no sampling error is
 * introduced where none is needed.
 */
export function segmentPolyline(doc: RoadDoc, seg: RoadSegment): Polyline {
  const a = doc.requireNode(seg.a);
  const b = doc.requireNode(seg.b);
  return Polyline.fromPoints(
    flattenSegment({ x: a.x, y: a.y }, { x: b.x, y: b.y }, seg.curve),
  );
}

/** Centreline oriented so that it starts at `from`. */
export function orientedPolyline(
  doc: RoadDoc,
  seg: RoadSegment,
  from: NodeId,
): Polyline {
  const pl = segmentPolyline(doc, seg);
  return seg.a === from ? pl : pl.reversed();
}

/**
 * Frame at `distance` measured from `nodeId` along `seg`.
 *
 * `dir` always points away from `nodeId`, which is what makes every downstream
 * formula (corners, trims, stop lines, crosswalks) sign-consistent regardless
 * of how the segment happens to be stored.
 */
export function frameFromNode(
  pl: Polyline,
  segStartsAtNode: boolean,
  distance: number,
): LegFrame {
  const length = pl.length;
  if (segStartsAtNode) {
    const f = pl.sampleAt(distance);
    return { p: f.p, dir: f.t, nrm: perp(f.t), length };
  }
  const f = pl.sampleAt(length - distance);
  const dir = neg(f.t);
  return { p: f.p, dir, nrm: perp(dir), length };
}

/** The other endpoint of `seg`. */
export const farNode = (seg: RoadSegment, from: NodeId): NodeId =>
  seg.a === from ? seg.b : seg.a;

export const segmentStartsAt = (seg: RoadSegment, node: NodeId): boolean =>
  seg.a === node;

/** Cheap cache of per-segment polylines, rebuilt only for dirty segments. */
export class PolylineCache {
  private map = new Map<SegmentId, Polyline>();

  get(doc: RoadDoc, id: SegmentId): Polyline {
    let pl = this.map.get(id);
    if (!pl) {
      pl = segmentPolyline(doc, doc.requireSegment(id));
      this.map.set(id, pl);
    }
    return pl;
  }

  invalidate(id: SegmentId): void {
    this.map.delete(id);
  }

  clear(): void {
    this.map.clear();
  }

  /**
   * Takes over another cache's entries.
   *
   * Used when one network adopts another's geometry after the two documents
   * have been made equal: every polyline in there was flattened from the same
   * segment id and is still the right answer, so re-flattening it would be work
   * for an identical result.
   */
  adopt(other: PolylineCache): void {
    this.map.clear();
    for (const [id, pl] of other.map) this.map.set(id, pl);
  }

  get size(): number {
    return this.map.size;
  }
}
