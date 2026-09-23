import { describe, expect, it } from 'vitest';
import { step } from '@sim/pipeline';
import { DT } from '@sim/params';
import { pedPose } from '@sim/pose';
import { PED_BEHAVIOUR } from '@sim/peds/behaviour';
import { LAYOUTS, fixtureDoc, layoutDoc, simOf } from './support/bodies';

/**
 * PEOPLE WALK; THEY DO NOT MARCH, TWITCH OR SNAP.
 *
 * Measured on the saved player map before this: 42,885 heading changes of more
 * than 8.6 degrees in a single tick over two minutes — a figure spinning on the
 * spot at every footway corner and every step aside — 266 position jumps, and
 * 3,167 instantaneous speed changes, because pose was rebuilt from the path
 * frame each tick and speed was assigned rather than integrated.
 *
 * What the eye reads as "robotic" is the absence of these: a body that turns at
 * a human rate towards where it is actually going, a speed that rises and falls
 * over a stride rather than switching, and a sideways step that accelerates and
 * settles. The gait itself is varied in `render/riggedCitizens.ts`; the
 * simulation's job is to give it continuous motion to play against.
 */

/** Deceleration beyond which a stop is abrupt rather than a brake, u/s². */
const HARD = 6;

/** Human turning rate, plus room for one tick of blending. */
const TURN_LIMIT_PER_TICK = 2.6 * DT * 1.5;

describe('pedestrian motion', () => {
  it('turns, accelerates and steps aside continuously', () => {
    const scenarios = [
      { name: 'cross', doc: layoutDoc(LAYOUTS[0]!).doc },
      { name: 'player-grid', doc: fixtureDoc() },
    ];

    for (const scenario of scenarios) {
      const sim = simOf(scenario.doc, 3, 2);
      const last = new Map<number, { x: number; y: number; angle: number; v: number; lat: number; edge: string; entry: string }>();
      let ticks = 0;
      let worstTurn = 0;
      let worstStep = 0;
      let worstAccel = 0;
      let hardStops = 0;
      let worstLateral = -Infinity;

      sim.clock.run(Math.round(120 / DT), () => {
        step(sim, { traffic: true, pedestrians: true });
        for (const p of sim.peds.values()) {
          const pose = pedPose(sim, p, 1);
          if (!pose) continue;
          ticks++;
          const before = last.get(p.id);
          if (before) {
            let turn = Math.abs(pose.angle - before.angle) % (2 * Math.PI);
            if (turn > Math.PI) turn = 2 * Math.PI - turn;
            worstTurn = Math.max(worstTurn, turn);
            // A step longer than the fastest walk is a teleport. Edge changes
            // included: the pose is world space, so they are continuous too.
            worstStep = Math.max(worstStep, Math.hypot(pose.p.x - before.x, pose.p.y - before.y));
            const accel = Math.abs(p.v - before.v) / DT;
            if (accel > HARD) hardStops++;
            worstAccel = Math.max(worstAccel, accel);
            // Offsets are per edge; compare only along one traversal.
            if (before.edge === p.edge && before.entry === p.entry) {
              worstLateral = Math.max(worstLateral, Math.abs(p.lat - before.lat) - PED_BEHAVIOUR.lateralRate * DT);
            }
          }
          last.set(p.id, { x: pose.p.x, y: pose.p.y, angle: pose.angle, v: p.v, lat: p.lat, edge: p.edge, entry: p.entry });
        }
      });

      expect(ticks, scenario.name).toBeGreaterThan(50_000);
      expect(worstTurn, `${scenario.name}: heading snap`).toBeLessThanOrEqual(TURN_LIMIT_PER_TICK);
      expect(worstStep, `${scenario.name}: position jump`).toBeLessThan(0.3);
      // Walkers slow as they come up to a knot rather than stopping dead: the
      // clearance is probed a braking distance plus two seconds of travel
      // ahead. What remains is the last resort — two people meeting head on
      // inside the 0.6 m gate between their bodies, and a vehicle sweeping
      // across a kerb — which IS a stop, and the renderer eases the gait out
      // of it over a third of a second. It must stay rare.
      expect(hardStops / ticks, `${scenario.name}: hard stops`).toBeLessThan(0.006);
      expect(worstAccel).toBeGreaterThan(0);
      // Sideways motion never exceeds the steering rate.
      expect(worstLateral, `${scenario.name}: lateral jump`).toBeLessThanOrEqual(1e-9);
    }
  });

  it('gives each person their own pace, and stops only where there is a reason', () => {
    // The saved player map: destinations close enough that people arrive.
    const sim = simOf(fixtureDoc(), 11, 2);
    const speeds = new Map<number, number>();
    let walkingTicks = 0;
    let stoppedWhileWalking = 0;
    let pausedAtDestination = 0;

    sim.clock.run(Math.round(150 / DT), () => {
      step(sim, { traffic: true, pedestrians: true });
      for (const p of sim.peds.values()) {
        if (p.state !== 'Walking') continue;
        walkingTicks++;
        speeds.set(p.id, Math.max(speeds.get(p.id) ?? 0, p.v));
        if (p.v < 0.05) {
          stoppedWhileWalking++;
          if (p.pause > 0) pausedAtDestination++;
        }
      }
    });

    // Nobody walks at the same speed as everybody else: a real spread of
    // cruising paces, not one speed with noise on it.
    const values = [...speeds.values()];
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const sd = Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length);
    expect(values.length).toBeGreaterThan(8);
    expect(sd / mean).toBeGreaterThan(0.1);
    // Standing still on a footway happens, but rarely, and a share of it is a
    // deliberate pause at somewhere somebody wanted to be.
    expect(stoppedWhileWalking / walkingTicks).toBeLessThan(0.08);
    expect(pausedAtDestination).toBeGreaterThan(0);
  });
});
