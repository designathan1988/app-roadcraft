import manifest from './citizens.manifest.json';
import { CITIZEN_MODELS } from './citizenCatalog';

/**
 * WHO IS DRAWN AS WHOM - the only door into the citizen roster.
 *
 * Every figure the game draws - a walker alone or in a party, a driver, a
 * passenger, a rider, somebody stepping out at the kerb, a figure recycled
 * from the pool or brought back by loading a save - gets its body from
 * `pickCitizenModel`, and nothing else reads the roster
 * (`tests/arch/citizenCasting.spec.ts` fails if another module does).
 *
 * The roster is the reviewed manifest (`citizens.manifest.json`), classified
 * BY EYE from the contact sheets (`scripts/contact-sheet.mjs`): what a model
 * is dressed in, its apparent age and sex, and whether it may be in the
 * street at all. The whitelist FAILS CLOSED: a model with no entry, a missing
 * tag, a uniform (police, security, navy, pilot, medical, site worker, chef,
 * gardener, a football kit, a waiter's waistcoat) or a rejected model is not
 * in it, is never loaded, and is never drawn.
 *
 * A group is dressed to ONE code - a set of wardrobes that go together -
 * and every member is drawn from inside it, never outside: a suit beside a
 * track jacket, or a nurse beside a man in a T-shirt, cannot happen. When a
 * member cannot be dressed in a code, the code changes; the wardrobe never
 * relaxes.
 */

/**
 * `traditional`: everyday dress of a tradition - a headscarf and tunic, a
 * shalwar kameez, a thobe and keffiyeh. Street clothes, not a uniform; it
 * stands only with itself, so a party dressed so is dressed so throughout.
 */
export type Wardrobe = 'casual' | 'smart-casual' | 'business' | 'sport-casual' | 'traditional';
export type AgeBand = 'child' | 'young' | 'adult' | 'senior';
export type Sex = 'f' | 'm';

export interface CitizenModel {
  readonly id: string;
  readonly wardrobe: Wardrobe;
  readonly ageBand: AgeBand;
  readonly gender: Sex;
  /** A visual variant uses the same licensed mesh and rig as this source. */
  readonly sourceId?: string;
  /** Clothing palette of a visual variant; zero keeps its source texture. */
  readonly look?: number;
}

const WARDROBES: readonly Wardrobe[] = ['casual', 'smart-casual', 'business', 'sport-casual', 'traditional'];
const AGE_BANDS: readonly AgeBand[] = ['child', 'young', 'adult', 'senior'];

interface ManifestEntry {
  readonly id?: unknown;
  readonly allowedInCrowd?: unknown;
  readonly wardrobe?: unknown;
  readonly ageBand?: unknown;
  readonly gender?: unknown;
  readonly quality?: unknown;
}

/**
 * The whitelist: entries whose every tag is present and valid, allowed in the
 * crowd, of good quality, and with an asset in the catalog. Anything else is
 * left out - including a model the manifest does not mention at all.
 */
export function whitelist(entries: readonly ManifestEntry[], available: readonly string[] = CITIZEN_MODELS): CitizenModel[] {
  const have = new Set(available);
  const out: CitizenModel[] = [];
  for (const e of entries) {
    if (typeof e.id !== 'string' || !have.has(e.id)) continue;
    if (e.allowedInCrowd !== true || e.quality !== 'ok') continue;
    if (!WARDROBES.includes(e.wardrobe as Wardrobe)) continue;
    if (!AGE_BANDS.includes(e.ageBand as AgeBand)) continue;
    if (e.gender !== 'f' && e.gender !== 'm') continue;
    out.push({ id: e.id, wardrobe: e.wardrobe as Wardrobe, ageBand: e.ageBand as AgeBand, gender: e.gender });
  }
  return out;
}

/** The street roster, including distinct clothing looks of real child bodies. */
const REVIEWED = whitelist(manifest.models as readonly ManifestEntry[]);
export const CROWD: readonly CitizenModel[] = [
  ...REVIEWED,
  ...REVIEWED.filter((model) => model.ageBand === 'child').flatMap((model) =>
    [1, 2, 3].map((look) => ({ ...model, id: `${model.id}_look${look}`, sourceId: model.id, look }))),
];
/** Their ids, in the same order: the renderer's model indices. */
export const CROWD_IDS: readonly string[] = CROWD.map((model) => model.id);

/**
 * Which wardrobes may stand together. Casual goes with sport-casual and with
 * smart-casual; business only with business and smart-casual; traditional
 * dress only with itself.
 */
export function compatible(a: Wardrobe, b: Wardrobe): boolean {
  if (a === b) return true;
  const pair = (x: Wardrobe, y: Wardrobe): boolean => (a === x && b === y) || (a === y && b === x);
  return pair('casual', 'sport-casual') || pair('casual', 'smart-casual') || pair('business', 'smart-casual');
}

/** A group's dress code: the wardrobes its members are drawn from, all pairwise compatible. */
export type DressCode = readonly Wardrobe[];

export const CODES = {
  everyday: ['casual', 'smart-casual'],
  sporty: ['casual', 'sport-casual'],
  office: ['business', 'smart-casual'],
  casual: ['casual'],
  smart: ['smart-casual'],
  business: ['business'],
  sport: ['sport-casual'],
  traditional: ['traditional'],
} as const satisfies Record<string, DressCode>;

/** What kind of company a figure is in (`PedParty.archetype`, or a vehicle's). */
export type Company = 'solo' | 'family' | 'couple' | 'friends' | 'colleagues' | 'elders' | 'tourists'
  | 'car' | 'bus' | 'truck' | 'rider';

/**
 * The codes a kind of company may be dressed in, in order of preference. A
 * code that has no body for one of the members is skipped for the next;
 * `office` is never offered to a party with a child in it.
 */
export function codesFor(company: Company, hash: number, hasChild: boolean): DressCode[] {
  const rotate = (list: DressCode[]): DressCode[] => {
    const k = hash % list.length;
    return [...list.slice(k), ...list.slice(0, k)];
  };
  // One adult party in twelve, and one lone walker in twenty, in traditional dress.
  const traditional = !hasChild && (hash >>> 8) % 12 === 0;
  const withTradition = (list: DressCode[]): DressCode[] => (traditional ? [CODES.traditional, ...list] : list);
  switch (company) {
    case 'colleagues': return [CODES.office];
    case 'family': return rotate([CODES.everyday, CODES.sporty]);
    case 'couple': return withTradition(hasChild ? rotate([CODES.everyday, CODES.sporty]) : rotate([CODES.everyday, CODES.office, CODES.sporty]));
    case 'friends': return withTradition(rotate([CODES.sporty, CODES.everyday]));
    case 'elders': return withTradition([CODES.everyday]);
    case 'tourists': return withTradition([CODES.sporty]);
    case 'car': {
      // A car in five is on a work trip; the rest everyday or weekend clothes.
      const base: DressCode[] = [CODES.everyday, CODES.sporty];
      if (!hasChild && hash % 5 === 0) return [CODES.office, ...base];
      return withTradition(rotate(base));
    }
    case 'bus': case 'solo': {
      // Strangers: each dressed on their own, in one wardrobe.
      const k = hash % 40;
      const first: DressCode = k < 17 ? CODES.casual : k < 25 ? CODES.smart : k < 32 ? CODES.business : k < 38 ? CODES.sport
        : hasChild ? CODES.casual : CODES.traditional;
      return [first, CODES.casual, CODES.smart];
    }
    case 'truck': return [CODES.casual];
    case 'rider': return rotate([CODES.casual, CODES.sport, CODES.smart]);
  }
}

/** Everything the casting needs to know about one figure. */
export interface CastingContext {
  /** The person's stable identity (pedestrian id, or a seat's seed). */
  readonly seed: number;
  readonly gender: Sex;
  readonly ageClass: 'child' | 'adult' | 'elder';
  /** Their company and its identity: every member of one party or vehicle shares both. */
  readonly company: Company;
  readonly companyId: number;
  readonly hasChild?: boolean;
  /** A rider's helmet must fit: models it does not fit are left out. */
  readonly helmet?: boolean;
  /** Where they are, for keeping twins apart. */
  readonly x: number;
  readonly y: number;
}

/** The body chosen: an index into `CROWD` and the size to draw it at. */
export interface Casting {
  readonly index: number;
  readonly size: number;
  readonly code: DressCode;
}

/** No two people within this distance wear the same body, if the roster allows. World units. */
export const CAST_NEAR = 62.5;

const hashOf = (n: number): number => {
  let h = (n | 0) + 0x7f4a7c15;
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  return (h ^ (h >>> 15)) >>> 0;
};

interface Entry { index: number; size: number; x: number; y: number; seen: number; group: string; code: DressCode }

/**
 * The casting registry: who wears which body, chosen once and kept while the
 * person is about, so a passenger who gets out keeps their body on foot.
 */
export class CastingRegistry {
  private readonly cast = new Map<number, Entry>();
  private readonly wearers = new Map<number, Set<number>>();
  /** Each company's dress code, settled by its first member drawn. */
  private readonly codes = new Map<string, DressCode>();
  private frame = 0;
  /** Figures drawn this frame, for the census (`census`). */
  private drawn: { seed: number; index: number; company: Company; companyId: number; code: DressCode }[] = [];
  recordCensus = false;

  constructor(private readonly roster: readonly CitizenModel[] = CROWD, private readonly forgetAfter = 3600) {}

  /** Starts a frame: the census empties and, now and then, the long-unseen are forgotten. */
  beginFrame(): void {
    this.frame++;
    this.drawn.length = 0;
    if (this.frame % 240 !== 0) return;
    for (const [seed, entry] of this.cast) {
      if (this.frame - entry.seen < this.forgetAfter) continue;
      this.cast.delete(seed);
      this.wearers.get(entry.index)?.delete(seed);
    }
    for (const key of this.codes.keys()) {
      let used = false;
      for (const entry of this.cast.values()) if (entry.group === key) { used = true; break; }
      if (!used) this.codes.delete(key);
    }
  }

  /**
   * The bodies a person may be drawn as under one code, best age first; an
   * empty pool if none. Children only use models built with child anatomy;
   * repeating one is preferable to shrinking an adult into a child.
   */
  candidates(ctx: CastingContext, code: DressCode, helmetFits: (id: string) => boolean = () => true):
    { pool: number[]; size: number; spare: number[]; spareSize: number } {
    const of = (band: AgeBand): number[] => {
      const out: number[] = [];
      this.roster.forEach((m, i) => {
        if (m.gender === ctx.gender && m.ageBand === band && code.includes(m.wardrobe) && (!ctx.helmet || helmetFits(m.id))) out.push(i);
      });
      return out;
    };
    // An adult is any grown body; an elder a senior's first, a grown one when
    // every senior's is worn. A child always has a real child body.
    if (ctx.ageClass === 'adult') return { pool: [...of('young'), ...of('adult')], size: 1, spare: [], spareSize: 1 };
    if (ctx.ageClass === 'child') return { pool: of('child'), size: 1, spare: [], spareSize: 1 };
    const [first, second] = [of('senior'), of('adult')];
    const spareSize = 1;
    if (first.length) return { pool: first, size: 1, spare: second, spareSize };
    if (second.length) return { pool: second, size: spareSize, spare: [], spareSize };
    return { pool: [], size: 1, spare: [], spareSize: 1 };
  }

  /**
   * THE function: the body `ctx` is drawn as. The same person gets the same
   * body for as long as they are about; a company gets one dress code; no
   * two members of one company, and nobody within `CAST_NEAR`, wear the same
   * body while the roster allows. Returns null only if the roster is empty.
   */
  pickCitizenModel(ctx: CastingContext, helmetFits: (id: string) => boolean = () => true): Casting | null {
    const known = this.cast.get(ctx.seed);
    if (known) {
      known.x = ctx.x;
      known.y = ctx.y;
      known.seen = this.frame;
      this.note(ctx, known);
      return known;
    }
    const group = `${ctx.company}:${ctx.companyId}`;
    const hash = hashOf(ctx.seed);
    const groupHash = hashOf(ctx.companyId ^ 0x51ce);
    // The company's code: its first member settles it, taking the first code
    // of its kind that dresses them; a later member who cannot be dressed in
    // it moves the whole company on to a code that dresses everyone so far.
    const shared = ctx.company !== 'solo' && ctx.company !== 'bus' && ctx.company !== 'rider';
    let options = codesFor(ctx.company, shared ? groupHash : hash, ctx.hasChild ?? ctx.ageClass === 'child');
    const settled = shared ? this.codes.get(group) : undefined;
    if (settled) options = [settled, ...options.filter((c) => c !== settled)];
    let code: DressCode | undefined;
    let choice = { pool: [] as number[], size: 1, spare: [] as number[], spareSize: 1 };
    for (const candidate of options) {
      const c = this.candidates(ctx, candidate, helmetFits);
      if (!c.pool.length) continue;
      if (settled && candidate !== settled && !this.dressesMembers(group, candidate)) continue;
      code = candidate;
      choice = c;
      break;
    }
    if (!code || !choice.pool.length) return null;
    if (shared && code !== settled) this.recode(group, code);
    const { pool, spare } = choice;
    let size = choice.size;
    let index = -1;
    let fallback = pool[hash % pool.length]!;
    let farthest = -1;
    const deck = pool.length + spare.length;
    for (let k = 0; k < deck; k++) {
      const fromSpare = k >= pool.length;
      const candidate = fromSpare ? spare[(hash + k) % spare.length]! : pool[(hash + k) % pool.length]!;
      let nearest = Infinity;
      let taken = false;
      for (const other of this.wearers.get(candidate) ?? []) {
        const worn = this.cast.get(other);
        if (!worn) continue;
        if (shared && worn.group === group) { taken = true; break; }
        nearest = Math.min(nearest, Math.hypot(worn.x - ctx.x, worn.y - ctx.y));
      }
      if (taken) continue;
      if (nearest >= CAST_NEAR) {
        index = candidate;
        if (fromSpare) size = choice.spareSize;
        break;
      }
      if (!fromSpare && nearest > farthest) { farthest = nearest; fallback = candidate; }
    }
    if (index < 0) index = fallback;
    const entry: Entry = { index, size, x: ctx.x, y: ctx.y, seen: this.frame, group, code };
    this.cast.set(ctx.seed, entry);
    const list = this.wearers.get(index);
    if (list) list.add(ctx.seed);
    else this.wearers.set(index, new Set([ctx.seed]));
    this.note(ctx, entry);
    return entry;
  }

  /** Whether everybody already cast in `group` is dressed inside `code`. */
  private dressesMembers(group: string, code: DressCode): boolean {
    for (const entry of this.cast.values()) {
      if (entry.group === group && !code.includes(this.roster[entry.index]!.wardrobe)) return false;
    }
    return true;
  }

  private recode(group: string, code: DressCode): void {
    this.codes.set(group, code);
    for (const entry of this.cast.values()) if (entry.group === group) entry.code = code;
  }

  private note(ctx: CastingContext, entry: Entry): void {
    if (this.recordCensus) this.drawn.push({ seed: ctx.seed, index: entry.index, company: ctx.company, companyId: ctx.companyId, code: entry.code });
  }

  /** Everybody drawn this frame: body, company and code (the runtime census). */
  census(): { seed: number; model: string; wardrobe: Wardrobe; company: Company; companyId: number; code: DressCode }[] {
    return this.drawn.map((d) => ({ seed: d.seed, model: this.roster[d.index]!.id, wardrobe: this.roster[d.index]!.wardrobe,
      company: d.company, companyId: d.companyId, code: d.code }));
  }
}
