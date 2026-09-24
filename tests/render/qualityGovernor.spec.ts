import { describe, expect, it } from 'vitest';

import { QualityGovernor, type QualityLevel } from '@render/quality';

/** Feeds `seconds` of frames of one length and cost; returns every tier change. */
function run(governor: QualityGovernor, seconds: number, frame: number, costMs: number): QualityLevel[] {
  const changes: QualityLevel[] = [];
  for (let t = 0; t < seconds; t += frame) {
    const next = governor.sample(frame, costMs);
    if (next) {
      governor.set(next);
      changes.push(next);
    }
  }
  return changes;
}

describe('the automatic quality governor', () => {
  it('drops a tier when frames are slow', () => {
    const governor = new QualityGovernor('high');
    expect(run(governor, 6, 1 / 25, 30)[0]).toBe('medium');
  });

  it('climbs back once the display is kept up with and the frames are cheap', () => {
    // It used to need a median frame under 9 ms to climb, which a 60 Hz
    // display never reports: one slow stretch left the game on the low tier
    // for the rest of the session.
    const governor = new QualityGovernor('high');
    run(governor, 12, 1 / 20, 40);
    expect(governor.current).toBe('low');
    run(governor, 30, 1 / 60, 3);
    expect(governor.current).toBe('high');
  });

  it('never climbs above the tier it started on', () => {
    const governor = new QualityGovernor('high');
    expect(run(governor, 30, 1 / 60, 1)).toEqual([]);
    expect(governor.current).toBe('high');
  });

  it('does not climb while the frames are expensive, even at 60 fps', () => {
    const governor = new QualityGovernor('medium', 'high');
    expect(run(governor, 30, 1 / 60, 12)).toEqual([]);
  });

  it('stops trying a tier the machine could not hold', () => {
    const governor = new QualityGovernor('medium', 'high');
    // Climbs, then the higher tier is slow at once: back down, and it holds.
    let tier: QualityLevel = governor.current;
    const history: QualityLevel[] = [];
    for (let t = 0; t < 60; t += 1 / 60) {
      const slow = tier === 'high';
      const next = governor.sample(slow ? 1 / 25 : 1 / 60, slow ? 30 : 3);
      if (next) {
        governor.set(next);
        tier = next;
        history.push(next);
      }
    }
    expect(history.slice(0, 2)).toEqual(['high', 'medium']);
    // No second attempt within the hold.
    expect(history.length).toBe(2);
  });
});
