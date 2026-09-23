import type { CrossingId } from '../signals/plan';
import type { SidewalkEdgeId, SidewalkNodeId } from './sidewalk';

export type PedId = number;

/**
 * Age and gender: drawn once at spawn and carried for life, the same way
 * colour and preferred file already are. They drive which of the eighty
 * rigged citizens a pedestrian is drawn as (`render/riggedCitizens.ts`) and
 * how it moves — a child's pace and gait, an elder's, an adult's.
 */
export type PedAgeClass = 'child' | 'adult' | 'elder';
export type PedGender = 'f' | 'm';

/**
 * Explicit crossing states.
 *
 * The V6 monolith had none: a pedestrian's whole behaviour was "walk to a
 * clamped progress, ask for a speed number, slide along a bezier". There was no
 * kerb, no wait, no clearance, and no way to reason about any of it (defect
 * 4.9). Each state here has one job and one exit condition.
 */
export type PedState =
  | 'Walking'
  | 'ApproachKerb'
  | 'WaitAtKerb'
  | 'Crossing'
  | 'Clearing';

/**
 * The people one pedestrian is walking with.
 *
 * One object per party, shared by reference with every member, so a party of
 * four costs one allocation at spawn and nothing afterwards. Someone walking
 * alone is a party of one rather than a null case, which is what keeps every
 * pacing and destination rule branch-free.
 */
export interface PedParty {
  /** The pacer's id, and the seed every member's destination is drawn from. */
  readonly id: PedId;
  readonly size: number;
  /** Walking pace of the slowest member. Nobody in a party outwalks it. */
  readonly pace: number;
  /**
   * Whether a child walks in this party. A family keeps closer together than
   * a party of adults — a parent does not let a child drift a lane's width
   * away — so this tightens the line-abreast spacing (`formation`).
   */
  readonly hasChild: boolean;
}

export interface PedKinematics {
  readonly edge: SidewalkEdgeId;
  readonly s: number;
  readonly lat: number;
  /** World position and body heading: what is drawn, and what is interpolated. */
  readonly x: number;
  readonly y: number;
  readonly heading: number;
}

export interface Ped {
  readonly id: PedId;
  readonly color: string;
  /** Free walking speed. */
  readonly speed: number;
  /** Preferred file across the footway; the seed of the lateral habit. */
  readonly file: number;
  /** Drawn once at spawn from the population shares in `PED_BEHAVIOUR`. */
  readonly ageClass: PedAgeClass;
  readonly gender: PedGender;
  readonly party: PedParty;
  /** Place in the party, from the front. Drives the line abreast. */
  readonly rank: number;
  /** The member walking directly behind, paced for. Null for the last. */
  trailing: PedId | null;

  state: PedState;
  /** Edge currently being traversed. */
  edge: SidewalkEdgeId;
  /** Node the current edge is entered from, which orients the path. */
  entry: SidewalkNodeId;
  /** Arc position along the oriented path. Monotone non-decreasing. */
  s: number;
  /** Current speed, from the following model. */
  v: number;
  /**
   * Offset across the footway, positive to the walker's left.
   *
   * Written only by the steering term, which rate-limits it: a pedestrian
   * steps aside, never teleports sideways. Bounded by the edge's `halfWidth`,
   * so it can never put anybody off the footway or off a zebra.
   */
  lat: number;

  /** Remaining route, as edge ids. */
  route: SidewalkEdgeId[];
  /** Node currently being walked towards. Re-chosen on arrival. */
  goal: SidewalkNodeId | null;
  /** Destinations reached, which seeds the next one. */
  trip: number;

  /** Crossing currently occupied, if any. */
  occupying: CrossingId | null;

  /** World position at the end of the last step. */
  x: number;
  y: number;
  /**
   * Direction the body faces, radians. Turned towards the direction of travel
   * at a human turning rate rather than read from the path tangent each tick:
   * the tangent of a polyline corner and the tick-to-tick lateral steering
   * made figures snap through tens of degrees in one frame.
   */
  heading: number;
  /** Drawn-body offset from the path position, closing after an edge change. */
  offX: number;
  offY: number;
  /** Sideways speed across the footway, eased rather than switched. */
  latV: number;
  /**
   * Side committed to while squeezing past a knot: -1, 0 or +1. Chosen once
   * when held up and kept until free, so a boxed-in walker steps decisively
   * one way instead of hesitating on the spot.
   */
  dodge: number;
  /**
   * Seconds left of a pause at a place reached: stopping to talk, to look
   * around, to check where next. Only ever set on arrival at a destination,
   * so nobody stops for no reason on an open footway.
   */
  pause: number;
  /** Seconds spent in `WaitAtKerb`, driving gap-acceptance impatience. */
  waited: number;
  /**
   * Seconds spent unable to move while wanting to, outside a kerb wait.
   * Drives how tightly this person is willing to squeeze past other people
   * (`PedestrianClearance`); decays once they move again.
   */
  stuck: number;
  /** Tick at which it last advanced, for the stall detector. */
  lastMovedTick: number;
  age: number;

  prev: PedKinematics;
}

export interface PedSpec {
  readonly id: PedId;
  readonly color: string;
  readonly speed: number;
  readonly file: number;
  readonly ageClass: PedAgeClass;
  readonly gender: PedGender;
  readonly party: PedParty;
  readonly rank: number;
  readonly edge: SidewalkEdgeId;
  readonly entry: SidewalkNodeId;
  readonly s: number;
  readonly lat: number;
  readonly tick: number;
}

export function createPed(spec: PedSpec): Ped {
  return {
    id: spec.id,
    color: spec.color,
    speed: spec.speed,
    file: spec.file,
    ageClass: spec.ageClass,
    gender: spec.gender,
    party: spec.party,
    rank: spec.rank,
    trailing: null,
    state: 'Walking',
    edge: spec.edge,
    entry: spec.entry,
    s: spec.s,
    v: Math.min(spec.speed, spec.party.pace),
    lat: spec.lat,
    route: [],
    goal: null,
    trip: 0,
    occupying: null,
    waited: 0,
    stuck: 0,
    lastMovedTick: spec.tick,
    age: 0,
    x: 0,
    y: 0,
    heading: 0,
    latV: 0,
    offX: 0,
    offY: 0,
    dodge: 0,
    pause: 0,
    prev: { edge: spec.edge, s: spec.s, lat: spec.lat, x: 0, y: 0, heading: 0 },
  };
}

export const pedSnapshot = (p: Ped): PedKinematics =>
  ({ edge: p.edge, s: p.s, lat: p.lat, x: p.x, y: p.y, heading: p.heading });
