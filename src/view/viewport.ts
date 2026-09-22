import type { Vec2 } from '@core/vec2';
import { MAX_ZOOM, MIN_ZOOM, type Camera } from '@ui/overlay/camera';

/** Which of the four quarter turns the view is at. Zero for a top-down view. */
export type Facing = 0 | 1 | 2 | 3;

/**
 * What the input layer needs from a view, and nothing else.
 *
 * The editor already works entirely in world coordinates — `findAnchor`,
 * `snapEndpoint` and every command take a world point — so switching renderers
 * is a matter of switching ONE conversion. This is the seam that makes that
 * true, and keeping it this narrow is why `src/editor` needs no change at all.
 *
 * Pan is expressed as "the ground point under the pointer when the drag began
 * should still be under it now" rather than as a screen delta over the zoom.
 * The two are identical in a top-down view and only the first survives a tilt,
 * so the flat renderer uses the general form as well: one rule, tested once.
 */
export interface Viewport {
  readonly kind: '2d' | 'iso';
  /** Ground point under a pointer, in world units, on the `y = 0` plane. */
  toWorld(px: number, py: number, cssW: number, cssH: number): Vec2;
  /**
   * The same, but on a horizontal plane at `height`.
   *
   * A tilted view projects a raised surface AWAY from the point under it: a
   * deck fifteen units up lands about thirteen units off on the ground plane, so
   * pointing at the visible end of an elevated road picked a spot that far away
   * from the node actually drawn there — and no amount of widening the snap
   * radius fixes that, because the error grows with the height.
   *
   * Everything that turns a pointer into a world position solves for the right
   * plane instead (`pointerWorld` in `main.ts`): the hill you are painting, the
   * deck you are connecting to, the road you are demolishing.
   */
  toWorldAt(px: number, py: number, height: number, cssW: number, cssH: number): Vec2;
  /**
   * Where a ground point lands on screen, in CSS pixels. The inverse of
   * `toWorld`, and the reason it exists is the editor's own feedback.
   *
   * Every hint the editor gives — the road being dragged, the snap markers, the
   * selection outline, the hovered segment — is drawn in world units onto a 2D
   * overlay. Under the flat renderer the canvas transform placed them for free.
   * Under an isometric one there is no such transform, so the overlay was left
   * unpainted and the editor gave NO visual feedback whatsoever: a player could
   * drag out a road and see nothing until they let go.
   */
  toScreen(p: Vec2, cssW: number, cssH: number, height?: number): Vec2;
  /** Moves the view so `grabbed` sits under the pointer again. */
  panTo(grabbed: Vec2, px: number, py: number, cssW: number, cssH: number): void;
  /** Zooms about a pointer, keeping the ground under it. */
  zoomAt(px: number, py: number, factor: number, cssW: number, cssH: number): void;
  /** Turns the view. A no-op where there is nothing to turn. */
  rotate(quarterTurns: number, px: number, py: number, cssW: number, cssH: number): void;
  /**
   * World point at the centre of the view, and the only way to move it there.
   *
   * Every other way of centring the view — the arrow keys, a tap on the
   * minimap, a two-finger pinch — used to write straight to the flat camera's
   * `x`/`y`. Under the isometric renderer nothing reads those, so all three
   * were silently dead while the right-drag pan and the wheel, which go through
   * this seam, worked. The two disagreed, and the coordinate readout showed the
   * flat camera's frozen position while the picture moved.
   */
  readonly centre: Vec2;
  moveTo(p: Vec2): void;
  readonly zoom: number;
  readonly facing: Facing;
  /**
   * Inclusive zoom range this viewport can actually represent.
   *
   * Restoring a saved session clamps to it. The two renderers have genuinely
   * different ranges — the flat camera 0.18–3.2, the iso rig roughly 0.42–7.3
   * at an 800 px viewport — so clamping a 3D zoom against the flat bounds
   * silently discarded a value the app itself had produced, snapping every
   * reload of a zoomed-in session back to 320%.
   */
  readonly zoomBounds: { readonly min: number; readonly max: number };
}

/** The existing flat camera, behind the same seam. */
export function flatViewport(camera: Camera): Viewport {
  return {
    kind: '2d',
    toWorld: (px, py, cssW, cssH) => camera.screenToWorld(px, py, cssW, cssH),
    // A top-down view has no parallax: height moves nothing sideways.
    toWorldAt: (px, py, _height, cssW, cssH) => camera.screenToWorld(px, py, cssW, cssH),
    toScreen: (p, cssW, cssH) => camera.worldToScreen(p, cssW, cssH),
    panTo(grabbed, px, py, cssW, cssH) {
      const now = camera.screenToWorld(px, py, cssW, cssH);
      camera.x += grabbed.x - now.x;
      camera.y += grabbed.y - now.y;
    },
    zoomAt(px, py, factor, cssW, cssH) {
      camera.zoomAt(px, py, factor, cssW, cssH);
    },
    rotate() {
      // A top-down view has one orientation. Offering three that do nothing
      // would be worse than not offering them.
    },
    get centre() {
      return { x: camera.x, y: camera.y };
    },
    moveTo(p) {
      camera.x = p.x;
      camera.y = p.y;
    },
    get zoom() {
      return camera.zoom;
    },
    get facing() {
      return 0 as Facing;
    },
    get zoomBounds() {
      return { min: MIN_ZOOM, max: MAX_ZOOM };
    },
  };
}
