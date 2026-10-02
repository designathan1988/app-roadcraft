import { expect, it } from 'vitest';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { sectionFromProfile, roadType } from '@world/roadTypes';
import { SimWorld } from '@sim/world';
import { rightOfWay } from '@sim/intersections/admission';
import { createVehicle } from '@sim/vehicles/state';
import { ARCHETYPES } from '@sim/vehicles/archetypes';
import { makeDriver } from '@sim/vehicles/driver';

it('changing authored priority changes which actual through movement yields', () => {
  const doc = new RoadDoc();
  const centre = doc.addNode({ x: 0, y: 0 });
  doc.setNodeControl(centre.id, 'priority');
  const arms = [[-200, 0], [200, 0], [0, -200], [0, 200]].map(([x, y]) =>
    doc.addSegment(doc.addNode({ x: x!, y: y! }).id, centre.id, 0)!);
  const verdicts = () => {
    const net = new Network(doc); net.rebuild();
    const sim = new SimWorld(doc, net); sim.graph.build(doc, net);
    const archetype = ARCHETYPES[0]!;
    return [0, 2].map((index) => {
      const conn = [...sim.graph.connectors.values()].find(c =>
        c.inSegment === arms[index]!.id && c.outSegment === arms[index + 1]!.id)!;
      const vehicle = createVehicle(1, archetype, makeDriver(archetype, () => 0.5), '#fff', conn.fromLane, 0, 0);
      return rightOfWay(sim, centre.id, vehicle, conn, 10);
    });
  };
  const section = sectionFromProfile(roadType(0));
  arms.slice(0, 2).forEach(s => doc.setSegmentSection(s.id, { ...section, priority: 4 }));
  expect(verdicts()).toEqual(['priority', 'yield']);
  arms.slice(2).forEach(s => doc.setSegmentSection(s.id, { ...section, priority: 5 }));
  expect(verdicts()).toEqual(['yield', 'priority']);
});
