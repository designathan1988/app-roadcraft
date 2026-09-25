import { describe, expect, it } from 'vitest';
import { step } from '@sim/pipeline';
import { DT } from '@sim/params';
import type { Ped, PedParty } from '@sim/peds/state';
import { CITIZEN_MODELS, wardrobeOf } from '@render/citizenCatalog';
import { dressFor } from '@render/riggedCitizens';
import { fixtureDoc, simOf } from './support/bodies';

/**
 * EVERY GROUP IS PEOPLE WHO BELONG TOGETHER.
 *
 * A party's kind is read from its members' ages (`sim/peds/spawn.ts`
 * partyArchetype), and the renderer dresses the whole party to match
 * (`dressFor`). Bodies used to come from the whole roster, uniforms included:
 * a footballer, a security guard and a man in a suit walking as one group.
 */
describe('pedestrian groups', () => {
  const sim = simOf(fixtureDoc(), 0xa11ce, 2);
  sim.pedestrianIntensity = 3;
  const parties = new Map<number, { party: PedParty; members: Ped[] }>();
  sim.clock.run(Math.round(120 / DT), () => {
    step(sim, { traffic: false, pedestrians: true });
    for (const p of sim.peds.values()) {
      const entry = parties.get(p.party.id) ?? { party: p.party, members: [] };
      if (!entry.members.includes(p)) entry.members.push(p);
      parties.set(p.party.id, entry);
    }
  });

  it('draws every member inside the kind of group it is', () => {
    const kinds = new Set<string>();
    let checked = 0;
    for (const { party, members } of parties.values()) {
      if (members.length < party.size) continue;
      checked++;
      kinds.add(party.archetype);
      const ages = members.map((m) => m.ageClass);
      switch (party.archetype) {
        case 'solo': expect(party.size).toBe(1); break;
        case 'family':
          // Children with an adult or an elder, or an adult out with an elder.
          expect(ages.includes('adult') || ages.includes('elder'), `family ${party.id}`).toBe(true);
          expect(ages.includes('child') || (ages.includes('adult') && ages.includes('elder')), `family ${party.id}`).toBe(true);
          break;
        case 'couple': expect(ages).toEqual(['adult', 'adult']); break;
        case 'colleagues': expect(ages.every((a) => a === 'adult'), `colleagues ${party.id}`).toBe(true); break;
        case 'friends': expect(new Set(ages).size, `friends ${party.id}`).toBe(1); break;
        case 'elders': expect(ages.every((a) => a === 'elder'), `elders ${party.id}`).toBe(true); break;
      }
    }
    expect(checked).toBeGreaterThan(30);
    expect(kinds.size).toBeGreaterThanOrEqual(4);
  });

  it('dresses a group alike, and never in a uniform', () => {
    for (const { party } of parties.values()) {
      const style = dressFor(party);
      if (party.archetype === 'colleagues') expect(style).toBe('business');
      if (party.archetype === 'family' || party.archetype === 'couple' || party.archetype === 'friends' ||
        party.archetype === 'elders') expect(style).toBe('casual');
    }
    const uniforms = CITIZEN_MODELS.filter((id) => wardrobeOf(id) === 'uniform');
    expect(uniforms.length).toBeGreaterThan(0);
    for (const id of uniforms) expect(/^(construction|chef|delivery|gardener|medical|pilot|police|security|sports|wood)_/.test(id)).toBe(true);
  });
});
