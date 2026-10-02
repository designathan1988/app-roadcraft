import { validOutline, overlapArea, roofPartFits } from './footprints';
import type { Vec2 } from '@core/vec2';
import { pointInPolygon } from '@core/polygon';
import { MAP_HALF } from '../bounds';
import type { RoadDoc } from '../doc';
import type { Network } from '../network';
import { Level, halfWidth } from '../roadTypes';
import { MAX_ELEMENT, MIN_ELEMENT, elementClash, groundElements } from './elements';
import { MAX_PLINTH, type GroundAt, sampleFootprint } from './foundation';
import {
  MIN_SIZE,
  buildingBounds,
  footprintRects,
  groundProjections,
  groundVolumes,
  isSupported,
  sideLength,
} from './geometry';
import {
  type Building,
  type BuildingId,
  MAX_ELEMENTS,
  MAX_MODULE,
  MAX_PITCH,
  MAX_PROJECTION,
  MAX_RECESS,
  MAX_SIZE,
  MIN_PITCH,
  MAX_STOREYS,
  MAX_STOREY_HEIGHT,
  MAX_GROUND_HEIGHT,
  MAX_VOLUMES,
  MIN_MODULE,
  MIN_STOREY_HEIGHT,
} from './types';

/** Why a building cannot stand where it is. See docs/buildings.md section 3. */
export type BuildingProblem =
  | 'cut'
  | 'setback'
  | 'roofSpace'
  | 'outline'
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
/**
 * Gap kept between a footprint and the back of a footway: next to nothing.
 * A town's facades stand ON the back of the pavement; at 0.3 (and the snap's
 * own 0.2 on top) every building stood behind a strip of grass, the road's
 * verge, which read as a gap between the pavement and the wall.
 */
export const ROAD_CLEARANCE = 0.02;
/** Overlap two footprints may have and still count as touching (terraces). */
const TOUCH = 0.05;

/** Structural checks: need no world at all. */
export function structuralProblem(b: Building): BuildingProblem | null {
  if (!(b.module >= MIN_MODULE - 1e-9 && b.module <= MAX_MODULE + 1e-9)) return 'size';
  if (!(b.groundHeight >= MIN_STOREY_HEIGHT - 1e-9 && b.groundHeight <= MAX_GROUND_HEIGHT + 1e-9)) return 'size';
  for (const h of [b.storeyHeight, ...(b.levels ?? []).slice(1).filter((x): x is number => typeof x === 'number')]) {
    if (!(h >= MIN_STOREY_HEIGHT - 1e-9 && h <= MAX_STOREY_HEIGHT + 1e-9)) return 'size';
  }
  const first = b.levels?.[0];
  if (typeof first === 'number' && !(first >= MIN_STOREY_HEIGHT - 1e-9 && first <= MAX_GROUND_HEIGHT + 1e-9)) return 'size';
  if (b.volumes.length === 0 || b.volumes.length > MAX_VOLUMES) return 'size';
  for (const v of b.volumes) {
    if (v.outline && !validOutline(v.outline)) return 'outline';
    if ((v.roofDetails?.length ?? 0) > 32 || v.roofDetails?.some((detail) => !roofPartFits(v, detail))) return 'size';
    if (![v.x, v.y, v.w, v.d].every(Number.isFinite)) return 'size';
    if (v.w < MIN_SIZE - 1e-6 || v.d < MIN_SIZE - 1e-6 || v.w > MAX_SIZE + 1e-6 || v.d > MAX_SIZE + 1e-6) return 'size';
    if (!Number.isInteger(v.base) || v.base < 0) return 'size';
    if (v.storeys.length < 1 || v.base + v.storeys.length > MAX_STOREYS) return 'size';
    if (v.pitch !== undefined && !(v.pitch >= MIN_PITCH && v.pitch <= MAX_PITCH)) return 'size';
    for (const r of v.reliefs ?? []) {
      if (r.side < 0 || r.side >= (v.outline?.length ?? 4)) return 'size';
      if (!Number.isFinite(r.depth) || r.depth > MAX_PROJECTION + 1e-6 || r.depth < -MAX_RECESS - 1e-6) return 'size';
      // A recess leaves at least a metre of the volume behind it.
      const across = sideLength(v, r.side === 0 || r.side === 2 ? 1 : 0);
      if (r.depth < 0 && -r.depth > across - MIN_SIZE / 2) return 'size';
    }
    for (const [faceKey, geometry] of Object.entries(v.facadeGeometry ?? {})) {
      if (!geometry) return 'size';
      const face = Number(faceKey);
      if (!Number.isInteger(face) || face < 0 || face >= (v.outline?.length ?? 4)) return 'size';
      if (geometry.bays !== undefined && (!Number.isInteger(geometry.bays) || geometry.bays < 1 || geometry.bays > 64)) return 'size';
      for (const ratio of [geometry.windowWidth, geometry.windowHeight])
        if (ratio !== undefined && (!Number.isFinite(ratio) || ratio < .15 || ratio > .95)) return 'size';
      for (const length of [geometry.sill, geometry.pierWidth, geometry.pierDepth])
        if (length !== undefined && (!Number.isFinite(length) || length < 0 || length > MAX_PROJECTION)) return 'size';
      if (geometry.pierEvery !== undefined && (!Number.isInteger(geometry.pierEvery) || geometry.pierEvery < 1 || geometry.pierEvery > 16)) return 'size';
    }
  }
  // Blocks may stand in each other's space: a building is blocks put
  // together like bricks, and what is drawn is their union. Refusing an
  // overlap forced every joined block to be cut, and nothing could be moved
  // back out again.
  if (groundVolumes(b).length === 0) return 'footprint';
  for (const v of b.volumes) if (!isSupported(b, v)) return 'support';
  const elements = b.elements ?? [];
  if (elements.length > MAX_ELEMENTS) return 'size';
  for (const e of elements) {
    if (![e.x, e.y, e.w, e.d, e.z, e.h].every(Number.isFinite) || e.z < -1e-6) return 'size';
    if (Math.min(e.w, e.d, e.h) < MIN_ELEMENT - 1e-6 || Math.max(e.w, e.d, e.h) > MAX_ELEMENT + 1e-6) return 'size';
    // Parts meet the volumes; they never stand inside them.
    if (elementClash(b, e)) return 'overlap';
  }
  return null;
}

/**
 * The first reason `b` cannot stand, or null. `ignore` is the building being
 * edited, which must not collide with its own previous self.
 */
export function validateBuilding(
  ctx: SiteContext,
  b: Building,
  ignore?: BuildingId | readonly BuildingId[],
): BuildingProblem | null {
  // One building (an edit of it) or several (the neighbours a weld is about to
  // absorb): either way they are not obstacles to what is being checked.
  const ignored = ignore === undefined ? undefined : Array.isArray(ignore) ? new Set(ignore) : new Set([ignore as BuildingId]);
  const structural = structuralProblem(b);
  if (structural) return structural;

  const box = buildingBounds(b);
  const limit = MAP_HALF - BUILDING_MAP_MARGIN;
  if (box.minX < -limit || box.minY < -limit || box.maxX > limit || box.maxY > limit) return 'bounds';

  const rects = [...footprintRects(b, -TOUCH), ...groundProjections(b, -TOUCH), ...groundElements(b, -TOUCH)];
  if (ctx.net && rects.some((rect) => touchesRoad(ctx.net as Network, rect))) return 'road';

  for (const other of ctx.doc.buildings.all()) {
    if (other.id === b.id || ignored?.has(other.id)) continue;
    const ob = buildingBounds(other);
    if (ob.minX > box.maxX || ob.maxX < box.minX || ob.minY > box.maxY || ob.maxY < box.minY) continue;
    const others = [...footprintRects(other), ...groundProjections(other), ...groundElements(other)];
    for (const a of rects) for (const c of others) if (overlapArea(a, c) > 1e-5) return 'building';
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
