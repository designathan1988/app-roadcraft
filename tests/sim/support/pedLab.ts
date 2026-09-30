import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { SimWorld } from '@sim/world';
import { step } from '@sim/pipeline';
import { DT, PED } from '@sim/params';
import { m } from '@world/units';
import { createPed, pedSnapshot, type Ped, type PedAgeClass, type PedParty } from '@sim/peds/state';
import type { SidewalkEdge } from '@sim/peds/sidewalk';
import { blocksPedestrians, streetFurniture } from '@world/streetFurniture';
import { SIGNAL_POST_RADIUS, signalPosts } from '@world/signalPosts';

/**
 * THE PEDESTRIAN LAB: controlled scenes, measured the way a player sees them.
 *
 * Each scene is a small map built for one situation - a footway with its
 * lamps, trees, bins and benches; two people meeting head on; a fast walker
 * behind a slow one; a party walking together; a crowd both ways - with the
 * walkers placed exactly, the spawner off and the traffic off. `runLab`
 * steps it and measures, every tick, on the DRAWN body position:
 *
 *   contact     seconds a body is inside street furniture (edge distance
 *               under a body's radius) or inside another body
 *   stuck       seconds a walker with somewhere to go stands still
 *   lateBrake   hard slowdowns with an obstruction within 1.5 m ahead: the
 *               walker saw it too late and had to brake in front of it
 *   weave       reversals of sideways motion per minute: zigzag
 *   turnRate    mean heading change while walking, deg/s
 *   speed       mean walking speed, m/s
 *   minFurniture / minPerson   the closest approaches, m
 *
 * The footway's own furniture comes from the same generator the game uses
 * (`world/streetFurniture.ts`), so the obstacles are the real ones.
 */

export interface LabWalker {
  /** Which footway side: the longest walk edge on the -1 or +1 side of the street. */
  readonly side: -1 | 1;
  /** Along the footway from the direction's start, metres. */
  readonly at: number;
  /** Across the footway, metres from its centre (+ to the walker's left). */
  readonly lat?: number;
  /** Walking towards the street's +x end (true) or -x end (false). */
  readonly east: boolean;
  /** Free walking speed, m/s. */
  readonly speed?: number;
  /** Members of one party share this key. */
  readonly party?: number;
  readonly ageClass?: PedAgeClass;
}

export interface LabScene {
  readonly sim: SimWorld;
  /** The walkers measured; empty for everybody the spawner puts on the map. */
  readonly walkers: readonly Ped[];
  /** Whether vehicles run too (a crossroads). */
  readonly traffic?: boolean;
}

/**
 * A signalised crossroads: an avenue across a street, both 600 u long, with
 * zebras, kerbs and signal posts, traffic running and the spawner putting
 * people on every footway - crossings, kerb queues and corners, as a player
 * sees them at any junction.
 */
export function labCrossroads(intensity = 3): SimWorld {
  const doc = new RoadDoc();
  const c = doc.addNode({ x: 0, y: 0 });
  for (const [x, y, type] of [[-300, 0, 2], [300, 0, 2], [0, -300, 1], [0, 300, 1]] as const) {
    doc.addSegment(doc.addNode({ x, y }).id, c.id, type);
  }
  doc.setNodeControl(c.id, 'signal');
  const net = new Network(doc);
  net.rebuild();
  const sim = new SimWorld(doc, net, 0xc055);
  sim.rebuildTopology();
  sim.pedestrianIntensity = intensity;
  sim.trafficIntensity = 1;
  sim.demandMultiplier = 1;
  sim.clock.paused = false;
  return sim;
}

/** A straight street, long enough to walk a minute along, with footways and their furniture. */
export function labStreet(type = 2, length = 600): { doc: RoadDoc; net: Network; sim: SimWorld } {
  const doc = new RoadDoc();
  const a = doc.addNode({ x: -length / 2, y: 0 });
  const b = doc.addNode({ x: length / 2, y: 0 });
  doc.addSegment(a.id, b.id, type);
  const net = new Network(doc);
  net.rebuild();
  const sim = new SimWorld(doc, net, 0x1ab);
  sim.rebuildTopology();
  sim.pedestrianIntensity = 0;
  sim.trafficIntensity = 0;
  sim.clock.paused = false;
  return { doc, net, sim };
}

/** The longest walk edge on one side of the street (by the sign of its centre's y). */
function footway(sim: SimWorld, side: -1 | 1): SidewalkEdge {
  const edges = [...sim.sidewalks.edges.values()].filter((e) => e.kind === 'walk');
  const onSide = edges.filter((e) => Math.sign(e.path.sampleAt(e.length / 2).p.y) === side);
  return onSide.sort((p, q) => q.length - p.length)[0]!;
}

/** Puts walkers on the lab street. */
export function placeWalkers(sim: SimWorld, walkers: readonly LabWalker[]): Ped[] {
  const parties = new Map<number, PedParty>();
  const out: Ped[] = [];
  for (const w of walkers) {
    const edge = footway(sim, w.side);
    const start = edge.path.sampleAt(0).p;
    const eastward = edge.path.sampleAt(edge.length).p.x > start.x;
    const entry = eastward === w.east ? edge.from : edge.to;
    const speed = m(w.speed ?? 1.34);
    const key = w.party ?? -1 - out.length;
    let party = parties.get(key);
    if (!party) {
      const size = walkers.filter((q) => (q.party ?? Number.NaN) === key).length || 1;
      party = { id: sim.nextPedId, size, archetype: size > 1 ? 'friends' : 'solo', pace: PED.maxSpeed, hasChild: false, goal: null, trip: 0 };
      parties.set(key, party);
    }
    (party as { pace: number }).pace = Math.min(party.pace, speed);
    const id = sim.nextPedId++;
    const ped = createPed({
      id, color: '#888', speed, file: 0, ageClass: w.ageClass ?? 'adult', gender: id % 2 ? 'f' : 'm',
      party, rank: out.filter((q) => q.party === party).length, edge: edge.id, entry,
      s: m(w.at), lat: m(w.lat ?? 0), tick: sim.clock.tick,
    });
    const frame = sim.sidewalks.orientedPath(edge, entry).sampleAt(ped.s);
    ped.x = frame.p.x + frame.n.x * ped.lat;
    ped.y = frame.p.y + frame.n.y * ped.lat;
    ped.heading = Math.atan2(frame.t.y, frame.t.x);
    ped.prev = pedSnapshot(ped);
    sim.peds.set(ped.id, ped);
    out.push(ped);
  }
  const members = new Map<PedParty, Ped[]>();
  for (const p of out) members.set(p.party, [...(members.get(p.party) ?? []), p]);
  for (const list of members.values()) for (let i = 0; i < list.length - 1; i++) list[i]!.trailing = list[i + 1]!.id;
  return out;
}

export interface LabResult {
  pedSeconds: number;
  furnitureContact: number;
  personContact: number;
  stuck: number;
  lateBrake: number;
  weavePerMinute: number;
  turnRate: number;
  speed: number;
  minFurniture: number;
  minPerson: number;
  /** For each walker, ground covered along its way, m. */
  progress: number[];
  /** Sideways reversals per 100 m walked. */
  zigzagPer100m: number;
  /** Angle between facing and motion while walking, p95, degrees. */
  sideslipP95: number;
  /** Nearest neighbour among people waiting at a kerb, p5 and p50, m. */
  waitSpacingP5: number;
  waitSpacingP50: number;
}

const BODY = 0.3;

/** Steps a scene for `seconds` and measures it. */
export function runLab(scene: LabScene, seconds: number): LabResult {
  const { sim } = scene;
  const everybody = scene.walkers.length === 0;
  let walkers: readonly Ped[] = scene.walkers;
  interface Item { x: number; y: number; radius: number; along?: { x: number; y: number }; halfLength?: number; halfWidth?: number }
  const items: Item[] = streetFurniture(sim.net).filter(blocksPedestrians);
  for (const post of signalPosts(sim.net, sim.graph)) items.push({ x: post.x, y: post.y, radius: SIGNAL_POST_RADIUS });
  const edgeDistance = (item: Item, x: number, y: number): number => {
    const dx = x - item.x, dy = y - item.y;
    if (item.halfLength === undefined || item.halfWidth === undefined || !item.along) return Math.hypot(dx, dy) - item.radius;
    const along = Math.abs(dx * item.along.x + dy * item.along.y) - item.halfLength;
    const across = Math.abs(-dx * item.along.y + dy * item.along.x) - item.halfWidth;
    return Math.hypot(Math.max(0, along), Math.max(0, across)) + Math.min(0, Math.max(along, across));
  };
  const r: LabResult = { pedSeconds: 0, furnitureContact: 0, personContact: 0, stuck: 0, lateBrake: 0,
    weavePerMinute: 0, turnRate: 0, speed: 0, minFurniture: Infinity, minPerson: Infinity, progress: [],
    zigzagPer100m: 0, sideslipP95: 0, waitSpacingP5: 0, waitSpacingP50: 0 };
  const slips: number[] = [];
  const waits: number[] = [];
  let walked = 0;
  const lastLat = new Map<number, number>();
  const lastSpeed = new Map<number, number>();
  const start = new Map<number, { x: number; y: number }>();
  let reversals = 0, walkSeconds = 0, turnSum = 0, speedSum = 0;
  for (const p of walkers) start.set(p.id, { x: p.x, y: p.y });
  for (let t = 0; t < Math.round(seconds / DT); t++) {
    step(sim, { traffic: scene.traffic ?? false, pedestrians: true });
    if (everybody) walkers = [...sim.peds.values()];
    const waiting = walkers.filter((q) => q.state === 'WaitAtKerb');
    for (const q of waiting) {
      let nearest = Infinity;
      for (const o of waiting) if (o !== q) nearest = Math.min(nearest, Math.hypot(o.x - q.x, o.y - q.y) / m(1));
      if (nearest < 5) waits.push(nearest);
    }
    for (const p of walkers) {
      if (!sim.peds.has(p.id)) continue;
      r.pedSeconds += DT;
      const metre = m(1);
      const moved = Math.hypot(p.x - p.prev.x, p.y - p.prev.y) / metre / DT;
      // Nearest furniture, and whether it is ahead within 1.5 m.
      let nearest = Infinity, ahead = false;
      for (const item of items) {
        const d = edgeDistance(item, p.x, p.y) / metre;
        if (d < nearest) nearest = d;
        const fx = item.x - p.x, fy = item.y - p.y;
        if (d < 1.5 && fx * Math.cos(p.heading) + fy * Math.sin(p.heading) > 0) ahead = true;
      }
      r.minFurniture = Math.min(r.minFurniture, nearest - BODY);
      if (nearest < BODY) r.furnitureContact += DT;
      for (const q of sim.peds.values()) {
        if (q === p) continue;
        const d = Math.hypot(q.x - p.x, q.y - p.y) / metre;
        if (d < r.minPerson + 2 * BODY) r.minPerson = d - 2 * BODY;
        if (d < 2 * BODY * 0.9) { r.personContact += DT / 2; }
      }
      const busy = p.activity !== null || p.state !== 'Walking';
      if (!busy && moved < 0.1) r.stuck += DT;
      const before = lastSpeed.get(p.id) ?? moved;
      if (!busy && ahead && before - moved > 1.2 * DT * 60 * DT * 10) r.lateBrake += DT;
      lastSpeed.set(p.id, moved);
      if (!busy && moved > 0.5) {
        const mx = p.x - p.prev.x, my = p.y - p.prev.y;
        slips.push(Math.abs(Math.atan2(Math.sin(Math.atan2(my, mx) - p.heading), Math.cos(Math.atan2(my, mx) - p.heading))) * 180 / Math.PI);
      }
      if (!busy && moved > 0.3) {
        walked += moved * DT;
        walkSeconds += DT;
        speedSum += moved * DT;
        const dh = Math.abs(Math.atan2(Math.sin(p.heading - p.prev.heading), Math.cos(p.heading - p.prev.heading))) / DT;
        turnSum += dh * 180 / Math.PI * DT;
        const latV = p.lat - p.prev.lat;
        const was = lastLat.get(p.id) ?? 0;
        if (Math.abs(latV) > m(0.05) * DT && Math.sign(latV) !== Math.sign(was) && was !== 0) reversals++;
        if (Math.abs(latV) > m(0.05) * DT) lastLat.set(p.id, latV);
      }
    }
  }
  const q = (xs: number[], f: number): number => xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(f * (xs.length - 1))]! : 0;
  r.sideslipP95 = q(slips, 0.95);
  r.waitSpacingP5 = q(waits, 0.05);
  r.waitSpacingP50 = q(waits, 0.5);
  r.zigzagPer100m = walked > 0 ? reversals / (walked / 100) : 0;
  for (const p of everybody ? [] : walkers) {
    const s0 = start.get(p.id)!;
    r.progress.push(+(Math.hypot(p.x - s0.x, p.y - s0.y) / m(1)).toFixed(1));
  }
  r.weavePerMinute = walkSeconds > 0 ? reversals / (walkSeconds / 60) : 0;
  r.turnRate = walkSeconds > 0 ? turnSum / walkSeconds : 0;
  r.speed = walkSeconds > 0 ? speedSum / walkSeconds : 0;
  return r;
}

/** The standard scenes, by name. */
export const LAB_SCENES: Record<string, () => LabScene> = {
  /** A signalised crossroads with traffic and the spawner: crossings, kerb queues, corners. */
  crossroads: () => ({ sim: labCrossroads(), walkers: [], traffic: true }),
  /** One walker along a footway full of lamps, bins, benches, hydrants and trees, near the kerb edge. */
  soloKerbside: () => {
    const { sim } = labStreet();
    return { sim, walkers: placeWalkers(sim, [{ side: 1, at: 20, lat: -0.5, east: true }]) };
  },
  /** One walker on the building side. */
  soloInside: () => {
    const { sim } = labStreet();
    return { sim, walkers: placeWalkers(sim, [{ side: -1, at: 20, lat: 0.5, east: false }]) };
  },
  /** Two strangers meeting head on. */
  headOn: () => {
    const { sim } = labStreet();
    const edge = footway(sim, 1);
    const len = edge.length / m(1);
    return { sim, walkers: placeWalkers(sim, [
      { side: 1, at: 40, lat: 0, east: true },
      { side: 1, at: len - 70, lat: 0, east: false },
    ]) };
  },
  /** A brisk walker behind a slow one: should pass, not trail. */
  overtake: () => {
    const { sim } = labStreet();
    return { sim, walkers: placeWalkers(sim, [
      { side: 1, at: 30, lat: 0, east: true, speed: 0.8 },
      { side: 1, at: 20, lat: 0, east: true, speed: 1.6 },
    ]) };
  },
  /** A party of three, and a stranger coming the other way. */
  party: () => {
    const { sim } = labStreet();
    const edge = footway(sim, -1);
    const len = edge.length / m(1);
    return { sim, walkers: placeWalkers(sim, [
      { side: -1, at: 30, lat: -0.4, east: true, party: 1 },
      { side: -1, at: 30, lat: 0.4, east: true, party: 1 },
      { side: -1, at: 29, lat: 0, east: true, party: 1 },
      { side: -1, at: len - 80, lat: 0, east: false },
    ]) };
  },
  /** Twelve strangers, both ways, at their own paces. */
  crowd: () => {
    const { sim } = labStreet();
    const edge = footway(sim, 1);
    const len = edge.length / m(1);
    const walkers: LabWalker[] = [];
    for (let i = 0; i < 12; i++) {
      const east = i % 2 === 0;
      walkers.push({ side: 1, at: east ? 20 + i * 4 : len - 80 - i * 4, lat: ((i * 37) % 7 - 3) * 0.25, east,
        speed: 1.1 + ((i * 53) % 9) * 0.06 });
    }
    return { sim, walkers: placeWalkers(sim, walkers) };
  },
};
