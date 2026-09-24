import type { NodeId } from '@world/ids';
import type { Connector, JunctionTopology } from '@world/lanelets';
import { CONVOY_ROLLING, CRITICAL_GAP, CRITICAL_GAP_FLOOR, IMPATIENCE_MAX, IMPATIENCE_RATE, JAM_GAP, REQUEST_MIN_DISTANCE, REQUEST_TIME, WAIT_CEILING } from '../params';
import type { SimWorld } from '../world';
import type { Vehicle } from '../vehicles/state';
import { canStopComfortably, type ObstacleKind } from '../vehicles/idm';
import { pedestrianSignalState, signalStateFor } from '../signals/query';
import { mustStopAtSignal } from '../signals/permission';
import { hasDownstreamStorage } from './spillback';
import { COARSE_EPS } from '@core/scalar';
import { bodyClassOfArchetype } from '../vehicles/archetypes';
import { type Claim, type HolderState, zoneShareable } from './claims';
import { PED_MIN_PACE, PED_REACH_TIME, pedestrianInSpan } from './crossingSpans';

export type RowClass = 'signalGreen' | 'priority' | 'stop' | 'yield' | 'none';

interface Request {
  readonly v: Vehicle;
  readonly conn: Connector;
  /** Distance from the vehicle's nose to the stop line. */
  readonly d: number;
  readonly requestTick: number;
  readonly row: RowClass;
}

interface Verdict {
  readonly ok: boolean;
  readonly reason?: ObstacleKind;
  readonly reservations?: readonly ConnectorReservation[];
  /** A soft maximum claim was declared, but the red still forbids entry. */
  readonly reserveOnly?: boolean;
}

interface ConnectorReservation {
  readonly connector: Connector;
  readonly points: readonly number[];
}

const RANK: Record<RowClass, number> = {
  signalGreen: 3,
  priority: 2,
  stop: 1,
  yield: 0,
  none: -1,
};

/**
 * Grants or denies entry to every junction, once per tick.
 *
 * This is the one stage that is order sensitive, because grants consume a
 * shared resource, so it iterates a sorted id list and resolves ties with a
 * total order.
 *
 * The critical difference from the V6 monolith is what a denial IS. There,
 * `canVehicleEnter` was six serial booleans and the first `false` won outright,
 * with no way for a later condition to soften an earlier one and no state to
 * unwind afterwards. Here a denial simply appends an obstacle at the stop line.
 * The vehicle decelerates smoothly under IDM and, the moment the denial goes
 * away, accelerates again — there is nothing to reset.
 *
 * Two V6 rules are absent by design and their absence is tested:
 *
 *   - No "deny because the green is about to end". Late-green entry is handled
 *     by physics and by the all-red clearance, which exists precisely for it.
 *   - No 3.2-unit arbitration window. The head of each lane requests entry from
 *     `max(8, v * 3s)` back, so a vehicle rolling to a stop — or already
 *     stationary at the line — is always a contender.
 */
export function stepAdmission(w: SimWorld): void {
  revokeStaleGrants(w);
  const requests: Request[] = [];

  for (const node of w.junctionNodesInOrder()) {
    const junction = w.graph.junctions.get(node);
    if (!junction) continue;

    for (const laneId of junction.inbound) {
      const head = w.laneHead(laneId);
      if (!head) continue;
      // A vehicle already granted a movement never competes again.  The token
      // is explicit because a conflict-free connector legitimately owns zero
      // conflict points.
      if (head.admittedConnector) continue;

      const conn = nextConnector(w, head);
      if (!conn) continue;

      const lane = w.lanelet(laneId);
      if (!lane) continue;
      const d = lane.length - head.s;
      if (d > Math.max(REQUEST_MIN_DISTANCE, head.v * REQUEST_TIME)) continue;

      const reservedCurrent = head.reservedConnectors[0] === conn.id;
      // A declared maximum claim pins the route. A different next connector
      // means a live edit or stale route broke that declaration; repair owns
      // that transition, not admission.
      if (head.reservedConnectors.length > 0 && !reservedCurrent) {
        head.constraints.obstacles.push({
          gap: Math.max(0, d),
          speed: 0,
          kind: 'conflict',
        });
        continue;
      }

      if (head.firstRequestTick === null) head.firstRequestTick = w.clock.tick;

      requests.push({
        v: head,
        conn,
        d,
        requestTick: head.firstRequestTick,
        row: rightOfWay(w, node, head, conn, d),
      });
    }
  }

  // A compact maximum claim spans nodes, so arbitration must span nodes too.
  // Sorting inside each junction gave lower node ids permanent first refusal
  // on the resources a holder needs next. Oldest request first makes that
  // preemption finite; ROW, distance and id remain deterministic tie-breakers.
  requests.sort(byPriority);

  // A zone that reaches back over a stop line cannot be protected by a claim
  // alone: the vehicle standing in it has not been admitted to anything.
  for (const r of requests) {
    const stop = stopShortOfIntrusion(w, r.v, r.conn, r.d);
    if (stop !== null) r.v.constraints.obstacles.push({ gap: stop, speed: 0, kind: 'conflict' });
  }

  for (const r of requests) {
    const verdict = evaluate(w, r);
    if (verdict.ok) {
      const reservations = verdict.reservations ?? [];
      if (verdict.reserveOnly) {
        // `reservedConnectors` is a Banker's maximum claim, not physical
        // ownership. It drives fair signal demand but does not block unrelated
        // movements before the vehicle reaches them.
        r.v.reservedConnectors = reservations.map(
          (reservation) => reservation.connector.id,
        );
        // `longitudinalConstraints` has already pushed the signal obstacle
        // for this vehicle from the same `mustStopAtSignal` decision. Pushing
        // a second identical one changes nothing for IDM, which takes the
        // minimum, but it doubled every per-kind diagnostic count.
        if (!r.v.constraints.obstacles.some((o) => o.kind === 'signal')) {
          r.v.constraints.obstacles.push({
            gap: Math.max(0, r.d),
            speed: 0,
            kind: 'signal',
          });
        }
        continue;
      }

      const current = reservations[0];
      if (current) {
        w.claims.grantAll(
          r.v.id,
          current.connector.id,
          current.points,
          w.clock.tick,
        );
      }
      // The vehicle must know it holds these, or it is never treated as
      // admitted and its claims are never released as it clears the points.
      r.v.claims = [...w.claims.points(r.v.id)];
      if (r.v.reservedConnectors[0] === r.conn.id) {
        r.v.reservedConnectors.shift();
      } else {
        r.v.reservedConnectors = reservations
          .slice(1)
          .map((reservation) => reservation.connector.id);
      }
      r.v.admittedConnector = r.conn.id;
      // Waiting time before admission is ordinary queueing, not time spent
      // holding a reservation.  Start the watchdog clock at the grant.
      r.v.lastMovedTick = w.clock.tick;
      // Keep the original age across a compound box so a holder which is able
      // to finish cannot be demoted behind fresh requests at every short link.
      if (r.v.reservedConnectors.length === 0) {
        r.v.firstRequestTick = null;
      }
      w.lastAdmission.set(r.conn.node, w.clock.tick);
    } else {
      r.v.constraints.obstacles.push({
        gap: Math.max(0, r.d),
        speed: 0,
        kind: verdict.reason ?? 'signal',
      });
    }
  }
}

/**
 * Takes back a grant whose signal went red before the vehicle used it.
 *
 * A grant is issued while the vehicle is still on the approach — it has to be,
 * or a driver would arrive at a green line with no permission and brake for
 * nothing. But it was then held until the vehicle physically entered, however
 * long that took. A car authorised on green, delayed behind a queue and
 * arriving at the line ten seconds later drove straight through a red light
 * still holding its token, and no code path could stop it: admission skips
 * anyone who already has `admittedConnector`, and the longitudinal stage sees
 * the grant and suppresses the signal obstacle.
 *
 * Measured on a 4x4 grid of four-lane avenues before this existed: 130 of 464
 * junction entries — 28 % — happened on a fully red movement, every sampled one
 * a right turn moving at speed with no right-on-red credit.
 *
 * The revocation uses the SAME `mustStopAtSignal` decision as braking and as
 * the original grant. A vehicle already too close to stop keeps its permission
 * and clears under the all-red, which is exactly what the all-red is for.
 */
function revokeStaleGrants(w: SimWorld): void {
  for (const v of w.vehiclesInIdOrder()) {
    if (!v.admittedConnector) continue;
    const lane = w.lanelet(v.lanelet);
    // Only while the nose is still on the approach. Once the vehicle is on the
    // connector the movement is committed and taking the box away would strand
    // it inside the junction.
    if (!lane || lane.kind !== 'link') continue;

    const conn = w.connector(v.admittedConnector);
    if (!conn || conn.fromLane !== lane.id) continue;
    const controller = w.controller(conn.node);
    if (!controller || !w.graph.junctions.get(conn.node)?.signalised) continue;

    const state = signalStateFor(controller, conn.group);
    if (state === 'green') continue;
    const d = Math.max(0, lane.length - v.s);

    // Still permitted to enter: an amber it cannot stop for, or a credited
    // right on red.
    if (!mustStopAtSignal(state, conn.turn, v.rorCredit, v.driver, v.v, d)) continue;

    // Committed. A driver who can no longer stop must not be told to — that is
    // the dilemma zone, and the all-red exists precisely so this vehicle can
    // clear. Revocation is for the vehicle that still has the room to obey.
    if (!canStopComfortably(v.driver, v.v, d)) continue;

    w.claims.releaseConnector(v.id, conn.id, w.conflicts);
    v.claims = [...w.claims.points(v.id)];
    v.admittedConnector = null;
    // The compound chain was declared as one transaction with this grant. It
    // has to be re-declared with it, or the vehicle keeps a maximum claim on
    // junctions it is no longer authorised to reach.
    v.reservedConnectors = [];
  }
}

/** Deterministic global order: arrival, then right of way, distance and id. */
const byPriority = (a: Request, b: Request): number =>
  a.requestTick - b.requestTick ||
  RANK[b.row] - RANK[a.row] ||
  a.d - b.d ||
  a.v.id - b.v.id;

function evaluate(w: SimWorld, r: Request): Verdict {
  const alreadyDeclared = r.v.reservedConnectors[0] === r.conn.id;
  const chain = alreadyDeclared
    ? r.v.reservedConnectors.map((id) => w.connector(id)).filter((c): c is Connector => !!c)
    : compactReservationChain(w, r.v, r.conn);
  if (!chain) return { ok: false, reason: 'spillback' };
  if (alreadyDeclared && chain.length !== r.v.reservedConnectors.length) {
    return { ok: false, reason: 'spillback' };
  }

  const reservations = chain.map((connector) => ({
    connector,
    points: w.conflicts.refs(connector.id).map((ref) => ref.point),
  }));

  const current = reservations[0];
  if (!current) return { ok: false, reason: 'spillback' };
  if (r.row === 'none') return { ok: true, reservations, reserveOnly: true };

  // Stop control is not merely a lower arbitration rank.  The driver must
  // first reach a near standstill at the line, then use the same conservative
  // gap acceptance as a yield movement before taking the box.
  if (r.row === 'stop' && r.v.v > 0.4) {
    return { ok: false, reason: 'yield' };
  }

  // Only the connector physically about to be entered becomes a hard claim.
  // Future connectors remain maximum needs in the Banker's safety check.
  if (!w.claims.available(current.points, r.v.id, current.connector.id,
    bodyClassOfArchetype(r.v.archetype), w.conflicts, (claim) => holderState(w, claim))) {
    return { ok: false, reason: 'conflict', reservations };
  }
  if (queuedBodyInZone(w, r.v, current.connector)) {
    return { ok: false, reason: 'conflict', reservations };
  }
  if (!convoyCanEnter(w, r, current.connector)) {
    return { ok: false, reason: 'conflict', reservations };
  }
  if (movementReservedByOther(w, r.v, r.conn)) {
    return { ok: false, reason: 'conflict', reservations };
  }

  if (!hasDownstreamStorage(w, r.v, r.conn)) {
    return { ok: false, reason: 'spillback', reservations };
  }

  if (!bankerSafeAfterGrant(w, r.v, reservations)) {
    return { ok: false, reason: 'conflict', reservations };
  }

  // Permissive movements must find a gap in the traffic they yield to — until
  // the wait ceiling, after which the next opening is taken. Everything above
  // this line has already agreed the movement is safe; only the courtesy of a
  // comfortable gap is being waived. See `WAIT_CEILING`.
  if (
    (r.row === 'yield' || r.row === 'stop') &&
    r.v.waited < WAIT_CEILING &&
    !hasAcceptableGap(w, r)
  ) {
    return { ok: false, reason: 'yield' };
  }

  if (crossingBusy(w, r.conn)) {
    return { ok: false, reason: 'pedestrian' };
  }
  if (pedestrianHasPriority(w, r)) {
    return { ok: false, reason: 'pedestrian' };
  }

  return { ok: true, reservations };
}

/**
 * Movement chain that must be declared before entering `first`.
 *
 * Every connector followed by a sub-vehicle link is part of one compound box.
 * The chain ends only at a link that can contain the complete vehicle plus its
 * standstill buffer, or at a genuine network exit.
 */
export function compactReservationChain(
  w: SimWorld,
  v: Vehicle,
  first: Connector,
): Connector[] | null {
  const chain: Connector[] = [first];
  const seen = new Set([first.id]);
  let routeIndex = v.route.indexOf(first.id);
  if (routeIndex < 0) return null;

  let connector = first;
  while (true) {
    const out = w.lanelet(connector.toLane);
    if (!out || out.kind !== 'link') return null;
    const stoppingBuffer = Math.max(JAM_GAP, v.driver.s0);
    if (out.length + COARSE_EPS >= v.archetype.length + stoppingBuffer) return chain;

    const exits = w.graph.exitsOf(out.id);
    const nextId = v.route[routeIndex + 2];
    if (nextId === undefined) {
      return exits.length === 0 ? chain : null;
    }
    const next = w.connector(nextId);
    if (!next || next.fromLane !== out.id || seen.has(next.id)) return null;

    chain.push(next);
    seen.add(next.id);
    connector = next;
    routeIndex += 2;
  }
}

/**
 * Whether a connector with no conflict points is already spoken for.
 *
 * Some movements genuinely cross nothing - a right turn out of a leg usually
 * crosses no other vehicle path at all - so there is no conflict point to
 * arbitrate them and this is the only thing standing between two vehicles
 * trying to occupy the same piece of road.
 *
 * It used to answer "is ANYBODY on this connector", which made the easiest
 * movement at the junction the most restricted one: a right turn was
 * serialised to ONE VEHICLE AT A TIME along its whole length, however long
 * that connector was and however far down it the leader had already gone.
 * Measured on a four-leg signalised cross, right turns were the most blocked
 * movement of the three - 136 stalls against 97 for both left and through -
 * which is the exact opposite of the order a real junction produces.
 *
 * What is actually required is that two vehicles never occupy the same space.
 * That is a HEADWAY question, and it is the same one car-following answers
 * everywhere else: a follower may enter once the vehicle ahead has travelled
 * far enough along the connector to leave room for it.
 *
 * A vehicle that has been ADMITTED but has not yet entered still holds the
 * movement outright. It was granted first and it is entitled to the space it
 * is about to use; letting a second vehicle in front of it is how a grant
 * becomes worthless.
 */
function movementReservedByOther(w: SimWorld, v: Vehicle, conn: Connector): boolean {
  // Real conflict points already protect a same-path convoy. Only a connector
  // with no point resource needs this explicit occupancy token.
  if (w.conflicts.refs(conn.id).length > 0) return false;

  const need = v.archetype.length + Math.max(JAM_GAP, v.driver.s0);
  for (const other of w.vehicles.values()) {
    if (other.id === v.id) continue;
    // Granted, but still on its approach: the movement is theirs.
    if (other.admittedConnector === conn.id) return true;
    if (other.lanelet !== conn.id) continue;
    // Already on it: only room decides.
    if (other.s < need) return true;
  }
  return false;
}

/**
 * Whether a vehicle WAITING at another movement's stop line is inside the area
 * this one would sweep.
 *
 * Swept zones are measured from the stop line, and on a few geometries they
 * reach back over it: the tail of a bus on a right turn swings across the
 * front of the car standing at the line in the lane beside it. That car holds
 * no claim - it has not been admitted to anything - so the claim table cannot
 * see it; the index records exactly these cases as `queueIntrusions`. The bus
 * waits until the car has gone.
 */
function queuedBodyInZone(w: SimWorld, v: Vehicle, conn: Connector): boolean {
  const mine = bodyClassOfArchetype(v.archetype);
  for (const ref of w.conflicts.refs(conn.id)) {
    const point = w.conflicts.points[ref.point];
    const other = w.connector(ref.other);
    if (!point || !other) continue;
    const head = w.laneHead(other.fromLane);
    const lane = w.lanelet(other.fromLane);
    if (!head || !lane || head.id === v.id) continue;
    // An admitted head is protected by its own claim instead.
    if (head.admittedConnector) continue;
    // Only the movement the head is actually about to take.
    if (nextConnector(w, head)?.id !== other.id) continue;
    const z = point.zone(other.id, bodyClassOfArchetype(head.archetype), mine);
    if (!z) continue;
    const centre = head.s - lane.length - head.archetype.length / 2;
    if (centre >= z.enter) return true;
  }
  return false;
}

/**
 * Distance to stop at so the body stays outside a zone that reaches back over
 * the stop line while another movement holds it. Null when the stop line
 * itself is far enough.
 */
function stopShortOfIntrusion(w: SimWorld, v: Vehicle, conn: Connector, d: number): number | null {
  const mine = bodyClassOfArchetype(v.archetype);
  let stop: number | null = null;
  for (const ref of w.conflicts.refs(conn.id)) {
    const point = w.conflicts.points[ref.point];
    if (!point) continue;
    for (const claim of w.claims.holdersAt(ref.point)) {
      if (claim.vehicle === v.id || claim.connector === conn.id) continue;
      const holder = holderState(w, claim);
      if (!holder) continue;
      const z = point.zone(conn.id, mine, holder.cls);
      const theirs = point.zone(claim.connector, holder.cls, mine);
      if (!z || !theirs || holder.centre > theirs.exit) continue;
      const frontAtEntry = z.enter + v.archetype.length / 2;
      if (frontAtEntry >= 0) continue;
      const gap = Math.max(0, d + frontAtEntry);
      stop = stop === null ? gap : Math.min(stop, gap);
    }
  }
  return stop;
}

/**
 * A follower may share a same-path claim only at the stop line, after the
 * existing convoy has physically entered the connector. This keeps a real
 * car-following stream through green while never handing a far-back queue a
 * claim it could hold motionless for seconds.
 */
function convoyCanEnter(w: SimWorld, r: Request, conn: Connector): boolean {
  const points = w.conflicts.refs(conn.id).map((ref) => ref.point);
  if (!points.length) return true;
  const owners = new Map<number, Vehicle>();
  for (const point of points) {
    for (const claim of w.claims.holdersAt(point)) {
      // Holders on OTHER movements have already been judged by the claim
      // table, which lets a body through beside one it cannot touch. This gate
      // is only about the convoy on this very path.
      if (claim.vehicle === r.v.id || claim.connector !== conn.id) continue;
      const owner = w.veh(claim.vehicle);
      if (owner) owners.set(owner.id, owner);
    }
  }
  if (!owners.size) return true;

  // The gate is on MOTION, not on distance.
  //
  // A fixed distance window here was self-reinforcing, and it produced exactly
  // the stop-and-go discharge players report. A denial appends a stop at the
  // line, so a follower outside the window braked for a virtual wall; braking
  // is what kept it outside the window; and it was only admitted once it had
  // crawled to within a car length, at which point it accelerated again.
  // Traced on a five-car standing queue at a four-leg green: the follower rose
  // to 4.90 u/s at tick 90 and was decelerated back to 2.39 by tick 180, when
  // it finally passed the 7-unit window. One car at a time, with a stop between
  // each. Making the window scale with the follower's own speed does not help,
  // because the wall has already destroyed that speed.
  //
  // Distance is ALREADY bounded, one level up: `stepAdmission` only takes a
  // request from `max(REQUEST_MIN_DISTANCE, v * REQUEST_TIME)` back. A second,
  // ten-times-tighter distance gate here was never the safety property. The
  // property is the one the comment above states — never hand a claim to a
  // queue that will sit on it motionless — and that is exactly `v > CONVOY_ROLLING`.
  // A standing vehicle is still refused unless it is at the line itself, which
  // is how the head of a queue starts the convoy in the first place.
  const atLine = r.d <= Math.max(6, r.v.driver.s0 + 2);
  if (!atLine && r.v.v <= CONVOY_ROLLING) return false;
  return [...owners.values()].every((owner) => {
    const lane = w.lanelet(owner.lanelet);
    const clearing = owner.clearingConnectors.some((token) => token.connector === conn.id);
    return (lane?.id === conn.id || clearing) && owner.v > CONVOY_ROLLING;
  });
}

type ResourceKey = string;

interface BankerProcess {
  readonly allocation: Set<ResourceKey>;
  readonly maximum: Set<ResourceKey>;
}

/** Conflict points plus a connector token for zero-point movements. */
function connectorResources(
  w: SimWorld,
  connector: Connector,
): ResourceKey[] {
  const points = w.conflicts.refs(connector.id).map((ref) => `point:${ref.point}`);
  return points.length ? points : [`movement:${connector.id}`];
}

function actualAllocation(w: SimWorld, v: Vehicle): Set<ResourceKey> {
  const resources = new Set<ResourceKey>();
  for (const point of w.claims.points(v.id)) resources.add(`point:${point}`);

  const movements = new Set<string>();
  if (v.admittedConnector) movements.add(v.admittedConnector);
  for (const token of v.clearingConnectors) movements.add(token.connector);
  const lane = w.lanelet(v.lanelet);
  if (lane?.kind === 'connector') movements.add(lane.id);
  for (const connector of movements) {
    if (w.conflicts.refs(connector).length === 0) resources.add(`movement:${connector}`);
  }
  return resources;
}

/**
 * Banker's safety test over all live maximum claims.
 *
 * Future movement intents do not own resources. A current grant is allowed
 * only if the resulting state still has some completion order in which every
 * compound-box vehicle can obtain its remaining connector points and release
 * what it physically holds. This prevents circular hold-and-wait without the
 * throughput collapse caused by hard-locking several future junctions.
 */
function bankerSafeAfterGrant(
  w: SimWorld,
  applicant: Vehicle,
  proposal: readonly ConnectorReservation[],
): boolean {
  const processes: BankerProcess[] = [];
  const owners = new Map<ResourceKey, number>();
  const universe = new Set<ResourceKey>();

  for (const vehicle of w.vehicles.values()) {
    const allocation = actualAllocation(w, vehicle);
    const maximum = new Set(allocation);
    const intentions =
      vehicle.id === applicant.id
        ? proposal
        : vehicle.reservedConnectors
            .map((id) => w.connector(id))
            .filter((connector): connector is Connector => !!connector)
            .map((connector) => ({
              connector,
              points: w.conflicts.refs(connector.id).map((ref) => ref.point),
            }));

    if (vehicle.id === applicant.id) {
      const current = proposal[0];
      if (current) {
        for (const resource of connectorResources(w, current.connector)) {
          allocation.add(resource);
        }
      }
    }
    for (const intention of intentions) {
      for (const resource of connectorResources(w, intention.connector)) {
        maximum.add(resource);
      }
    }

    // A process that HOLDS NOTHING cannot be part of a deadlock.
    //
    // Deadlock needs hold-and-wait. A vehicle with no allocation is not
    // holding a resource anyone else could be waiting for, so the system can
    // always just decline to grant it anything and let everybody else finish.
    // Counting its future intent as a reason to refuse somebody else models a
    // state that cannot occur.
    //
    // This mattered because of where reservedConnectors comes from: the
    // reserveOnly branch publishes a maximum claim for every vehicle stopped
    // at a RED light, before any safety check runs. Measured on a signalised
    // crossroads, all eleven vehicles carried a reservation while the claims
    // table was completely empty, and 'conflict' was the single commonest
    // reason a car with a green light was refused. A queue of cars that cannot
    // legally move was making the junction look unsafe to the one car that
    // could.
    if (!allocation.size) continue;
    if (!maximum.size) continue;
    for (const resource of allocation) {
      const owner = owners.get(resource);
      if (owner !== undefined && owner !== vehicle.id && !sharedConvoyResource(w, resource)) return false;
      owners.set(resource, vehicle.id);
      universe.add(resource);
    }
    for (const resource of maximum) universe.add(resource);
    processes.push({ allocation, maximum });
  }

  const work = new Set<ResourceKey>();
  for (const resource of universe) {
    if (!owners.has(resource)) work.add(resource);
  }

  const unfinished = new Set(processes.map((_, index) => index));
  let progressed = true;
  while (unfinished.size && progressed) {
    progressed = false;
    for (const index of [...unfinished]) {
      const process = processes[index];
      if (!process) continue;
      let canFinish = true;
      for (const resource of process.maximum) {
        if (!process.allocation.has(resource) && !work.has(resource)) {
          canFinish = false;
          break;
        }
      }
      if (!canFinish) continue;
      for (const resource of process.allocation) work.add(resource);
      unfinished.delete(index);
      progressed = true;
    }
  }
  return unfinished.size === 0;
}

/**
 * A conflict resource may have several holders only while no two of them can
 * touch there: a convoy on one path, bodies too small to meet in that zone, or
 * one of them already out of it.
 */
function sharedConvoyResource(w: SimWorld, resource: ResourceKey): boolean {
  if (!resource.startsWith('point:')) return false;
  const id = Number(resource.slice('point:'.length));
  const point = w.conflicts.points[id];
  const claims = w.claims.holdersAt(id);
  if (!point || claims.length === 0) return false;
  const placed = claims.map((claim) => ({ connector: claim.connector, state: holderState(w, claim) }));
  for (let i = 0; i < placed.length; i++) {
    for (let j = i + 1; j < placed.length; j++) {
      const a = placed[i];
      const b = placed[j];
      if (!a || !b || a.connector === b.connector) continue;
      if (!a.state || !b.state) return false;
      if (!zoneShareable(point, { connector: a.connector, state: a.state },
        { connector: b.connector, state: b.state })) return false;
    }
  }
  return true;
}

/**
 * Where a claim holder's body is along the movement it holds.
 *
 * Granted but still on the approach: a negative centre, measured back from the
 * stop line. On the movement: its own arc position. Past the exit with the rear
 * still clearing: the connector length plus how far the front has gone beyond.
 */
export function holderState(w: SimWorld, claim: Claim): HolderState | null {
  const v = w.veh(claim.vehicle);
  const conn = w.connector(claim.connector);
  if (!v || !conn) return null;
  const cls = bodyClassOfArchetype(v.archetype);
  const half = v.archetype.length / 2;
  if (v.lanelet === conn.id) return { cls, centre: v.s - half };
  if (v.lanelet === conn.fromLane) {
    const lane = w.lanelet(conn.fromLane);
    return lane ? { cls, centre: v.s - lane.length - half } : null;
  }
  const token = v.clearingConnectors.find((t) => t.connector === conn.id);
  if (token) return { cls, centre: conn.length + token.distanceBeyondExit - half };
  return null;
}

/**
 * Right of way for one movement.
 *
 * Signals, priority roads, stop control and uncontrolled junctions are all the
 * same code path with a different verdict and a different gap predicate —
 * there is no separate branch for any of them.
 */
export function rightOfWay(
  w: SimWorld,
  node: NodeId,
  v: Vehicle,
  conn: Connector,
  distanceToStop: number,
): RowClass {
  const controller = w.controller(node);
  const junction = w.graph.junctions.get(node);

  const policy = w.doc.node(node)?.control ?? 'auto';

  if (controller && junction?.signalised) {
    const state = signalStateFor(controller, conn.group);
    if (
      mustStopAtSignal(
        state,
        conn.turn,
        v.rorCredit,
        v.driver,
        v.v,
        distanceToStop,
      )
    ) return 'none';

    // A movement is protected when the current stage gives green to nothing
    // that physically conflicts with it from another approach (`annotate` in
    // signals/plan.ts). Everything else green is permissive and finds a gap.
    const stage = controller.plan.stages[controller.stageIndex];
    return state !== 'red' && stage?.protectedMovements.includes(conn.id) ? 'signalGreen' : 'yield';
  }

  // `RowClass 'none'` means "no right of way, stop" — it is what a red signal
  // yields, and `evaluate` answers it with a reserve-only verdict that never
  // grants the connector. The authoring policy spelled `none` means the
  // OPPOSITE: there is no control device at this node. Returning the RowClass
  // for it wedged every "Uncontrolled" junction permanently, because
  // `shouldSignalise` is also false for it, so nothing else could admit.
  //
  // Mapping it to `yield` instead was the other half of the same defect. At a
  // node where EVERY approach yields, every approach is waiting for a gap in
  // traffic that is itself waiting: measured on a four-leg uncontrolled cross,
  // four of nine vehicles stopped, the leader carrying `yield` for ever and
  // three queued behind it. Nothing in `audit()` saw it either, because
  // `greenBlocked` only watches signals and there was no signal.
  //
  // A real uncontrolled junction is not symmetric: the larger road has priority
  // and the smaller one gives way. So `none` falls through to the same class
  // ranking `auto` uses, which is what breaks the tie and keeps the node alive.
  if (policy === 'stop') return 'stop';
  if (policy === 'yield') return 'yield';

  // Unsignalised: the road the junction is ON goes first, everything joining
  // it gives way.
  //
  // That road is the pair of legs a straight-on movement links whose LESSER
  // class is the highest, not "every leg of the highest class". The old rule
  // required both of a movement's roads to match the node's biggest road, so
  // where a street simply continues as a bigger road - an urban street
  // widening into a boulevard, a two-leg node - no movement qualified and
  // both directions gave way to each other. Traffic crawled through such a
  // join on gaps in the opposite stream, and queued back along the street.
  if (junction && conn.inSegment !== conn.outSegment && continues(w, node, conn)) {
    if (throughRank(w, conn) >= mainRoadRank(w, junction)) return 'priority';
  }
  return 'yield';
}

/** The lesser class of the two roads a movement links. */
function throughRank(w: SimWorld, conn: Connector): number {
  return Math.min(w.doc.segment(conn.inSegment)?.type ?? 0, w.doc.segment(conn.outSegment)?.type ?? 0);
}

/**
 * Whether a movement carries its road on through the node: a straight-on
 * movement, or any movement at a node of two legs, which is one road going
 * on however sharply it bends there.
 */
function continues(w: SimWorld, node: NodeId, conn: Connector): boolean {
  return conn.turn === 'through' || (w.doc.node(node)?.incident.length ?? 0) === 2;
}

/** Rank of the road a junction is on, per topology build. */
const mainRoads = new WeakMap<JunctionTopology, number>();

function mainRoadRank(w: SimWorld, junction: JunctionTopology): number {
  let rank = mainRoads.get(junction);
  if (rank !== undefined) return rank;
  rank = -Infinity;
  for (const id of junction.connectors) {
    const conn = w.connector(id);
    if (!conn || conn.inSegment === conn.outSegment || !continues(w, junction.node, conn)) continue;
    rank = Math.max(rank, throughRank(w, conn));
  }
  mainRoads.set(junction, rank);
  return rank;
}

/**
 * Gap acceptance against the movements this one yields to.
 *
 * Impatience shortens the required gap the longer a driver waits, which is what
 * keeps a minor road alive against a busy major one — but it is bounded and
 * floored, so it can never fall below a physically safe gap.
 */
export function hasAcceptableGap(w: SimWorld, r: Request): boolean {
  const need = clearTime(w, r);
  const impatience = Math.min(IMPATIENCE_MAX, IMPATIENCE_RATE * r.v.waited);
  // The critical gap is the driver's, not the movement's. Two cars waiting to
  // turn out of the same side street used to pull out at exactly the same
  // offered gap, which is the single most visible way a junction reads as a
  // machine; `gapFactor` is derived from the same aggression that decides how
  // hard they accelerate once they are in it, so the bold one goes first and
  // goes harder.
  const critical = Math.max(
    CRITICAL_GAP_FLOOR,
    CRITICAL_GAP[r.conn.turn] * r.v.driver.gapFactor - impatience,
  );

  const mine = bodyClassOfArchetype(r.v.archetype);
  for (const ref of w.conflicts.refs(r.conn.id)) {
    const other = w.connector(ref.other);
    if (!other) continue;
    // A movement from the same approach is not a stream this one gives way
    // to: the two leave side by side, and whether their bodies can touch is
    // the claim table's question, not a gap to wait for. Counting it made a
    // right turn wait for a gap in the lane BESIDE it, because a bus in that
    // pair of lanes can swing across both.
    if (other.inSegment === r.conn.inSegment) continue;
    if (!movementIsActive(w, other)) continue;

    // Anything approaching on the conflicting movement's origin lane.
    const approach = w.laneHead(other.fromLane);
    if (!approach) continue;
    // A lane may fan out into several connectors. Its head only blocks this
    // turn when it is actually taking the conflicting path; treating every
    // possible turn as live is a false yield and can even make a vehicle yield
    // to itself on compact geometry.
    if (approach.id === r.v.id || nextConnector(w, approach)?.id !== other.id) continue;
    // Only a body that can actually reach this one is a reason to wait.
    if (!w.conflicts.points[ref.point]?.zone(r.conn.id, mine, bodyClassOfArchetype(approach.archetype))) {
      continue;
    }
    const lane = w.lanelet(other.fromLane);
    if (!lane) continue;

    // A vehicle sitting still at its own stop line is not arriving, and
    // treating it as an oncoming threat is how two waiting drivers block each
    // other forever. Whoever is actually admitted first is decided by the claim
    // table and the priority order, not here.
    //
    // EXCEPT a protected movement at its own green. It is standing only
    // because the light has just changed, and it goes first by right: letting
    // the permissive left read the stationary queue as "no traffic" put lefts
    // into the box at every green onset and held the protected through behind
    // them — measured, the commonest conflict stall at green on a four-way.
    if (approach.v < 0.5 && !approach.admittedConnector && !protectedNow(w, other)) continue;

    const distance = lane.length - approach.s;
    const arrival = distance / Math.max(approach.v, 0.5);
    if (arrival < need + critical) return false;
  }
  return true;
}

/**
 * Seconds for the FRONT to reach the point where the body has left the last
 * conflict zone of this movement.
 */
function clearTime(w: SimWorld, r: Request): number {
  const refs = w.conflicts.refs(r.conn.id);
  const cls = bodyClassOfArchetype(r.v.archetype);
  let exit = -Infinity;
  for (const ref of refs) exit = Math.max(exit, ref.exit[cls] ?? -Infinity);
  const last = Number.isFinite(exit)
    ? Math.max(0, exit + r.v.archetype.length / 2)
    : r.conn.length;
  const lanelet = w.lanelet(r.conn.lanelet);
  const speed = Math.max(2, Math.min(r.v.v0, lanelet?.speedLimit ?? r.v.v0) * 0.6);
  return (r.d + last) / speed;
}

/** True when this movement is green and protected in the current stage. */
function protectedNow(w: SimWorld, conn: Connector): boolean {
  const controller = w.controller(conn.node);
  if (!controller || !w.graph.junctions.get(conn.node)?.signalised) return false;
  if (signalStateFor(controller, conn.group) !== 'green') return false;
  return controller.plan.stages[controller.stageIndex]?.protectedMovements.includes(conn.id) ?? false;
}

/** True when the other movement currently has permission to run. */
function movementIsActive(w: SimWorld, other: Connector): boolean {
  const controller = w.controller(other.node);
  const junction = w.graph.junctions.get(other.node);
  if (!controller || !junction?.signalised) return true;
  return signalStateFor(controller, other.group) !== 'red';
}

/**
 * True when a pedestrian is on, or about to step onto, the stretch of a zebra
 * this movement drives over (`CrossingSpans`). Somebody on the far half of the
 * crossing, or who has already passed the vehicle's path, is no reason to wait.
 */
export function crossingBusy(w: SimWorld, conn: Connector): boolean {
  for (const segment of [conn.inSegment, conn.outSegment]) {
    if (pedestrianInSpan(w, conn.id, `${conn.node}:${segment}`)) return true;
  }
  return false;
}

/**
 * Whether somebody waiting at a kerb has the right to cross in front of this
 * movement before it is admitted: at an uncontrolled zebra always, at a signal
 * while their own lamp shows WALK.
 *
 * Pedestrians may only step off when no admitted vehicle uses that leg, and
 * vehicles used to yield only to somebody already ON the crossing. With a
 * steady stream of turning traffic in the same stage the two rules never let
 * anyone go first: people stood at a WALK signal for three minutes while the
 * turns kept flowing. A driver who can still stop comfortably now gives way.
 */
function pedestrianHasPriority(w: SimWorld, r: Request): boolean {
  if (!canStopComfortably(r.v.driver, r.v.v, r.d)) return false;
  const controller = w.controller(r.conn.node);
  const signalised = !!controller && !!w.graph.junctions.get(r.conn.node)?.signalised;
  for (const segment of [r.conn.inSegment, r.conn.outSegment]) {
    const id = `${r.conn.node}:${segment}`;
    const waiting = w.pedWaiting.get(id);
    if (!waiting) continue;
    const edge = w.sidewalks.edges.get(w.sidewalks.crossings.get(id) ?? '');
    const span = w.crossingSpans.span(r.conn.id, id);
    if (span === null) continue;
    // Only people who would reach the vehicle's path soon after stepping off:
    // somebody at the far kerb of a wide crossing lets the turn go first.
    if (!signalised || !controller) {
      // Uncontrolled zebra: give way to those who would soon be in the path;
      // somebody at the far kerb of a wide crossing lets the turn go first.
      if (edge && span) {
        const reach = PED_MIN_PACE * PED_REACH_TIME;
        const near = (waiting.from > 0 && span.s0 < reach) || (waiting.to > 0 && edge.length - span.s1 < reach);
        if (!near) continue;
      }
      return true;
    }
    if (edge && pedestrianSignalState(controller, id, edge.length) === 'walk') return true;
  }
  return false;
}

/** The connector this vehicle intends to take at the end of its lane. */
export function nextConnector(w: SimWorld, v: Vehicle): Connector | undefined {
  const next = v.route[1];
  if (next) {
    const c = w.connector(next);
    if (c && c.fromLane === v.lanelet) return c;
  }
  return undefined;
}
