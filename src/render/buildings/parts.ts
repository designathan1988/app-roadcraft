import { AmbientLight, DirectionalLight, PerspectiveCamera, Scene, WebGLRenderer } from 'three';

import {
  BAY_COMPONENTS,
  type Building,
  type ElementKind,
  FACADE_PATTERNS,
  type FacadePattern,
  ROOF_KINDS,
  type RoofKind,
  type BayComponent,
} from '@world/buildings/types';
import { ELEMENT_DEFAULTS, elementAt } from '@world/buildings/elements';
import { BLUEPRINTS, blueprintByKey, instantiate } from '@world/buildings/blueprints';
import { buildingBounds, buildingHeight } from '@world/buildings/geometry';
import { buildBuildingMeshes } from './buildingMesh';
import { type BuildingKit, createBuildingKit } from './kit';

/**
 * Pictures of the things the galleries offer - a model, a window, a roof, a
 * stair - built by the same mesh builder that will build them on the map and
 * photographed from the game camera's own angle.
 *
 * A gallery of glyphs names the options; a gallery of pictures shows them. It
 * is a studio rather than a function because a picture costs a few
 * milliseconds: an interface that photographs eighty of them in one go freezes
 * for a third of a second (measured), so the pictures are taken a few per frame
 * and handed over as they are ready.
 */
const SIZE = 224;
/** Pictures per frame: enough to fill a row, small enough to hold 60 fps. */
const PER_FRAME = 3;
/** How long the second context is kept once the queue is empty. */
const IDLE_MS = 4000;

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

const MODEL_KEYS = new Set(BLUEPRINTS.map((blueprint) => blueprint.key));

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
  if (MODEL_KEYS.has(id)) {
    const blueprint = blueprintByKey(id);
    if (!blueprint) return null;
    return { ...instantiate(blueprint.body, { x: 0, y: 0 }, Math.PI / 4), id: -1 } as Building;
  }

  const sample = blank();
  const volume = sample?.volumes[0];
  if (!sample || !volume) return null;
  sample.elements = [];

  const component = WALL_PARTS[id];
  if (component) {
    // One storey, one wall, filled with the part: the picture is the part.
    if (!volume.storeys[0]) return null;
    volume.storeys = [{ facade: { fill: component } }];
    return sample;
  }

  // A composition is photographed on the wall it composes.
  if ((FACADE_PATTERNS as readonly string[]).includes(id)) {
    for (const storey of volume.storeys) {
      storey.facade = { ...storey.facade, pattern: id as FacadePattern };
    }
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

export interface ThumbnailStudio {
  /**
   * Photographs the ids that are worth a picture, a few per frame, calling
   * back with each batch. Ids already taken or already queued are ignored.
   */
  request(ids: readonly string[], onBatch: (images: ReadonlyMap<string, string>) => void): void;
  /** Releases the second GPU context at once. */
  dispose(): void;
  /** How long the studio holds its context after the last picture. */
  IDLE_MS?: number;
}

export function createThumbnailStudio(gl: WebGLRenderer): ThumbnailStudio {
  const done = new Set<string>();
  const queued = new Set<string>();
  const waiting: { id: string; onBatch: (images: ReadonlyMap<string, string>) => void }[] = [];
  let frame: number | null = null;

  let idle: ReturnType<typeof setTimeout> | null = null;
  let canvas: HTMLCanvasElement | null = null;
  let renderer: WebGLRenderer | null = null;
  let kit: BuildingKit | null = null;
  let scene: Scene | null = null;
  let camera: PerspectiveCamera | null = null;

  const setUp = (): boolean => {
    if (renderer) return true;
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
      scene = new Scene();
      scene.add(new AmbientLight(0xffffff, 1.15));
      const sun = new DirectionalLight(0xffffff, 1.5);
      sun.position.set(-3, 6, -2);
      scene.add(sun);
      camera = new PerspectiveCamera(30, 1, 0.5, 4000);
      return true;
    } catch (error) {
      // No second context: the galleries keep their glyphs.
      console.warn('parts studio: no second context', error);
      return false;
    }
  };

  const shoot = (id: string, batch: Map<string, string>): void => {
    const sample = partSample(id);
    if (!sample || !renderer || !kit || !scene || !camera) return;
    try {
      const meshes = buildBuildingMeshes([sample], () => 0, kit);
      scene.add(meshes.group);
      const box = buildingBounds(sample);
      const height = Math.max(buildingHeight(sample), 3);
      // An element on its own stands on nothing: it is framed round itself,
      // or the camera looks over its head and the picture clips its feet.
      const alone = sample.volumes.length === 0;
      const span = Math.max(box.maxX - box.minX, box.maxY - box.minY, height * 0.9) + (alone ? 2 : 4);
      const focus = { x: (box.minX + box.maxX) / 2, y: (box.minY + box.maxY) / 2 };
      const look = alone ? Math.max(0.5, height * 0.35) : height * 0.45;
      const distance = span * (alone ? 1.5 : 1.7);
      camera.position.set(focus.x + distance * 0.55, look + distance * 0.6, focus.y + distance * 0.55);
      camera.lookAt(focus.x, look, focus.y);
      camera.updateProjectionMatrix();
      renderer.render(scene, camera);
      batch.set(id, renderer.domElement.toDataURL('image/png'));
      scene.remove(meshes.group);
      meshes.dispose();
    } catch {
      // A part that will not build keeps its glyph: the gallery still works.
    }
  };

  const step = (): void => {
    frame = null;
    if (!setUp()) {
      waiting.length = 0;
      return;
    }
    const batch = new Map<string, string>();
    for (let i = 0; i < PER_FRAME && waiting.length > 0; i++) {
      const next = waiting.shift();
      if (!next) break;
      shoot(next.id, batch);
      done.add(next.id);
      if (batch.size > 0) next.onBatch(new Map(batch));
    }
    if (waiting.length > 0) {
      frame = requestAnimationFrame(step);
      return;
    }
    // Nothing left to shoot: hand the second GPU context back rather than
    // holding two of them open for the rest of the session, and take it again
    // when another gallery asks. The pictures already on screen are the ones
    // the studio was holding.
    idle = setTimeout(release, IDLE_MS);
  };

  const release = (): void => {
    idle = null;
    kit?.dispose();
    renderer?.dispose();
    canvas?.remove();
    canvas = null;
    renderer = null;
    kit = null;
    scene = null;
    camera = null;
  };

  return {
    request(ids, onBatch) {
      if (idle !== null) {
        clearTimeout(idle);
        idle = null;
      }
      for (const id of ids) {
        if (done.has(id) || queued.has(id)) continue;
        queued.add(id);
        waiting.push({ id, onBatch });
      }
      if (frame === null && waiting.length > 0) frame = requestAnimationFrame(step);
    },
    dispose() {
      if (frame !== null) cancelAnimationFrame(frame);
      if (idle !== null) clearTimeout(idle);
      frame = null;
      idle = null;
      waiting.length = 0;
      release();
    },
  };
}
