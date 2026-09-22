import { clamp } from '@core/scalar';
import type { Vec2 } from '@core/vec2';
import type { Aabb } from '@core/aabb';

export const MIN_ZOOM = 0.18;
export const MAX_ZOOM = 3.2;

/**
 * The camera is applied as a canvas transform and nothing else.
 *
 * The V6 monolith projected every point in JavaScript through `worldToScreen`
 * and hand-multiplied every stroke width and dash length by the zoom, while
 * vehicles used `ctx.translate/rotate/scale` — two conflicting conventions in
 * one renderer (defect 5.12). Here there is one: draw in world units.
 *
 * Three things fall out of that. Line widths and dash patterns are already in
 * world units, so nothing is scaled by hand. `Path2D` objects are camera
 * independent, so panning and zooming rebuild no geometry at all. And a change
 * in device pixel ratio needs no geometry rebuild either — only the matrix.
 */
export class Camera {
  /** World point at the centre of the viewport. */
  x = 0;
  y = 0;
  /** CSS pixels per world unit. */
  zoom = 1;

  /** Transform mapping world coordinates to device pixels. */
  matrix(dpr: number, cssW: number, cssH: number): DOMMatrix2DInit {
    const k = this.zoom * dpr;
    return {
      a: k,
      b: 0,
      c: 0,
      d: k,
      e: (cssW * dpr) / 2 - this.x * k,
      f: (cssH * dpr) / 2 - this.y * k,
    };
  }

  /** Screen (CSS px, canvas-relative) to world. Input handling only. */
  screenToWorld(px: number, py: number, cssW: number, cssH: number): Vec2 {
    return {
      x: (px - cssW / 2) / this.zoom + this.x,
      y: (py - cssH / 2) / this.zoom + this.y,
    };
  }

  /** World to screen (CSS px). For DOM overlays only, never for drawing. */
  worldToScreen(p: Vec2, cssW: number, cssH: number): Vec2 {
    return {
      x: (p.x - this.x) * this.zoom + cssW / 2,
      y: (p.y - this.y) * this.zoom + cssH / 2,
    };
  }

  /** Zooms about a fixed screen point, keeping the world point under it. */
  zoomAt(px: number, py: number, factor: number, cssW: number, cssH: number): void {
    const before = this.screenToWorld(px, py, cssW, cssH);
    this.zoom = clamp(this.zoom * factor, MIN_ZOOM, MAX_ZOOM);
    const after = this.screenToWorld(px, py, cssW, cssH);
    this.x += before.x - after.x;
    this.y += before.y - after.y;
  }

  /** World-space rectangle currently visible, expanded by `margin`. */
  viewBounds(cssW: number, cssH: number, margin = 0): Aabb {
    const hw = cssW / 2 / this.zoom + margin;
    const hh = cssH / 2 / this.zoom + margin;
    return {
      minX: this.x - hw,
      minY: this.y - hh,
      maxX: this.x + hw,
      maxY: this.y + hh,
    };
  }

  /** Frames a world bounds rectangle with padding. */
  fit(bounds: Aabb, cssW: number, cssH: number, pad = 1.15): void {
    const w = Math.max(1, bounds.maxX - bounds.minX) * pad;
    const h = Math.max(1, bounds.maxY - bounds.minY) * pad;
    this.x = (bounds.minX + bounds.maxX) / 2;
    this.y = (bounds.minY + bounds.maxY) / 2;
    this.zoom = clamp(Math.min(cssW / w, cssH / h), MIN_ZOOM, 1.5);
  }

  /** `n` CSS pixels expressed in world units, for hairlines and hit radii. */
  px(n: number): number {
    return n / this.zoom;
  }
}
