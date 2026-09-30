import type { PlanShapeId } from './builder/catalog';

/**
 * The footprint a shape tool draws, as a picture: the outline filled, on a
 * grid, seen from above - which is exactly how the player draws it.
 *
 * The shape tools have no object to photograph until one is drawn, so this is
 * drawn rather than rendered: the same polygons the plan decomposer works
 * from, in plan.
 */

/** Outline points per shape, in a 0..1 box. */
const OUTLINES: Readonly<Record<PlanShapeId, readonly (readonly [number, number])[]>> = {
  rectangle: [[0.08, 0.2], [0.92, 0.2], [0.92, 0.8], [0.08, 0.8]],
  l: [[0.08, 0.14], [0.5, 0.14], [0.5, 0.5], [0.92, 0.5], [0.92, 0.86], [0.08, 0.86]],
  u: [
    [0.08, 0.14], [0.32, 0.14], [0.32, 0.6], [0.68, 0.6], [0.68, 0.14], [0.92, 0.14],
    [0.92, 0.86], [0.08, 0.86],
  ],
  circle: Array.from({ length: 28 }, (_, i) => {
    const a = (i / 28) * Math.PI * 2;
    return [0.5 + Math.cos(a) * 0.42, 0.5 + Math.sin(a) * 0.34] as const;
  }),
  hexagon: [[0.5, 0.1], [0.88, 0.3], [0.88, 0.7], [0.5, 0.9], [0.12, 0.7], [0.12, 0.3]],
  octagon: [
    [0.32, 0.1], [0.68, 0.1], [0.9, 0.32], [0.9, 0.68], [0.68, 0.9], [0.32, 0.9], [0.1, 0.68], [0.1, 0.32],
  ],
  chamfered: [[0.08, 0.16], [0.6, 0.16], [0.92, 0.5], [0.92, 0.84], [0.08, 0.84]],
};

/**
 * Drawn once per shape and size. These are asked for on every redraw of the
 * tray, and a canvas drawn and encoded to PNG is far too expensive to repeat:
 * it was the whole game's frame budget, sixty times a second.
 */
const CACHE = new Map<string, string>();

export function planSwatch(shape: PlanShapeId, width = 148, height = 78, dpr = 2): string {
  const key = `${shape}|${width}x${height}@${dpr}`;
  const cached = CACHE.get(key);
  if (cached !== undefined) return cached;
  const canvas = document.createElement('canvas');
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';
  ctx.scale(dpr, dpr);

  const grass = ctx.createLinearGradient(0, 0, 0, height);
  grass.addColorStop(0, '#4c6b3d');
  grass.addColorStop(1, '#3a5432');
  ctx.fillStyle = grass;
  ctx.fillRect(0, 0, width, height);

  // A grid, so the picture says "seen from above".
  ctx.strokeStyle = 'rgba(255,255,255,0.09)';
  ctx.lineWidth = 1;
  for (let x = 0; x <= width; x += 12) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();
  }
  for (let y = 0; y <= height; y += 12) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
  }

  const points = OUTLINES[shape];
  ctx.beginPath();
  points.forEach(([x, y], i) => {
    const px = x * width;
    const py = y * height;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  });
  ctx.closePath();
  ctx.fillStyle = 'rgba(226,232,228,0.86)';
  ctx.fill();
  ctx.strokeStyle = '#7ee0b8';
  ctx.lineWidth = 2;
  ctx.stroke();

  const url = canvas.toDataURL('image/png');
  CACHE.set(key, url);
  return url;
}
