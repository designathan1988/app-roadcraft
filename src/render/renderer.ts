import {
  ACESFilmicToneMapping,
  Box3,
  PointLight,
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
import { FOOTWAY_RISE, ROAD_TYPES, casingHalf, sidewalkHalf } from '@world/roadTypes';
import type { RoadStructure } from '@world/structures';
import type { SimWorld } from '@sim/world';
import type { Viewport } from '@view/viewport';

import { createAgentMeshes, type AgentMeshes } from './agents';
import { createEnvironment } from './environment';
import { createMaterials, type SceneMaterials } from './materials';
import { createIsoRig } from './isoViewport';
import { createPostChain, type PostChain } from './postprocess';
import { createInspector, type Inspector } from './inspector';
import { buildRoadSurfaces, type RoadSurfaces, type SurfaceReuse } from './roadSurfaces';
import { PLANT_MAP_ZOOM, PLANT_NEAR_ZOOM, buildGardens, buildScenery, createSceneryKit, type GardenPlant, type Scenery, type SceneryKit } from './scenery';
import { localToWorld } from '@world/buildings/geometry';
import { drainCompiles, drainUploads } from './uploads';
import type { Building } from '@world/buildings/types';
import { GRASS_MIN_ZOOM } from './grass';
import { advanceWind } from './wind';
import { createSignalHeads, type SignalHeads } from './signals';
import { buildStructureDetails, type StructureDetails } from './structures';
import { buildUtilities, poleGroundAt, type Utilities } from './utilities';
import { TERRAIN_CELL, createTerrainSurface, type TerrainSurface } from './terrain';
import { buildingPads } from '@world/buildings/pads';
import { Indoors } from './indoors';
import { setLit, slotOf, slotsOnFloor } from './buildings/lightSlots';
import { m } from '@world/units';
/**
 * Marks lit every space somebody is in, awake: a resident's own flat at home
 * (none after bedtime), the floor of their job at work, the ground floor for
 * a visitor, and the lobby of a block of flats with people in it after dark.
 */
function updateLitRooms(sim: SimWorld): void {
  const lit = new Set<number>();
  const hour = (sim.city.minutes(sim) % 1440) / 60;
  const asleep = hour >= 23 || hour < 6.5;
  const addFloor = (b: number, level: number): void => { for (const slot of slotsOnFloor(b, level)) lit.add(slot); };
  for (const b of sim.doc.buildings.all()) {
    const inside = sim.city.inside(b.id);
    if (inside.length === 0) continue;
    for (const r of inside) {
      if (r.home === b.id) {
        if (asleep) continue;
        const flat = r.homeSpace;
        const slot = flat ? slotOf(b.id, r.homeLevel, flat.volume, flat.x, flat.y) : -1;
        if (slot >= 0) lit.add(slot); else addFloor(b.id, r.homeLevel);
      } else addFloor(b.id, r.work === b.id ? r.workLevel : 0);
    }
    if (b.function === 'apartments' || b.function === 'residentialTower') addFloor(b.id, 0);
  }
  setLit(lit);
}

/** Room lights kept in the scene for the floors cut open (`indoors.ts`). */
const ROOM_LIGHTS = 6;
import { type BuildingPreviewInput, type CutawaySpec, createBuildingLayer } from './buildings/layer';
import type { BuildingId } from '@world/buildings/types';
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

/** How the sky is kept: `cycle` follows the residents' clock. */
export type SkyMode = 'day' | 'night' | 'cycle';

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
  /**
   * The Builder's "Ocultar outros": undefined draws every building solid,
   * null fades them all, an id fades every building but that one.
   */
  setBuildingsDimmed(except: number | null | undefined): void;
  /** "See inside": the buildings near (x, y) drawn cut open at a floor; null draws them whole. */
  setBuildingCutaway(spec: CutawaySpec | null): void;
  /** The sky: always day, always night, or the residents' own clock. */
  setSkyMode(mode: SkyMode): void;
  /** Perspective camera on, or the orthographic (isometric) view. */
  setPerspective(on: boolean): void;
  /** The height the terrain is drawn at — what anything laid on it must clear. */
  terrainHeightAt(x: number, y: number): number;
  /**
   * The top of what is drawn at a point: a deck where a road's casing covers
   * it, the terrain elsewhere. (`elevationAt` is the NEAREST road's height
   * wherever the point is, a field for previews, not a surface.)
   */
  surfaceHeightAt(x: number, y: number): number;
  /**
   * The height of the paving at a point - footway or carriageway of a road at
   * grade - or NaN off the roads. What a building's entrance opens onto.
   */
  pavedHeightAt(x: number, y: number): number;
  resize(): void;
  draw(net: Network, sim: SimWorld, alpha: number, delta: number, options?: DrawOptions): void;
  setQuality(level: QualityLevel | 'auto'): void;
  readonly quality: QualityLevel | 'auto';
  /** The inspection camera (`inspector.ts`); null outside development builds. */
  readonly inspect: Inspector | null;
  /** Every figure drawn last frame and the body it was cast as: the runtime census. */
  census(): ReturnType<AgentMeshes['census']>;
  /** Every body loaded and baked, for the loading screen. */
  preloadPeople(progress?: (done: number, total: number) => void): Promise<void>;
  dispose(): void;
}

/** Roads at grade, and the decks above them, as `surfaceHeightAt` asks them. */
const SURFACE_SETS: readonly ReadonlySet<RoadStructure>[] = [GROUND_ONLY, new Set<RoadStructure>(['elevated', 'bridge'])];

/** The plants of every building's garden, in the world, on the ground they stand on. */
function gardenPlants(all: Iterable<Building>, groundAt: (x: number, y: number) => number): GardenPlant[] {
  const out: GardenPlant[] = [];
  for (const b of all) {
    for (const el of b.elements ?? []) {
      if (el.kind !== 'tree' && el.kind !== 'shrub' && el.kind !== 'hedge' && el.kind !== 'flowers') continue;
      const at = localToWorld(b, el.x, el.y);
      // `w` runs across the way the element faces.
      const yaw = (b.rotation ?? 0) + (el.facing === 1 || el.facing === 3 ? Math.PI / 2 : 0) + (el.angle ?? 0);
      out.push({ kind: el.kind, x: at.x, y: at.y, z: groundAt(at.x, at.y), w: el.w, d: el.d, h: el.h, yaw, seed: ((b.id * 7919 + el.id * 104729) % 100003) / 100003 });
    }
  }
  return out;
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
    return across > footway - (road.sidewalk ?? rt.sidewalk) ? deck + FOOTWAY_RISE : deck;
  };

  const agents: AgentMeshes = createAgentMeshes(deckHeight, onAssetsReady,
    (x, y) => terrain.renderedHeightAt(x, y));
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
  /** The buildings' garden plants, and the buildings and ground they were planted for. */
  let gardens: Scenery | null = null;
  let gardensFor = '';
  // Materials whose shaders were compiled ahead (`compileAsync`), and when the scene was last checked.
  const compiledMaterials = new WeakSet<Material>();
  let compileCheckedAt = 0;
  let compiling = false;
  /** The buildings cut open, for the people drawn inside them (`indoors.ts`). */
  let cutSpec: CutawaySpec | null = null;
  let skyMode: SkyMode = 'day';
  const indoors = new Indoors();
  // Room lights for the floors cut open: a fixed set, so switching them on and
  // off never changes the scene's light count (which recompiles every shader).
  const roomLights: PointLight[] = [];
  for (let i = 0; i < ROOM_LIGHTS; i++) {
    const light = new PointLight(0xffd6a0, 0, m(8), 2);
    light.name = 'room-light';
    light.castShadow = false;
    scene.add(light);
    roomLights.push(light);
  }
  let lampsKey = '';
  let litAt = 0;
  let tallestFor = -1;
  let lastDark = -1;
  let tallestTop = 0;
  const tallestBox = new Box3();
  const viewDirection = new Vector3();
  /** The building revision the ground was last graded for. */
  let gradedFor = -1;
  /**
   * Cuts and fills the ground to the roads AND to the buildings: a level
   * platform under each building and a grassed bank round it. A road keeps the
   * ground it has claimed; a platform takes the rest.
   */
  const shapeGround = (net: Network): void => {
    gradedFor = net.doc.buildings.revision;
    const roads = net.doc.segments.size > 0 ? elevation : null;
    const pads = net.doc.buildings.size > 0
      ? buildingPads(net.doc.buildings.all(), terrain.naturalRenderedHeightAt, pavedHeightAt, TERRAIN_CELL * 1.5)
      : null;
    if (!pads) {
      terrain.shapeToRoads(roads);
      return;
    }
    terrain.shapeToRoads({
      shapeBounds: () => [...(roads?.shapeBounds() ?? []), ...pads.shapeBounds()],
      shapeAt(x, y, ground) {
        const road = roads ? roads.shapeAt(x, y, ground) : { height: ground, weight: 0 };
        const pad = pads.shapeAt(x, y, ground);
        if (pad.weight <= 0) return road;
        if (road.weight <= 0) return pad;
        return { height: pad.height + (road.height - pad.height) * road.weight, weight: 1 };
      },
    });
  };

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
    shapeGround(net);

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
    post.setNight(Math.max(0, lastDark));
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

  // Development only: the production build replaces the flag with false and
  // drops the inspector with it.
  const inspect = import.meta.env.DEV ? createInspector(renderer, scene) : null;

  return {
    inspect,
    census: () => agents.census(),
    preloadPeople: (progress) => agents.preloadPeople(progress),
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
    surfaceHeightAt(x, y) {
      const ground = terrain.renderedHeightAt(x, y);
      if (!elevation) return ground;
      let top = ground;
      // The road at grade and the decks are asked apart: where an overpass
      // crosses a street, the street's centreline is the nearer of the two.
      for (const set of SURFACE_SETS) {
        if (!elevation.has(set)) continue;
        const road = elevation.roadAt(x, y, set);
        if (road.type < 0 || Math.abs(road.across) > road.half) continue;
        top = Math.max(top, elevation.at(x, y, set));
      }
      return top;
    },
    pavedHeightAt,
    setBuildingPreview(preview) {
      buildings.setPreview(preview);
    },
    setPerspective(on) {
      if (on === rig.perspective) return;
      rig.setPerspective(on);
      // The passes hold the camera they were made with.
      post.dispose();
      post = createPostChain(renderer, scene, rig.camera, quality, governor.current);
      post.setNight(Math.max(0, lastDark));
      resize();
      onAssetsReady();
    },
    setSkyMode(mode) {
      // Read by the next frame drawn.
      skyMode = mode;
    },
    setBuildingCutaway(spec) {
      buildings.setCutaway(spec);
      cutSpec = spec;
    },
    setBuildingsDimmed(except) {
      buildings.setDimmed(except === undefined ? undefined : (except as BuildingId | null));
    },
    elevationAt(x, y, structure) {
      if (!elevation) return terrain.renderedHeightAt(x, y);
      return elevation.at(x, y, structure ? new Set([structure]) : undefined);
    },
    resize,
    draw(net, sim, alpha, delta, options) {
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
          shapeGround(net);
          terrainMs = performance.now() - terrainStarted;
        }
      } else {
        rebuildWorld(net);
      }
      // A building placed, moved or reshaped grades its own site.
      if (gradedFor !== net.doc.buildings.revision) shapeGround(net);
      buildings.update(net.doc, terrain.renderedHeightAt, `${net.doc.terrainRevision}:${rebuilds}`, pavedHeightAt);
      if (scenery && (excludedFor.scenery !== scenery || excludedFor.version !== buildings.version)) {
        scenery.exclude(net.doc.buildings.size > 0 ? buildings.covers : null);
        excludedFor = { scenery, version: buildings.version };
      }
      const gardenKey = `${buildings.version}:${gradedFor}:${net.doc.terrainRevision}:${rebuilds}`;
      if (gardenKey !== gardensFor) {
        gardensFor = gardenKey;
        if (gardens) {
          for (const mesh of gardens.meshes) world.remove(mesh);
          gardens.dispose();
        }
        gardens = buildGardens(gardenPlants(net.doc.buildings.all(), terrain.renderedHeightAt), sceneryKit);
        for (const mesh of gardens.meshes) world.add(mesh);
      }
      // Every shader the scene needs, compiled ahead and in parallel (the
      // browser's KHR_parallel_shader_compile): checked every two seconds for
      // materials not seen yet - hidden ones too, and what was added since (a
      // vehicle model, a body). Left to the first frame a material is drawn
      // in, that frame stalled for a quarter to half a second.
      if (!compiling && performance.now() - compileCheckedAt > 2000) {
        compileCheckedAt = performance.now();
        const hidden: Object3D[] = [];
        let fresh = false;
        scene.traverse((o) => {
          const material = (o as Mesh).material as Material | Material[] | undefined;
          if (material) for (const m of Array.isArray(material) ? material : [material]) if (!compiledMaterials.has(m)) { compiledMaterials.add(m); fresh = true; }
          if (!o.visible) { hidden.push(o); o.visible = true; }
        });
        if (fresh) {
          compiling = true;
          // compileAsync gathers what to compile at once; the scene is shown
          // as it was straight after.
          // For the target the scene is drawn into (`drainCompiles`).
          const previous = renderer.getRenderTarget();
          renderer.setRenderTarget(post.target);
          void renderer.compileAsync(scene, rig.camera).catch(() => {}).finally(() => { compiling = false; });
          renderer.setRenderTarget(previous);
        }
        for (const o of hidden) o.visible = false;
      }

      const detailed = rig.viewport.zoom >= quality.detailCutoffZoom;
      // A window frame's bar is about 0.14 u: under half a pixel below this zoom.
      buildings.setFar(rig.viewport.zoom < 3);
      if (roads) roads.group.visible = true;
      if (details) details.group.visible = true;
      for (const mesh of scenery?.meshes ?? []) mesh.visible = quality.detailProps && detailed;
      for (const mesh of gardens?.meshes ?? []) mesh.visible = detailed;
      gardens?.setNear(rig.viewport.zoom >= PLANT_NEAR_ZOOM);
      gardens?.setMap(rig.viewport.zoom < PLANT_MAP_ZOOM);
      if (scenery) {
        scenery.grass.visible = quality.detailProps && rig.viewport.zoom >= GRASS_MIN_ZOOM;
        scenery.setNear(rig.viewport.zoom >= PLANT_NEAR_ZOOM);
        scenery.setMap(rig.viewport.zoom < PLANT_MAP_ZOOM);
      }
      // The wind blows in real time: a paused simulation is still a windy day.
      windClock += Math.min(0.1, Math.max(0, delta));
      advanceWind(windClock);

      crowdProjection.multiplyMatrices(rig.camera.projectionMatrix, rig.camera.matrixWorldInverse);
      crowdFrustum.setFromProjectionMatrix(crowdProjection);
      // Plants and street furniture outside the view are not drawn at all.
      scenery?.cull(crowdFrustum, crowdProjection);
      gardens?.cull(crowdFrustum, crowdProjection);
      agents.sync(sim, alpha, detailed, rig.viewport.zoom, {
        pedestrianDetail: quality.pedestrianDetail,
        pedestrianVisible,
        vehicleVisible,
        occupantZoom: quality.occupantZoom,
        indoor: indoors.figures(sim, cutSpec, terrain.renderedHeightAt, pavedHeightAt),
      });
      // The rooms cut open are lit from inside: brighter as the day goes.
      const key = cutSpec ? `${cutSpec.level}@${cutSpec.x},${cutSpec.y}:${sim.doc.buildings.revision}` : '';
      if (key !== lampsKey) {
        lampsKey = key;
        const lamps = indoors.lamps(sim, cutSpec, terrain.renderedHeightAt, pavedHeightAt, ROOM_LIGHTS);
        roomLights.forEach((light, i) => {
          const at = lamps[i];
          light.userData['used'] = !!at;
          if (at) light.position.set(at.x, at.z, -at.y);
        });
      }
      for (const light of roomLights) light.intensity = cutSpec && light.userData['used'] ? 55 * (0.25 + 0.75 * lastDark) : 0;
      signals.sync(sim, detailed);

      target.copy(rig.target);
      const halfHeight = canvas.clientHeight / Math.max(0.001, rig.viewport.zoom * 2);
      const halfWidth = (halfHeight * canvas.clientWidth) / Math.max(1, canvas.clientHeight);
      // The screen's height covers more ground the lower the camera looks: the
      // shadows are fitted to the ground seen, not to the screen.
      // In perspective the far edge of the view takes in more ground than the
      // near: the shadows reach that far too.
      const reach = rig.perspective ? 1.6 : 1;
      const groundHalfDepth = (reach * halfHeight) / Math.max(0.3, Math.sin(rig.viewport.elevation));
      // The top of the tallest building, once per rebuild of the layer: the
      // shadows must reach as high as anything stands, or every terrace and
      // upper floor seen at close zoom lies outside the shadow map, in sun.
      if (tallestFor !== buildings.version) {
        tallestFor = buildings.version;
        tallestBox.setFromObject(buildings.group);
        tallestTop = tallestBox.isEmpty() ? 0 : tallestBox.max.y;
      }
      // The windows of the rooms people are in, and awake in, are lit; the rest
      // are dark (`buildings/lightSlots.ts`). Once a second of play is enough.
      if (performance.now() - litAt > 1000) {
        litAt = performance.now();
        updateLitRooms(sim);
      }
      // Day and night, by the residents' clock (`sim/city`).
      const clock = skyMode === 'day' ? 13 * 60 : skyMode === 'night' ? 22 * 60 : sim.city.minutes(sim);
      const dark = environment.setTimeOfDay(clock);
      if (Math.abs(dark - lastDark) > 0.01) {
        lastDark = dark;
        post.setNight(dark);
        buildings.setNight(dark);
        sceneryKit.setNight(dark);
        agents.setNight(dark);
      }
      rig.camera.getWorldDirection(viewDirection);
      environment.follow(target, halfWidth, groundHalfDepth, viewDirection, Math.max(0, tallestTop - target.y));
      // What the simulation must show in full: people step round each other
      // only where they are seen, and big enough to see it (`SimWorld.focus`).
      sim.focus = {
        x: target.x,
        y: -target.z,
        r: Math.hypot(halfWidth, groundHalfDepth) + m(20),
        detail: rig.viewport.zoom * m(1.7) >= 10,
      };

      renderer.shadowMap.needsUpdate = true;
      // Cheap (a few hundred objects), and it follows meshes a rebuild or an
      // asset load adds, and instance colours created on first use.
      if (renderer.shadowMap.enabled) assignShadowDepth(scene);
      post.render(delta);
      // One waiting texture a frame to the GPU, before anybody draws it.
      drainUploads(renderer, 1);
      drainCompiles(renderer, rig.camera, scene, post.target);

      if (delta > 0) fps = fps * 0.9 + (1 / Math.min(1, delta)) * 0.1;
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
      gardens?.dispose();
      sceneryKit.dispose();
      terrain.dispose();
      materials.dispose();
      environment.dispose();
      post.dispose();
      renderer.dispose();
    },
  };
}
