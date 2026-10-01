import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { m } from '@world/units';
import { step } from '@sim/pipeline';
import { DT } from '@sim/params';
import { SimWorld } from '@sim/world';
import { createPeopleEngine, inspectPeople } from '@sim/people/people';
import { blueprintByKey, instantiate } from '@world/buildings/blueprints';
import { fixtureDoc, LAYOUTS, layoutDoc } from './bodies';

/**
 * WHAT THE PLAYER SEES GO WRONG WITH THE AGENTS, measured on the drawn bodies
 * and the vehicles, in the engines the game runs (People, Drive v2):
 *
 * - `zebraStand`: longest anybody stood still on a zebra (the cars wait for
 *   them: a frozen junction);
 * - `pavementStand`: longest anybody stood still elsewhere, neither waiting at
 *   a kerb, nor queueing for one, nor sitting or talking;
 * - `fidgets`: a standing body turning its head and shoulders to and fro -
 *   over 20 degrees swung back and forth within a second - per person-minute;
 * - `back`, `side`, `jump`, `flip`: steps against the heading, sideways faster
 *   than a shuffle, teleports, side-to-side pops;
 * - `closest`: the nearest two bodies came, metres;
 * - `junction`: longest a junction had a queue at its line and let nobody in;
 * - `still`: longest any one vehicle stood without moving (a red included).
 */
export interface AgentDefects {
  name: string;
  people: number;
  vehicles: number;
  zebraStand: number;
  pavementStand: number;
  fidgets: number;
  back: number;
  side: number;
  jump: number;
  flip: number;
  closest: number;
  junction: number;
  still: number;
  /** Share of person-time given way to by everybody, and walking through people (the safety nets). */
  urgent: number;
  ghost: number;
  /** Two bodies closer than 0.4 m, per person-minute (sampled every 0.1 s). */
  overlaps: number;
}

export interface City {
  readonly name: string;
  readonly build: () => SimWorld;
  /** How long to watch it, s: a small scene longer, for its rates to mean anything. */
  readonly seconds?: number;
}

function people(sim: SimWorld, peds: number, traffic: number): SimWorld {
  sim.pedestrianIntensity = peds;
  sim.trafficIntensity = traffic;
  sim.demandMultiplier = traffic || 1;
  sim.clock.paused = false;
  sim.usePedestrianEngine(createPeopleEngine());
  sim.driveModel = 'v2';
  return sim;
}

/** `AGENT_SEED` reruns every city with other people, cars and routes. */
const SEED_SHIFT = Number(process.env.AGENT_SEED ?? 0);

function worldOf(doc: RoadDoc, seed: number): SimWorld {
  const net = new Network(doc);
  net.rebuild();
  const sim = new SimWorld(doc, net, (seed ^ (SEED_SHIFT * 0x9e3779b1)) >>> 0);
  sim.rebuildTopology();
  return sim;
}

/** The cities every change to the agents is measured on. */
export const CITIES: readonly City[] = [
  {
    name: 'player-city',
    build: () => {
      const raw = JSON.parse(readFileSync(join(process.cwd(), 'tests', 'fixtures', 'player-city.json'), 'utf8')) as { document: unknown };
      // As the player runs it: traffic and people at the game's default of 2.
      return people(worldOf(RoadDoc.fromJSON(raw.document as never), 0x2026), 2, 2);
    },
  },
  { name: 'grid-and-bends', build: () => people(worldOf(fixtureDoc(), 0x5eed), 2, 2) },
  {
    name: 'busy-crossroads',
    build: () => {
      const doc = new RoadDoc();
      const c = doc.addNode({ x: 0, y: 0 });
      for (const [x, y, type] of [[-300, 0, 3], [300, 0, 3], [0, -300, 2], [0, 300, 2]] as const) doc.addSegment(doc.addNode({ x, y }).id, c.id, type);
      doc.setNodeControl(c.id, 'signal');
      return people(worldOf(doc, 0xc055), 8, 2);
    },
  },
  {
    // A narrow street of houses, busy with parties and people coming the
    // other way: two families meeting on one pavement.
    name: 'narrow-street',
    seconds: 360,
    build: () => {
      const doc = new RoadDoc();
      const a = doc.addNode({ x: -180, y: 0 }), b = doc.addNode({ x: 180, y: 0 });
      doc.addSegment(a.id, b.id, 1);
      const net = new Network(doc); net.rebuild();
      for (const x of [-100, 0, 100]) doc.buildings.add(instantiate(blueprintByKey('house')!.body, { x, y: 55 }, 0, 'house'));
      return people(worldOf(doc, 0xbe7c), 8, 0);
    },
  },
  ...LAYOUTS.map((layout) => ({ name: layout.name, build: () => people(worldOf(layoutDoc(layout, 300).doc, 0x1a70), 6, 2) })),
];

export function measureDefects(city: City, seconds: number): AgentDefects {
  const sim = city.build();
  const U = m(1);
  const last = new Map<number, { x: number; y: number; lat: number; flips: number[] }>();
  const turns = new Map<number, { t: number; d: number }[]>();
  const still = new Map<number, number>();
  const onZebra = new Map<number, number>();
  const lastEntry = new Map<number, number>();
  const where = new Map<number, string>();
  const r: AgentDefects = {
    name: city.name, people: 0, vehicles: 0, zebraStand: 0, pavementStand: 0, fidgets: 0,
    back: 0, side: 0, jump: 0, flip: 0, closest: Infinity, junction: 0, still: 0, urgent: 0, ghost: 0, overlaps: 0,
  };
  let fidget = 0, personSeconds = 0;
  const ticks = Math.round(seconds / DT);
  for (let i = 0; i < ticks; i++) {
    step(sim, { traffic: true, pedestrians: true });
    const t = i * DT;
    const views = sim.pedViews;
    const alive = new Set(views.map((v) => v.id));
    for (const map of [still, last, turns] as Map<number, unknown>[]) for (const id of [...map.keys()]) if (!alive.has(id)) map.delete(id);
    for (const v of views) {
      personSeconds += DT;
      const busy = v.gesture !== null;
      if (v.v < m(0.1) && v.kerbWait === 0 && !busy && v.ground !== 'crossing') {
        const s = (still.get(v.id) ?? 0) + DT;
        still.set(v.id, s);
        r.pavementStand = Math.max(r.pavementStand, s);
      } else still.delete(v.id);
      // Fidgeting: standing (or all but), the heading swung to and fro.
      if (v.v < m(0.15) && !busy) {
        const list = turns.get(v.id) ?? [];
        const d = Math.atan2(Math.sin(v.heading - v.prev.heading), Math.cos(v.heading - v.prev.heading));
        list.push({ t: i, d });
        while (list.length && i - list[0]!.t >= Math.round(1 / DT)) list.shift();
        let total = 0, net = 0;
        for (const e of list) { total += Math.abs(e.d); net += e.d; }
        if (total > 0.35 && Math.abs(net) < total * 0.5) { fidget++; list.length = 0; }
        turns.set(v.id, list);
      } else turns.delete(v.id);
      const prev = last.get(v.id);
      if (!prev) { last.set(v.id, { x: v.x, y: v.y, lat: 0, flips: [] }); continue; }
      const dx = (v.x - prev.x) / U, dy = (v.y - prev.y) / U;
      const hx = Math.cos(v.heading), hy = Math.sin(v.heading);
      const fwd = (dx * hx + dy * hy) / DT, lat = (-dx * hy + dy * hx) / DT;
      if (Math.hypot(dx, dy) / DT > 3) r.jump++;
      else if (fwd < -0.25) r.back++;
      else if (Math.abs(lat) > 0.5) r.side++;
      if (Math.abs(lat) > 0.15 && prev.lat !== 0 && Math.sign(lat) !== Math.sign(prev.lat)) prev.flips.push(i);
      prev.flips = prev.flips.filter((k) => i - k < 1 / DT);
      if (prev.flips.length >= 3) { r.flip++; prev.flips.length = 0; }
      prev.x = v.x; prev.y = v.y; prev.lat = Math.abs(lat) > 0.15 ? lat : prev.lat;
    }
    if (i % 6 === 0) {
      for (let a = 0; a < views.length; a++) {
        for (let b = a + 1; b < views.length; b++) {
          const d = Math.hypot(views[a]!.x - views[b]!.x, views[a]!.y - views[b]!.y) / U;
          if (d < r.closest) r.closest = d;
          if (d < 0.4) r.overlaps++;
        }
      }
    }
    for (const v of sim.vehicles.values()) {
      const lane = sim.lanelet(v.lanelet);
      if (lane?.kind === 'connector' && where.get(v.id) !== v.lanelet) lastEntry.set(lane.node!, t);
      where.set(v.id, v.lanelet);
    }
    if (i % 30 === 0) {
      for (const q of inspectPeople(sim)) { if (q.urgent > 0) r.urgent += 1; if (q.ghost > 0) r.ghost += 1; }
    }
    if (i % 30 !== 0) continue;
    for (const v of sim.vehicles.values()) r.still = Math.max(r.still, sim.clock.since(v.lastMovedTick));
    for (const [node, junction] of sim.graph.junctions) {
      const queued = junction.inbound.some((l) => { const h = sim.laneHead(l); return h && h.v < 0.1 && sim.lanelet(l)!.length - h.s < 20; });
      if (queued) r.junction = Math.max(r.junction, t - (lastEntry.get(node) ?? 0));
      else lastEntry.set(node, t);
    }
    const seen = new Set<number>();
    for (const [, st] of sim.crossingStates) for (const p of st.occupants) {
      seen.add(p.id);
      const s = p.v < m(0.05) ? (onZebra.get(p.id) ?? 0) + 30 * DT : 0;
      onZebra.set(p.id, s);
      r.zebraStand = Math.max(r.zebraStand, s);
    }
    for (const id of [...onZebra.keys()]) if (!seen.has(id)) onZebra.delete(id);
  }
  r.people = sim.pedViews.length;
  r.vehicles = sim.vehicles.size;
  r.fidgets = fidget / Math.max(1, personSeconds) * 60;
  // Per person-minute: a busier city has more of everything.
  r.side = r.side / Math.max(1, personSeconds) * 60;
  r.flip = r.flip / Math.max(1, personSeconds) * 60;
  r.overlaps = r.overlaps * 6 * DT / Math.max(1, personSeconds) * 60;
  r.urgent = r.urgent * 30 * DT / Math.max(1, personSeconds);
  r.ghost = r.ghost * 30 * DT / Math.max(1, personSeconds);
  return r;
}

export function formatDefects(r: AgentDefects): string {
  const f = (x: number, d = 1) => x.toFixed(d);
  return `${r.name.padEnd(18)} people ${String(r.people).padStart(3)} cars ${String(r.vehicles).padStart(3)} | zebra ${f(r.zebraStand)}s pavement ${f(r.pavementStand)}s fidget ${f(r.fidgets, 2)}/min | back ${r.back} side ${f(r.side, 3)}/min jump ${r.jump} flip ${f(r.flip, 3)}/min closest ${f(r.closest, 2)}m overlap ${f(r.overlaps, 3)}/min | junction ${f(r.junction, 0)}s still ${f(r.still, 0)}s | nets urgent ${f(r.urgent * 100, 2)}% ghost ${f(r.ghost * 100, 2)}%`;
}
