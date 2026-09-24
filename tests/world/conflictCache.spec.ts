import { describe, expect, it } from 'vitest';
import type { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { LaneletGraph } from '@world/lanelets';
import { BODY_CLASSES, ConflictIndex } from '@world/conflictPoints';
import type { NodeId } from '@world/ids';
import { fixtureDoc } from '../sim/support/bodies';

/**
 * The conflict index reuses the zones of every pair of movements whose swept
 * geometry did not change since the previous build.
 *
 * That cache is only a cache if it can never change an answer: claims, signal
 * stages and the pose agreement all read these zones. So an index rebuilt
 * THROUGH the cache after an edit must agree exactly — every zone, every
 * reference, every diverge — with an index built cold on the same graph.
 */

function graphOf(doc: RoadDoc): LaneletGraph {
  const net = new Network(doc);
  net.rebuild();
  const graph = new LaneletGraph();
  graph.build(doc, net);
  return graph;
}

/** Everything the simulation reads from an index, keyed by connector pair. */
function snapshot(index: ConflictIndex): unknown {
  const keyOf = new Map<number, string>();
  const points = index.points
    .filter((p) => p !== undefined)
    .map((p) => {
      const key = `${p.node}|${p.a}|${p.b}`;
      keyOf.set(p.id, key);
      const zones: unknown[] = [];
      for (const on of [p.a, p.b]) {
        for (const mine of BODY_CLASSES) {
          for (const theirs of BODY_CLASSES) zones.push(p.zone(on, mine, theirs));
        }
      }
      return { key, kind: p.kind, at: p.at, sA: p.sA, sB: p.sB, zones };
    })
    .sort((p, q) => (p.key < q.key ? -1 : p.key > q.key ? 1 : 0));

  const refs = [...index.byConnector.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([connector, list]) => [
      connector,
      list.map((r) => ({ point: keyOf.get(r.point), s: r.s, other: r.other, kind: r.kind, exit: r.exit })),
    ]);

  const diverges = [...index.diverges.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([connector, list]) => [
      connector,
      list.map((d) => ({
        other: d.other,
        exits: BODY_CLASSES.flatMap((mine) => BODY_CLASSES.map((theirs) => d.otherExit(mine, theirs))),
      })),
    ]);

  return { points, refs, diverges, intrusions: index.queueIntrusions };
}

/** Adds one leg to the busiest junction it can, so the edit changes one node. */
function addLeg(doc: RoadDoc): NodeId {
  const busiest = [...doc.nodes.values()]
    .filter((n) => n.incident.length >= 3)
    .sort((a, b) => b.incident.length - a.incident.length || a.id - b.id)[0];
  if (!busiest) throw new Error('fixture has no junction');
  const far = doc.addNode({ x: busiest.x + 180, y: busiest.y + 330 });
  if (!doc.addSegment(busiest.id, far.id, 1)) throw new Error('could not add a leg');
  return busiest.id;
}

describe('conflict zone cache', () => {
  it('gives the same index as a cold build after an edit', () => {
    const doc = fixtureDoc();
    const warm = new ConflictIndex();
    warm.build(graphOf(doc));

    addLeg(doc);
    const graph = graphOf(doc);
    warm.build(graph);
    const cold = new ConflictIndex();
    cold.build(graph);

    expect(snapshot(warm)).toEqual(snapshot(cold));
  });

  it('gives the same index when a junction loses a leg again', () => {
    const doc = fixtureDoc();
    const warm = new ConflictIndex();
    warm.build(graphOf(doc));
    const node = addLeg(doc);
    warm.build(graphOf(doc));

    const added = doc.requireNode(node).incident.at(-1);
    if (added === undefined) throw new Error('leg missing');
    doc.removeSegment(added);
    doc.pruneOrphanNodes();
    const graph = graphOf(doc);
    warm.build(graph);
    const cold = new ConflictIndex();
    cold.build(graph);

    expect(snapshot(warm)).toEqual(snapshot(cold));
  });

  it('makes an unchanged rebuild much cheaper than a cold one', () => {
    const graph = graphOf(fixtureDoc());
    const index = new ConflictIndex();
    let t = performance.now();
    index.build(graph);
    const cold = performance.now() - t;
    t = performance.now();
    index.build(graph);
    const warm = performance.now() - t;
    // Measured at about a fifth; half leaves room for a noisy machine.
    expect(warm).toBeLessThan(cold * 0.5);
  });
});
