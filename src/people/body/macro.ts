/**
 * MakeHuman's macro sliders, as weights on its macro targets.
 *
 * Everything here is read from the data (`modifiers.json`, which is MPFB2's
 * `macrodetails/macro.json`): each slider is a run of parts, each part a
 * stretch of the slider between two named states - age goes baby, child,
 * young, old - and a target is named by one state of every factor it
 * combines (`universal-female-young-averagemuscle-averageweight`,
 * `african-male-old`, `height/female-child-...-maxheight`). A target's weight
 * is the product of its states' weights; a state's weight is how far the
 * slider sits towards it inside its part.
 *
 * Written from the file format alone: no MakeHuman or MPFB code is used.
 */

/** The macro sliders, each 0..1 as MakeHuman has them; the three ethnic shares are normalised. */
export interface MacroParams {
  /** 0 female, 1 male. */
  readonly gender: number;
  /** 0 a baby, 0.1875 eleven, 0.5 twenty-five, 1 ninety (`ageFromYears`). */
  readonly age: number;
  readonly muscle: number;
  readonly weight: number;
  /** 0.5 is the average for the sex and age. */
  readonly height: number;
  /** 0.5 neutral; above it towards ideal, below towards uncommon. */
  readonly proportions: number;
  readonly african: number;
  readonly asian: number;
  readonly caucasian: number;
  readonly cupsize: number;
  readonly firmness: number;
}

export const DEFAULT_MACRO: MacroParams = {
  gender: 0.5, age: 0.5, muscle: 0.5, weight: 0.5, height: 0.5, proportions: 0.5,
  african: 1 / 3, asian: 1 / 3, caucasian: 1 / 3, cupsize: 0.5, firmness: 0.5,
};

interface MacroPart {
  readonly lowest: number;
  readonly highest: number;
  readonly low: string;
  readonly high: string;
}

/** `modifiers.json` `.macro`. */
export interface MacroDefinition {
  readonly macrotargets: Readonly<Record<string, { readonly label: string; readonly parts: readonly MacroPart[] }>>;
  readonly combinations: Readonly<Record<string, readonly string[]>>;
}

const RACES = ['african', 'asian', 'caucasian'] as const;

/**
 * Weight of every state of one slider at `value`: the part holding the value
 * splits a weight of one between its two ends. An empty end (the neutral of
 * height and proportions) takes its share with it: at the neutral the slider
 * moves nothing.
 */
export function stateWeights(parts: readonly MacroPart[], value: number): Map<string, number> {
  const out = new Map<string, number>();
  const x = Math.min(1, Math.max(0, value));
  const part = parts.find((p) => x >= p.lowest && x <= p.highest)
    // The data leaves hairline gaps between parts (0.49998..0.49999): the
    // nearest part owns them.
    ?? parts.reduce((best, p) => (Math.abs(x - (p.lowest + p.highest) / 2) < Math.abs(x - (best.lowest + best.highest) / 2) ? p : best));
  const lo = Math.max(0, part.lowest);
  const hi = Math.min(1, part.highest);
  const t = hi > lo ? Math.min(1, Math.max(0, (x - lo) / (hi - lo))) : 0;
  if (part.low) out.set(part.low, (out.get(part.low) ?? 0) + (1 - t));
  if (part.high) out.set(part.high, (out.get(part.high) ?? 0) + t);
  return out;
}

/** Slider value of an age in years, on MakeHuman's scale (1, 11, 25 and 90 at the four states). */
export function ageFromYears(years: number): number {
  const y = Math.min(90, Math.max(1, years));
  if (y < 11) return ((y - 1) / 10) * 0.1875;
  if (y < 25) return 0.1875 + ((y - 11) / 14) * (0.5 - 0.1875);
  return 0.5 + ((y - 25) / 65) * 0.5;
}

export function yearsFromAge(age: number): number {
  const a = Math.min(1, Math.max(0, age));
  if (a < 0.1875) return 1 + (a / 0.1875) * 10;
  if (a < 0.5) return 11 + ((a - 0.1875) / (0.5 - 0.1875)) * 14;
  return 25 + ((a - 0.5) / 0.5) * 65;
}

/**
 * The weight of every macro target in `names` (as the packs name them, with
 * or without a `macrodetails/` or `breast/` folder) for `params`. Targets the
 * parameters give no weight are left out.
 */
export function macroTargetWeights(def: MacroDefinition, names: readonly string[], params: MacroParams): Map<string, number> {
  const factor = new Map<string, Map<string, number>>();
  for (const [name, slider] of Object.entries(def.macrotargets)) {
    const value = (params as unknown as Record<string, number>)[name];
    if (value !== undefined) factor.set(name, stateWeights(slider.parts, value));
  }
  const raceTotal = RACES.reduce((s, r) => s + Math.max(0, params[r]), 0);
  factor.set('race', new Map(RACES.map((r) => [r, raceTotal > 0 ? Math.max(0, params[r]) / raceTotal : 1 / 3])));

  // Which slider each state belongs to, so a name can be read part by part.
  const owner = new Map<string, string>();
  for (const [slider, states] of factor) for (const state of states.keys()) owner.set(state, slider);
  for (const [, slider] of Object.entries(def.macrotargets)) {
    for (const part of slider.parts) {
      for (const state of [part.low, part.high]) {
        if (state && !owner.has(state)) owner.set(state, Object.entries(def.macrotargets).find(([, s]) => s === slider)![0]);
      }
    }
  }
  for (const r of RACES) owner.set(r, 'race');
  const combos = Object.values(def.combinations).map((c) => [...c].sort().join('|'));

  const out = new Map<string, number>();
  for (const full of names) {
    const leaf = full.slice(full.lastIndexOf('/') + 1).replace(/^universal-/, '');
    const states = leaf.split('-');
    const sliders = states.map((s) => owner.get(s));
    // Not a macro target (a regional one such as `breast-dist-incr`).
    if (sliders.some((s) => s === undefined)) continue;
    if (!combos.includes([...(sliders as string[])].sort().join('|'))) continue;
    let w = 1;
    for (let i = 0; i < states.length && w > 0; i++) w *= factor.get(sliders[i]!)?.get(states[i]!) ?? 0;
    if (w > 1e-9) out.set(full, w);
  }
  return out;
}
