import clipping from 'polygon-clipping';
import { isSimple, pointInPolygon, signedArea } from '@core/polygon';
import type { Vec2 } from '@core/vec2';
import type { FaceId, RoofDetail, Volume } from './types';

/** Polygon outlines are normalized to the volume's bounding rectangle. */
export function validOutline(points: readonly Vec2[]): boolean {
  return points.length >= 3 && points.length <= 64 &&
    points.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y) && p.x >= -1e-6 && p.y >= -1e-6 && p.x <= 1 + 1e-6 && p.y <= 1 + 1e-6) &&
    points.every((p, i) => Math.hypot(p.x - points[(i + 1) % points.length]!.x, p.y - points[(i + 1) % points.length]!.y) > 1e-6) &&
    signedArea(points) > 1e-5 && isSimple(points);
}

export function localFootprint(v: Volume): Vec2[] {
  return v.outline ? v.outline.map((p) => ({ x: v.x + p.x * v.w, y: v.y + p.y * v.d }))
    : [{ x: v.x, y: v.y }, { x: v.x + v.w, y: v.y }, { x: v.x + v.w, y: v.y + v.d }, { x: v.x, y: v.y + v.d }];
}

export const volumeSides = (v: Volume): FaceId[] => Array.from({ length: v.outline?.length ?? 4 }, (_, i) => i);

export interface EdgeFrame { x: number; y: number; tx: number; ty: number; nx: number; ny: number; length: number }

export function edgeFrame(v: Volume, side: number): EdgeFrame {
  const ring = localFootprint(v);
  let p = ring[side % ring.length]!, q = ring[(side + 1) % ring.length]!;
  const dx = q.x - p.x, dy = q.y - p.y;
  const length = Math.hypot(dx, dy) || 1;
  const nx = dy / length, ny = -dx / length;
  // Legacy rectangles number bays from left to right / front to back.
  if (!v.outline && side >= 2) [p, q] = [q, p];
  return { x: p.x, y: p.y, tx: (q.x - p.x) / length, ty: (q.y - p.y) / length, nx, ny, length };
}

export const asPolygon = (ring: readonly Vec2[]): clipping.Polygon => [ring.map((p) => [p.x, p.y])];

export function polygonArea(poly: clipping.MultiPolygon): number {
  return poly.reduce((total, rings) => total + rings.reduce((sum, ring, index) =>
    sum + (index === 0 ? 1 : -1) * Math.abs(signedArea(ring.map(([x, y]) => ({ x, y })))), 0), 0);
}

export const overlapArea = (a: readonly Vec2[], b: readonly Vec2[]): number =>
  polygonArea(clipping.intersection(asPolygon(a), asPolygon(b)));

/** A side cut leaves one simple outline; enclosed holes are built from masses. */
export function cutOutline(source: readonly Vec2[], cut: readonly Vec2[]): Vec2[] | null {
  if (overlapArea(source, cut) < 1e-5) return null;
  const result = clipping.difference(asPolygon(source), asPolygon(cut));
  if (result.length !== 1 || result[0]?.length !== 1) return null;
  const ring = result[0][0];
  if (!ring || ring.length < 4) return null;
  const points = ring.slice(0, -1).map(([x, y]) => ({ x, y }));
  return signedArea(points) < 0 ? points.reverse() : points;
}

export function supportedBy(ring: readonly Vec2[], supports: readonly Vec2[][]): boolean {
  if (supports.length === 0) return false;
  const remaining = clipping.difference(asPolygon(ring), ...supports.map(asPolygon));
  return polygonArea(remaining) < 1e-5;
}

export function containsPoint(v: Volume, p: Vec2): boolean {
  const ring = localFootprint(v);
  if (pointInPolygon(p, ring)) return true;
  return ring.some((a, i) => {
    const q = ring[(i + 1) % ring.length]!;
    const cross = (p.x - a.x) * (q.y - a.y) - (p.y - a.y) * (q.x - a.x);
    return Math.abs(cross) < 1e-6 && p.x >= Math.min(a.x, q.x) - 1e-6 && p.x <= Math.max(a.x, q.x) + 1e-6 && p.y >= Math.min(a.y, q.y) - 1e-6 && p.y <= Math.max(a.y, q.y) + 1e-6;
  });
}

export function roofPartFits(v: Volume, part: Pick<RoofDetail, 'x' | 'y' | 'w' | 'd' | 'rotation'>): boolean {
  if (![part.x, part.y, part.w, part.d, part.rotation].every(Number.isFinite) || part.w <= 0 || part.d <= 0) return false;
  return roofDetailRing(part).every((point) => containsPoint(v, point));
}

export function roofDetailRing(part: Pick<RoofDetail, 'x' | 'y' | 'w' | 'd' | 'rotation'>): Vec2[] {
  const c = Math.cos(part.rotation), s = Math.sin(part.rotation);
  const ring: Vec2[] = [];
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) {
    const dx = sx * part.w / 2, dy = sy * part.d / 2;
    ring.push({ x: part.x + dx * c - dy * s, y: part.y + dx * s + dy * c });
  }
  return [ring[0]!, ring[2]!, ring[3]!, ring[1]!];
}

/** Small miter offsets for selection outlines and ground clearance. */
export function offsetRing(ring: readonly Vec2[], distance: number): Vec2[] {
  if (distance === 0) return ring.map((p) => ({ ...p }));
  return ring.map((p, i) => {
    const prev = ring[(i + ring.length - 1) % ring.length]!, next = ring[(i + 1) % ring.length]!;
    const a = Math.hypot(p.x - prev.x, p.y - prev.y) || 1;
    const b = Math.hypot(next.x - p.x, next.y - p.y) || 1;
    const nx = (p.y - prev.y) / a, ny = -(p.x - prev.x) / a;
    const mx = (next.y - p.y) / b, my = -(next.x - p.x) / b;
    const scale = distance / Math.max(.3, 1 + nx * mx + ny * my);
    return { x: p.x + (nx + mx) * scale, y: p.y + (ny + my) * scale };
  });
}
