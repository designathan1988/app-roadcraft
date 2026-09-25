/** Every Rocketbox model shipped (`public/models/citizens/catalog.json`). Which of them may be drawn, and how, is `citizens.manifest.json` through `citizenCasting.ts`. */
export const CITIZEN_CATALOG = [
  { id: 'business_female_01', category: 'professions' },
  { id: 'business_female_02', category: 'professions' },
  { id: 'business_female_03', category: 'professions' },
  { id: 'business_female_04', category: 'professions' },
  { id: 'business_male_01', category: 'professions' },
  { id: 'business_male_02', category: 'professions' },
  { id: 'business_male_03', category: 'professions' },
  { id: 'business_male_04', category: 'professions' },
  { id: 'business_male_05', category: 'professions' },
  { id: 'business_male_06', category: 'professions' },
  { id: 'business_male_07', category: 'professions' },
  { id: 'chef_female_01', category: 'professions' },
  { id: 'construction_female_01', category: 'professions' },
  { id: 'construction_male_02', category: 'professions' },
  { id: 'construction_male_03', category: 'professions' },
  { id: 'construction_male_04', category: 'professions' },
  { id: 'construction_male_05', category: 'professions' },
  { id: 'construction_male_06', category: 'professions' },
  { id: 'construction_male_07', category: 'professions' },
  { id: 'construction_male_08', category: 'professions' },
  { id: 'delivery_male_01', category: 'professions' },
  { id: 'female_01', category: 'adults' },
  { id: 'female_02', category: 'adults' },
  { id: 'female_03', category: 'adults' },
  { id: 'female_04', category: 'adults' },
  { id: 'female_05', category: 'adults' },
  { id: 'female_06', category: 'adults' },
  { id: 'female_07', category: 'adults' },
  { id: 'female_08', category: 'adults' },
  { id: 'female_09', category: 'adults' },
  { id: 'female_10', category: 'adults' },
  { id: 'female_11', category: 'adults' },
  { id: 'female_12', category: 'adults' },
  { id: 'female_13', category: 'adults' },
  { id: 'female_14', category: 'adults' },
  { id: 'female_15', category: 'adults' },
  { id: 'female_17', category: 'adults' },
  { id: 'female_child_01', category: 'children' },
  { id: 'female_party_01', category: 'adults' },
  { id: 'female_party_02', category: 'adults' },
  { id: 'gardener_male_01', category: 'professions' },
  { id: 'male_01', category: 'adults' },
  { id: 'male_02', category: 'adults' },
  { id: 'male_03', category: 'adults' },
  { id: 'male_04', category: 'adults' },
  { id: 'male_05', category: 'adults' },
  { id: 'male_06', category: 'adults' },
  { id: 'male_07', category: 'adults' },
  { id: 'male_08', category: 'adults' },
  { id: 'male_09', category: 'adults' },
  { id: 'male_10', category: 'adults' },
  { id: 'male_11', category: 'adults' },
  { id: 'male_12', category: 'adults' },
  { id: 'male_13', category: 'adults' },
  { id: 'male_14', category: 'adults' },
  { id: 'male_15', category: 'adults' },
  { id: 'male_16', category: 'adults' },
  { id: 'male_17', category: 'adults' },
  { id: 'male_18', category: 'adults' },
  { id: 'male_19', category: 'adults' },
  { id: 'male_20', category: 'adults' },
  { id: 'male_21', category: 'adults' },
  { id: 'male_child_01', category: 'children' },
  { id: 'male_child_02', category: 'children' },
  { id: 'medical_female_01', category: 'professions' },
  { id: 'medical_female_02', category: 'professions' },
  { id: 'medical_female_03', category: 'professions' },
  { id: 'medical_male_01', category: 'professions' },
  { id: 'medical_male_02', category: 'professions' },
  { id: 'medical_male_03', category: 'professions' },
  { id: 'medical_male_04', category: 'professions' },
  { id: 'pilot_female_01', category: 'professions' },
  { id: 'pilot_female_02', category: 'professions' },
  { id: 'pilot_male_01', category: 'professions' },
  { id: 'pilot_male_02', category: 'professions' },
  { id: 'pilot_male_03', category: 'professions' },
  { id: 'police_male_01', category: 'professions' },
  { id: 'police_male_03', category: 'professions' },
  { id: 'police_male_06', category: 'professions' },
  { id: 'security_female_01', category: 'professions' },
  { id: 'security_male_01', category: 'professions' },
  { id: 'sports_female_02', category: 'professions' },
  { id: 'sports_male_02', category: 'professions' },
  { id: 'sports_male_03', category: 'professions' },
  { id: 'sports_male_04', category: 'professions' },
  { id: 'wood_male_01', category: 'professions' },
] as const;

export const CITIZEN_MODELS: readonly string[] = CITIZEN_CATALOG.map(model => model.id);

/**
 * What a body is dressed for.
 *
 * `uniform` is a job's outfit - a footballer's kit, a security guard, a
 * surgeon, a pilot, a site worker - which only makes sense in its own place.
 * Drawn at random into the street crowd, uniforms put a footballer, a
 * bouncer and a man in a suit into one "group" of friends. They are left out
 * of the crowd entirely (and so never downloaded) until the game has places
 * they belong to. `business` dresses colleagues; `casual` everybody else.
 */
export type Wardrobe = 'casual' | 'business' | 'uniform';

const UNIFORMS = ['construction_', 'chef_', 'delivery_', 'gardener_', 'medical_', 'pilot_', 'police_',
  'security_', 'sports_', 'wood_'];

export function wardrobeOf(id: string): Wardrobe {
  if (id.startsWith('business_')) return 'business';
  if (UNIFORMS.some((prefix) => id.startsWith(prefix))) return 'uniform';
  return 'casual';
}

/** A style a person is dressed in: what the group they are with calls for. */
export type DressStyle = 'casual' | 'business';
