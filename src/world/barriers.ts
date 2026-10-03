/**
 * Walls, fences and hedges drawn along a path, as roads are: a run of points
 * on the ground, each pair of them a straight length of barrier.
 *
 * Their own graph, not a building's parts: a building's fence lives in its
 * local frame and needs the building selected first, and a boundary along a
 * street is nobody's building. Drawn as a network the way city builders do
 * it (Cities: Skylines' walls and fences, laid like roads) and traced point
 * after point as The Sims' fence tool is.
 */
export type BarrierKind = 'fence' | 'wall' | 'hedge';

export const BARRIER_KINDS: readonly BarrierKind[] = ['fence', 'wall', 'hedge'];

export interface Barrier {
  readonly id: number;
  readonly kind: BarrierKind;
  /** The path, in world units on the ground; two points or more. */
  readonly points: readonly { readonly x: number; readonly y: number }[];
}

/** Each kind's height and thickness, metres. */
export const BARRIER_SIZE: Readonly<Record<BarrierKind, { readonly height: number; readonly thickness: number }>> = {
  fence: { height: 1.1, thickness: 0.12 },
  wall: { height: 1.8, thickness: 0.25 },
  hedge: { height: 1.2, thickness: 0.8 },
};

export function isBarrierKind(value: unknown): value is BarrierKind {
  return value === 'fence' || value === 'wall' || value === 'hedge';
}
