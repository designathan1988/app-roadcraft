import { dist } from '@core/vec2';
import { m } from '@world/units';
import { PED_BEHAVIOUR, edgePreference } from './behaviour';
import type { SidewalkEdgeId, SidewalkGraph, SidewalkNodeId } from './sidewalk';

interface SearchState { node: SidewalkNodeId; first: SidewalkEdgeId | null; cost: number; estimate: number }

/** The next edge on a shortest walk to a chosen destination. */
export function nextTowardGoal(graph: SidewalkGraph, start: SidewalkNodeId,
  goal: SidewalkNodeId, previous: SidewalkEdgeId, party: number): SidewalkEdgeId | undefined {
  const destination = graph.nodes.get(goal)?.at;
  if (!destination || start === goal) return undefined;
  const origin = graph.nodes.get(start)?.at;
  if (!origin) return undefined;
  const best = new Map<SidewalkNodeId, number>([[start, 0]]);
  const queue: SearchState[] = [{ node: start, first: null, cost: 0, estimate: dist(origin, destination) }];
  while (queue.length) {
    const current = pop(queue)!;
    if (current.cost > (best.get(current.node) ?? Infinity) + 1e-8) continue;
    if (current.node === goal) return current.first ?? undefined;
    for (const edgeId of graph.edgesAt(current.node)) {
      const edge = graph.edges.get(edgeId);
      if (!edge) continue;
      const other = graph.other(edge, current.node);
      const at = graph.nodes.get(other)?.at;
      if (!at) continue;
      const cost = current.cost + edge.length +
        (edge.kind === 'crossing' ? PED_BEHAVIOUR.crossingPenalty : 0) +
        (edgeId === previous ? m(2) : 0) +
        edgePreference(party, edgeId) * 0.08;
      if (cost >= (best.get(other) ?? Infinity)) continue;
      best.set(other, cost);
      push(queue, { node: other, first: current.first ?? edgeId,
        cost, estimate: cost + dist(at, destination) });
    }
  }
  return undefined;
}

function push(queue: SearchState[], item: SearchState): void {
  let at = queue.length;
  queue.push(item);
  while (at > 0) {
    const parent = (at - 1) >> 1;
    if (queue[parent]!.estimate <= item.estimate) break;
    queue[at] = queue[parent]!;
    at = parent;
  }
  queue[at] = item;
}

function pop(queue: SearchState[]): SearchState | undefined {
  const first = queue[0];
  const tail = queue.pop();
  if (!first || !tail || !queue.length) return first;
  let at = 0;
  while (true) {
    let child = at * 2 + 1;
    if (child >= queue.length) break;
    if (child + 1 < queue.length && queue[child + 1]!.estimate < queue[child]!.estimate) child++;
    if (tail.estimate <= queue[child]!.estimate) break;
    queue[at] = queue[child]!;
    at = child;
  }
  queue[at] = tail;
  return first;
}
