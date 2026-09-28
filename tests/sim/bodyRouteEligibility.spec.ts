import { expect, it } from 'vitest';
import { Network } from '@world/network';
import { SimWorld } from '@sim/world';
import { routeToDestination } from '@sim/routing/destination';
import { freshState, applyOp } from '../fuzz/support/ops';
import { generate } from '../fuzz/support/runner';

it('rejects a heavy route through a turn that fits a car', () => {
  const state = freshState();
  for (const op of generate(1, 40)) applyOp(state, op);
  const net = new Network(state.doc); net.rebuild();
  const sim = new SimWorld(state.doc, net, 73); sim.rebuildTopology();
  const limited = [...sim.graph.connectors.values()].find((c) => c.maxBodyClass === 1);
  expect(limited).toBeDefined();
  const carRoute = routeToDestination(sim, limited!.fromLane, limited!.toLane, 1);
  expect(carRoute).toContain(limited!.id);
  const busRoute = routeToDestination(sim, limited!.fromLane, limited!.toLane, 2);
  expect(busRoute === null || !busRoute.includes(limited!.id)).toBe(true);
  for (const id of busRoute ?? []) {
    const connector = sim.connector(id);
    if (connector) expect(connector.maxBodyClass).toBeGreaterThanOrEqual(2);
  }
});
