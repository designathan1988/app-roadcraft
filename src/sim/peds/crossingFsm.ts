import { DIV_EPS, clamp, lerp } from '@core/scalar';
import { dist } from '@core/vec2';
import { DT, PED } from '../params';
import { m } from '@world/units';
import type { SimWorld } from '../world';
import type { Ped } from './state';
import type { SidewalkEdge, SidewalkEdgeId, SidewalkNode } from './sidewalk';
import {
  PED_BEHAVIOUR,
  edgePreference,
  goalPick,
  preferredLateral,
  strollFactor,
} from './behaviour';
import { pedestrianSignalState, remainingProtectedTime } from '../signals/query';
import { makeCrossingId } from '../signals/plan';
import { PedestrianClearance, STUCK_RELEASE } from './clearance';
import { canStopComfortably } from '../vehicles/idm';
import { nextTowardGoal } from './route';
import {
  activityAnchor,
  arrivalActivity,
  considerActivity,
  endActivity,
  holdFacing,
  stepActivity,
} from './activities';

const SPACES = new WeakMap<SimWorld, PedestrianClearance>();

/**
 * The pedestrian crossing state machine.
 *
 * `s` is monotone non-decreasing, exactly as for vehicles. There is deliberately
 * NO anti-stall force-forward here. The V6 monolith needed one because its
 * pedestrians parked inside the carriageway and had to be shoved out, and its
 * shove had a unit bug that teleported them across the road in 0.4 seconds
 * (defects 4.1 and 4.7). With the waiting position defined as a kerb node
 * outside the carriageway, there is nothing to shove.
 *
 * The state machine decides where somebody may be. `behaviour.ts` decides what
 * they look like getting there — pace, lateral position, who they are with and
 * where they are going — and none of it is reachable from `mayEnterCrossing`
 * or from gap acceptance, so no amount of character can put anybody in front
 * of a car.
 */
export function stepPedestrians(w: SimWorld): void {
  const peds = w.pedsInIdOrder();
  w.sidewalks.occupancy.rebuild(w.sidewalks, peds);
  let space = SPACES.get(w);
  if (!space) { space = new PedestrianClearance(); SPACES.set(w, space); }
  space.begin(w);
  const remove: Ped[] = [];
  // Where each party that has stopped to talk is standing, so its members can
  // turn to face one another rather than the way they happened to arrive.
  TALK.clear();
  for (const p of peds) {
    if (p.activity?.kind !== 'talk') continue;
    const at = TALK.get(p.party.id) ?? { x: 0, y: 0, n: 0 };
    at.x += p.x; at.y += p.y; at.n++;
    TALK.set(p.party.id, at);
  }

  for (const p of peds) {
    p.age += DT;
    const edge = w.sidewalks.edges.get(p.edge);
    if (!edge) {
      releaseCrossing(w, p);
      remove.push(p);
      continue;
    }

    planAhead(w, p, edge);
    scanNeighbours(w, p, edge);
    const cap = stepActivity(w, p, edge, stopWithin);
    const free = desiredSpeed(w, p, edge);
    const desired = cap === null ? free : Math.min(free, cap);
    steer(w, p, edge, desired, space);

    switch (p.state) {
      case 'Walking':
        walk(w, p, edge, desired, space);
        break;

      case 'ApproachKerb':
        p.v = 0;
        p.waited = 0;
        p.state = 'WaitAtKerb';
        break;

      case 'WaitAtKerb': {
        p.v = 0;
        const boxedBefore = p.stuck;
        p.waited += DT;
        const nextId = p.route[0];
        const next = nextId ? w.sidewalks.edges.get(nextId) : undefined;
        if (!next) {
          // Nothing planned: pick any onward edge rather than stand forever.
          if (!repath(w, p, space)) remove.push(p);
          break;
        }
        if (next.kind !== 'crossing') {
          if (enterEdge(w, p, next, space)) p.state = 'Walking';
          break;
        }
        if (mayEnterCrossing(w, p, next)) {
          if (enterEdge(w, p, next, space)) {
            p.state = 'Crossing';
            occupyCrossing(w, p, next);
          } else {
            // Permitted but boxed in at the kerb: that is being stuck, and it
            // earns the same release as a jam on the footway — unless what
            // holds the kerb is people still coming off the crossing, whom a
            // waiter lets out of the road first. That is giving way, not being
            // stuck, and squeezing through them is the one thing not to do.
            if (!space.jammedNear(w, p, MAKE_ROOM_RANGE)) p.stuck += DT;
          }
        }
        if (p.stuck === boxedBefore) p.stuck = Math.max(0, p.stuck - 2 * DT);
        break;
      }

      case 'Crossing': {
        const want = followSpeed(Math.min(PED.maxSpeed, desired * crossingUrgency(w, p, edge)));
        p.v = eased(p.v, Math.min(want, approachSpeed(w, p, edge, space, want)));
        const before = p.s;
        p.s = space.safeStep(w, p, edge, Math.min(edge.length, p.s + p.v * DT));
        p.v = (p.s - before) / DT;
        if (p.v * DT > 0.01) p.lastMovedTick = w.clock.tick;
        if (p.s >= edge.length) {
          if (!advance(w, p, edge, space)) remove.push(p);
          else if (p.edge !== edge.id) {
            releaseCrossing(w, p);
            p.state = 'Clearing';
          } else if (p.state !== 'Crossing') {
            // Turned back at the far kerb onto the same zebra: the edge id
            // did not change, but this crossing is over and the next has to
            // be asked for. The claim used to survive the turn and leave with
            // the walker, and a turning car yielded to that phantom for good.
            releaseCrossing(w, p);
          }
        }
        break;
      }

      case 'Clearing':
        p.state = 'Walking';
        break;
    }

    // A blocked transfer can leave the body at the end of a zebra. Keep its
    // crossing state and claim until it reaches the next edge, even when a
    // route decision above has requested the next crossing.
    const current = w.sidewalks.edges.get(p.edge);
    if (current?.kind === 'crossing' && p.s > 0 && p.state !== 'Crossing') {
      p.state = 'Crossing';
      occupyCrossing(w, p, current);
    }

    // The edge may have changed inside the switch, and steering belongs to
    // the edge the pedestrian is on when the tick ends: applying the old
    // edge's width to the new edge is how somebody ends up off the footway
    // for a frame after a turn.
    const settled = w.sidewalks.edges.get(p.edge);
    if (settled && settled !== edge) {
      const usable = Math.max(0, settled.halfWidth - PED_BEHAVIOUR.lateralMargin);
      p.lat = clamp(p.lat, -usable, usable);
    }
    settlePose(w, p, false, space);
    if (settled?.kind === 'walk' && !p.activity) considerActivity(w, p, settled);
    const wantsToMove = p.state !== 'WaitAtKerb' && desired > 0.05;
    // Held-up time; a released walker keeps its release until it has
    // actually got clear, about a metre of travel at walking pace.
    // Standing in the queue for one's own crossing is waiting, not being
    // stuck: counting it released queuers straight through the person ahead.
    const queued = NEAR.blockerQueue && NEAR.blockerGap < PED.jamGap + desired * PED.headway;
    if (p.state === 'WaitAtKerb') {
      // Accumulated in the kerb case itself, only while permitted and boxed in.
    } else if (wantsToMove && p.v < 0.05 && !queued) p.stuck += DT;
    else if (p.stuck >= STUCK_RELEASE) p.stuck = Math.max(0, p.stuck - DT * p.v / 2.5 * 3);
    else p.stuck = Math.max(0, p.stuck - 2 * DT);
    space.update(w, p);
  }

  // Who is waiting for which crossing, for admission's right-of-way check.
  w.pedWaiting.clear();
  for (const p of peds) {
    if (p.state !== 'WaitAtKerb') continue;
    const next = p.route[0] ? w.sidewalks.edges.get(p.route[0]) : undefined;
    if (!next?.crossing) continue;
    const here = w.sidewalks.edges.get(p.edge);
    const kerb = here ? w.sidewalks.other(here, p.entry) : undefined;
    const count = w.pedWaiting.get(next.crossing) ?? { from: 0, to: 0 };
    if (kerb === next.from) count.from++;
    else count.to++;
    w.pedWaiting.set(next.crossing, count);
  }

  for (const p of remove) {
    releaseCrossing(w, p);
    endActivity(w, p);
    w.peds.delete(p.id);
  }
}

function walk(w: SimWorld, p: Ped, edge: SidewalkEdge, desired: number, space: PedestrianClearance): void {
  const command = followSpeed(desired, p.stuck >= STUCK_RELEASE);
  p.v = eased(p.v, Math.min(command, approachSpeed(w, p, edge, space, command)));
  const before = p.s;
  p.s = space.safeStep(w, p, edge, p.s + p.v * DT);
  p.v = (p.s - before) / DT;
  if (p.v * DT > 0.01) p.lastMovedTick = w.clock.tick;

  if (p.s < edge.length) return;

  const nextId = p.route[0];
  const next = nextId ? w.sidewalks.edges.get(nextId) : undefined;

  if (next?.kind === 'crossing' && edge.kind !== 'crossing') {
    // Stop at the kerb. The kerb is a graph node offset outside the
    // carriageway, so this position is never in the road.
    p.s = edge.length;
    p.state = 'ApproachKerb';
    return;
  }

  if (!advance(w, p, edge, space)) {
    if (!repath(w, p, space)) {
      p.s = edge.length;
      p.v = 0;
    }
  }
}

/** Moves onto the next routed edge, carrying the overshoot. */
function advance(w: SimWorld, p: Ped, edge: SidewalkEdge, space: PedestrianClearance): boolean {
  const carried = Math.max(0, p.s - edge.length);
  const exit = w.sidewalks.other(edge, p.entry);
  const nextId = p.route[0];
  const next = nextId ? w.sidewalks.edges.get(nextId) : undefined;

  if (!next) return repath(w, p, space);

  if (!transfer(w, p, edge, next, exit, space)) return true;
  p.route.shift();
  p.s = Math.min(carried, next.length);

  // A crossing is never entered directly. Even arriving from another crossing
  // — the second half of a staged crossing — the pedestrian stops at the kerb
  // and asks permission, because "may I start" is the only rule that keeps
  // anyone from being caught in the road.
  if (next.kind === 'crossing') {
    p.s = 0;
    p.state = 'WaitAtKerb';
    p.waited = 0;
  } else {
    p.state = 'Walking';
  }
  return true;
}

function enterEdge(w: SimWorld, p: Ped, next: SidewalkEdge, space: PedestrianClearance): boolean {
  const current = w.sidewalks.edges.get(p.edge);
  if (!current) return false;
  const exit = w.sidewalks.other(current, p.entry);
  if (!transfer(w, p, current, next, exit, space)) return false;
  p.s = 0;
  p.route.shift();
  return true;
}

function transfer(w: SimWorld, p: Ped, current: SidewalkEdge, next: SidewalkEdge,
  exit: string, space: PedestrianClearance): boolean {
  const before = space.point(w, current, p.entry, current.length, p.lat);
  const frame = w.sidewalks.orientedPath(next, exit).sampleAt(0);
  const width = Math.max(0, next.halfWidth - PED_BEHAVIOUR.lateralMargin);
  const lat = clamp((before.x - frame.p.x) * frame.n.x + (before.y - frame.p.y) * frame.n.y, -width, width);
  if (!space.canEnter(w, p, next, exit, lat)) {
    // Hold at the end of the edge. Stepping back to the previous position
    // made a blocked walker bounce between two points every tick, which is
    // the twitching "frozen" figure players saw at busy corners.
    p.s = current.length;
    p.v = 0;
    return false;
  }
  p.entry = exit;
  p.edge = next.id;
  p.lat = lat;
  return true;
}

/**
 * Picks the onward edge that gets closest to where this pedestrian is going.
 *
 * A pedestrian always has somewhere to go; none of them ever freeze. What has
 * changed is that "somewhere" is now a place rather than a coin toss. A
 * uniform draw over the adjacent edges is a random walk, and a crowd of random
 * walks has no direction at any scale: people drift back and forth past the
 * same corner and the street reads as Brownian motion rather than as a city.
 *
 * A* chooses the next edge on a connected route to the destination. The small
 * per-party preference spreads routes without overruling the route length.
 * Crossing cost prevents unnecessary road crossings.
 */
function repath(w: SimWorld, p: Ped, space: PedestrianClearance): boolean {
  const edge = w.sidewalks.edges.get(p.edge);
  if (!edge) return false;
  const at = w.sidewalks.other(edge, p.entry);
  const next = pickNext(w, p);
  if (!next) return false;

  // A crossing is a requested *next* edge until permission is granted.  The
  // old code installed it as both current edge and route[0], so after crossing
  // it tried to enter the same edge again and could reverse or freeze.
  if (next.kind === 'crossing') {
    p.s = edge.length;
    p.route = [next.id];
    // A person still on the previous crossing keeps its crossing state and
    // occupancy claim until the transfer reaches the next kerb at s=0.
    if (edge.kind !== 'crossing') {
      p.state = 'WaitAtKerb';
      p.waited = 0;
    }
    return true;
  }

  p.route = [];
  if (!transfer(w, p, edge, next, at, space)) {
    p.route = [next.id];
    return true;
  }
  p.s = 0;
  p.state = 'Walking';
  return true;
}

/**
 * How far before the end of an edge a walker decides where it goes next.
 *
 * The choice used to be made on arrival. Until then nobody knew whether a
 * walker was queueing for the crossing ahead or only turning the corner, so a
 * walker bound round the corner stood in the crossing queue through a whole
 * red light — measured at over two minutes on the saved player map.
 */
const PLAN_AHEAD = m(6);

/** Picks the next edge in advance, once, when the end of the edge is near. */
function planAhead(w: SimWorld, p: Ped, edge: SidewalkEdge): void {
  if (p.state !== 'Walking' || p.route.length || edge.length - p.s > PLAN_AHEAD) return;
  const next = pickNext(w, p);
  if (next) p.route = [next.id];
}

/** The onward edge that gets closest to where this pedestrian is going. */
function pickNext(w: SimWorld, p: Ped): SidewalkEdge | undefined {
  const edge = w.sidewalks.edges.get(p.edge);
  if (!edge) return undefined;
  const at = w.sidewalks.other(edge, p.entry);
  const goal = chooseGoal(w, p, w.sidewalks.nodes.get(at));

  let best: SidewalkEdgeId | undefined = goal
    ? nextTowardGoal(w.sidewalks, at, goal.id, edge.id, p.party.id)
    : undefined;
  let bestScore = Infinity;
  let fallback: SidewalkEdgeId | undefined;

  for (const id of w.sidewalks.edgesAt(at)) {
    if (fallback === undefined || id < fallback) fallback = id;
    if (best !== undefined) continue;
    if (id === p.edge) continue;
    const candidate = w.sidewalks.edges.get(id);
    if (!candidate) continue;
    const far = w.sidewalks.nodes.get(w.sidewalks.other(candidate, at));

    let score = goal && far ? dist(far.at, goal.at) : 0;
    if (candidate.kind === 'crossing') score += PED_BEHAVIOUR.crossingPenalty;
    score += edgePreference(p.party.id, id);
    if (score < bestScore) {
      bestScore = score;
      best = id;
    }
  }

  // A dead end — a stub with one footway — is turned round on rather than
  // stood on. Without the fallback the only edge available is the one just
  // walked, which the loop above excludes by design.
  const pick = best ?? fallback;
  return pick === undefined ? undefined : w.sidewalks.edges.get(pick);
}

/**
 * The node this pedestrian is walking towards, re-chosen on arrival.
 *
 * Keyed on the party rather than the pedestrian, so everybody walking together
 * wants the same thing and makes the same turns without any member having to
 * look at another. The arrival radius matters as much as the destination: a
 * kerb node on the far side of a road the party has no reason to cross would
 * otherwise hold them circling it forever.
 */
function chooseGoal(w: SimWorld, p: Ped, here: SidewalkNode | undefined): SidewalkNode | undefined {
  const pool = w.sidewalks.goalNodes;
  if (!pool.length) return undefined;

  let goal = p.goal === null ? undefined : w.sidewalks.nodes.get(p.goal);
  const arrived =
    !!goal && !!here && (goal.id === here.id || dist(goal.at, here.at) < PED_BEHAVIOUR.arriveRadius);
  if (arrived) {
    p.trip++;
    goal = undefined;
    p.pause = arrivalPause(p);
    arrivalActivity(p, p.pause);
  }
  if (!goal) {
    goal = nextGoal(w, p, here, pool);
    p.goal = goal ? goal.id : null;
  }
  return goal;
}

/**
 * A destination worth walking to from here.
 *
 * Any kerb on the map used to be drawn with equal odds, including the one a
 * few metres behind — so somebody arriving somewhere turned round and walked
 * back the way they came, and a street full of people read as a crowd pacing
 * up and down. A destination is now somewhere FURTHER ON: some distance away,
 * and ahead of the way this person is already facing, as a person on their
 * way somewhere continues. Several hashed candidates are tried in turn, so the
 * choice is still the party's own and still deterministic.
 */
function nextGoal(w: SimWorld, p: Ped, here: SidewalkNode | undefined,
  pool: readonly string[]): SidewalkNode | undefined {
  let fallback: SidewalkNode | undefined;
  let farEnough: SidewalkNode | undefined;
  const hx = Math.cos(p.heading);
  const hy = Math.sin(p.heading);
  for (let k = 0; k < GOAL_TRIES; k++) {
    const picked = pool[goalPick(p.party.id, p.trip * GOAL_TRIES + k, pool.length)];
    const node = picked === undefined ? undefined : w.sidewalks.nodes.get(picked);
    if (!node) continue;
    fallback ??= node;
    if (!here) return node;
    const dx = node.at.x - here.at.x;
    const dy = node.at.y - here.at.y;
    const d = Math.hypot(dx, dy);
    if (d < GOAL_MIN_TRIP) continue;
    farEnough ??= node;
    if (dx * hx + dy * hy > d * GOAL_AHEAD) return node;
  }
  return farEnough ?? fallback;
}
/** Candidates tried for a new destination, the least distance to one, and how far ahead it must lie (cosine). */
const GOAL_TRIES = 10;
const GOAL_MIN_TRIP = m(60);
const GOAL_AHEAD = 0.2;

/**
 * Whether a pedestrian may step off the kerb.
 *
 * A pedestrian may only start if it can FINISH. That single rule, combined with
 * the plan-level clearance invariant and with crossing occupancy being a hard
 * conflict resource for vehicles, is what guarantees nobody is ever caught in
 * the road.
 */
export function mayEnterCrossing(w: SimWorld, p: Ped, crossing: SidewalkEdge): boolean {
  const node = crossing.node;
  const segment = crossing.segment;
  if (node === undefined || segment === undefined) return true;

  const need = crossing.length / PED.designSpeed + PED.startLag;
  const controller = w.controller(node);
  const junction = w.graph.junctions.get(node);
  const id = makeCrossingId(node, segment);

  // Connector admission is also a crossing reservation.  This closes the
  // one-tick race where a car reserved a turn and a pedestrian stepped onto
  // its zebra later in the same simulation tick.
  if (crossingReservedByVehicle(w, node, segment)) return false;

  if (controller && junction?.signalised) {
    const state = pedestrianSignalState(controller, id, crossing.length);
    if (state !== 'walk') return false;
    void need;
    return true;
  }

  // Uncontrolled: accept a gap in the lanes actually being crossed.
  return pedGapAccepted(w, p, crossing);
}

/** Margin past the span a vehicle's rear must reach before it stops counting. */
const CLEAR_PAST = 6;

function crossingReservedByVehicle(w: SimWorld, node: number, segment: number): boolean {
  for (const v of w.vehicles.values()) {
    const lane = w.lanelet(v.lanelet);
    const connectorIds = new Set(v.clearingConnectors.map((token) => token.connector));
    if (v.admittedConnector) connectorIds.add(v.admittedConnector);
    if (lane?.kind === 'connector') connectorIds.add(lane.id);

    for (const connectorId of connectorIds) {
      const connector = w.connector(connectorId);
      if (!connector || connector.node !== node) continue;
      if (connector.inSegment !== segment && connector.outSegment !== segment) continue;
      const span = w.crossingSpans.span(connector.id, `${node}:${segment}`);
      // Never drives over this zebra at all.
      if (span === null) continue;
      // A token may be granted while its vehicle is still on the approach.
      // When it can comfortably stop before this zebra, a waiting person may
      // take the gap; pedestrianAhead then keeps the admitted vehicle behind
      // the person. A vehicle already on the connector retains the hard gate.
      if (span && lane?.kind === 'link' && connectorId === v.admittedConnector) {
        const distance = Math.max(0, lane.length - v.s) + span.along;
        if (distance > m(2) && canStopComfortably(v.driver, v.v, distance)) continue;
      }
      // Its whole body is already past the stretch it drives over. Counting a
      // vehicle that has gone by held walkers at a WALK for as long as turns
      // kept flowing behind it — nearly two minutes at a busy corner.
      if (span && connectorId === lane?.id && v.s - v.archetype.length > span.along + CLEAR_PAST) continue;
      if (span && connectorId !== lane?.id && connectorId !== v.admittedConnector) {
        const token = v.clearingConnectors.find((t) => t.connector === connectorId);
        if (token && connector.length + token.distanceBeyondExit - v.archetype.length > span.along + CLEAR_PAST) continue;
      }
      return true;
    }
  }
  return false;
}

/**
 * Gap acceptance against approaching traffic on the lanes being crossed.
 *
 * At an uncontrolled zebra the pedestrian has priority once on it: admission
 * refuses every movement over an occupied crossing (`crossingBusy`). So the
 * question is not "is the road empty for the whole time I need to cross" —
 * with a crossing of forty units that demanded a seventeen-second gap and
 * held people at the kerb for three minutes — but "can everything coming
 * stop for me, and is nothing about to arrive regardless".
 */
export function pedGapAccepted(w: SimWorld, p: Ped, crossing: SidewalkEdge): boolean {
  const impatience = Math.min(1.5, 0.05 * p.waited);
  const critical = Math.max(2.5, PED.criticalGap - impatience);

  for (const laneId of crossing.lanes ?? []) {
    const lane = w.lanelet(laneId);
    if (!lane || lane.to !== crossing.node) continue;
    const head = w.laneHead(laneId);
    if (!head) continue;
    // A vehicle standing at its line is not arriving. It has no admission
    // (`crossingReservedByVehicle` already refused this crossing if it had),
    // and admission will not grant it one while somebody is on the zebra.
    // Treating it as arriving at walking pace — distance over 0.5 u/s — kept
    // pedestrians at uncontrolled kerbs for over three minutes behind queues
    // that could not move until they had crossed.
    if (head.v < 0.5 && !head.admittedConnector) continue;
    const distance = lane.length - head.s;
    const arrival = distance / Math.max(head.v, 0.5);
    if (arrival < critical || !canStopComfortably(head.driver, head.v, distance)) return false;
  }
  return true;
}

// ---------------------------------------------------------------- neighbours

/**
 * The result of one neighbour scan.
 *
 * A single record, reused. The scan runs once per pedestrian per tick and its
 * answer is consumed before the next scan begins, so a fresh object per
 * pedestrian would be fifteen hundred allocations a tick to carry seven numbers
 * a few lines.
 *
 * `leader` is the nearest person ahead going the same way whatever their line;
 * `blocker` is the nearest one actually in the way. They differ exactly when
 * somebody can be walked around, which is the whole point of having both.
 */
const NEAR = {
  leaderGap: Infinity,
  leaderSpeed: 0,
  leaderLat: 0,
  blockerGap: Infinity,
  blockerSpeed: 0,
  /** The blocker is somebody waiting for the same crossing: a queue, not a jam. */
  blockerQueue: false,
  oncomingGap: Infinity,
  oncomingLat: 0,
};

function scanNeighbours(w: SimWorld, p: Ped, edge: SidewalkEdge): void {
  NEAR.leaderGap = Infinity;
  NEAR.leaderSpeed = 0;
  NEAR.leaderLat = 0;
  NEAR.blockerGap = Infinity;
  NEAR.blockerSpeed = 0;
  NEAR.blockerQueue = false;
  NEAR.oncomingGap = Infinity;
  NEAR.oncomingLat = 0;

  const index = w.sidewalks.occupancy;
  const slot = index.slotOf(p.id);
  if (slot < 0) return;
  const ids = index.occupants(edge.id);
  const keys = index.positions(edge.id);
  const mine = keys[slot];
  if (mine === undefined) return;

  // The index runs from the edge's `from` end; a pedestrian who entered from
  // the other end walks down it, not up it.
  const step = p.entry === edge.from ? 1 : -1;

  let i = slot + step;
  for (let n = 1; n <= PED_BEHAVIOUR.scanAhead && i >= 0 && i < ids.length; n++, i += step) {
    const key = keys[i];
    const id = ids[i];
    if (key === undefined || id === undefined) break;
    const ahead = (key - mine) * step;
    if (ahead <= 0) continue;
    const other = w.peds.get(id);
    if (!other) continue;
    // Somebody waiting at the kerb for a crossing is a queue only for people
    // going to the SAME crossing. Everybody else walks past the queue, round
    // the corner; treating them as a jam held turning walkers behind a red
    // light that was never theirs, some for over two minutes.
    if (other.state === 'WaitAtKerb' && other.route[0] !== p.route[0]) continue;

    if (other.entry === p.entry) {
      if (ahead < NEAR.leaderGap) {
        NEAR.leaderGap = ahead;
        NEAR.leaderSpeed = other.v;
        NEAR.leaderLat = other.lat;
      }
      if (ahead < NEAR.blockerGap && Math.abs(other.lat - p.lat) < PED_BEHAVIOUR.shoulder) {
        NEAR.blockerGap = ahead;
        NEAR.blockerSpeed = other.v;
        // A queue for a crossing is everybody standing in line for it, not
        // only the one at the kerb: a third person behind two others was
        // counted as stuck and released through the line.
        NEAR.blockerQueue = other.state === 'WaitAtKerb' ||
          (other.v < 0.05 && other.route[0] !== undefined && other.route[0] === p.route[0] &&
            w.sidewalks.edges.get(other.route[0])?.kind === 'crossing');
      }
    } else if (ahead < NEAR.oncomingGap) {
      NEAR.oncomingGap = ahead;
      // Two people walking towards each other measure their offsets against
      // opposite normals, so the sign has to be flipped to compare them.
      NEAR.oncomingLat = -other.lat;
    }
  }
}

/** Speed reduced by whoever is genuinely in the way. */
function followSpeed(desired: number, released = false): number {
  const gap = NEAR.blockerGap;
  // The same last resort as the clearance release: a walker held up for
  // STUCK_RELEASE seconds walks through the knot rather than stand in it.
  if (released) return desired;
  if (gap === Infinity) return desired;
  const target = PED.jamGap + desired * PED.headway;
  if (gap <= PED.jamGap) return 0;
  if (gap < target) return Math.min(desired, Math.max(0, NEAR.blockerSpeed));
  return desired;
}

// ------------------------------------------------------------------- pace

/**
 * What this pedestrian would walk at right now with the footway to themselves.
 *
 * A product of independent scalars rather than a branch tree, so a person
 * slowing for a corner while dawdling while waiting for a friend is all three
 * at once instead of whichever case was tested first.
 */
/**
 * How long this person stops on reaching a destination. Keyed on the party
 * and the trip, so companions stop together and for as long as each other;
 * most people walk straight on, some pause briefly, groups stop to talk.
 */
function arrivalPause(p: Ped): number {
  const roll = goalPick(p.party.id ^ 0x3c6ef372, p.trip, 1000) / 1000;
  if (roll < PAUSE_SKIP) return 0;
  const talk = p.party.size > 1 ? PAUSE_TALK : 0;
  return PAUSE_MIN + (PAUSE_MAX - PAUSE_MIN + talk) * (roll - PAUSE_SKIP) / (1 - PAUSE_SKIP);
}
/** Share of arrivals with no pause, and the pause range in seconds. */
const PAUSE_SKIP = 0.45;
const PAUSE_MIN = 1.5;
const PAUSE_MAX = 7;
/** Extra time a group spends talking when it stops. */
const PAUSE_TALK = 8;

function desiredSpeed(w: SimWorld, p: Ped, edge: SidewalkEdge): number {
  if (p.pause > 0 && p.state === 'Walking') {
    p.pause = Math.max(0, p.pause - DT);
    return 0;
  }
  let v = Math.min(p.speed, p.party.pace);

  // Individual pace variation applies on footways only.
  if (p.state === 'Walking') v *= strollFactor(p.id, p.age, p.ageClass);
  if (edge.kind === 'corner') v *= PED_BEHAVIOUR.cornerFactor;

  const remaining = edge.length - p.s;
  if (edge.kind !== 'crossing' && remaining < PED_BEHAVIOUR.kerbSlowDistance) {
    const nextId = p.route[0];
    const next = nextId ? w.sidewalks.edges.get(nextId) : undefined;
    // Anything that is not more footway straight ahead — a kerb, a corner, or
    // a decision still to be made — is approached rather than walked into.
    // An elder is more cautious about it than most; a child barely is.
    if (next?.kind !== 'walk') {
      const kerbFactor = p.ageClass === 'elder' ? PED_BEHAVIOUR.elderKerbFactor
        : p.ageClass === 'child' ? PED_BEHAVIOUR.childKerbFactor : PED_BEHAVIOUR.kerbSlowFactor;
      v *= lerp(
        kerbFactor,
        1,
        clamp(remaining / PED_BEHAVIOUR.kerbSlowDistance, 0, 1),
      );
    }
  }

  v *= cohesion(w, p);
  return Math.max(0, v);
}

/**
 * Pacing for the companion directly behind, as a multiplier. Cuts the link when
 * the two have parted, which is the only place a party ever breaks up.
 *
 * A party only holds together while its members are on the same footway going
 * the same way. The moment a crossing releases part of a party the rest walk
 * on, deliberately: waiting would park somebody at a kerb they are not queuing
 * to cross, where the crossing rules have nothing to say about them, and would
 * let one red signal hold a party still for a whole cycle. They re-form on
 * their own, because the destination is the party's and not the walker's, so
 * the ones ahead keep making the turns the ones behind will make.
 */
function cohesion(w: SimWorld, p: Ped): number {
  if (p.trailing === null) return 1;
  const mate = w.peds.get(p.trailing);
  if (!mate) {
    p.trailing = null;
    return 1;
  }
  // A companion on another edge is mid-crossing or a turn behind: transient,
  // and not something to pace for, because the lag is not measurable across
  // two edges and a kerb is no place to be held. One on the SAME footway
  // walking the other way is not a transient — they have parted.
  if (mate.edge !== p.edge) return 1;
  if (mate.entry !== p.entry) {
    p.trailing = null;
    return 1;
  }

  const lag = p.s - mate.s;
  if (lag <= PED_BEHAVIOUR.cohesionSlack) return 1;
  if (lag > PED_BEHAVIOUR.cohesionBreak) {
    p.trailing = null;
    return 1;
  }

  // Slower than the companion, not equal to them, so the gap actually closes;
  // and never below the crawl, so a companion held up by a stranger cannot
  // bring the footway to a halt.
  const closing = clamp((lag - PED_BEHAVIOUR.cohesionSlack) / PED_BEHAVIOUR.cohesionSlack, 0, 1);
  const cap = Math.max(
    mate.v * lerp(1, PED_BEHAVIOUR.cohesionClose, closing),
    PED_BEHAVIOUR.cohesionCrawl,
  );
  const own = Math.max(Math.min(p.speed, p.party.pace), DIV_EPS);
  return clamp(cap / own, 0, 1);
}

/**
 * Urgency while in the road.
 *
 * Everybody crosses a little faster than they walk, and faster still when the
 * protected window is closing. This can only ever make somebody leave the road
 * sooner: the decision to be there was taken at the kerb by `mayEnterCrossing`
 * against the design speed, which is slower than anyone actually walks.
 */
function crossingUrgency(w: SimWorld, p: Ped, edge: SidewalkEdge): number {
  const node = edge.node;
  const crossing = edge.crossing;
  if (node === undefined || crossing === undefined) return PED_BEHAVIOUR.crossingUrgency;

  const controller = w.controller(node);
  if (!controller || !w.graph.junctions.get(node)?.signalised) {
    return PED_BEHAVIOUR.crossingUrgency;
  }

  const left = remainingProtectedTime(controller, crossing);
  const need = (edge.length - p.s) / Math.max(p.speed, DIV_EPS);
  return left < need * PED_BEHAVIOUR.hurryMargin
    ? PED_BEHAVIOUR.crossingUrgency * PED_BEHAVIOUR.hurryGain
    : PED_BEHAVIOUR.crossingUrgency;
}

// ---------------------------------------------------------------- steering

/**
 * The only writer of `Ped.lat`.
 *
 * Target plus rate limit. Every term below moves the target, never the
 * position, so however hard two of them disagree the pedestrian still walks
 * from where they are to where they want to be at a walking pace. The clamp is
 * against the edge's own half-width, which is what makes it structurally
 * impossible for steering to put anybody off a footway or off a zebra.
 */
function steer(w: SimWorld, p: Ped, edge: SidewalkEdge, desired: number, space: PedestrianClearance): void {
  const usable = Math.max(0, edge.halfWidth - PED_BEHAVIOUR.lateralMargin);
  let target = formation(p, usable);
  // Going to stop, or stopped, at one side of the footway: that side.
  const stopping = p.activity && p.activity.side !== 0 && edge.kind === 'walk' ? p.activity : null;
  if (stopping) target = stopping.side * usable;
  // Line up for a narrower next edge — a zebra is far narrower than a footway
  // — before reaching it, so the entry is walked into rather than cut to.
  const nextEdge = p.route[0] ? w.sidewalks.edges.get(p.route[0]) : undefined;
  const narrower = nextEdge ? Math.max(0, nextEdge.halfWidth - PED_BEHAVIOUR.lateralMargin) : usable;
  const remaining = edge.length - p.s;
  if (nextEdge && narrower < usable && remaining < LINE_UP_DISTANCE && p.state !== 'Crossing') {
    const room = lerp(narrower, usable, clamp(remaining / LINE_UP_DISTANCE, 0, 1));
    target = clamp(target, -room, room);
  }

  if (p.state === 'WaitAtKerb' || p.state === 'ApproachKerb') {
    // Wait BESIDE the mouth of the zebra, not in it: standing in the middle
    // of it boxed in everybody coming off the crossing, and the people at the
    // kerb could not step on until they had got off — a knot at every busy
    // kerb. The side follows the walker's own habit, so a queue fans out.
    if (nextEdge?.kind === 'crossing') {
      const mouth = Math.max(0, nextEdge.halfWidth - PED_BEHAVIOUR.lateralMargin);
      const flank = Math.min(usable, mouth + KERB_FLANK);
      target = (target >= 0 ? 1 : -1) * Math.max(flank, Math.abs(target));
    }
    // Somebody going round the corner is held up against this waiter: step
    // aside for them, as a person at a kerb does. Standing firm left a
    // through-walker boxed behind the queue for the whole of a long red —
    // over 40 s once the signal plans stopped pairing approaches.
    const jam = p.state === 'WaitAtKerb' ? space.jammedNear(w, p, MAKE_ROOM_RANGE) : null;
    if (jam) {
      const frame = w.sidewalks.orientedPath(edge, p.entry).sampleAt(p.s);
      const across = (jam.x - frame.p.x) * frame.n.x + (jam.y - frame.p.y) * frame.n.y;
      target = p.lat + (across >= p.lat ? -1 : 1) * MAKE_ROOM;
    }
  } else {
    // Step around somebody slower, towards whichever side has more room.
    if (
      NEAR.leaderGap < PED_BEHAVIOUR.passLook &&
      NEAR.leaderSpeed < desired - PED_BEHAVIOUR.passMargin &&
      Math.abs(NEAR.leaderLat - target) < PED_BEHAVIOUR.shoulder
    ) {
      const room = NEAR.leaderLat <= 0 ? 1 : -1;
      target += room * PED_BEHAVIOUR.passShift;
    }

    // And give way to anyone coming the other way. Both walkers shift to the
    // same signed side, which in mirrored frames is the same hand, so the two
    // corrections add up to a gap instead of cancelling into a dance.
    if (
      NEAR.oncomingGap < PED_BEHAVIOUR.oncomingLook &&
      Math.abs(NEAR.oncomingLat - target) < PED_BEHAVIOUR.shoulder * 2
    ) {
      target += PED_BEHAVIOUR.keepSide * PED_BEHAVIOUR.oncomingShift;
    }
    // Those say where this walker would like to be. What is actually in the
    // way decides where they can be, and it has the last word: it used to be
    // applied first, and the two nudges above could put somebody straight
    // back in front of the bench they had just stepped round.
    target = space.clearLine(w, p, edge, target, usable);
  }

  // Held up: commit to the side with more room and go there.
  if (p.stuck > DODGE_AFTER && p.state !== 'WaitAtKerb') {
    if (p.dodge === 0) p.dodge = p.lat >= 0 ? -1 : 1;
    // Already against the edge on the committed side and still shut in: that
    // side has nothing more to give, so try the other. The flip below only
    // fires when a sideways step is refused, and at the edge none is ever
    // attempted - a walker pinned there facing somebody on the same side of a
    // narrow zebra stood for 9.7 s until the release let them squeeze.
    else if (p.dodge * p.lat >= usable - EDGE_PINNED) p.dodge = -p.dodge;
    // Towards that side, but round whatever stands there: the edge of a
    // footway is where its lamp columns and tree pits are.
    target = space.clearLine(w, p, edge, p.dodge * usable, usable);
  } else if (p.stuck === 0) {
    p.dodge = 0;
  }
  const held = clamp(p.lat, -usable, usable);
  // Sideways speed wanted to close the offset, then eased: a step aside
  // starts, carries and settles instead of switching on and off each tick.
  // Standing, it is a side-step, and a side-step is half the pace of one
  // taken while walking on.
  const rate = PED_BEHAVIOUR.lateralRate * lerp(SIDESTEP_STANDING, 1, clamp(p.v / SIDESTEP_WALKING, 0, 1));
  PLAN.target = clamp(target, -usable, usable);
  PLAN.rate = rate;
  const wanted = clamp((PLAN.target - held) / LATERAL_SETTLE, -rate, rate);
  const step = LATERAL_ACCEL * DT;
  p.latV = clamp(wanted, p.latV - step, p.latV + step);
  const proposed = clamp(held + p.latV * DT, -usable, usable);
  // Blocked sideways: hold the line. Stepping the other way instead, as this
  // used to, made a boxed-in walker zigzag on the spot every tick.
  if (space.canShift(w, p, edge, proposed)) p.lat = proposed;
  else {
    p.lat = held;
    p.latV = 0;
    // Committed side blocked too: take the other one next time.
    if (p.dodge !== 0) p.dodge = -p.dodge;
  }
}

/**
 * Where `steer` is taking this walker across the footway this tick, and how
 * fast it may get there; read by `approachSpeed` straight after. One record,
 * reused, as `NEAR` is.
 */
const PLAN = { target: 0, rate: 0 };

/** Seconds held up before committing to a side. */
const DODGE_AFTER = 0.6;
/** How close to the edge of the usable width counts as pinned against it. */
const EDGE_PINNED = m(0.05);

/** Distance beyond the zebra's edge at which people wait. */
const KERB_FLANK = m(0.45);
/** How near a held-up walker must be for a waiter to make room, and how far they step aside. */
const MAKE_ROOM_RANGE = m(1.3);
const MAKE_ROOM = m(0.9);

/** Distance before a narrower edge over which walkers line up for it. */
const LINE_UP_DISTANCE = m(4);

/** Seconds over which a lateral offset is closed, and the sideways acceleration. */
const LATERAL_SETTLE = 0.6;
const LATERAL_ACCEL = PED_BEHAVIOUR.lateralRate * 2.2;
/** Share of the sideways rate a standing person steps aside at, and the pace at which it is all of it. */
const SIDESTEP_STANDING = 0.5;
const SIDESTEP_WALKING = m(1);

/**
 * Speed at which this person can still stop before whatever is blocking the
 * way ahead.
 *
 * The clearance is a hard gate: it either allows a step or refuses it. Walking
 * into it at full pace and being refused is an instantaneous stop — measured at
 * 193 u/s of deceleration in a single tick, which is what a figure stopping
 * dead in mid-stride looks like. Probing a braking distance ahead turns the
 * same gate into a deceleration: people slow as they come up to a knot and
 * stop short of it, as they do in a street.
 */
function approachSpeed(w: SimWorld, p: Ped, edge: SidewalkEdge, space: PedestrianClearance,
  command: number): number {
  if (command <= 0) return command;
  // Braking distance plus a reaction: people see a knot coming and start
  // slowing well before they reach it. The reaction term matters most for two
  // people walking towards each other, who close at twice walking pace.
  const brake = (p.v * p.v) / (2 * PED_COMFORT);
  const reach = Math.max(PED_PROBE_MIN, brake + p.v * PED_REACTION);
  let limit = command;

  // Whatever is in the way along this edge.
  const probe = Math.min(edge.length, p.s + reach);
  if (probe > p.s) {
    const free = space.safeStep(w, p, edge, probe) - p.s;
    if (free < probe - p.s - 1e-6) {
      let allowed = stopWithin(free);
      // Unless the step aside `steer` has planned clears it: then walk on,
      // no faster than lets that step be finished before it is reached.
      // Braking for everything on the current line is what stopped people
      // dead in front of a bench they were about to walk round.
      const aside = Math.abs(PLAN.target - p.lat);
      if (aside > 1e-3 && PLAN.rate > 0 &&
        space.clearAlong(w, p, edge, probe, PLAN.target) >= probe - 1e-6) {
        allowed = Math.max(allowed, (free - PASS_ROOM) / (aside / PLAN.rate + SIDESTEP_LAG));
      }
      limit = Math.min(limit, allowed);
    }
  }

  // The end of the edge itself, when it cannot be walked straight through: a
  // kerb, or a next edge somebody is standing in the mouth of. Arriving at
  // full pace and being refused is a stop from walking speed to nothing in a
  // single tick — 193 u/s of deceleration, a figure halting in mid-stride.
  const toEnd = edge.length - p.s;
  if (toEnd <= reach && mustStopAtEndOf(w, p, edge, space)) {
    limit = Math.min(limit, stopWithin(toEnd));
  }
  return limit;
}

/**
 * Speed from which this person can still stop comfortably within a distance.
 * Planned at a comfortable rate, not the hardest one: a stop braked at
 * 2.4 m/s² is over in half a metre, a third of a stride — a body halting
 * while the legs that should be slowing it are still mid-step.
 */
const stopWithin = (distance: number): number => Math.sqrt(Math.max(0, 2 * PED_COMFORT * distance));
/** Distance kept in hand when walking on towards something a planned step aside will clear, u. */
const PASS_ROOM = m(0.3);
/** Seconds before a step aside actually gets under way. */
const SIDESTEP_LAG = 0.35;

/** Whether the next edge cannot simply be walked into right now. */
function mustStopAtEndOf(
  w: SimWorld,
  p: Ped,
  edge: SidewalkEdge,
  space: PedestrianClearance,
): boolean {
  if (p.state === 'Crossing') return false;
  const next = p.route[0] ? w.sidewalks.edges.get(p.route[0]) : undefined;
  // Nothing planned, or a crossing: both end at this kerb.
  if (!next || next.kind === 'crossing') return true;
  const exit = w.sidewalks.other(edge, p.entry);
  const frame = w.sidewalks.orientedPath(next, exit).sampleAt(0);
  const width = Math.max(0, next.halfWidth - PED_BEHAVIOUR.lateralMargin);
  const here = space.point(w, edge, p.entry, edge.length, p.lat);
  const lat = clamp(
    (here.x - frame.p.x) * frame.n.x + (here.y - frame.p.y) * frame.n.y,
    -width,
    width,
  );
  return !space.canEnter(w, p, next, exit, lat);
}
/** Shortest look-ahead, so a standing walker still sees a body in front of it. */
const PED_PROBE_MIN = 4;
/**
 * Seconds of travel looked ahead beyond the braking distance.
 *
 * Two people walking towards each other close at twice walking pace, and the
 * clearance gate between them is 0.6 m wide, so the look-ahead has to cover
 * the closing speed rather than this walker's own.
 */
const PED_REACTION = 2;

/**
 * Walking speed eased towards the target: people accelerate into a stride
 * and slow out of it over a second or so. Braking is quicker than starting.
 * A hard stop for somebody in the way is still enforced by the clearance.
 */
function eased(current: number, target: number): number {
  const rise = PED_ACCEL * DT;
  const fall = PED_DECEL * DT;
  return target > current ? Math.min(target, current + rise) : Math.max(target, current - fall);
}
const PED_ACCEL = m(1.1);
const PED_DECEL = m(2.4);
/** Deceleration planned for a stop that is seen coming: a kerb, a queue, a place to stop at. */
const PED_COMFORT = m(1.2);

/**
 * World position, and a body heading turned towards the direction of travel
 * at a human rate. Standing still, a person keeps facing where they were
 * going, or turns to face the crossing they are waiting for.
 */
function settlePose(w: SimWorld, p: Ped, first: boolean, space: PedestrianClearance): void {
  const edge = w.sidewalks.edges.get(p.edge);
  if (!edge) return;
  const path = w.sidewalks.orientedPath(edge, p.entry);
  const frame = path.sampleAt(p.s);
  // The lateral offset is applied along a normal averaged over a short span.
  // A corner is a polyline, and the per-segment normal turns through 15
  // degrees or more at every vertex: somebody walking a metre off the line
  // was drawn jumping sideways each time they passed one.
  const before = path.sampleAt(Math.max(0, p.s - NORMAL_SPAN)).t;
  const after = path.sampleAt(Math.min(path.length, p.s + NORMAL_SPAN)).t;
  const tx = before.x + after.x;
  const ty = before.y + after.y;
  const tl = Math.hypot(tx, ty) || 1;
  const nx = -ty / tl;
  const ny = tx / tl;
  const pathX = frame.p.x + nx * p.lat;
  const pathY = frame.p.y + ny * p.lat;
  // Changing edge can move the path position sideways: somebody waiting
  // beside a zebra's mouth steps onto its centreline, a corner starts from a
  // different offset. That gap is real and has to be WALKED, so it becomes an
  // offset of the drawn body that closes over a third of a second instead of
  // a 1-2 unit teleport in one frame.
  //
  // The same holds for a sharp vertex of a corner path: the offset line of a
  // polyline has a gap on the outside of every kink. Any path jump longer
  // than a step is absorbed the same way.
  //
  // It closes no faster than a person walks it (`OFFSET_CLOSE`): a catch-up of
  // a metre or two closed on a time constant alone swept the body across the
  // pavement at several metres a second — a figure gliding sideways, faster
  // than anybody can step.
  const settledX = pathX + p.offX * closing(p.offX, p.offY);
  const settledY = pathY + p.offY * closing(p.offX, p.offY);
  const step = Math.hypot(settledX - p.x, settledY - p.y);
  if (!first && (p.prev.edge !== p.edge || step > p.v * DT * 1.5 + PATH_JUMP)) {
    p.offX = p.x - pathX;
    p.offY = p.y - pathY;
    if (Math.hypot(p.offX, p.offY) > OFFSET_LIMIT) { p.offX = 0; p.offY = 0; }
  }
  const keep = closing(p.offX, p.offY);
  p.offX *= keep;
  p.offY *= keep;
  // The catch-up sweep above is a straight line the physical clearance
  // system never vetted (`PedestrianClearance.tooCloseToPerson`), and
  // decaying it in a straight line can sweep the drawn body through whoever
  // stands between its two ends — measured, gap 0.75 to 0.03 in under a
  // second, entering a crossing right beside somebody queued at its own
  // kerb. Holding the offset instead of closing it did not fix this: the
  // logical walk (`p.s`, `p.lat`) is governed elsewhere and keeps going
  // regardless, so a hold only lets the gap between drawn and logical
  // position grow without bound while whoever it is avoiding stays put.
  // Closing it to zero outright is a visible pop, but a rare, bounded one —
  // and a pop is a far smaller defect than a body passing through a person.
  if ((p.offX !== 0 || p.offY !== 0) && space.tooCloseToPerson(p.id, pathX + p.offX, pathY + p.offY)) {
    p.offX = 0;
    p.offY = 0;
  }
  const anchor = activityAnchor(p);
  // Off the walking line — stepping to a bench, sitting on it — the body is
  // where the activity has put it, and no path offset applies.
  if (anchor) { p.offX = 0; p.offY = 0; }
  const x = anchor ? anchor.x : pathX + p.offX;
  const y = anchor ? anchor.y : pathY + p.offY;
  p.x = x;
  p.y = y;
  if (first) {
    p.heading = Math.atan2(frame.t.y, frame.t.x);
    p.turnV = 0;
    return;
  }

  // Which way the body wants to face. While walking it is the direction of
  // TRAVEL along the path — the tangent, averaged over a stride either side
  // — leaning a little into a sidestep. It used to be the direction of the
  // drawn displacement, every tick: each step aside to pass somebody swung
  // the whole body towards it and back, and the crowd walked in zigzags; and
  // standing still, a sideways shuffle of a few millimetres turned people
  // right round on the spot.
  let face: number | null = null;
  let rate = TURN_RATE_STANDING;
  // Standing on the footway, not placed by an activity: turns are made in
  // decisive steps rather than tracked by the degree (`steerHeading`).
  const standing = !anchor && p.v <= FACE_MIN_SPEED;
  if (anchor) {
    face = anchor.face;
    if (p.activity?.move) rate = TURN_RATE;
  } else if (p.v > FACE_MIN_SPEED) {
    const lean = Math.atan2(p.latV, Math.max(p.v, m(0.8))) * SIDESTEP_LEAN;
    face = Math.atan2(ty, tx) + lean;
    rate = TURN_RATE;
  } else if (p.state === 'WaitAtKerb') {
    const next = p.route[0] ? w.sidewalks.edges.get(p.route[0]) : undefined;
    if (next) {
      const t = w.sidewalks.orientedPath(next, w.sidewalks.other(edge, p.entry)).sampleAt(0).t;
      face = Math.atan2(t.y, t.x);
    }
  } else if (p.activity?.kind === 'talk') {
    const party = TALK.get(p.party.id);
    if (party && party.n > 1) {
      const cx = (party.x - p.x) / (party.n - 1);
      const cy = (party.y - p.y) / (party.n - 1);
      if (Math.hypot(cx - p.x, cy - p.y) > m(0.2)) face = Math.atan2(cy - p.y, cx - p.x);
    }
  } else {
    face = holdFacing(w, p, edge);
  }
  steerHeading(p, face, rate, standing);
}

/**
 * Turns the body through an angular velocity: towards `face` when there is
 * one, easing to a stop when there is not. A turn therefore starts, carries
 * and settles, and `turnV` says how fast the body is turning for the renderer,
 * which steps the feet round with it.
 *
 * Somebody `standing` does not track a target by the degree. They hold their
 * stance until it is a step round off, then turn — briskly enough that the
 * feet visibly step — and stop square to it. Tracking it continuously was a
 * slow swivel of a fraction of a radian a second, too slow to step for, that
 * went on for as long as a talking party shuffled or a queue settled: a
 * figure rotating on motionless legs.
 */
function steerHeading(p: Ped, face: number | null, rate: number, standing = false): void {
  let want = 0;
  if (face !== null) {
    const delta = Math.atan2(Math.sin(face - p.heading), Math.cos(face - p.heading));
    const settled = Math.abs(p.turnV) < STAND_SETTLED;
    if (!(standing && settled && Math.abs(delta) < STAND_DEADBAND)) {
      want = clamp(delta / TURN_EASE, -rate, rate);
      if (standing && Math.abs(delta) > STAND_SQUARE) {
        want = Math.sign(delta) * Math.max(Math.abs(want), Math.min(rate, STAND_TURN_MIN));
      }
    }
  }
  const step = TURN_ACCEL * DT;
  p.turnV = clamp(want, p.turnV - step, p.turnV + step);
  p.heading += p.turnV * DT;
  p.heading = Math.atan2(Math.sin(p.heading), Math.cos(p.heading));
}

/** Where each talking party stands: summed positions and a count, rebuilt each tick. */
const TALK = new Map<number, { x: number; y: number; n: number }>();

/** Travel below which the direction of travel is not a direction worth facing, u/s. */
const FACE_MIN_SPEED = m(0.12);
/** Share of a sidestep's angle the body turns into. */
const SIDESTEP_LEAN = 0.35;
/** Seconds over which a heading error is closed, and the turning acceleration, rad/s². */
const TURN_EASE = 0.28;
const TURN_ACCEL = 7;
/**
 * Standing: the error worth a step round (rad), the error a turn stops at, the
 * slowest a turn is made at (rad/s, above the 0.35 at which the renderer steps
 * the feet round), and the turning rate below which a body counts as settled.
 */
const STAND_DEADBAND = 0.2;
const STAND_SQUARE = 0.035;
const STAND_TURN_MIN = 0.6;
const STAND_SETTLED = 0.05;

/** Half-length of the span a drawn lateral normal is averaged over. */
const NORMAL_SPAN = 1.5;

/** Seconds over which an edge-change offset closes, and the largest one bridged. */
const OFFSET_SETTLE = 0.3;
const OFFSET_LIMIT = 6;
/** Fastest an offset closes, u/s: a brisk side-step. */
const OFFSET_CLOSE = m(0.8);

/** Share of a drawn-body offset left after one tick of closing it. */
function closing(offX: number, offY: number): number {
  const size = Math.hypot(offX, offY);
  if (size < 1e-9) return 0;
  return Math.max(Math.exp(-DT / OFFSET_SETTLE), 1 - OFFSET_CLOSE * DT / size);
}
/** Path movement beyond a stride that counts as a discontinuity, world units. */
const PATH_JUMP = 0.05;

/** Human turning rate walking, and turning on the spot, radians a second. */
const TURN_RATE = 2.6;
const TURN_RATE_STANDING = 1.25;

/**
 * Where across the footway this pedestrian wants to be, before anyone is in
 * the way.
 *
 * A party is placed as one thing: its members share the habit, so they share
 * the base offset and differ only by their place in the line. The line is then
 * shifted whole to fit the footway rather than each member being clamped
 * separately — clamping members separately piles the outside ones onto the same
 * bound, which is a party walking through itself.
 *
 * No branch names a footway class. Where the width is there the members spread
 * across it and walk side by side; where it is not they all want the same line
 * and the following model puts them in a queue, which is what people do.
 */
function formation(p: Ped, usable: number): number {
  const size = p.party.size;
  if (size < 2) return preferredLateral(p.id, p.file, PED.files) * usable;

  // A family keeps closer together than a party of adults would — a parent
  // does not let a child drift a lane's width away — so it walks abreast at
  // about half the spacing.
  const spacing = Math.max(PED_BEHAVIOUR.shoulder,
    PED_BEHAVIOUR.abreastSpacing *
      (p.party.hasChild ? PED_BEHAVIOUR.familySpacingFactor : 1));
  const base = preferredLateral(p.party.id, p.party.id % PED.files, PED.files) * usable;
  const needed = (size - 1) * spacing + PED_BEHAVIOUR.shoulder;
  if (usable * 2 < needed) {
    // A narrow footway may fit a pair, though it cannot fit the whole party
    // abreast. Keep pairs side by side and place the next pair behind them.
    if (usable * 2 < spacing + PED_BEHAVIOUR.shoulder) return base;
    const halfPair = spacing / 2;
    const rows = Math.ceil(size / 2);
    const rowShift = (Math.floor(p.rank / 2) - (rows - 1) / 2) * m(0.3);
    return clamp(base + rowShift, -(usable - halfPair), usable - halfPair) +
      (p.rank % 2 === 0 ? -halfPair : halfPair);
  }

  const half = ((size - 1) / 2) * spacing;
  const place = (p.rank - (size - 1) / 2) * spacing;
  return clamp(base, -(usable - half), usable - half) + place;
}

// --------------------------------------------------------------- occupancy

function occupyCrossing(w: SimWorld, p: Ped, edge: SidewalkEdge): void {
  if (edge.kind !== 'crossing' || !edge.crossing) return;
  // The wait is over. Without this reset the stall detector would see the whole
  // time spent at the kerb as time spent motionless in the road, and flag every
  // pedestrian on the very tick it steps off.
  p.lastMovedTick = w.clock.tick;
  p.occupying = edge.crossing;
  const list = w.pedOccupancy.get(edge.crossing);
  if (list) {
    if (!list.includes(p.id)) list.push(p.id);
  } else {
    w.pedOccupancy.set(edge.crossing, [p.id]);
  }
}

export function releaseCrossing(w: SimWorld, p: Ped): void {
  if (!p.occupying) return;
  const list = w.pedOccupancy.get(p.occupying);
  if (list) {
    const i = list.indexOf(p.id);
    if (i >= 0) list.splice(i, 1);
    if (!list.length) w.pedOccupancy.delete(p.occupying);
  }
  p.occupying = null;
}
