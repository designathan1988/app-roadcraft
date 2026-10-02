import { m } from '@world/units';
import type { DriverParams } from '../vehicles/driver';
import { safeSpeed, type Obstacle } from '../vehicles/idm';
import { nextSpeed } from './operational';

/**
 * Separate the driver's preferred standing gap from physical stopping room.
 * A newly denied movement inside that preferred gap must not instantaneously
 * stop the body while metres of collision-free braking room still remain.
 */
export function physicalSpeed(p: DriverParams, speed: number, wanted: number, acceleration: number,
  obstacles: readonly Obstacle[], dt: number): number {
  const comfort = nextSpeed(p, speed, wanted, acceleration,
    obstacles.map(o => ({ ...o, hard: false })), dt).v;
  const physical = { ...p, s0: m(0.1) };
  let limit = Infinity;
  for (const obstacle of obstacles) {
    if (obstacle.hard !== false) limit = Math.min(limit, safeSpeed(physical, obstacle, dt));
  }
  return Math.min(comfort, limit);
}
