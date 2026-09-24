import type { Vec2 } from '@core/vec2';
import type { BlueprintBody } from '@world/buildings/blueprints';
import { buildingBounds, footprintCells, footprintRects } from '@world/buildings/geometry';
import { ROAD_CLEARANCE } from '@world/buildings/validate';
import type { Building, BuildingId } from '@world/buildings/types';
import type { RoadDoc } from '@world/doc';
import type { Network } from '@world/network';
import { Level, halfWidth } from '@world/roadTypes';
import { normaliseAngle } from './buildings';

/**
 * Where a footprint goes when the pointer is at `cursor`. See
 * docs/buildings.md section 4, "Snapping": to a road first (facing it, its
 * front along the back of the footway, flush with a neighbour on the same
 * frontage), then to a nearby building (its rotation, edges flush), then to
 * the module grid.
 *
 * The result is an ANCHOR - the middle of the footprint's front edge - and a
 * rotation, which is exactly what `instantiate` takes.
 */
export interface PlacementSnap {
  readonly anchor: Vec2;
  readonly rotation: number;
  readonly kind: 'road' | 'building' | 'grid';
}

/** The size of a footprint, measured from its anchor. */
export interface FootprintSize {
  readonly width: number;
  readonly depth: number;
  readonly module: number;
}

export function footprintSize(body: BlueprintBody | Building): FootprintSize {
  const f = footprintCells(body as Building);
  return { width: (f.x1 - f.x0) * body.module, depth: (f.y1 - f.y0) * body.module, module: body.module };
}

/** How far from a road a footprint still snaps to it, beyond its own depth. */
const ROAD_REACH = 24;
/** How close an edge must come to another to be made flush. */
const EDGE_SNAP = 0.8;
/** How far a building still lends its rotation to one being placed. */
const BUILDING_REACH = 30;

export function snapPlacement(
  doc: RoadDoc,
  net: Network | null,
  size: FootprintSize,
  cursor: Vec2,
  rotation: number,
  ignore?: BuildingId,
): PlacementSnap {
  const road = net ? snapToRoad(net, size, cursor) : null;
  if (road) return flush(doc, road, size, false, ignore);
  const near = nearestBuilding(doc, cursor, ignore);
  if (near) {
    const quarter = Math.PI / 2;
    const k = Math.round(normaliseAngle(rotation - near.rotation) / quarter);
    const aligned: PlacementSnap = {
      anchor: frontAnchor(cursor, size, near.rotation + k * quarter),
      rotation: normaliseAngle(near.rotation + k * quarter),
      kind: 'building',
    };
    return flush(doc, aligned, size, true, ignore);
  }
  const u = size.module;
  const snapped = { x: Math.round(cursor.x / u) * u, y: Math.round(cursor.y / u) * u };
  return { anchor: frontAnchor(snapped, size, rotation), rotation: normaliseAngle(rotation), kind: 'grid' };
}

/** The front-centre anchor that puts the footprint's CENTRE at `centre`. */
function frontAnchor(centre: Vec2, size: FootprintSize, rotation: number): Vec2 {
  // Local -y is the front; the centre is depth/2 behind the anchor.
  const vx = -Math.sin(rotation);
  const vy = Math.cos(rotation);
  return { x: centre.x - vx * (size.depth / 2), y: centre.y - vy * (size.depth / 2) };
}

function snapToRoad(net: Network, size: FootprintSize, cursor: Vec2): PlacementSnap | null {
  let best: { distance: number; anchor: Vec2; rotation: number } | null = null;
  for (const ribbon of net.ribbons.values()) {
    const segment = net.doc.segment(ribbon.id);
    if (!segment || segment.structure === 'tunnel') continue;
    const half = halfWidth(ribbon.road, Level.Sidewalk) + ROAD_CLEARANCE + 0.2;
    const hit = ribbon.full.closestPoint(cursor);
    if (hit.distance > half + size.depth + ROAD_REACH) continue;
    if (best && hit.distance >= best.distance) continue;
    const frame = ribbon.full.sampleAt(hit.s);
    const side = (cursor.x - frame.p.x) * frame.n.x + (cursor.y - frame.p.y) * frame.n.y >= 0 ? 1 : -1;
    const ox = frame.n.x * side;
    const oy = frame.n.y * side;
    // The front (local -y) faces the road: (sin r, -cos r) = -outward.
    const rotation = Math.atan2(-ox, oy);
    // Along the road, the anchor snaps to half-modules from the road's start.
    const step = size.module / 2;
    const s = Math.round(hit.s / step) * step;
    const along = ribbon.full.sampleAt(Math.max(0, Math.min(ribbon.full.length, s)));
    best = {
      distance: hit.distance,
      anchor: { x: along.p.x + ox * half, y: along.p.y + oy * half },
      rotation,
    };
  }
  return best ? { anchor: best.anchor, rotation: normaliseAngle(best.rotation), kind: 'road' } : null;
}

function nearestBuilding(doc: RoadDoc, cursor: Vec2, ignore?: BuildingId): Building | null {
  let best: Building | null = null;
  let bestDistance = BUILDING_REACH;
  for (const b of doc.buildings.all()) {
    if (b.id === ignore) continue;
    const box = buildingBounds(b);
    const dx = Math.max(box.minX - cursor.x, 0, cursor.x - box.maxX);
    const dy = Math.max(box.minY - cursor.y, 0, cursor.y - box.maxY);
    const d = Math.hypot(dx, dy);
    if (d < bestDistance) {
      bestDistance = d;
      best = b;
    }
  }
  return best;
}

/**
 * Makes the footprint's edges flush with a neighbour of the same bearing:
 * along the local x axis always (a terrace along a street), along y too when
 * `both` (a building placed against another's back or side, away from roads).
 */
function flush(doc: RoadDoc, snap: PlacementSnap, size: FootprintSize, both: boolean, ignore?: BuildingId): PlacementSnap {
  const ux = Math.cos(snap.rotation);
  const uy = Math.sin(snap.rotation);
  const vx = -uy;
  const vy = ux;
  let shiftU = 0;
  let shiftV = 0;
  let bestU = EDGE_SNAP * size.module;
  let bestV = EDGE_SNAP * size.module;
  const reach = Math.max(size.width, size.depth) * 2 + 20;
  for (const b of doc.buildings.all()) {
    if (b.id === ignore) continue;
    const turn = Math.abs(normaliseAngle((b.rotation - snap.rotation) * 4)) / 4;
    if (turn > 0.02) continue;
    const box = buildingBounds(b);
    if (box.minX > snap.anchor.x + reach || box.maxX < snap.anchor.x - reach ||
      box.minY > snap.anchor.y + reach || box.maxY < snap.anchor.y - reach) continue;
    for (const rect of footprintRects(b)) {
      let minU = Infinity;
      let maxU = -Infinity;
      let minV = Infinity;
      let maxV = -Infinity;
      for (const p of rect) {
        const du = (p.x - snap.anchor.x) * ux + (p.y - snap.anchor.y) * uy;
        const dv = (p.x - snap.anchor.x) * vx + (p.y - snap.anchor.y) * vy;
        minU = Math.min(minU, du);
        maxU = Math.max(maxU, du);
        minV = Math.min(minV, dv);
        maxV = Math.max(maxV, dv);
      }
      const half = size.width / 2;
      // Beside it (the depth ranges overlap): flush or aligned in u.
      if (maxV > -0.5 && minV < size.depth + 0.5) {
        for (const shift of [maxU + half, minU - half, minU + half, maxU - half]) {
          if (Math.abs(shift) < bestU) {
            bestU = Math.abs(shift);
            shiftU = shift;
          }
        }
      }
      if (both && maxU > -half - 0.5 && minU < half + 0.5) {
        for (const shift of [maxV, minV - size.depth, minV, maxV - size.depth]) {
          if (Math.abs(shift) < bestV) {
            bestV = Math.abs(shift);
            shiftV = shift;
          }
        }
      }
    }
  }
  return {
    anchor: { x: snap.anchor.x + ux * shiftU + vx * shiftV, y: snap.anchor.y + uy * shiftU + vy * shiftV },
    rotation: snap.rotation,
    kind: snap.kind,
  };
}
