import {
  OrthographicCamera,
  Plane,
  Raycaster,
  Vector2,
  Vector3,
} from 'three';

import type { Vec2 } from '@core/vec2';
import type { Facing, Viewport } from '@view/viewport';

export const MIN_HALF_HEIGHT = 55;
export const MAX_HALF_HEIGHT = 950;

/**
 * The zoom range the iso rig can represent at a given viewport height.
 *
 * `zoom` is `height / (halfHeight * 2)` and `halfHeight` is clamped to
 * [MIN_HALF_HEIGHT, MAX_HALF_HEIGHT], so this is the rig's own range and NOT the
 * flat camera's `MIN_ZOOM`/`MAX_ZOOM`. Restoring a session clamps against it, so
 * a zoom the rig produced (up to ~7.3 at 800 px tall) is never rejected by a
 * narrower fallback range. One definition, used by the rig's `zoomBounds` and by
 * the boot-time clamp before the rig exists.
 */
export function isoZoomBounds(height: number): { min: number; max: number } {
  return { min: height / (MAX_HALF_HEIGHT * 2), max: height / (MIN_HALF_HEIGHT * 2) };
}

const ELEVATION = (48 * Math.PI) / 180;
const AZIMUTH = Math.PI / 4;
const DISTANCE = 2400;

export interface IsoRig {
  readonly camera: OrthographicCamera;
  readonly viewport: Viewport;
  readonly target: Vector3;
  resize(width: number, height: number): void;
}

export function createIsoRig(initial: Vec2, initialHalfHeight: number): IsoRig {
  const camera = new OrthographicCamera(-1, 1, 1, -1, 1, 7000);
  const target = new Vector3(initial.x, 0, -initial.y);
  const raycaster = new Raycaster();
  const ground = new Plane(new Vector3(0, 1, 0), 0);
  const hit = new Vector3();
  const ndc = new Vector2();

  let width = 1;
  let height = 1;
  let halfHeight = Math.min(MAX_HALF_HEIGHT, Math.max(MIN_HALF_HEIGHT, initialHalfHeight));
  let facing = 0;

  const apply = (): void => {
    const aspect = Math.max(0.1, width / Math.max(1, height));
    camera.left = -halfHeight * aspect;
    camera.right = halfHeight * aspect;
    camera.top = halfHeight;
    camera.bottom = -halfHeight;

    const azimuth = AZIMUTH + facing * Math.PI * 0.5;
    const horizontal = Math.cos(ELEVATION) * DISTANCE;
    camera.position.set(
      target.x + Math.cos(azimuth) * horizontal,
      Math.sin(ELEVATION) * DISTANCE,
      target.z + Math.sin(azimuth) * horizontal,
    );
    camera.lookAt(target);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld(true);
  };

  /**
   * The point under a pointer, on the horizontal plane at `atHeight`.
   *
   * Height is not cosmetic here. The camera looks down at 48 degrees, so a
   * surface fifteen units up projects about thirteen units away from the ground
   * point beneath it. Solving on the wrong plane is why pointing at the end of
   * an elevated road picked open ground thirteen units away and the snap never
   * found the node that was plainly drawn there.
   */
  const worldAt = (px: number, py: number, atHeight = 0): Vec2 => {
    ndc.set((px / Math.max(1, width)) * 2 - 1, 1 - (py / Math.max(1, height)) * 2);
    raycaster.setFromCamera(ndc, camera);
    ground.constant = -atHeight;
    const ok = raycaster.ray.intersectPlane(ground, hit);
    ground.constant = 0;
    if (!ok) return { x: target.x, y: -target.z };
    return { x: hit.x, y: -hit.z };
  };

  const viewport: Viewport = {
    kind: 'iso',
    toWorld: (px, py) => worldAt(px, py),
    toWorldAt: (px, py, atHeight) => worldAt(px, py, atHeight),
    toScreen(p, cssW, cssH, atHeight = 0) {
      const projected = new Vector3(p.x, atHeight, -p.y).project(camera);
      return {
        x: (projected.x * 0.5 + 0.5) * cssW,
        y: (-projected.y * 0.5 + 0.5) * cssH,
      };
    },
    panTo(grabbed, px, py) {
      const now = worldAt(px, py);
      target.x += grabbed.x - now.x;
      target.z -= grabbed.y - now.y;
      apply();
    },
    zoomAt(px, py, factor) {
      const before = worldAt(px, py);
      halfHeight = Math.min(MAX_HALF_HEIGHT, Math.max(MIN_HALF_HEIGHT, halfHeight / factor));
      apply();
      const after = worldAt(px, py);
      target.x += before.x - after.x;
      target.z -= before.y - after.y;
      apply();
    },
    rotate(quarterTurns, px, py) {
      const before = worldAt(px, py);
      facing = ((facing + quarterTurns) % 4 + 4) % 4;
      apply();
      const after = worldAt(px, py);
      target.x += before.x - after.x;
      target.z -= before.y - after.y;
      apply();
    },
    get centre() {
      return { x: target.x, y: -target.z };
    },
    moveTo(p) {
      target.set(p.x, 0, -p.y);
      apply();
    },
    get zoom() {
      return height / Math.max(1, halfHeight * 2);
    },
    get facing() {
      return facing as Facing;
    },
    get zoomBounds() {
      return isoZoomBounds(height);
    },
  };

  apply();
  return {
    camera,
    viewport,
    target,
    resize(nextWidth, nextHeight) {
      width = Math.max(1, nextWidth);
      height = Math.max(1, nextHeight);
      apply();
    },
  };
}
