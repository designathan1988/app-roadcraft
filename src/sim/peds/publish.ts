import type { SimWorld } from '../world';
import { emptyCrossingState, type CrossingOccupant, type CrossingState } from '../crossings/state';
import type { Ped, PedActivity } from './state';
import type { GestureView, PedGround } from '../people/view';
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

/** One gesture object per activity, so a renderer sees a new gesture only when there is one. */
const gestures = new WeakMap<PedActivity, GestureView>();

function gestureOf(activity: PedActivity | null): GestureView | null {
  if (!activity) return null;
  let gesture = gestures.get(activity);
  if (!gesture) {
    gesture = { kind: activity.kind, phase: activity.phase, t: activity.t };
    gestures.set(activity, gesture);
  }
  gesture.phase = activity.phase;
  gesture.t = activity.t;
  return gesture;
}

const groundOf = (edge: SidewalkEdge): PedGround =>
  edge.kind === 'access' ? 'open' : edge.kind === 'crossing' ? 'crossing' : 'footway';

/**
 * The legacy model's answer to `SimWorld.pedViews`: one view per person on a
 * known edge, in id order, the same object for an id for as long as it lives.
 */
export function publishPedViews(w: SimWorld): void {
  const views = w.pedViews;
  const byId = w.pedViewById;
  views.length = 0;
  for (const p of w.pedsInIdOrder()) {
    const edge = w.sidewalks.edges.get(p.edge);
    if (!edge) continue;
    let view = byId.get(p.id);
    if (!view) {
      view = {
        id: p.id, x: 0, y: 0, heading: 0, prev: { x: 0, y: 0, heading: 0 }, v: 0, turnV: 0, age: 0,
        ageClass: p.ageClass, gender: p.gender, party: p.party, rank: p.rank,
        ground: 'footway', segment: undefined, stretch: '', walking: false, kerbWait: 0, waitingFor: null, gesture: null,
      };
      byId.set(p.id, view);
    }
    view.x = p.x;
    view.y = p.y;
    view.heading = p.heading;
    view.prev.x = p.prev.x;
    view.prev.y = p.prev.y;
    view.prev.heading = p.prev.heading;
    view.v = p.v;
    view.turnV = p.turnV;
    view.age = p.age;
    view.party = p.party;
    view.rank = p.rank;
    view.ground = groundOf(edge);
    view.segment = edge.segment;
    view.stretch = `${p.edge}|${p.entry}`;
    view.walking = p.state === 'Walking' && p.pause <= 0;
    const waiting = p.state === 'WaitAtKerb';
    view.kerbWait = waiting ? p.waited : 0;
    view.waitingFor = waiting ? p.route[0] ?? null : null;
    view.gesture = gestureOf(p.activity);
    views.push(view);
  }
  if (byId.size > views.length) {
    for (const id of byId.keys()) if (!w.peds.has(id)) byId.delete(id);
  }
}
