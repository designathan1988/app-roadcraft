import type { Polyline } from '@core/polyline';
import { BODY_ENVELOPE, HEAVY } from '@world/conflictPoints';
import type { ConnectorId } from '@world/lanelets';
import { m } from '@world/units';
import { CROSSWALK_DEPTH } from '@world/approach';
import type { CrossingId } from '../signals/plan';
import type { SimWorld } from '../world';
import type { Ped } from '../peds/state';
import type { SidewalkEdge } from '../peds/sidewalk';

/** Arc interval of a crossing, measured from its `from` kerb. */
export interface CrossingSpan {
  readonly s0: number;
  readonly s1: number;
  /** Arc position along the MOVEMENT where its body first reaches the span. */
  readonly along: number;
}

/**
 * Clearance kept between a vehicle body and a pedestrian: a heavy vehicle's
 * half width plus a person and a margin, as a distance from the movement's
 * centreline.
 */
const REACH = (BODY_ENVELOPE[HEAVY]?.width ?? 0) / 2 + m(0.9);
const SAMPLE = 0.5;
/** A walker's clearance from a vehicle body (`PedestrianClearance`), plus margin. */
const PERSON_CLEAR = m(0.6);

/**
 * The part of each zebra a movement actually drives over.
 *
 * A turning vehicle used to be held while ANYBODY was anywhere on a crossing
 * it touched: a person on the far half of a boulevard zebra, three lanes away
 * from the turn's path, stopped it just as surely as one in front of its
 * bumper. Measured on a four-way of avenues, "pedestrian" was the commonest
 * reason a turn stood still at green. What conflicts is the stretch of the
 * crossing inside the swept path of the vehicle, so that stretch is what is
 * recorded here, once per topology version.
 */
export class CrossingSpans {
  private readonly spans = new Map<string, CrossingSpan | null>();
  /**
   * Every span of the previous build, with the two paths it was measured on.
   *
   * Measuring is a closest-point query against the whole movement for every
   * half unit of every crossing, for every movement in the map, on every edit:
   * half a second per road drawn on a 264-segment map, nearly all of it for
   * junctions the edit never reached. A span depends on nothing but the two
   * paths, so one whose paths are unchanged is read back instead.
   */
  private measured = new Map<string, Measured>();

  build(w: SimWorld): void {
    this.spans.clear();
    const previous = this.measured;
    this.measured = new Map();
    for (const connector of w.graph.connectors.values()) {
      const path = w.lanelet(connector.lanelet)?.centre;
      if (!path) continue;
      for (const segment of [connector.inSegment, connector.outSegment]) {
        const crossing = `${connector.node}:${segment}`;
        const edge = w.sidewalks.edges.get(w.sidewalks.crossings.get(crossing) ?? '');
        if (!edge) continue;
        const id = key(connector.id, crossing);
        const known = previous.get(id);
        const span = known && known.length === edge.length && sameFloats(known.path, path.xy)
          && sameFloats(known.edge, edge.path.xy)
          ? known.span
          : measure(path, edge.path, edge.length);
        this.measured.set(id, { path: path.xy, edge: edge.path.xy, length: edge.length, span });
        this.spans.set(id, span);
      }
    }
  }

  /** Undefined: never measured (treat conservatively). Null: never crossed. */
  span(connector: ConnectorId, crossing: CrossingId): CrossingSpan | null | undefined {
    return this.spans.get(key(connector, crossing));
  }
}

const key = (connector: ConnectorId, crossing: CrossingId): string => `${connector}|${crossing}`;

interface Measured {
  readonly path: Float64Array;
  readonly edge: Float64Array;
  readonly length: number;
  readonly span: CrossingSpan | null;
}

/** The stretch of a crossing `length` long that a movement along `path` drives over. */
function measure(path: Polyline, crossing: Polyline, length: number): CrossingSpan | null {
  let s0 = Infinity;
  let s1 = -Infinity;
  let centre = Infinity;
  for (let s = 0; s <= length; s += SAMPLE) {
    const hit = path.closestPoint(crossing.sampleAt(s).p);
    if (hit.distance > REACH) continue;
    s0 = Math.min(s0, s);
    s1 = Math.max(s1, s);
    centre = Math.min(centre, hit.s);
  }
  // Where the FRONT must stop: before the near edge of the painted band
  // and a person standing on it. Stopping by the zebra centreline put the
  // bumper inside a walker's clearance; the walker could not pass and the
  // vehicle would not move until they had — a mutual wait in the box.
  const along = Math.max(0, centre - CROSSWALK_DEPTH / 2 - PERSON_CLEAR);
  return s0 <= s1 ? { s0, s1, along } : null;
}

function sameFloats(a: Float64Array, b: Float64Array): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** A person's radius, a minimum pace assumed for someone about to move, and the look-ahead. */
export const PED_BODY = 1;
export const PED_MIN_PACE = 2;
export const PED_REACH_TIME = 4;
/** Reserve the near half of a zebra before stopping a car for a pedestrian. */
export const PED_CROSSING_STOP_BUFFER = CROSSWALK_DEPTH / 2 + 0.5;

/** Whether this pedestrian occupies or will soon reach this movement's part of a zebra. */
export function pedestrianAffectsSpan(p: Ped, edge: SidewalkEdge, span: CrossingSpan): boolean {
  const forward = p.entry === edge.from;
  const at = forward ? p.s : edge.length - p.s;
  if (at >= span.s0 - PED_BODY && at <= span.s1 + PED_BODY) return true;
  const ahead = forward ? span.s0 - at : at - span.s1;
  return ahead > 0 && ahead < Math.max(p.v, PED_MIN_PACE) * PED_REACH_TIME;
}

/** Whether somebody on this crossing is in, or about to enter, the span. */
export function pedestrianInSpan(w: SimWorld, connector: ConnectorId, crossing: CrossingId): CrossingSpan | null {
  const occupants = w.pedOccupancy.get(crossing);
  if (!occupants?.length) return null;
  const span = w.crossingSpans.span(connector, crossing);
  if (span === null) return null;
  const edge = w.sidewalks.edges.get(w.sidewalks.crossings.get(crossing) ?? '');
  const whole: CrossingSpan = { s0: 0, s1: edge?.length ?? 0, along: 0 };
  if (span === undefined || !edge) return whole;
  for (const pedId of occupants) {
    const p = w.peds.get(pedId);
    if (!p) continue;
    if (pedestrianAffectsSpan(p, edge, span)) return span;
  }
  return null;
}
