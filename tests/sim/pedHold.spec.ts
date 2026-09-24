import { describe, expect, it } from 'vitest';

import { RoadDoc } from '@world/doc';
import { DT } from '@sim/params';
import { stepController } from '@sim/signals/fsm';
import { simOf } from './support/bodies';

/**
 * A GREEN IS NOT HELD FOR EVER BY SOMEBODY WHO NEVER FINISHES CROSSING.
 *
 * `stepController` never cuts a green over people still on its crossings,
 * because walkers always finish. Two walkers deadlocked face to face at a kerb
 * - one on the zebra, one on the footway - never did, and the stage that had
 * released the first held green for minutes while every other approach of the
 * junction starved (`groupStarved`, 512 times in five minutes on a one-way
 * couplet). The hold is now bounded.
 */
describe('a signal stage with somebody stuck on its crossing', () => {
  it('still ends', () => {
    const doc = new RoadDoc();
    const centre = doc.addNode({ x: 0, y: 0 });
    for (const [x, y] of [[-400, 0], [400, 0], [0, -400], [0, 400]] as const) {
      doc.addSegment(centre.id, doc.addNode({ x, y }).id, 1);
    }
    doc.setNodeControl(centre.id, 'signal');
    const sim = simOf(doc, 1, 1);
    const controller = sim.controller(centre.id)!;
    const deps = { ...sim.signalDeps(), pedestriansCrossing: () => true };
    const start = controller.stageIndex;
    let seconds = 0;
    while (controller.stageIndex === start && controller.sub === 'GREEN' && seconds < 600) {
      stepController(controller, deps);
      seconds += DT;
    }
    expect(controller.sub).not.toBe('GREEN');
    expect(seconds).toBeLessThan(120);
  });
});
