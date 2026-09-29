import { AmbientLight, DirectionalLight, PerspectiveCamera, Scene, WebGLRenderer } from 'three';

import { type Blueprint, instantiate } from '@world/buildings/blueprints';
import { buildingBounds, buildingHeight } from '@world/buildings/geometry';
import type { Building } from '@world/buildings/types';
import { m } from '@world/units';
import { buildBuildingMeshes } from './buildingMesh';
import { type BuildingKit, createBuildingKit } from './kit';

/**
 * Pictures of the models, for the gallery: each preset is built by the game's
 * own mesh builder and photographed from the game camera's angle, off screen,
 * once - so what the player clicks is what they get, and a gallery costs one
 * canvas instead of a hundred fonts of iconography.
 *
 * Everything is created on the fly and disposed at the end: this runs once,
 * after the Builder is first opened, and never inside a frame.
 */
const SIZE = 256;

export function renderBuildingThumbnails(
  gl: WebGLRenderer,
  blueprints: readonly Blueprint[],
): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  let canvas: HTMLCanvasElement | null = null;
  let renderer: WebGLRenderer | null = null;
  let kit: BuildingKit | null = null;
  try {
    // A small second context, sharing the same GPU: the game's own renderer
    // keeps its state, and nothing here touches the visible frame.
    canvas = document.createElement('canvas');
    canvas.width = SIZE;
    canvas.height = SIZE;
    renderer = new WebGLRenderer({ canvas, alpha: true, antialias: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(1);
    renderer.setSize(SIZE, SIZE, false);
    renderer.setClearColor(0x000000, 0);
    void gl;
    kit = createBuildingKit();

    const scene = new Scene();
    scene.add(new AmbientLight(0xffffff, 1.15));
    const sun = new DirectionalLight(0xffffff, 1.5);
    sun.position.set(-3, 6, -2);
    scene.add(sun);
    const camera = new PerspectiveCamera(32, 1, 0.5, 4000);

    for (const blueprint of blueprints) {
      const body = instantiate(blueprint.body, { x: 0, y: 0 }, Math.PI / 4);
      const building = { ...body, id: -1 } as Building;
      const meshes = buildBuildingMeshes([building], () => 0, kit);
      scene.add(meshes.group);
      const box = buildingBounds(building);
      const height = buildingHeight(building);
      const span = Math.max(box.maxX - box.minX, box.maxY - box.minY, height * 0.8) + m(4);
      const focus = { x: (box.minX + box.maxX) / 2, y: (box.minY + box.maxY) / 2 };
      // The game camera's own bearing: a quarter turn, looking down.
      const distance = span * 1.85;
      camera.position.set(focus.x + distance * 0.62, height + distance * 0.72, focus.y + distance * 0.62);
      camera.lookAt(focus.x, height * 0.42, focus.y);
      camera.updateProjectionMatrix();
      renderer.render(scene, camera);
      out.set(blueprint.key, renderer.domElement.toDataURL('image/png'));
      scene.remove(meshes.group);
      meshes.dispose();
    }
    return out;
  } catch {
    // No GPU, no second context: the gallery falls back to its glyphs.
    return out;
  } finally {
    kit?.dispose();
    renderer?.dispose();
    canvas?.remove();
  }
}
