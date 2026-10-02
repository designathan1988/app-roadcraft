import { ageFromYears } from './body/macro';
import { CLOTH_COLOURS, WARDROBE, randomPerson, type BottomStyle, type PersonSpec, type TopStyle } from './spec';

/**
 * The street's people: a fixed roster of MakeHuman bodies, made once from
 * seeds, that the crowd draws (`render/citizenCasting.ts`). Each one is dressed
 * for a wardrobe - a set of clothes that go together - so a party can be
 * dressed to one code, as the casting asks.
 */
export type RosterWardrobe = 'casual' | 'smart-casual' | 'business' | 'sport-casual' | 'traditional';
export type RosterAge = 'child' | 'young' | 'adult' | 'senior';

export interface RosterEntry {
  readonly id: string;
  readonly wardrobe: RosterWardrobe;
  readonly ageBand: RosterAge;
  readonly gender: 'f' | 'm';
  readonly person: PersonSpec;
  /** Tall enough to reach a motorcycle's grips and pegs and a bicycle's pedals. */
  readonly rides: boolean;
}

const YEARS: Readonly<Record<RosterAge, readonly [number, number]>> = {
  child: [6, 12], young: [17, 28], adult: [30, 58], senior: [66, 84],
};

const DARK = [0x22252b, 0x2e3440, 0x3b4a6b, 0x4a4a4a] as const;
const MUTED = [0x6a8fbf, 0xc9a68a, 0x7a9a5a, 0x8a5a9a, 0xf2f0ea, 0x5c5c5c] as const;
const BRIGHT = [0xb03a2e, 0xd9822b, 0xe8c547, 0x2f9d8f, 0x3b6fd1, 0xe05a8a] as const;
const DENIM = [0x3b4a6b, 0x2e3a52, 0x5a6f8f] as const;

interface Dress {
  readonly top: readonly TopStyle[];
  readonly topColours: readonly number[];
  readonly bottom: (female: boolean) => readonly BottomStyle[];
  readonly bottomColours: readonly number[];
}

const DRESS: Readonly<Record<RosterWardrobe, Dress>> = {
  casual: { top: ['tshirt', 'tshirt', 'longsleeve'], topColours: [...MUTED, ...BRIGHT], bottom: (f) => (f ? ['trousers', 'skirt', 'shorts'] : ['trousers', 'shorts']), bottomColours: [...DENIM, 0xc9a68a] },
  'smart-casual': { top: ['longsleeve', 'tshirt'], topColours: [...MUTED], bottom: (f) => (f ? ['trousers', 'skirt'] : ['trousers']), bottomColours: [0xc9a68a, 0x5c5c5c, ...DENIM] },
  business: { top: ['longsleeve'], topColours: [0xf2f0ea, 0xdfe6ee, ...DARK], bottom: (f) => (f ? ['trousers', 'skirt'] : ['trousers']), bottomColours: [...DARK] },
  'sport-casual': { top: ['tank', 'tshirt'], topColours: [...BRIGHT, 0xf2f0ea], bottom: () => ['shorts', 'trousers'], bottomColours: [0x22252b, 0x3b4a6b, 0x5c5c5c] },
  traditional: { top: ['longsleeve'], topColours: [0xf2f0ea, 0xc9a68a, 0x2f5d50, 0x8a2f1f], bottom: (f) => (f ? ['skirt'] : ['trousers']), bottomColours: [0xf2f0ea, 0xc9a68a, 0x22252b] },
};

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = <T>(r: () => number, list: readonly T[]): T => list[Math.floor(r() * list.length)]!;

/** How many people of each sex, age band and wardrobe the street has. */
const PLAN: readonly (readonly [RosterAge, RosterWardrobe, number])[] = [
  ['child', 'casual', 4], ['child', 'sport-casual', 3],
  ['young', 'casual', 4], ['young', 'sport-casual', 3], ['young', 'smart-casual', 2], ['young', 'business', 1],
  ['adult', 'casual', 4], ['adult', 'smart-casual', 3], ['adult', 'business', 3], ['adult', 'sport-casual', 3], ['adult', 'traditional', 2],
  ['senior', 'casual', 3], ['senior', 'smart-casual', 3], ['senior', 'sport-casual', 1], ['senior', 'business', 1], ['senior', 'traditional', 2],
];

/** The MakeHuman outfits each wardrobe dresses in. */
const OUTFIT: Readonly<Record<RosterWardrobe, { female: readonly string[]; male: readonly string[] }>> = {
  casual: {
    female: ['female_casualsuit01', 'female_casualsuit02', 'female_sportsuit01'],
    male: ['male_casualsuit01', 'male_casualsuit02', 'male_casualsuit03', 'male_casualsuit04', 'male_casualsuit05', 'male_casualsuit06'],
  },
  'smart-casual': { female: ['female_elegantsuit01', 'female_casualsuit01'], male: ['male_casualsuit01', 'male_casualsuit03', 'male_casualsuit05'] },
  business: { female: ['female_elegantsuit01'], male: ['male_elegantsuit01'] },
  'sport-casual': { female: ['female_sportsuit01', 'female_casualsuit02'], male: ['male_casualsuit02', 'male_casualsuit04', 'male_casualsuit06', 'male_worksuit01'] },
  traditional: { female: ['female_elegantsuit01', 'female_casualsuit01'], male: ['male_worksuit01', 'male_casualsuit01'] },
};
void WARDROBE;

/** Dyes a suit takes: never a party colour. */
const SOBER: readonly number[] = [0x22252b, 0x2c3550, 0x3a3f47, 0x4a3a2c, 0x5c5c5c, 0x1f3a32];

/**
 * An outfit and its colour that nobody in the roster wears yet: undyed or dyed
 * one of `palette`. Picked freely, 84 people came out in 44 combinations, and
 * a street showed the same blue suit three times over.
 */
function dressUnlike(r: () => number, used: Set<string>, outfits: readonly string[], palette: readonly number[]): { outfit: string; outfitTint: number | null } {
  const tints: (number | null)[] = [null, ...palette];
  for (let attempt = 0; attempt < 64; attempt++) {
    const outfit = pick(r, outfits);
    const outfitTint = pick(r, tints);
    const key = `${outfit}|${outfitTint}`;
    if (used.has(key)) continue;
    used.add(key);
    return { outfit, outfitTint };
  }
  return { outfit: pick(r, outfits), outfitTint: pick(r, palette) };
}

export function makeRoster(): RosterEntry[] {
  const out: RosterEntry[] = [];
  const used = new Set<string>();
  let n = 0;
  for (const [age, wardrobe, count] of PLAN) {
    for (const gender of ['f', 'm'] as const) {
      for (let i = 0; i < count; i++) {
        const seed = 0x51a7 + n * 7919;
        const r = rng(seed ^ 0x9e3779b9);
        const [lo, hi] = YEARS[age];
        const years = lo + r() * (hi - lo);
        const female = gender === 'f';
        const base = randomPerson(1000 + n, seed, {
          body: {
            gender: female ? r() * 0.2 : 0.8 + r() * 0.2,
            age: ageFromYears(years),
          },
        });
        const dress = DRESS[wardrobe];
        const top = pick(r, dress.top);
        const topColour = pick(r, dress.topColours);
        const person: PersonSpec = {
          ...base,
          look: {
            ...base.look,
            top,
            topColour,
            bottom: pick(r, dress.bottom(female)),
            bottomColour: pick(r, dress.bottomColours.filter((c) => c !== topColour)),
            shoes: wardrobe === 'business' ? pick(r, [0x22252b, 0x3a2418]) : wardrobe === 'sport-casual' ? pick(r, [0xf2f0ea, 0x22252b]) : base.look.shoes,
            // The MakeHuman outfit for the wardrobe: a suit for business, a
            // sports suit for sport, everyday clothes otherwise.
            ...(age === 'child' ? {}
              : dressUnlike(r, used, OUTFIT[wardrobe][female ? 'female' : 'male'], wardrobe === 'business' ? SOBER : CLOTH_COLOURS)),
          },
        };
        // Riders reach the controls of the two-wheelers as they are drawn
        // (`render/riderPoses.ts`, measured in tests/render/riderFit.spec.ts).
        const rides = age !== 'child' && age !== 'senior' && person.body.height >= (female ? 0.55 : 0.53) && years >= 18;
        out.push({ id: `mh_${String(n).padStart(2, '0')}`, wardrobe, ageBand: age, gender, person, rides });
        n++;
      }
    }
  }
  return out;
}
