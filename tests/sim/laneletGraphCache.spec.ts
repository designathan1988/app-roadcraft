import { describe, expect, it } from 'vitest';

import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import type { NodeId } from '@world/ids';
import { SimWorld } from '@sim/world';
import { rebindVehicles } from '@sim/pipeline';
import { commitDraft } from '@editor/commit';

/**
 * The link lanelets a road edit did not touch are reused as they were built.
 * This is the guard that reuse needs: the graph built answering from the last
 * build must be the graph a build from nothing makes, lanelet for lanelet.
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

/** Every lanelet, connector and junction of the graph, by the numbers that matter. */
function graphShape(sim: SimWorld): string[] {
  const out: string[] = [];
  for (const [id, l] of sim.graph.lanelets) {
    const centre = l.centre.toPoints().map((p) => `${p.x},${p.y}`).join(';');
    out.push(`L|${id}|${l.kind}|${centre}|${l.length}|${l.speedLimit}|${l.segment}|${l.from}|${l.to}|${l.laneIndex}|${l.controlled}`);
  }
  for (const [id, c] of sim.graph.connectors) {
    out.push(`C|${id}|${c.node}|${c.fromLane}|${c.toLane}|${c.inSegment}|${c.outSegment}|${c.turn}|${c.carried}|${c.group}|${c.length}|${c.maxBodyClass}`);
  }
  for (const [node, j] of sim.graph.junctions) {
    out.push(`J|${node}|${j.groups.map((g) => `${g.id}:${g.segments.join(',')}`).join(';')}|${j.connectors.join(',')}|${j.inbound.join(',')}|${j.signalised}|${j.control}`);
  }
  return out.sort();
}

describe('the lanelet graph cache', () => {
  it('builds the same graph reused or from nothing', () => {
    const doc = gridDoc();
    const net = new Network(doc);
    net.rebuild();
    const sim = new SimWorld(doc, net, 0x51ce);
    sim.rebuildTopology();

    // A street inside one block: most of the map's segments stay put.
    commitDraft(doc, net, { kind: 'free', at: { x: -120, y: -120 } }, { kind: 'free', at: { x: 40, y: -120 } }, 1);
    net.rebuild();
    sim.rebuildVehicleTopology(); rebindVehicles(sim);
    const reused = graphShape(sim);

    (sim.graph as unknown as { linkCache: Map<string, unknown> }).linkCache.clear();
    sim.rebuildVehicleTopology(); rebindVehicles(sim);
    const rebuilt = graphShape(sim);

    expect(reused.length).toBeGreaterThan(50);
    expect(reused).toEqual(rebuilt);
  });

  it('builds the same graph after a road across the map', () => {
    const doc = gridDoc();
    const net = new Network(doc);
    net.rebuild();
    const sim = new SimWorld(doc, net, 0x51ce);
    sim.rebuildTopology();

    commitDraft(doc, net, { kind: 'free', at: { x: -320, y: -75 } }, { kind: 'free', at: { x: 320, y: -75 } }, 1);
    net.rebuild();
    sim.rebuildVehicleTopology(); rebindVehicles(sim);
    const reused = graphShape(sim);

    (sim.graph as unknown as { linkCache: Map<string, unknown> }).linkCache.clear();
    sim.rebuildVehicleTopology(); rebindVehicles(sim);
    const rebuilt = graphShape(sim);

    expect(reused.length).toBeGreaterThan(50);
    expect(reused).toEqual(rebuilt);
  });
});
