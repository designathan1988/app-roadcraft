import {
  Box3,
  Color,
  DirectionalLight,
  HemisphereLight,
  OrthographicCamera,
  Scene,
  Vector3,
  WebGLRenderTarget,
  type WebGLRenderer,
} from 'three';

import type { BlueprintBody } from '@world/buildings/blueprints';
import { type Building, asBuildingId } from '@world/buildings/types';
import { buildBuildingMeshes } from './buildingMesh';
import { createBuildingKit } from './kit';

/**
 * Pictures of buildings for the palette, rendered by the game's own renderer
 * off screen: the model a button places, drawn from the game's camera angle,
 * says more than any icon. Rendered once, when the palette first opens, into a
 * small target; the renderer's own target and clear colour are restored.
 */

/** The game camera's angle (`isoViewport.ts`): a quarter off the axes, 48 degrees up. */
const ELEVATION = (48 * Math.PI) / 180;
const AZIMUTH = Math.PI / 4;

/** Linear 0..255 to sRGB 0..255. */
const SRGB = Uint8Array.from({ length: 256 }, (_, i) => {
  const c = i / 255;
  return Math.round(255 * (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055));
});

export function renderBuildingThumbnails(
  gl: WebGLRenderer,
  bodies: readonly { readonly key: string; readonly body: BlueprintBody }[],
  size = 112,
): Map<string, string> {
  const out = new Map<string, string>();
  const kit = createBuildingKit();
  const scene = new Scene();
  scene.add(new HemisphereLight(0xdbe8f5, 0x5b604f, 1.4));
  const sun = new DirectionalLight(0xfff1dc, 2.6);
  sun.position.set(-0.6, 1, 0.9);
  scene.add(sun);
  const camera = new OrthographicCamera(-1, 1, 1, -1, 0.1, 4000);
  const target = new WebGLRenderTarget(size, size);
  const pixels = new Uint8Array(size * size * 4);
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const previousTarget = gl.getRenderTarget();
  const previousClear = gl.getClearColor(new Color());
  const previousAlpha = gl.getClearAlpha();
  gl.setClearColor(0x000000, 0);
  try {
    for (const { key, body } of bodies) {
      const building = { ...(JSON.parse(JSON.stringify(body)) as BlueprintBody), id: asBuildingId(1), x: 0, y: 0, rotation: 0 } as Building;
      const meshes = buildBuildingMeshes([building], () => 0, kit);
      scene.add(meshes.group);
      // Fit the camera to the building, from the game's angle.
      const box = new Box3().setFromObject(meshes.group);
      const centre = box.getCenter(new Vector3());
      const radius = box.getSize(new Vector3()).length() / 2;
      camera.position.set(
        centre.x + Math.cos(AZIMUTH) * Math.cos(ELEVATION) * radius * 4,
        centre.y + Math.sin(ELEVATION) * radius * 4,
        centre.z + Math.sin(AZIMUTH) * Math.cos(ELEVATION) * radius * 4,
      );
      camera.left = -radius;
      camera.right = radius;
      camera.top = radius;
      camera.bottom = -radius;
      camera.lookAt(centre);
      camera.updateProjectionMatrix();
      gl.setRenderTarget(target);
      gl.clear();
      gl.render(scene, camera);
      gl.readRenderTargetPixels(target, 0, 0, size, size, pixels);
      scene.remove(meshes.group);
      meshes.dispose();
      if (!ctx) continue;
      // Render targets are bottom-up and linear; a canvas is top-down and sRGB.
      const image = ctx.createImageData(size, size);
      for (let row = 0; row < size; row++) {
        const from = (size - 1 - row) * size * 4;
        for (let i = 0; i < size * 4; i++) {
          const v = pixels[from + i] as number;
          image.data[row * size * 4 + i] = i % 4 === 3 ? v : SRGB[v] as number;
        }
      }
      ctx.putImageData(image, 0, 0);
      out.set(key, canvas.toDataURL('image/png'));
    }
  } finally {
    gl.setRenderTarget(previousTarget);
    gl.setClearColor(previousClear, previousAlpha);
    target.dispose();
    kit.dispose();
  }
  return out;
}
