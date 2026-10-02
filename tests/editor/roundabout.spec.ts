import { describe, expect, it } from 'vitest';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { LaneletGraph } from '@world/lanelets';
import { History, restoreSnapshot } from '@editor/history';
import { commitRoundabout } from '@editor/roundabout';
import { segmentMarkings } from '@world/markings';
import { Level, SURFACE_LEVELS } from '@world/roadTypes';
import { SimWorld } from '@sim/world';
import { rightOfWay } from '@sim/intersections/admission';
import { createVehicle } from '@sim/vehicles/state';
import { ARCHETYPES } from '@sim/vehicles/archetypes';
import { makeDriver } from '@sim/vehicles/driver';

describe('roundabout command', () => {
  it('creates one directed curved cycle with four connected two-way entrances and exact undo', () => {
    const doc = new RoadDoc(), net = new Network(doc), history = new History();
    net.rebuild();
    const before = doc.toJSON();
    history.record(doc);
    const result = commitRoundabout(doc, net, { x: 0, y: 0 }, 100);
    expect(result.committed).toBe(true);
    if (!result.committed) return;
    expect(result.ring).toHaveLength(8);
    expect(result.entrances).toHaveLength(4);
    result.ring.forEach((id, i) => {
      const segment = doc.requireSegment(id);
      expect(segment.direction).toBe('aToB');
      expect(segment.lanes).toBe(1);
      expect(segment.curve).not.toBeNull();
      expect(segment.b).toBe(doc.requireSegment(result.ring[(i + 1) % 8]!).a);
      const ribbon = net.ribbons.get(id)!;
      expect(ribbon.road.lanes).toBe(1);
      expect(segmentMarkings(ribbon, 0)).toEqual([]);
      if (i % 2 !== 0) {
        expect(net.continues(segment.a)).toBe(true);
        expect(net.crosswalkDistanceAt(id, segment.a)).toBe(0);
      }
    });
    for (const id of result.entrances) {
      const segment = doc.requireSegment(id);
      expect(segment.direction).toBe('both');
      expect(doc.requireNode(segment.b).control).toBe('priority');
      expect(doc.requireNode(segment.b).incident).toHaveLength(3);
    }
    expect(net.impossible.size).toBe(0);
    const sim = new SimWorld(doc, net);
    const graph = sim.graph;
    graph.build(doc, net);
    const ringIds = new Set(result.ring);
    for (const id of result.entrances) {
      const node = doc.requireSegment(id).b;
      const movements = [...graph.connectors.values()].filter((movement) => movement.node === node);
      const throughRing = movements.filter((movement) => ringIds.has(movement.inSegment) && ringIds.has(movement.outSegment));
      expect(throughRing).toHaveLength(1);
      expect(throughRing[0]!.turn === 'through' || throughRing[0]!.carried).toBe(true);
      const entering = movements.filter((movement) => movement.inSegment === id && ringIds.has(movement.outSegment));
      expect(entering).toHaveLength(1);
      expect(entering[0]!.turn).not.toBe('through');
      expect(entering[0]!.carried).toBe(false);
      expect(graph.junctions.get(node)?.signalised).toBe(false);
      const archetype = ARCHETYPES[0]!;
      const driver = makeDriver(archetype, () => 0.5);
      const vehicle = createVehicle(1, archetype, driver, '#ffffff', entering[0]!.fromLane, 0, 0);
      expect(rightOfWay(sim, node, vehicle, throughRing[0]!, 10)).toBe('priority');
      expect(rightOfWay(sim, node, vehicle, entering[0]!, 10)).toBe('yield');
    }
    const fresh = new Network(doc);
    fresh.rebuild();
    const geometry = (network: Network) => [...network.ribbons].map(([id, ribbon]) => ({
      id,
      road: ribbon.road,
      full: ribbon.full.toPoints(),
      centre: ribbon.centre[Level.Asphalt]!.toPoints(),
      surfaces: SURFACE_LEVELS.map((level) => ribbon.rings[level]!.flatten()),
      trims: network.trims.get(id),
    }));
    expect(geometry(net)).toEqual(geometry(fresh));
    const freshGraph = new LaneletGraph();
    freshGraph.build(doc, fresh);
    expect([...graph.connectors]).toEqual([...freshGraph.connectors]);
    const lanes = (source: LaneletGraph) => [...source.lanelets.values()]
      .map((lane) => ({ ...lane, centre: lane.centre.toPoints() }));
    expect(lanes(graph)).toEqual(lanes(freshGraph));
    const after = doc.toJSON();
    restoreSnapshot(doc, history.undo(doc)!, net);
    expect(doc.toJSON()).toEqual(before);
    restoreSnapshot(doc, history.redo(doc)!, net);
    expect(doc.toJSON()).toEqual(after);
  });

  it('refuses occupied ground and invalid or off-map sizes without changing the document', () => {
    const doc = new RoadDoc(), net = new Network(doc);
    doc.addSegment(doc.addNode({ x: -300, y: 0 }).id, doc.addNode({ x: 300, y: 0 }).id, 0);
    net.rebuild();
    const before = doc.toJSON();
    expect(commitRoundabout(doc, net, { x: 0, y: 0 }, 100)).toMatchObject({ committed: false, reason: 'occupied' });
    expect(commitRoundabout(doc, net, { x: 2300, y: 0 }, 100)).toMatchObject({ committed: false, reason: 'bounds' });
    expect(commitRoundabout(doc, net, { x: 0, y: 0 }, NaN).committed).toBe(false);
    expect(commitRoundabout(doc, net, { x: 0, y: 0 }, 5).committed).toBe(false);
    expect(doc.toJSON()).toEqual(before);
  });
});
