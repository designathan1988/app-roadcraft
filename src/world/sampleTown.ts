import type { Vec2 } from '@core/vec2';
import { type BlueprintBody, instantiate } from './buildings/blueprints';
import { footprintRects } from './buildings/geometry';
import type { Building, BuildingFunction } from './buildings/types';

/**
 * Where a building stands on a block: boxes, edges, and the arithmetic that
 * turns a model to face the street.
 *
 * These were written for a sample town that drew its own grid; that town is
 * gone - `defaultTown.ts` is the map the game opens on - and what is left
 * here is the vocabulary every town generator needs, which both `town.ts` and
 * `defaultTown.ts` lay their blocks out with.
 */

/** Between the pavement's edge and a facade; between two neighbours. */
const FRONT_GAP = 0.12;
const PARTY_GAP = 0;
void PARTY_GAP;

export interface Box { x0: number; y0: number; x1: number; y1: number }

export function boxOf(b: Omit<Building, 'id'>): Box {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const ring of footprintRects(b as Building)) {
    for (const p of ring) {
      x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y);
      x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y);
    }
  }
  return { x0, y0, x1, y1 };
}

export const overlaps = (a: Box, b: Box, gap: number): boolean =>
  a.x0 < b.x1 + gap && a.x1 > b.x0 - gap && a.y0 < b.y1 + gap && a.y1 > b.y0 - gap;

export const inside = (a: Box, b: Box): boolean =>
  a.x0 >= b.x0 - 0.05 && a.x1 <= b.x1 + 0.05 && a.y0 >= b.y0 - 0.05 && a.y1 <= b.y1 + 0.05;

export interface Edge { readonly start: Vec2; readonly along: Vec2; readonly inward: Vec2; readonly length: number }

/** Any model (`body`) turned to face the street on `edge`, its front's left end `t` along it. */
export function facingBody(source: BlueprintBody, fn: BuildingFunction, edge: Edge, t: number, gap = FRONT_GAP): { body: Omit<Building, 'id'>; box: Box; width: number } {
  const model = { body: source };
  // The model's front (local -y) towards the street, which is against `inward`.
  const rotation = Math.atan2(-edge.inward.x, edge.inward.y);
  const probe = instantiate(model.body, { x: 0, y: 0 }, rotation, fn);
  const pb = boxOf(probe);
  const width = edge.along.x !== 0 ? pb.x1 - pb.x0 : pb.y1 - pb.y0;
  const at = {
    x: edge.start.x + edge.along.x * (t + width / 2) + edge.inward.x * gap,
    y: edge.start.y + edge.along.y * (t + width / 2) + edge.inward.y * gap,
  };
  const body = { ...instantiate(model.body, at, rotation, fn), function: fn };
  return { body, box: boxOf(body), width };
}

