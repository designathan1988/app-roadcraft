import { AmbientLight, DirectionalLight, PerspectiveCamera, Scene, WebGLRenderer } from 'three';

import {
  BAY_COMPONENTS,
  type Building,
  type ElementKind,
  ROOF_KINDS,
  type RoofKind,
  type BayComponent,
} from '@world/buildings/types';
import { ELEMENT_DEFAULTS, elementAt } from '@world/buildings/elements';
import { blueprintByKey, instantiate } from '@world/buildings/blueprints';
import { buildingBounds, buildingHeight } from '@world/buildings/geometry';
import { buildBuildingMeshes } from './buildingMesh';
import { type BuildingKit, createBuildingKit } from './kit';

/**
 * A picture of one part - a window, a roof, a stair - for the gallery, built
 * by the same mesh builder that will build it on the map and photographed from
 * the game camera's own angle.
 *
 * A gallery of glyphs names the options; a gallery of pictures shows them, and
 * the part the player clicks is the part they get, down to the glazing bars.
 * Off screen and once, like the models' own pictures.
 */
const SIZE = 224;

/** Which BayComponent a gallery id stands for: most carry their own name. */
const WALL_PARTS: Readonly<Record<string, BayComponent>> = {
  ...Object.fromEntries(BAY_COMPONENTS.map((component) => [component, component])),
  pillarBay: 'pillar',
  wallBay: 'wall',
};

const ROOF_PARTS: Readonly<Record<string, RoofKind>> = Object.fromEntries(
  ROOF_KINDS.map((kind) => [kind === 'flat' ? 'roofFlat' : `roof${kind[0]?.toUpperCase()}${kind.slice(1)}`, kind]),
);

const ELEMENT_PARTS = new Set<string>(Object.keys(ELEMENT_DEFAULTS));

/** The traced runs are their element, seen as the thing they lay. */
const RUN_PARTS: Readonly<Record<string, ElementKind>> = {
  wallRun: 'wall',
  fenceRun: 'fence',
  pavementRun: 'pavement',
  stairRun: 'stair',
  railing: 'railing',
};

/** Every id the gallery can show a picture of. */
export const PART_IDS: readonly string[] = [
  ...Object.keys(WALL_PARTS),
  ...Object.keys(ROOF_PARTS),
  'roofShape',
  ...ELEMENT_PARTS,
  ...Object.keys(RUN_PARTS),
];

function blank(): Building | null {
  const blueprint = blueprintByKey('block');
  if (!blueprint) return null;
  return { ...instantiate(blueprint.body, { x: 0, y: 0 }, 0), id: -1 } as Building;
}

/**
 * The record a part is photographed from: the wall of a small block for a
 * window, that block under the roof in question, or a pad with one element
 * standing on it.
 */
export function partSample(id: string): Building | null {
  const sample = blank();
  const volume = sample?.volumes[0];
  if (!sample || !volume) return null;
  sample.elements = [];

  const component = WALL_PARTS[id];
  if (component) {
    // One storey, one wall, filled with the part: the picture is the part.
    const storey = volume.storeys[0];
    if (!storey) return null;
    volume.storeys = [{ facade: { fill: component } }];
    return sample;
  }

  const roof = ROOF_PARTS[id];
  if (roof) {
    volume.roof = roof;
    return sample;
  }
  if (id === 'roofShape' || id === 'roofs') {
    volume.roof = 'gable';
    return sample;
  }

  const kind = RUN_PARTS[id] ?? (ELEMENT_PARTS.has(id) ? (id as ElementKind) : null);
  if (kind) {
    // No walls at all: the element alone, at the size it is placed at.
    sample.volumes = [];
    sample.cores = [];
    sample.elements = [{ ...elementAt(sample, kind, { x: 0, y: 0 }, 2), id: 1 }];
    return sample;
  }

  return null;
}

export function renderPartThumbnails(
  gl: WebGLRenderer,
  ids: readonly string[],
): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  let canvas: HTMLCanvasElement | null = null;
  let renderer: WebGLRenderer | null = null;
  let kit: BuildingKit | null = null;
  try {
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
    const camera = new PerspectiveCamera(30, 1, 0.5, 4000);

    for (const id of ids) {
      const sample = partSample(id);
      if (!sample) continue;
      try {
        const meshes = buildBuildingMeshes([sample], () => 0, kit);
        scene.add(meshes.group);
        const box = buildingBounds(sample);
        const height = Math.max(buildingHeight(sample), 3);
        const span = Math.max(box.maxX - box.minX, box.maxY - box.minY, height * 0.9) + 4;
        const focus = { x: (box.minX + box.maxX) / 2, y: (box.minY + box.maxY) / 2 };
        const distance = span * 1.7;
        camera.position.set(focus.x + distance * 0.55, height + distance * 0.6, focus.y + distance * 0.55);
        camera.lookAt(focus.x, height * 0.45, focus.y);
        camera.updateProjectionMatrix();
        renderer.render(scene, camera);
        out.set(id, renderer.domElement.toDataURL('image/png'));
        scene.remove(meshes.group);
        meshes.dispose();
      } catch {
        // A part that will not build keeps its glyph: the gallery still works.
      }
    }
    return out;
  } catch {
    return out;
  } finally {
    kit?.dispose();
    renderer?.dispose();
    canvas?.remove();
  }
}
