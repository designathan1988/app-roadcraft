import { describe, expect, it } from 'vitest';
import { RoadDoc } from '@world/doc';
import { step } from '@sim/pipeline';
import { DT, MAX_LATERAL_ACCEL } from '@sim/params';
import { comfortableLateral, curveSpeedCap } from '@sim/vehicles/curvature';
import type { SimWorld } from '@sim/world';
import { fixtureDoc, simOf } from './support/bodies';

/**
 * A BEND IS TAKEN AT A SPEED A DRIVER WOULD TAKE IT.
 *
 * Nothing used to slow a vehicle for the curvature of the road: a turn at a
 * junction took a fixed share of the limit and a curved street took none.
 * Measured before this, on a single bend of an urban street, vehicles pulled
 * 10.3 m/s² sideways, and on the saved player map 22 m/s² - more than twice
 * what a tyre holds - with 1 % of all samples over 1 g.
 */

/** Curvature of a lanelet at `s`, over the same kind of chord a driver reads. */
function curvatureAt(sim: SimWorld, lanelet: string, s: number): number {
  const lane = sim.lanelet(lanelet);
  if (!lane) return 0;
  const h = Math.min(6, lane.length / 2);
  const at = Math.min(Math.max(s, h), lane.length - h);
  const a = lane.centre.sampleAt(at - h).t;
  const b = lane.centre.sampleAt(at + h).t;
  return Math.abs(Math.atan2(a.x * b.y - a.y * b.x, a.x * b.x + a.y * b.y)) / (2 * h);
}

function bendDoc(): RoadDoc {
  const doc = new RoadDoc();
  const a = doc.addNode({ x: -600, y: 0 });
  const b = doc.addNode({ x: 0, y: 0 });
  const c = doc.addNode({ x: 300, y: 300 });
  const d = doc.addNode({ x: 300, y: 900 });
  doc.addSegment(a.id, b.id, 2);
  const bend = doc.addSegment(b.id, c.id, 2)!;
  doc.setSegmentCurve(bend.id, { t: 0.5, h: -160 });
  doc.addSegment(c.id, d.id, 2);
  return doc;
}

describe('curvature speed', () => {
  it('keeps the sideways pull of every bend within what a driver accepts', () => {
    // The most any driver accepts: the comfortable figure at full aggression,
    // plus what the chord estimate and one step of lag add.
    const ceiling = MAX_LATERAL_ACCEL * 1.2 * 1.35;
    for (const [name, doc] of [['bend', bendDoc()], ['player-map', fixtureDoc()]] as const) {
      const sim = simOf(doc, 5, 2);
      let worst = 0;
      let inBend = 0;
      sim.clock.run(Math.round(150 / DT), () => {
        step(sim, { traffic: true, pedestrians: false });
        for (const v of sim.vehicles.values()) {
          const k = curvatureAt(sim, v.lanelet, v.s - v.archetype.length / 2);
          if (k > 0.002) inBend++;
          worst = Math.max(worst, v.v * v.v * k);
        }
      });
      expect(inBend, name).toBeGreaterThan(1000);
      expect(worst, name).toBeLessThan(ceiling);
    }
  });

  it('brakes for a bend before it, never all at once at its entry', () => {
    const sim = simOf(bendDoc(), 5, 2);
    let worstDemand = 0;
    let braked = 0;
    sim.clock.run(Math.round(150 / DT), () => {
      step(sim, { traffic: true, pedestrians: false });
      for (const v of sim.vehicles.values()) {
        const cap = curveSpeedCap(sim, v);
        if (cap < v.v) braked++;
        // The deceleration the bend demands in the next step. A cap far above
        // the vehicle's speed may move by any amount; one below it must never
        // ask for more than comfortable braking, or the bend was seen late.
        worstDemand = Math.max(worstDemand, (v.v - cap) / DT - v.driver.b);
      }
    });
    expect(braked).toBeGreaterThan(0);
    expect(worstDemand).toBeLessThan(0.5);
  });

  it('leaves a straight road alone and gives heavy vehicles a gentler limit', () => {
    const doc = new RoadDoc();
    const a = doc.addNode({ x: -800, y: 0 });
    const b = doc.addNode({ x: 800, y: 0 });
    doc.addSegment(a.id, b.id, 2);
    const sim = simOf(doc, 5, 1);
    sim.clock.run(Math.round(40 / DT), () => step(sim, { traffic: true, pedestrians: false }));
    let checked = 0;
    for (const v of sim.vehicles.values()) {
      checked++;
      expect(curveSpeedCap(sim, v)).toBe(Infinity);
      const heavy = v.archetype.length > 20;
      if (heavy) expect(comfortableLateral(v)).toBeLessThan(MAX_LATERAL_ACCEL * 1.2 * 0.71);
    }
    expect(checked).toBeGreaterThan(0);
  });
});
