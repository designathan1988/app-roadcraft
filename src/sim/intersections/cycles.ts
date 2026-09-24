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

/** A strongly connected set of lanelets whose storage is small enough to lock. */
export interface RoadCycle {
  readonly id: number;
  /** Road a queue can stand on: the summed length of the cycle's links. */
  readonly storage: number;
}

/** Cycles with more storage than this are a street network, not a ring. */
const MAX_CYCLE_STORAGE = 1400;
/** Share of a cycle's storage past which nobody more is let on. */
const METER_SHARE = 0.7;

interface CycleIndex {
  readonly byLanelet: Map<LaneletId, RoadCycle>;
  /** The topology build it was made from: the graph is rebuilt in place. */
  readonly revision: number;
}

const indexes = new WeakMap<LaneletGraph, CycleIndex>();

/** The small cycle a lanelet belongs to, or undefined. Built once per topology. */
export function cycleOf(w: SimWorld, lanelet: LaneletId): RoadCycle | undefined {
  let index = indexes.get(w.graph);
  if (!index || index.revision !== w.topologyRevision) {
    index = { ...build(w.graph), revision: w.topologyRevision };
    indexes.set(w.graph, index);
  }
  return index.byLanelet.get(lanelet);
}

/** Whether a movement from outside onto a small cycle has to wait for room on it. */
export function cycleFull(w: SimWorld, from: LaneletId, to: LaneletId, need: number): boolean {
  const cycle = cycleOf(w, to);
  if (!cycle || cycleOf(w, from) === cycle) return false;
  let used = need;
  for (const v of w.vehicles.values()) {
    if (cycleOf(w, v.lanelet) !== cycle) continue;
    used += v.archetype.length + Math.max(JAM_GAP, v.driver.s0);
  }
  return used > cycle.storage * METER_SHARE;
}

/**
 * Tarjan's strongly connected components over links and connectors, iterative
 * so a long network cannot overflow the stack. Deterministic: lanelets are
 * visited in sorted id order.
 */
function build(graph: LaneletGraph): Omit<CycleIndex, 'revision'> {
  const ids = [...graph.lanelets.keys()].sort();
  const successors = (id: LaneletId): readonly LaneletId[] => {
    const lane = graph.lanelets.get(id);
    if (!lane) return [];
    if (lane.kind === 'connector') return lane.toLane ? [lane.toLane] : [];
    return graph.exitsOf(id);
  };

  const index = new Map<LaneletId, number>();
  const low = new Map<LaneletId, number>();
  const onStack = new Set<LaneletId>();
  const stack: LaneletId[] = [];
  const components: LaneletId[][] = [];
  let counter = 0;

  for (const root of ids) {
    if (index.has(root)) continue;
    const work: { id: LaneletId; next: number }[] = [{ id: root, next: 0 }];
    index.set(root, counter);
    low.set(root, counter);
    counter++;
    stack.push(root);
    onStack.add(root);
    while (work.length) {
      const frame = work[work.length - 1]!;
      const out = successors(frame.id);
      if (frame.next < out.length) {
        const to = out[frame.next++]!;
        if (!index.has(to)) {
          index.set(to, counter);
          low.set(to, counter);
          counter++;
          stack.push(to);
          onStack.add(to);
          work.push({ id: to, next: 0 });
        } else if (onStack.has(to)) {
          low.set(frame.id, Math.min(low.get(frame.id)!, index.get(to)!));
        }
        continue;
      }
      work.pop();
      const parent = work[work.length - 1];
      if (parent) low.set(parent.id, Math.min(low.get(parent.id)!, low.get(frame.id)!));
      if (low.get(frame.id) === index.get(frame.id)) {
        const component: LaneletId[] = [];
        let member: LaneletId | undefined;
        do {
          member = stack.pop()!;
          onStack.delete(member);
          component.push(member);
        } while (member !== frame.id);
        if (component.length > 1) components.push(component);
      }
    }
  }

  const byLanelet = new Map<LaneletId, RoadCycle>();
  components.forEach((component, i) => {
    let storage = 0;
    for (const id of component) {
      const lane = graph.lanelets.get(id);
      if (lane?.kind === 'link') storage += lane.length;
    }
    if (storage <= 0 || storage > MAX_CYCLE_STORAGE) return;
    const cycle: RoadCycle = { id: i, storage };
    for (const id of component) byLanelet.set(id, cycle);
  });
  return { byLanelet };
}
