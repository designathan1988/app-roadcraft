import { describe, expect, it } from 'vitest';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { SimWorld } from '@sim/world';
import { crossingSegment } from '@sim/signals/plan';

const cases = [
  { name: 'four-way', angles: [0, 90, 180, 270], types: [3, 3, 3, 3] },
  { name: 'T', angles: [0, 90, 180], types: [2, 1, 3] },
  { name: 'skew', angles: [0, 67, 175, 257], types: [1, 2, 3, 2] },
  { name: 'five-leg', angles: [0, 68, 145, 218, 293], types: [2, 1, 3, 2, 1] },
  { name: 'one-way', angles: [0, 90, 180, 270], types: [2, 3, 1, 2], oneWay: true },
] as const;

describe('complete signal movement matrix', () => {
  it('never gives conflicting protected movements green together', () => {
    let checked = 0;
    for (const config of cases) {
      const doc = new RoadDoc();
      const centre = doc.addNode({ x: 0, y: 0 });
      config.angles.forEach((degrees, index) => {
        const angle = degrees * Math.PI / 180;
        const far = doc.addNode({ x: Math.cos(angle) * 420, y: Math.sin(angle) * 420 });
        const segment = doc.addSegment(centre.id, far.id, config.types[index]!);
        if (!segment) throw new Error('Fixture road was rejected');
        if ('oneWay' in config && config.oneWay && index % 2 === 0) {
          doc.setSegmentDirection(segment.id, index === 0 ? 'aToB' : 'bToA');
        }
      });
      doc.setNodeControl(centre.id, 'signal');
      const net = new Network(doc); net.rebuild();
      const sim = new SimWorld(doc, net, 0x392a); sim.rebuildTopology();
      const controller = sim.controller(centre.id)!;
      const connectors = [...sim.graph.connectors.values()].filter(c => c.node === centre.id);
      for (const stage of controller.plan.stages) {
        const protectedMovements = connectors.filter(c =>
          stage.greenGroups.includes(c.group) && c.turn === 'through');
        for (let i = 0; i < protectedMovements.length; i++) {
          for (let j = i + 1; j < protectedMovements.length; j++) {
            checked++;
            const a = protectedMovements[i]!;
            const b = protectedMovements[j]!;
            const label = `${config.name}: ${a.id} conflicts with ${b.id}`;
            const ref = sim.conflicts.refs(a.id).find(r => r.other === b.id);
            const point = ref === undefined ? undefined : sim.conflicts.points[ref.point];
            // No CENTRELINE crossing and no merge: two protected movements
            // released together must never be two streams that cross.
            expect(point?.kind === 'cross' || point?.kind === 'merge', label).toBe(false);
            // And no ordinary car may touch another on a protected green. The
            // remaining case — two HEAVY bodies whose swept areas graze, which
            // is real geometry where lanes of unequal width meet, and between
            // two lanes of one approach — is serialised by the claim table;
            // `tests/sim/collisions.spec.ts` checks the bodies themselves.
            expect(point?.zone(a.id, 1, 1) ?? null, label).toBeNull();
          }
        }
        for (const crossing of stage.pedWalk) {
          const leg = crossingSegment(crossing);
          for (const movement of protectedMovements) {
            expect(movement.inSegment === leg || movement.outSegment === leg,
              `${config.name}: ${movement.id} has protected green across WALK ${crossing}`).toBe(false);
          }
        }
      }
      for (const movement of connectors) {
        expect(controller.plan.stages.some(stage => stage.greenGroups.includes(movement.group)),
          `${config.name}: no green for ${movement.id}`).toBe(true);
      }
      // Every signal group serves traffic. A one-way leg LEAVING the junction
      // used to get a group, a head facing an empty road and a stage of green
      // for nobody.
      const junction = sim.graph.junctions.get(centre.id)!;
      for (const group of junction.groups) {
        expect(connectors.some(c => c.group === group.id),
          `${config.name}: group ${group.id} (${group.segments}) serves no movement`).toBe(true);
      }
      for (const stage of controller.plan.stages) {
        if (stage.exclusivePed) continue;
        expect(stage.greenGroups.length, `${config.name}: empty vehicle stage`).toBeGreaterThan(0);
      }
    }
    expect(checked).toBeGreaterThan(5);
  });

  it('never gives green together to two movements whose cars could meet', () => {
    // Permissive turns are gone from signal plans: a stage only combines
    // approaches none of whose movements cross, merge or sweep into each other
    // for two cars. What remains is the claim table's job - a bus's tail swing
    // - and every green movement is protected.
    let stages = 0;
    for (const config of cases) {
      const doc = new RoadDoc();
      const centre = doc.addNode({ x: 0, y: 0 });
      config.angles.forEach((degrees, index) => {
        const angle = degrees * Math.PI / 180;
        const far = doc.addNode({ x: Math.cos(angle) * 420, y: Math.sin(angle) * 420 });
        const segment = doc.addSegment(centre.id, far.id, config.types[index]!);
        if ('oneWay' in config && config.oneWay && index % 2 === 0 && segment) {
          doc.setSegmentDirection(segment.id, index === 0 ? 'aToB' : 'bToA');
        }
      });
      doc.setNodeControl(centre.id, 'signal');
      const net = new Network(doc); net.rebuild();
      const sim = new SimWorld(doc, net, 0x392a); sim.rebuildTopology();
      const controller = sim.controller(centre.id)!;
      const connectors = [...sim.graph.connectors.values()].filter(c => c.node === centre.id);
      for (const stage of controller.plan.stages) {
        stages++;
        const green = connectors.filter(c => stage.greenGroups.includes(c.group));
        for (const a of green) {
          expect(stage.protectedMovements.includes(a.id), `${config.name}: ${a.id}`).toBe(true);
          for (const b of green) {
            if (a.inSegment === b.inSegment || a.id >= b.id) continue;
            const cars = sim.conflicts.refs(a.id).filter(r => r.other === b.id)
              .some(r => sim.conflicts.points[r.point]?.zone(a.id, 1, 1));
            expect(cars, `${config.name}: ${a.id} (${a.turn}) vs ${b.id} (${b.turn})`).toBe(false);
          }
        }
      }
    }
    expect(stages).toBeGreaterThan(cases.length);
  });
});
