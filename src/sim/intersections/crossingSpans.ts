import type { Polyline } from '@core/polyline';
import { BODY_ENVELOPE, HEAVY } from '@world/conflictPoints';
import type { ConnectorId } from '@world/lanelets';
import type { Connector } from '@world/lanelets';
import { m } from '@world/units';
import { CROSSWALK_DEPTH } from '@world/approach';
import type { CrossingId } from '../signals/plan';
import type { SimWorld } from '../world';
import type { CrossingOccupant } from '../crossings/state';
import type { Vehicle } from '../vehicles/state';
import { canStopComfortably } from '../vehicles/idm';

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
  /** Earliest safe front stop on an incoming lane near another leg's zebra. */
  private readonly approachStops = new Map<string, number>();
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
    this.approachStops.clear();
    const previous = this.measured;
    this.measured = new Map();
    for (const connector of w.graph.connectors.values()) {
      const path = w.lanelet(connector.lanelet)?.centre;
      if (!path) continue;
      for (const segment of w.doc.node(connector.node)?.incident ?? []) {
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
    // A long body stopped at a red signal can project across the zebra of an
    // adjacent acute leg even though its own stop line is correctly placed.
    // Measure those physical overlaps once per topology, before any pedestrian
    // enters, so the red-light obstacle holds the front before that zebra.
    for (const junction of w.graph.junctions.values()) {
      const incident = w.doc.node(junction.node)?.incident ?? [];
      for (const laneId of junction.inbound) {
        const lane = w.lanelet(laneId);
        if (!lane || lane.kind !== 'link') continue;
        let stop = lane.length;
        for (const segment of incident) {
          if (segment === lane.segment) continue;
          const crossing = `${junction.node}:${segment}`;
          const edge = w.sidewalks.edges.get(w.sidewalks.crossings.get(crossing) ?? '');
          if (!edge) continue;
          const id = `approach:${key(laneId, crossing)}`;
          const known = previous.get(id);
          const span = known && known.length === edge.length && sameFloats(known.path, lane.centre.xy)
            && sameFloats(known.edge, edge.path.xy)
            ? known.span : measure(lane.centre, edge.path, edge.length);
          this.measured.set(id, { path: lane.centre.xy, edge: edge.path.xy, length: edge.length, span });
          if (span) stop = Math.min(stop, span.along);
        }
        if (stop < lane.length) this.approachStops.set(laneId, stop);
      }
    }
  }

  approachStop(lane: string): number | undefined {
    return this.approachStops.get(lane);
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
const CLEAR_PAST = 6;

/** Whether this vehicle's current reservation still protects a zebra span. */
export function reservationCoversCrossing(w: SimWorld, v: Vehicle, connector: Connector,
  segment: number, span: CrossingSpan | null | undefined): boolean {
  if (span === null) return false;
  if (span === undefined) return true;
  const lane = w.lanelet(v.lanelet);
  if (lane?.kind === 'link' && connector.id === v.admittedConnector &&
      connector.inSegment === segment && connector.outSegment !== segment) {
    const distance = Math.max(0, lane.length - v.s) + span.along;
    if (distance > m(2) && canStopComfortably(v.driver, v.v, distance)) return false;
  }
  if (connector.id === lane?.id && v.s - v.archetype.length > span.along + CLEAR_PAST) return false;
  if (connector.id !== lane?.id && connector.id !== v.admittedConnector) {
    const token = v.clearingConnectors.find((t) => t.connector === connector.id);
    if (token && connector.length + token.distanceBeyondExit - v.archetype.length > span.along + CLEAR_PAST) return false;
  }
  return true;
}

/** Whether somebody on a crossing occupies or will soon reach this movement's part of it. */
export function pedestrianAffectsSpan(p: CrossingOccupant, span: CrossingSpan): boolean {
  const at = p.s;
  if (at >= span.s0 - PED_BODY && at <= span.s1 + PED_BODY) return true;
  const ahead = p.forward ? span.s0 - at : at - span.s1;
  return ahead > 0 && ahead < Math.max(p.v, PED_MIN_PACE) * PED_REACH_TIME;
}

/** Whether somebody on this crossing is in, or about to enter, the span. */
export function pedestrianInSpan(w: SimWorld, connector: ConnectorId, crossing: CrossingId): CrossingSpan | null {
  const state = w.crossingStates.get(crossing);
  if (!state?.occupants.length) return null;
  const span = w.crossingSpans.span(connector, crossing);
  if (span === null) return null;
  if (span === undefined) return { s0: 0, s1: state.length, along: 0 };
  for (const p of state.occupants) {
    if (pedestrianAffectsSpan(p, span)) return span;
  }
  return null;
}
