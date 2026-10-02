import { Rng } from '@core/rng';
import { localFootprint } from '@world/buildings/footprints';
import { topLevel } from '@world/buildings/geometry';
import { deriveSpaces } from '@world/buildings/spaces';
import type { Building, BuildingFunction, BuildingId } from '@world/buildings/types';
import { m } from '@world/units';

/**
 * Who lives in the city and where they work, read from its buildings.
 *
 * Every home holds households by its floor area; every workplace offers jobs
 * by its floor area and kind. Residents are made from the buildings with a
 * seed per building, so the same city always has the same people: open it
 * again and the woman on the third floor of the block on the corner is still
 * there, still working at the bakery.
 *
 * A building with no function is read from its use (residential, commercial,
 * industrial, mixed), so the player's own buildings take part as well.
 */

export type AgeClass = 'child' | 'adult' | 'elder';

export interface Resident {
  readonly id: number;
  readonly seed: number;
  readonly ageClass: AgeClass;
  readonly home: BuildingId;
  /**
   * The home within the building: its floor and the space (a flat) that is
   * theirs - the unit a family owns or rents (`spaces.ts`).
   */
  readonly homeLevel: number;
  readonly homeSpace: { readonly volume: number; readonly x: number; readonly y: number; readonly w: number; readonly d: number } | null;
  /** The floor of the workplace their job is on. */
  readonly workLevel: number;
  /** Where they spend the day: a job, a school; null for those at home all day. */
  readonly work: BuildingId | null;
  readonly hasCar: boolean;
  /** Minutes after midnight they leave in the morning, and how long they stay. */
  readonly leaveAt: number;
  readonly stay: number;
  /** An evening out: where, when (minutes after midnight) and for how long; null when they stay in. */
  readonly outing: { readonly to: BuildingId; readonly at: number; readonly stay: number } | null;
  /** Lunch out from work: a place to eat near the job; null when they eat in. */
  readonly lunch: { readonly to: BuildingId; readonly at: number; readonly stay: number } | null;
  /** A morning errand for somebody at home all day: the shop, the bank, the post. */
  readonly errand: { readonly to: BuildingId; readonly at: number; readonly stay: number } | null;
}

export interface Population {
  readonly residents: readonly Resident[];
  /** Jobs offered by each workplace, and how many were taken. */
  readonly jobs: ReadonlyMap<BuildingId, { readonly offered: number; readonly taken: number }>;
  /** Residents by home. */
  readonly homes: ReadonlyMap<BuildingId, readonly number[]>;
}

const HOMES: ReadonlySet<BuildingFunction> = new Set(['house', 'townhouse', 'apartments', 'residentialTower']);
/** Square metres of floor per job, by kind of workplace; absent is no jobs. */
const FLOOR_PER_JOB: Partial<Record<BuildingFunction, number>> = {
  office: 18, cityHall: 20, council: 25, courthouse: 25, bank: 25, postOffice: 30, police: 30,
  fireStation: 40, hospital: 25, clinic: 25, school: 45, university: 40, library: 60, museum: 80,
  prison: 50, church: 200, cemetery: 600, busStation: 80,
  shop: 40, supermarket: 50, mall: 45, pharmacy: 40, bakery: 30, restaurant: 25, snackBar: 25,
  bar: 30, nightclub: 50, cinema: 80, hotel: 40, gym: 60, club: 120, gasStation: 40,
  factory: 45, warehouse: 120,
  park: 2_000, square: 3_000, playground: 4_000, sportsCourt: 2_000,
};
/** Where people go of an evening. */
const OUTINGS: ReadonlySet<BuildingFunction> = new Set([
  'restaurant', 'snackBar', 'bar', 'nightclub', 'cinema', 'mall', 'supermarket', 'shop', 'bakery',
  'pharmacy', 'gym', 'club', 'park', 'square', 'playground', 'sportsCourt', 'church', 'library',
]);
const SCHOOLS: ReadonlySet<BuildingFunction> = new Set(['school']);
/** Where people eat at midday. */
const EATERIES: ReadonlySet<BuildingFunction> = new Set(['restaurant', 'snackBar', 'bakery', 'bar', 'mall']);
/** Where a morning's errands are run. */
const ERRANDS: ReadonlySet<BuildingFunction> = new Set([
  'supermarket', 'shop', 'pharmacy', 'bakery', 'bank', 'postOffice', 'mall', 'clinic', 'library', 'cityHall',
]);

/** Square metres of floor per person at home. */
const FLOOR_PER_PERSON = 32;
/** Largest number of residents one building is given: the agents stay affordable. */
const MAX_PER_BUILDING = 400;

const METRE2 = m(1) * m(1);

function ringArea(ring: readonly { x: number; y: number }[]): number {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += ring[j]!.x * ring[i]!.y - ring[i]!.x * ring[j]!.y;
  return Math.abs(a) / 2;
}

/** Built floor area, square metres: every closed block, every storey. */
export function floorArea(b: Building): number {
  let total = 0;
  for (const v of b.volumes) {
    if (v.open || v.mode === 'void' || v.mode === 'intersect') continue;
    total += ringArea(localFootprint(v)) * v.storeys.length;
  }
  return total / METRE2;
}

/** Site area of a building's open lots, square metres (parks, squares). */
function lotArea(b: Building): number {
  let total = 0;
  for (const v of b.volumes) if (v.open) total += ringArea(localFootprint(v));
  return total / METRE2;
}

/** What a building is for in the residents' days. */
export function roleOf(b: Building): { home: boolean; perJob: number | null; outing: boolean; school: boolean } {
  const fn = b.function;
  if (fn) {
    return {
      home: HOMES.has(fn),
      perJob: FLOOR_PER_JOB[fn] ?? null,
      outing: OUTINGS.has(fn),
      school: SCHOOLS.has(fn),
    };
  }
  switch (b.use) {
    case 'residential': return { home: true, perJob: null, outing: false, school: false };
    case 'commercial': return { home: false, perJob: 25, outing: true, school: false };
    case 'industrial': return { home: false, perJob: 50, outing: false, school: false };
    default: return { home: true, perJob: 40, outing: true, school: false };
  }
}

/** Residents a home holds, by its floor area. */
export function residentsOf(b: Building): number {
  if (!roleOf(b).home) return 0;
  const fn = b.function;
  const area = floorArea(b);
  // A house is one household, whatever its size.
  if (fn === 'house') return 3 + (b.id % 3);
  if (fn === 'townhouse') return 4 + (b.id % 3);
  // Mixed use: the upper floors are flats, the ground floor something else.
  const share = b.use === 'mixed' && !fn ? 0.6 : 1;
  return Math.max(2, Math.min(MAX_PER_BUILDING, Math.round((area * share) / FLOOR_PER_PERSON)));
}

/** Jobs a workplace offers, by its floor area (or site, for a park). */
export function jobsOf(b: Building): number {
  const role = roleOf(b);
  if (role.perJob === null) return 0;
  const area = floorArea(b) + lotArea(b);
  return Math.max(1, Math.min(MAX_PER_BUILDING, Math.round(area / role.perJob)));
}

/**
 * The city's people, from its buildings. Pure and deterministic: the same
 * buildings give the same residents, homes, jobs and days.
 */
export function derivePopulation(buildings: Iterable<Building>): Population {
  const all = [...buildings].sort((a, b) => a.id - b.id);
  const workplaces = all.filter((b) => jobsOf(b) > 0);
  const byIdAll = new Map(all.map((b) => [b.id, b]));
  const schools = all.filter((b) => roleOf(b).school);
  const outings = all.filter((b) => roleOf(b).outing);
  const eateries = all.filter((b) => b.function !== undefined && EATERIES.has(b.function));
  const errands = all.filter((b) => b.function !== undefined && ERRANDS.has(b.function));
  const byId = new Map(all.map((b) => [b.id, b]));
  /**
   * The nearest few of `places` to building `from`, by their anchors; worked
   * out once per building and list (it was sorted afresh for every resident).
   */
  const nearest = new Map<readonly Building[], Map<BuildingId, Building[]>>();
  const near = (from: BuildingId, places: readonly Building[]): Building[] => {
    let known = nearest.get(places);
    if (!known) { known = new Map(); nearest.set(places, known); }
    const hit = known.get(from);
    if (hit) return hit;
    const o = byId.get(from);
    const found = !o ? [] : [...places].filter((p) => p.id !== from)
      .sort((a, b) => Math.hypot(a.x - o.x, a.y - o.y) - Math.hypot(b.x - o.x, b.y - o.y)).slice(0, 3);
    known.set(from, found);
    return found;
  };
  const offered = new Map(workplaces.map((b) => [b.id, jobsOf(b)]));
  const taken = new Map<BuildingId, number>();
  const residents: Resident[] = [];
  const homes = new Map<BuildingId, number[]>();
  // Jobs handed out round the workplaces in turn, from a stream of its own,
  // so a new house does not reshuffle who works where in the rest of town.
  const jobRng = new Rng(0x10b5);
  let lastJob = 0;
  // The workplaces with a job left, in their order; one that fills is taken
  // out. (Filtered from every workplace for each adult, it was workplaces
  // times residents; the list and the picks are the same.)
  const open = workplaces.filter((b) => (taken.get(b.id) ?? 0) < offered.get(b.id)!);
  const vacancies = (): BuildingId | null => {
    if (!open.length) return null;
    const at = Math.floor(jobRng.float() * open.length);
    const pick = open[at]!;
    lastJob = taken.get(pick.id) ?? 0;
    taken.set(pick.id, lastJob + 1);
    if (lastJob + 1 >= offered.get(pick.id)!) open.splice(at, 1);
    return pick.id;
  };
  /** The floor job number `n` of a workplace is on: the jobs filled floor by floor. */
  const workFloor = (id: BuildingId | null, n: number): number => {
    const w = id === null ? undefined : byIdAll.get(id);
    if (!w) return 0;
    const floors = Math.max(1, topLevel(w));
    const perFloor = Math.max(1, Math.ceil((offered.get(id!) ?? 1) / floors));
    return Math.min(floors - 1, Math.floor(n / perFloor));
  };

  for (const b of all) {
    const count = residentsOf(b);
    if (!count) continue;
    const rng = new Rng(0xc17 ^ (b.id * 2654435761));
    const list: number[] = [];
    // The flats: residential spaces, the ground floor of a block of flats
    // left to its lobby. A family of two or three to each, in turn.
    const tall = topLevel(b) > 1 && b.function !== 'house' && b.function !== 'townhouse';
    const flats = deriveSpaces(b).flatMap((f) => (tall && f.level === 0) || f.use !== 'residential' && f.use !== 'mixed'
      ? [] : f.spaces.filter((sp) => sp.kind === 'unit').map((sp) => ({ level: f.level, space: { volume: f.volume, x: sp.x, y: sp.y, w: sp.w, d: sp.d } })));
    for (let k = 0; k < count; k++) {
      const age = rng.float();
      const ageClass: AgeClass = age < 0.22 ? 'child' : age < 0.85 ? 'adult' : 'elder';
      let work: BuildingId | null = null;
      let job = 0;
      if (ageClass === 'child' && schools.length) {
        work = schools[Math.floor(rng.float() * schools.length)]!.id;
        job = Math.floor(rng.float() * 1000);
      } else if (ageClass === 'adult' && rng.float() < 0.82) {
        work = vacancies();
        job = lastJob;
      }
      const flat = flats.length ? flats[Math.floor(k / 2.6) % flats.length]! : null;
      // A house is one home on every floor: its people are about the house.
      const homeLevel = flat ? flat.level : (b.function === 'house' || b.function === 'townhouse' ? k % Math.max(1, topLevel(b)) : 0);
      const early = ageClass === 'child' ? 7 * 60 : 6 * 60 + 45;
      const leaveAt = Math.round(early + rng.range(0, 110));
      const stay = Math.round(ageClass === 'child' ? rng.range(300, 360) : rng.range(450, 560));
      let outing: Resident['outing'] = null;
      if (ageClass !== 'child' && outings.length && rng.float() < (work ? 0.3 : 0.55)) {
        const to = outings[Math.floor(rng.float() * outings.length)]!.id;
        if (to !== b.id) {
          const at = work ? Math.round(18 * 60 + 30 + rng.range(0, 120)) : Math.round(10 * 60 + rng.range(0, 360));
          outing = { to, at, stay: Math.round(rng.range(50, 140)) };
        }
      }
      let lunch: Resident['lunch'] = null;
      if (work !== null && ageClass === 'adult' && rng.float() < 0.45) {
        const options = near(work, eateries);
        const to = options.length ? options[Math.floor(rng.float() * options.length)]!.id : null;
        if (to !== null && to !== work) {
          lunch = { to, at: Math.round(11 * 60 + 50 + rng.range(0, 70)), stay: Math.round(rng.range(30, 55)) };
        }
      }
      let errand: Resident['errand'] = null;
      if (work === null && ageClass !== 'child' && rng.float() < 0.6) {
        const options = near(b.id, errands);
        const to = options.length ? options[Math.floor(rng.float() * options.length)]!.id : null;
        if (to !== null) errand = { to, at: Math.round(8 * 60 + 30 + rng.range(0, 150)), stay: Math.round(rng.range(15, 50)) };
      }
      const id = residents.length + 1;
      residents.push({
        id,
        seed: (b.id * 7919 + k * 104729) >>> 0,
        ageClass,
        home: b.id,
        homeLevel,
        homeSpace: flat && tall ? flat.space : null,
        workLevel: work === null ? 0 : workFloor(work, job),
        work,
        hasCar: ageClass === 'adult' && rng.float() < 0.55,
        leaveAt,
        stay,
        outing,
        lunch,
        errand,
      });
      list.push(id);
    }
    homes.set(b.id, list);
  }
  const jobs = new Map<BuildingId, { offered: number; taken: number }>();
  for (const b of workplaces) jobs.set(b.id, { offered: offered.get(b.id)!, taken: taken.get(b.id) ?? 0 });
  return { residents, jobs, homes };
}
