import { describe, expect, it } from 'vitest';

import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import type { NodeId } from '@world/ids';
import { SimWorld } from '@sim/world';
import { rebindPeds, rebindVehicles } from '@sim/pipeline';
import { commitDraft } from '@editor/commit';

/**
 * A corner path may be reused across builds, and this proves the reuse is
 * free of consequences: the same graph, built once answering from the last
 * build's corners and once from nothing, must come out identical.
 *
 * It is the guard the reuse needs. A stale corner is not a wrong number in a
 * report — it is a footway that stops short of the kerb it belongs to, and a
 * walker stepping over the gap.
 */

function gridDoc(n = 5, spacing = 150): RoadDoc {
  const doc = new RoadDoc();
  const ids: NodeId[][] = [];
  const origin = -((n - 1) * spacing) / 2;
  for (let i = 0; i < n; i++) {
    ids.push([]);
    for (let j = 0; j < n; j++) ids[i]!.push(doc.addNode({ x: origin + i * spacing, y: origin + j * spacing }).id);
  }
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i + 1 < n) doc.addSegment(ids[i]![j]!, ids[i + 1]![j]!, 1);
      if (j + 1 < n) doc.addSegment(ids[i]![j]!, ids[i]![j + 1]!, 1);
    }
  }
  return doc;
}

/**
 * Every edge of the graph, with the exact points of its path and the exact
 * walls of its corridor: a corner reused by path, a footway reused by walls.
 */
function graphShape(sim: SimWorld): string[] {
  const out: string[] = [];
  for (const [id, edge] of sim.sidewalks.edges) {
    const points = edge.path.toPoints().map((p) => `${p.x},${p.y}`).join(';');
    const lo = Array.from(edge.corridor.lo).join(',');
    const hi = Array.from(edge.corridor.hi).join(',');
    out.push(`${id}|${edge.kind}|${points}|${lo}|${hi}`);
  }
  return out.sort();
}

const clearCaches = (sim: SimWorld): void => {
  const s = sim.sidewalks as unknown as { cornerCache: Map<string, unknown>; corridorCache: Map<string, unknown> };
  s.cornerCache.clear();
  s.corridorCache.clear();
};

describe('the sidewalk corner cache', () => {
  it('gives the same corner the same path, reused or rebuilt', () => {
    const doc = gridDoc();
    const net = new Network(doc);
    net.rebuild();
    const sim = new SimWorld(doc, net, 0x51ce);
    sim.rebuildTopology();

    // A street drawn inside one block: most of the map's junctions stay put.
    commitDraft(doc, net, { kind: 'free', at: { x: -120, y: -120 } }, { kind: 'free', at: { x: 40, y: -120 } }, 1);
    net.rebuild();
    sim.rebuildVehicleTopology(); rebindVehicles(sim);
    sim.rebuildWalkTopology(); rebindPeds(sim);
    const reused = graphShape(sim);

    clearCaches(sim);
    sim.rebuildWalkTopology(); rebindPeds(sim);
    const rebuilt = graphShape(sim);

    expect(reused.length).toBeGreaterThan(20);
    expect(reused).toEqual(rebuilt);
  });

  it('gives the same corner the same path after a road across the map', () => {
    const doc = gridDoc();
    const net = new Network(doc);
    net.rebuild();
    const sim = new SimWorld(doc, net, 0x51ce);
    sim.rebuildTopology();

    commitDraft(doc, net, { kind: 'free', at: { x: -320, y: -75 } }, { kind: 'free', at: { x: 320, y: -75 } }, 1);
    net.rebuild();
    sim.rebuildVehicleTopology(); rebindVehicles(sim);
    sim.rebuildWalkTopology(); rebindPeds(sim);
    const reused = graphShape(sim);

    clearCaches(sim);
    sim.rebuildWalkTopology(); rebindPeds(sim);
    const rebuilt = graphShape(sim);

    expect(reused.length).toBeGreaterThan(20);
    expect(reused).toEqual(rebuilt);
  });
});
