import type { LaneletId } from '@world/lanelets';
import type { SimWorld } from '../world';
import type { Vehicle } from '../vehicles/state';

/** How far ahead a route is planned, in lanelet hops. */
const HORIZON = 24;
/** Bounded network lookahead used when comparing alternate turns. */
const LOOKAHEAD = 5;

/**
 * Route planning over the lanelet graph.
 *
 * Routes are stored as a LANELET sequence that already contains the connectors,
 * so lookahead across a junction needs no special case anywhere else in the
 * engine.
 *
 * The hard invariant this module upholds: a vehicle ALWAYS has a route with at
 * least one lanelet. When planning fails it falls back to any legal exit, and
 * only when there is genuinely nowhere to go does the vehicle stop and despawn.
 * That is what removes the V6 monolith's silent freeze, where a stale next-edge
 * key left a vehicle pinned on a green with no recovery path (defect 2.1).
 */
export function planFrom(w: SimWorld, v: Vehicle): LaneletId | null {
  const own = w.graph.exitsOf(v.lanelet);

  // Lane discipline makes each turn legal from exactly one lane, so the choice
  // of MOVEMENT has to be made over the whole carriageway and the choice of
  // LANE has to follow it. Planning only over this lane's own exits would make
  // a right turn permanently invisible to anyone in an inner lane.
  //
  // This is the ONLY place a lane-change desire is born. A vehicle whose route
  // is already settled never acquires one, so nothing re-decides underneath a
  // driver who has a plan — that oscillation is what makes discretionary lane
  // changing unshippable.
  const siblings = w.graph.siblingLanes(v.lanelet);
  const union = siblings.length
    ? [...own, ...siblings.flatMap((id: LaneletId) => w.graph.exitsOf(id))]
    : own;

  const existingIntent = v.movementIntent ? w.connector(v.movementIntent) : undefined;
  const wanted = existingIntent &&
      (existingIntent.fromLane === v.lanelet || siblings.includes(existingIntent.fromLane))
    ? existingIntent.id
    : union.length ? chooseExit(w, union, new Set([v.lanelet])) : null;
  const wantedConnector = wanted === null ? null : w.connector(wanted);
  v.movementIntent = wantedConnector?.id ?? null;
  if (wantedConnector && wantedConnector.fromLane !== v.lanelet) {
    v.desiredLane = wantedConnector.fromLane;
  } else {
    v.desiredLane = null;
  }

  // The route itself always starts where the vehicle actually IS. If the lane
  // change lands, `planFrom` runs again from the new lane and picks the wanted
  // movement then; if it never lands, this fallback is what the vehicle drives.
  if (!own.length) return null;
  const best = wantedConnector?.fromLane === v.lanelet
    ? wantedConnector.id : chooseExit(w, own, new Set([v.lanelet]));
  if (!best) return null;

  const conn = w.connector(best);
  if (!conn) return null;

  v.route = [v.lanelet, best, conn.toLane];
  extend(w, v);
  return best;
}

/** Grows a route forward until it reaches the horizon or a dead end. */
export function extend(w: SimWorld, v: Vehicle): void {
  let guard = 0;
  while (v.route.length < HORIZON && guard++ < HORIZON) {
    const tail = v.route[v.route.length - 1];
    if (tail === undefined) break;
    const lane = w.lanelet(tail);
    if (!lane || lane.kind !== 'link') break;

    const exits = w.graph.exitsOf(tail);
    if (!exits.length) break;

    const pick = chooseExit(w, exits);
    if (!pick) break;
    const conn = w.connector(pick);
    if (!conn) break;

    // Do not loop straight back into a lanelet already on the route.
    if (v.route.includes(conn.toLane)) break;

    v.route.push(pick, conn.toLane);
  }
}

/**
 * Cost of the best route leaving this lane, or Infinity when it has none.
 *
 * Lane changing compares neighbouring lanes with it. It deliberately reuses the
 * SAME cost function the router chooses with, so a vehicle never moves across
 * to a lane the router would then refuse to use.
 */
export function bestOnwardCost(w: SimWorld, laneId: LaneletId): number {
  let best = Infinity;
  for (const cid of w.graph.exitsOf(laneId)) {
    const connector = w.connector(cid);
    if (!connector) continue;
    if (w.rt(connector.toLane).ghost) continue;
    best = Math.min(best, routeCost(w, cid, new Set([laneId]), LOOKAHEAD));
  }
  return best;
}

function chooseExit(
  w: SimWorld,
  exits: readonly string[],
  visited = new Set<LaneletId>(),
): string | null {
  const scored: { id: string; cost: number }[] = [];

  for (const cid of exits) {
    const conn = w.connector(cid);
    if (!conn) continue;
    const out = w.lanelet(conn.toLane);
    if (!out || w.rt(conn.toLane).ghost || visited.has(out.id)) continue;
    const cost = routeCost(w, cid, visited, LOOKAHEAD);
    if (Number.isFinite(cost)) scored.push({ id: cid, cost });
  }

  if (!scored.length) return null;
  scored.sort((a, b) => a.cost - b.cost || (a.id < b.id ? -1 : 1));

  // Spread the fleet only across genuinely comparable exits. Choosing the
  // third-ranked route unconditionally used to send vehicles into a clearly
  // saturated street even when an open alternative was already visible.
  const bestCost = scored[0]!.cost;
  const tolerance = Math.max(0.5, bestCost * 0.18);
  const comparable = scored
    .filter((candidate) => candidate.cost <= bestCost + tolerance)
    .slice(0, 3);
  const pick = comparable[Math.floor(w.rng.route.float() * comparable.length)] ?? comparable[0];
  return pick ? pick.id : null;
}

/**
 * A small bounded search gives every decision a view beyond its immediate
 * downstream lane.  It is deliberately not a global pathfinder: vehicles have
 * no fixed destination, and doing a full graph search for every spawn would
 * make large sandboxes slower precisely when they are busy.  Five hops is
 * enough to see a blocked block or a faster parallel avenue.
 */
function routeCost(
  w: SimWorld,
  connectorId: LaneletId,
  visited: ReadonlySet<LaneletId>,
  remaining: number,
): number {
  const connector = w.connector(connectorId);
  if (!connector) return Infinity;
  const out = w.lanelet(connector.toLane);
  if (!out || out.kind !== 'link' || visited.has(out.id) || w.rt(out.id).ghost) return Infinity;

  const runtime = w.rt(out.id);
  const density = runtime.order.length / Math.max(1, out.length / 12);
  const travel = out.length / Math.max(0.5, out.speedLimit);
  const connectorTravel = connector.length / Math.max(0.5, out.speedLimit * 0.65);
  const turnPenalty = connector.turn === 'uturn' ? 4 : connector.turn === 'through' ? 0 : 0.35;
  const here = connectorTravel + travel * (1 + density * 2.6) + turnPenalty;
  if (remaining <= 1) return here;

  const nextVisited = new Set(visited);
  nextVisited.add(out.id);
  const next = w.graph.exitsOf(out.id);
  if (!next.length) return here;

  let continuation = Infinity;
  for (const nextConnector of next) {
    continuation = Math.min(
      continuation,
      routeCost(w, nextConnector, nextVisited, remaining - 1),
    );
  }
  // Keep the immediate choice meaningful even when a far-away branch is a
  // marginally better fit; local congestion and speed still dominate.
  return here + (Number.isFinite(continuation) ? continuation * 0.72 : 0);
}

/**
 * Lets a driver who has been held up look for another way round.
 *
 * The router already prices congestion — `routeCost` weighs a lane's occupancy
 * — but it only ever asked the question at a junction, when the route ran short.
 * A driver who joins the back of a queue two hundred units before the junction
 * has already committed, and will sit there however long it takes, because
 * nothing re-asks. That is what makes a jam look like a parked queue rather
 * than like traffic: real drivers reconsider.
 *
 * So a vehicle that has been crawling for longer than its own patience re-plans
 * from where it is, against the densities as they are NOW. `heldUp` is reset
 * whether or not the answer changes, which is the cooldown: without it a
 * vehicle at the front of a jam re-plans every tick and the fleet's routing
 * cost becomes proportional to how stuck it is.
 *
 * It cannot cause a vehicle to turn round or to abandon a movement it has been
 * admitted to — both are refused below — so the worst it can do is pick the
 * same exit again.
 */
export function reconsiderRoute(w: SimWorld, v: Vehicle): void {
  if (v.heldUp < v.driver.patience) return;
  v.heldUp = 0;

  // A granted movement is a transaction in progress; a rear still inside a
  // junction is the same. Neither may be re-planned out from under.
  if (v.admittedConnector || v.clearingConnectors.length > 0) return;
  const lane = w.lanelet(v.lanelet);
  if (!lane || lane.kind !== 'link') return;
  // Too late to change anything: the movement is about to be requested.
  if (lane.length - v.s < v.archetype.length + v.driver.s0) return;

  v.movementIntent = null;
  planFrom(w, v);
}

/** Repairs a route whose lanelets no longer exist, after a live edit. */
export function repairRoute(w: SimWorld, v: Vehicle): void {
  const current = w.lanelet(v.lanelet);
  if (!current) {
    v.route = [v.lanelet];
    return;
  }

  // A connector has exactly one legal continuation.  Reconstruct it directly
  // instead of asking `exitsOf`, which is intentionally defined only for link
  // lanelets.
  if (current.kind === 'connector') {
    const connector = w.connector(current.id);
    const to = connector ? w.lanelet(connector.toLane) : undefined;
    v.route = to ? [current.id, to.id] : [current.id];
    extend(w, v);
    return;
  }

  const valid: LaneletId[] = [];
  let previous: LaneletId | undefined;
  for (const id of v.route) {
    const lane = w.lanelet(id);
    if (!lane) break;
    if (previous !== undefined && !isLegalTransition(w, previous, id)) break;
    valid.push(id);
    previous = id;
  }

  if (!valid.length || valid[0] !== v.lanelet) {
    v.route = [v.lanelet];
    planFrom(w, v);
    return;
  }

  v.route = valid;
  // A bare link route is valid data but not a usable junction intention.
  // Plan immediately so admission never has to invent an arbitrary exit.
  if (v.route.length < 2) {
    planFrom(w, v);
    return;
  }
  extend(w, v);
}

function isLegalTransition(w: SimWorld, fromId: LaneletId, toId: LaneletId): boolean {
  const from = w.lanelet(fromId);
  const to = w.lanelet(toId);
  if (!from || !to) return false;
  if (from.kind === 'link') {
    const connector = w.connector(toId);
    return !!connector && connector.fromLane === fromId;
  }
  const connector = w.connector(fromId);
  return !!connector && connector.toLane === toId;
}
