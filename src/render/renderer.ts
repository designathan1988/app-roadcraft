import {
  ACESFilmicToneMapping,
  Group,
  Frustum,
  Matrix4,
  type Material,
  type Mesh,
  MeshDepthMaterial,
  type Object3D,
  RGBADepthPacking,
  Sphere,
  PCFShadowMap,
  Scene,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer,
} from 'three';

import { Digest } from '@core/digest';
import type { Vec2 } from '@core/vec2';
import type { SegmentId } from '@world/ids';
import type { Network } from '@world/network';
import { GROUND_ONLY, buildRoadElevation, type RoadElevation } from '@world/elevation';
import { ROAD_TYPES, casingHalf, sidewalkHalf } from '@world/roadTypes';
import type { RoadStructure } from '@world/structures';
import type { SimWorld } from '@sim/world';
import type { Viewport } from '@view/viewport';

import { createAgentMeshes, type AgentMeshes } from './agents';
import { createEnvironment } from './environment';
import { createMaterials, type SceneMaterials } from './materials';
import { createIsoRig } from './isoViewport';
import { createPostChain, type PostChain } from './postprocess';
import { FOOTWAY_RISE, buildRoadSurfaces, type RoadSurfaces, type SurfaceReuse } from './roadSurfaces';
import { PLANT_NEAR_ZOOM, buildScenery, createSceneryKit, type Scenery, type SceneryKit } from './scenery';
import { GRASS_MIN_ZOOM } from './grass';
import { advanceWind } from './wind';
import { createSignalHeads, type SignalHeads } from './signals';
import { buildStructureDetails, type StructureDetails } from './structures';
import { buildUtilities, poleGroundAt, type Utilities } from './utilities';
import { createTerrainSurface, type TerrainSurface } from './terrain';
import { type BuildingPreviewInput, createBuildingLayer } from './buildings/layer';
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
 * 4. scenery (furniture, trees, bushes; grass at close zoom only)
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
  /** Wall time of the last terrain-only update (a brush dab while roads are held), ms. */
  readonly terrainMs: number;
}

export interface DrawOptions {
  /**
   * Keep the roads, and everything laid along them, as they are: only the
   * ground is updated, and shaped to the roads' current heights. Set while a
   * terrain brush stroke is held; the first draw without it re-solves the
   * roads once for the whole stroke.
   */
  readonly holdRoads?: boolean;
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
  /** The editor's building ghost (docs/buildings.md); null removes it. */
  setBuildingPreview(preview: BuildingPreviewInput | null): void;
  /** The height the terrain is drawn at — what anything laid on it must clear. */
  terrainHeightAt(x: number, y: number): number;
  /**
   * The height of the paving at a point - footway or carriageway of a road at
   * grade - or NaN off the roads. What a building's entrance opens onto.
   */
  pavedHeightAt(x: number, y: number): number;
  resize(): void;
  draw(net: Network, sim: SimWorld, alpha: number, delta: number, options?: DrawOptions): void;
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
  // Drawn once a frame, on request (see `post.render` below). Left automatic,
  // three redraws every shadow map on EVERY `renderer.render`, and the frame
  // has two scene renders with the sun in them - the main pass and the
  // ambient-occlusion pass's normal pass - so the whole shadow pass, every
  // caster in the city, was drawn twice a frame for the same picture.
  renderer.shadowMap.autoUpdate = false;

  // One shadow depth material per program variant. three draws every caster
  // without a depth material of its own with ONE shared material, and plain
  // meshes, instanced meshes and instanced meshes with per-instance colour
  // compile to three different programs of it: interleaved in the shadow pass,
  // three re-derived the program on nearly every draw (`getParameters`,
  // `setProgram` - the trap AGENTS.md describes, inside three). Each variant
  // now has its own material, so each keeps its program.
  const depthVariants = {
    plain: new MeshDepthMaterial({ depthPacking: RGBADepthPacking }),
    instanced: new MeshDepthMaterial({ depthPacking: RGBADepthPacking }),
    tinted: new MeshDepthMaterial({ depthPacking: RGBADepthPacking }),
  };
  const ownDepth = new Set<MeshDepthMaterial>(Object.values(depthVariants));
  const plainOpaque = (material: Material): boolean => {
    const m = material as Material & { alphaTest: number; alphaMap?: unknown; map?: unknown; displacementMap?: unknown };
    // Anything three would give a depth material of its own (cut-outs,
    // displacement, coverage) keeps three's own choice.
    return !(m.alphaTest > 0 && (m.map || m.alphaMap)) && !m.displacementMap && !m.alphaToCoverage;
  };
  const assignShadowDepth = (root: Object3D): void => {
    root.traverse((object) => {
      const mesh = object as Mesh & { isInstancedMesh?: boolean; instanceColor?: unknown };
      if (!mesh.isMesh || !mesh.castShadow) return;
      const current = mesh.customDepthMaterial as MeshDepthMaterial | undefined;
      if (current && !ownDepth.has(current)) return;
      if (Array.isArray(mesh.material) || !plainOpaque(mesh.material)) return;
      const wanted = !mesh.isInstancedMesh
        ? depthVariants.plain
        : mesh.instanceColor ? depthVariants.tinted : depthVariants.instanced;
      if (current !== wanted) mesh.customDepthMaterial = wanted;
    });
  };

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
  materials.setDetail(quality.surfaceDetail);
  // Every prop model and material, built once. A rebuild writes only the
  // instance matrices.
  const sceneryKit: SceneryKit = createSceneryKit();
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

  // What each rebuild keeps for the next: the tiles of every surface an edit
  // does not reach, keyed by the solved roads and the ground they read.
  const surfaceReuse: SurfaceReuse = {
    tiles: new Map(),
    dependsOn: (minX, minY, maxX, maxY) => new Digest()
      .add(elevation?.digest(minX, minY, maxX, maxY) ?? 0)
      .add(terrain.digest(minX, minY, maxX, maxY))
      .value(),
    paint: new Map(),
  };

  let networkRevision = -1;
  let terrainRevision = -1;
  let builtTriangles = 0;
  let rebuildMs = 0;
  let rebuilds = 0;
  let terrainMs = 0;

  const deckHeight = (
    _world: SimWorld,
    x: number,
    y: number,
    segment: SegmentId | undefined,
  ): number => {
    if (!elevation) return terrain.renderedHeightAt(x, y);
    return segment === undefined ? elevation.at(x, y) : elevation.onSegment(segment, x, y);
  };

  /** See `SceneHandle.pavedHeightAt`. */
  const pavedHeightAt = (x: number, y: number): number => {
    if (!elevation || !elevation.has(GROUND_ONLY)) return NaN;
    const road = elevation.roadAt(x, y, GROUND_ONLY);
    const rt = road.type >= 0 ? ROAD_TYPES[road.type] : undefined;
    if (!rt) return NaN;
    // `half` is this road's own casing (its lanes may be set individually):
    // the footway ends a casing band inside it and starts a footway further in.
    const footway = road.half - (casingHalf(rt) - sidewalkHalf(rt));
    const across = Math.abs(road.across);
    if (across > footway) return NaN;
    const deck = elevation.at(x, y, GROUND_ONLY);
    return across > footway - rt.sidewalk ? deck + FOOTWAY_RISE : deck;
  };

  const agents: AgentMeshes = createAgentMeshes(deckHeight, onAssetsReady);
  const crowdFrustum = new Frustum();
  const crowdProjection = new Matrix4();
  const crowdBounds = new Sphere(new Vector3(), 8);
  const pedestrianVisible = (x: number, y: number, height: number): boolean => {
    crowdBounds.center.set(x, height + 3, -y);
    return crowdFrustum.intersectsSphere(crowdBounds);
  };
  // A vehicle is tested with its own reach, grown by its height towards the
  // sun's side: an off-screen truck near the edge still casts a shadow onto it.
  const vehicleBounds = new Sphere(new Vector3(), 1);
  const vehicleVisible = (x: number, y: number, height: number, radius: number): boolean => {
    vehicleBounds.center.set(x, height + radius * 0.3, -y);
    vehicleBounds.radius = radius;
    return crowdFrustum.intersectsSphere(vehicleBounds);
  };
  scene.add(...agents.meshes);
  const signals: SignalHeads = createSignalHeads(scene, deckHeight);

  // Modular buildings: their own layer, behind their own gate (see
  // `render/buildings/layer.ts`), so a building edit never re-solves the roads.
  const buildings = createBuildingLayer();
  scene.add(buildings.group);
  /** The scenery the building footprints were last cut out of. */
  let excludedFor: { scenery: Scenery | null; version: number } = { scenery: null, version: -1 };

  /** `doc.utilityRevision` the pole layer was last built at. */
  let utilityRevision = -1;
  /**
   * The pole layer alone, on its own revision: a pole edit moves only
   * `doc.utilityRevision` (see `RoadDoc`), so it rebuilds this and nothing else.
   */
  const rebuildUtilities = (net: Network): void => {
    if (!elevation) return;
    utilityRevision = net.doc.utilityRevision;
    if (utilities) {
      builtTriangles -= utilities.triangles;
      world.remove(utilities.group);
      utilities.dispose();
    }
    utilities = buildUtilities(net.doc, poleGroundAt(elevation, terrain.renderedHeightAt));
    world.add(utilities.group);
    builtTriangles += utilities.triangles;
  };

  const rebuildWorld = (net: Network): void => {
    if (networkRevision === net.revision && terrainRevision === net.doc.terrainRevision) {
      if (utilityRevision !== net.doc.utilityRevision) rebuildUtilities(net);
      return;
    }
    const started = performance.now();
    networkRevision = net.revision;
    terrainRevision = net.doc.terrainRevision;

    roads?.dispose();
    details?.dispose();
    scenery?.dispose();
    utilities?.dispose();
    for (const mesh of scenery?.meshes ?? []) world.remove(mesh);
    if (scenery) world.remove(scenery.grass);
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

    roads = buildRoadSurfaces(net, elevation, materials, terrain.renderedHeightAt, surfaceReuse);
    world.add(roads.group);

    details = buildStructureDetails(net, elevation, terrain.renderedHeightAt, materials);
    world.add(details.group);

    scenery = buildScenery(
      net,
      elevation,
      terrain.renderedHeightAt,
      terrain.wetAt,
      { vegetation: quality.vegetation, grass: quality.grass },
      sceneryKit,
    );
    for (const mesh of scenery.meshes) world.add(mesh);
    world.add(scenery.grass);

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
    utilityRevision = net.doc.utilityRevision;

    builtTriangles =
      roads.triangles + details.triangles + scenery.triangles + utilities.triangles;
    rebuildMs = performance.now() - started;
    rebuilds++;
  };

  const applyQuality = (level: QualityLevel): void => {
    quality = QUALITY[level];
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, quality.pixelRatio));
    renderer.shadowMap.enabled = quality.shadows;
    materials.setDetail(quality.surfaceDetail);
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
  /** Wall-clock seconds, for the wind; independent of the simulation speed. */
  let windClock = 0;
  let lastWidth = 0;
  let lastHeight = 0;

  return {
    backend: 'three-webgl',
    viewport: rig.viewport,
    scene,
    gl: renderer,
    get stats(): RenderStats {
      return {
        triangles: builtTriangles + buildings.triangles,
        drawCalls: renderer.info.render.calls,
        quality: governor.current,
        fps: Math.round(fps),
        rebuildMs: Math.round(rebuildMs),
        rebuilds,
        terrainMs: Math.round(terrainMs),
      };
    },
    terrainHeightAt(x, y) {
      return terrain.renderedHeightAt(x, y);
    },
    pavedHeightAt,
    setBuildingPreview(preview) {
      buildings.setPreview(preview);
    },
    elevationAt(x, y, structure) {
      if (!elevation) return terrain.renderedHeightAt(x, y);
      return elevation.at(x, y, structure ? new Set([structure]) : undefined);
    },
    resize,
    draw(net, sim, alpha, delta, options) {
      const frameStarted = performance.now();
      if (canvas.clientWidth !== lastWidth || canvas.clientHeight !== lastHeight) {
        lastWidth = canvas.clientWidth;
        lastHeight = canvas.clientHeight;
        resize();
      }
      const terrainStarted = performance.now();
      const groundMoved = terrain.update(net.doc);
      // A brush stroke in progress: every dab used to re-solve the whole road
      // network and re-mesh every road, tree and tuft of grass near it - 450 ms
      // a dab on the player map, so painting was a slideshow. While the stroke
      // is held only the ground follows the brush, cut and filled to the roads
      // as they already stand; the roads catch up once, when it ends.
      if (options?.holdRoads && elevation && networkRevision === net.revision) {
        if (groundMoved) {
          terrain.shapeToRoads(net.doc.segments.size > 0 ? elevation : null);
          terrainMs = performance.now() - terrainStarted;
        }
      } else {
        rebuildWorld(net);
      }
      buildings.update(net.doc, terrain.renderedHeightAt, `${net.doc.terrainRevision}:${rebuilds}`, pavedHeightAt);
      if (scenery && (excludedFor.scenery !== scenery || excludedFor.version !== buildings.version)) {
        scenery.exclude(net.doc.buildings.size > 0 ? buildings.covers : null);
        excludedFor = { scenery, version: buildings.version };
      }

      const detailed = rig.viewport.zoom >= quality.detailCutoffZoom;
      if (roads) roads.group.visible = true;
      if (details) details.group.visible = true;
      for (const mesh of scenery?.meshes ?? []) mesh.visible = quality.detailProps && detailed;
      if (scenery) {
        scenery.grass.visible = quality.detailProps && rig.viewport.zoom >= GRASS_MIN_ZOOM;
        scenery.setNear(rig.viewport.zoom >= PLANT_NEAR_ZOOM);
      }
      // The wind blows in real time: a paused simulation is still a windy day.
      windClock += Math.min(0.1, Math.max(0, delta));
      advanceWind(windClock);

      crowdProjection.multiplyMatrices(rig.camera.projectionMatrix, rig.camera.matrixWorldInverse);
      crowdFrustum.setFromProjectionMatrix(crowdProjection);
      // Plants and street furniture outside the view are not drawn at all.
      scenery?.cull(crowdFrustum, crowdProjection);
      agents.sync(sim, alpha, detailed, rig.viewport.zoom, {
        pedestrianDetail: quality.pedestrianDetail,
        pedestrianVisible,
        vehicleVisible,
        occupantZoom: quality.occupantZoom,
      });
      signals.sync(sim, detailed);

      target.copy(rig.target);
      const halfHeight = canvas.clientHeight / Math.max(0.001, rig.viewport.zoom * 2);
      const halfWidth = (halfHeight * canvas.clientWidth) / Math.max(1, canvas.clientHeight);
      environment.follow(target, halfWidth, halfHeight);

      renderer.shadowMap.needsUpdate = true;
      // Cheap (a few hundred objects), and it follows meshes a rebuild or an
      // asset load adds, and instance colours created on first use.
      if (renderer.shadowMap.enabled) assignShadowDepth(scene);
      post.render(delta);

      if (delta > 0) fps = fps * 0.9 + (1 / Math.min(1, delta)) * 0.1;
      if (requested === 'auto') {
        const next = governor.sample(delta, performance.now() - frameStarted);
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
      buildings.dispose();
      roads?.dispose();
      for (const paint of surfaceReuse.paint.values()) paint.dispose();
      details?.dispose();
      scenery?.dispose();
      sceneryKit.dispose();
      terrain.dispose();
      materials.dispose();
      environment.dispose();
      post.dispose();
      renderer.dispose();
    },
  };
}
