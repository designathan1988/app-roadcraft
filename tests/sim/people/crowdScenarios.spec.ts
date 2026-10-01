import { beforeAll, describe, expect, it } from 'vitest';
import { appendFileSync } from 'node:fs';
import { Network } from '@world/network';
import { SimWorld } from '@sim/world';
import { step } from '@sim/pipeline';
import { DT } from '@sim/params';
import { m } from '@world/units';
import { blocksPedestrians, streetFurniture } from '@world/streetFurniture';
import { POLE_BASE_RADIUS } from '@world/utilities';
import { addScriptedWalker, createCrowdEngine, initCrowd, inspectCrowd } from '@sim/people/crowd';
import { AGENT_RADIUS } from '@sim/people/crowdNav';
import { SCENARIOS, type Scenario } from '../../fixtures/crowdScenarios';

/**
 * The crowd engine on a fixed battery of reproducible scenarios
 * (`tests/fixtures/crowdScenarios.ts`): what the player must never see,
 * measured on the bodies as published. These DETECT defects; they do not
 * define the mechanics. Each scenario is also looked at in the game.
 */
interface Result {
  name: string;
  arrived: number;
  walkers: number;
  /** Longest time anybody took to arrive, s. */
  slowestTrip: number;
  /** Closest two bodies came (different parties), m; and as a share of two radii. */
  closest: number;
  closestShare: number;
  /** Deepest a body came into an obstacle, m (negative: never touched). */
  intoObstacle: number;
  /** Velocity reversals: the way moved turning over 120 degrees within half a second, both above 0.2 m/s. */
  reversals: number;
  /** Ticks moved against the facing faster than 0.1 m/s. */
  backward: number;
  /**
   * Ticks a body was displaced faster than 0.1 m/s while its own velocity
   * was under 0.03 m/s: moved without stepping - shoved by a collision -
   * which no animation can show as anything but a slide. (A person at rest
   * that steps aside for somebody moves with a velocity of its own.)
   */
  slides: number;
  /** Seconds bodies moved at 0.03-0.14 m/s (drawn standing while displaced): total, and longest spell. */
  creep: number;
  creepSpell: number;
  /** Ticks a body moved faster than 3 m/s. */
  jumps: number;
  /** Strongest acceleration of a body (over a quarter second), m/s². */
  accel: number;
  /** Fastest turn of the body, rad/s. */
  turn: number;
  /** Longest a person meaning to walk (not standing at its place) stood still, s. */
  stood: number;
  /** Longest anybody got nowhere while wanting to move (starvation), s. */
  starved: number;
  /** Times people gave way, and targets passed to Detour per person-minute. */
  yields: number;
  replansPerMin: number;
  /** Ticks somebody stood on a zebra it had not been let onto. */
  trespass: number;
}

function run(sc: Scenario): Result {
  const doc = sc.doc;
  const net = new Network(doc);
  net.rebuild();
  const sim = new SimWorld(doc, net, 0x5ce7);
  sim.rebuildTopology();
  sim.pedestrianIntensity = 0;
  sim.trafficIntensity = 0;
  sim.clock.paused = false;
  sim.usePedestrianEngine(createCrowdEngine());
  step(sim, { traffic: false, pedestrians: true });
  const ids: number[] = [];
  for (const wk of sc.walkers(net)) {
    const id = addScriptedWalker(sim, { x: wk.x, y: wk.y, goal: wk.goal, ...(wk.pace !== undefined ? { pace: wk.pace } : {}),
      ...(wk.leader !== undefined ? { leader: ids[wk.leader]! } : {}) });
    ids.push(id ?? -1);
  }
  const U = m(1);
  const obstacles = [
    ...streetFurniture(net).filter(blocksPedestrians).map((f) => ({ x: f.x, y: f.y, r: f.halfWidth ?? f.radius })),
    ...[...doc.poles.values()].map((p) => ({ x: p.x, y: p.y, r: POLE_BASE_RADIUS })),
  ];
  const r: Result = { name: sc.name, arrived: 0, walkers: ids.filter((i) => i >= 0).length, slowestTrip: 0, closest: Infinity, closestShare: Infinity,
    intoObstacle: -Infinity, reversals: 0, backward: 0, slides: 0, creep: 0, creepSpell: 0, jumps: 0, accel: 0, turn: 0, stood: 0, starved: 0,
    yields: 0, replansPerMin: 0, trespass: 0 };
  const lastDir = new Map<number, { a: number; t: number }>();
  const still = new Map<number, number>();
  const creeping = new Map<number, number>();
  const vel = new Map<number, { x: number; y: number }[]>();
  const arrivedAt = new Map<number, number>();
  const ticks = Math.round(sc.seconds / DT);
  for (let t = 0; t < ticks; t++) {
    step(sim, { traffic: false, pedestrians: true });
    const inner = new Map(inspectCrowd(sim).map((q) => [q.id, q]));
    const views = sim.pedViews;
    for (const v of views) {
      const q = inner.get(v.id);
      const dx = (v.x - v.prev.x) / U, dy = (v.y - v.prev.y) / U;
      const sp = Math.hypot(dx, dy) / DT;
      if (sp > 3) r.jumps++;
      if (sp > 0.1 && (dx * Math.cos(v.heading) + dy * Math.sin(v.heading)) / DT < -0.1) r.backward++;
      if (q && sp > 0.1 && q.speed / U < 0.03) r.slides++;
      if (sp > 0.03 && sp < 0.14) {
        r.creep += DT;
        const c = (creeping.get(v.id) ?? 0) + DT; creeping.set(v.id, c); r.creepSpell = Math.max(r.creepSpell, c);
      } else creeping.delete(v.id);
      const hist = vel.get(v.id) ?? [];
      hist.push({ x: dx / DT, y: dy / DT });
      if (hist.length > 16) hist.shift();
      vel.set(v.id, hist);
      if (hist.length === 16) r.accel = Math.max(r.accel, Math.hypot(hist[15]!.x - hist[0]!.x, hist[15]!.y - hist[0]!.y) / (15 * DT));
      let dh = v.heading - v.prev.heading;
      dh = Math.atan2(Math.sin(dh), Math.cos(dh));
      r.turn = Math.max(r.turn, Math.abs(dh) / DT);
      if (sp > 0.2) {
        const a = Math.atan2(dy, dx);
        const prev = lastDir.get(v.id);
        if (prev && t - prev.t < 0.5 / DT && Math.abs(Math.atan2(Math.sin(a - prev.a), Math.cos(a - prev.a))) > (2 * Math.PI) / 3) r.reversals++;
        lastDir.set(v.id, { a, t });
      }
      if (sp < 0.05 && !q?.holding) { const s = (still.get(v.id) ?? 0) + DT; still.set(v.id, s); r.stood = Math.max(r.stood, s); }
      else still.delete(v.id);
      if (q) {
        r.starved = Math.max(r.starved, q.blocked);
        if (q.onZebra && !q.granted.includes(q.onZebra)) r.trespass++;
        if (!arrivedAt.has(v.id) && q.leader === null && Math.hypot(q.goal.x - q.x, q.goal.y - q.y) < m(1.5)) arrivedAt.set(v.id, t * DT);
      }
      for (const f of obstacles) {
        const d = Math.hypot(v.x - f.x, v.y - f.y) / U - f.r / U;
        r.intoObstacle = Math.max(r.intoObstacle, AGENT_RADIUS / U - d);
      }
    }
    for (let i = 0; i < views.length; i++) for (let j = i + 1; j < views.length; j++) {
      if (views[i]!.party.id === views[j]!.party.id) continue;
      r.closest = Math.min(r.closest, Math.hypot(views[i]!.x - views[j]!.x, views[i]!.y - views[j]!.y) / U);
    }
  }
  const end = inspectCrowd(sim);
  for (const q of end) {
    // A companion goes where its leader goes: arrived when the leader has, and it is by the leader.
    const lead = q.leader !== null ? end.find((l) => l.id === q.leader) : undefined;
    const there = lead
      ? Math.hypot(lead.goal.x - lead.x, lead.goal.y - lead.y) < m(1.5) && Math.hypot(lead.x - q.x, lead.y - q.y) < m(2)
      : Math.hypot(q.goal.x - q.x, q.goal.y - q.y) < m(1.5);
    if (there) r.arrived++;
    r.yields += q.yields;
    r.replansPerMin += q.replans;
  }
  r.replansPerMin /= Math.max(1, end.length) * (sc.seconds / 60);
  r.slowestTrip = Math.max(0, ...arrivedAt.values());
  r.closestShare = r.closest / (2 * AGENT_RADIUS / U);
  return r;
}

const REPORT = process.env.CROWD_REPORT;
const ONLY = process.env.SC?.split(',');
describe('crowd scenarios', () => {
  beforeAll(async () => { await initCrowd(); });
  for (const sc of SCENARIOS) {
    if (ONLY && !ONLY.includes(sc.name)) continue;
    it(sc.name, () => {
      const r = run(sc);
      const round = (x: number, k = 2): number => +x.toFixed(k);
      if (REPORT) appendFileSync(REPORT, `${JSON.stringify({ ...r, closest: round(r.closest), closestShare: round(r.closestShare), intoObstacle: round(r.intoObstacle),
        turn: round(r.turn, 1), stood: round(r.stood, 1), starved: round(r.starved, 1), creep: round(r.creep, 1), creepSpell: round(r.creepSpell, 1),
        accel: round(r.accel, 1), slowestTrip: round(r.slowestTrip, 1), replansPerMin: round(r.replansPerMin, 1) })}\n`);
      expect(r.walkers).toBeGreaterThan(0);
      expect(r.arrived, 'everybody gets where they were going').toBe(r.walkers);
      expect(r.jumps).toBe(0);
      expect(r.slides).toBe(0);
      expect(r.closestShare, 'bodies never inside each other').toBeGreaterThan(0.9);
      expect(r.intoObstacle, 'bodies never inside an obstacle').toBeLessThan(0.01);
      expect(r.reversals).toBe(0);
      expect(r.backward).toBe(0);
      expect(r.stood).toBeLessThan(6);
      expect(r.starved).toBeLessThan(10);
      expect(r.trespass).toBe(0);
    }, 300_000);
  }
});
