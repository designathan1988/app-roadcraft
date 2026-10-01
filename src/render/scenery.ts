import {
  Color,
  DoubleSide,
  DynamicDrawUsage,
  Frustum,
  InstancedMesh,
  Matrix4,
  Sphere,
  Vector3,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  type BufferGeometry,
  type Group,
  type Material,
  type MeshDepthMaterial,
} from 'three';

import { Rng } from '@core/rng';
import { angleOf } from '@core/vec2';
import type { Network } from '@world/network';
import type { RoadElevation } from '@world/elevation';
import { GROUND_ONLY } from '@world/elevation';
import { streetFurniture, type FurnitureItem, type FurnitureKind } from '@world/streetFurniture';
import { FOOTWAY_RISE, casingHalf } from '@world/roadTypes';
import { m } from '@world/units';
import { TERRAIN_HALF } from './terrain';
import { MEDIAN_PLANTING } from './roadSurfaces';
import { buildGrass, type GrassField } from './grass';
import { applyWind, windDepthMaterial, type WindResponse } from './wind';
import { applyFoliageShading } from './foliageShading';
import {
  BUSH_KINDS,
  TREE_SPECIES,
  benchGeometry,
  binGeometry,
  bushGeometry,
  grassTuftGeometry,
  hydrantGeometry,
  lampGeometry,
  lampLensGeometry,
  postboxGeometry,
  treeGeometry,
  treePitGeometry,
  trianglesOf,
  wildflowerGeometry,
  type BushKind,
  type TreeSpecies,
} from './propGeometry';

export { LAMP_HEIGHT, LAMP_OUTREACH } from './propGeometry';

/**
 * Everything standing on the ground that is not a road: street furniture,
 * street trees, vegetation and grass.
 *
 * There used to be a gantry arch at every map-edge stub, to mark where traffic
 * entered. It was a piece of scenery nobody asked for standing in the middle of
 * open country, and it is gone: a road that ends simply ends.
 *
 * Vegetation is here for a reason beyond decoration. An isometric view of an
 * open plain gives the eye nothing to judge distance or scale by, so the scene
 * reads as a flat map however good the ground material is. Objects of a KNOWN
 * height, scattered at a known density, are what turn the same image into a
 * landscape: they cast shadows across the terrain, they occlude one another with
 * distance, and they make a hill's far side legible.
 *
 * WHERE the furniture stands is not decided here: `world/streetFurniture.ts`
 * owns the layout, because the pedestrians have to walk around the same list.
 *
 * Everything is instanced — one draw call per model, whatever the count — and
 * every mesh carries a real bounding sphere so the frustum can reject it.
 * Models and materials live in a `SceneryKit` built once; a rebuild only
 * writes instance matrices.
 */

export const TREE_MIN_HEIGHT = m(6);
export const TREE_HEIGHT_RANGE = m(8);

/** Street trees are pollarded smaller than a tree in open ground. */
const STREET_TREE_MIN = m(6.5);
const STREET_TREE_RANGE = m(3);

/** Nothing is planted closer than this to the edge of a road's casing. */
const PLANT_CLEARANCE = 16;
/** Keeps a canopy from overhanging the edge of the terrain plate. */
const PLANT_EDGE_MARGIN = 24;
/**
 * Roadside planting: how often a spot along a road is tried, and how far past
 * the casing it may go. The open-ground scatter keeps well clear of every road
 * - right for a forest, and the reason a street used to run through a bare
 * lawn - so the band just beyond the verge is planted on its own.
 */
const ROADSIDE_STEP = 30;
const ROADSIDE_BAND = 26;
/** Plants tried per unit of road, as a share of the vegetation budget. */
const ROADSIDE_SHARE = 0.55;

/** How each kind of plant answers the wind; see `wind.ts`. */
const TREE_WIND: WindResponse = { sway: 0.03, flutter: 0.006 };
const BUSH_WIND: WindResponse = { sway: 0.05, flutter: 0.014 };
const GRASS_WIND: WindResponse = { sway: 0.22, flutter: 0.04 };

export interface SceneryKit {
  readonly trees: Record<TreeSpecies, BufferGeometry>;
  readonly bushes: Record<BushKind, BufferGeometry>;
  /** The same plants at map-zoom detail; see `Detail` in `propGeometry.ts`. */
  readonly treesFar: Record<TreeSpecies, BufferGeometry>;
  readonly bushesFar: Record<BushKind, BufferGeometry>;
  readonly furniture: Record<Exclude<FurnitureKind, 'streetTree' | 'medianShrub'>, BufferGeometry>;
  readonly lampLens: BufferGeometry;
  readonly treePit: BufferGeometry;
  readonly tuft: BufferGeometry;
  readonly flower: BufferGeometry;
  readonly foliage: MeshStandardMaterial;
  readonly foliageDepth: MeshDepthMaterial;
  readonly shrubs: MeshStandardMaterial;
  readonly shrubsDepth: MeshDepthMaterial;
  readonly grass: MeshStandardMaterial;
  readonly flowers: MeshStandardMaterial;
  readonly props: MeshStandardMaterial;
  readonly glow: MeshBasicMaterial;
  dispose(): void;
}

/** Builds every model and material once, at renderer start. */
export function createSceneryKit(): SceneryKit {
  const trees = Object.fromEntries(TREE_SPECIES.map((s) => [s, treeGeometry(s)])) as Record<TreeSpecies, BufferGeometry>;
  const bushes = Object.fromEntries(BUSH_KINDS.map((k) => [k, bushGeometry(k)])) as Record<BushKind, BufferGeometry>;
  const treesFar = Object.fromEntries(TREE_SPECIES.map((s) => [s, treeGeometry(s, 0)])) as Record<TreeSpecies, BufferGeometry>;
  const bushesFar = Object.fromEntries(BUSH_KINDS.map((k) => [k, bushGeometry(k, 0)])) as Record<BushKind, BufferGeometry>;
  const furniture = {
    lamp: lampGeometry(),
    bin: binGeometry(),
    bench: benchGeometry(),
    hydrant: hydrantGeometry(),
    postbox: postboxGeometry(),
  };
  const lampLens = lampLensGeometry();
  const treePit = treePitGeometry();
  const tuft = grassTuftGeometry();
  const flower = wildflowerGeometry();

  const foliage = new MeshStandardMaterial({ vertexColors: true, roughness: 0.82, metalness: 0 });
  applyWind(foliage, TREE_WIND, 'tree');
  applyFoliageShading(foliage, 34);
  const shrubs = new MeshStandardMaterial({ vertexColors: true, roughness: 0.86, metalness: 0 });
  applyWind(shrubs, BUSH_WIND, 'bush');
  applyFoliageShading(shrubs, 13);
  const grass = new MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0, side: DoubleSide });
  applyWind(grass, GRASS_WIND, 'grass');
  const flowers = new MeshStandardMaterial({ vertexColors: true, roughness: 0.8, metalness: 0, side: DoubleSide });
  applyWind(flowers, GRASS_WIND, 'flower');
  const props = new MeshStandardMaterial({ vertexColors: true, roughness: 0.62, metalness: 0.28 });
  const glow = new MeshBasicMaterial({ color: 0xffeec0, toneMapped: false });
  const foliageDepth = windDepthMaterial(TREE_WIND, 'tree');
  const shrubsDepth = windDepthMaterial(BUSH_WIND, 'bush');

  const geometries: BufferGeometry[] = [
    ...Object.values(trees),
    ...Object.values(bushes),
    ...Object.values(treesFar),
    ...Object.values(bushesFar),
    ...Object.values(furniture),
    lampLens,
    treePit,
    tuft,
    flower,
  ];
  const materials: Material[] = [foliage, shrubs, grass, flowers, props, glow, foliageDepth, shrubsDepth];
  return {
    trees,
    bushes,
    treesFar,
    bushesFar,
    furniture,
    lampLens,
    treePit,
    tuft,
    flower,
    foliage,
    foliageDepth,
    shrubs,
    shrubsDepth,
    grass,
    flowers,
    props,
    glow,
    dispose() {
      for (const geometry of geometries) geometry.dispose();
      for (const material of materials) material.dispose();
    },
  };
}

export interface Scenery {
  readonly meshes: readonly InstancedMesh[];
  /** Grass tufts and wildflowers, shown only at close zoom. */
  readonly grass: Group;
  readonly triangles: number;
  /**
   * Swaps every plant between its close-up model and its map-zoom model. A
   * geometry reference per mesh; nothing is rebuilt.
   */
  setNear(near: boolean): void;
  /**
   * Keeps only the instances the camera can see, or whose shadow it can.
   * `view` is the camera's projection times its inverse world matrix; nothing
   * is done while it is unchanged.
   */
  cull(frustum: Frustum, view: Matrix4): void;
  /**
   * Drops every tree and shrub whose trunk stands where `covered` says -
   * under a building (docs/buildings.md section 5) - from the instance cull.
   * Nothing is rebuilt; the next `cull` simply skips them. Null clears it.
   */
  exclude(covered: ((x: number, y: number) => boolean) | null): void;
  dispose(): void;
}

/**
 * How far outside the view an instance is still drawn, world units: the
 * longest shadow a tree can throw into the picture from beyond its edge.
 */
const SHADOW_REACH = 70;

/**
 * Every instance of one mesh, kept apart from what is drawn.
 *
 * Each species used to be ONE instanced mesh spread over the whole map, so
 * its bounding sphere was the map and nothing was ever off screen: zoomed in
 * on a crossroads, every bush on the map went to the GPU in close-up detail,
 * three times over (picture, shadow map, occlusion) - four million triangles
 * a frame, most of them outside the window. The instances in view are copied
 * to the front of the buffer when the camera moves, and only those are drawn.
 */
interface Instances {
  readonly matrices: Float32Array;
  readonly colours: Float32Array | null;
  /** Per instance: centre x, y, z and radius, in the scene's frame. */
  readonly spheres: Float32Array;
  readonly count: number;
}

/** Zoom at and above which plants are drawn with their close-up models. */
export const PLANT_NEAR_ZOOM = 1.4;

interface Placement {
  x: number;
  y: number;
  z: number;
  yaw: number;
  sx: number;
  sy: number;
  sz: number;
  tint?: Color;
}

function build(
  name: string,
  geometry: BufferGeometry,
  material: Material,
  placements: readonly Placement[],
  depth?: MeshDepthMaterial,
  near?: BufferGeometry,
): InstancedMesh | null {
  if (placements.length === 0) return null;
  const mesh = new InstancedMesh(geometry, material, placements.length);
  mesh.name = name;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  // Culled per instance instead (`Scenery.cull`): a sphere round the whole
  // map rejects nothing, and it would go stale when the model is swapped.
  mesh.frustumCulled = false;
  mesh.instanceMatrix.setUsage(DynamicDrawUsage);
  // The shadow pass bends with the wind too, or the shadows would lie still
  // under moving trees.
  if (depth) mesh.customDepthMaterial = depth;
  const object = new Object3D();
  let tinted = false;
  placements.forEach((placement, index) => {
    object.position.set(placement.x, placement.z, -placement.y);
    object.rotation.set(0, placement.yaw, 0);
    object.scale.set(placement.sx, placement.sy, placement.sz);
    object.updateMatrix();
    mesh.setMatrixAt(index, object.matrix);
    if (placement.tint) {
      mesh.setColorAt(index, placement.tint);
      tinted = true;
    }
  });
  mesh.instanceMatrix.needsUpdate = true;
  if (tinted && mesh.instanceColor) {
    mesh.instanceColor.setUsage(DynamicDrawUsage);
    mesh.instanceColor.needsUpdate = true;
  }
  mesh.computeBoundingSphere();

  // Every instance's bounding sphere, from the larger of the model's reach
  // and the plant's close-up model's (`setNear` swaps them).
  if (!geometry.boundingSphere) geometry.computeBoundingSphere();
  const reach = Math.max(geometry.boundingSphere?.radius ?? 1, near?.boundingSphere?.radius ?? 0);
  const centre = geometry.boundingSphere?.center ?? new Vector3();
  const spheres = new Float32Array(placements.length * 4);
  const point = new Vector3();
  const matrix = new Matrix4();
  for (let i = 0; i < placements.length; i++) {
    mesh.getMatrixAt(i, matrix);
    point.copy(centre).applyMatrix4(matrix);
    const p = placements[i] as Placement;
    spheres[i * 4] = point.x;
    spheres[i * 4 + 1] = point.y;
    spheres[i * 4 + 2] = point.z;
    spheres[i * 4 + 3] = reach * Math.max(p.sx, p.sy, p.sz);
  }
  instances.set(mesh, {
    matrices: Float32Array.from(mesh.instanceMatrix.array as Float32Array),
    colours: tinted && mesh.instanceColor ? Float32Array.from(mesh.instanceColor.array as Float32Array) : null,
    spheres,
    count: placements.length,
  });
  return mesh;
}

const instances = new WeakMap<InstancedMesh, Instances>();
const probe = new Sphere();

/** A near-white multiplier, so no two plants of one species are identical. */
function foliageTint(rng: Rng): Color {
  const warm = rng.float();
  return new Color(0.9 + warm * 0.18, 0.93 + rng.float() * 0.12, 0.86 + (1 - warm) * 0.14);
}

/** Picks a species for a tree in open ground. */
function wildSpecies(roll: number): TreeSpecies {
  if (roll < 0.3) return 'conifer';
  if (roll < 0.62) return 'broadleaf';
  if (roll < 0.88) return 'broadleafTall';
  return roll < 0.94 ? 'ipeYellow' : 'ipePink';
}

/** Picks a species for a street tree: mostly planes, some flowering ipês. */
function streetSpecies(roll: number): TreeSpecies {
  if (roll < 0.55) return 'broadleafTall';
  if (roll < 0.78) return 'broadleaf';
  return roll < 0.89 ? 'ipeYellow' : 'ipePink';
}

export interface ScenerySettings {
  /** Plants scattered over open ground. */
  readonly vegetation: number;
  /** Grass clumps. */
  readonly grass: number;
}

export function buildScenery(
  net: Network,
  elevation: RoadElevation,
  terrainAt: (x: number, y: number) => number,
  wetAt: (x: number, y: number) => boolean,
  settings: ScenerySettings,
  kit: SceneryKit,
): Scenery {
  const furniture = new Map<string, Placement[]>();
  const put = (key: string, placement: Placement): void => {
    const list = furniture.get(key);
    if (list) list.push(placement);
    else furniture.set(key, [placement]);
  };
  const trees = new Map<TreeSpecies, Placement[]>(TREE_SPECIES.map((s) => [s, []]));
  const bushes = new Map<BushKind, Placement[]>(BUSH_KINDS.map((k) => [k, []]));

  // ------------------------------------------------------ street furniture
  // On the item's OWN road. The unfiltered field answers for whichever road is
  // nearest, and a lamp on a street passing under a viaduct was lifted onto the
  // deck above it.
  const deckAt = (item: FurnitureItem): number =>
    elevation.onSegment(item.segment, item.x, item.y) + (item.on === 'median' ? MEDIAN_PLANTING : FOOTWAY_RISE);
  for (const item of streetFurniture(net)) {
    const base = deckAt(item);
    // Local +X of a lamp reaches over the road; local -Z of a bench, a post
    // box or a hydrant turns its back on the road.
    const inward = angleOf({ x: -item.outward.x, y: -item.outward.y });
    const facing = angleOf({ x: item.outward.y, y: -item.outward.x });
    const at = { x: item.x, y: item.y, z: base, sx: 1, sy: 1, sz: 1 };
    switch (item.kind) {
      case 'lamp':
        put('lamp', { ...at, yaw: inward });
        break;
      case 'bin':
        put('bin', { ...at, yaw: item.seed * Math.PI * 2 });
        break;
      case 'bench': {
        // Its seat faces where the layout says somebody sitting looks.
        const faces = item.faces ?? { x: -item.outward.x, y: -item.outward.y };
        put('bench', { ...at, yaw: angleOf({ x: -faces.y, y: faces.x }) });
        break;
      }
      case 'postbox':
      case 'hydrant':
        put(item.kind, { ...at, yaw: facing });
        break;
      case 'streetTree': {
        put('treePit', { ...at, yaw: angleOf(item.along) });
        const height = STREET_TREE_MIN + item.seed * STREET_TREE_RANGE;
        const rng = new Rng(Math.floor(item.seed * 0xffffff));
        (trees.get(streetSpecies(rng.float())) as Placement[]).push({
          x: item.x,
          y: item.y,
          z: base + m(0.03),
          yaw: rng.float() * Math.PI * 2,
          sx: height * (0.85 + rng.float() * 0.2),
          sy: height,
          sz: height * (0.85 + rng.float() * 0.2),
          tint: foliageTint(rng),
        });
        break;
      }
      case 'medianShrub': {
        const rng = new Rng(Math.floor(item.seed * 0xffffff));
        const height = m(0.8) + rng.float() * m(0.5);
        (bushes.get('hedge') as Placement[]).push({
          x: item.x,
          y: item.y,
          z: base - m(0.05),
          yaw: angleOf(item.along),
          sx: height * 1.1,
          sy: height,
          sz: height * 0.9,
          tint: foliageTint(rng),
        });
        break;
      }
    }
  }

  // ------------------------------------------------------------- vegetation
  if (settings.vegetation > 0) {
    const rng = new Rng(0x517a);
    const bounds = networkBounds(net);
    const spread = Math.max(900, Math.max(bounds.w, bounds.h) * 0.85);
    // The scatter window, clipped to the terrain plate. A margin keeps a
    // canopy from overhanging the edge even when its trunk is just inside.
    const limit = TERRAIN_HALF - PLANT_EDGE_MARGIN;
    const minX = Math.max(-limit, bounds.cx - spread);
    const maxX = Math.min(limit, bounds.cx + spread);
    const minY = Math.max(-limit, bounds.cy - spread);
    const maxY = Math.min(limit, bounds.cy + spread);
    // A network pushed entirely off the plate leaves no window to plant in.
    const attempts = maxX > minX && maxY > minY ? settings.vegetation * 3 : 0;
    const clear = (x: number, y: number, margin: number): boolean => {
      // Nothing grows on the carriageway or its verge.
      if (Math.abs(elevation.at(x, y, GROUND_ONLY) - terrainAt(x, y)) < 40) {
        const road = elevation.roadAt(x, y);
        if (Math.abs(road.across) < PLANT_CLEARANCE + margin) return false;
      }
      return true;
    };
    const bushAt = (x: number, y: number, scale: number): void => {
      const ground = terrainAt(x, y);
      const kind: BushKind = rng.float() < 0.26 ? 'bushFlowering' : 'bush';
      const height = (1.8 + rng.float() * 2.2) * scale;
      (bushes.get(kind) as Placement[]).push({
        x,
        y,
        z: ground - 0.15,
        yaw: rng.float() * Math.PI * 2,
        sx: height * (0.9 + rng.float() * 0.4),
        sy: height,
        sz: height * (0.9 + rng.float() * 0.4),
        tint: foliageTint(rng),
      });
    };
    const treeAt = (x: number, y: number, ground: number, species: TreeSpecies, scale = 1): void => {
      const height = (TREE_MIN_HEIGHT + rng.float() * TREE_HEIGHT_RANGE) * scale;
      (trees.get(species) as Placement[]).push({
        x,
        y,
        z: ground - 0.1,
        yaw: rng.float() * Math.PI * 2,
        sx: height * (0.82 + rng.float() * 0.36),
        sy: height,
        sz: height * (0.82 + rng.float() * 0.36),
        tint: foliageTint(rng),
      });
    };

    // The band just past each road's verge.
    for (const ribbon of net.ribbons.values()) {
      const length = ribbon.full.length;
      for (let s = 10 + rng.float() * ROADSIDE_STEP; s < length - 10; s += ROADSIDE_STEP * (0.7 + rng.float() * 0.6)) {
        for (const side of [-1, 1]) {
          if (rng.float() > ROADSIDE_SHARE) continue;
          const frame = ribbon.full.sampleAt(s);
          const out = casingHalf(ribbon.road) + 5 + rng.float() ** 1.4 * ROADSIDE_BAND;
          const x = frame.p.x + frame.n.x * out * side;
          const y = frame.p.y + frame.n.y * out * side;
          if (Math.abs(x) > limit || Math.abs(y) > limit) continue;
          // The nearest road may not be this one near a junction.
          const road = elevation.roadAt(x, y);
          if (road.type >= 0 && Math.abs(road.across) < road.half + 4) continue;
          if (wetAt(x, y)) continue;
          const ground = terrainAt(x, y);
          if (rng.float() < 0.5) {
            treeAt(x, y, ground, wildSpecies(rng.float() * 0.94 + 0.03), 0.85);
            if (rng.float() < 0.4) bushAt(x + frame.t.x * 4, y + frame.t.y * 4, 0.8);
          } else {
            // A loose group of shrubs, as a hedge line grows along a road.
            const count = 1 + Math.floor(rng.float() * 3);
            for (let k = 0; k < count; k++) {
              bushAt(x + frame.t.x * (k * 3.2 - 3), y + frame.t.y * (k * 3.2 - 3), 0.75 + rng.float() * 0.4);
            }
          }
        }
      }
    }

    let planted = 0;
    for (let i = 0; i < attempts && planted < settings.vegetation; i++) {
      const x = minX + rng.float() * (maxX - minX);
      const y = minY + rng.float() * (maxY - minY);
      if (!clear(x, y, 24)) continue;
      const ground = terrainAt(x, y);
      // Steep rock and rivers stay bare, which makes the slope readable.
      const slope =
        Math.abs(terrainAt(x + 6, y) - terrainAt(x - 6, y)) +
        Math.abs(terrainAt(x, y + 6) - terrainAt(x, y - 6));
      if (slope > 7 || wetAt(x, y)) continue;
      planted++;
      const scale = 0.75 + rng.float() * 0.6;
      if (rng.float() < 0.38) {
        bushAt(x, y, scale);
        continue;
      }
      treeAt(x, y, ground, wildSpecies(rng.float()));
      // Undergrowth: a tree in open ground rarely stands alone on bare turf.
      if (rng.float() < 0.35) {
        const a = rng.float() * Math.PI * 2;
        const d = 3 + rng.float() * 4;
        const bx = x + Math.cos(a) * d;
        const by = y + Math.sin(a) * d;
        if (clear(bx, by, 20)) bushAt(bx, by, 0.7);
      }
    }
  }

  const meshes = [
    build('street-lights', kit.furniture.lamp, kit.props, furniture.get('lamp') ?? []),
    build('street-light-lamps', kit.lampLens, kit.glow, furniture.get('lamp') ?? []),
    build('street-bins', kit.furniture.bin, kit.props, furniture.get('bin') ?? []),
    build('benches', kit.furniture.bench, kit.props, furniture.get('bench') ?? []),
    build('hydrants', kit.furniture.hydrant, kit.props, furniture.get('hydrant') ?? []),
    build('post-boxes', kit.furniture.postbox, kit.props, furniture.get('postbox') ?? []),
    build('tree-pits', kit.treePit, kit.props, furniture.get('treePit') ?? []),
  ].filter((mesh): mesh is InstancedMesh => mesh !== null);

  /** Each plant mesh with its two models, near first. */
  const plants: [InstancedMesh, BufferGeometry, BufferGeometry][] = [];
  const plant = (mesh: InstancedMesh | null, near: BufferGeometry, far: BufferGeometry): void => {
    if (!mesh) return;
    meshes.push(mesh);
    plants.push([mesh, near, far]);
  };
  for (const species of TREE_SPECIES) {
    plant(
      build(`trees-${species}`, kit.treesFar[species], kit.foliage, trees.get(species) ?? [], kit.foliageDepth,
        kit.trees[species]),
      kit.trees[species],
      kit.treesFar[species],
    );
  }
  for (const kind of BUSH_KINDS) {
    plant(
      build(`bushes-${kind}`, kit.bushesFar[kind], kit.shrubs, bushes.get(kind) ?? [], kit.shrubsDepth,
        kit.bushes[kind]),
      kit.bushes[kind],
      kit.bushesFar[kind],
    );
  }
  // The lens is lit from inside; it neither casts nor takes a shadow.
  for (const mesh of meshes) {
    if (mesh.name === 'street-light-lamps' || mesh.name === 'tree-pits') mesh.castShadow = false;
  }

  const grass: GrassField = buildGrass(net, elevation, terrainAt, wetAt, settings.grass, kit);

  let triangles = grass.triangles;
  for (const mesh of meshes) triangles += trianglesOf(mesh.geometry) * mesh.count;
  /** The view the instances were last culled for; null draws them all until the first. */
  let culledFor: Matrix4 | null = null;
  /** Plants standing under a building, per plant mesh; see `exclude`. */
  const excluded = new Map<InstancedMesh, Uint8Array>();

  return {
    meshes,
    grass: grass.group,
    triangles,
    setNear(near) {
      for (const [mesh, close, far] of plants) mesh.geometry = near ? close : far;
    },
    cull(frustum, view) {
      // Grass only when it is shown; it keeps its own record of the view.
      if (grass.group.visible) grass.cull(frustum, view);
      if (culledFor && culledFor.equals(view)) return;
      culledFor = (culledFor ?? new Matrix4()).copy(view);
      for (const mesh of meshes) {
        const all = instances.get(mesh);
        if (!all) continue;
        const matrices = mesh.instanceMatrix.array as Float32Array;
        const colours = all.colours && mesh.instanceColor ? mesh.instanceColor.array as Float32Array : null;
        let n = 0;
        const hidden = excluded.get(mesh);
        for (let i = 0; i < all.count; i++) {
          if (hidden && hidden[i]) continue;
          const s = all.spheres;
          probe.center.set(s[i * 4] as number, s[i * 4 + 1] as number, s[i * 4 + 2] as number);
          probe.radius = (s[i * 4 + 3] as number) + SHADOW_REACH;
          if (!frustum.intersectsSphere(probe)) continue;
          matrices.set(all.matrices.subarray(i * 16, i * 16 + 16), n * 16);
          if (colours && all.colours) colours.set(all.colours.subarray(i * 3, i * 3 + 3), n * 3);
          n++;
        }
        mesh.count = n;
        mesh.instanceMatrix.clearUpdateRanges();
        if (n > 0) mesh.instanceMatrix.addUpdateRange(0, n * 16);
        mesh.instanceMatrix.needsUpdate = true;
        if (colours && mesh.instanceColor) {
          mesh.instanceColor.clearUpdateRanges();
          if (n > 0) mesh.instanceColor.addUpdateRange(0, n * 3);
          mesh.instanceColor.needsUpdate = true;
        }
      }
    },
    exclude(covered) {
      excluded.clear();
      culledFor = null;
      if (!covered) return;
      for (const [mesh] of plants) {
        const all = instances.get(mesh);
        if (!all) continue;
        const flags = new Uint8Array(all.count);
        let any = false;
        for (let i = 0; i < all.count; i++) {
          // Sphere centres are in three's axes: world y is -z.
          if (covered(all.spheres[i * 4] as number, -(all.spheres[i * 4 + 2] as number))) {
            flags[i] = 1;
            any = true;
          }
        }
        if (any) excluded.set(mesh, flags);
      }
    },
    dispose() {
      // The InstancedMesh itself owns GPU buffers for its matrices and its
      // colours, and they are not freed by disposing the geometry. Every
      // rebuild - and a rebuild happens on every edit - leaked one set per
      // mesh. Geometry and materials are the kit's, and outlive the rebuild.
      for (const mesh of meshes) mesh.dispose();
      grass.dispose();
    },
  };
}

function networkBounds(net: Network): { cx: number; cy: number; w: number; h: number } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const node of net.doc.nodes.values()) {
    if (node.x < minX) minX = node.x;
    if (node.y < minY) minY = node.y;
    if (node.x > maxX) maxX = node.x;
    if (node.y > maxY) maxY = node.y;
  }
  if (!Number.isFinite(minX)) return { cx: 0, cy: 0, w: 800, h: 800 };
  return {
    cx: (minX + maxX) / 2,
    cy: (minY + maxY) / 2,
    w: maxX - minX,
    h: maxY - minY,
  };
}
