import {
  BufferGeometry,
  Color,
  Float32BufferAttribute,
  FrontSide,
  Mesh,
  MeshStandardMaterial,
  PlaneGeometry,
  type Texture,
} from 'three';

import type { RoadDoc } from '@world/doc';
import { MAP_SIZE } from '@world/bounds';
import {
  MAX_TERRAIN_STAMPS,
  TERRAIN_WATER_HEIGHT,
  TerrainIndex,
  sampleTerrainHeight,
  terrainInfluence,
  type TerrainStamp,
} from '@world/terrain';
import { bakeSurface, fbm, makeNoise, type SurfaceBake } from './mesh/textureBaker';
import { DETAIL_GLSL, detailSwitch, detailTextures } from './mesh/detailLayer';
import { WATER_DEPTH_ATTRIBUTE, createWaterSurface } from './water';

/**
 * Side of the playable, editable terrain plate, in world units.
 *
 * The world the editor authors in is 4096 units across. The plate is a little
 * wider so the player never reaches its rim, and a separate, cheap backdrop
 * carries the view out to the horizon beyond it — a single large plate at the
 * resolution the play area needs would be most of the frame's vertex budget
 * spent on ground nobody builds on.
 */
const TERRAIN_SIZE = MAP_SIZE;
/** Cells per side. 300 gives a 16-unit cell: 6.4 m, fine enough for a brush. */
const TERRAIN_SEGMENTS = 300;
const TERRAIN_BASE = -0.12;

/** Radius of a river's water disc, as a fraction of the stamp that carved it. */
const WATER_RADIUS = 0.92;
/** How far past the brush the surface may reach to find its shore. */
const WATER_SPREAD = 1.6;
/** Share of a channel's depth the water fills, measured down from its banks. */
const WATER_FILL = 0.3;
/** How far under the ground the surface stays, so its rim is never left dry. */
const WATER_MARGIN = 0.4;
/** Grid resolution of the unified river surface. */
const WATER_CELL = 4;

/**
 * World size of one terrain quad.
 *
 * The terrain mesh holds one vertex per cell and interpolates linearly between
 * them, so anything laid on the ground must be tessellated to at most this step
 * or it chords across a bump it never sampled.
 */
export const TERRAIN_CELL = TERRAIN_SIZE / TERRAIN_SEGMENTS;

/** Corners per side of the terrain grid — one more than its cells. */
const GRID = TERRAIN_SEGMENTS + 1;
/**
 * Half the terrain plate's extent. Nothing may be placed outside it.
 *
 * The ground is a finite 4800-unit plate. Anything scattered beyond it hangs
 * in the void with no surface under it, which is exactly what happened to the
 * vegetation: it was spread over `max(900, networkBounds * 0.85)` about the
 * network centre with no reference to the terrain at all, so a network near an
 * edge planted trees off the end of the world.
 */
export const TERRAIN_HALF = TERRAIN_SIZE / 2;

export interface TerrainSurface {
  readonly meshes: readonly Mesh[];
  readonly ground: Mesh;
  /** The analytic height field: the smooth surface the stamps describe. */
  heightAt(x: number, y: number): number;
  /**
   * The ground as DRAWN, before any road cut or filled it.
   *
   * This is what the road profile is solved against. Solving it against the
   * shaped surface instead would feed the roads their own previous answer, and
   * the ground and the road would chase each other a little further apart on
   * every rebuild.
   */
  naturalRenderedHeightAt(x: number, y: number): number;
  /**
   * The height the terrain is actually DRAWN at.
   *
   * The mesh samples the field at cell corners and interpolates linearly across
   * the triangles between them, so the drawn surface differs from the field by
   * up to `(cell^2 / 8) * |H''|`. Anything laid on the ground must clear what is
   * on screen, not what the field says, or it sinks into a triangle.
   */
  renderedHeightAt(x: number, y: number): number;
  /**
   * Whether a point is under a river's water.
   *
   * NOT "the ground is low": the base relief dips well below zero over whole
   * valleys with no water in them, and planting was skipped wherever it did -
   * which left the ground around a crossroads in such a valley bare.
   */
  wetAt(x: number, y: number): boolean;
  /**
   * Rewrites the heightfield from the document's stamps alone.
   *
   * The first half of a two-pass build. Roads are solved against THIS surface,
   * because a road has to be laid on the natural ground before the ground can
   * be asked to come and meet it.
   */
  update(doc: RoadDoc): boolean;
  /**
   * Cuts and fills the ground so it meets the roads.
   *
   * The second half. `shape` is the solved road field; every corner inside a
   * road's corridor is pulled to the road's subgrade, and the difference is
   * carried back to the natural ground over a wide batter. Returns true when
   * anything moved, so the caller knows whether the water needs rebuilding.
   */
  shapeToRoads(shape: TerrainShaper | null): boolean;
  dispose(): void;
}

/** What `shapeToRoads` needs to know about the road network. */
export interface TerrainShaper {
  shapeAt(x: number, y: number, naturalGround: number): { height: number; weight: number };
}

function terrainBakes(anisotropy: number): {
  grass: SurfaceBake;
  rock: SurfaceBake;
  dirt: SurfaceBake;
} {
  const grassFine = makeNoise(0x1234);
  const grassClump = makeNoise(0x9f2c);
  const grass = bakeSurface(
    'terrain-grass',
    {
      size: 512,
      worldSize: 42,
      relief: 2.2,
      shade: (x, y, out) => {
        const u = x / 512;
        const v = y / 512;
        const fine = fbm(grassFine, u * 170, v * 170, 170, 2);
        const clump = fbm(grassClump, u * 11, v * 11, 11, 4);
        const dry = clump > 0.58 ? (clump - 0.58) * 2.4 : 0;
        const moss = clump < 0.4 ? (0.4 - clump) * 1.6 : 0;
        out.r = 0.13 + fine * 0.08 + dry * 0.3 + clump * 0.04;
        out.g = 0.21 + fine * 0.12 + clump * 0.1 + dry * 0.2 - moss * 0.03;
        out.b = 0.075 + fine * 0.05 + dry * 0.09 + moss * 0.02;
        out.h = fine * 0.65 + clump * 0.35;
        out.rough = 0.99;
      },
    },
    anisotropy,
  );

  const rockCrack = makeNoise(0x5ac1);
  const rockGrain = makeNoise(0x77b3);
  const rock = bakeSurface(
    'terrain-rock',
    {
      size: 512,
      worldSize: 58,
      relief: 4.6,
      shade: (x, y, out) => {
        const u = x / 512;
        const v = y / 512;
        const strata = fbm(rockCrack, u * 7, v * 22, 7, 4);
        const grain = fbm(rockGrain, u * 110, v * 110, 110, 3);
        const crack = Math.abs(strata - 0.5) < 0.045 ? 1 : 0;
        const tone = 0.38 + (grain - 0.5) * 0.16 + strata * 0.16 - crack * 0.18;
        out.r = tone * 1.04;
        out.g = tone * 0.99;
        out.b = tone * 0.92;
        out.h = crack ? 0.05 : 0.35 + strata * 0.4 + grain * 0.25;
        out.rough = 0.92;
      },
    },
    anisotropy,
  );

  const dirtGrain = makeNoise(0x3311);
  const dirt = bakeSurface(
    'terrain-dirt',
    {
      size: 256,
      worldSize: 34,
      relief: 2.4,
      shade: (x, y, out) => {
        const u = x / 256;
        const v = y / 256;
        const grain = fbm(dirtGrain, u * 90, v * 90, 90, 3);
        const patch = fbm(dirtGrain, u * 8 + 3, v * 8 + 9, 8, 3);
        const tone = 0.34 + (grain - 0.5) * 0.14 + patch * 0.1;
        out.r = tone * 1.22;
        out.g = tone * 0.96;
        out.b = tone * 0.68;
        out.h = grain * 0.7 + patch * 0.3;
        out.rough = 0.97;
      },
    },
    anisotropy,
  );

  return { grass, rock, dirt };
}

/**
 * The terrain material: three surfaces blended by slope, height and noise.
 *
 * One texture stretched over four kilometres of ground is what made the terrain
 * read as painted paper. Three fixes are layered here, and each is visible on
 * its own:
 *
 *  - **Slope decides the surface.** Anything steeper than about 25 degrees is
 *    rock, which is what actually gives a hill a silhouette: the colour change
 *    follows the geometry, so a slope is legible even when the sun is behind it.
 *  - **Two scales of the same texture.** Each map is sampled at its own size and
 *    again eight times larger, and the two are mixed. The large sample breaks
 *    the repeat that the eye otherwise locks on to from far away.
 *  - **Macro variation.** A slow noise tints wide regions warm or cool, so the
 *    ground has weather in it rather than one flat green.
 */
function terrainMaterial(
  bakes: {
    grass: SurfaceBake;
    rock: SurfaceBake;
    dirt: SurfaceBake;
  },
  anisotropy: number,
): MeshStandardMaterial {
  const material = new MeshStandardMaterial({
    color: 0xffffff,
    map: bakes.grass.map,
    normalMap: bakes.grass.normalMap,
    roughness: 1,
    metalness: 0,
    side: FrontSide,
    envMapIntensity: 0.4,
  });
  material.normalScale.set(1.35, 1.35);

  const grassDetail = detailTextures('grass', anisotropy);
  const soilDetail = detailTextures('soil', anisotropy);
  const uniforms = {
    uRockMap: { value: bakes.rock.map as Texture },
    uRockNormal: { value: bakes.rock.normalMap as Texture },
    uDirtMap: { value: bakes.dirt.map as Texture },
    uGrassScale: { value: 1 / 42 },
    uRockScale: { value: 1 / 58 },
    uDirtScale: { value: 1 / 34 },
    // The close-zoom layer (see `mesh/detailLayer.ts`): blades over grass,
    // grit over dirt and rock, faded in by pixel footprint.
    uDetailOn: detailSwitch,
    uGrassDetail: { value: grassDetail.map },
    uGrassDetailN: { value: grassDetail.normalMap },
    uGrassDetailScale: { value: 1 / grassDetail.worldSize },
    uSoilDetail: { value: soilDetail.map },
    uSoilDetailN: { value: soilDetail.normalMap },
    uSoilDetailScale: { value: 1 / soilDetail.worldSize },
  };

  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
         varying vec3 vTerrainWorld;
         varying vec3 vTerrainNormal;`,
      )
      .replace(
        '#include <worldpos_vertex>',
        `#include <worldpos_vertex>
         vTerrainWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;
         vTerrainNormal = normalize(mat3(modelMatrix) * objectNormal);`,
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
         varying vec3 vTerrainWorld;
         varying vec3 vTerrainNormal;
         uniform sampler2D uRockMap;
         uniform sampler2D uRockNormal;
         uniform sampler2D uDirtMap;
         uniform float uGrassScale;
         uniform float uRockScale;
         uniform float uDirtScale;
         uniform sampler2D uGrassDetail;
         uniform sampler2D uGrassDetailN;
         uniform float uGrassDetailScale;
         uniform sampler2D uSoilDetail;
         uniform sampler2D uSoilDetailN;
         uniform float uSoilDetailScale;
         ${DETAIL_GLSL}

         // Set once per fragment, before the first dualScale read: how far the
         // close-zoom layer has taken over, and so how much softer to read the
         // magnified macro maps.
         float terrainDetailW = 0.0;

         // Detail plus a sample eight times wider, so the tile never repeats
         // visibly at the distances this camera works at.
         vec4 dualScale(sampler2D tex, vec2 uv) {
           vec4 near = texture2D(tex, uv, terrainDetailW * 2.2);
           vec4 far = texture2D(tex, uv * 0.125);
           return mix(near, far, 0.42);
         }`,
      )
      .replace(
        '#include <map_fragment>',
        `terrainDetailW = detailWeight(vTerrainWorld.xz);
         vec2 tGrass = vTerrainWorld.xz * uGrassScale;
         vec2 tRock = vTerrainWorld.xz * uRockScale;
         vec2 tDirt = vTerrainWorld.xz * uDirtScale;
         // In DEGREES, not in one-minus-cosine. The cosine of a small angle is
         // almost one, so thresholds written against it are unreadable and were
         // simply wrong: a 10-degree hillside came out at 0.015, under a
         // threshold meant to start at a gentle slope, and the whole map stayed
         // one flat green however steep it got.
         float slopeDeg = degrees(acos(clamp(vTerrainNormal.y, 0.0, 1.0)));
         float rockMix = smoothstep(26.0, 42.0, slopeDeg);
         float dirtMix = smoothstep(9.0, 26.0, slopeDeg) * (1.0 - rockMix) * 0.8;
         vec4 grassColor = dualScale(map, tGrass);
         vec4 rockColor = dualScale(uRockMap, tRock);
         vec4 dirtColor = dualScale(uDirtMap, tDirt);
         vec4 blended = mix(grassColor, dirtColor, dirtMix);
         blended = mix(blended, rockColor, rockMix);
         if (terrainDetailW > 0.001) {
           vec3 bladeDetail = detailSample(uGrassDetail, vTerrainWorld.xz * uGrassDetailScale);
           vec3 soilDetail = detailSample(uSoilDetail, vTerrainWorld.xz * uSoilDetailScale);
           float soilMix = clamp(dirtMix + rockMix, 0.0, 1.0);
           vec3 fine = mix(bladeDetail, soilDetail, soilMix);
           blended.rgb *= mix(vec3(1.0), fine, terrainDetailW);
         }
         // Wide, slow tint so whole regions read warm or cool.
         float macro = texture2D(uDirtMap, vTerrainWorld.xz * 0.0009).r;
         blended.rgb *= mix(0.84, 1.16, macro);
         // A hillshade written into the ALBEDO, on top of the light the surface
         // actually receives. Direct sun alone moves a 10-degree slope by about
         // a tenth, which is under what the eye reads as shape at map zoom; this
         // doubles that for the slopes that carry the landform and leaves flat
         // ground untouched, so the hills are legible without the scene turning
         // into a relief map.
         float relief = clamp(dot(normalize(vTerrainNormal), normalize(vec3(0.24, 0.62, -0.75))), -1.0, 1.0);
         blended.rgb *= 1.0 + relief * 0.34 * smoothstep(1.0, 10.0, slopeDeg);
         // Higher ground dries out, low ground stays lush.
         float dryness = smoothstep(4.0, 26.0, vTerrainWorld.y);
         blended.rgb = mix(blended.rgb, blended.rgb * vec3(1.16, 1.07, 0.8), dryness * 0.6);
         // Hollows hold moisture and read darker, which is the cue that tells a
         // dip from a rise when the sun is behind the slope.
         float damp = smoothstep(2.0, -9.0, vTerrainWorld.y);
         blended.rgb *= mix(1.0, 0.78, damp * 0.7);
         diffuseColor *= blended;`,
      )
      .replace(
        '#include <normal_fragment_maps>',
        `vec3 grassN = dualScale(normalMap, vTerrainWorld.xz * uGrassScale).xyz * 2.0 - 1.0;
         vec3 rockN = dualScale(uRockNormal, vTerrainWorld.xz * uRockScale).xyz * 2.0 - 1.0;
         vec3 mapN = normalize(mix(grassN, rockN, rockMix));
         mapN.xy *= normalScale;
         if (terrainDetailW > 0.001) {
           vec3 bladeN = detailNormal(uGrassDetailN, vTerrainWorld.xz * uGrassDetailScale);
           vec3 soilN = detailNormal(uSoilDetailN, vTerrainWorld.xz * uSoilDetailScale);
           vec3 fineN = mix(bladeN, soilN, clamp(dirtMix + rockMix, 0.0, 1.0));
           mapN.xy += fineN.xy * 1.2 * terrainDetailW;
         }
         normal = normalize(tbn * mapN);`,
      );
  };
  // A changed program key forces three to compile this variant separately from
  // any other standard material in the scene.
  material.customProgramCacheKey = () => 'terrain-splat-v2';
  return material;
}

export function createTerrainSurface(anisotropy: number): TerrainSurface {
  const bakes = terrainBakes(anisotropy);
  const material = terrainMaterial(bakes, anisotropy);

  const geometry = new PlaneGeometry(TERRAIN_SIZE, TERRAIN_SIZE, TERRAIN_SEGMENTS, TERRAIN_SEGMENTS);
  geometry.rotateX(-Math.PI / 2);
  const ground = new Mesh(geometry, material);
  ground.name = 'terrain-ground';
  ground.receiveShadow = true;
  // The ground does NOT cast.
  //
  // It is a single 301x301 heightfield - 180 000 triangles - and casting meant
  // rasterising every one of them a second time into the shadow map each
  // frame. What that bought was self-shadowing across one wide cascade whose
  // texels are around a world unit across at play zoom, which does not resolve
  // a hillside; what it actually produced was acne, the irregular dark
  // diagonal banding on open grass that has nothing casting it. Roads,
  // structures, props and agents all still cast onto the ground, which is
  // every shadow the player is actually looking at.
  ground.castShadow = false;
  ground.matrixAutoUpdate = false;
  ground.updateMatrix();

  // Land beyond the editable plate, so the map does not end in mid-air.
  //
  // It is a FRAME, not a plane. A plane under the plate is the wrong shape: the
  // plate's own ground dips below it wherever the base relief goes negative, and
  // the plane then draws straight over the terrain, the roads and everything on
  // them — which is exactly how a full plane hid most of the road network behind
  // a grey sheet. A frame occupies only the ground the plate does not.
  const backdrop = new Mesh(
    frameGeometry(TERRAIN_HALF, 13_000, TERRAIN_BASE - 3.5),
    new MeshStandardMaterial({ color: new Color(0x53694a), roughness: 1, metalness: 0 }),
  );
  backdrop.name = 'terrain-backdrop';
  backdrop.receiveShadow = false;
  backdrop.matrixAutoUpdate = false;
  backdrop.updateMatrix();

  const waterSurface = createWaterSurface(anisotropy);
  const water = new Mesh(new BufferGeometry(), waterSurface.material);
  water.name = 'terrain-water';
  water.receiveShadow = false;
  water.castShadow = false;
  water.matrixAutoUpdate = false;
  water.updateMatrix();
  // The river animates itself from here on: nothing in the draw loop has to
  // know that the terrain owns something with a clock in it.
  waterSurface.attach(water);

  let index = new TerrainIndex([], 0);
  let revision = -1;

  /** The land the player sculpted, with no road in it. */
  const naturalHeightAt = (x: number, y: number): number =>
    TERRAIN_BASE + sampleTerrainHeight(index, x, y);

  // The heights the mesh actually carries, one per grid corner, so
  // `renderedHeightAt` interpolates exactly the numbers that are on screen.
  const grid = new Float64Array(GRID * GRID);
  /** The same corners before any road shaped them, so shaping is idempotent. */
  const natural = new Float64Array(GRID * GRID);
  /** Corners a road has moved, so an unshaped one can be restored cheaply. */
  let shapedCorners: number[] = [];
  let lastStamps: readonly TerrainStamp[] = [];

  const heightAt = naturalHeightAt;

  /** Bilinear read of one corner array, reproducing the plane's own diagonal. */
  const sampleGrid = (corners: Float64Array, x: number, y: number): number => {
    if (!(x >= -TERRAIN_HALF && x <= TERRAIN_HALF && y >= -TERRAIN_HALF && y <= TERRAIN_HALF)) {
      return naturalHeightAt(x, y);
    }
    // `PlaneGeometry` lays its rows from +y downwards, so the row index grows as
    // world y falls.
    const gx = (x + TERRAIN_HALF) / TERRAIN_CELL;
    const gy = (TERRAIN_HALF - y) / TERRAIN_CELL;
    const ix = Math.min(TERRAIN_SEGMENTS - 1, Math.floor(gx));
    const iy = Math.min(TERRAIN_SEGMENTS - 1, Math.floor(gy));
    const u = gx - ix;
    const v = gy - iy;
    const a = corners[ix + iy * GRID] as number;
    const b = corners[ix + (iy + 1) * GRID] as number;
    const c = corners[ix + 1 + (iy + 1) * GRID] as number;
    const d = corners[ix + 1 + iy * GRID] as number;
    // Each cell is split into (a, b, d) and (b, c, d): the diagonal runs b-d.
    return u + v <= 1 ? a * (1 - u - v) + d * u + b * v : b * (1 - u) + c * (u + v - 1) + d * (1 - v);
  };

  const renderedHeightAt = (x: number, y: number): number => sampleGrid(grid, x, y);
  const naturalRenderedHeightAt = (x: number, y: number): number => sampleGrid(natural, x, y);

  const position = geometry.getAttribute('position');

  const rewrite = (x0: number, x1: number, y0: number, y1: number): void => {
    for (let iy = y0; iy <= y1; iy++) {
      for (let ix = x0; ix <= x1; ix++) {
        const i = iy * GRID + ix;
        const x = position.getX(i);
        const worldY = -position.getZ(i);
        const height = naturalHeightAt(x, worldY);
        position.setY(i, height);
        grid[i] = height;
        natural[i] = height;
      }
    }
  };

  /**
   * Pulls the ground towards the roads, and carries the difference away over a
   * batter wide enough to read as an embankment rather than as a wall.
   *
   * This is the answer to the oldest complaint about this renderer: a road laid
   * across rolling ground has to sit at ONE height across its full width, so
   * where the ground falls away there is a difference to absorb. Absorbing it in
   * the road's own skirt draws a vertical face — the "wall" — and absorbing it
   * nowhere leaves the road hanging. Absorbing it in the TERRAIN is what a road
   * actually does to a landscape, and it is the only version that looks built.
   *
   * It is also, with no extra code, how tunnels work: `shapeAt` fades its own
   * weight out where the road is buried deeply, so the ground closes over the
   * bore and stays open at the portals.
   */
  const shapeToRoads = (shape: TerrainShaper | null): boolean => {
    let moved = false;
    // Restore whatever the last shaping moved, so this is a pure function of
    // the current network rather than an accumulation over every edit.
    for (const i of shapedCorners) {
      if (grid[i] !== natural[i]) {
        grid[i] = natural[i] as number;
        position.setY(i, natural[i] as number);
        moved = true;
      }
    }
    shapedCorners = [];
    if (!shape) return moved;

    for (let i = 0; i < GRID * GRID; i++) {
      const x = position.getX(i);
      const worldY = -position.getZ(i);
      const ground = natural[i] as number;
      const { height, weight } = shape.shapeAt(x, worldY, ground);
      if (weight <= 0.001) continue;
      const blended = ground + (height - ground) * weight;
      if (Math.abs(blended - ground) < 0.002) continue;
      grid[i] = blended;
      position.setY(i, blended);
      shapedCorners.push(i);
      moved = true;
    }
    if (moved) {
      position.needsUpdate = true;
      geometry.computeVertexNormals();
      geometry.computeBoundingSphere();
    }
    return moved;
  };

  let wetDiscs: readonly WaterStamp[] = [];
  const wetAt = (x: number, y: number): boolean => {
    for (const disc of wetDiscs) {
      const reach = disc.radius * WATER_SPREAD;
      if (Math.abs(x - disc.x) > reach || Math.abs(y - disc.y) > reach) continue;
      if (Math.hypot(x - disc.x, y - disc.y) > reach) continue;
      // A margin, so nothing stands with its root on the waterline.
      if (renderedHeightAt(x, y) < disc.level + 0.6) return true;
    }
    return false;
  };

  const rebuildWater = (stamps: readonly TerrainStamp[]): void => {
    // A river stands at the level its channel was cut INTO, below the banks: at
    // a fixed world datum it vanished under raised ground, and level with the
    // banks it covered the whole valley as one flat sheet.
    const land = stamps.filter((stamp) => stamp.mode !== 'river');
    const landIndex = new TerrainIndex(land, 0);
    const landAt = (x: number, y: number): number => TERRAIN_BASE + sampleTerrainHeight(landIndex, x, y);

    const discs: WaterStamp[] = [];
    for (const stamp of stamps) {
      if (stamp.mode !== 'river' || discs.length >= MAX_TERRAIN_STAMPS) continue;
      const bank = landAt(stamp.x, stamp.y);
      const bed = heightAt(stamp.x, stamp.y);
      const level = bank - Math.max(WATER_MARGIN, WATER_FILL * (bank - bed));
      if (bed + TERRAIN_WATER_HEIGHT >= level) continue;
      discs.push({ x: stamp.x, y: stamp.y, radius: stamp.radius * WATER_RADIUS, level });
    }
    wetDiscs = discs;
    const previous = water.geometry;
    water.geometry = unifiedWaterGeometry(discs, renderedHeightAt);
    previous.dispose();
  };

  return {
    meshes: [backdrop, ground, water],
    ground,
    heightAt,
    naturalRenderedHeightAt,
    renderedHeightAt,
    wetAt,
    shapeToRoads(shape) {
      const moved = shapeToRoads(shape);
      // A road that cut through a valley changes where the water's shore is.
      if (moved) rebuildWater(lastStamps);
      return moved;
    },
    update(doc) {
      if (revision === doc.terrainRevision) return false;
      const firstBuild = revision < 0;
      const previous = index;
      revision = doc.terrainRevision;
      index = new TerrainIndex(doc.terrainStamps, revision);

      // Only the cells a new stamp reaches are rewritten. A brush stroke adds
      // one 80-unit stamp; rewriting all 90 601 corners for it is what made
      // painting terrain drop frames on a large map.
      const added = doc.terrainStamps.length === previous.stamps.length + 1
        ? doc.terrainStamps[doc.terrainStamps.length - 1]
        : undefined;
      const sameHistory =
        added !== undefined &&
        previous.stamps.length > 0 &&
        previous.stamps[0] === doc.terrainStamps[0];

      if (firstBuild || !added || !sameHistory) {
        rewrite(0, GRID - 1, 0, GRID - 1);
      } else {
        const reach = added.radius + TERRAIN_CELL;
        const cx0 = Math.max(0, Math.floor((added.x - reach + TERRAIN_HALF) / TERRAIN_CELL));
        const cx1 = Math.min(GRID - 1, Math.ceil((added.x + reach + TERRAIN_HALF) / TERRAIN_CELL));
        const cy0 = Math.max(0, Math.floor((TERRAIN_HALF - (added.y + reach)) / TERRAIN_CELL));
        const cy1 = Math.min(GRID - 1, Math.ceil((TERRAIN_HALF - (added.y - reach)) / TERRAIN_CELL));
        // A `flatten` stamp scales everything under it, so it can move ground
        // the disc does not cover if an earlier stamp reached further; the box
        // above is still the only place its influence is non-zero.
        rewrite(cx0, cx1, cy0, cy1);
      }

      position.needsUpdate = true;
      geometry.computeVertexNormals();
      geometry.computeBoundingSphere();
      lastStamps = doc.terrainStamps;
      rebuildWater(lastStamps);
      return true;
    },
    dispose() {
      geometry.dispose();
      material.dispose();
      backdrop.geometry.dispose();
      (backdrop.material as MeshStandardMaterial).dispose();
      water.geometry.dispose();
      waterSurface.dispose();
    },
  };
}

/**
 * A square annulus: flat ground from `inner` out to `outer`, with a hole in the
 * middle exactly the size of the terrain plate.
 */
function frameGeometry(inner: number, outer: number, y: number): BufferGeometry {
  const geometry = new BufferGeometry();
  const positions: number[] = [];
  const quad = (
    ax: number, az: number, bx: number, bz: number,
    cx: number, cz: number, dx: number, dz: number,
  ): void => {
    positions.push(ax, y, az, bx, y, bz, cx, y, cz, ax, y, az, cx, y, cz, dx, y, dz);
  };
  quad(-outer, -outer, outer, -outer, outer, -inner, -outer, -inner);
  quad(-outer, inner, outer, inner, outer, outer, -outer, outer);
  quad(-outer, -inner, -inner, -inner, -inner, inner, -outer, inner);
  quad(inner, -inner, outer, -inner, outer, inner, inner, inner);
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

export interface WaterStamp {
  readonly x: number;
  readonly y: number;
  readonly radius: number;
  readonly level: number;
}

interface WaterVertex {
  readonly ix: number;
  readonly iy: number;
  weightedLevel: number;
  weight: number;
}

/**
 * One triangulated surface for every overlapping river stamp.
 *
 * Drawing one translucent disc per brush sample stacked forty alpha layers into
 * the pale cloud saved maps showed. Accumulating them on a shared grid performs
 * the union before rendering: overlap changes the local level, never the
 * opacity. The level each vertex carries is the weighted average of the stamps
 * reaching it, so the surface runs DOWN the channel's own profile instead of
 * standing at one height along a river that drops seventeen units across a map.
 *
 * Every vertex also carries its DEPTH — its own level minus the ground under it
 * — which is the one number the shader needs to tell a bank from a channel. It
 * is free here and impossible there: only this builder holds the terrain
 * sampler. See `water.ts` for what is made of it.
 */
export function unifiedWaterGeometry(
  stamps: readonly WaterStamp[],
  terrainHeightAt: (x: number, y: number) => number,
): BufferGeometry {
  const geometry = new BufferGeometry();
  if (stamps.length === 0) return geometry;

  const vertices = new Map<string, WaterVertex>();
  for (const stamp of stamps) {
    const reach = stamp.radius * WATER_SPREAD;
    const minX = Math.floor((stamp.x - reach) / WATER_CELL);
    const maxX = Math.ceil((stamp.x + reach) / WATER_CELL);
    const minY = Math.floor((stamp.y - reach) / WATER_CELL);
    const maxY = Math.ceil((stamp.y + reach) / WATER_CELL);
    for (let ix = minX; ix <= maxX; ix++) {
      const x = ix * WATER_CELL;
      for (let iy = minY; iy <= maxY; iy++) {
        const y = iy * WATER_CELL;
        const distance = Math.hypot(x - stamp.x, y - stamp.y);
        if (distance >= reach) continue;
        const weight =
          distance < stamp.radius
            ? Math.max(0.001, terrainInfluence(1 - distance / stamp.radius))
            : 0.001;
        const key = `${ix}:${iy}`;
        const vertex = vertices.get(key);
        if (vertex) {
          vertex.weightedLevel += stamp.level * weight;
          vertex.weight += weight;
        } else {
          vertices.set(key, { ix, iy, weightedLevel: stamp.level * weight, weight });
        }
      }
    }
  }

  const levelAt = (ix: number, iy: number): number | null => {
    const vertex = vertices.get(`${ix}:${iy}`);
    return vertex ? vertex.weightedLevel / vertex.weight : null;
  };
  const positions: number[] = [];
  const depths: number[] = [];
  const cells = new Set<string>();
  for (const vertex of vertices.values()) {
    cells.add(`${vertex.ix}:${vertex.iy}`);
    cells.add(`${vertex.ix - 1}:${vertex.iy}`);
    cells.add(`${vertex.ix}:${vertex.iy - 1}`);
    cells.add(`${vertex.ix - 1}:${vertex.iy - 1}`);
  }

  for (const cell of cells) {
    const [sx, sy] = cell.split(':');
    const ix = Number(sx);
    const iy = Number(sy);
    const corners = [
      [ix, iy],
      [ix + 1, iy],
      [ix + 1, iy + 1],
      [ix, iy + 1],
    ] as const;
    const levels = corners.map(([x, y]) => levelAt(x, y));
    if (levels.some((level) => level === null)) continue;
    const points = corners.map(([x, y], i) => {
      const wx = x * WATER_CELL;
      const wy = y * WATER_CELL;
      const level = levels[i] as number;
      return { x: wx, y: wy, level, depth: level - terrainHeightAt(wx, wy) };
    });
    // Drop boundary cells whose surface is not held inside the carved ground.
    // Their absence is hidden by the bank instead of showing a rim in open air.
    // Stated as a depth now, but it is the same test: a cell survives only where
    // the water stands clear of the land at all four corners and at its centre,
    // which is what guarantees no part of the sheet is left hanging in open air.
    const centreLevel = points.reduce((sum, point) => sum + point.level, 0) / points.length;
    const centreX = (ix + 0.5) * WATER_CELL;
    const centreY = (iy + 0.5) * WATER_CELL;
    if (
      points.some((point) => point.depth <= TERRAIN_WATER_HEIGHT) ||
      centreLevel - terrainHeightAt(centreX, centreY) <= TERRAIN_WATER_HEIGHT
    ) {
      continue;
    }
    // Wound anticlockwise seen from above, so the surface is a FRONT face. The
    // old winding pointed every face at the ground and needed `DoubleSide` and a
    // back-face normal flip to be lit at all — which also meant the water was
    // rasterised twice.
    pushTriangle(positions, depths, points[0]!, points[1]!, points[2]!);
    pushTriangle(positions, depths, points[0]!, points[2]!, points[3]!);
  }

  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setAttribute(WATER_DEPTH_ATTRIBUTE, new Float32BufferAttribute(depths, 1));
  const uvs: number[] = [];
  // Flat UP, not the face normals `computeVertexNormals` would give. The level
  // field steps by a fraction of a unit per cell, and on a surface this
  // reflective those steps show as a quilt of four-unit facets in the Fresnel
  // term and in the sun's glint. The ripple the eye reads comes from the normal
  // map, so the geometry's own normal should be the plane's.
  const normals = new Float32Array(positions.length);
  for (let i = 0; i < positions.length; i += 3) {
    uvs.push((positions[i] as number) / 40, (positions[i + 2] as number) / 40);
    normals[i + 1] = 1;
  }
  geometry.setAttribute('uv', new Float32BufferAttribute(uvs, 2));
  geometry.setAttribute('normal', new Float32BufferAttribute(normals, 3));
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

interface WaterPoint {
  readonly x: number;
  readonly y: number;
  readonly level: number;
  readonly depth: number;
}

function pushTriangle(
  out: number[],
  depths: number[],
  a: WaterPoint,
  b: WaterPoint,
  c: WaterPoint,
): void {
  out.push(a.x, a.level, -a.y, b.x, b.level, -b.y, c.x, c.level, -c.y);
  depths.push(a.depth, b.depth, c.depth);
}
