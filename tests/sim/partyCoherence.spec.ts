import { describe, expect, it } from 'vitest';
import { step } from '@sim/pipeline';
import { DT } from '@sim/params';
import type { Ped, PedParty } from '@sim/peds/state';
import manifest from '@render/citizens.manifest.json';
import { CITIZEN_MODELS } from '@render/citizenCatalog';
import {
  CROWD, CastingRegistry, compatible, whitelist, type Company, type Wardrobe,
} from '@render/citizenCasting';
import { companyOf } from '@render/riggedCitizens';
import { seatPerson } from '@sim/vehicles/kerbStops';
import { fixtureDoc, simOf } from './support/bodies';

/**
 * EVERY GROUP IS PEOPLE WHO BELONG TOGETHER, DRESSED ALIKE, AND NOBODY IN A UNIFORM.
 *
 * This runs on the REAL manifest and the ONE casting function the renderer
 * uses (`citizenCasting.pickCitizenModel`), not on mocks: every walker of a
 * two-minute crowd, every occupant of every vehicle and every rider is cast,
 * several times over as the pool recycles, and every body must be in the
 * whitelist and every company dressed in mutually compatible wardrobes.
 */
const UNIFORM = /^(construction|chef|gardener|medical|pilot|police|security|fire|military)_|^sports_male_0[23]$|^business_male_04$/;

describe('the citizen whitelist', () => {
  it('fails closed: no entry, a missing tag or a uniform keeps a model out', () => {
    const ids = CROWD.map((m) => m.id);
    for (const id of ids) expect(UNIFORM.test(id), id).toBe(false);
    // Every shipped model is reviewed.
    const reviewed = new Set(manifest.models.map((m) => m.id));
    for (const id of CITIZEN_MODELS) expect(reviewed.has(id), `${id} has no manifest entry`).toBe(true);
    // Unlisted, untagged, rejected and uniform entries are all excluded.
    expect(whitelist([{ id: 'male_01' }], ['male_01'])).toEqual([]);
    expect(whitelist([{ id: 'male_01', allowedInCrowd: true, wardrobe: 'casual', ageBand: 'young', gender: 'm', quality: 'reject' }], ['male_01'])).toEqual([]);
    expect(whitelist([{ id: 'male_01', allowedInCrowd: true, wardrobe: 'uniform', ageBand: 'young', gender: 'm', quality: 'ok' }], ['male_01'])).toEqual([]);
    expect(whitelist([{ id: 'nobody', allowedInCrowd: true, wardrobe: 'casual', ageBand: 'young', gender: 'm', quality: 'ok' }], ['male_01'])).toEqual([]);
    expect(ids.length).toBeGreaterThanOrEqual(50);
  });

  it('has only the allowed wardrobe pairings', () => {
    expect(compatible('casual', 'sport-casual')).toBe(true);
    expect(compatible('casual', 'smart-casual')).toBe(true);
    expect(compatible('business', 'smart-casual')).toBe(true);
    expect(compatible('business', 'casual')).toBe(false);
    expect(compatible('business', 'sport-casual')).toBe(false);
    expect(compatible('sport-casual', 'smart-casual')).toBe(false);
    expect(compatible('traditional', 'casual')).toBe(false);
  });
});

describe('pedestrian groups', () => {
  const sim = simOf(fixtureDoc(), 0xa11ce, 2);
  sim.pedestrianIntensity = 3;
  const parties = new Map<number, { party: PedParty; members: Ped[] }>();
  sim.clock.run(Math.round(120 / DT), () => {
    step(sim, { traffic: true, pedestrians: true });
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
          expect(ages.includes('adult') || ages.includes('elder'), `family ${party.id}`).toBe(true);
          expect(ages.includes('child') || (ages.includes('adult') && ages.includes('elder')), `family ${party.id}`).toBe(true);
          break;
        case 'couple': expect(ages).toEqual(['adult', 'adult']); break;
        case 'colleagues': case 'tourists': expect(ages.every((a) => a === 'adult'), `${party.archetype} ${party.id}`).toBe(true); break;
        case 'friends': expect(new Set(ages).size, `friends ${party.id}`).toBe(1); break;
        case 'elders': expect(ages.every((a) => a === 'elder'), `elders ${party.id}`).toBe(true); break;
      }
    }
    expect(checked).toBeGreaterThan(30);
    expect(kinds.size).toBeGreaterThanOrEqual(4);
  });

  it('casts every walker, occupant and rider inside the whitelist, every company in one compatible code', () => {
    const registry = new CastingRegistry();
    registry.recordCensus = true;
    const wardrobeOf = (index: number): Wardrobe => CROWD[index]!.wardrobe;
    const groups = new Map<string, Set<Wardrobe>>();
    const twins = new Map<string, number[]>();
    const censusModels = new Set<string>();
    let cast = 0;
    for (let round = 0; round < 3; round++) {
      registry.beginFrame();
      for (const { party, members } of parties.values()) {
        for (const p of members) {
          const c = registry.pickCitizenModel({ seed: p.id, gender: p.gender, ageClass: p.ageClass, company: companyOf(party),
            companyId: party.id, hasChild: party.hasChild, x: p.x, y: p.y });
          expect(c, `walker ${p.id} got no body`).not.toBeNull();
          cast++;
          if (party.size > 1) {
            const key = `p${party.id}`;
            const set = groups.get(key) ?? new Set();
            set.add(wardrobeOf(c!.index));
            groups.set(key, set);
            const list = twins.get(key) ?? [];
            if (round === 0) list.push(c!.index);
            twins.set(key, list);
          }
        }
      }
      for (const v of sim.vehicles.values()) {
        const company: Company = v.archetype.shape === 'bus' ? 'bus' : v.archetype.shape === 'truck' ? 'truck'
          : v.archetype.shape === 'motorcycle' || v.archetype.shape === 'bicycle' ? 'rider' : 'car';
        const seats = Math.min(32, v.archetype.seats);
        let hasChild = false;
        for (let i = 0; i < seats; i++) if ((v.seats & (1 << i)) && seatPerson(v, i).ageClass === 'child') hasChild = true;
        for (const pickedFirst of [true, false]) for (let i = 0; i < seats; i++) {
          if ((v.seats & (1 << i)) === 0) continue;
          if ((v.people[i] !== undefined) !== pickedFirst) continue;
          const who = seatPerson(v, i);
          const c = registry.pickCitizenModel({ ...who, company, companyId: v.id, hasChild, helmet: v.archetype.shape === 'motorcycle', x: 0, y: 0 });
          expect(c, `seat ${i} of vehicle ${v.id} got no body`).not.toBeNull();
          cast++;
          if (company === 'car' || company === 'truck') {
            const key = `v${v.id}`;
            const set = groups.get(key) ?? new Set();
            set.add(wardrobeOf(c!.index));
            groups.set(key, set);
          }
        }
      }
      for (const row of registry.census()) censusModels.add(row.model);
    }
    expect(cast).toBeGreaterThan(300);
    const ids = new Set(CROWD.map((m) => m.id));
    for (const model of censusModels) expect(ids.has(model), model).toBe(true);
    const mixed: string[] = [];
    for (const [key, set] of groups) {
      const list = [...set];
      if (list.some((a) => list.some((b) => !compatible(a, b)))) mixed.push(`${key}: ${list.join(' + ')}`);
    }
    expect(mixed).toEqual([]);
    // Nobody in one party wears the same body as another member.
    for (const [key, list] of twins) expect(new Set(list).size, `twins in ${key}`).toBe(list.length);
  });
});
