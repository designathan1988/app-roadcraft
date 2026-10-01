import { describe, expect, it } from 'vitest';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { SimWorld } from '@sim/world';
import { cyclesOf } from '@sim/intersections/cycles';

/**
 * P1-22: the ring breaker meters entries onto small loops so they never fill
 * and lock. U-turns made every two-way street a loop of its own, the whole
 * city one strongly connected component, too big to be a ring - and nothing
 * was ever metered. Loops are now the shortest way round without turning back.
 */
describe('small loops of road', () => {
  it('are found on a connected grid of two-way streets: its blocks', () => {
    const doc = new RoadDoc();
    const n: number[][] = [];
    for (let i = 0; i < 3; i++) {
      n.push([]);
      for (let j = 0; j < 3; j++) n[i]!.push(doc.addNode({ x: i * 120, y: j * 120 }).id);
    }
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
      if (i < 2) doc.addSegment(n[i]![j]!, n[i + 1]![j]!, 1);
      if (j < 2) doc.addSegment(n[i]![j]!, n[i]![j + 1]!, 1);
    }
    const net = new Network(doc);
    net.rebuild();
    const sim = new SimWorld(doc, net, 1);
    sim.rebuildTopology();
    const links = [...sim.graph.lanelets.values()].filter((l) => l.kind === 'link');
    const onLoops = links.filter((l) => cyclesOf(sim, l.id).length > 0);
    // Every street of the grid is on some block's loop.
    expect(onLoops.length).toBe(links.length);
    for (const l of onLoops) {
      for (const c of cyclesOf(sim, l.id)) {
        // A block: four links, about 4 x 120 of road (less the junctions).
        expect(c.storage).toBeLessThan(4 * 120 + 1);
        expect(c.storage).toBeGreaterThan(2 * 120);
      }
    }
  });

  it('are not found on a lone two-way street, where only a U-turn comes back', () => {
    const doc = new RoadDoc();
    const a = doc.addNode({ x: 0, y: 0 });
    const b = doc.addNode({ x: 200, y: 0 });
    doc.addSegment(a.id, b.id, 1);
    const net = new Network(doc);
    net.rebuild();
    const sim = new SimWorld(doc, net, 1);
    sim.rebuildTopology();
    for (const l of sim.graph.lanelets.values()) expect(cyclesOf(sim, l.id)).toEqual([]);
  });
});
