import { beforeAll, expect, it } from 'vitest';
import { Network } from '@world/network';
import { SimWorld } from '@sim/world';
import { step } from '@sim/pipeline';
import { addScriptedWalker, createCrowdEngine, initCrowd, inspectCrowd } from '@sim/people/crowd';
import { SCENARIOS } from '../../fixtures/crowdScenarios';

beforeAll(initCrowd);

/** Identical navigation and population; only the initial visual facing differs. */
function group(headingOffset: number): SimWorld {
  const sc = SCENARIOS.find(s => s.name === 'group')!;
  const net = new Network(sc.doc);
  net.rebuild();
  const sim = new SimWorld(sc.doc, net, 0x5ce7);
  sim.rebuildTopology();
  sim.pedestrianIntensity = 0;
  sim.trafficIntensity = 0;
  sim.usePedestrianEngine(createCrowdEngine());
  step(sim, { traffic: false, pedestrians: true });
  const ids: number[] = [];
  for (const p of sc.walkers(net)) {
    ids.push(addScriptedWalker(sim, {
      ...p,
      heading: Math.atan2(p.goal.y - p.y, p.goal.x - p.x) + headingOffset,
      ...(p.leader !== undefined ? { leader: ids[p.leader]! } : {}),
    })!);
  }
  return sim;
}

it('visual facing cannot change a party target or its Detour movement', () => {
  const facingForward = group(0);
  const facingBack = group(Math.PI);
  for (let tick = 0; tick < 3000; tick++) {
    step(facingForward, { traffic: false, pedestrians: true });
    step(facingBack, { traffic: false, pedestrians: true });
    const motion = (sim: SimWorld) => inspectCrowd(sim).map(p => ({
      id: p.id, x: p.x, y: p.y, vx: p.vx, vy: p.vy, target: p.target,
    }));
    expect(motion(facingBack), `navigation at tick ${tick}`).toEqual(motion(facingForward));
  }
});
