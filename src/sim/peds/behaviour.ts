import { TAU, clamp } from '@core/scalar';
import { m } from '@world/units';

/**
 * How a pedestrian behaves between the rules that keep it safe.
 *
 * The crossing state machine decides whether someone may be in the road. This
 * file decides everything the state machine does not: how fast they feel like
 * walking this second, where across the footway they put themselves, who they
 * are walking with and where they are going. None of it may ever loosen a
 * crossing rule, so nothing here is reachable from `mayEnterCrossing`.
 *
 * The model has four parts.
 *
 *   TRAITS are a hash of the pedestrian's id. Nothing is stored and nothing is
 *   drawn from an RNG stream at use time, because a value re-rolled each tick
 *   strobes and one cached in a map needs eviction that has to agree with
 *   despawn. A hash of the id is stable for the agent's whole life for free,
 *   and it cannot reshuffle a seeded stream that something else depends on.
 *
 *   PACE is the trait speed, capped to the party's pace, multiplied by a pair
 *   of sine terms in simulation time — a slow wander and a rare deep dip that
 *   reads as somebody stopping to look at something — and cut on the approach
 *   to a kerb or a corner. It is a product of scalars, so it can be evaluated
 *   in any state without a branch tree.
 *
 *   LATERAL position is a target plus a rate limit. The target is the
 *   pedestrian's preferred file, their side-of-the-footway habit, their place
 *   in their party's line abreast, and two steering nudges: away from a slower
 *   person ahead, and towards the keep-side when somebody is coming the other
 *   way. The rate limit is what makes it a step sideways instead of a
 *   teleport, and it is the ONLY thing that writes `Ped.lat`.
 *
 *   PARTIES share a pace and a destination, and a member paces itself to the
 *   companion directly behind it while that companion is on the same footway.
 *   They break up rather than stretch: past `cohesionBreak` the link is cut,
 *   because a party that can never give up on a member is a party that can be
 *   a block long, and a member that can stop dead for one is a jam.
 *
 * Cost, per pedestrian per tick: a handful of integer hashes, two `Math.sin`
 * calls walking or one waiting, one `Map.get` for the companion, and a bounded
 * walk over at most `scanAhead` entries of the pedestrian's own sidewalk edge.
 * No allocation, no scan over the population, nothing that grows with the
 * crowd. Measured at 1024 pedestrians on a four-leg network: 1.1 microseconds
 * each per tick, against 9.8 for the full-population scan this replaces.
 *
 * These constants live here rather than in `params.ts` because that file is
 * shared with the vehicle model and is edited from both sides.
 */
export const PED_BEHAVIOUR = {
  // ---- parties ----------------------------------------------------------
  /** Party sizes and their relative weights; most people walk alone. */
  partySizes: [
    [1, 56],
    [2, 26],
    [3, 12],
    [4, 6],
  ] as const,
  /** Longitudinal spacing between members when a party is spawned in file. */
  partyStagger: m(1.2),
  /** Lateral spacing between members walking abreast. */
  abreastSpacing: m(0.62),
  /** Lag a companion may fall behind before the member ahead paces down. */
  cohesionSlack: m(2.0),
  /**
   * Share of a lagging companion's pace the member ahead drops to.
   *
   * Below one, and that matters: matching the companion's pace exactly stops
   * the gap growing but never closes it, so every time a companion is briefly
   * held up the party ends a little longer than it started and the length
   * ratchets up over a walk across town. Measured at the population ceiling,
   * matching alone left parties 250 units long.
   */
  cohesionClose: 0.55,
  /**
   * Floor on the pace of a member waiting for a companion.
   *
   * Never zero. A member that can stop dead while a companion is blocked by a
   * stranger standing between them is a jam with a stationary head, and
   * everything behind the head — including the companion — is stuck on it.
   */
  cohesionCrawl: m(0.12),
  /**
   * Lag at which a party gives up on a companion for good.
   *
   * The crawl floor above means a companion who is genuinely stuck still falls
   * behind, slowly, forever. Something has to end that, and a bound on how far
   * apart two people walking together can be is the honest end: past this they
   * are not walking together any more, so the link is cut and both walk on.
   * They still share a party pace and a destination, so they often re-form.
   */
  cohesionBreak: m(9),

  // ---- lateral position -------------------------------------------------
  /** How fast a pedestrian may slide across the footway. */
  lateralRate: m(0.55),
  /** Clearance kept from the edge of the footway. */
  lateralMargin: m(0.25),
  /** Lateral separation at which two people no longer obstruct each other. */
  shoulder: m(0.52),
  /** How far ahead a slower person is worth stepping around. */
  passLook: m(4.5),
  passShift: m(0.6),
  /** Speed advantage that makes stepping around worth the effort. */
  passMargin: m(0.15),
  /** How far ahead an oncoming person is worth steering away from. */
  oncomingLook: m(6.0),
  oncomingShift: m(0.55),
  /** Weight of the pedestrian's spawned file in its preferred position. */
  fileBlend: 0.52,
  /** Weight of the per-pedestrian habit, so a file is not a painted lane. */
  jitterBlend: 0.24,
  /** Weight of the keep-side habit. */
  keepBlend: 0.3,
  /**
   * Which hand people keep to, as a sign on the lateral axis.
   *
   * `perp` is the LEFT normal in this coordinate system and the carriageway is
   * right-hand traffic, so the negative side is the walker's right. Two people
   * meeting head on are in mirrored frames, so both stepping to the same
   * SIGNED side is both stepping to the same HAND, which separates them
   * instead of putting them in each other's way twice.
   */
  keepSide: -1,

  // ---- pace -------------------------------------------------------------
  dawdleAmplitude: 0.09,
  /** Angular rate of the slow speed wander, in radians per second. */
  dawdleRate: [0.32, 0.66] as const,
  /** Angular rate of the rare pause, in radians per second. */
  pauseRate: [0.12, 0.26] as const,
  /** Depth of the pause at its narrow peak. */
  pauseDepth: 0.78,
  /** Distance over which someone slows for a kerb or a corner. */
  kerbSlowDistance: m(4),
  kerbSlowFactor: 0.52,
  /** Corners are taken at a walk, not at a stride. */
  cornerFactor: 0.84,
  /** People cross a carriageway slightly faster than they walk a footway. */
  crossingUrgency: 1.06,
  /** And faster still when the protected window is closing. */
  hurryGain: 1.32,
  hurryMargin: 1.4,

  // ---- waiting ----------------------------------------------------------
  /**
   * Amplitude of the weight shift of somebody standing at a kerb.
   *
   * The renderer freezes the gait at zero speed, which is right — a figure
   * marching on the spot is worse than a still one. This is what keeps the
   * still one from reading as a mannequin: a few centimetres of sway, slow
   * enough to be a person shifting their weight rather than a jitter.
   */
  swayAmplitude: m(0.07),
  swayRate: [0.7, 1.5] as const,

  // ---- destinations -----------------------------------------------------
  /** Distance at which a destination counts as reached. */
  arriveRadius: m(9),
  /**
   * Distance penalty on a crossing, so a road is crossed because it is on the
   * way rather than because a coin came up heads.
   */
  crossingPenalty: m(14),
  /** Spread of the per-party preference that keeps a crowd from funnelling. */
  exploreSpan: m(13),

  // ---- neighbours -------------------------------------------------------
  /**
   * Entries of a pedestrian's own edge examined per tick.
   *
   * The occupancy index is ordered along the edge, so the nearest leader and
   * the nearest oncoming walker are both within the first few entries unless
   * the footway is several abreast — and past that depth the people beyond are
   * far enough away to be irrelevant this tick.
   */
  scanAhead: 8,
} as const;

/**
 * Integer avalanche over an id.
 *
 * The same construction the renderer uses for a pedestrian's appearance, kept
 * separately because `src/sim` may not import from `src/render`. Two copies of
 * five lines are cheaper than a shared module that would have to sit in
 * `core` and be a dependency of both.
 */
export function pedHash(id: number): number {
  let h = (id | 0) + 0x9e3779b9;
  h = Math.imul(h ^ (h >>> 16), 0x21f0aaad);
  h = Math.imul(h ^ (h >>> 15), 0x735a2d97);
  return (h ^ (h >>> 15)) >>> 0;
}

/** A byte of a hash as a fraction in [0, 1). */
const frac = (h: number, shift: number): number => ((h >>> shift) & 0xff) / 256;

/** Blends a fraction into a closed range. */
const span = (range: readonly [number, number], t: number): number =>
  range[0] + (range[1] - range[0]) * t;

/**
 * Where on the footway this pedestrian likes to walk, as a fraction of the
 * usable half-width.
 *
 * The spawned file still decides most of it, so the seeded spawn stream keeps
 * deciding something visible; the habit term is what stops three files from
 * reading as three painted lanes.
 */
export function preferredLateral(id: number, file: number, files: number): number {
  const centred = files > 1 ? (file - (files - 1) / 2) / ((files - 1) / 2) : 0;
  const habit = (frac(pedHash(id ^ 0x5bf03635), 4) - 0.5) * 2;
  return clamp(
    centred * PED_BEHAVIOUR.fileBlend +
      habit * PED_BEHAVIOUR.jitterBlend +
      PED_BEHAVIOUR.keepSide * PED_BEHAVIOUR.keepBlend,
    -1,
    1,
  );
}

/**
 * Speed multiplier for one pedestrian at one moment.
 *
 * A slow wander plus a narrow dip. The dip is a sine raised to the sixteenth
 * power, which is flat at one almost everywhere and falls to the floor for a
 * couple of seconds every half-minute or so — a pause, without a state to
 * enter or leave, and continuous at both ends so nobody jerks.
 */
export function strollFactor(id: number, age: number): number {
  const h = pedHash(id ^ 0x2c1b3c6d);
  const wander =
    1 +
    PED_BEHAVIOUR.dawdleAmplitude *
      Math.sin(age * span(PED_BEHAVIOUR.dawdleRate, frac(h, 0)) + frac(h, 8) * TAU);

  const dip = age * span(PED_BEHAVIOUR.pauseRate, frac(h, 16)) + frac(h, 24) * TAU;
  const x = Math.max(0, Math.sin(dip));
  const x2 = x * x;
  const x4 = x2 * x2;
  const x8 = x4 * x4;
  return wander * (1 - PED_BEHAVIOUR.pauseDepth * x8 * x8);
}

/** Weight shift of somebody standing still, in world units. */
export function kerbSway(id: number, age: number): number {
  const h = pedHash(id ^ 0x1d2c6f3b);
  return (
    PED_BEHAVIOUR.swayAmplitude *
    Math.sin(age * span(PED_BEHAVIOUR.swayRate, frac(h, 0)) + frac(h, 8) * TAU)
  );
}

/** Which destination a party wants on its `trip`-th outing. */
export function goalPick(party: number, trip: number, count: number): number {
  if (count <= 0) return 0;
  return pedHash(Math.imul(party, 0x9e3779b1) ^ Math.imul(trip + 1, 0x85ebca6b)) % count;
}

/**
 * A party's standing preference between two edges, in world units of detour.
 *
 * Keyed on the party rather than the pedestrian so that everyone walking
 * together makes the same turn, and on the edge rather than the moment so that
 * the same party at the same junction chooses the same way twice.
 */
export function edgePreference(party: number, edge: string): number {
  let h = Math.imul(party + 0x9e3779b9, 0x85ebca6b) >>> 0;
  for (let i = 0; i < edge.length; i++) {
    h = Math.imul(h ^ edge.charCodeAt(i), 16777619) >>> 0;
  }
  return (pedHash(h) / 0x1_0000_0000) * PED_BEHAVIOUR.exploreSpan;
}
