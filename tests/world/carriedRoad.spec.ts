import { describe, expect, it } from 'vitest';

import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { LaneletGraph } from '@world/lanelets';
import type { NodeId } from '@world/ids';

/**
 * A ROAD THAT BENDS AT A NODE IS STILL ONE ROAD.
 *
 * `classifyTurn` calls anything bending more than 30 degrees a turn, and turns
 * are paired lane to lane from their own side: a left from the innermost lane
 * into the innermost lane. So a two-lane carriageway bending 45 degrees at a
 * node kept lane 0 and merged lane 1 into it through the no-route fallback -
 * every bend in a polyline road was a lane drop - and a ring of streets, which
 * bends at every node, carried one lane with a merge at each of them.
 */

function graphOf(doc: RoadDoc): LaneletGraph {
  const net = new Network(doc);
  net.rebuild();
  const graph = new LaneletGraph();
  graph.build(doc, net);
  return graph;
}

/** `lane index in` -> `lane index out` for every connector from one segment into another, at a node. */
function pairing(
  graph: LaneletGraph, node: NodeId, from: number, to: number,
): { pairs: string[]; turns: Set<string>; carried: Set<boolean> } {
  const pairs: string[] = [];
  const turns = new Set<string>();
  const carried = new Set<boolean>();
  for (const c of graph.connectors.values()) {
    if (c.node !== node || c.inSegment !== from || c.outSegment !== to) continue;
    const a = graph.lanelets.get(c.fromLane)?.laneIndex;
    const b = graph.lanelets.get(c.toLane)?.laneIndex;
    pairs.push(`${a}>${b}`);
    turns.add(c.turn);
    carried.add(c.carried);
  }
  return { pairs: pairs.sort(), turns, carried };
}

const at = (degrees: number, r: number) => ({
  x: Math.cos((degrees * Math.PI) / 180) * r,
  y: Math.sin((degrees * Math.PI) / 180) * r,
});

describe('a road bending at a node', () => {
  it('keeps every lane of an avenue bending 45 degrees at a node of two legs', () => {
    const doc = new RoadDoc();
    const west = doc.addNode({ x: -400, y: 0 });
    const bend = doc.addNode({ x: 0, y: 0 });
    const on = doc.addNode(at(45, 400));
    const a = doc.addSegment(west.id, bend.id, 2)!;
    const b = doc.addSegment(bend.id, on.id, 2)!;
    const graph = graphOf(doc);

    // Two lanes each way, each carried on in its own lane, in both directions.
    const forward = pairing(graph, bend.id, a.id, b.id);
    const back = pairing(graph, bend.id, b.id, a.id);
    expect(forward.pairs).toEqual(['0>0', '1>1']);
    expect(back.pairs).toEqual(['0>0', '1>1']);
    expect([...forward.carried]).toEqual([true]);
    // It still states how far it bends: speed and the indicator read that.
    expect([...forward.turns]).toEqual(['left']);
  });

  it('carries the road through a junction where it bends and a side street joins square', () => {
    // The main road turns 45 degrees at the node; the side street meets the
    // outside of the bend. No pair is straight within 30 degrees.
    const doc = new RoadDoc();
    const node = doc.addNode({ x: 0, y: 0 });
    const west = doc.addNode({ x: -400, y: 0 });
    const on = doc.addNode(at(45, 400));
    const side = doc.addNode(at(-67.5, 400));
    const a = doc.addSegment(west.id, node.id, 1)!;
    const b = doc.addSegment(node.id, on.id, 1)!;
    const c = doc.addSegment(node.id, side.id, 1)!;
    const graph = graphOf(doc);

    expect([...pairing(graph, node.id, a.id, b.id).carried]).toEqual([true]);
    expect([...pairing(graph, node.id, b.id, a.id).carried]).toEqual([true]);
    // Joining or leaving the road is not.
    expect([...pairing(graph, node.id, c.id, b.id).carried]).toEqual([false]);
    expect([...pairing(graph, node.id, a.id, c.id).carried]).toEqual([false]);
  });

  it('leaves a symmetric Y without a main road', () => {
    const doc = new RoadDoc();
    const node = doc.addNode({ x: 0, y: 0 });
    const legs = [90, 210, 330].map((d) => doc.addSegment(node.id, doc.addNode(at(d, 400)).id, 1)!);
    const graph = graphOf(doc);
    for (const from of legs) {
      for (const to of legs) {
        if (from === to) continue;
        expect(pairing(graph, node.id, from.id, to.id).carried.has(true)).toBe(false);
      }
    }
  });

  it('does not touch a crossroads that has a straight-on movement', () => {
    const doc = new RoadDoc();
    const node = doc.addNode({ x: 0, y: 0 });
    const [e, n, w] = [0, 90, 180].map((d) => doc.addSegment(node.id, doc.addNode(at(d, 400)).id, 1)!);
    const graph = graphOf(doc);
    expect([...pairing(graph, node.id, e!.id, w!.id).turns]).toEqual(['through']);
    expect(pairing(graph, node.id, e!.id, w!.id).carried.has(true)).toBe(false);
    expect([...pairing(graph, node.id, n!.id, e!.id).turns]).toEqual(['left']);
    expect([...pairing(graph, node.id, n!.id, w!.id).turns]).toEqual(['right']);
  });
});
