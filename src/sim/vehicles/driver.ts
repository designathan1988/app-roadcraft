import { clamp } from '@core/scalar';
import type { Archetype } from './archetypes';

/**
 * The driver behind the wheel, as distinct from the vehicle around them.
 *
 * ## Why this exists
 *
 * Every sedan braked identically, accepted the same gap, and held the same
 * headway, because the car-following parameters lived on the ARCHETYPE and an
 * archetype is one object shared by every vehicle of that class. The only thing
 * that varied between two drivers was a plus-or-minus eight per cent on the
 * free-flow speed. That is why a queue discharged like a goods train and a
 * platoon on an open road held station to the centimetre: the model was already
 * a good one, and every instance of it was the same instance.
 *
 * A driver therefore carries their own copy of the numbers the longitudinal
 * model reads. The vehicle keeps its dimensions — a van is a van whoever is
 * driving — and the driver keeps the behaviour.
 *
 * ## Where the variation comes from
 *
 * One number: `aggression`, drawn once at spawn. Everything else is derived
 * from it, so a driver is internally consistent. Somebody who accelerates hard
 * also follows closely, accepts a tighter gap at a junction, and is readier to
 * pull out and overtake; somebody timid does all of the opposite. Drawing each
 * parameter independently produces a population that is statistically varied
 * and individually incoherent — a driver who tailgates and then refuses a
 * forty-metre gap reads as a bug, not as a person.
 *
 * The one thing NOT derived from aggression is `drift`: every driver, however
 * placid, fails to hold an exact speed. That is what stops an uncongested road
 * looking like a conveyor.
 *
 * ## What it is not allowed to touch
 *
 * `bEmergency` is scaled far more narrowly than the comfort parameters, and
 * never upwards past the archetype's own value on the timid side by enough to
 * matter. The safe-speed cap in `idm.ts` is what makes the discrete step
 * collision-free, and a driver who cannot brake as hard as the cap assumes is
 * a driver who can be made to crash by arithmetic.
 */

/**
 * The subset of an archetype the longitudinal model actually reads.
 *
 * An `Archetype` satisfies it structurally, which is what let every existing
 * call site keep compiling while the vehicle's own driver was threaded through
 * the ones that matter.
 */
export interface DriverParams {
  /** Comfortable acceleration. */
  readonly a: number;
  /** Comfortable deceleration. */
  readonly b: number;
  /** Emergency deceleration, used by the safe-speed cap. */
  readonly bEmergency: number;
  /** Desired time headway, in seconds. */
  readonly T: number;
  /** Standstill gap. */
  readonly s0: number;
}

export interface Driver extends DriverParams {
  /**
   * -1 timid, 0 ordinary, +1 pushy. Kept so the parts of the engine that are
   * not car-following — gap acceptance, overtaking, rerouting — can read the
   * same personality rather than inventing a second one.
   */
  readonly aggression: number;
  /** Multiplies the critical gap a yielding movement demands. */
  readonly gapFactor: number;
  /** MOBIL politeness: how much this driver weighs the cars they affect. */
  readonly politeness: number;
  /** MOBIL threshold: the gain an overtake has to be worth. */
  readonly laneThreshold: number;
  /** Amplitude of the slow wander in desired speed, as a fraction. */
  readonly driftAmplitude: number;
  /** Angular rate of that wander, in radians per second. */
  readonly driftRate: number;
  /** Phase of it, so no two drivers wander together. */
  readonly driftPhase: number;
  /** Seconds of being held up before this driver looks for another way round. */
  readonly patience: number;
}

/** Spread of the comfort parameters between the timid and the pushy. */
const ACCEL_SPREAD = 0.3;
const BRAKE_SPREAD = 0.22;
const HEADWAY_SPREAD = 0.32;
const GAP_SPREAD = 0.28;
/**
 * The emergency brake barely varies.
 *
 * It is not a comfort parameter: `safeSpeed` sizes every following distance in
 * the simulation from it, and a driver whose real stopping power is below what
 * the cap assumed can be driven into the car in front by arithmetic alone. Two
 * and a half per cent is enough to stop the hardest stops being identical and
 * small enough to stay inside the margin the cap already carries.
 */
const EMERGENCY_SPREAD = 0.025;

/**
 * Draws a driver.
 *
 * `sample` must come from a seeded stream: determinism is tested, and a fleet
 * whose personalities are drawn from `Math.random` would give a different city
 * on every reload of the same map.
 */
export function makeDriver(archetype: Archetype, sample: () => number): Driver {
  // Two uniforms averaged: a triangular distribution, so most drivers are
  // ordinary and the extremes are rare. A flat draw gives a city in which one
  // car in five is a maniac, which reads as noise rather than as character.
  const aggression = clamp((sample() + sample() - 1) * 1.15, -1, 1);

  return {
    aggression,
    a: archetype.a * (1 + aggression * ACCEL_SPREAD),
    b: archetype.b * (1 + aggression * BRAKE_SPREAD),
    bEmergency: archetype.bEmergency * (1 + aggression * EMERGENCY_SPREAD),
    // Inverted: the pushy driver keeps a SHORTER headway and a smaller gap.
    T: archetype.T * (1 - aggression * HEADWAY_SPREAD),
    s0: archetype.s0 * (1 - aggression * GAP_SPREAD * 0.6),
    gapFactor: 1 - aggression * GAP_SPREAD,
    // A polite driver gives more weight to the cars a lane change would
    // inconvenience; a pushy one barely notices them.
    politeness: clamp(0.45 - aggression * 0.3, 0.05, 0.8),
    // And demands less of an improvement before taking the lane.
    laneThreshold: clamp(0.35 - aggression * 0.22, 0.08, 0.7),
    // Independent of aggression, because nobody holds an exact speed.
    driftAmplitude: 0.025 + sample() * 0.045,
    driftRate: 0.06 + sample() * 0.12,
    driftPhase: sample() * Math.PI * 2,
    patience: 6 + (1 - aggression) * 7,
  };
}

/**
 * The speed this driver is aiming for right now.
 *
 * A slow sine on simulation time, not on wall time and not from a random
 * source: it has to be continuous — a target that jumps makes the IDM free-flow
 * term jump with it — and it has to be reproducible from the clock alone, so
 * that rendering, testing and replay all see the same wander.
 */
export function desiredSpeed(driver: Driver, v0: number, time: number): number {
  return v0 * (1 + driver.driftAmplitude * Math.sin(driver.driftPhase + time * driver.driftRate));
}
