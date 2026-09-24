import { describe, expect, it } from 'vitest';
import { LAYOUTS, fixtureDoc, layoutDoc, simOf } from './support/bodies';
import { auditPedestrians } from './support/pedAudit';

/**
 * NOBODY WALKS ON THE GRASS.
 *
 * Every drawn body centre, every tick, checked against the surface polygons
 * the road mesh is built from (`support/pedAudit.ts`): on the footway or its
 * kerb, or on a zebra while crossing it. Nothing else.
 *
 * Measured before this on the saved player map, seed 3, 120 s: 536.7 s of
 * 10 977 pedestrian-seconds (4.9 %) on the open ground, every second of it on
 * a corner, whose path was an arc about the junction's centre that swung wide
 * over the verge. The corners now follow the footway that is drawn, every
 * offset is held between walls fitted to it (`corridor.ts`), and the drawn
 * body is checked last of all.
 *
 * Sitting on a bench is the one exception, and is counted apart: the benches
 * stand on the verge beside the footway, and somebody who goes to sit on one
 * is at the bench.
 */
describe('pedestrian containment', () => {
  it('keeps every pedestrian on the footway or a zebra on the saved player map', () => {
    const audit = auditPedestrians(simOf(fixtureDoc(), 3, 2), 90);
    expect(audit.pedSeconds).toBeGreaterThan(5000);
    expect(audit.openGround, JSON.stringify(audit.offBy)).toBe(0);
    expect(audit.carriageway, JSON.stringify(audit.offBy)).toBe(0);
  });

  it('keeps every pedestrian on the footway or a zebra at every junction shape', () => {
    for (const layout of LAYOUTS) {
      const sim = simOf(layoutDoc(layout, 170).doc, 7, 2);
      sim.pedestrianIntensity = 4;
      const audit = auditPedestrians(sim, 60);
      expect(audit.pedSeconds, layout.name).toBeGreaterThan(500);
      expect(audit.offWalkable, `${layout.name}: ${JSON.stringify(audit.offBy)}`).toBe(0);
    }
  });
});
