import type { SimWorld } from '../world';
import { emptyCrossingState, type CrossingOccupant, type CrossingState } from '../crossings/state';
import type { Ped } from './state';
import type { SidewalkEdge } from './sidewalk';

/** Below this pace somebody on a crossing is standing, not walking. */
const PED_WALKING = 0.3;
/** Held up this long, standing on the crossing: waiting, not arriving. */
const PED_HELD = 2;

/** Where this pedestrian stands on a crossing, in the published frame. */
export function occupantOf(p: Ped, edge: SidewalkEdge): CrossingOccupant {
  const forward = p.entry === edge.from;
  return {
    id: p.id,
    s: forward ? p.s : edge.length - p.s,
    forward,
    v: p.v,
    held: p.v < PED_WALKING && p.stuck > PED_HELD,
  };
}

/**
 * The legacy pedestrian model's answer to `SimWorld.crossingStates`: built at
 * the end of its stage (and after a rebind), from its own occupancy, waiting
 * and route state. The same facts the vehicles and signals used to read out
 * of the model directly, so behaviour is unchanged.
 */
export function publishCrossingStates(w: SimWorld): void {
  const states = w.crossingStates;
  states.clear();
  const edgeOf = (crossing: string): SidewalkEdge | undefined =>
    w.sidewalks.edges.get(w.sidewalks.crossings.get(crossing) ?? '');
  const stateOf = (crossing: string): CrossingState | null => {
    const existing = states.get(crossing);
    if (existing) return existing;
    const edge = edgeOf(crossing);
    if (!edge) return null;
    const state = emptyCrossingState(edge.length);
    states.set(crossing, state);
    return state;
  };

  for (const [crossing, ids] of w.pedOccupancy) {
    const edge = edgeOf(crossing);
    const state = stateOf(crossing);
    if (!edge || !state) continue;
    for (const id of ids) {
      const p = w.peds.get(id);
      if (p) state.occupants.push(occupantOf(p, edge));
    }
  }
  for (const [crossing, count] of w.pedWaiting) {
    const state = stateOf(crossing);
    if (!state) continue;
    state.waitingFrom = count.from;
    state.waitingTo = count.to;
  }
  for (const p of w.peds.values()) {
    if (p.state !== 'ApproachKerb' && p.state !== 'WaitAtKerb') continue;
    const next = p.route[0];
    const edge = next ? w.sidewalks.edges.get(next) : undefined;
    if (!edge?.crossing) continue;
    const state = stateOf(edge.crossing);
    if (!state) continue;
    if (edge.kind === 'crossing') state.demand = true;
    if (p.state === 'WaitAtKerb') state.longestWait = Math.max(state.longestWait, p.waited);
  }
}
