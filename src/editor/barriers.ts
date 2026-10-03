import type { Vec2 } from '@core/vec2';
import { BARRIER_SIZE, type BarrierKind } from '@world/barriers';
import { ROAD_CLEARANCE, touchesRoad } from '@world/buildings/validate';
import type { Network } from '@world/network';
import { Level, halfWidth } from '@world/roadTypes';
import { m } from '@world/units';

/**
 * Drawing walls, fences and hedges along a path (`world/barriers.ts`).
 *
 * A point put down near a road goes onto the back of its footway, the line a
 * building's front snaps to (`buildingSnap.ts`), so a boundary drawn along a
 * street stands flush with the pavement and with the houses on it. Elsewhere
 * it stays where it was put.
 */

/** How far from the back of a footway a point is still put onto it, world units. */
const FOOTWAY_REACH = m(3);
/** Shortest length of a run worth building, world units. */
export const MIN_BARRIER_RUN = m(0.5);

export function snapBarrierPoint(net: Network | null, kind: BarrierKind, at: Vec2): Vec2 {
  if (!net) return at;
  const half = m(BARRIER_SIZE[kind].thickness) / 2;
  let best: { d: number; p: Vec2 } | null = null;
  for (const ribbon of net.ribbons.values()) {
    if (net.doc.segment(ribbon.id)?.structure === 'tunnel') continue;
    const back = halfWidth(ribbon.road, Level.Sidewalk) + ROAD_CLEARANCE + half + m(0.02);
    const hit = ribbon.full.closestPoint(at);
    const off = Math.abs(hit.distance - back);
    if (off > FOOTWAY_REACH || (best && off >= best.d)) continue;
    const frame = ribbon.full.sampleAt(hit.s);
    const side = (at.x - frame.p.x) * frame.n.x + (at.y - frame.p.y) * frame.n.y >= 0 ? 1 : -1;
    best = { d: off, p: { x: frame.p.x + frame.n.x * side * back, y: frame.p.y + frame.n.y * side * back } };
  }
  return best ? best.p : at;
}

/**
 * Why a run cannot be built, or null: it reaches a road or its footway, as a
 * building's own parts may not (`validateBuilding`, same test).
 */
export function barrierProblem(net: Network | null, kind: BarrierKind, points: readonly Vec2[]): 'road' | 'short' | null {
  let length = 0;
  for (let i = 1; i < points.length; i++) length += Math.hypot(points[i]!.x - points[i - 1]!.x, points[i]!.y - points[i - 1]!.y);
  if (points.length < 2 || length < MIN_BARRIER_RUN) return 'short';
  if (!net) return null;
  const half = Math.max(m(0.02), m(BARRIER_SIZE[kind].thickness) / 2 - m(0.05));
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!, b = points[i]!;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len < 1e-6) continue;
    const nx = -(b.y - a.y) / len * half, ny = (b.x - a.x) / len * half;
    const rect = [
      { x: a.x + nx, y: a.y + ny }, { x: b.x + nx, y: b.y + ny },
      { x: b.x - nx, y: b.y - ny }, { x: a.x - nx, y: a.y - ny },
    ];
    if (touchesRoad(net, rect)) return 'road';
  }
  return null;
}
