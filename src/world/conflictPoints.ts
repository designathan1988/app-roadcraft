import { segSeg } from '@core/intersect';
import type { Vec2 } from '@core/vec2';
import type { NodeId } from './ids';
import type { ConnectorId, LaneletGraph } from './lanelets';

export type ConflictKind = 'cross' | 'merge';

export interface ConflictPoint {
  readonly id: number;
  readonly node: NodeId;
  readonly a: ConnectorId;
  readonly b: ConnectorId;
  /** Arc position of the point along connector `a`. */
  readonly sA: number;
  /** Arc position of the point along connector `b`. */
  readonly sB: number;
  readonly kind: ConflictKind;
  readonly at: Vec2;
}

export interface ConflictRef {
  readonly point: number;
  /** Arc position along the connector holding this reference. */
  readonly s: number;
  readonly other: ConnectorId;
  readonly kind: ConflictKind;
}

/**
 * Where two movements through a junction actually cross.
 *
 * Computed once per topology version by sampling connector centrelines, not per
 * frame. The V6 monolith ran `polylinesTooClose` — 441 distance tests plus 400
 * segment intersections per pair — inside the per-vehicle admission check,
 * twice a frame, uncached (defect 5.7). Worse, it tested a path built for a
 * DIFFERENT lane than the one the vehicle actually drove, so it invented
 * phantom conflicts that blocked green movements forever (defect 2.4).
 *
 * Movements that share an origin lane are excluded: those are handled by
 * ordinary car-following, not by conflict arbitration. Movements that share a
 * destination lane are included as merges.
 */
export class ConflictIndex {
  readonly points: ConflictPoint[] = [];
  /** References held by each connector, sorted by arc position. */
  readonly byConnector = new Map<ConnectorId, ConflictRef[]>();

  /**
   * Conflict ids are resources held by live vehicles, so their meaning must
   * survive a topology rebuild.  Array positions are deliberately never
   * recycled: a connector pair that still exists keeps its id, while a new
   * pair receives a fresh one.  `points` may therefore be sparse after edits.
   */
  private readonly idByKey = new Map<string, number>();
  private nextId = 0;

  build(graph: LaneletGraph): void {
    this.points.length = 0;
    this.byConnector.clear();

    for (const junction of graph.junctions.values()) {
      const ids = junction.connectors.slice().sort();
      for (let i = 0; i < ids.length; i++) {
        for (let j = i + 1; j < ids.length; j++) {
          const a = graph.connectors.get(ids[i] as ConnectorId);
          const b = graph.connectors.get(ids[j] as ConnectorId);
          if (!a || !b) continue;

          // Same origin lane: a diverge. Car-following handles it.
          if (a.fromLane === b.fromLane) continue;

          const la = graph.lanelet(a.lanelet);
          const lb = graph.lanelet(b.lanelet);
          if (!la || !lb) continue;

          if (a.toLane === b.toLane) {
            // Shared destination: the merge point is the end of both.
            this.add(junction.node, a.id, b.id, la.length, lb.length, 'merge', la.centre.sampleAt(la.length).p);
            continue;
          }

          const hit = firstCrossing(la.centre.toPoints(), lb.centre.toPoints());
          if (hit) {
            this.add(junction.node, a.id, b.id, hit.sA, hit.sB, 'cross', hit.at);
          }
        }
      }
    }

    for (const list of this.byConnector.values()) list.sort((p, q) => p.s - q.s);
  }

  private add(
    node: NodeId,
    a: ConnectorId,
    b: ConnectorId,
    sA: number,
    sB: number,
    kind: ConflictKind,
    at: Vec2,
  ): void {
    const [lo, hi] = a < b ? [a, b] : [b, a];
    const key = `${node}|${lo}|${hi}|${kind}`;
    let id = this.idByKey.get(key);
    if (id === undefined) {
      id = this.nextId++;
      this.idByKey.set(key, id);
    }

    // Assignment rather than push preserves the stable (possibly sparse) id.
    this.points[id] = { id, node, a, b, sA, sB, kind, at };
    pushRef(this.byConnector, a, { point: id, s: sA, other: b, kind });
    pushRef(this.byConnector, b, { point: id, s: sB, other: a, kind });
  }

  refs(connector: ConnectorId): readonly ConflictRef[] {
    return this.byConnector.get(connector) ?? [];
  }

  /** True when the two connectors have at least one conflict point. */
  conflict(a: ConnectorId, b: ConnectorId): boolean {
    for (const r of this.refs(a)) if (r.other === b) return true;
    return false;
  }
}

function pushRef(
  map: Map<ConnectorId, ConflictRef[]>,
  key: ConnectorId,
  ref: ConflictRef,
): void {
  const list = map.get(key);
  if (list) list.push(ref);
  else map.set(key, [ref]);
}

/** First intersection between two polylines, with arc positions on each. */
function firstCrossing(
  a: readonly Vec2[],
  b: readonly Vec2[],
): { sA: number; sB: number; at: Vec2 } | null {
  let sA = 0;
  for (let i = 0; i + 1 < a.length; i++) {
    const a0 = a[i] as Vec2;
    const a1 = a[i + 1] as Vec2;
    const segA = Math.hypot(a1.x - a0.x, a1.y - a0.y);

    let sB = 0;
    for (let j = 0; j + 1 < b.length; j++) {
      const b0 = b[j] as Vec2;
      const b1 = b[j + 1] as Vec2;
      const segB = Math.hypot(b1.x - b0.x, b1.y - b0.y);
      const hit = segSeg(a0, a1, b0, b1);
      if (hit) {
        return { sA: sA + hit.t * segA, sB: sB + hit.u * segB, at: hit.point };
      }
      sB += segB;
    }
    sA += segA;
  }
  return null;
}
