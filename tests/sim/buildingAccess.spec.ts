import { describe, expect, it } from 'vitest';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { blueprintByKey, instantiate } from '@world/buildings/blueprints';
import { SimWorld } from '@sim/world';
import { step } from '@sim/pipeline';
import { nextTowardGoal } from '@sim/peds/route';
import { createPed, pedSnapshot } from '@sim/peds/state';
import { m } from '@world/units';

describe('building entrance navigation', () => {
  it('assigns spawned walkers a building destination and lets one enter its access path', () => {
    const doc = new RoadDoc();
    const a = doc.addNode({ x: -180, y: 0 }), b = doc.addNode({ x: 180, y: 0 });
    doc.addSegment(a.id, b.id, 1);
    const net = new Network(doc); net.rebuild();
    doc.buildings.add(instantiate(blueprintByKey('house')!.body, { x: 0, y: 55 }, 0, 'house'));
    const sim = new SimWorld(doc, net, 0xbe7c);
    sim.rebuildTopology();
    sim.pedestrianIntensity = 8;
    let aimed = false, approached = false, arrived = false;
    for (let tick = 0; tick < 60 * 90; tick++) {
      const before = new Map([...sim.peds.values()].map((ped) => [ped.id, { goal: ped.goal, trip: ped.trip }]));
      step(sim, { traffic: false, pedestrians: true });
      for (const ped of sim.peds.values()) {
        if (ped.goal?.startsWith('B:')) aimed = true;
        if (sim.sidewalks.edges.get(ped.edge)?.kind === 'access') approached = true;
        const prior = before.get(ped.id);
        if (prior?.goal?.startsWith('B:') && ped.trip > prior.trip) arrived = true;
      }
      if (aimed && approached && arrived) break;
    }
    expect(aimed).toBe(true);
    expect(approached).toBe(true);
    expect(arrived).toBe(true);
  });
  it('links a visible door to a sidewalk and updates the link without rebuilding cars', () => {
    const doc = new RoadDoc();
    const west = doc.addNode({ x: -180, y: 0 });
    const east = doc.addNode({ x: 180, y: 0 });
    doc.addSegment(west.id, east.id, 1);
    const net = new Network(doc);
    net.rebuild();
    const sim = new SimWorld(doc, net);
    sim.rebuildTopology();
    const lanelets = sim.graph.lanelets;
    const building = doc.buildings.add(instantiate(blueprintByKey('house')!.body,
      { x: 0, y: 55 }, 0, 'house'));

    step(sim, { traffic: false, pedestrians: false });
    const doors = [...sim.sidewalks.nodes.keys()].filter((id) => id.startsWith(`B:${building.id}:`));
    expect(doors.length).toBeGreaterThan(0);
    const access = [...sim.sidewalks.edges.values()].find((edge) => edge.to === doors[0]);
    expect(access?.kind).toBe('access');
    expect(sim.sidewalks.goalNodes).toContain(doors[0]);
    const footway = [...sim.sidewalks.edges.values()].find((edge) =>
      edge.kind === 'walk' && edge.to === access!.from && edge.id.includes(':part:'))!;
    expect(footway).toBeDefined();
    expect(sim.sidewalks.buildingsFrom(footway.from)).toContain(doors[0]);
    const opposite = [...sim.sidewalks.edges.values()].find((edge) => edge.id === 'W:1:-1')!;
    expect(sim.sidewalks.goalsFrom(opposite.from)).not.toContain(doors[0]);
    expect(nextTowardGoal(sim.sidewalks, footway.from, doors[0]!, '', 1)).toBe(footway.id);
    expect(sim.graph.lanelets).toBe(lanelets);
    const accessBeforeRoof = sim.sidewalks.edges.get(access!.id);
    doc.buildings.put({ ...building, volumes: building.volumes.map((volume) => ({ ...volume, roof: 'flat' })) });
    step(sim, { traffic: false, pedestrians: false });
    expect(sim.sidewalks.edges.get(access!.id)).toBe(accessBeforeRoof);
    expect(sim.graph.lanelets).toBe(lanelets);

    const entry = footway.from;
    const party = { id: 1, size: 1, archetype: 'solo' as const, pace: m(1.4),
      hasChild: false, goal: doors[0]!, trip: 0 };
    const ped = createPed({ id: 1, color: '#888888', speed: m(1.4), file: 0,
      ageClass: 'adult', gender: 'f', party, rank: 0, edge: footway.id, entry,
      s: Math.max(0, footway.length - m(6)), lat: 0, tick: 0 });
    const at = sim.sidewalks.orientedPath(footway, entry).sampleAt(ped.s);
    ped.x = at.p.x; ped.y = at.p.y; ped.heading = Math.atan2(at.t.y, at.t.x);
    ped.goal = doors[0]!;
    ped.prev = pedSnapshot(ped);
    sim.peds.set(ped.id, ped);
    sim.pedestrianIntensity = 0;
    let reachedDoor = false;
    for (let i = 0; i < 2400; i++) {
      step(sim, { traffic: false, pedestrians: true });
      if (ped.edge === access!.id && ped.s > access!.length * 0.85) {
        reachedDoor = true;
        break;
      }
    }
    expect(reachedDoor).toBe(true);

    const beforeMove = { x: ped.x, y: ped.y };
    doc.buildings.put({ ...building, x: building.x + m(5) });
    step(sim, { traffic: false, pedestrians: false });
    expect(sim.peds.has(ped.id)).toBe(true);
    expect(Math.hypot(ped.x - beforeMove.x, ped.y - beforeMove.y)).toBeLessThan(m(15));
    expect(sim.graph.lanelets).toBe(lanelets);

    const before = { x: ped.x, y: ped.y };
    doc.buildings.remove(building.id);
    step(sim, { traffic: false, pedestrians: false });
    expect([...sim.sidewalks.nodes.keys()].some((id) => id.startsWith('B:'))).toBe(false);
    expect(sim.sidewalks.buildingGoalNodes).toHaveLength(0);
    expect(sim.peds.has(ped.id)).toBe(true);
    expect(Math.hypot(ped.x - before.x, ped.y - before.y)).toBeLessThan(m(30));
    expect(sim.graph.lanelets).toBe(lanelets);
  });
});
