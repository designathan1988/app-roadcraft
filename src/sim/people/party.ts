import type { Rng } from '@core/rng';
import { clamp } from '@core/scalar';
import { PED } from '../params';
import { PED_BEHAVIOUR } from '../peds/behaviour';
import { personHash, type PartyArchetype, type PersonAgeClass } from './view';

/**
 * Who goes out together: how many, how old, what kind of group, and the pace
 * they keep. The same shares as the legacy model drew (most people walk
 * alone; families, couples, friends, colleagues, elderly friends, tourists),
 * drawn from the People engine's own stream.
 */
export interface PartyPlan {
  readonly size: number;
  readonly ages: readonly PersonAgeClass[];
  readonly archetype: PartyArchetype;
  readonly hasChild: boolean;
  /** Each member's own walking speed, u/s. */
  readonly speeds: readonly number[];
}

export function planParty(rng: Rng, id: number, room: number): PartyPlan {
  const size = Math.min(room, weighted(rng, PED_BEHAVIOUR.partySizes));
  const ages: PersonAgeClass[] = size >= 2 && size <= 3 && rng.float() < PED_BEHAVIOUR.familyChance
    ? Array.from({ length: size }, (_, i) => (i === 0 ? 'adult' : 'child'))
    : Array.from({ length: size }, () => {
      const roll = rng.float();
      if (roll < PED_BEHAVIOUR.childShare) return 'child';
      if (roll < PED_BEHAVIOUR.childShare + PED_BEHAVIOUR.elderShare) return 'elder';
      return 'adult';
    });
  // A child never walks the streets alone.
  if (size === 1 && ages[0] === 'child') ages[0] = 'adult';
  return { size, ages, archetype: archetypeOf(ages, id), hasChild: ages.includes('child'), speeds: ages.map((a) => speedOf(rng, a)) };
}

function weighted(rng: Rng, table: readonly (readonly [number, number])[]): number {
  let total = 0;
  for (const [, w] of table) total += w;
  let roll = rng.float() * total;
  for (const [value, w] of table) {
    roll -= w;
    if (roll < 0) return value;
  }
  return table[0]![0];
}

/** What kind of group a party of these ages is, read from the ages. */
function archetypeOf(ages: readonly PersonAgeClass[], id: number): PartyArchetype {
  if (ages.length === 1) return 'solo';
  const child = ages.includes('child');
  const adult = ages.includes('adult');
  const elder = ages.includes('elder');
  if (child && (adult || elder)) return 'family';
  if (adult && elder) return 'family';
  if (elder) return 'elders';
  if (child) return 'friends';
  const h = personHash(id ^ 0x9a47);
  const tourists = ((h >>> 4) & 3) === 0;
  if (ages.length === 2) return (h & 3) < 2 ? 'couple' : tourists ? 'tourists' : 'friends';
  return (h & 7) < 2 ? 'colleagues' : tourists ? 'tourists' : 'friends';
}

function normal(rng: Rng, mean: number, sd: number): number {
  const u = Math.max(1e-9, rng.float()), v = rng.float();
  return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function speedOf(rng: Rng, age: PersonAgeClass): number {
  if (age === 'child') {
    return clamp(normal(rng, PED_BEHAVIOUR.childSpeedMean, PED_BEHAVIOUR.childSpeedSd), PED_BEHAVIOUR.childSpeedMin, PED.maxSpeed);
  }
  if (age === 'elder') {
    return clamp(normal(rng, PED_BEHAVIOUR.elderSpeedMean, PED_BEHAVIOUR.elderSpeedSd), PED_BEHAVIOUR.elderSpeedMin, PED_BEHAVIOUR.elderSpeedMax);
  }
  return clamp(normal(rng, PED.meanSpeed, PED.speedSd), PED.minSpeed, PED.maxSpeed);
}
