import { describe, expect, it } from 'vitest';
import { socialCue } from '@render/pedestrianSocial';
import type { PartyView, PedView } from '@sim/people/view';
import { m } from '@world/units';

const person = (id: number, rank: number, party: PartyView, y: number, ageClass: PedView['ageClass']): PedView => ({
  id, x: 0, y, heading: 0, prev: { x: 0, y, heading: 0 }, v: m(1), turnV: 0, age: 0,
  ageClass, gender: rank ? 'm' : 'f', party, rank,
  ground: 'footway', segment: undefined, stretch: 'walk:1|node:1', walking: true, kerbWait: 0, waitingFor: null, gesture: null,
});

function pair(): [PedView, PedView, Map<number, PedView>] {
  const party: PartyView = { id: 100, size: 2, archetype: 'family', hasChild: true };
  const first = person(100, 0, party, 0, 'adult');
  const second = person(101, 1, party, m(0.62), 'child');
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
    child.walking = false;
    expect(socialCue(adult, members, 2).holdWeight).toBe(0);
    child.walking = true;
    child.x = m(1);
    expect(socialCue(adult, members, 2).holdWeight).toBe(0);
  });
});
