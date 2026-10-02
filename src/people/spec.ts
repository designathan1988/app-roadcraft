import { DEFAULT_MACRO, ageFromYears, yearsFromAge, type MacroParams } from './body/macro';
import { phenotype } from './phenotype';

/**
 * A person: everything the Person Creator sets, and all a citizen needs to be
 * drawn. Small (a few hundred bytes), saved with the city, and the same record
 * for a pedestrian, a driver and a passenger.
 */
export interface PersonSpec {
  readonly id: number;
  readonly name: string;
  /** Resting expression, -1 subdued through 0 neutral to 1 cheerful. */
  readonly mood?: number;
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
  /** Optional editable pigment coordinates; skin remains the rendered sRGB colour. */
  readonly melanin?: number;
  readonly undertone?: number;
  readonly beard?: 'none' | 'stubble' | 'moustache' | 'beard';
  readonly makeup?: number;
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

/** Imported outfits were authored for adults; no child fit has been reviewed. */
export type ClothingAudience = 'adult' | 'child' | 'any';
export const OUTFIT_AUDIENCE: Readonly<Record<string, ClothingAudience>> = Object.fromEntries(
  [...WARDROBE.outfits.male, ...WARDROBE.outfits.female].map((name) => [name, 'adult' as const]),
);

export function outfitsForAge(years: number, outfits: readonly string[]): readonly string[] {
  return outfits.filter((name) => OUTFIT_AUDIENCE[name] === 'any'
    || OUTFIT_AUDIENCE[name] === (years < 16 ? 'child' : 'adult'));
}

/** Reviewed silhouettes from the shipped eyebrow textures; all remain in the creator. */
const BROW_PROFILES = {
  arched: ['eyebrow001', 'eyebrow003', 'eyebrow008', 'eyebrow010'],
  straightOrFull: ['eyebrow002', 'eyebrow004', 'eyebrow005', 'eyebrow009', 'eyebrow012'],
} as const;

/** Every outfit, either sex's. */
export const ALL_OUTFITS: readonly string[] = [...WARDROBE.outfits.male, ...WARDROBE.outfits.female];
export const ALL_HAIR: readonly string[] = [...WARDROBE.hair.short, ...WARDROBE.hair.long];

/** The items a look wears, by name: what has to be loaded to draw it. */
export function wornItems(look: PersonLook): string[] {
  const out: string[] = look.outfit ? [look.outfit] : [];
  if (look.outfit && look.footwear) out.push(look.footwear);
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
    muscle: 0.28 + (keep.body?.gender ?? gender) * 0.1 + r() * 0.3,
    weight: 0.3 + (1 - (keep.body?.gender ?? gender)) * 0.04 + r() * 0.4,
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
  const actualYears = yearsFromAge(body.age);
  const female = body.gender < 0.5;
  const pigments = phenotype(body, r);
  const look: PersonLook = {
    melanin: pigments.melanin, undertone: pigments.undertone,
    skin: pigments.skin,
    eyes: pigments.eyes,
    hair: pigments.hair,
    // Mostly long for women and short for men, never only that.
    hairStyle: !female && r() < 0.12 ? 'none' : female ? (r() < 0.72 ? 'long' : 'short') : r() < 0.1 ? 'long' : 'short',
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
    beard: !female && actualYears >= 18 ? pick(r, ['none', 'none', 'stubble', 'moustache', 'beard'] as const) : 'none',
    makeup: female && actualYears >= 18 && r() < 0.3 ? 0.15 + r() * 0.25 : 0,
    outfit: pick(r, female ? WARDROBE.outfits.female : WARDROBE.outfits.male),
    // Heels (shoes03) only ever on a woman.
    footwear: pick(r, female ? WARDROBE.footwear : WARDROBE.footwear.filter((f) => f !== 'shoes03')),
    hairCut,
    brows: pick(r, female ? BROW_PROFILES.arched : BROW_PROFILES.straightOrFull),
    lashes: pick(r, WARDROBE.lashes),
    hat: !female && years > 30 && r() < 0.08 ? pick(r, WARDROBE.hats) : 'none',
    // Dyed more often than not: a dozen outfits make a street of uniforms
    // in their own colours.
    outfitTint: r() < 0.65 ? pick(r, CLOTH_COLOURS) : null,
    ...keep.look,
  };
  // A face with something in it: most people a gentle smile, some at rest,
  // a few serious; brows set a little differently on everybody. MakeHuman's
  // neutral face, on everybody, read as a street of masks.
  const mood = r();
  const features: Record<string, number> = {
    'mouth-angles-down-up': mood < 0.65 ? 0.2 + r() * 0.4 : mood < 0.9 ? r() * 0.15 : -0.1 - r() * 0.2,
    'mouth-laugh-lines-in-out': mood < 0.65 ? r() * 0.3 : 0,
    'eyebrows-angle-down-up': (r() - 0.5) * 0.5,
    'eyebrows-trans-down-up': (r() - 0.5) * 0.4,
    ...faceShape(r, body, actualYears),
  };
  if (actualYears < 16) {
    // The tailored shells follow child anatomy; adult proxies have no reviewed child fit.
    const { outfit: _outfit, footwear: _footwear, ...childLook } = finished;
    void _outfit; void _footwear;
    return { id, name: '', body, features, look: { ...childLook, top: 'tshirt', bottom: 'shorts', hat: 'none' } };
  }
  return { id, name: '', body, features, look: finished };
}

/**
 * A face of one's own: the head's shape, and the nose, mouth, eyes, chin,
 * cheeks, forehead and ears each set a little differently. Values lean to the
 * middle (the sum of two draws) so most faces are ordinary and a few
 * striking, as in any street. Everybody wore MakeHuman's one default face
 * before - the same face on every body, whatever its build or skin.
 */
function faceShape(r: () => number, body: MacroParams, years: number): Record<string, number> {
  const around = (amp: number): number => (r() + r() - 1) * amp;
  const shapes = ['head-oval', 'head-round', 'head-square', 'head-rectangular', 'head-diamond', 'head-triangular', 'head-invertedtriangular'];
  // Whole-head shape and local contours should tell the same story. Unrelated
  // large shape presets previously overwhelmed the much smaller jaw profile.
  const grown = Math.max(0, Math.min(1, (years - 10) / 10));
  const profileShapes = r() < grown * 0.7
    ? (r() < body.gender ? ['head-square', 'head-rectangular', 'head-oval'] : ['head-oval', 'head-round', 'head-invertedtriangular'])
    : shapes;
  const out: Record<string, number> = { [pick(r, profileShapes)]: 0.2 + r() * 0.3 };
  for (const [name, amp] of FACE_SLIDERS) out[name] = around(amp);
  // Folded eyelids with an East Asian heritage; bags under the eyes with age.
  out['eye-epicanthus-in-out'] = -body.asian * (0.3 + r() * 0.5);
  out['eye-bag-decr-incr'] = Math.max(-0.3, Math.min(0.8, (years - 35) / 50 + around(0.2)));
  {
    // Overlapping artistic profiles, strongest after puberty; not a classifier.
    const adult = Math.max(0, Math.min(1, (years - 10) / 10));
    const sex = (body.gender * 2 - 1) * adult;
    out['chin-width-decr-incr'] = sex * 0.32 + around(0.22);
    out['chin-bones-decr-incr'] = sex * 0.24 + around(0.2);
    out['chin-prominent-decr-incr'] = sex * 0.24 + around(0.2);
    out['mouth-lowerlip-volume-decr-incr'] = -sex * 0.85 + around(0.1);
    out['mouth-upperlip-volume-decr-incr'] = -sex * 0.85 + around(0.1);
    out['cheek-bones-decr-incr'] = -sex * 0.12 + around(0.3);
    out['measure-neck-circ-decr-incr'] = sex * 0.12 + around(0.15);
    out['measure-waist-circ-decr-incr'] = sex * 0.1 + around(0.15);
    out['measure-hips-circ-decr-incr'] = -sex * 0.12 + around(0.15);
  }
  return out;
}

/** The face's sliders a stranger varies, and how far either way. */
const FACE_SLIDERS: readonly (readonly [string, number])[] = [
  ['head-fat-decr-incr', 0.4], ['head-scale-horiz-decr-incr', 0.3], ['head-scale-vert-decr-incr', 0.3],
  ['nose-scale-horiz-decr-incr', 0.6], ['nose-scale-vert-decr-incr', 0.5], ['nose-hump-decr-incr', 0.6],
  ['nose-point-width-decr-incr', 0.6], ['nose-curve-concave-convex', 0.5], ['nose-nostrils-width-decr-incr', 0.5],
  ['nose-volume-decr-incr', 0.5], ['nose-point-down-up', 0.4], ['nose-greek-decr-incr', 0.4],
  ['mouth-scale-horiz-decr-incr', 0.5], ['mouth-lowerlip-volume-decr-incr', 0.6], ['mouth-upperlip-volume-decr-incr', 0.6],
  ['mouth-cupidsbow-decr-incr', 0.5], ['mouth-scale-vert-decr-incr', 0.3],
  ['eye-scale-decr-incr', 0.4], ['eye-trans-in-out', 0.4], ['eye-corner1-down-up', 0.4], ['eye-height2-decr-incr', 0.4],
  ['chin-width-decr-incr', 0.6], ['chin-prominent-decr-incr', 0.6], ['chin-height-decr-incr', 0.4], ['chin-cleft-decr-incr', 0.4],
  ['cheek-bones-decr-incr', 0.6], ['cheek-volume-decr-incr', 0.5],
  ['forehead-scale-vert-decr-incr', 0.4], ['forehead-temple-decr-incr', 0.3],
  ['ear-scale-decr-incr', 0.5], ['ear-lobe-decr-incr', 0.5], ['ear-flap-decr-incr', 0.4],
];

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
    if (typeof v === 'number' && Number.isFinite(v) && k.length < 80) features[k] = Math.min(1, Math.max(-1, v));
  }
  return {
    id: o['id'],
    name: typeof o['name'] === 'string' ? o['name'].slice(0, 40) : '',
    ...(typeof o['mood'] === 'number' && Number.isFinite(o['mood']) ? { mood: Math.max(-1, Math.min(1, o['mood'])) } : {}),
    body,
    features,
    look: {
      skin: colour(l['skin'], DEFAULT_LOOK.skin),
      ...(typeof l['melanin'] === 'number' ? { melanin: unit(l['melanin'], 0.5) } : {}),
      ...(typeof l['undertone'] === 'number' ? { undertone: unit(l['undertone'], 0.5) } : {}),
      ...(typeof l['beard'] === 'string' ? { beard: oneOf(l['beard'], ['none', 'stubble', 'moustache', 'beard'] as const, 'none') } : {}),
      ...(typeof l['makeup'] === 'number' ? { makeup: unit(l['makeup'], 0) } : {}),
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
        outfitTint: l['outfitTint'] == null ? null : colour(l['outfitTint'], 0xffffff),
      } : {}),
      ...(typeof l['footwear'] === 'string' ? { footwear: oneOf(l['footwear'], WARDROBE.footwear, WARDROBE.footwear[0]) } : {}),
      ...(typeof l['hairCut'] === 'string' ? { hairCut: oneOf(l['hairCut'], ['none', ...ALL_HAIR], 'none') } : {}),
      ...(typeof l['brows'] === 'string' ? { brows: oneOf(l['brows'], WARDROBE.brows, WARDROBE.brows[0]) } : {}),
      ...(typeof l['lashes'] === 'string' ? { lashes: oneOf(l['lashes'], WARDROBE.lashes, WARDROBE.lashes[0]) } : {}),
      ...(typeof l['hat'] === 'string' ? { hat: oneOf(l['hat'], ['none', ...WARDROBE.hats], 'none') } : {}),
      ...(l['outfitTint'] !== undefined ? { outfitTint: l['outfitTint'] === null ? null : colour(l['outfitTint'], 0xffffff) } : {}),
    },
  };
}
