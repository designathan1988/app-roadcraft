import type { Vec2 } from '@core/vec2';
import { m } from './units';

/**
 * Half-length of the chord a body's heading is read along.
 *
 * Paths are polylines, and a polyline's tangent is constant along each piece
 * and jumps at every vertex, so a body pointed along the tangent turns in
 * steps. Pointing it along a short chord centred on the body instead turns it
 * continuously, and on a circular arc the chord is parallel to the tangent at
 * its middle. The drawn pose (`sim/pose.ts`), the conflict sweep
 * (`conflictPoints.ts`) and the turn-path containment check (`turnPaths.ts`)
 * all read the heading this way, so what is checked is what is drawn.
 */
export const HEADING_CHORD = m(1.5);

/** Unit heading from the point `behind` to the point `ahead`, or `fallback` when they coincide. */
export function chordHeading(behind: Vec2, ahead: Vec2, fallback: Vec2): Vec2 {
  const dx = ahead.x - behind.x;
  const dy = ahead.y - behind.y;
  const d = Math.hypot(dx, dy);
  return d < 1e-6 ? fallback : { x: dx / d, y: dy / d };
}
