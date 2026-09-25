import { describe, expect, it } from 'vitest';

import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { duplicateSegment, joinSegments, splitSegment } from '@editor/commit';
import { History, restoreInto } from '@editor/history';

function street(): { doc: RoadDoc; net: Network } {
  const doc = new RoadDoc();
  const a = doc.addNode({ x: -200, y: 0 });
  const b = doc.addNode({ x: 200, y: 0 });
  doc.addSegment(a.id, b.id, 2);
  const net = new Network(doc);
  net.rebuild();
  return { doc, net };
}

describe('splitting', () => {
  it('turns one road into two and leaves a node between them', () => {
    const { doc, net } = street();
    const id = [...doc.segments.keys()][0]!;
    const node = splitSegment(doc, net, id, 200, { x: 0, y: 0 });
    expect(node).not.toBeNull();
    expect(doc.segments.size).toBe(2);
    expect(doc.nodes.size).toBe(3);
    expect(doc.degree(node!)).toBe(2);
  });

  it('rejoins a split road back into one', () => {
    const { doc, net } = street();
    const id = [...doc.segments.keys()][0]!;
    const node = splitSegment(doc, net, id, 200, { x: 0, y: 0 })!;
    net.rebuild();
    expect(joinSegments(doc, node)).toBe(true);
    expect(doc.segments.size).toBe(1);
  });
});

describe('duplicating', () => {
  it('produces a parallel road of the same class', () => {
    const { doc, net } = street();
    const id = [...doc.segments.keys()][0]!;
    const copy = duplicateSegment(doc, net, id);
    expect(copy).not.toBeNull();
    expect(doc.segments.size).toBe(2);
    expect(doc.segment(copy!)!.type).toBe(doc.segment(id)!.type);
  });
});

describe('history', () => {
  it('restores the document a step at a time', () => {
    const { doc, net } = street();
    const history = new History();
    history.record(doc);
    const a = doc.addNode({ x: 0, y: 300 });
    doc.addSegment([...doc.nodes.keys()][0]!, a.id, 1);
    expect(doc.segments.size).toBe(2);
    const previous = history.undo(doc);
    expect(previous).not.toBeNull();
    restoreInto(doc, previous!, net);
    expect(doc.segments.size).toBe(1);
  });
});

describe('terrain authoring', () => {
  it('bumps the terrain revision so the renderer knows to rebuild', () => {
    const doc = new RoadDoc();
    const before = doc.terrainRevision;
    doc.addTerrainStamp({ x: 0, y: 0, radius: 80, strength: 4, mode: 'raise' });
    expect(doc.terrainRevision).toBeGreaterThan(before);
  });

  it('clears back to bare land', () => {
    const doc = new RoadDoc();
    doc.addTerrainStamp({ x: 0, y: 0, radius: 80, strength: 4, mode: 'raise' });
    doc.clearTerrain();
    expect(doc.terrainStamps.length).toBe(0);
  });

  it('round-trips a map through JSON', () => {
    const { doc } = street();
    doc.addTerrainStamp({ x: 10, y: 20, radius: 60, strength: 3, mode: 'lower' });
    const copy = RoadDoc.fromJSON(JSON.parse(JSON.stringify(doc.toJSON())));
    expect(copy.segments.size).toBe(doc.segments.size);
    expect(copy.nodes.size).toBe(doc.nodes.size);
    expect(copy.terrainStamps.length).toBe(1);
  });
});

describe('drawing', () => {
  it('hands back a network that already contains the road it drew', async () => {
    // Found by the fuzzer (`staleNetwork`): commitDraft adopted a network built
    // before the draft's segments were added, stamped with the new revision.
    const { commitDraft } = await import('@editor/commit');
    const doc = new RoadDoc();
    const net = new Network(doc);
    net.rebuild();
    const result = commitDraft(doc, net, { kind: 'free', at: { x: -200, y: 0 } },
      { kind: 'free', at: { x: 200, y: 0 } }, 2);
    expect(result.committed).toBe(true);
    expect(net.revision).toBe(doc.revision);
    expect([...net.ribbons.keys()].sort()).toEqual([...doc.segments.keys()].sort());
  });
});
