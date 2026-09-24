import { describe, expect, it } from 'vitest';
import { step } from '@sim/pipeline';
import { DT } from '@sim/params';
import { STUCK_RELEASE } from '@sim/peds/clearance';
import { fixtureDoc, simOf } from './support/bodies';

/**
 * NOBODY STANDS FROZEN.
 *
 * Measured on the saved player map before these checks existed: 27 % of all
 * pedestrian time was spent standing still while wanting to walk, one walker
 * stood for 151 s, and people waited at kerbs for up to 189 s — at WALK signals
 * and at empty uncontrolled zebras. The causes were rigid personal discs that
 * deadlocked head-on meetings, corners one person wide, walkers bound round a
 * corner queueing behind people waiting to cross, waiters boxing each other in
 * at the kerb, gap acceptance that treated a stopped queue as arriving
 * traffic, and turning vehicles that never gave way to people at the kerb.
 */
describe('pedestrian flow', () => {
  it('never leaves anybody frozen on a footway or at a kerb', () => {
    const sim = simOf(fixtureDoc(), 0x51de, 2);
    const kerb = new Map<number, number>();
    let maxStuck = 0;
    let maxKerb = 0;
    let pedTicks = 0;
    let heldTicks = 0;

    sim.clock.run(Math.round(200 / DT), () => {
      step(sim, { traffic: true, pedestrians: true });
      for (const p of sim.peds.values()) {
        pedTicks++;
        maxStuck = Math.max(maxStuck, p.stuck);
        if (p.stuck > 0) heldTicks++;
        const n = p.state === 'WaitAtKerb' ? (kerb.get(p.id) ?? 0) + 1 : 0;
        kerb.set(p.id, n);
        maxKerb = Math.max(maxKerb, n * DT);
      }
    });

    expect(pedTicks).toBeGreaterThan(100_000);
    // Held up, a walker commits to a side and then squeezes shoulder to
    // shoulder (never through anybody); it must never run away. The worst
    // measured is a head-on meeting at a zebra's mouth, untied in 6.3 s;
    // before the fix people stood for 151 s.
    expect(maxStuck).toBeLessThan(STUCK_RELEASE + 5);
    // A kerb wait is bounded by the signal cycle, not by a deadlock.
    expect(maxKerb).toBeLessThan(90);
    expect(heldTicks / pedTicks).toBeLessThan(0.05);
    // 200 s of the full crowd: about 20 s alone, past the default timeout when
    // it shares the machine with the rest of the suite under coverage.
  }, 180_000);
});
