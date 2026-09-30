import { describe, expect, it } from 'vitest';

import { History, restoreSnapshot } from '@editor/history';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { generateBody } from '@world/buildings/blueprints';
import type { Building } from '@world/buildings/types';

function city(): { doc: RoadDoc; net: Network } {
  const doc = new RoadDoc();
  const a = doc.addNode({ x: 0, y: 0 });
  const b = doc.addNode({ x: 200, y: 0 });
  doc.addSegment(a.id, b.id, 1);
  const net = new Network(doc);
  net.rebuild();
  return { doc, net };
}

/**
 * Undo restores the model's own snapshot. It used to replace the whole
 * document, bump every revision and rebuild the road network (twice), the
 * lanelets and the simulation topology - for a storey, a pole, a brush dab.
 */
describe('undo', () => {
  it('of a building edit leaves the road revisions, and the network, alone', () => {
    const { doc, net } = city();
    const history = new History();
    history.record(doc);
    doc.buildings.add({ ...generateBody('residential', 30, 30, 2), x: 0, y: 80, rotation: 0 } as unknown as Building);
    const roads = doc.revision;
    const traffic = doc.trafficRevision;
    const built = net.revision;

    const snapshot = history.undo(doc)!;
    restoreSnapshot(doc, snapshot, net);
    expect(doc.buildings.size).toBe(0);
    expect(doc.revision).toBe(roads);
    expect(doc.trafficRevision).toBe(traffic);
    expect(net.revision).toBe(built);
  });

  it('of a road edit moves the revisions and rebuilds', () => {
    const { doc, net } = city();
    const history = new History();
    history.record(doc);
    const c = doc.addNode({ x: 200, y: 200 });
    doc.addSegment([...doc.nodes.keys()][1]!, c.id, 1);
    net.rebuild();
    const roads = doc.revision;

    restoreSnapshot(doc, history.undo(doc)!, net);
    expect(doc.segments.size).toBe(1);
    expect(doc.revision).toBeGreaterThan(roads);
    expect(net.revision).toBe(doc.revision);
  });

  it('and redo are exact inverses', () => {
    const { doc, net } = city();
    const history = new History();
    const start = JSON.stringify(doc.toJSON());
    history.record(doc);
    const c = doc.addNode({ x: 100, y: 150 });
    doc.addSegment([...doc.nodes.keys()][0]!, c.id, 2);
    const edited = JSON.stringify(doc.toJSON());
    restoreSnapshot(doc, history.undo(doc)!, net);
    expect(JSON.stringify(doc.toJSON())).toBe(start);
    restoreSnapshot(doc, history.redo(doc)!, net);
    expect(JSON.stringify(doc.toJSON())).toBe(edited);
  });
});
