import { beforeAll, expect, it } from 'vitest';
import { Network } from '@world/network';
import { SimWorld } from '@sim/world';
import { step } from '@sim/pipeline';
import { DT } from '@sim/params';
import { addScriptedWalker, createCrowdEngine, initCrowd, inspectCrowd } from '@sim/people/crowd';
import { SCENARIOS } from '../../fixtures/crowdScenarios';

beforeAll(initCrowd);

it('publishes a new moving body facing its first Detour velocity', () => {
  const sc = SCENARIOS.find(s => s.name === 'head-on')!;
  const net = new Network(sc.doc); net.rebuild();
  const sim = new SimWorld(sc.doc, net, 0x5ce7); sim.rebuildTopology();
  sim.pedestrianIntensity = 0; sim.trafficIntensity = 0;
  sim.usePedestrianEngine(createCrowdEngine());
  step(sim, { traffic: false, pedestrians: true });
  const spec = sc.walkers(net)[0]!;
  const id = addScriptedWalker(sim, { ...spec, heading: Math.PI })!;
  step(sim, { traffic: false, pedestrians: true });
  const p = inspectCrowd(sim).find(p => p.id === id)!;
  const view = sim.pedViewById.get(id)!;
  expect(p.speed).toBeGreaterThan(0);
  const direction = Math.atan2(p.vy, p.vx);
  expect(Math.atan2(Math.sin(p.heading - direction), Math.cos(p.heading - direction))).toBeCloseTo(0, 8);
  expect(view.prev.heading).toBe(p.heading);
  expect((view.x - view.prev.x) / DT).toBeCloseTo(p.vx, 3);
  expect((view.y - view.prev.y) / DT).toBeCloseTo(p.vy, 3);
});

it('keeps turning smoothly when an idle pose was already visible', () => {
  const sc = SCENARIOS.find(s => s.name === 'head-on')!;
  const net = new Network(sc.doc); net.rebuild();
  const sim = new SimWorld(sc.doc, net, 0x5ce7); sim.rebuildTopology();
  sim.pedestrianIntensity = 0; sim.trafficIntensity = 0;
  sim.usePedestrianEngine(createCrowdEngine());
  step(sim, { traffic: false, pedestrians: true });
  const id = addScriptedWalker(sim, { ...sc.walkers(net)[0]!, heading: Math.PI })!;
  sim.pedEngine.publish(sim);
  step(sim, { traffic: false, pedestrians: true });
  const p = inspectCrowd(sim).find(p => p.id === id)!;
  const turn = Math.abs(Math.atan2(Math.sin(p.heading - Math.PI), Math.cos(p.heading - Math.PI)));
  expect(turn).toBeLessThanOrEqual(2 * Math.PI * DT);
  expect(turn).toBeGreaterThan(0);
});
