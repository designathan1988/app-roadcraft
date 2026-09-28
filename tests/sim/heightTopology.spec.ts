import { describe, expect, it } from 'vitest';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { TUNNEL_HEADROOM } from '@world/structures';
import { SimWorld } from '@sim/world';
import { step } from '@sim/pipeline';

describe('height-only edits', () => {
  it('updates the rendered road revision without rebuilding unchanged traffic geometry', () => {
    const doc = new RoadDoc();
    const a = doc.addNode({ x: 0, y: 0 });
    const b = doc.addNode({ x: 180, y: 0 });
    const segment = doc.addSegment(a.id, b.id, 1)!;
    const net = new Network(doc);
    net.rebuild();
    const sim = new SimWorld(doc, net, 19);
    sim.rebuildTopology();
    const roadRevision = net.revision;
    const trafficRevision = net.trafficRevision;
    const link = [...sim.graph.lanelets.values()].find(lane => lane.kind === 'link' && lane.segment === segment.id)!;
    const walk = [...sim.sidewalks.edges.values()].find(edge => edge.kind === 'walk')!;

    doc.setNodeHeightOffset(b.id, 5);
    net.rebuild();
    expect(net.revision).toBeGreaterThan(roadRevision);
    expect(net.trafficRevision).toBe(trafficRevision);
    step(sim, { traffic: false, pedestrians: false });
    expect(sim.topologyRevision).toBe(trafficRevision);
    expect(sim.graph.lanelets.get(link.id)).toBe(link);
    expect(sim.sidewalks.edges.get(walk.id)).toBe(walk);

    doc.setNodeHeightOffset(b.id, -TUNNEL_HEADROOM - 1);
    net.rebuild();
    expect(net.trafficRevision).toBeGreaterThan(trafficRevision);
    step(sim, { traffic: false, pedestrians: false });
    expect(sim.topologyRevision).toBe(net.trafficRevision);
    expect(sim.graph.lanelets.get(link.id)).not.toBe(link);
  });
});
