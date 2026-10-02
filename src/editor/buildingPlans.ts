import type { Vec2 } from '@core/vec2';
import { signedArea } from '@core/polygon';
import { inflatePaths, JoinType, EndType } from 'clipper2-ts';
import { generateBlock, type BlueprintBody } from '@world/buildings/blueprints';
import { GRID, MIN_SIZE } from '@world/buildings/geometry';
import { localFootprint, edgeFrame, validOutline, cutOutline, overlapArea, roofDetailRing, supportedBy } from '@world/buildings/footprints';
import { upperStoreyFrom } from '@world/buildings/blueprints';
import type { Building, RoofKind, Side, Volume } from '@world/buildings/types';

export type PlanShape = 'rectangle' | 'l' | 'u' | 'circle' | 'hexagon' | 'octagon' | 'chamfered' | 'cross' | 'stepped';

/** The basic shapes thrown at a building: a plan and a roof. */
export type Primitive = 'box' | 'cylinder' | 'octagonal' | 'prism' | 'wedge' | 'pyramid' | 'cone' | 'crossBlock';
export const PRIMITIVE_IDS: readonly Primitive[] = ['box', 'cylinder', 'octagonal', 'prism', 'wedge', 'pyramid', 'cone', 'crossBlock'];
export const PRIMITIVES: Readonly<Record<Primitive, { readonly shape: PlanShape; readonly roof: RoofKind; readonly pitch: number }>> = {
  box: { shape: 'rectangle', roof: 'flat', pitch: 0 },
  cylinder: { shape: 'circle', roof: 'flat', pitch: 0 },
  octagonal: { shape: 'octagon', roof: 'flat', pitch: 0 },
  prism: { shape: 'rectangle', roof: 'gable', pitch: 35 },
  wedge: { shape: 'rectangle', roof: 'shed', pitch: 25 },
  pyramid: { shape: 'rectangle', roof: 'hip', pitch: 45 },
  cone: { shape: 'circle', roof: 'hip', pitch: 55 },
  crossBlock: { shape: 'cross', roof: 'flat', pitch: 0 },
};

/** Editable polygon starters. Curved forms are deliberately explicit vertices. */
export function shapePoints(shape: PlanShape): Vec2[] {
  const points = (a: number[][]): Vec2[] => a.map(([x, y]) => ({ x: x!, y: y! }));
  if (shape === 'rectangle') return points([[0, 0], [1, 0], [1, 1], [0, 1]]);
  if (shape === 'l') return points([[0, 0], [1, 0], [1, .4], [.4, .4], [.4, 1], [0, 1]]);
  if (shape === 'u') return points([[0, 0], [1, 0], [1, 1], [.7, 1], [.7, .3], [.3, .3], [.3, 1], [0, 1]]);
  // A cross: four arms of the middle third.
  if (shape === 'cross') return points([[.3, 0], [.7, 0], [.7, .3], [1, .3], [1, .7], [.7, .7], [.7, 1], [.3, 1], [.3, .7], [0, .7], [0, .3], [.3, .3]]);
  // A ziggurat plan: every corner set back in two steps, as an Art Deco tower
  // steps (the Altino Arantes, the Empire State).
  if (shape === 'stepped') return points([[.3, 0], [.7, 0], [.7, .12], [.85, .12], [.85, .3], [1, .3], [1, .7], [.85, .7], [.85, .88], [.7, .88],
    [.7, 1], [.3, 1], [.3, .88], [.15, .88], [.15, .7], [0, .7], [0, .3], [.15, .3], [.15, .12], [.3, .12]]);
  if (shape === 'chamfered') return points([[.12, 0], [.88, 0], [1, .12], [1, .88], [.88, 1], [.12, 1], [0, .88], [0, .12]]);
  const count = shape === 'circle' ? 24 : shape === 'hexagon' ? 6 : 8;
  return Array.from({ length: count }, (_, i) => {
    const a = i * Math.PI * 2 / count - Math.PI / 2;
    return { x: .5 + .5 * Math.cos(a), y: .5 + .5 * Math.sin(a) };
  });
}

export function detectPlanShape(volume: Volume): PlanShape | null {
  if (!volume.outline) return 'rectangle';
  for (const shape of ['rectangle', 'chamfered', 'octagon', 'circle', 'hexagon', 'l', 'u', 'cross', 'stepped'] as const) {
    const expected = shapePoints(shape);
    if (volume.outline.length === expected.length && volume.outline.every((p, i) =>
      Math.hypot(p.x - expected[i]!.x, p.y - expected[i]!.y) < 1e-4)) return shape;
  }
  return null;
}

/** Store a ring in a volume's bounding frame. Existing edge overrides stay indexed. */
export function setVolumePlan(v: Volume, input: readonly Vec2[]): boolean {
  if (input.length < 3 || input.length > 64 || !input.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))) return false;
  const minX = Math.min(...input.map((p) => p.x));
  const minY = Math.min(...input.map((p) => p.y));
  const w = Math.max(...input.map((p) => p.x)) - minX;
  const d = Math.max(...input.map((p) => p.y)) - minY;
  if (w < MIN_SIZE || d < MIN_SIZE) return false;
  const ring = signedArea(input) < 0 ? [...input].reverse() : [...input];
  const outline = ring.map((p) => ({ x: (p.x - minX) / w, y: (p.y - minY) / d }));
  if (!validOutline(outline)) return false;
  Object.assign(v, { x: minX, y: minY, w, d, outline });
  return true;
}

export function shapeBody(shape: PlanShape, width: number, depth: number, floors: number): BlueprintBody {
  const body = generateBlock(width, depth, floors);
  const v = body.volumes[0]!;
  if (shape !== 'rectangle') v.outline = shapePoints(shape);
  return body;
}

export function movePlanVertex(b: Building, volume: number, index: number, point: Vec2, snap = true): boolean {
  const v = b.volumes.find((v) => v.id === volume);
  if (!v) return false;
  const ring = localFootprint(v);
  if (!ring[index]) return false;
  ring[index] = snap ? { x: Math.round(point.x / GRID) * GRID, y: Math.round(point.y / GRID) * GRID } : point;
  if (signedArea(ring) <= 0) return false;
  return setVolumePlan(v, ring);
}

export function movePlanEdge(v: Volume, side: number, delta: number, snap = true): boolean {
  const ring = localFootprint(v);
  const frame = edgeFrame(v, side);
  const distance = snap ? Math.round(delta / GRID) * GRID : delta;
  const next = (side + 1) % ring.length;
  for (const index of [side, next]) {
    const p = ring[index];
    if (!p) return false;
    ring[index] = { x: p.x + frame.nx * distance, y: p.y + frame.ny * distance };
  }
  if (signedArea(ring) <= 0) return false;
  return setVolumePlan(v, ring);
}

/**
 * Bevels corners of a plan: each corner becomes two, `distance` back along
 * its two sides (never past half a side). `only` bevels that corner alone;
 * absent, every corner is bevelled.
 */
export function bevelPlan(v: Volume, distance: number, only?: number): boolean {
  if (!(distance > 0)) return false;
  const ring = localFootprint(v);
  const out: Vec2[] = [];
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i]!;
    if (only !== undefined && only !== i) {
      out.push(p);
      continue;
    }
    const prev = ring[(i + ring.length - 1) % ring.length]!;
    const next = ring[(i + 1) % ring.length]!;
    const toPrev = Math.hypot(prev.x - p.x, prev.y - p.y);
    const toNext = Math.hypot(next.x - p.x, next.y - p.y);
    const a = Math.min(distance, toPrev / 2 - 1e-3);
    const c = Math.min(distance, toNext / 2 - 1e-3);
    if (a <= 0 || c <= 0) {
      out.push(p);
      continue;
    }
    out.push({ x: p.x + ((prev.x - p.x) / toPrev) * a, y: p.y + ((prev.y - p.y) / toPrev) * a });
    out.push({ x: p.x + ((next.x - p.x) / toNext) * c, y: p.y + ((next.y - p.y) / toNext) * c });
  }
  if (out.length > 64 || out.length === ring.length) return false;
  const ok = setVolumePlan(v, out);
  if (ok) {
    delete v.reliefs;
    delete v.facadeGeometry;
    for (const storey of v.storeys) {
      delete storey.facade.bays;
      delete storey.facade.sides;
    }
  }
  return ok;
}

/** Offsets the selected volume's whole plan; preserves edge identities. */
export function offsetPlan(v: Volume, distance: number, snap = true): boolean {
  if (!Number.isFinite(distance)) return false;
  const amount = snap ? Math.round(distance / GRID) * GRID : distance;
  if (Math.abs(amount) < 1e-6) return true;
  if (!v.outline) {
    if (v.w + 2 * amount < MIN_SIZE || v.d + 2 * amount < MIN_SIZE) return false;
    v.x -= amount; v.y -= amount; v.w += 2 * amount; v.d += 2 * amount;
    return true;
  }
  const source = localFootprint(v);
  const scale = 10_000;
  const paths = inflatePaths([source.map((p) => ({ x: Math.round(p.x * scale), y: Math.round(p.y * scale) }))],
    amount * scale, JoinType.Miter, EndType.Polygon);
  // A split, vanished contour, or new corner needs a topology edit that can
  // remap facade sides. Reject it here rather than silently moving materials.
  if (paths.length !== 1 || paths[0]?.length !== source.length) return false;
  let points = paths[0]!.map((p) => ({ x: p.x / scale, y: p.y / scale }));
  if (signedArea(points) < 0) points = points.reverse();
  let start = 0;
  let nearest = Infinity;
  for (let i = 0; i < points.length; i++) {
    const d = Math.hypot(points[i]!.x - source[0]!.x, points[i]!.y - source[0]!.y);
    if (d < nearest) { nearest = d; start = i; }
  }
  points = [...points.slice(start), ...points.slice(0, start)];
  return setVolumePlan(v, points);
}

/** Inserting/deleting a vertex invalidates edge-specific decorations. */
export function changePlanVertex(b: Building, volume: number, index: number, remove: boolean): boolean {
  const v = b.volumes.find((v) => v.id === volume);
  if (!v) return false;
  const ring = localFootprint(v);
  const old = ring.length;
  if (remove) {
    if (ring.length <= 3) return false;
    ring.splice(index, 1);
  } else {
    const p = ring[index], q = ring[(index + 1) % ring.length];
    if (!p || !q || ring.length >= 64) return false;
    ring.splice(index + 1, 0, { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 });
  }
  if (!setVolumePlan(v, ring)) return false;
  const remap = (side: number): number[] => {
    if (remove) return side === index ? [] : [side > index ? side - 1 : side];
    return side === index ? [side, side + 1] : [side > index ? side + 1 : side];
  };
  const remapSides = <T>(sides: Partial<Record<Side, T>> | undefined): Partial<Record<Side, T>> | undefined => {
    if (!sides) return undefined;
    const next: Partial<Record<Side, T>> = {};
    for (const [key, value] of Object.entries(sides)) {
      const side = Number(key);
      if (side < 0 || side >= old) continue;
      for (const to of remap(side)) next[to as Side] = value;
    }
    return Object.keys(next).length > 0 ? next : undefined;
  };
  for (const storey of v.storeys) {
    const facade = storey.facade;
    const sides = remapSides(facade.sides);
    if (sides) facade.sides = sides;
    else delete facade.sides;
    const patterns = remapSides(facade.patterns);
    if (patterns) facade.patterns = patterns;
    else delete facade.patterns;
    if (facade.bays) {
      const next: Record<string, typeof facade.fill> = {};
      for (const [key, component] of Object.entries(facade.bays)) {
        const [side, bay] = key.split(':').map(Number);
        if (side === undefined || bay === undefined || side < 0 || side >= old) continue;
        for (const to of remap(side)) next[`${to}:${bay}`] = component;
      }
      if (Object.keys(next).length > 0) facade.bays = next;
      else delete facade.bays;
    }
  }
  if (v.materials) {
    const sides = remapSides(v.materials.sides);
    if (sides) v.materials.sides = sides;
    else delete v.materials.sides;
  }
  if (v.facadeGeometry) {
    const sides = remapSides(v.facadeGeometry);
    if (sides) v.facadeGeometry = sides;
    else delete v.facadeGeometry;
  }
  if (v.reliefs) v.reliefs = v.reliefs.flatMap((relief) => remap(relief.side).map((side) => ({ ...relief, side: side as Side })));
  return true;
}

/** Adds a mass to the same building at ground or on an existing roof. */
export function addPlanMass(b: Building, sourceId: number, points: readonly Vec2[], base: number, floors: number): number | null {
  const source = b.volumes.find((v) => v.id === sourceId);
  if (!source || floors < 1) return null;
  const template = base === 0 ? source.storeys[0] : upperStoreyFrom(source.storeys[source.storeys.length - 1]!);
  if (!template) return null;
  const id = b.nextVolumeId;
  const volume: Volume = {
    id, x: 0, y: 0, w: 1, d: 1, base,
    roof: base === 0 ? source.roof : 'flat',
    storeys: Array.from({ length: floors }, () => structuredClone(template)),
  };
  if (!setVolumePlan(volume, points)) return null;
  if (source.materials) volume.materials = structuredClone(source.materials);
  if (source.facadePattern) volume.facadePattern = source.facadePattern;
  b.volumes.push(volume);
  b.nextVolumeId = id + 1;
  if (base > 0) {
    source.roof = 'terrace';
    if (source.roofDetails) source.roofDetails = source.roofDetails.filter((part) =>
      overlapArea(roofDetailRing(part), localFootprint(volume)) < 1e-5);
  }
  return id;
}

/** Creates an editable shaped volume on a roof. Values are world units. */
export interface UpperMassPlacement { width?: number; depth?: number; offsetX?: number; offsetY?: number }
export function addShapedUpperMass(b: Building, sourceId: number, shape: PlanShape | 'match', inset: number, floors: number,
  placement: UpperMassPlacement = {}): number | null {
  const source = b.volumes.find((v) => v.id === sourceId);
  if (!source || !Number.isFinite(inset) || inset < 0) return null;
  const width = placement.width ?? source.w - 2 * inset, depth = placement.depth ?? source.d - 2 * inset;
  const shiftX = placement.offsetX ?? 0, shiftY = placement.offsetY ?? 0;
  if (![width, depth, shiftX, shiftY].every(Number.isFinite) || width < MIN_SIZE || depth < MIN_SIZE) return null;
  const cx = source.x + source.w / 2 + shiftX, cy = source.y + source.d / 2 + shiftY;
  const normalized = shape === 'match' ? source.outline ?? shapePoints('rectangle') : shapePoints(shape);
  const atScale = (scale: number): Vec2[] => normalized.map((p) => ({
    x: cx + (p.x - .5) * width * scale, y: cy + (p.y - .5) * depth * scale,
  }));
  const support = localFootprint(source);
  let points = atScale(1);
  if (!supportedBy(points, [support])) {
    let low = 0, high = 1;
    for (let i = 0; i < 18; i++) {
      const mid = (low + high) / 2;
      if (supportedBy(atScale(mid), [support])) low = mid;
      else high = mid;
    }
    points = atScale(low * .997);
  }
  return addPlanMass(b, sourceId, points, source.base + source.storeys.length, floors);
}

/** Removes a polygon from the selected mass, keeping one simple boundary. */
export function cutPlanMass(b: Building, volumeId: number, points: readonly Vec2[]): boolean {
  const volume = b.volumes.find((v) => v.id === volumeId);
  if (!volume) return false;
  const cut = cutOutline(localFootprint(volume), points);
  return cut !== null && setVolumePlan(volume, cut);
}
