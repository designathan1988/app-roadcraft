import { describe, expect, it } from 'vitest';
import { PedestrianClearance } from '@sim/peds/clearance';
import { pedSnapshot } from '@sim/peds/state';
import { m } from '@world/units';
import { fixtureDoc, simOf } from './support/bodies';
import { labStreet, placeWalkers } from './support/pedLab';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { SimWorld } from '@sim/world';
import { kerbId } from '@sim/peds/sidewalk';
import { WalkableSurface } from '@world/walkable';

describe('pedestrian perception', () => {
  it('keeps neighbour velocities after render snapshots and throughout the decision step', () => {
    const { sim } = labStreet();
    const [p] = placeWalkers(sim, [{ side: 1, at: 30, east: true, speed: 1.3 }]);
    p!.prev = pedSnapshot(p!);
    const space = new PedestrianClearance();
    space.begin(sim);
    const velocity = (): number[] => {
      let result: number[] = [];
      space.around(p!.x, p!.y, m(2), (item) => {
        if (item.id === p!.id) result = [item.vx ?? 0, item.vy ?? 0];
      });
      return result;
    };
    const before = velocity();
    expect(Math.hypot(...before)).toBeCloseTo(m(1.3));
    p!.v = 0;
    space.update(sim, p!);
    expect(velocity()).toEqual(before);
    space.begin(sim);
    expect(velocity()).toEqual([0, 0]);
  });

  it('places collision footprints on the same curved corridor as the visible body', () => {
    const sim = simOf(fixtureDoc(), 7);
    const space = new PedestrianClearance();
    const frame = { x: 0, y: 0, tx: 0, ty: 0, nx: 0, ny: 0 };
    let samples = 0;
    for (const edge of sim.sidewalks.edges.values()) {
      if (edge.kind !== 'corner') continue;
      for (const entry of [edge.from, edge.to]) for (let s = 0; s < edge.length; s += 0.5) {
        edge.corridor.place(s, 1, entry !== edge.from, frame);
        const at = space.point(sim, edge, entry, s, 1);
        expect(Math.hypot(at.x - frame.x, at.y - frame.y), edge.id).toBeLessThan(1e-9);
        samples++;
      }
    }
    expect(samples).toBeGreaterThan(100);
  });

  it('connects both footways across a continuous two-leg node without inventing a crossing', () => {
    const doc = new RoadDoc();
    const west = doc.addNode({ x: -120, y: 0 });
    const middle = doc.addNode({ x: 0, y: 0 });
    const east = doc.addNode({ x: 120, y: 0 });
    const a = doc.addSegment(west.id, middle.id, 2)!;
    const b = doc.addSegment(middle.id, east.id, 2)!;
    const net = new Network(doc);
    net.rebuild();
    const sim = new SimWorld(doc, net, 7);
    sim.rebuildTopology();
    expect(net.crosswalkDistanceAt(a.id, middle.id)).toBe(0);
    expect(net.crosswalkDistanceAt(b.id, middle.id)).toBe(0);
    for (const seg of [a, b]) for (const side of [-1, 1] as const) {
      const edges = sim.sidewalks.edgesAt(kerbId(middle.id, seg.id, side))
        .map((id) => sim.sidewalks.edges.get(id)?.kind).sort();
      expect(edges).toEqual(['corner', 'walk']);
    }
  });

  it('keeps both corner routes on footway around a two-leg bend', () => {
    const doc = new RoadDoc();
    const west = doc.addNode({ x: -120, y: 0 });
    const middle = doc.addNode({ x: 0, y: 0 });
    const north = doc.addNode({ x: 0, y: 120 });
    doc.addSegment(west.id, middle.id, 2);
    doc.addSegment(middle.id, north.id, 2);
    const net = new Network(doc);
    net.rebuild();
    const sim = new SimWorld(doc, net, 7);
    sim.rebuildTopology();
    const footway = new WalkableSurface(net);
    const corners = [...sim.sidewalks.edges.values()].filter((edge) => edge.kind === 'corner');
    expect(corners).toHaveLength(2);
    for (const edge of corners) for (let s = 0.25; s < edge.length - 0.25; s += 0.5) {
      const point = edge.path.sampleAt(s).p;
      expect(footway.footway(point.x, point.y), `${edge.id} at ${s}`).toBe(true);
    }
  });
});
