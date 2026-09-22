import {
  ACESFilmicToneMapping,
  Group,
  Frustum,
  Matrix4,
  Sphere,
  PCFShadowMap,
  Scene,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer,
} from 'three';

import type { Vec2 } from '@core/vec2';
import type { SegmentId } from '@world/ids';
import type { Network } from '@world/network';
import { buildRoadElevation, type RoadElevation } from '@world/elevation';
import type { RoadStructure } from '@world/structures';
import type { SimWorld } from '@sim/world';
import type { Viewport } from '@view/viewport';

import { createAgentMeshes, type AgentMeshes } from './agents';
import { createEnvironment } from './environment';
import { createMaterials, type SceneMaterials } from './materials';
import { createIsoRig } from './isoViewport';
import { createPostChain, type PostChain } from './postprocess';
import { buildRoadSurfaces, type RoadSurfaces } from './roadSurfaces';
import { buildScenery, type Scenery } from './scenery';
import { createSignalHeads, type SignalHeads } from './signals';
import { buildStructureDetails, type StructureDetails } from './structures';
import { buildUtilities, poleGroundAt, type Utilities } from './utilities';
import { createTerrainSurface, type TerrainSurface } from './terrain';
import { QUALITY, QualityGovernor, type QualityLevel, type QualitySettings } from './quality';

/**
 * The scene renderer.
 *
 * ## The rebuild contract
 *
 * Everything derived from the road network or the terrain is rebuilt in exactly
 * one place, `rebuildWorld`, and only when one of the two revisions it watches
 * has moved. Nothing computes geometry inside `draw`. That matters because a
 * road rebuild solves the whole elevation field and re-triangulates every band:
 * doing it per frame was how earlier versions turned an edit into a stall.
 *
 * A terrain edit invalidates the roads too — they are laid ON the terrain — so
 * both revisions gate the same rebuild.
 *
 * ## Draw order
 *
 * 1. terrain (heightfield, water)
 * 2. road surfaces (four bands per structural level, plus markings)
 * 3. structure details (piers, parapets)
 * 4. scenery (lamps, vegetation)
 * 5. agents and signal heads, resynced every frame from the simulation
 */

export interface RenderStats {
  readonly triangles: number;
  readonly drawCalls: number;
  readonly quality: QualityLevel;
  readonly fps: number;
  /** Wall time of the last world rebuild, in milliseconds. */
  readonly rebuildMs: number;
  /** Increments once per completed world rebuild. */
  readonly rebuilds: number;
}

export interface SceneHandle {
  readonly backend: 'three-webgl';
  readonly viewport: Viewport;
  readonly scene: Scene;
  /** The underlying WebGL renderer. Exposed for diagnostics and tests. */
  readonly gl: WebGLRenderer;
  readonly stats: RenderStats;
  /** The solved road height field, for the editor's own previews. */
  elevationAt(x: number, y: number, structure?: RoadStructure): number;
  /** The height the terrain is drawn at — what anything laid on it must clear. */
  terrainHeightAt(x: number, y: number): number;
  resize(): void;
  draw(net: Network, sim: SimWorld, alpha: number, delta: number): void;
  setQuality(level: QualityLevel | 'auto'): void;
  readonly quality: QualityLevel | 'auto';
  dispose(): void;
}

export function createSceneRenderer(
  canvas: HTMLCanvasElement,
  initialCentre: Vec2,
  initialZoom: number,
  initialQuality: QualityLevel | 'auto' = 'auto',
  onAssetsReady: () => void = () => {},
): SceneHandle {
  const renderer = new WebGLRenderer({
    canvas,
    antialias: true,
    alpha: false,
    powerPreference: 'high-performance',
    stencil: false,
  });
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = true;
  // PCFSoftShadowMap was REMOVED in three r186. Asking for it logged
  // "PCFSoftShadowMap has been removed. Using PCFShadowMap instead." on every
  // boot and silently gave us the hard filter anyway, so the softness the
  // scene was tuned for never existed. Name what we actually get.
  renderer.shadowMap.type = PCFShadowMap;

  let requested: QualityLevel | 'auto' = initialQuality;
  const governor = new QualityGovernor(requested === 'auto' ? 'high' : requested);
  let quality: QualitySettings = QUALITY[governor.current];

  const maxAnisotropy = renderer.capabilities.getMaxAnisotropy();
  const anisotropy = Math.min(quality.anisotropy, maxAnisotropy);

  const scene = new Scene();
  const initialHeight = Math.max(1, canvas.clientHeight || window.innerHeight);
  const rig = createIsoRig(initialCentre, initialHeight / Math.max(0.001, initialZoom * 2));

  const environment = createEnvironment(scene, renderer, {
    shadows: quality.shadows,
    shadowMapSize: quality.shadowMapSize,
  });

  const materials: SceneMaterials = createMaterials(anisotropy);
  const terrain: TerrainSurface = createTerrainSurface(anisotropy);
  scene.add(...terrain.meshes);

  const world = new Group();
  world.name = 'world';
  scene.add(world);

  let roads: RoadSurfaces | null = null;
  let details: StructureDetails | null = null;
  let scenery: Scenery | null = null;
  let utilities: Utilities | null = null;
  let elevation: RoadElevation | null = null;

  let networkRevision = -1;
  let terrainRevision = -1;
  let builtTriangles = 0;
  let rebuildMs = 0;
  let rebuilds = 0;

  const deckHeight = (
    _world: SimWorld,
    x: number,
    y: number,
    segment: SegmentId | undefined,
  ): number => {
    if (!elevation) return terrain.renderedHeightAt(x, y);
    return segment === undefined ? elevation.at(x, y) : elevation.onSegment(segment, x, y);
  };

  const agents: AgentMeshes = createAgentMeshes(deckHeight, onAssetsReady);
  const crowdFrustum = new Frustum();
  const crowdProjection = new Matrix4();
  const crowdBounds = new Sphere(new Vector3(), 8);
  const pedestrianVisible = (x: number, y: number, height: number): boolean => {
    crowdBounds.center.set(x, height + 3, -y);
    return crowdFrustum.intersectsSphere(crowdBounds);
  };
  scene.add(...agents.meshes);
  const signals: SignalHeads = createSignalHeads(scene, deckHeight);

  const rebuildWorld = (net: Network): void => {
    if (networkRevision === net.revision && terrainRevision === net.doc.terrainRevision) return;
    const started = performance.now();
    networkRevision = net.revision;
    terrainRevision = net.doc.terrainRevision;

    roads?.dispose();
    details?.dispose();
    scenery?.dispose();
    utilities?.dispose();
    for (const mesh of scenery?.meshes ?? []) world.remove(mesh);
    world.clear();

    // ONE solve for the whole network, shared by every consumer below. Solving
    // it per structure, or per band, is how two surfaces came to disagree about
    // where the same junction was.
    //
    // Against the NATURAL ground, never the shaped one: the terrain is about to
    // be cut and filled to meet these roads, and feeding the next solve its own
    // previous answer would let the two drift a little further apart on every
    // rebuild.
    elevation = buildRoadElevation(net, terrain.naturalRenderedHeightAt);
    // Now the ground comes to meet the roads: embankments and cuttings instead
    // of the vertical face the verge skirt used to hang off its own edge, and —
    // from the same rule, where a road is buried deeply enough — tunnels.
    terrain.shapeToRoads(net.doc.segments.size > 0 ? elevation : null);

    roads = buildRoadSurfaces(net, elevation, materials, terrain.renderedHeightAt);
    world.add(roads.group);

    details = buildStructureDetails(net, elevation, terrain.renderedHeightAt, materials);
    world.add(details.group);

    scenery = buildScenery(net, elevation, terrain.renderedHeightAt, quality.vegetation);
    for (const mesh of scenery.meshes) world.add(mesh);

    // The overhead utility network. It is drawn from the document directly
    // rather than from the Network, because a pole line is not derived from
    // the roads - it can be drawn across open ground with no road near it.
    //
    // But a pole that IS beside a road stands on the FOOTWAY, not on the
    // ground beside it. The terrain is shaped to meet the road, so the two
    // differ only by the kerb - and a pole sunk 0.36 into the pavement it is
    // meant to stand on is exactly the "poles do not sit on the footway"
    // complaint. The lamp columns in `scenery.ts` already do this; the poles
    // were the one piece of street furniture reading the bare ground.
    utilities = buildUtilities(net.doc, poleGroundAt(elevation, terrain.renderedHeightAt));
    world.add(utilities.group);

    builtTriangles =
      roads.triangles + details.triangles + scenery.triangles + utilities.triangles;
    rebuildMs = performance.now() - started;
    rebuilds++;
  };

  const applyQuality = (level: QualityLevel): void => {
    quality = QUALITY[level];
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, quality.pixelRatio));
    renderer.shadowMap.enabled = quality.shadows;
    environment.setQuality({ shadows: quality.shadows, shadowMapSize: quality.shadowMapSize });
    post?.dispose();
    post = createPostChain(renderer, scene, rig.camera, quality, level);
    resize();
    // Vegetation density is baked into the instanced meshes, so it only takes
    // effect on the next rebuild. Forcing one here keeps the tier honest.
    networkRevision = -1;
  };

  let post: PostChain = createPostChain(renderer, scene, rig.camera, quality, governor.current);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, quality.pixelRatio));

  function resize(): void {
    const width = Math.max(1, canvas.clientWidth);
    const height = Math.max(1, canvas.clientHeight);
    renderer.setSize(width, height, false);
    rig.resize(width, height);
    post.setSize(width, height, renderer.getPixelRatio());
  }
  resize();

  const target = new Vector3();
  let fps = 60;
  let lastWidth = 0;
  let lastHeight = 0;

  return {
    backend: 'three-webgl',
    viewport: rig.viewport,
    scene,
    gl: renderer,
    get stats(): RenderStats {
      return {
        triangles: builtTriangles,
        drawCalls: renderer.info.render.calls,
        quality: governor.current,
        fps: Math.round(fps),
        rebuildMs: Math.round(rebuildMs),
        rebuilds,
      };
    },
    terrainHeightAt(x, y) {
      return terrain.renderedHeightAt(x, y);
    },
    elevationAt(x, y, structure) {
      if (!elevation) return terrain.renderedHeightAt(x, y);
      return elevation.at(x, y, structure ? new Set([structure]) : undefined);
    },
    resize,
    draw(net, sim, alpha, delta) {
      if (canvas.clientWidth !== lastWidth || canvas.clientHeight !== lastHeight) {
        lastWidth = canvas.clientWidth;
        lastHeight = canvas.clientHeight;
        resize();
      }
      terrain.update(net.doc);
      rebuildWorld(net);

      const detailed = rig.viewport.zoom >= quality.detailCutoffZoom;
      if (roads) roads.group.visible = true;
      if (details) details.group.visible = true;
      for (const mesh of scenery?.meshes ?? []) mesh.visible = quality.detailProps && detailed;

      crowdProjection.multiplyMatrices(rig.camera.projectionMatrix, rig.camera.matrixWorldInverse);
      crowdFrustum.setFromProjectionMatrix(crowdProjection);
      agents.sync(sim, alpha, detailed, rig.viewport.zoom, {
        pedestrianDetail: quality.pedestrianDetail,
        pedestrianVisible,
      });
      signals.sync(sim, detailed);

      target.copy(rig.target);
      const halfHeight = canvas.clientHeight / Math.max(0.001, rig.viewport.zoom * 2);
      const halfWidth = (halfHeight * canvas.clientWidth) / Math.max(1, canvas.clientHeight);
      environment.follow(target, halfWidth, halfHeight);

      post.render(delta);

      if (delta > 0) fps = fps * 0.9 + (1 / Math.min(1, delta)) * 0.1;
      if (requested === 'auto') {
        const next = governor.sample(delta);
        if (next) {
          governor.set(next);
          applyQuality(next);
        }
      }
    },
    setQuality(level) {
      requested = level;
      const resolved = level === 'auto' ? governor.current : level;
      governor.set(resolved);
      applyQuality(resolved);
    },
    get quality() {
      return requested;
    },
    dispose() {
      agents.dispose();
      signals.dispose();
      roads?.dispose();
      details?.dispose();
      scenery?.dispose();
      terrain.dispose();
      materials.dispose();
      environment.dispose();
      post.dispose();
      renderer.dispose();
    },
  };
}
