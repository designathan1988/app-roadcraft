import type { LaneletGraph, LaneletId } from '@world/lanelets';
import { JAM_GAP } from '../params';
import type { SimWorld } from '../world';

/**
 * Small closed loops of road: rings of streets, roundabouts drawn as polygons.
 *
 * "Don't block the box" keeps a junction clear, but it cannot stop a CYCLE of
 * links from filling: every car let onto a ring takes a place the cars
 * already circulating need, and once every link of the ring holds a car
 * waiting for the next one, none of them can move - gridlock, measured on a
 * one-way ring of eight streets with four arms at 0.4 vehicles a minute out
 * and the whole fleet frozen for over three minutes. A real roundabout avoids
 * it because entering traffic gives way to the ring AND the ring is never
 * allowed to fill: here an entry onto a small cycle is refused while the
 * cycle is already `METER_SHARE` full. Traffic that is already on the cycle
 * is never metered, so it can always get round to its exit.
 */

/** A small closed loop of road: its lanelets and the queue it can hold. */
export interface RoadCycle {
  readonly id: number;
  /** Road a queue can stand on: the summed length of the loop's links. */
  readonly storage: number;
  readonly lanelets: ReadonlySet<LaneletId>;
}

/** Loops with more storage than this are a street network, not a ring. */
const MAX_CYCLE_STORAGE = 1400;
/** Share of a loop's storage past which nobody more is let on. */
const METER_SHARE = 0.7;

interface CycleIndex {
  readonly byLanelet: Map<LaneletId, RoadCycle[]>;
  /** The topology build it was made from: the graph is rebuilt in place. */
  readonly revision: number;
}

const indexes = new WeakMap<LaneletGraph, CycleIndex>();

function indexOf(w: SimWorld): CycleIndex {
  let index = indexes.get(w.graph);
  if (!index || index.revision !== w.topologyRevision) {
    index = { byLanelet: build(w.graph), revision: w.topologyRevision };
    indexes.set(w.graph, index);
  }
  return index;
}

/** The small loops a lanelet belongs to. Built once per topology. */
export function cyclesOf(w: SimWorld, lanelet: LaneletId): readonly RoadCycle[] {
  return indexOf(w).byLanelet.get(lanelet) ?? [];
}

/**
 * Whether a movement onto a small loop it is not already on has to wait for
 * room on it. Traffic already on a loop is never metered onto it.
 */
export function cycleFull(w: SimWorld, from: LaneletId, to: LaneletId, need: number): boolean {
  for (const cycle of cyclesOf(w, to)) {
    if (cycle.lanelets.has(from)) continue;
    let used = need;
    for (const v of w.vehicles.values()) {
      if (!cycle.lanelets.has(v.lanelet)) continue;
      used += v.archetype.length + Math.max(JAM_GAP, v.driver.s0);
    }
    if (used > cycle.storage * METER_SHARE) return true;
  }
  return false;
}

/**
 * The shortest loop through each link, without U-turns.
 *
 * The loops used to be the strongly connected components of the graph. But a
 * U-turn connector closes every two-way street on itself, so on any connected
 * city the whole network was ONE component, far larger than a ring can be,
 * and it was dropped: the breaker never acted (audit P1-22). Now each link
 * looks for its own shortest way back to itself, never by turning round, and
 * no longer than `MAX_CYCLE_STORAGE`: a roundabout, a ring of one-way streets,
 * a block driven round by its turns. A link may lie on several (the blocks
 * either side of a street); each is metered on its own. Deterministic: links
 * in sorted id order, ties broken by id.
 */
function build(graph: LaneletGraph): Map<LaneletId, RoadCycle[]> {
  const ids = [...graph.lanelets.keys()].filter((id) => graph.lanelets.get(id)?.kind === 'link').sort();
  const length = (id: LaneletId): number => {
    const lane = graph.lanelets.get(id);
    return lane?.kind === 'link' ? lane.length : 0;
  };
  /** Links reachable from a link through one connector that is not a U-turn. */
  const next = (id: LaneletId): LaneletId[] => {
    const out: LaneletId[] = [];
    for (const c of graph.exitsOf(id)) {
      const connector = graph.lanelets.get(c) as { kind: string; turn?: string; toLane?: LaneletId } | undefined;
      if (!connector || connector.turn === 'uturn' || !connector.toLane) continue;
      out.push(connector.toLane);
    }
    return out.sort();
  };

  const seen = new Map<string, RoadCycle>();
  const byLanelet = new Map<LaneletId, RoadCycle[]>();
  for (const start of ids) {
    // Dijkstra over links from the start's exits back to the start.
    const best = new Map<LaneletId, number>();
    const parent = new Map<LaneletId, LaneletId>();
    const open: { id: LaneletId; cost: number }[] = [];
    for (const n of next(start)) {
      const cost = length(start) + length(n);
      if (n === start) continue;
      if (cost <= MAX_CYCLE_STORAGE && cost < (best.get(n) ?? Infinity)) {
        best.set(n, cost);
        parent.set(n, start);
        open.push({ id: n, cost });
      }
    }
    let closing: LaneletId | null = null;
    let closingCost = Infinity;
    while (open.length) {
      open.sort((a, b) => a.cost - b.cost || (a.id < b.id ? -1 : 1));
      const { id, cost } = open.shift()!;
      if (cost > (best.get(id) ?? Infinity) || cost >= closingCost) continue;
      for (const n of next(id)) {
        if (n === start) {
          if (cost < closingCost) {
            closingCost = cost;
            closing = id;
          }
          continue;
        }
        const c = cost + length(n);
        if (c > MAX_CYCLE_STORAGE || c >= (best.get(n) ?? Infinity)) continue;
        best.set(n, c);
        parent.set(n, id);
        open.push({ id: n, cost: c });
      }
    }
    if (closing === null) continue;
    const loop: LaneletId[] = [start];
    for (let at: LaneletId | undefined = closing; at !== undefined && at !== start; at = parent.get(at)) loop.push(at);
    // The connectors between the loop's links belong to it too: a car in the
    // box between two of them is on the loop.
    const members = new Set<LaneletId>(loop);
    for (const link of loop) {
      for (const c of graph.exitsOf(link)) {
        const connector = graph.lanelets.get(c) as { toLane?: LaneletId } | undefined;
        if (connector?.toLane && members.has(connector.toLane)) members.add(c);
      }
    }
    const key = [...loop].sort().join('|');
    let cycle = seen.get(key);
    if (!cycle) {
      cycle = { id: seen.size, storage: closingCost, lanelets: members };
      seen.set(key, cycle);
      for (const id of members) {
        const list = byLanelet.get(id) ?? [];
        list.push(cycle);
        byLanelet.set(id, list);
      }
    }
  }
  return byLanelet;
}
