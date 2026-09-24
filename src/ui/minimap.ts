import type { Vec2 } from '@core/vec2';
import type { Aabb } from '@core/aabb';
import type { RoadDoc } from '@world/doc';
import type { Network, SegmentRibbon } from '@world/network';
import type { SimWorld } from '@sim/world';
import type { Camera } from '@view/camera';
import type { CanvasSurface } from '@ui/overlay/surface';
import { SELECTION, TERRAIN_SHADE } from '@ui/overlay/palette';

/**
 * Minimap.
 *
 * Scaled to the device pixel ratio, unlike the V6 monolith's, which declared a
 * fixed 404x232 backing store and let CSS stretch it — so it was permanently
 * blurry. The transform used for the last visible frame is retained per canvas
 * so pointer input always maps through exactly what the user can see.
 */
interface MinimapTransform {
  readonly scale: number;
  readonly ox: number;
  readonly oy: number;
}

const transforms = new WeakMap<HTMLCanvasElement, MinimapTransform>();

interface DocumentBoundsCache {
  readonly revision: number;
  readonly bounds: Aabb | null;
}

interface RoadOrderCache {
  readonly revision: number;
  readonly order: readonly SegmentRibbon[];
}

const documentBoundsCache = new WeakMap<RoadDoc, DocumentBoundsCache>();
const roadOrderCache = new WeakMap<Network, RoadOrderCache>();

export function drawMinimap(
  canvas: HTMLCanvasElement,
  doc: RoadDoc,
  net: Network,
  sim: SimWorld,
  camera: Camera,
  surface: CanvasSurface,
): void {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const rect = canvas.getBoundingClientRect();
  // A folded minimap panel has no box. Sweeping every lanelet ten times a
  // second for a canvas nobody can see is the whole cost of this function.
  if (rect.width === 0 || rect.height === 0) return;
  const w = Math.max(1, Math.round(rect.width * dpr));
  const h = Math.max(1, Math.round(rect.height * dpr));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }

  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const bounds = worldBounds(doc, camera);
  const scale = Math.min(w / spanX(bounds), h / spanY(bounds));
  const ox = w / 2 - ((bounds.minX + bounds.maxX) / 2) * scale;
  const oy = h / 2 - ((bounds.minY + bounds.maxY) / 2) * scale;
  transforms.set(canvas, { scale, ox, oy });

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = TERRAIN_SHADE;
  ctx.fillRect(0, 0, w, h);
  ctx.setTransform(scale, 0, 0, scale, ox, oy);

  // Roads, widest class first so narrow ones stay visible on top.
  const order = orderedRibbons(net);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const saturation = new Map<number, { vehicles: number; capacity: number }>();
  for (const lane of sim.graph?.lanelets?.values?.() ?? []) {
    if (lane.kind !== 'link' || lane.segment === undefined) continue;
    const entry = saturation.get(lane.segment) ?? { vehicles: 0, capacity: 0 };
    entry.vehicles += sim.rt(lane.id).order.length;
    entry.capacity += Math.max(1, lane.length / 12);
    saturation.set(lane.segment, entry);
  }
  for (const ribbon of order) {
    const rt = ribbon.road;
    const pts = ribbon.full.toPoints();
    if (pts.length < 2) continue;
    ctx.strokeStyle = rt.color;
    ctx.lineWidth = Math.max(rt.width * 0.7, 2 / scale);
    ctx.beginPath();
    ctx.moveTo((pts[0] as Vec2).x, (pts[0] as Vec2).y);
    for (let i = 1; i < pts.length; i++) {
      const p = pts[i] as Vec2;
      ctx.lineTo(p.x, p.y);
    }
    ctx.stroke();

    const load = saturation.get(ribbon.id);
    if (!load || load.vehicles === 0) continue;
    const ratio = Math.min(1, load.vehicles / load.capacity);
    const hue = Math.round((1 - ratio) * 120);
    ctx.strokeStyle = `hsla(${hue}, 92%, 58%, ${0.45 + ratio * 0.4})`;
    ctx.lineWidth = Math.max(rt.width * 0.3, 1.5 / scale);
    ctx.stroke();
  }

  // Agents, as small dots.
  ctx.fillStyle = '#f4f7f4';
  const dot = Math.max(2.5, 3 / scale);
  for (const v of sim.vehicles.values()) {
    const lane = sim.lanelet(v.lanelet);
    if (!lane) continue;
    const p = lane.centre.sampleAt(v.s).p;
    ctx.fillRect(p.x - dot / 2, p.y - dot / 2, dot, dot);
  }

  // Viewport rectangle.
  const view = camera.viewBounds(surface.cssW, surface.cssH);
  ctx.strokeStyle = SELECTION;
  ctx.lineWidth = Math.max(1.5 / scale, 1);
  ctx.strokeRect(view.minX, view.minY, spanX(view), spanY(view));
}

/** Converts a click on the minimap back to a world position. */
export function minimapToWorld(
  canvas: HTMLCanvasElement,
  doc: RoadDoc,
  camera: Camera,
  clientX: number,
  clientY: number,
): Vec2 | null {
  const rect = canvas.getBoundingClientRect();
  if (rect.width < 1 || rect.height < 1) return null;
  const transform = transforms.get(canvas);
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.max(1, canvas.width || Math.round(rect.width * dpr));
  const h = Math.max(1, canvas.height || Math.round(rect.height * dpr));
  const fallbackBounds = worldBounds(doc, camera);
  const scale = transform?.scale ?? Math.min(w / spanX(fallbackBounds), h / spanY(fallbackBounds));
  const ox = transform?.ox ?? w / 2 - ((fallbackBounds.minX + fallbackBounds.maxX) / 2) * scale;
  const oy = transform?.oy ?? h / 2 - ((fallbackBounds.minY + fallbackBounds.maxY) / 2) * scale;

  const px = (clientX - rect.left) * dpr;
  const py = (clientY - rect.top) * dpr;
  return { x: (px - ox) / scale, y: (py - oy) / scale };
}

const spanX = (b: Aabb): number => Math.max(1, b.maxX - b.minX);
const spanY = (b: Aabb): number => Math.max(1, b.maxY - b.minY);

function worldBounds(doc: RoadDoc, camera: Camera | null): Aabb {
  const documentBounds = boundsOfDocument(doc);
  if (!documentBounds) {
    const cx = camera?.x ?? 0;
    const cy = camera?.y ?? 0;
    return { minX: cx - 300, minY: cy - 300, maxX: cx + 300, maxY: cy + 300 };
  }

  let minX = documentBounds.minX;
  let minY = documentBounds.minY;
  let maxX = documentBounds.maxX;
  let maxY = documentBounds.maxY;
  // Always keep the camera in view, and pad a little.
  if (camera) {
    minX = Math.min(minX, camera.x);
    maxX = Math.max(maxX, camera.x);
    minY = Math.min(minY, camera.y);
    maxY = Math.max(maxY, camera.y);
  }
  const padX = Math.max(40, (maxX - minX) * 0.08);
  const padY = Math.max(40, (maxY - minY) * 0.08);
  return { minX: minX - padX, minY: minY - padY, maxX: maxX + padX, maxY: maxY + padY };
}

/** Static document extent, rebuilt only after an authoring mutation. */
function boundsOfDocument(doc: RoadDoc): Aabb | null {
  const cached = documentBoundsCache.get(doc);
  if (cached?.revision === doc.revision) return cached.bounds;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const n of doc.nodes.values()) {
    minX = Math.min(minX, n.x);
    minY = Math.min(minY, n.y);
    maxX = Math.max(maxX, n.x);
    maxY = Math.max(maxY, n.y);
  }
  const bounds = Number.isFinite(minX) ? { minX, minY, maxX, maxY } : null;
  documentBoundsCache.set(doc, { revision: doc.revision, bounds });
  return bounds;
}

/** Draw order changes only when network geometry changes, never per tick. */
function orderedRibbons(net: Network): readonly SegmentRibbon[] {
  const cached = roadOrderCache.get(net);
  if (cached?.revision === net.revision) return cached.order;
  const order = [...net.ribbons.values()].sort((a, b) => b.road.width - a.road.width);
  roadOrderCache.set(net, { revision: net.revision, order });
  return order;
}
