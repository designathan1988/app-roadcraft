import { m } from '@world/units';

/**
 * Vehicle classes, in world units.
 *
 * Dimensions are real: a sedan is 4.7 m, which at 0.4 m per unit is 11.75
 * units. The V6 monolith called a 9.6-unit vehicle a "sedan" against road
 * widths of 15 to 46 — roughly half scale relative to the carriageway, and the
 * mismatch is part of why its storage arithmetic came out negative.
 *
 * The fleet is deliberately mixed: hatchbacks and sedans dominate, with SUVs
 * and vans behind them, a scattering of motorcycles and bicycles, and buses
 * and trucks rare enough that meeting one is an event. The share is `weight`
 * and the shares sum to one, so the spawn draw needs no normalisation.
 *
 * Two groups of fields are carried here that the simulation itself never
 * reads. The first is `palette`: paint has to be picked at spawn from a
 * seeded stream, not at draw time, or a car changes colour whenever the
 * renderer is rebuilt. The second is the body plan — `shape`, `height`,
 * `cabinFraction`, `cabinShift`, `axles`, `seats`. That data lives here
 * because it is a property of the class, and because the alternative is a
 * chain of `if (id === 'truck')` tests inside the render loop, which is how
 * the old renderer ended up drawing a bus as a long hatchback. `src/sim` must
 * not import three, so these are plain numbers; the renderer turns them into
 * geometry.
 */

/**
 * Body plan the renderer builds from.
 *
 * A discriminator rather than an id test: adding a second bus class must not
 * mean editing the renderer.
 */
export type VehicleShape = 'car' | 'bus' | 'truck' | 'motorcycle' | 'bicycle';

export interface Archetype {
  readonly id: string;
  /** Which body plan the renderer assembles for this class. */
  readonly shape: VehicleShape;
  readonly length: number;
  readonly width: number;
  /** Overall height above the road surface, roof included. */
  readonly height: number;
  /**
   * Greenhouse length as a fraction of the body length. A truck's cab is a
   * quarter of the vehicle; a van's is two thirds.
   */
  readonly cabinFraction: number;
  /**
   * Greenhouse centre, forward of the body centre, as a fraction of length.
   * Negative pulls the roofline back, which is what makes a hatchback read as
   * a hatchback next to a sedan.
   */
  readonly cabinShift: number;
  /** Number of axles, which decides the wheel count and their spacing. */
  readonly axles: number;
  /** Radius of one road wheel. */
  readonly wheelRadius: number;
  /** Seats the renderer may fill with occupants, driver included. */
  readonly seats: number;
  /** Comfortable acceleration. */
  readonly a: number;
  /** Comfortable deceleration, used by the IDM interaction term. */
  readonly b: number;
  /** Emergency deceleration, used by the safe-speed cap. */
  readonly bEmergency: number;
  /** Desired time headway, in seconds. */
  readonly T: number;
  /** Standstill gap. */
  readonly s0: number;
  /** Multiplier on the road's speed limit. */
  readonly speedFactor: number;
  readonly weight: number;
  readonly palette: readonly string[];
}

export const ARCHETYPES: readonly Archetype[] = [
  {
    id: 'hatch',
    shape: 'car',
    length: m(3.9),
    width: m(1.72),
    height: m(1.48),
    cabinFraction: 0.54,
    cabinShift: -0.04,
    axles: 2,
    wheelRadius: m(0.31),
    seats: 2,
    a: m(2.9),
    b: m(3.2),
    bEmergency: m(6.5),
    T: 1.0,
    s0: m(1.8),
    speedFactor: 1.08,
    weight: 0.3,
    palette: ['#e7dfd3', '#e06056', '#5f8fca', '#e5b64d', '#74a36d', '#3c4147'],
  },
  {
    id: 'sedan',
    shape: 'car',
    length: m(4.7),
    width: m(1.84),
    height: m(1.45),
    cabinFraction: 0.46,
    cabinShift: -0.02,
    axles: 2,
    wheelRadius: m(0.33),
    seats: 2,
    a: m(2.4),
    b: m(2.9),
    bEmergency: m(6.0),
    T: 1.2,
    s0: m(2.0),
    speedFactor: 1.0,
    weight: 0.27,
    palette: ['#d6d8dc', '#2f6a86', '#b993d1', '#cf7b43', '#dbe6ec', '#22262b'],
  },
  {
    id: 'suv',
    shape: 'car',
    length: m(4.9),
    width: m(1.95),
    height: m(1.78),
    cabinFraction: 0.52,
    cabinShift: -0.01,
    axles: 2,
    wheelRadius: m(0.37),
    seats: 2,
    a: m(2.2),
    b: m(2.8),
    bEmergency: m(5.8),
    T: 1.3,
    s0: m(2.1),
    speedFactor: 0.97,
    weight: 0.14,
    palette: ['#3f4a52', '#7d8f7a', '#c0c4c8', '#6b4f3a'],
  },
  {
    id: 'van',
    shape: 'car',
    length: m(5.6),
    width: m(2.0),
    height: m(2.35),
    // The cabin runs forward and long: a panel van has no boot, so the
    // greenhouse sits over the front axle and the box behind it is blind.
    cabinFraction: 0.4,
    cabinShift: 0.24,
    axles: 2,
    wheelRadius: m(0.35),
    seats: 2,
    a: m(1.9),
    b: m(2.6),
    bEmergency: m(5.5),
    T: 1.4,
    s0: m(2.2),
    speedFactor: 0.95,
    weight: 0.08,
    palette: ['#eceae4', '#d8d3c6', '#9aa7b1', '#f0f2f4'],
  },
  {
    id: 'bus',
    shape: 'bus',
    length: m(12.0),
    width: m(2.55),
    height: m(3.2),
    // Glazing runs nearly the whole length, so the "cabin" here is the roof
    // cap rather than a separate passenger box.
    cabinFraction: 0.98,
    cabinShift: 0,
    axles: 3,
    wheelRadius: m(0.5),
    seats: 6,
    a: m(0.9),
    b: m(1.6),
    bEmergency: m(4.2),
    T: 2.0,
    s0: m(3.2),
    speedFactor: 0.8,
    weight: 0.025,
    palette: ['#1f5fa8', '#c9342d', '#2e7d5b', '#e4e7ea', '#d8a32a'],
  },
  {
    id: 'truck',
    shape: 'truck',
    length: m(9.8),
    width: m(2.5),
    height: m(3.5),
    cabinFraction: 0.24,
    cabinShift: 0.35,
    axles: 3,
    wheelRadius: m(0.52),
    seats: 2,
    a: m(0.85),
    b: m(1.7),
    bEmergency: m(4.4),
    T: 2.1,
    s0: m(3.4),
    speedFactor: 0.82,
    weight: 0.035,
    palette: ['#8c9195', '#5d6a72', '#b4b0a5', '#2c4f6b', '#8f3d34'],
  },
  {
    id: 'motorcycle',
    shape: 'motorcycle',
    length: m(2.1),
    width: m(0.8),
    height: m(1.25),
    cabinFraction: 0.3,
    cabinShift: 0.26,
    axles: 2,
    wheelRadius: m(0.3),
    seats: 1,
    a: m(3.6),
    b: m(3.6),
    bEmergency: m(7.0),
    T: 0.8,
    s0: m(1.2),
    speedFactor: 1.12,
    weight: 0.11,
    palette: ['#1b1d21', '#b02a25', '#1d4f86', '#d9dde1', '#c6761f'],
  },
  {
    id: 'bicycle',
    shape: 'bicycle',
    length: m(1.8),
    width: m(0.6),
    height: m(1.1),
    cabinFraction: 0.3,
    cabinShift: 0.2,
    axles: 2,
    wheelRadius: m(0.34),
    seats: 1,
    // A bicycle is not a slow car: it accelerates gently, brakes far worse
    // than anything with four wheels, and tops out near a fifth of an urban
    // limit. `speedFactor` is what keeps it out of the way of the fleet.
    a: m(1.2),
    b: m(2.2),
    bEmergency: m(3.5),
    T: 1.3,
    s0: m(0.8),
    speedFactor: 0.3,
    weight: 0.04,
    palette: ['#2f8f7a', '#c4c8cc', '#9c3f5e', '#3b5fa0', '#dfc65a'],
  },
];

export const archetypeWeights = (): readonly (readonly [Archetype, number])[] =>
  ARCHETYPES.map((a) => [a, a.weight] as const);

/**
 * Lookup by id, falling back to the sedan.
 *
 * The fallback is not defensive noise: a saved document can name a class this
 * build no longer ships, and the alternative to substituting the commonest
 * car is a crash on load.
 */
export const archetypeById = (id: string): Archetype =>
  ARCHETYPES.find((a) => a.id === id) ?? (ARCHETYPES[1] as Archetype);
