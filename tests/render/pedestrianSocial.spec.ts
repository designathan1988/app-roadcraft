import { describe, expect, it } from 'vitest';
import { socialCue } from '@render/pedestrianSocial';
import { createPed, type Ped, type PedParty } from '@sim/peds/state';
import { m } from '@world/units';

function pair(): [Ped, Ped, Map<number, Ped>] {
  const party: PedParty = { id: 100, size: 2, archetype: 'family', pace: m(1), hasChild: true, goal: null, trip: 0 };
  const first = createPed({ id: 100, color: '#fff', speed: m(1), file: 0,
    ageClass: 'adult', gender: 'f', party, rank: 0,
    edge: 'walk:1', entry: 'node:1', s: 5, lat: 0, tick: 0 });
  const second = createPed({ id: 101, color: '#fff', speed: m(1), file: 1,
    ageClass: 'child', gender: 'm', party, rank: 1,
    edge: 'walk:1', entry: 'node:1', s: 5, lat: m(0.62), tick: 0 });
  first.x = second.x = 0;
  first.y = 0;
  second.y = m(0.62);
  first.heading = second.heading = 0;
  return [first, second, new Map([[first.id, first], [second.id, second]])];
}

describe('pedestrian social animation', () => {
  it('pairs a walking adult and child with opposite hands', () => {
    const [adult, child, members] = pair();
    const a = socialCue(adult, members, 2);
    const b = socialCue(child, members, 2);
    expect(a.holdSide).toBe(-1);
    expect(b.holdSide).toBe(1);
    expect(a.holdWeight).toBeGreaterThan(0);
    expect(b.holdWeight).toBeGreaterThan(0);
  });

  it('releases the hands when a companion crosses or falls behind', () => {
    const [adult, child, members] = pair();
    child.state = 'Crossing';
    expect(socialCue(adult, members, 2).holdWeight).toBe(0);
    child.state = 'Walking';
    child.x = m(1);
    expect(socialCue(adult, members, 2).holdWeight).toBe(0);
  });
});
