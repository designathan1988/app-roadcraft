import { beforeAll, expect, it } from 'vitest';
import { Network } from '@world/network';
import { SimWorld } from '@sim/world';
import { m } from '@world/units';
import { AGENT_RADIUS } from '@sim/people/crowdNav';
import { DT } from '@sim/params';
import { step } from '@sim/pipeline';
import { initCrowd, createCrowdEngine, addScriptedWalker, inspectCrowd } from '@sim/people/crowd';
import { SCENARIOS } from '../../fixtures/crowdScenarios';

beforeAll(initCrowd);

it('does not release a passage waiter through a standing body in its approach', () => {
  const sc = SCENARIOS.find(s => s.name === 'gap-one')!;
  const net = new Network(sc.doc); net.rebuild();
  const sim = new SimWorld(sc.doc, net, 0x5ce7); sim.rebuildTopology();
  sim.pedestrianIntensity = 0; sim.trafficIntensity = 0;
  sim.usePedestrianEngine(createCrowdEngine());
  step(sim, { traffic: false, pedestrians: true });
  const ids = sc.walkers(net).map(p => addScriptedWalker(sim, p)!);
  let checked = 0;
  try {
    for (let i = 0; i < 12 / DT; i++) {
      step(sim, { traffic: false, pedestrians: true });
      const people = inspectCrowd(sim);
      const front = people.find(p => p.id === ids[3])!;
      const back = people.find(p => p.id === ids[5])!;
      if (front.narrow === null || !front.aside || !front.holding) continue;
      const dx = -back.x, dy = 14 - back.y;
      const t = Math.max(0, Math.min(1, ((front.x - back.x) * dx + (front.y - back.y) * dy) / (dx * dx + dy * dy)));
      if (Math.hypot(front.x - back.x - t * dx, front.y - back.y - t * dy) >= 2 * AGENT_RADIUS) continue;
      checked++;
      expect(back.passage, `rear walker admitted at ${(i * DT).toFixed(3)} while front still yields`).not.toBe(front.narrow);
    }
    expect(checked).toBeGreaterThan(0);
  } finally { sim.pedEngine.reset(sim); }
});

it('prefers a feasible side or forward yield in the completed trip direction', () => {
  const sc = SCENARIOS.find(s => s.name === 'head-on')!;
  const net = new Network(sc.doc); net.rebuild();
  const sim = new SimWorld(sc.doc, net, 0x5ce7); sim.rebuildTopology();
  sim.pedestrianIntensity = 0; sim.trafficIntensity = 0;
  sim.usePedestrianEngine(createCrowdEngine());
  step(sim, { traffic: false, pedestrians: true });
  const y = sc.walkers(net)[0]!.y;
  const id = addScriptedWalker(sim, { x: m(8), y, goal: { x: 0, y }, pace: m(1.2) })!;
  try {
    for (let i = 0; i < 20 / DT; i++) step(sim, { traffic: false, pedestrians: true });
    const stopped = inspectCrowd(sim).find(p => p.id === id)!;
    expect(stopped.holding).toBe(true);
    addScriptedWalker(sim, { x: stopped.x + m(1.9), y: stopped.y, goal: { x: stopped.x - m(4), y: stopped.y }, pace: m(1.2) });
    let yielded = false;
    for (let i = 0; i < 10 / DT; i++) {
      step(sim, { traffic: false, pedestrians: true });
      const p = inspectCrowd(sim).find(p => p.id === id)!;
      if (!p.aside) continue;
      yielded = true;
      // This trip ran west. Facing/render state is not part of the assertion.
      expect(p.aside.x).toBeLessThanOrEqual(p.x + 1e-5);
      break;
    }
    expect(yielded).toBe(true);
  } finally { sim.pedEngine.reset(sim); }
});
