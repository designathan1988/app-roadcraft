import type { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { SimWorld } from '@sim/world';
import { step } from '@sim/pipeline';
import { DT, WAIT_CEILING } from '@sim/params';
import { vehiclePose } from '@sim/pose';
import type { Vehicle } from '@sim/vehicles/state';
import { collisions } from '../../sim/support/bodies';
import type { Defect } from './invariants';

/**
 * What the fuzzer asserts about TRAFFIC on a network that built cleanly.
 *
 * Audit codes (`sim/invariants.ts`, full level) are reported under their own
 * code; the rest are measured here from the drawn bodies:
 *  - `bodyOverlap`  two vehicle rectangles intersecting (tests/sim/support/bodies.ts);
 *  - `poseJump`     a body moving further in one tick than its speed allows;
 *  - `nonFinite`    a NaN position or speed;
 *  - `stalled`      a vehicle standing still longer than `STALL_LIMIT`.
 */
export interface SimRun {
  readonly seconds: number;
  readonly seed: number;
  readonly intensity: number;
}

/** Ten times the longest a driver will hold out for a comfortable gap. */
export const STALL_LIMIT = 10 * WAIT_CEILING;

/**
 * Audit codes that are congestion diagnostics rather than defects on their
 * own; `stalled` below is the measured form of the same question.
 */
const DIAGNOSTIC = new Set(['shortLink']);

/** The structural levels and road nodes a vehicle's body spans. */
function placeOf(sim: SimWorld, v: Vehicle): { structures: Set<string>; nodes: Set<number> } {
  const structures = new Set<string>();
  const nodes = new Set<number>();
  for (const id of [v.lanelet, ...v.rearPath.slice(0, 3)]) {
    const lane = sim.lanelet(id);
    if (!lane) continue;
    for (const seg of lane.kind === 'link' ? [lane.segment] : [sim.connector(id)?.inSegment, sim.connector(id)?.outSegment]) {
      const segment = seg === undefined ? undefined : sim.doc.segment(seg);
      if (!segment) continue;
      structures.add(segment.structure);
      nodes.add(segment.a);
      nodes.add(segment.b);
    }
  }
  return { structures, nodes };
}

export function checkSim(doc: RoadDoc, run: SimRun): Defect[] {
  const net = new Network(doc);
  net.rebuild();
  const sim = new SimWorld(doc, net, run.seed);
  sim.rebuildTopology();
  sim.trafficIntensity = run.intensity;
  sim.demandMultiplier = run.intensity;
  sim.auditEnabled = true;
  sim.auditLevel = 'full';
  sim.clock.paused = false;

  const out: Defect[] = [];
  const seen = new Set<string>();
  const add = (category: string, subject: string, detail: string): void => {
    // One report per category and subject: a stuck car is one defect, not 7000.
    const key = `${category}|${subject}`;
    if (seen.has(key) || out.length > 40) return;
    seen.add(key);
    out.push({ category, subject, detail });
  };

  const last = new Map<number, { x: number; y: number }>();
  const still = new Map<number, number>();
  let reported = 0;
  sim.clock.run(Math.round(run.seconds / DT), () => {
    step(sim, { traffic: true, pedestrians: true });
    const tick = sim.clock.tick;

    for (; reported < sim.issues.length; reported++) {
      const issue = sim.issues[reported];
      if (issue && !DIAGNOSTIC.has(issue.code)) add(issue.code, issue.subject, `t=${(issue.tick * DT).toFixed(1)} ${issue.detail}`);
    }
    // `issues` is a ring of 512; keep the cursor valid once it starts shifting.
    if (sim.issues.length >= 512) { sim.issues.length = 0; reported = 0; }

    for (const v of sim.vehiclesInIdOrder()) {
      if (!Number.isFinite(v.s) || !Number.isFinite(v.v)) { add('nonFinite', `veh ${v.id}`, `s=${v.s} v=${v.v}`); continue; }
      const pose = vehiclePose(sim, v, 1);
      if (!pose) continue;
      if (!Number.isFinite(pose.p.x) || !Number.isFinite(pose.p.y)) { add('nonFinite', `veh ${v.id}`, 'pose'); continue; }
      const before = last.get(v.id);
      if (before) {
        const moved = Math.hypot(pose.p.x - before.x, pose.p.y - before.y);
        const allowed = Math.max(v.v, v.prev.v) * DT * 2 + 0.75;
        if (moved > allowed) add('poseJump', `veh ${v.id}`, `t=${(tick * DT).toFixed(1)} moved ${moved.toFixed(2)} > ${allowed.toFixed(2)} on ${v.lanelet}`);
      }
      last.set(v.id, { x: pose.p.x, y: pose.p.y });
      const idle = v.v < 0.05 ? (still.get(v.id) ?? 0) + DT : 0;
      still.set(v.id, idle);
      if (idle > STALL_LIMIT) {
        const kinds = v.constraints.obstacles.map((o) => o.kind).join(',');
        add('stalled', `veh ${v.id}`, `t=${(tick * DT).toFixed(1)} still ${idle.toFixed(0)}s on ${v.lanelet} [${kinds}]`);
      }
    }
    for (const id of [...last.keys()]) if (!sim.vehicles.has(id as never)) { last.delete(id); still.delete(id); }

    if (tick % 6 === 0) {
      for (const hit of collisions(sim)) {
        const a = placeOf(sim, hit.a);
        const b = placeOf(sim, hit.b);
        // A deck over a road: two levels, no contact.
        if (![...a.structures].some((s) => b.structures.has(s))) continue;
        // Two roads that share no node, bodies touching: the roads overlap.
        const related = [...a.nodes].some((n) => b.nodes.has(n));
        add(related ? 'bodyOverlap' : 'unrelatedBodyOverlap', `veh ${hit.a.id}/${hit.b.id}`,
          `t=${(tick * DT).toFixed(1)} ${hit.category} ${hit.a.lanelet} / ${hit.b.lanelet}`);
      }
    }
  });
  return out;
}
