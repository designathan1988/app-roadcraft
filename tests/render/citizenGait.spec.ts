import { appendFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createGait, gaitHeading, gaitPlays, stepGait, type Gait } from '@render/citizenGait';
import { auditFlow, auditGait, type GaitController } from './support/gaitAudit';

/**
 * WHAT THE LEGS DO AGAINST HOW THE BODY MOVES.
 *
 * Two minutes of the saved player map, traffic and all, with every pedestrian
 * driven through the renderer's own gait controller (`citizenGait.ts`) and
 * audited without a skinned mesh (`support/gaitAudit.ts`). Players reported
 * people walking in slow motion, gliding like ghosts, swivelling on the spot
 * with their legs still, and walking through street furniture. Measured
 * before the gait controller existed, on this map: 2 828 s of slow-motion
 * walking out of 9 033, 236 s of gliding, 15.1 rad of unstepped rotation.
 * With it: 43 s of 9 727, 42 s, 6.6 rad; 12.7 s inside furniture out of
 * 8 331 s walking. The ceilings below leave room for honest change and none
 * for the old defects.
 */
const CONTROLLER: GaitController<Gait> = {
  create: (ped, time, heading, hash) => createGait(ped, time, heading, hash),
  step: (g, ped, clips, time, heading, size, hash) => stepGait(g, ped, clips, time, heading, size, hash),
  plays: (g, clips, out) => gaitPlays(g, clips, out),
  heading: gaitHeading,
};

describe('citizen gait', () => {
  it('steps at the pace the body moves, and steps round its turns', () => {
    const audit = auditGait(CONTROLLER, 120);
    if (process.env.GAIT_REPORT) appendFileSync(process.env.GAIT_REPORT, `${JSON.stringify(audit)}\n`);
    expect(audit.walkSeconds).toBeGreaterThan(1000);
    // Slow motion: a walk cycle played at under three quarters of its rate.
    expect(audit.slowMotionSeconds / audit.walkSeconds).toBeLessThan(0.015);
    // Gliding: the body moving at a visible pace while the legs do not step.
    expect(audit.glideSeconds / audit.movingSeconds).toBeLessThan(0.008);
    // Swivelling on motionless legs, radians over the whole run: 12.2 before a
    // standing body was made to turn only as far as its turn clip steps it,
    // with the feet leading and each step finished; 5.4 after.
    expect(audit.unsteppedRotation).toBeLessThan(7.5);
    // Feet sliding, as a share of the pace: an absolute ceiling failed walkers
    // for walking at a real pace (1.15 m/s realised instead of 1.0) with the
    // same 2.4 % mismatch.
    expect(audit.skateMean / audit.movingSpeedMean).toBeLessThan(0.028);
  });

  it('walks round the furniture and the other people, not through them', () => {
    const flow = auditFlow(120);
    if (process.env.GAIT_REPORT) appendFileSync(process.env.GAIT_REPORT, `${JSON.stringify(flow)}\n`);
    expect(flow.walkingSeconds).toBeGreaterThan(1000);
    expect(flow.insideFurniture / flow.walkingSeconds).toBeLessThan(0.003);
    expect(flow.overlapping / flow.walkingSeconds).toBeLessThan(0.01);
  });
});
