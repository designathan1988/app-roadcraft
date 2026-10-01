import { DEFAULT_MACRO, ageFromYears, type MacroParams } from './body/macro';

/**
 * A person: everything the Person Creator sets, and all a citizen needs to be
 * drawn. Small (a few hundred bytes), saved with the city, and the same record
 * for a pedestrian, a driver and a passenger.
 */
export interface PersonSpec {
  readonly id: number;
  readonly name: string;
  readonly body: MacroParams;
  /** Regional sliders, -1..1, by slider name (`l-`/`r-` for one side). */
  readonly features: Readonly<Record<string, number>>;
  readonly look: PersonLook;
}

export type HairStyle = 'none' | 'short' | 'long';
export type TopStyle = 'none' | 'tank' | 'tshirt' | 'longsleeve';
export type BottomStyle = 'trousers' | 'shorts' | 'skirt';

export interface PersonLook {
  /** Colours as 0xRRGGBB. */
  readonly skin: number;
  readonly eyes: number;
  readonly hair: number;
  readonly hairStyle: HairStyle;
  readonly top: TopStyle;
  readonly topColour: number;
  readonly bottom: BottomStyle;
  readonly bottomColour: number;
  readonly shoes: number;
  /**
   * MakeHuman garments, fitted to the body (`people/body/proxy.ts`), by
   * name: what the person wears when set. Without them the older tailored
   * shells above are drawn, so people saved before still look as they did.
   */
  readonly outfit?: string;
  readonly footwear?: string;
  /** A hairstyle, or 'none'. */
  readonly hairCut?: string;
  readonly brows?: string;
  readonly lashes?: string;
  /** A hat, or 'none'. */
  readonly hat?: string;
  /** A colour the outfit is dyed, or null for its own colours. */
  readonly outfitTint?: number | null;
}

/** The MakeHuman (CC0) items a person can wear, by name (`public/models/people/proxies`). */
export const WARDROBE = {
  outfits: {
    male: ['male_casualsuit01', 'male_casualsuit02', 'male_casualsuit03', 'male_casualsuit04', 'male_casualsuit05',
      'male_casualsuit06', 'male_elegantsuit01', 'male_worksuit01'],
    female: ['female_casualsuit01', 'female_casualsuit02', 'female_elegantsuit01', 'female_sportsuit01'],
  },
  footwear: ['shoes01', 'shoes02', 'shoes03', 'shoes04', 'shoes05', 'shoes06'],
  hair: {
    short: ['short01', 'short02', 'short03', 'short04'],
    long: ['long01', 'bob01', 'bob02', 'braid01', 'ponytail01', 'afro01'],
  },
  brows: ['eyebrow001', 'eyebrow002', 'eyebrow003', 'eyebrow004', 'eyebrow005', 'eyebrow006', 'eyebrow007', 'eyebrow008',
    'eyebrow009', 'eyebrow010', 'eyebrow011', 'eyebrow012'],
  lashes: ['eyelashes01', 'eyelashes02', 'eyelashes03', 'eyelashes04'],
  hats: ['fedora01', 'fedora_cocked'],
} as const;

/** Every outfit, either sex's. */
export const ALL_OUTFITS: readonly string[] = [...WARDROBE.outfits.male, ...WARDROBE.outfits.female];
export const ALL_HAIR: readonly string[] = [...WARDROBE.hair.short, ...WARDROBE.hair.long];

/** The items a look wears, by name: what has to be loaded to draw it. */
export function wornItems(look: PersonLook): string[] {
  if (!look.outfit) return [];
  const out = [look.outfit];
  if (look.footwear) out.push(look.footwear);
  if (look.hairCut && look.hairCut !== 'none') out.push(look.hairCut);
  if (look.brows) out.push(look.brows);
  if (look.lashes) out.push(look.lashes);
  if (look.hat && look.hat !== 'none') out.push(look.hat);
  return out;
}

/** Skin tones from very light to very dark, a deliberately wide range. */
export const SKIN_TONES: readonly number[] = [
  0xf6dccb, 0xf0cdb2, 0xe5b898, 0xd9a47f, 0xc68b62, 0xb07349, 0x8f5b3a, 0x6f452b, 0x553220, 0x3d2417,
];
export const HAIR_COLOURS: readonly number[] = [
  0x1a1410, 0x2e2018, 0x4a3022, 0x6b4428, 0x8c5a2e, 0xa8743c, 0xc9a165, 0xe0c58f, 0x9a9a98, 0xdedcd8, 0x8a2f1f,
];
export const EYE_COLOURS: readonly number[] = [0x3b2416, 0x5a3a22, 0x6b6a3a, 0x3d6b4a, 0x3d5d8a, 0x7a8a9a];
export const CLOTH_COLOURS: readonly number[] = [
  0xf2f0ea, 0x22252b, 0x3b4a6b, 0x6a8fbf, 0x2f5d50, 0x7a9a5a, 0xb03a2e, 0xd9822b, 0xe8c547, 0x8a5a9a, 0xc9a68a, 0x5c5c5c,
];

export const DEFAULT_LOOK: PersonLook = {
  skin: SKIN_TONES[3]!, eyes: EYE_COLOURS[1]!, hair: HAIR_COLOURS[2]!, hairStyle: 'short',
  top: 'tshirt', topColour: CLOTH_COLOURS[3]!, bottom: 'trousers', bottomColour: CLOTH_COLOURS[2]!, shoes: CLOTH_COLOURS[1]!,
  outfit: 'male_casualsuit02', footwear: 'shoes01', hairCut: 'short02', brows: 'eyebrow001', lashes: 'eyelashes01', hat: 'none', outfitTint: null,
};

export function defaultPerson(id: number, name = ''): PersonSpec {
  return { id, name, body: { ...DEFAULT_MACRO }, features: {}, look: { ...DEFAULT_LOOK } };
}

/** A small, fast, seedable generator (mulberry32). */
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

/**
 * A plausible stranger, the same one for the same seed: any sex, an age from
 * a toddler to the very old (weighted towards adults, as a street is), every
 * skin tone, and clothes and hair to go with them.
 */
export function randomPerson(id: number, seed: number, keep: { body?: Partial<PersonSpec['body']>; look?: Partial<PersonSpec['look']> } = {}): PersonSpec {
  const r = rng(seed);
  const years = r() < 0.12 ? 2 + r() * 14 : r() < 0.82 ? 18 + r() * 47 : 65 + r() * 25;
  const gender = r() < 0.5 ? r() * 0.25 : 0.75 + r() * 0.25;
  const shares = [r() ** 2, r() ** 2, r() ** 2];
  const total = shares.reduce((s, x) => s + x, 0) || 1;
  const body: MacroParams = {
    gender,
    age: ageFromYears(years),
    muscle: 0.3 + r() * 0.45,
    weight: 0.25 + r() * 0.55,
    // Narrow on purpose: the slider is steep (0.33 to 0.67 is 1.56 to 1.94 m
    // for a man), and a street of giants and very short people is not a street.
    height: 0.42 + r() * 0.18,
    proportions: 0.4 + r() * 0.5,
    african: shares[0]! / total,
    asian: shares[1]! / total,
    caucasian: shares[2]! / total,
    cupsize: 0.35 + r() * 0.4,
    firmness: 0.4 + r() * 0.4,
    ...keep.body,
  };
  const old = years > 60;
  const female = gender < 0.5;
  const look: PersonLook = {
    skin: pick(r, SKIN_TONES),
    eyes: pick(r, EYE_COLOURS),
    hair: old && r() < 0.7 ? pick(r, [0x9a9a98, 0xdedcd8]) : pick(r, HAIR_COLOURS),
    hairStyle: !female && r() < 0.12 ? 'none' : female && r() < 0.6 ? 'long' : 'short',
    top: pick(r, ['tank', 'tshirt', 'tshirt', 'longsleeve', 'longsleeve'] as const),
    topColour: pick(r, CLOTH_COLOURS),
    bottom: female && r() < 0.35 ? 'skirt' : r() < 0.25 ? 'shorts' : 'trousers',
    // Never the top's own colour: a matching pair reads as a boiler suit.
    bottomColour: 0,
    shoes: pick(r, [0x22252b, 0x4a3022, 0xf2f0ea, 0x5c5c5c]),
    ...keep.look,
  };
  const bottoms = CLOTH_COLOURS.filter((c) => c !== look.topColour);
  const coloured: PersonLook = keep.look?.bottomColour !== undefined ? look : { ...look, bottomColour: pick(r, bottoms) };
  // Dressed in MakeHuman garments: an outfit cut for the body's sex, shoes,
  // a hairstyle of the length drawn above, brows and lashes; now and then a
  // hat, and an outfit dyed a colour of the street's.
  const hairCut = coloured.hairStyle === 'none' ? 'none'
    : pick(r, coloured.hairStyle === 'long' ? WARDROBE.hair.long : WARDROBE.hair.short);
  const finished: PersonLook = {
    ...coloured,
    outfit: pick(r, female ? WARDROBE.outfits.female : WARDROBE.outfits.male),
    // Heels (shoes03) only ever on a woman.
    footwear: pick(r, female ? WARDROBE.footwear : WARDROBE.footwear.filter((f) => f !== 'shoes03')),
    hairCut,
    brows: pick(r, WARDROBE.brows),
    lashes: pick(r, WARDROBE.lashes),
    hat: !female && years > 30 && r() < 0.08 ? pick(r, WARDROBE.hats) : 'none',
    outfitTint: r() < 0.35 ? pick(r, CLOTH_COLOURS) : null,
    ...keep.look,
  };
  return { id, name: '', body, features: {}, look: finished };
}

const unit = (x: unknown, fallback: number): number =>
  typeof x === 'number' && Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : fallback;
const colour = (x: unknown, fallback: number): number =>
  typeof x === 'number' && Number.isInteger(x) && x >= 0 && x <= 0xffffff ? x : fallback;
const oneOf = <T extends string>(x: unknown, values: readonly T[], fallback: T): T =>
  typeof x === 'string' && (values as readonly string[]).includes(x) ? (x as T) : fallback;

/**
 * A person read from outside (a save, a file): every field brought into range,
 * every unknown dropped. Null when it is not a person at all.
 */
export function normalizePerson(raw: unknown): PersonSpec | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const o = raw as Record<string, unknown>;
  if (typeof o['id'] !== 'number' || !Number.isInteger(o['id']) || o['id'] < 0 || o['id'] > 2 ** 31) return null;
  const b = (typeof o['body'] === 'object' && o['body'] !== null ? o['body'] : {}) as Record<string, unknown>;
  const l = (typeof o['look'] === 'object' && o['look'] !== null ? o['look'] : {}) as Record<string, unknown>;
  const f = (typeof o['features'] === 'object' && o['features'] !== null ? o['features'] : {}) as Record<string, unknown>;
  const body = Object.fromEntries(
    (Object.keys(DEFAULT_MACRO) as (keyof MacroParams)[]).map((k) => [k, unit(b[k], DEFAULT_MACRO[k])]),
  ) as unknown as MacroParams;
  const features: Record<string, number> = {};
  for (const [k, v] of Object.entries(f)) {
    if (typeof v === 'number' && Number.isFinite(v) && v !== 0 && k.length < 80) features[k] = Math.min(1, Math.max(-1, v));
  }
  return {
    id: o['id'],
    name: typeof o['name'] === 'string' ? o['name'].slice(0, 40) : '',
    body,
    features,
    look: {
      skin: colour(l['skin'], DEFAULT_LOOK.skin),
      eyes: colour(l['eyes'], DEFAULT_LOOK.eyes),
      hair: colour(l['hair'], DEFAULT_LOOK.hair),
      hairStyle: oneOf(l['hairStyle'], ['none', 'short', 'long'] as const, DEFAULT_LOOK.hairStyle),
      top: oneOf(l['top'], ['none', 'tank', 'tshirt', 'longsleeve'] as const, DEFAULT_LOOK.top),
      topColour: colour(l['topColour'], DEFAULT_LOOK.topColour),
      bottom: oneOf(l['bottom'], ['trousers', 'shorts', 'skirt'] as const, DEFAULT_LOOK.bottom),
      bottomColour: colour(l['bottomColour'], DEFAULT_LOOK.bottomColour),
      shoes: colour(l['shoes'], DEFAULT_LOOK.shoes),
      // MakeHuman garments only when the save names them, and only known ones.
      ...(typeof l['outfit'] === 'string' && ALL_OUTFITS.includes(l['outfit']) ? {
        outfit: l['outfit'],
        footwear: oneOf(l['footwear'], WARDROBE.footwear, WARDROBE.footwear[0]),
        hairCut: oneOf(l['hairCut'], ['none', ...ALL_HAIR], 'none'),
        brows: oneOf(l['brows'], WARDROBE.brows, WARDROBE.brows[0]),
        lashes: oneOf(l['lashes'], WARDROBE.lashes, WARDROBE.lashes[0]),
        hat: oneOf(l['hat'], ['none', ...WARDROBE.hats], 'none'),
        outfitTint: l['outfitTint'] === null || l['outfitTint'] === undefined ? null : colour(l['outfitTint'], 0xffffff),
      } : {}),
    },
  };
}
