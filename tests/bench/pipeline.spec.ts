import { writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import type { NodeId } from '@world/ids';
import { buildRoadElevation } from '@world/elevation';
import { sampleTerrainHeight } from '@world/terrain';
import { BLUEPRINTS } from '@world/buildings/blueprints';
import { SimWorld } from '@sim/world';
import { rebindAgents, step } from '@sim/pipeline';
import { DT } from '@sim/params';
import { commitDraft } from '@editor/commit';
import { instantiate } from '@editor/buildings';

/**
 * THE HEADLESS BENCHMARK (`node scripts/bench-sim.mjs`, BENCH=1).
 *
 * A large seeded map - a 9 x 9 grid of streets and avenues, 144 segments -
 * with traffic and pedestrians pushed to the population ceiling, measured two
 * ways:
 *  - milliseconds per tick for every pipeline stage (`StepOptions.timings`),
 *    plus the calls and time of the per-tick helpers that were candidates;
 *  - milliseconds per edit for each kind of edit, the way main.ts pays for it
 *    (a road: commitDraft, the network rebuild of mutateBuilt, the simulation
 *    topology; a pole: the same, because it moves `doc.revision`; a building:
 *    its own store; a terrain dab: the road elevation re-solve against the
 *    new ground).
 * Results go to the console and to BENCH_OUT (JSON) when set.
 */
const WARM_SECONDS = Number(process.env['BENCH_WARM'] ?? 90);
const MEASURE_TICKS = Number(process.env['BENCH_TICKS'] ?? 600);
const EDIT_REPEATS = Number(process.env['BENCH_EDITS'] ?? 5);

function gridDoc(n = 9, spacing = 150): RoadDoc {
  const doc = new RoadDoc();
  const ids: NodeId[][] = [];
  const origin = -((n - 1) * spacing) / 2;
  for (let i = 0; i < n; i++) {
    ids.push([]);
    for (let j = 0; j < n; j++) ids[i]!.push(doc.addNode({ x: origin + i * spacing, y: origin + j * spacing }).id);
  }
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const avenue = (k: number): number => (k % 3 === 0 ? 3 : 1);
      if (i + 1 < n) doc.addSegment(ids[i]![j]!, ids[i + 1]![j]!, avenue(j));
      if (j + 1 < n) doc.addSegment(ids[i]![j]!, ids[i]![j + 1]!, avenue(i));
    }
  }
  return doc;
}

const time = (fn: () => void): number => {
  const t0 = performance.now();
  fn();
  return performance.now() - t0;
};
const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;

describe('benchmark', () => {
  it.runIf(process.env['BENCH'] === '1')('measures ticks and edits on a large map', () => {
    const doc = gridDoc();
    const net = new Network(doc);
    net.rebuild();
    const sim = new SimWorld(doc, net, 0xbe7c);
    sim.rebuildTopology();
    sim.trafficIntensity = 8;
    sim.pedestrianIntensity = 8;
    sim.demandMultiplier = 1;
    sim.clock.paused = false;

    sim.clock.run(Math.round(WARM_SECONDS / DT), () => step(sim));

    // Count and time the helpers the analysis named, without changing them.
    const helpers = new Map<string, { calls: number; ms: number }>();
    const wrap = <T extends object, K extends keyof T>(target: T, key: K, name: string): void => {
      const original = target[key] as unknown as (...args: unknown[]) => unknown;
      (target as Record<K, unknown>)[key] = function (this: unknown, ...args: unknown[]) {
        const t0 = performance.now();
        const out = original.apply(this, args);
        const entry = helpers.get(name) ?? { calls: 0, ms: 0 };
        entry.calls++;
        entry.ms += performance.now() - t0;
        helpers.set(name, entry);
        return out;
      } as unknown as T[K];
    };
    wrap(sim, 'vehiclesInIdOrder', 'vehiclesInIdOrder');
    wrap(sim, 'pedsInIdOrder', 'pedsInIdOrder');
    const deps = sim.signalDeps.bind(sim);
    sim.signalDeps = () => {
      const d = deps();
      const out = { ...d };
      wrap(out, 'pedestrianDemandOn', 'pedestrianDemandOn');
      if (out.pedestrianWait) wrap(out as { pedestrianWait: NonNullable<typeof out.pedestrianWait> }, 'pedestrianWait', 'pedestrianWait');
      return out;
    };

    const timings = new Map<string, number>();
    const population = { vehicles: 0, peds: 0 };
    const total = time(() => sim.clock.run(MEASURE_TICKS, () => {
      step(sim, { timings });
      population.vehicles += sim.vehicles.size;
      population.peds += sim.peds.size;
    }));

    const perTick = Object.fromEntries([...timings].sort().map(([k, v]) => [k, +(v / MEASURE_TICKS).toFixed(3)]));
    const helperRows = Object.fromEntries([...helpers].map(([k, v]) =>
      [k, { callsPerTick: +(v.calls / MEASURE_TICKS).toFixed(1), msPerTick: +(v.ms / MEASURE_TICKS).toFixed(3) }]));

    // ---- edits -----------------------------------------------------------
    const edits: Record<string, Record<string, number>> = {};
    const record = (kind: string, parts: Record<string, number[]>): void => {
      edits[kind] = Object.fromEntries(Object.entries(parts).map(([k, xs]) => [k, +median(xs).toFixed(2)]));
    };
    {
      const parts = { commitDraft: [] as number[], networkRebuild: [] as number[], simTopology: [] as number[] };
      for (let i = 0; i < EDIT_REPEATS; i++) {
        const y = -520 + 75 + i * 150;
        parts.commitDraft.push(time(() => commitDraft(doc, net, { kind: 'free', at: { x: -700, y } }, { kind: 'free', at: { x: 700, y } }, 1)));
        parts.networkRebuild.push(time(() => net.rebuild()));
        parts.simTopology.push(time(() => { sim.rebuildTopology(); rebindAgents(sim); }));
      }
      record('road', parts);
    }
    {
      const parts = { addPole: [] as number[], networkRebuild: [] as number[], simTopology: [] as number[] };
      for (let i = 0; i < EDIT_REPEATS; i++) {
        const revision = doc.revision;
        parts.addPole.push(time(() => {
          const a = doc.addPole({ x: -600 + i * 40, y: -610 });
          const b = doc.addPole({ x: -580 + i * 40, y: -610 });
          doc.addPoleSpan(a.id, b.id);
        }));
        // main.ts's mutateBuilt rebuilds the network after any edit, and the
        // simulation catches up whenever `doc.revision` moved.
        parts.networkRebuild.push(time(() => net.rebuild()));
        parts.simTopology.push(doc.revision !== revision ? time(() => { sim.rebuildTopology(); rebindAgents(sim); }) : 0);
      }
      record('pole', parts);
    }
    {
      const parts = { addBuilding: [] as number[], networkRebuildNeeded: [] as number[] };
      const blueprint = BLUEPRINTS[0]!;
      for (let i = 0; i < EDIT_REPEATS; i++) {
        const revision = doc.revision;
        parts.addBuilding.push(time(() => doc.buildings.add(instantiate(blueprint.body, { x: -635 + i * 40, y: 640 }, 0, blueprint.key))));
        parts.networkRebuildNeeded.push(doc.revision !== revision ? 1 : 0);
      }
      record('building', parts);
    }
    {
      const parts = { addStamp: [] as number[], roadElevation: [] as number[] };
      for (let i = 0; i < EDIT_REPEATS; i++) {
        parts.addStamp.push(time(() => doc.addTerrainStamp({ x: -300 + i * 30, y: 200, radius: 60, strength: 4, mode: 'raise' } as never)));
        const stamps = doc.terrainStamps;
        parts.roadElevation.push(time(() => buildRoadElevation(net, (x, y) => sampleTerrainHeight(stamps, x, y))));
      }
      record('terrain', parts);
    }

    const result = {
      map: { segments: doc.segments.size, nodes: doc.nodes.size },
      population: { vehicles: Math.round(population.vehicles / MEASURE_TICKS), pedestrians: Math.round(population.peds / MEASURE_TICKS) },
      msPerTick: { total: +(total / MEASURE_TICKS).toFixed(3), ...perTick },
      helpers: helperRows,
      msPerEdit: edits,
    };
    console.log(JSON.stringify(result, null, 2));
    if (process.env['BENCH_OUT']) writeFileSync(process.env['BENCH_OUT'], JSON.stringify(result, null, 2) + '\n');
    expect(result.population.vehicles).toBeGreaterThan(0);
  });
});
