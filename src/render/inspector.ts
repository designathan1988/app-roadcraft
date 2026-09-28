import {
  PerspectiveCamera,
  Plane,
  type Scene,
  Vector2,
  Vector3,
  type WebGLRenderer,
} from 'three';

/**
 * THE INSPECTION CAMERA (development builds only).
 *
 * The play camera is an isometric rig clamped at a 4 m tall view, where a
 * driver is a handful of pixels: nothing about a seated pose, a mirror or a
 * wheel on a slope can be judged from it. This renders the SAME scene - the
 * frame the play camera has just prepared, so culling, instancing and the
 * shadow frustum are those of the spot being looked at - from any angle and
 * distance, at any resolution, and hands back a PNG.
 *
 * `interior` cuts the scene with two clipping planes in world space: one
 * above the seated heads (the roof), one along the camera side of a vehicle
 * (the near door), so the people inside can be seen whole.
 */
export interface InspectShot {
  /** Point looked at, world units: (x, y) on the map and `h` its height. */
  readonly x: number;
  readonly y: number;
  readonly h: number;
  /** Camera bearing round the point, radians (0 looks along +x), and height angle. */
  readonly azimuth: number;
  readonly elevation: number;
  /** Camera distance from the point, world units. */
  readonly distance: number;
  /** Vertical field of view, degrees. */
  readonly fov?: number;
  readonly width?: number;
  readonly height?: number;
  /**
   * Cut away a vehicle's roof and near side: its heading (radians), its roof
   * cut height above `h`, half its width, and its centre when the shot is
   * framed on something else (a seat).
   */
  readonly interior?: { readonly heading: number; readonly roofCut: number; readonly halfWidth: number;
    readonly cx?: number; readonly cy?: number };
}

export interface Inspector {
  shot(spec: InspectShot): string;
  dispose(): void;
}

export function createInspector(renderer: WebGLRenderer, scene: Scene): Inspector {
  const camera = new PerspectiveCamera(30, 1, 0.05, 4000);
  const roof = new Plane();
  const side = new Plane();
  const normal = new Vector3();
  const point = new Vector3();

  return {
    shot(spec) {
      const width = spec.width ?? 1600;
      const height = spec.height ?? 1000;
      // World (x, y, h) is three's (x, h, -y).
      const lookAt = new Vector3(spec.x, spec.h, -spec.y);
      const ce = Math.cos(spec.elevation);
      camera.position.set(
        spec.x + Math.cos(spec.azimuth) * ce * spec.distance,
        spec.h + Math.sin(spec.elevation) * spec.distance,
        -(spec.y + Math.sin(spec.azimuth) * ce * spec.distance),
      );
      camera.fov = spec.fov ?? 30;
      camera.aspect = width / height;
      camera.near = Math.max(0.02, spec.distance * 0.02);
      camera.updateProjectionMatrix();
      camera.lookAt(lookAt);

      const previousPlanes = renderer.clippingPlanes;
      if (spec.interior) {
        // Keep what is BELOW the roof cut.
        roof.setFromNormalAndCoplanarPoint(normal.set(0, -1, 0), point.set(0, spec.h + spec.interior.roofCut, 0));
        // Keep what is on the far side of the vehicle's camera-side flank.
        const hx = Math.cos(spec.interior.heading);
        const hy = Math.sin(spec.interior.heading);
        // The vehicle's left in world (x, y) is (-hy, hx); the camera side is
        // whichever flank faces the camera.
        const toCameraX = Math.cos(spec.azimuth);
        const toCameraY = Math.sin(spec.azimuth);
        const leftFacing = -hy * toCameraX + hx * toCameraY > 0 ? 1 : -1;
        const nx = -hy * leftFacing;
        const ny = hx * leftFacing;
        const inset = spec.interior.halfWidth * 0.55;
        side.setFromNormalAndCoplanarPoint(
          normal.set(-nx, 0, ny),
          point.set((spec.interior.cx ?? spec.x) + nx * inset, 0, -((spec.interior.cy ?? spec.y) + ny * inset)),
        );
        renderer.clippingPlanes = [roof, side];
      }
      // To the canvas itself, at the shot's size, and read straight back in
      // the same task: an offscreen target would skip the tone mapping and
      // colour conversion three applies only on screen, and the picture would
      // not be the game's.
      const size = renderer.getSize(new Vector2());
      const ratio = renderer.getPixelRatio();
      renderer.setPixelRatio(1);
      renderer.setSize(width, height, false);
      renderer.render(scene, camera);
      const url = renderer.domElement.toDataURL('image/png');
      renderer.clippingPlanes = previousPlanes;
      renderer.setPixelRatio(ratio);
      renderer.setSize(size.x, size.y, false);
      return url;
    },
    dispose() {
      /* nothing held */
    },
  };
}
