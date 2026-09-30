import { describe, expect, it } from 'vitest';
import { step } from '@sim/pipeline';
import { DT } from '@sim/params';
import { m } from '@world/units';
import { createPeopleEngine } from '@sim/people/people';
import { fixtureDoc, simOf } from '../support/bodies';

/**
 * WHAT THE PLAYER SEES THE PEOPLE DO.
 *
 * Measured on the drawn body (`PedView`), tick by tick, on the saved player
 * map with its traffic: the defects players reported in the legacy model -
 * being dragged backwards at a kerb (305 times a waiting minute), sliding
 * sideways round corners (334 a minute), jumping, popping side to side,
 * turning on the spot, freezing - must not happen at all.
 */
describe('the People engine, as drawn', () => {
  it('walks forward only, never slides, jumps, pops or spins, and never freezes', () => {
    const sim = simOf(fixtureDoc(), 0x5eed, 2);
    sim.usePedestrianEngine(createPeopleEngine());
    const U = m(1);
    const last = new Map<number, { x: number; y: number; lat: number; flips: number[] }>();
    const headings = new Map<number, { t: number; h: number }[]>();
    const still = new Map<number, number>();
    let back = 0, side = 0, jump = 0, flip = 0, spin = 0, longest = 0, closest = Infinity, personSeconds = 0;
    const seconds = 45;
    for (let i = 0; i < Math.round(seconds / DT); i++) {
      step(sim, { traffic: true, pedestrians: true });
      const views = sim.pedViews;
      for (let a = 0; a < views.length; a++) {
        for (let b = a + 1; b < views.length; b++) {
          closest = Math.min(closest, Math.hypot(views[a]!.x - views[b]!.x, views[a]!.y - views[b]!.y) / U);
        }
      }
      const alive = new Set(views.map((v) => v.id));
      for (const id of [...still.keys()]) if (!alive.has(id)) still.delete(id);
      for (const v of views) {
        personSeconds += DT;
        // Standing, not waiting at a kerb: how long.
        if (v.v < m(0.1) && v.kerbWait === 0) {
          const t = (still.get(v.id) ?? 0) + DT;
          still.set(v.id, t);
          longest = Math.max(longest, t);
        } else still.delete(v.id);
        // Turning on the spot: over a quarter turn back and forth in a second.
        if (v.v < m(0.2)) {
          const hs = headings.get(v.id) ?? [];
          hs.push({ t: sim.clock.tick, h: v.heading });
          while (hs.length && sim.clock.tick - hs[0]!.t > 60) hs.shift();
          let total = 0;
          for (let k = 1; k < hs.length; k++) total += Math.abs(Math.atan2(Math.sin(hs[k]!.h - hs[k - 1]!.h), Math.cos(hs[k]!.h - hs[k - 1]!.h)));
          const net = hs.length > 1 ? Math.abs(Math.atan2(Math.sin(hs.at(-1)!.h - hs[0]!.h), Math.cos(hs.at(-1)!.h - hs[0]!.h))) : 0;
          if (total > Math.PI / 2 && total > net * 1.8) { spin++; hs.length = 0; }
          headings.set(v.id, hs);
        } else headings.delete(v.id);
        const prev = last.get(v.id);
        if (!prev) { last.set(v.id, { x: v.x, y: v.y, lat: 0, flips: [] }); continue; }
        const dx = (v.x - prev.x) / U, dy = (v.y - prev.y) / U;
        const hx = Math.cos(v.heading), hy = Math.sin(v.heading);
        const fwd = (dx * hx + dy * hy) / DT, lat = (-dx * hy + dy * hx) / DT;
        if (Math.hypot(dx, dy) / DT > 3) jump++;
        else if (fwd < -0.25) back++;
        else if (Math.abs(lat) > 0.5) side++;
        if (Math.abs(lat) > 0.15 && prev.lat !== 0 && Math.sign(lat) !== Math.sign(prev.lat)) prev.flips.push(sim.clock.tick);
        prev.flips = prev.flips.filter((t) => sim.clock.tick - t < 1 / DT);
        if (prev.flips.length >= 3) { flip++; prev.flips.length = 0; }
        prev.x = v.x; prev.y = v.y; prev.lat = Math.abs(lat) > 0.15 ? lat : prev.lat;
      }
    }
    expect(sim.pedViews.length).toBeGreaterThan(80);
    expect({ back, side, jump, flip }).toEqual({ back: 0, side: 0, jump: 0, flip: 0 });
    expect(spin / personSeconds * 60).toBeLessThan(0.2);
    expect(longest).toBeLessThan(5);
    // Bodies are 0.5 m across and never overlap.
    expect(closest).toBeGreaterThanOrEqual(0.49);
  }, 120_000);
});
