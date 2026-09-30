import { describe, expect, it } from 'vitest';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { blueprintByKey, instantiate } from '@world/buildings/blueprints';
import { SimWorld } from '@sim/world';
import { step } from '@sim/pipeline';
import { createPeopleEngine } from '@sim/people/people';

describe('where people come from and go to', () => {
  it('appear only at a door or a road end, walk the path to a door, and go in', () => {
    const doc = new RoadDoc();
    const a = doc.addNode({ x: -180, y: 0 }), b = doc.addNode({ x: 180, y: 0 });
    doc.addSegment(a.id, b.id, 1);
    const net = new Network(doc); net.rebuild();
    doc.buildings.add(instantiate(blueprintByKey('house')!.body, { x: 0, y: 55 }, 0, 'house'));
    const sim = new SimWorld(doc, net, 0xbe7c);
    sim.rebuildTopology();
    sim.pedestrianIntensity = 30;
    sim.usePedestrianEngine(createPeopleEngine());
    step(sim, { traffic: false, pedestrians: true });
    const doors = [...sim.sidewalks.nodes.values()].filter((n) => n.id.startsWith('B:')).map((n) => n.at);
    expect(doors.length).toBeGreaterThan(0);

    const seen = new Set(sim.pedViews.map((v) => v.id));
    const last = new Map<number, { x: number; y: number }>();
    let fresh = 0, atDoor = 0, atEnd = 0, elsewhere = 0, onPath = false, wentIn = false;
    for (let tick = 0; tick < 60 * 400; tick++) {
      step(sim, { traffic: false, pedestrians: true });
      const now = new Set<number>();
      for (const v of sim.pedViews) {
        now.add(v.id);
        if (v.ground === 'open') onPath = true;
        if (!seen.has(v.id)) {
          seen.add(v.id);
          fresh++;
          const door = Math.min(...doors.map((d) => Math.hypot(d.x - v.x, d.y - v.y)));
          if (door < 3) atDoor++;
          else if (Math.abs(Math.abs(v.x) - 180) < 6) atEnd++;
          else elsewhere++;
        }
        last.set(v.id, { x: v.x, y: v.y });
      }
      for (const [id, at] of last) {
        if (now.has(id)) continue;
        if (Math.min(...doors.map((d) => Math.hypot(d.x - at.x, d.y - at.y))) < 3) wentIn = true;
        last.delete(id);
      }
      if (fresh > 20 && onPath && wentIn && atDoor > 0) break;
    }
    expect(fresh).toBeGreaterThan(0);
    expect(elsewhere).toBe(0);
    expect(atDoor).toBeGreaterThan(0);
    expect(atEnd).toBeGreaterThan(0);
    expect(onPath).toBe(true);
    expect(wentIn).toBe(true);
  }, 120_000);
});
