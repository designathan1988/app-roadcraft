import { describe, expect, it } from 'vitest';

import { reconcileMovedNode } from '@editor/commit';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';

function setup(): { doc: RoadDoc; net: Network } {
  const doc = new RoadDoc();
  const net = new Network(doc);
  return { doc, net };
}

/**
 * A node dropped by the Move tool is reconciled with the network the way a
 * drawn road is. It used to be left as dropped: on its neighbour, on another
 * node, or carrying a road across another with no junction - where no
 * conflict zone exists and cars drive through each other.
 */
describe('a node dropped by Move', () => {
  it('on another node at its level becomes that node', () => {
    const { doc, net } = setup();
    const a = doc.addNode({ x: 0, y: 0 });
    const b = doc.addNode({ x: 200, y: 0 });
    const c = doc.addNode({ x: 0, y: 200 });
    const d = doc.addNode({ x: 200, y: 200 });
    doc.addSegment(a.id, b.id, 1);
    doc.addSegment(c.id, d.id, 1);
    doc.moveNode(d.id, { x: 201, y: 1 });
    expect(reconcileMovedNode(doc, net, d.id).committed).toBe(true);
    expect(doc.node(d.id)).toBeUndefined();
    expect(doc.degree(b.id)).toBe(2);
  });

  it('onto its own neighbour is refused', () => {
    const { doc, net } = setup();
    const a = doc.addNode({ x: 0, y: 0 });
    const b = doc.addNode({ x: 200, y: 0 });
    doc.addSegment(a.id, b.id, 1);
    doc.moveNode(b.id, { x: 1, y: 0 });
    expect(reconcileMovedNode(doc, net, b.id)).toEqual({ committed: false, reason: 'tooShort' });
  });

  it('carrying its road across another makes a junction there', () => {
    const { doc, net } = setup();
    const w = doc.addNode({ x: -200, y: 0 });
    const e = doc.addNode({ x: 200, y: 0 });
    const s = doc.addNode({ x: 0, y: -200 });
    const n = doc.addNode({ x: 0, y: -80 });
    doc.addSegment(w.id, e.id, 1);
    doc.addSegment(s.id, n.id, 1);
    // Drag the stub's end up across the east-west road.
    doc.moveNode(n.id, { x: 0, y: 150 });
    expect(reconcileMovedNode(doc, net, n.id).committed).toBe(true);
    const junction = [...doc.nodes.values()].find((node) => node.incident.length === 4);
    expect(junction, 'a four-way junction where the roads cross').toBeDefined();
    expect(Math.hypot(junction!.x, junction!.y)).toBeLessThan(3);
    expect(doc.segments.size).toBe(4);
  });
});

describe('merging two nodes', () => {
  it('never leaves two roads between the same pair of nodes', () => {
    const doc = new RoadDoc();
    const hub = doc.addNode({ x: 0, y: 0 });
    const a = doc.addNode({ x: 200, y: 0 });
    const b = doc.addNode({ x: 205, y: 60 });
    doc.addSegment(hub.id, a.id, 1);
    doc.addSegment(hub.id, b.id, 1);
    doc.addSegment(a.id, b.id, 1);
    // b folded into a: its road to the hub would duplicate a's.
    expect(doc.mergeNodes(a.id, b.id)).toBe(true);
    const pairs = [...doc.segments.values()].map((s) => [s.a, s.b].sort().join('-'));
    expect(new Set(pairs).size).toBe(pairs.length);
  });
});
