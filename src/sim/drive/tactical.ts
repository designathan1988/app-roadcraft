import type { LaneletId } from '@world/lanelets';
import type { BodyClass } from '@world/conflictPoints';
import { m } from '@world/units';
import type { SimWorld } from '../world';

/**
 * Drive v2, tactical layer: which LANE a trip is driven in.
 *
 * The legacy trip planner searched the lanelet graph from the lane a vehicle
 * happened to be in, over connectors only. Lane discipline makes each turn
 * legal from one lane, so a car in the wrong lane for its turn found no way
 * to it at all and was sent round the block, or into a U-turn - the audit's
 * P1-19. A driver does the opposite: they know the turn is coming and move
 * across in time.
 *
 * Here the search carries lane changes as edges of their own. From any link
 * lane the car may cross to a sibling lane of the same carriageway, at a cost
 * per lane crossed, and only where the lane leaves room to make the change.
 * The cheapest trip then says where the changes are, and the plan is split
 * at the first one:
 *
 *  - a change on the lane the car is in now is published as `changeTo`, for
 *    `laneChange.ts` to execute as a mandatory change, while `route` stays
 *    the trip the car can drive from where it is, should the change fail;
 *  - a change further on ends `route` at the lane where it is to be made.
 *    The route runs out there, the planner is asked again from that lane,
 *    and the change becomes that lane's `changeTo`.
 *
 * Only one change is taken per lane: two in a row are one move to a lane
 * further across, which the edge already prices by the lanes it crosses.
 */

/** Seconds a lane change costs the trip, per lane crossed. Also the hysteresis. */
const CHANGE_COST = 4;
/**
 * Road a change needs, per lane crossed. The driver eases off to fit a change
 * (`positioningSpeedCap`), so this is the room at a slow approach speed, not at
 * the limit; the lane-change stage itself gives up if even a crawl misses.
 */
const ROOM_PER_LANE = m(24);

export interface TripPlan {
  /**
   * Drivable from the start lane: links joined by their connectors, ending at
   * the goal or at the lane where the next change is to be made.
   */
  readonly route: LaneletId[];
  /** The sibling lane to move into before leaving the start lane, or null. */
  readonly changeTo: LaneletId | null;
  /** With `changeTo`: the connector the trip leaves that lane by. */
  readonly intent: LaneletId | null;
  readonly cost: number;
}

interface Node {
  readonly key: string;
  readonly lane: LaneletId;
  /** Arrived by a lane change: another may not follow on the same lane. */
  readonly changed: boolean;
  readonly cost: number;
}

interface Step {
  readonly from: string;
  /** The connector taken, or null for a lane change. */
  readonly connector: LaneletId | null;
}

const keyOf = (lane: LaneletId, changed: boolean): string => (changed ? `${lane}|c` : lane);

const compare = (a: Node, b: Node): number => a.cost - b.cost || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

function push(heap: Node[], value: Node): void {
  let at = heap.length;
  heap.push(value);
  while (at > 0) {
    const parent = (at - 1) >> 1;
    if (compare(heap[parent]!, value) <= 0) break;
    heap[at] = heap[parent]!;
    at = parent;
  }
  heap[at] = value;
}

function pop(heap: Node[]): Node | undefined {
  const first = heap[0];
  const tail = heap.pop();
  if (!first || !tail || heap.length === 0) return first;
  let at = 0;
  while (at * 2 + 1 < heap.length) {
    let child = at * 2 + 1;
    if (child + 1 < heap.length && compare(heap[child + 1]!, heap[child]!) < 0) child++;
    if (compare(tail, heap[child]!) <= 0) break;
    heap[at] = heap[child]!;
    at = child;
  }
  heap[at] = tail;
  return first;
}

/** Seconds to drive on through a connector and the link it leads to, with its congestion. */
function connectorCost(w: SimWorld, connectorId: LaneletId, body: BodyClass): number {
  const connector = w.connector(connectorId);
  const out = connector && w.lanelet(connector.toLane);
  if (!connector || connector.maxBodyClass < body || !out || out.kind !== 'link' || w.rt(out.id).ghost) return Infinity;
  const density = w.rt(out.id).order.length / Math.max(1, out.length / 12);
  const travel = out.length / Math.max(0.5, out.speedLimit) * (1 + density * 2.6);
  const turn = connector.turn === 'uturn' ? 4 : connector.turn === 'through' ? 0 : 0.35;
  return connector.length / Math.max(0.5, out.speedLimit * 0.65) + travel + turn;
}

/**
 * The cheapest trip from `start` (the car at `startS` along it) to `goal`,
 * lane changes included. `startChange` false plans the trip as driven from
 * the start lane without leaving it first - the fallback while a change is
 * pending. Null when the goal cannot be reached at all.
 */
export function planTrip(
  w: SimWorld,
  start: LaneletId,
  startS: number,
  goal: LaneletId,
  body: BodyClass,
  startChange = true,
): TripPlan | null {
  const startLane = w.lanelet(start);
  if (!startLane || startLane.kind !== 'link' || !w.lanelet(goal) || w.rt(goal).ghost) return null;
  if (start === goal) return { route: [start], changeTo: null, intent: null, cost: 0 };

  const best = new Map<string, number>([[start, 0]]);
  const parent = new Map<string, Step>();
  const heap: Node[] = [];
  push(heap, { key: start, lane: start, changed: !startChange, cost: 0 });

  let reached: Node | null = null;
  while (heap.length) {
    const node = pop(heap)!;
    if (node.cost > (best.get(node.key) ?? Infinity) + 1e-9) continue;
    if (node.lane === goal) {
      reached = node;
      break;
    }
    const lane = w.lanelet(node.lane);
    if (!lane || lane.kind !== 'link') continue;

    for (const id of w.graph.exitsOf(node.lane)) {
      const step = connectorCost(w, id, body);
      if (!Number.isFinite(step)) continue;
      const out = w.connector(id)!.toLane;
      relax(heap, best, parent, { key: out, lane: out, changed: false, cost: node.cost + step }, { from: node.key, connector: id });
    }

    if (node.changed || lane.laneIndex === undefined) continue;
    const room = node.lane === start ? lane.length - startS : lane.length;
    for (const sibling of w.graph.siblingLanes(node.lane)) {
      const other = w.lanelet(sibling);
      if (!other || other.kind !== 'link' || other.laneIndex === undefined || w.rt(sibling).ghost) continue;
      const lanes = Math.abs(other.laneIndex - lane.laneIndex);
      if (lanes === 0 || room < lanes * ROOM_PER_LANE) continue;
      const key = keyOf(sibling, true);
      relax(heap, best, parent, { key, lane: sibling, changed: true, cost: node.cost + lanes * CHANGE_COST }, { from: node.key, connector: null });
    }
  }
  if (!reached) return null;

  // The steps, start to goal.
  const steps: { lane: LaneletId; connector: LaneletId | null }[] = [];
  for (let key = reached.key; key !== start;) {
    const step = parent.get(key);
    if (!step) return null;
    steps.push({ lane: key.endsWith('|c') ? key.slice(0, -2) : key, connector: step.connector });
    key = step.from;
  }
  steps.reverse();

  const first = steps[0];
  if (first && first.connector === null) {
    // Change lanes here first. The route is the trip as driven without it.
    const next = steps[1];
    const fallback = planTrip(w, start, startS, goal, body, false);
    return {
      route: fallback?.route ?? [start],
      changeTo: first.lane,
      intent: next?.connector ?? null,
      cost: reached.cost,
    };
  }

  const route: LaneletId[] = [start];
  for (const step of steps) {
    // The next change is made on the lane the route has reached: it ends there.
    if (step.connector === null) break;
    route.push(step.connector, step.lane);
  }
  return { route, changeTo: null, intent: null, cost: reached.cost };
}

function relax(heap: Node[], best: Map<string, number>, parent: Map<string, Step>, node: Node, step: Step): void {
  if (node.cost >= (best.get(node.key) ?? Infinity) - 1e-9) return;
  best.set(node.key, node.cost);
  parent.set(node.key, step);
  push(heap, node);
}
