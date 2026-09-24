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

/** Components that are a way in, on level 0. */
export const ACCESS_COMPONENTS: ReadonlySet<BayComponent> = new Set<BayComponent>(['door', 'shopfront', 'loadingDoor']);

/**
 * Extension point: a way into the building on its ground floor.
 *
 * `ground` is the height of the land in front of it and `steps` the flight
 * that brings the threshold down to it. Pedestrians and deliveries will
 * attach to the footway graph here.
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

export function foundationOf(b: Building, groundAt: GroundAt, bays?: readonly FacadeBay[]): Foundation {
  const { lowest, highest } = sampleFootprint(b, groundAt);
  const floor = highest + PLINTH_MIN;
  const entrances: Entrance[] = [];
  for (const bay of bays ?? facadeBays(b)) {
    if (bay.level !== 0 || !ACCESS_COMPONENTS.has(bay.component)) continue;
    // The ground where the steps would land: half a module out, then again
    // at the far end of the flight the first reading asks for.
    let reach = b.module * 0.5;
    let ground = groundAt(bay.x + bay.nx * reach, bay.y + bay.ny * reach);
    let steps = stepsFor(floor - ground);
    if (steps > 0) {
      reach = Math.max(reach, steps * STEP_RUN + m(0.4));
      ground = Math.min(ground, groundAt(bay.x + bay.nx * reach, bay.y + bay.ny * reach));
      steps = stepsFor(floor - ground);
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

  floorOf(b: Building, groundAt: GroundAt, key: string): number {
    if (key !== this.key) {
      this.key = key;
      this.floors.clear();
    }
    const known = this.floors.get(b.id);
    if (known !== undefined) return known;
    const floor = floorHeight(b, groundAt);
    this.floors.set(b.id, floor);
    return floor;
  }
}

/** The absolute ground-floor height of a building, uncached. */
export const floorHeight = (b: Building, groundAt: GroundAt): number =>
  sampleFootprint(b, groundAt).highest + PLINTH_MIN;

/** Steps needed to climb `rise`; a threshold under two risers needs none. */
export function stepsFor(rise: number): number {
  if (!(rise > STEP_RISE * 1.5)) return 0;
  return Math.min(40, Math.ceil(rise / STEP_RISE));
}
