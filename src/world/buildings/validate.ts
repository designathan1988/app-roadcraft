import type { Vec2 } from '@core/vec2';
import { pointInPolygon } from '@core/polygon';
import { MAP_HALF } from '../bounds';
import type { RoadDoc } from '../doc';
import type { Network } from '../network';
import { Level, halfWidth } from '../roadTypes';
import { MAX_PLINTH, type GroundAt, sampleFootprint } from './foundation';
import { buildingBounds, footprintRects, groundVolumes, occupancy } from './geometry';
import {
  type Building,
  type BuildingId,
  MAX_CELLS,
  MAX_MODULE,
  MAX_STOREYS,
  MAX_STOREY_HEIGHT,
  MAX_VOLUMES,
  MIN_MODULE,
  MIN_STOREY_HEIGHT,
} from './types';

/** Why a building cannot stand where it is. See docs/buildings.md section 3. */
export type BuildingProblem =
  | 'size'
  | 'overlap'
  | 'support'
  | 'footprint'
  | 'bounds'
  | 'road'
  | 'building'
  | 'slope';

export interface SiteContext {
  readonly doc: RoadDoc;
  /** Null skips the road test (a headless check with no network built). */
  readonly net: Network | null;
  /** Null skips the slope test. */
  readonly groundAt: GroundAt | null;
}

/** Nothing the player builds may come closer than this to the map's rim. */
export const BUILDING_MAP_MARGIN = 8;
/** Gap kept between a footprint and the back of a footway. */
export const ROAD_CLEARANCE = 0.3;
/** Overlap two footprints may have and still count as touching (terraces). */
const TOUCH = 0.05;

/** Structural checks: need no world at all. */
export function structuralProblem(b: Building): BuildingProblem | null {
  if (!(b.module >= MIN_MODULE - 1e-9 && b.module <= MAX_MODULE + 1e-9)) return 'size';
  for (const h of [b.groundHeight, b.storeyHeight, ...(b.levels ?? []).filter((x): x is number => typeof x === 'number')]) {
    if (!(h >= MIN_STOREY_HEIGHT - 1e-9 && h <= MAX_STOREY_HEIGHT + 1e-9)) return 'size';
  }
  if (b.volumes.length === 0 || b.volumes.length > MAX_VOLUMES) return 'size';
  for (const v of b.volumes) {
    if (!Number.isInteger(v.x) || !Number.isInteger(v.y) || !Number.isInteger(v.w) || !Number.isInteger(v.d)) return 'size';
    if (v.w < 1 || v.d < 1 || v.w > MAX_CELLS || v.d > MAX_CELLS) return 'size';
    if (!Number.isInteger(v.base) || v.base < 0) return 'size';
    if (v.storeys.length < 1 || v.base + v.storeys.length > MAX_STOREYS) return 'size';
  }
  const occ = occupancy(b);
  if (occ.clashes.length > 0) return 'overlap';
  if (groundVolumes(b).length === 0) return 'footprint';
  for (const v of b.volumes) {
    if (v.base === 0) continue;
    for (let i = v.x; i < v.x + v.w; i++) {
      for (let j = v.y; j < v.y + v.d; j++) {
        if (occ.at(i, j, v.base - 1) === undefined) return 'support';
      }
    }
  }
  return null;
}

/**
 * The first reason `b` cannot stand, or null. `ignore` is the building being
 * edited, which must not collide with its own previous self.
 */
export function validateBuilding(ctx: SiteContext, b: Building, ignore?: BuildingId): BuildingProblem | null {
  const structural = structuralProblem(b);
  if (structural) return structural;

  const box = buildingBounds(b);
  const limit = MAP_HALF - BUILDING_MAP_MARGIN;
  if (box.minX < -limit || box.minY < -limit || box.maxX > limit || box.maxY > limit) return 'bounds';

  const rects = footprintRects(b, -TOUCH);
  if (ctx.net && rects.some((rect) => touchesRoad(ctx.net as Network, rect))) return 'road';

  for (const other of ctx.doc.buildings.all()) {
    if (other.id === b.id || other.id === ignore) continue;
    const ob = buildingBounds(other);
    if (ob.minX > box.maxX || ob.maxX < box.minX || ob.minY > box.maxY || ob.maxY < box.minY) continue;
    const others = footprintRects(other);
    for (const a of rects) for (const c of others) if (convexOverlap(a, c)) return 'building';
  }

  if (ctx.groundAt) {
    const { lowest, highest } = sampleFootprint(b, ctx.groundAt);
    if (highest - lowest > MAX_PLINTH) return 'slope';
  }
  return null;
}

/** Whether a footprint rectangle reaches any road's footway or junction plate. */
export function touchesRoad(net: Network, rect: readonly Vec2[]): boolean {
  const box = boundsOf(rect);
  for (const ribbon of net.ribbons.values()) {
    const segment = net.doc.segment(ribbon.id);
    if (segment?.structure === 'tunnel') continue;
    const reach = halfWidth(ribbon.road, Level.Sidewalk) + ROAD_CLEARANCE;
    const bb = ribbon.full.bbox;
    if (bb.minX - reach > box.maxX || bb.maxX + reach < box.minX || bb.minY - reach > box.maxY || bb.maxY + reach < box.minY) continue;
    if (polylineDistance(ribbon.full.toPoints(), rect) < reach) return true;
  }
  for (const levels of net.junctions.values()) {
    const junction = levels.get(Level.Sidewalk);
    if (!junction || junction.ring.isEmpty) continue;
    const jb = junction.ring.bbox;
    if (jb.minX > box.maxX || jb.maxX < box.minX || jb.minY > box.maxY || jb.maxY < box.minY) continue;
    if (polygonsOverlap(junction.ring.flatten(), rect)) return true;
  }
  return false;
}

// ------------------------------------------------------------------ geometry

export function boundsOf(points: readonly Vec2[]): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  return { minX, minY, maxX, maxY };
}

/** Separating-axis overlap of two convex polygons; touching is not overlap. */
export function convexOverlap(a: readonly Vec2[], b: readonly Vec2[]): boolean {
  for (const poly of [a, b]) {
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i] as Vec2;
      const q = poly[(i + 1) % poly.length] as Vec2;
      const ax = -(q.y - p.y);
      const ay = q.x - p.x;
      const len = Math.hypot(ax, ay);
      if (len < 1e-12) continue;
      let aMin = Infinity;
      let aMax = -Infinity;
      let bMin = Infinity;
      let bMax = -Infinity;
      for (const r of a) {
        const d = (r.x * ax + r.y * ay) / len;
        aMin = Math.min(aMin, d);
        aMax = Math.max(aMax, d);
      }
      for (const r of b) {
        const d = (r.x * ax + r.y * ay) / len;
        bMin = Math.min(bMin, d);
        bMax = Math.max(bMax, d);
      }
      if (aMax <= bMin + 1e-6 || bMax <= aMin + 1e-6) return false;
    }
  }
  return true;
}

function segmentsCross(a: Vec2, b: Vec2, c: Vec2, d: Vec2): boolean {
  const o = (p: Vec2, q: Vec2, r: Vec2): number => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  const d1 = o(c, d, a);
  const d2 = o(c, d, b);
  const d3 = o(a, b, c);
  const d4 = o(a, b, d);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

function pointSegmentDistance(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0;
  return Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t));
}

/** Shortest distance from an open polyline to a closed polygon (0 inside). */
export function polylineDistance(line: readonly Vec2[], polygon: readonly Vec2[]): number {
  for (const p of line) if (pointInPolygon(p, polygon)) return 0;
  let best = Infinity;
  for (let i = 0; i + 1 < line.length; i++) {
    const a = line[i] as Vec2;
    const b = line[i + 1] as Vec2;
    for (let k = 0; k < polygon.length; k++) {
      const c = polygon[k] as Vec2;
      const d = polygon[(k + 1) % polygon.length] as Vec2;
      if (segmentsCross(a, b, c, d)) return 0;
      best = Math.min(best, pointSegmentDistance(a, c, d), pointSegmentDistance(b, c, d), pointSegmentDistance(c, a, b), pointSegmentDistance(d, a, b));
    }
  }
  return best;
}

/** Whether two simple polygons overlap (share interior area, roughly). */
export function polygonsOverlap(a: readonly Vec2[], b: readonly Vec2[]): boolean {
  for (const p of a) if (pointInPolygon(p, b)) return true;
  for (const p of b) if (pointInPolygon(p, a)) return true;
  for (let i = 0; i < a.length; i++) {
    const p = a[i] as Vec2;
    const q = a[(i + 1) % a.length] as Vec2;
    for (let k = 0; k < b.length; k++) {
      if (segmentsCross(p, q, b[k] as Vec2, b[(k + 1) % b.length] as Vec2)) return true;
    }
  }
  return false;
}
