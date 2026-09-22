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
            expect(sim.conflicts.conflict(protectedMovements[i]!.id, protectedMovements[j]!.id),
              `${config.name}: ${protectedMovements[i]!.id} conflicts with ${protectedMovements[j]!.id}`).toBe(false);
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
    }
    expect(checked).toBeGreaterThan(5);
  });
});
