/**
 * Ready-made shapes for each part of the face, as a life-simulation game
 * offers them: pick a nose, eyes, a mouth, a jaw, a face shape by name
 * instead of moving a dozen sliders. Each preset sets the MakeHuman regional
 * sliders of its part (and clears the others of that part); values stay
 * moderate, so a preset never draws a caricature.
 */
export interface FacePreset {
  /** i18n key of its name: `person.preset.<part>.<key>`. */
  readonly key: string;
  readonly values: Readonly<Record<string, number>>;
}

export interface FacePart {
  /** i18n key: `person.part.<key>`. */
  readonly key: string;
  /** Every slider this part owns: cleared before a preset of the part is applied. */
  readonly sliders: readonly string[];
  readonly presets: readonly FacePreset[];
}

export const FACE_PARTS: readonly FacePart[] = [
  {
    key: 'shape',
    sliders: ['head-oval', 'head-round', 'head-square', 'head-rectangular', 'head-diamond', 'head-triangular', 'head-invertedtriangular', 'head-fat-decr-incr'],
    presets: [
      { key: 'oval', values: { 'head-oval': 0.5 } },
      { key: 'round', values: { 'head-round': 0.45, 'head-fat-decr-incr': 0.1 } },
      { key: 'square', values: { 'head-square': 0.45 } },
      { key: 'heart', values: { 'head-invertedtriangular': 0.45 } },
      { key: 'long', values: { 'head-rectangular': 0.4, 'head-fat-decr-incr': -0.1 } },
      { key: 'diamond', values: { 'head-diamond': 0.4 } },
    ],
  },
  {
    key: 'nose',
    sliders: ['nose-scale-horiz-decr-incr', 'nose-scale-vert-decr-incr', 'nose-hump-decr-incr', 'nose-point-width-decr-incr',
      'nose-curve-concave-convex', 'nose-nostrils-width-decr-incr', 'nose-volume-decr-incr', 'nose-point-down-up', 'nose-greek-decr-incr'],
    presets: [
      { key: 'straight', values: {} },
      { key: 'slim', values: { 'nose-scale-horiz-decr-incr': -0.35, 'nose-nostrils-width-decr-incr': -0.3, 'nose-point-width-decr-incr': -0.25 } },
      { key: 'small', values: { 'nose-volume-decr-incr': -0.35, 'nose-scale-vert-decr-incr': -0.25, 'nose-scale-horiz-decr-incr': -0.15 } },
      { key: 'upturned', values: { 'nose-point-down-up': 0.4, 'nose-curve-concave-convex': -0.3, 'nose-volume-decr-incr': -0.15 } },
      { key: 'aquiline', values: { 'nose-hump-decr-incr': 0.45, 'nose-curve-concave-convex': 0.3, 'nose-point-down-up': -0.2 } },
      { key: 'broad', values: { 'nose-scale-horiz-decr-incr': 0.35, 'nose-nostrils-width-decr-incr': 0.4, 'nose-point-width-decr-incr': 0.3 } },
      { key: 'greek', values: { 'nose-greek-decr-incr': 0.45, 'nose-scale-vert-decr-incr': 0.15 } },
    ],
  },
  {
    key: 'eyes',
    sliders: ['eye-scale-decr-incr', 'eye-trans-in-out', 'eye-corner1-down-up', 'eye-height2-decr-incr', 'eye-epicanthus-in-out'],
    presets: [
      { key: 'almond', values: { 'eye-corner1-down-up': 0.25, 'eye-height2-decr-incr': -0.1 } },
      { key: 'large', values: { 'eye-scale-decr-incr': 0.35, 'eye-height2-decr-incr': 0.2 } },
      { key: 'small', values: { 'eye-scale-decr-incr': -0.3 } },
      { key: 'downturned', values: { 'eye-corner1-down-up': -0.35 } },
      { key: 'upturned', values: { 'eye-corner1-down-up': 0.4 } },
      { key: 'monolid', values: { 'eye-epicanthus-in-out': -0.6, 'eye-height2-decr-incr': -0.15 } },
      { key: 'wide', values: { 'eye-trans-in-out': -0.3 } },
      { key: 'close', values: { 'eye-trans-in-out': 0.3 } },
    ],
  },
  {
    key: 'mouth',
    sliders: ['mouth-scale-horiz-decr-incr', 'mouth-lowerlip-volume-decr-incr', 'mouth-upperlip-volume-decr-incr',
      'mouth-cupidsbow-decr-incr', 'mouth-scale-vert-decr-incr'],
    presets: [
      { key: 'thin', values: { 'mouth-lowerlip-volume-decr-incr': -0.35, 'mouth-upperlip-volume-decr-incr': -0.35 } },
      { key: 'full', values: { 'mouth-lowerlip-volume-decr-incr': 0.4, 'mouth-upperlip-volume-decr-incr': 0.35 } },
      { key: 'wide', values: { 'mouth-scale-horiz-decr-incr': 0.35 } },
      { key: 'small', values: { 'mouth-scale-horiz-decr-incr': -0.3, 'mouth-scale-vert-decr-incr': -0.1 } },
      { key: 'bow', values: { 'mouth-cupidsbow-decr-incr': 0.5, 'mouth-upperlip-volume-decr-incr': 0.2 } },
    ],
  },
  {
    key: 'jaw',
    sliders: ['chin-width-decr-incr', 'chin-prominent-decr-incr', 'chin-height-decr-incr', 'chin-bones-decr-incr', 'chin-cleft-decr-incr'],
    presets: [
      { key: 'soft', values: { 'chin-width-decr-incr': -0.3, 'chin-bones-decr-incr': -0.25 } },
      { key: 'square', values: { 'chin-width-decr-incr': 0.4, 'chin-bones-decr-incr': 0.35 } },
      { key: 'pointed', values: { 'chin-width-decr-incr': -0.4, 'chin-prominent-decr-incr': 0.2, 'chin-height-decr-incr': 0.2 } },
      { key: 'strong', values: { 'chin-prominent-decr-incr': 0.4, 'chin-bones-decr-incr': 0.3 } },
      { key: 'cleft', values: { 'chin-cleft-decr-incr': 0.55, 'chin-width-decr-incr': 0.15 } },
    ],
  },
  {
    key: 'cheeks',
    sliders: ['cheek-bones-decr-incr', 'cheek-volume-decr-incr'],
    presets: [
      { key: 'high', values: { 'cheek-bones-decr-incr': 0.45 } },
      { key: 'full', values: { 'cheek-volume-decr-incr': 0.35 } },
      { key: 'hollow', values: { 'cheek-volume-decr-incr': -0.35, 'cheek-bones-decr-incr': 0.15 } },
    ],
  },
];

/** The face's features with one part replaced by a preset. */
export function applyFacePreset(features: Readonly<Record<string, number>>, part: FacePart, preset: FacePreset): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(features)) if (!part.sliders.includes(k)) out[k] = v;
  return { ...out, ...preset.values };
}
