import { m } from '../units';
import { type FacadeBay, facadeBays, groundVolumes, localToWorld } from './geometry';
import type { BayComponent, Building, Side } from './types';

/**
 * How a building meets the ground. See docs/buildings.md section 2.
 *
 * The caller passes the ground: the renderer passes the height the terrain
 * TRIANGLES are drawn at (`renderedHeightAt`), because that is what a floor
 * has to clear - AGENTS.md's trap about terrain height having two meanings.
 */

/**
 * The ground floor stands at least this far above the highest ground under it:
 * one kerb, so a building on level ground has a level entrance.
 */
export const PLINTH_MIN = m(0.15);
/** The plinth runs this far below the lowest ground, so no slope shows under it. */
export const PLINTH_BURY = m(0.8);
/** The steepest site a building may be placed on: ground spread under the footprint. */
export const MAX_PLINTH = m(5.5);
export const STEP_RISE = m(0.17);
export const STEP_RUN = m(0.3);

export type GroundAt = (x: number, y: number) => number;

/**
 * Height of a PAVED surface at a point - a footway, a carriageway - or NaN
 * where there is none. The terrain under a footway is shaped well below the
 * paving (`SHAPE_DROP` in `world/elevation.ts`), so the land and the surface a
 * person stands on are two different answers there; the renderer answers this
 * one from the solved road surfaces. A caller with no roads passes nothing.
 */
export type PavedAt = (x: number, y: number) => number;

const NO_PAVING: PavedAt = () => NaN;

/** Components that are a way in, on level 0. */
export const ACCESS_COMPONENTS: ReadonlySet<BayComponent> = new Set<BayComponent>(['door', 'shopfront', 'loadingDoor']);

/** How far in front of an entrance paving still counts as the street it opens onto. */
const ENTRANCE_REACH = m(1.5);
/** Sampling step when looking for the edge of the paving in front of an entrance. */
const SCAN_STEP = m(0.1);
/** Wall kept between a recessed flight and the back of its volume. */
const RECESS_BACK = m(1.2);

/**
 * Extension point: a way into the building on its ground floor.
 *
 * `ground` is the height of the land in front of it and `steps` the flight
 * that brings the threshold down to it. A flight never crosses paving: where
 * there is no room for it in front of the facade (a building on the back of a
 * footway) it is set into the building instead, `recess` deep, like a porch.
 * Pedestrians and deliveries will attach to the footway graph here.
 */
export interface Entrance {
  readonly volume: number;
  readonly side: Side;
  readonly index: number;
  readonly component: BayComponent;
  /** World point of the threshold, on the facade line. */
  readonly x: number;
  readonly y: number;
  readonly nx: number;
  readonly ny: number;
  readonly width: number;
  /** Absolute height of the ground at the foot of the steps. */
  readonly ground: number;
  /** Number of steps from the ground up to the floor; 0 = level access. */
  readonly steps: number;
  /**
   * How far behind the facade line the threshold is, when the flight is set
   * into the building (0: the flight, if any, stands outside).
   */
  readonly recess: number;
  /**
   * Length of the slab at `ground` height from the foot of a recessed flight
   * out to the paving, over the verge between them (0: none).
   */
  readonly threshold: number;
}

export interface Foundation {
  /** Absolute world height of the ground floor. */
  readonly floor: number;
  readonly lowest: number;
  readonly highest: number;
  /** Absolute height of the bottom of the plinth. */
  readonly bottom: number;
  /** Ground spread under the footprint: what `MAX_PLINTH` limits. */
  readonly spread: number;
  readonly entrances: readonly Entrance[];
}

/** Samples the ground over every ground volume, at half-cell spacing. */
export function sampleFootprint(b: Building, groundAt: GroundAt): { lowest: number; highest: number } {
  let lowest = Infinity;
  let highest = -Infinity;
  for (const v of groundVolumes(b)) {
    const stepsX = Math.min(24, v.w * 2);
    const stepsY = Math.min(24, v.d * 2);
    for (let a = 0; a <= stepsX; a++) {
      for (let c = 0; c <= stepsY; c++) {
        const lx = (v.x + (v.w * a) / stepsX) * b.module;
        const ly = (v.y + (v.d * c) / stepsY) * b.module;
        const p = localToWorld(b, lx, ly);
        const h = groundAt(p.x, p.y);
        if (!Number.isFinite(h)) continue;
        lowest = Math.min(lowest, h);
        highest = Math.max(highest, h);
      }
    }
  }
  if (!Number.isFinite(lowest)) return { lowest: 0, highest: 0 };
  return { lowest, highest };
}

const isAccess = (bay: FacadeBay): boolean => bay.level === 0 && ACCESS_COMPONENTS.has(bay.component);

/** Plan length of a flight of `steps`: one tread each, and the top one doubled as a landing. */
export const flightRun = (steps: number): number => (steps > 0 ? (steps + 1) * STEP_RUN : 0);

/**
 * The highest paving any entrance opens onto, or -Infinity. The ground floor
 * is never below it: a door onto a footway is at the footway's level, not a
 * step down from it.
 */
function entrancePaving(bays: readonly FacadeBay[], pavedAt: PavedAt): number {
  let best = -Infinity;
  for (const bay of bays) {
    if (!isAccess(bay)) continue;
    for (const d of [m(0.25), ENTRANCE_REACH * 0.5, ENTRANCE_REACH]) {
      const h = pavedAt(bay.x + bay.nx * d, bay.y + bay.ny * d);
      if (Number.isFinite(h)) {
        best = Math.max(best, h);
        break;
      }
    }
  }
  return best;
}

/**
 * Distance from a facade to the first paving in front of it, or Infinity if
 * there is none within `limit`: the room a flight of steps has there.
 */
function pavingEdge(bay: FacadeBay, pavedAt: PavedAt, limit: number): number {
  const paved = (d: number): boolean => Number.isFinite(pavedAt(bay.x + bay.nx * d, bay.y + bay.ny * d));
  let outside = 0;
  for (let d = SCAN_STEP; d <= limit + 1e-9; d += SCAN_STEP * 2.5) {
    if (!paved(d)) {
      outside = d;
      continue;
    }
    // The edge is between the last dry sample and this one: halve the gap.
    let inside = d;
    while (inside - outside > SCAN_STEP * 0.25) {
      const mid = (inside + outside) / 2;
      if (paved(mid)) inside = mid;
      else outside = mid;
    }
    return outside;
  }
  return paved(0) ? 0 : Infinity;
}

export function foundationOf(
  b: Building,
  groundAt: GroundAt,
  bays?: readonly FacadeBay[],
  pavedAt: PavedAt = NO_PAVING,
): Foundation {
  const all = bays ?? facadeBays(b);
  const { lowest, highest } = sampleFootprint(b, groundAt);
  const floor = Math.max(highest, entrancePaving(all, pavedAt)) + PLINTH_MIN;
  const volumes = new Map(b.volumes.map((v) => [v.id, v]));
  const entrances: Entrance[] = [];
  for (const bay of all) {
    if (!isAccess(bay)) continue;
    // What a person stands on at `d` in front of the facade: the paving where
    // there is some, the land elsewhere.
    const surface = (d: number): number => {
      const x = bay.x + bay.nx * d;
      const y = bay.y + bay.ny * d;
      const paved = pavedAt(x, y);
      return Number.isFinite(paved) ? paved : groundAt(x, y);
    };
    let ground = surface(b.module * 0.5);
    let steps = stepsFor(floor - ground);
    let recess = 0;
    let threshold = 0;
    if (steps > 0) {
      // A flight may run out to the paving and no further.
      const room = pavingEdge(bay, pavedAt, flightRun(stepsFor(floor - Math.min(ground, lowest))) + m(0.5));
      // At and past the edge of the paving, the paving is what one stands on:
      // not the verge between it and the building, shaped down with the road.
      const stand = (d: number): number => (d >= room ? surface(room + SCAN_STEP * 0.3) : surface(d));
      ground = stand(b.module * 0.5);
      steps = stepsFor(floor - ground);
      if (flightRun(steps) <= room) {
        // Read the ground again where the flight would land.
        ground = Math.min(ground, stand(Math.max(b.module * 0.5, flightRun(steps) + m(0.4))));
        steps = stepsFor(floor - ground);
      }
      if (flightRun(steps) > room) {
        // No room in front: the flight is set into the building. It starts
        // where a person arrives from - the paving, when that is right there
        // (a threshold slab bridges the verge), else the land at the facade.
        const fromPaving = room <= ENTRANCE_REACH;
        ground = stand(fromPaving ? room : m(0.2));
        threshold = fromPaving ? room : 0;
        steps = stepsFor(floor - ground);
        const v = volumes.get(bay.volume);
        const depth = v ? (bay.side === 0 || bay.side === 2 ? v.d : v.w) * b.module : b.module;
        // A volume too shallow for the whole flight takes as many treads as
        // fit, each a little steeper.
        const fit = Math.max(0, depth - RECESS_BACK);
        if (flightRun(steps) > fit) steps = Math.max(0, Math.floor(fit / STEP_RUN + 1e-9) - 1);
        recess = flightRun(steps);
        if (steps === 0) threshold = 0;
      }
    }
    entrances.push({
      volume: bay.volume,
      side: bay.side,
      index: bay.index,
      component: bay.component,
      x: bay.x,
      y: bay.y,
      nx: bay.nx,
      ny: bay.ny,
      width: bay.width,
      ground,
      steps,
      recess,
      threshold,
    });
  }
  return {
    floor,
    lowest,
    highest,
    bottom: lowest - PLINTH_BURY,
    spread: highest - lowest,
    entrances,
  };
}

/**
 * Ground-floor heights of stored buildings, remembered until `key` changes.
 * The caller builds the key from every revision the ground depends on (the
 * roads shape the terrain, so the network's counts as well as the land's).
 */
export class FloorCache {
  private key = '';
  private readonly floors = new Map<number, number>();

  floorOf(b: Building, groundAt: GroundAt, key: string, pavedAt: PavedAt = NO_PAVING): number {
    if (key !== this.key) {
      this.key = key;
      this.floors.clear();
    }
    const known = this.floors.get(b.id);
    if (known !== undefined) return known;
    const floor = floorHeight(b, groundAt, pavedAt);
    this.floors.set(b.id, floor);
    return floor;
  }
}

/** The absolute ground-floor height of a building, uncached. Same rule as `foundationOf`. */
export function floorHeight(b: Building, groundAt: GroundAt, pavedAt: PavedAt = NO_PAVING): number {
  const highest = sampleFootprint(b, groundAt).highest;
  const paving = pavedAt === NO_PAVING ? -Infinity : entrancePaving(facadeBays(b), pavedAt);
  return Math.max(highest, paving) + PLINTH_MIN;
}

/** Steps needed to climb `rise`; a threshold under two risers needs none. */
export function stepsFor(rise: number): number {
  if (!(rise > STEP_RISE * 1.5)) return 0;
  return Math.min(40, Math.ceil(rise / STEP_RISE));
}
