import type { LaneletId } from '@world/lanelets';
import type { BodyClass } from '@world/conflictPoints';
import type { SimWorld } from '../world';

interface RouteStep {
  readonly lane: LaneletId;
  readonly cost: number;
}

interface Parent {
  readonly lane: LaneletId;
  readonly connector: LaneletId;
}

interface ReachableCache {
  revision: number;
  exits: Map<LaneletId, readonly LaneletId[]>;
}

const reachable = new WeakMap<SimWorld, ReachableCache>();

const compare = (a: RouteStep, b: RouteStep): number =>
  a.cost - b.cost || (a.lane < b.lane ? -1 : a.lane > b.lane ? 1 : 0);

function push(heap: RouteStep[], value: RouteStep): void {
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

function pop(heap: RouteStep[]): RouteStep | undefined {
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

function boundaryExit(w: SimWorld, id: LaneletId): boolean {
  const lane = w.lanelet(id);
  return !!lane && lane.kind === 'link' && lane.to !== undefined &&
    w.doc.degree(lane.to) === 1 && w.graph.exitsOf(id).length === 0;
}

/** Stable reachability per entry and topology revision; traffic cost stays live. */
function reachableExits(w: SimWorld, start: LaneletId, body: BodyClass): readonly LaneletId[] {
  let cache = reachable.get(w);
  if (!cache || cache.revision !== w.net.trafficRevision) {
    cache = { revision: w.net.trafficRevision, exits: new Map() };
    reachable.set(w, cache);
  }
  const cacheKey = `${start}|${body}|${w.driveModel}`;
  const known = cache.exits.get(cacheKey);
  if (known) return known;
  const seen = new Set<LaneletId>([start]);
  const queue: LaneletId[] = [start];
  const exits: LaneletId[] = [];
  for (let i = 0; i < queue.length; i++) {
    const lane = queue[i]!;
    if (lane !== start && boundaryExit(w, lane)) exits.push(lane);
    for (const id of w.graph.exitsOf(lane)) {
      const connector = w.connector(id);
      if (!connector || connector.maxBodyClass < body) continue;
      const next = connector?.toLane;
      if (!next || seen.has(next) || w.rt(next).ghost) continue;
      seen.add(next);
      queue.push(next);
    }
    // Drive v2 changes lane on the way (`drive/tactical.ts`): what a sibling
    // lane reaches, this one reaches too.
    if (w.driveModel === 'v2') {
      for (const next of w.graph.siblingLanes(lane)) {
        if (seen.has(next) || w.rt(next).ghost) continue;
        seen.add(next);
        queue.push(next);
      }
    }
  }
  exits.sort();
  cache.exits.set(cacheKey, exits);
  return exits;
}

/** Chooses one reachable trip endpoint, once, when a vehicle enters the city. */
export function chooseVehicleDestination(w: SimWorld, start: LaneletId, body: BodyClass): LaneletId | null {
  const exits = reachableExits(w, start, body);
  if (exits.length === 0) return null;
  return exits[Math.floor(w.rng.route.float() * exits.length)] ?? exits[0] ?? null;
}

/** Least-time lanelet route to a fixed endpoint, with congestion priced at planning time. */
export function routeToDestination(w: SimWorld, start: LaneletId, goal: LaneletId, body: BodyClass): LaneletId[] | null {
  if (start === goal) return [start];
  if (!w.lanelet(start) || !w.lanelet(goal) || w.rt(goal).ghost) return null;
  const best = new Map<LaneletId, number>([[start, 0]]);
  const parent = new Map<LaneletId, Parent>();
  const heap: RouteStep[] = [];
  push(heap, { lane: start, cost: 0 });

  while (heap.length) {
    const current = pop(heap)!;
    if (current.cost > (best.get(current.lane) ?? Infinity) + 1e-9) continue;
    if (current.lane === goal) {
      const route: LaneletId[] = [goal];
      let lane = goal;
      while (lane !== start) {
        const step = parent.get(lane);
        if (!step) return null;
        route.unshift(step.lane, step.connector);
        lane = step.lane;
      }
      return route;
    }
    for (const id of w.graph.exitsOf(current.lane)) {
      const connector = w.connector(id);
      const out = connector && w.lanelet(connector.toLane);
      if (!connector || connector.maxBodyClass < body || !out || out.kind !== 'link' || w.rt(out.id).ghost) continue;
      const density = w.rt(out.id).order.length / Math.max(1, out.length / 12);
      const travel = out.length / Math.max(0.5, out.speedLimit) * (1 + density * 2.6);
      const turn = connector.turn === 'uturn' ? 4 : connector.turn === 'through' ? 0 : 0.35;
      const cost = current.cost + connector.length / Math.max(0.5, out.speedLimit * 0.65) + travel + turn;
      if (cost >= (best.get(out.id) ?? Infinity) - 1e-9) continue;
      best.set(out.id, cost);
      parent.set(out.id, { lane: current.lane, connector: id });
      push(heap, { lane: out.id, cost });
    }
  }
  return null;
}
