import type { Vec2 } from '@core/vec2';
import { m } from '../units';
import { STEP_RISE, STEP_RUN } from './foundation';
import {
  EPS,
  GRID,
  SIDE_NORMAL,
  bayWidth,
  elementRect,
  levelElevation,
  localToWorld,
  sideStart,
  volumeHeight,
} from './geometry';
import {
  type Building,
  type BuildingElement,
  type ElementKind,
  type Side,
  type Volume,
  volumeTop,
} from './types';

/**
 * Free parts of a building. See docs/buildings.md, "Elements".
 *
 * Every element is a box of the building's local frame (`BuildingElement`),
 * so collisions with the volumes are exact box tests, and it snaps to what it
 * is put against: a canopy over the bay it is put on, a stair or a ramp from
 * that bay's floor down to the ground, a pillar on a bay line, a wall or a
 * slab on the grid.
 */

/** A ramp's slope: one in twelve, the usual limit for a wheelchair ramp. */
export const RAMP_RUN_PER_RISE = 12;
export const MIN_ELEMENT = m(0.1);
export const MAX_ELEMENT = m(40);

/** Sizes an element starts with, world units: [w, d, h]. */
export const ELEMENT_DEFAULTS: Readonly<Record<ElementKind, readonly [number, number, number]>> = {
  stair: [m(1.2), m(3), m(1)],
  ramp: [m(1.5), m(6), m(0.5)],
  pillar: [m(0.4), m(0.4), m(3)],
  canopy: [m(2.4), m(1.2), m(0.15)],
  wall: [m(4), m(0.25), m(1.8)],
  slab: [m(4), m(4), m(0.25)],
};

/** Whether an element's foot stands on the ground (rather than on a floor, or hung on a wall). */
export const onGround = (e: BuildingElement): boolean => e.z <= EPS && e.kind !== 'canopy';

export { elementRect };

/** The world ring of an element's plan. */
export function elementRing(b: Building, e: BuildingElement, grow = 0): Vec2[] {
  const [x0, y0, x1, y1] = elementRect(e);
  return [
    localToWorld(b, x0 - grow, y0 - grow),
    localToWorld(b, x1 + grow, y0 - grow),
    localToWorld(b, x1 + grow, y1 + grow),
    localToWorld(b, x0 - grow, y1 + grow),
  ];
}

/** World rings of the elements that stand on the ground: footprint, for the road and neighbour tests. */
export const groundElements = (b: Building, grow = 0): Vec2[][] =>
  (b.elements ?? []).filter(onGround).map((e) => elementRing(b, e, grow));

/** Steps of a stair: every riser at most `STEP_RISE`. */
export const stairSteps = (e: BuildingElement): number => Math.max(1, Math.ceil(e.h / STEP_RISE - 1e-9));

/** The run a stair or a ramp needs for its rise. */
export function runFor(kind: ElementKind, rise: number): number {
  if (kind === 'ramp') return Math.max(m(1), rise * RAMP_RUN_PER_RISE);
  return Math.max(STEP_RUN, Math.ceil(rise / STEP_RISE - 1e-9) * STEP_RUN);
}

/** The first volume an element would stand inside of, or null. Touching is allowed. */
export function elementClash(b: Building, e: BuildingElement): Volume | null {
  const [x0, y0, x1, y1] = elementRect(e);
  const z0 = e.z;
  const z1 = e.z + e.h;
  for (const v of b.volumes) {
    const vz0 = levelElevation(b, v.base);
    const vz1 = levelElevation(b, volumeTop(v));
    if (x0 < v.x + v.w - EPS && v.x < x1 - EPS && y0 < v.y + v.d - EPS && v.y < y1 - EPS && z0 < vz1 - EPS && vz0 < z1 - EPS) return v;
  }
  return null;
}

/** A new element's id, and the building's counter moved past it. */
export function takeElementId(b: Building): number {
  const used = (b.elements ?? []).reduce((n, e) => Math.max(n, e.id), 0);
  const id = Math.max(b.nextElementId ?? 1, used + 1);
  b.nextElementId = id + 1;
  return id;
}

// ------------------------------------------------------------------ snapping

/** A bay of a face, as the pointer picked it. */
export interface BayRef {
  readonly volume: number;
  readonly side: Side;
  readonly index: number;
  readonly storey: number;
}

const snap = (v: number, step = GRID): number => Math.round(v / step) * step;

/**
 * Candidate placements of an element of `kind` against a picked bay, best
 * first. The caller keeps the first one that validates - so a stair that has
 * no room to run straight out from the facade turns and runs along it.
 */
export function elementsAgainstBay(b: Building, v: Volume, bay: BayRef, kind: ElementKind): Omit<BuildingElement, 'id'>[] {
  const [dw, dd, dh] = ELEMENT_DEFAULTS[kind];
  const n = SIDE_NORMAL[bay.side];
  const s = sideStart(v, bay.side);
  const width = bayWidth(b, v, bay.side);
  const along = (bay.index + 0.5) * width;
  // A point on the face line, `out` in front of it and `a` along it.
  const at = (a: number, out: number): Vec2 => ({ x: s.x + s.tx * a + n.x * out, y: s.y + s.ty * a + n.y * out });
  const floorZ = levelElevation(b, v.base + bay.storey);
  switch (kind) {
    case 'canopy': {
      // Over the bay's opening, a little below the next floor.
      const z = Math.max(floorZ + m(2.5), levelElevation(b, v.base + bay.storey + 1) - m(0.6));
      const c = at(along, dd / 2);
      return [{ kind, x: c.x, y: c.y, facing: bay.side, w: Math.max(width, dw), d: dd, z, h: dh }];
    }
    case 'stair':
    case 'ramp': {
      // From the floor of the picked storey down to the ground floor's level.
      const rise = Math.max(floorZ, STEP_RISE);
      const run = runFor(kind, rise);
      const w = kind === 'ramp' ? dw : Math.max(dw, Math.min(width, m(1.6)));
      const straight = at(along, run / 2);
      const out: Omit<BuildingElement, 'id'>[] = [{ kind, x: straight.x, y: straight.y, facing: bay.side, w, d: run, z: 0, h: rise }];
      // Turned to run along the facade, either way, its top at the bay.
      for (const dir of [1, -1] as const) {
        const facing = ((bay.side + (dir === 1 ? 1 : 3)) % 4) as Side;
        const c = at(along + dir * (run / 2 - w / 2), w / 2);
        out.push({ kind, x: c.x, y: c.y, facing, w, d: run, z: 0, h: rise });
      }
      return out;
    }
    case 'pillar': {
      // On the nearest bay line, just in front of the face, as tall as the storey.
      const line = Math.round(along / width) * width;
      const c = at(line, dd / 2 + m(0.6));
      return [{ kind, x: c.x, y: c.y, facing: bay.side, w: dw, d: dd, z: floorZ, h: levelElevation(b, v.base + bay.storey + 1) - floorZ }];
    }
    case 'wall': {
      // Parallel to the face, a module out, on the ground.
      const c = at(along, b.module);
      return [{ kind, x: snap(c.x), y: snap(c.y), facing: bay.side, w: Math.max(dw, width), d: dd, z: 0, h: dh }];
    }
    case 'slab': {
      // A deck in front of the bay, at its floor.
      const c = at(along, dd / 2);
      return [{ kind, x: c.x, y: c.y, facing: bay.side, w: Math.max(width, dw), d: dd, z: Math.max(0, floorZ - dh), h: dh }];
    }
  }
}

/** An element of `kind` at a free point of the local frame, on the ground (a slab at `z`). */
export function elementAt(b: Building, kind: ElementKind, p: Vec2, facing: Side): Omit<BuildingElement, 'id'> {
  const [w, d, h] = ELEMENT_DEFAULTS[kind];
  const top = b.volumes.reduce((z, v) => Math.max(z, volumeHeight(b, v)), 0);
  const z = kind === 'canopy' ? Math.min(top, m(2.6)) : 0;
  return { kind, x: snap(p.x), y: snap(p.y), facing, w, d, z, h };
}
