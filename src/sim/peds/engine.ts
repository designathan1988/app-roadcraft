import type { LaneletId } from '@world/lanelets';
import { issue, type AuditIssue } from '../audit';
import { maxCycle } from '../invariants';
import { PED } from '../params';
import type { Boarder, PedestrianEngine, PeopleBridge } from '../people/engine';
import type { SimWorld } from '../world';
import { stepPedestrians } from './crossingFsm';
import { publishPedViews } from './publish';
import { rebindPeds } from './rebind';
import type { SidewalkEdge } from './sidewalk';
import { stepPedDispatch } from './spawn';
import { createPed, pedSnapshot, type Ped } from './state';

/**
 * The sidewalk-graph pedestrian model behind `PedestrianEngine`: edges with a
 * lateral offset, the crossing state machine and its kerb slots. It stays
 * until the People engine matches it on the metrics (People P6).
 */
export const legacyPedestrians: PedestrianEngine = {
  kind: 'legacy',
  beginTick(w) {
    for (const p of w.peds.values()) p.prev = pedSnapshot(p);
  },
  dispatch: stepPedDispatch,
  step: stepPedestrians,
  rebind: rebindPeds,
  publish: publishPedViews,
  audit: auditPedestrians,
  // `SimWorld.reset` clears everything this model keeps.
  reset() {},
  bridge: {
    hailable,
    board(w, id, door, reach) {
      const ped = w.peds.get(id);
      if (!ped || ped.state !== 'Walking' || ped.activity || ped.trailing !== null ||
          Math.hypot(ped.x - door.x, ped.y - door.y) > reach) return null;
      w.peds.delete(ped.id);
      return { seed: ped.id, gender: ped.gender, ageClass: ped.ageClass, footX: ped.x, footY: ped.y, footHeading: ped.heading };
    },
    alight,
    anyoneWithin(w, x, y, radius, except) {
      for (const ped of w.peds.values()) {
        if (ped.id !== except && Math.hypot(ped.x - x, ped.y - y) < radius) return true;
      }
      return false;
    },
  } satisfies PeopleBridge,
};

/** A pedestrian walking alone on the kerb-side footway between `s0` and `s1` of the lane. */
function hailable(w: SimWorld, lanelet: LaneletId, s0: number, s1: number,
  exclude: ReadonlySet<number> = new Set()): { id: number; s: number } | null {
  const lane = w.lanelet(lanelet);
  if (!lane) return null;
  let best: { ped: Ped; s: number } | null = null;
  for (const ped of w.pedsInIdOrder()) {
    if (ped.state !== 'Walking' || ped.party.size !== 1 || ped.ageClass === 'child' || ped.activity) continue;
    // Somebody another member of a party is pacing would be left behind.
    if (ped.trailing !== null || exclude.has(ped.id)) continue;
    const edge = w.sidewalks.edges.get(ped.edge);
    if (edge?.kind !== 'walk' || edge.segment !== lane.segment) continue;
    const hit = lane.centre.closestPoint({ x: ped.x, y: ped.y });
    if (hit.s < s0 || hit.s > s1) continue;
    const f = lane.centre.sampleAt(hit.s);
    if ((ped.x - f.p.x) * f.t.y - (ped.y - f.p.y) * f.t.x <= 0) continue;
    if (!best || hit.s < best.s) best = { ped, s: hit.s };
  }
  return best ? { id: best.ped.id, s: best.s } : null;
}

/** The dropped-off passenger, as a pedestrian standing where they got out. */
function alight(w: SimWorld, person: Boarder): void {
  let edge: SidewalkEdge | undefined;
  let s = 0;
  let lat = 0;
  let best = Infinity;
  for (const candidate of w.sidewalks.edges.values()) {
    if (candidate.kind !== 'walk') continue;
    const hit = candidate.path.closestPoint({ x: person.footX, y: person.footY });
    if (hit.distance < best) {
      best = hit.distance;
      edge = candidate;
      s = hit.s;
      const f = candidate.path.sampleAt(hit.s);
      lat = (person.footX - f.p.x) * f.n.x + (person.footY - f.p.y) * f.n.y;
    }
  }
  // The person keeps the id they had in the seat (`seatPerson`), unless
  // somebody of that id is already walking about.
  if (!edge || w.peds.has(person.seed)) return;
  const id = person.seed;
  const speed = PED.meanSpeed;
  const ped = createPed({
    id,
    color: '#5d6b7a',
    speed,
    file: id % PED.files,
    ageClass: person.ageClass,
    gender: person.gender,
    party: { id, size: 1, archetype: 'solo', pace: speed, hasChild: false, goal: null, trip: 0 },
    rank: 0,
    edge: edge.id,
    entry: edge.from,
    s,
    lat: Math.max(-edge.halfWidth * 0.8, Math.min(edge.halfWidth * 0.8, lat)),
    tick: w.clock.tick,
  });
  ped.x = person.footX;
  ped.y = person.footY;
  ped.heading = person.footHeading;
  ped.v = 0;
  ped.prev = pedSnapshot(ped);
  w.peds.set(id, ped);
}

/** The legacy model's own sentinels: its crossing state machine against its edges. */
function auditPedestrians(w: SimWorld, out: AuditIssue[]): void {
  const tick = w.clock.tick;
  for (const p of w.peds.values()) {
    const edge = w.sidewalks.edges.get(p.edge);
    if (!edge) continue;

    if (p.state === 'Crossing' && w.clock.since(p.lastMovedTick) > 3) {
      out.push(issue('pedInRoadStalled', tick, p.id, 'no progress while crossing'));
    }

    if (p.state === 'WaitAtKerb' && p.waited > 2 * maxCycle(w)) {
      out.push(issue('pedFrozen', tick, p.id, `waited ${p.waited.toFixed(1)}s`));
    }

    // A pedestrian may only be inside a junction while on a crossing edge.
    if (edge.kind !== 'crossing' && p.state === 'Crossing') {
      out.push(issue('pedOutsideSidewalk', tick, p.id, 'crossing state off a crossing edge'));
    }
  }
}
