import { type Vec2, dist, sub } from '@core/vec2';
import type { PoleId, SpanId } from './ids';
import { m } from './units';

/**
 * The overhead utility network: poles, the wires strung between them, and the
 * lamps they carry.
 *
 * It is a SECOND drawable graph, deliberately much simpler than the road one.
 * A pole has no width, so there is no casing, no junction, no trim and no
 * elevation solve — a pole stands on whatever is under it and a wire hangs
 * between two of them. Everything in this file is pure geometry and numbers;
 * the meshes live in `src/render/utilities.ts`, and nothing here knows what
 * three.js is.
 *
 * The one piece of real modelling is the wire. A cable hanging under its own
 * weight is a CATENARY, not a straight line and not a parabola, and the sag is
 * the whole reason a pole line reads as wiring rather than as a row of sticks.
 */

/** Height of a pole's mast, from the ground to the crown. */
export const POLE_HEIGHT = m(8.5);
/** Radius at the crown and at the foot. A pole tapers. */
export const POLE_TOP_RADIUS = m(0.11);
export const POLE_BASE_RADIUS = m(0.18);
/** Half-length of the cross-arm the wires are strung from. */
export const POLE_ARM_HALF = m(0.85);
/** How far below the crown the cross-arm sits. */
export const POLE_ARM_DROP = m(0.55);
export const POLE_ARM_THICK = m(0.1);
/** Vertical spacing between the wire courses on the arm. */
export const WIRE_COURSES: readonly number[] = [0, -m(0.45), -m(0.9)];
/** Lateral position of each wire on the cross-arm, as a fraction of its half. */
export const WIRE_OFFSETS: readonly number[] = [-0.8, 0, 0.8];
export const WIRE_RADIUS = m(0.035);

/** Lamp arm reach and head, for the poles that carry a light. */
export const POLE_LAMP_REACH = m(1.6);
export const POLE_LAMP_DROP = m(1.1);
export const POLE_LAMP_LONG = m(0.5);
export const POLE_LAMP_TALL = m(0.14);
export const POLE_LAMP_WIDE = m(0.26);

/**
 * Default distance between poles along a drawn run, in world units.
 *
 * Real distribution poles sit 30 to 45 m apart. At 0.4 m per unit that is 75
 * to 112; the middle of that range keeps the sag readable without turning a
 * short run into a single span.
 */
export const DEFAULT_POLE_SPACING = m(38);
export const MIN_POLE_SPACING = m(18);
export const MAX_POLE_SPACING = m(80);

/**
 * Sag of a span, as a fraction of its length.
 *
 * Measured off real distribution lines: a 40 m span sags about 0.6 m, which is
 * 1.5%. Below about 1% the wire reads as a taut wire rather than a hanging
 * one, and above about 4% it starts to look like washing line.
 */
export const WIRE_SAG_RATIO = 0.018;
/** However long the span, the sag stops growing past this. */
export const WIRE_MAX_SAG = m(1.4);

/** How many points a span is flattened into. */
export const WIRE_SEGMENTS = 8;

export interface UtilityPole {
  readonly id: PoleId;
  x: number;
  y: number;
  /** Whether this pole carries a street light. */
  lamp: boolean;
}

export interface UtilitySpan {
  readonly id: SpanId;
  a: PoleId;
  b: PoleId;
}

/**
 * Sag at the middle of a span of this length.
 *
 * Proportional to length, then capped: a long span over a river should droop
 * more than a short one between two kerbs, but not without limit.
 */
export function spanSag(length: number): number {
  return Math.min(WIRE_MAX_SAG, length * WIRE_SAG_RATIO);
}

/**
 * Height of a catenary above the chord, at normalised position `t` in [0, 1].
 *
 * The exact curve is `a * cosh((x - b) / a)`, which has to be solved for `a`
 * from the sag. For the shallow sags a power line actually has, the difference
 * between that and the quadratic through the same three points is far under a
 * pixel — and the quadratic needs no solve, no `cosh` per vertex and no
 * special case when the two ends are level. What matters visually is that the
 * curve is smooth, symmetric, zero at both ends and deepest in the middle.
 */
export function wireDrop(t: number, sag: number): number {
  const u = t * 2 - 1;
  return sag * (1 - u * u);
}

/**
 * Samples one wire between two poles, as a flat list of 3D points.
 *
 * The ends are given as full 3D positions because the two poles can stand on
 * ground of different heights, and a wire between them hangs from a straight
 * chord that is itself sloped.
 */
export function sampleWire(
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  segments = WIRE_SEGMENTS,
): { x: number; y: number; z: number }[] {
  const length = Math.hypot(bx - ax, by - ay);
  const sag = spanSag(length);
  const out: { x: number; y: number; z: number }[] = new Array(segments + 1);
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    out[i] = {
      x: ax + (bx - ax) * t,
      y: ay + (by - ay) * t,
      z: az + (bz - az) * t - wireDrop(t, sag),
    };
  }
  return out;
}

/**
 * Where the poles of a freshly drawn run go.
 *
 * The run is given as the two ends of a drag. Poles are placed at a regular
 * spacing, and BOTH ENDS ALWAYS GET ONE: a run whose length is not a whole
 * number of spacings would otherwise stop short of where the player released,
 * which reads as the tool having ignored them. The interior spacing is
 * adjusted instead, which is also what a real line does.
 */
export function polePositions(
  from: Vec2,
  to: Vec2,
  spacing = DEFAULT_POLE_SPACING,
): Vec2[] {
  const length = dist(from, to);
  if (!(length > 0)) return [{ x: from.x, y: from.y }];

  const step = Math.max(MIN_POLE_SPACING, Math.min(MAX_POLE_SPACING, spacing));
  const spans = Math.max(1, Math.round(length / step));
  const direction = sub(to, from);

  const out: Vec2[] = new Array(spans + 1);
  for (let i = 0; i <= spans; i++) {
    const t = i / spans;
    out[i] = { x: from.x + direction.x * t, y: from.y + direction.y * t };
  }
  return out;
}

/**
 * Which poles of a run carry a lamp.
 *
 * Not all of them: a lamp on every pole at 15 m spacing would be twice the
 * lighting a street needs and would read as decoration. Every other pole is
 * the usual arrangement, and it is decided by position along the run rather
 * than by an RNG so that redrawing the same line gives the same answer.
 */
export const poleCarriesLamp = (index: number): boolean => index % 2 === 0;
