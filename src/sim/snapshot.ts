import type { SimWorld } from './world';

/**
 * A stable fingerprint of simulation state.
 *
 * Quantized so that meaningless last-bit differences do not register, and taken
 * over id-sorted agents so it cannot depend on map insertion order. Used to
 * assert that the same seed and the same inputs produce the same run — and that
 * stepping one tick at a time is identical to stepping five, which is the real
 * test of a fixed timestep.
 */
export function hashSim(w: SimWorld): number {
  let h = 2166136261;

  const mix = (n: number): void => {
    h = Math.imul(h ^ (n & 0xff), 16777619) >>> 0;
    h = Math.imul(h ^ ((n >>> 8) & 0xff), 16777619) >>> 0;
    h = Math.imul(h ^ ((n >>> 16) & 0xff), 16777619) >>> 0;
    h = Math.imul(h ^ ((n >>> 24) & 0xff), 16777619) >>> 0;
  };

  const mixText = (s: string): void => {
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0;
  };

  const q = (v: number): number => Math.round(v * 1000) | 0;

  for (const v of w.vehiclesInIdOrder()) {
    mix(v.id);
    mixText(v.lanelet);
    mix(q(v.s));
    mix(q(v.v));
  }

  for (const p of w.pedsInIdOrder()) {
    mix(p.id);
    mixText(p.edge);
    mix(q(p.s));
    mixText(p.state);
  }

  for (const node of w.junctionNodesInOrder()) {
    const c = w.controllers.get(node);
    if (!c) continue;
    mix(node);
    mix(c.stageIndex);
    mixText(c.sub);
    mix(q(c.elapsed));
  }

  return h >>> 0;
}
