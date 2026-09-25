import {
  Color, DynamicDrawUsage, Group, InstancedMesh, Object3D, Sphere,
  type BufferGeometry, type Frustum, type Material, type Matrix4,
} from 'three';

import { Rng } from '@core/rng';
import type { Network } from '@world/network';
import type { RoadElevation } from '@world/elevation';
import { m } from '@world/units';
import { TERRAIN_HALF } from './terrain';

/**
 * Grass you can see blades of: instanced tufts and wildflowers over the ground.
 *
 * The terrain texture is grass from the map zoom. From a few metres, a flat
 * texture is a flat texture, and the ground was the "hard" thing in the scene -
 * a carpet under objects that stood on it. Real turf is never mown to a plane
 * at the edge of a road: it grows in tufts along the verge, around lamp posts
 * and at the foot of every tree, with the odd flower in it.
 *
 * ## Placement
 *
 * In CLUMPS, not uniformly. A uniform scatter dense enough to read as grass
 * would be millions of instances over a city; clumps put the same budget where
 * the eye goes - the roadside, where the roads are - and read as uneven,
 * unmown ground rather than as a sparse lawn. A clump's centre is tested
 * against the roads once, and its tufts only against the ground height.
 *
 * ## Chunks
 *
 * Instances are grouped by 96-unit cell, but drawn as ONE instanced mesh per
 * kind. A mesh per cell was 1 070 meshes on the player map - a draw call per
 * visible cell per pass whenever grass showed. The cells now only order the
 * instances: when the camera moves (`cull`), the visible cells' instances are
 * copied to the front of the buffer as a few contiguous runs, and only those
 * are drawn.
 */

/**
 * Below this zoom a tuft is two or three pixels tall, and a million triangles
 * of them would be drawn to show a texture the ground already has; grass is
 * hidden.
 */
export const GRASS_MIN_ZOOM = 4;

const CHUNK = 96;
/** Real turf height, root to tip. */
const TUFT_MIN = m(0.18);
const TUFT_RANGE = m(0.3);
const FLOWER_MIN = m(0.25);
const FLOWER_RANGE = m(0.2);
/** How far from the nearest road grass is scattered over open ground. */
const OPEN_REACH = 700;
/** Share of clumps put along roads rather than scattered over open ground. */
const ROADSIDE_SHARE = 0.65;

export interface GrassField {
  readonly group: Group;
  readonly triangles: number;
  /**
   * Keeps only the cells the camera can see. `view` is the camera's projection
   * times its inverse world matrix; nothing is done while it is unchanged.
   */
  cull(frustum: Frustum, view: Matrix4): void;
  dispose(): void;
}

/** One kind of plant: every instance, cell by cell, and what is drawn. */
interface Field {
  readonly mesh: InstancedMesh;
  readonly matrices: Float32Array;
  readonly colours: Float32Array;
  /** Per cell: first instance, count, and a bounding sphere (x, y, z, radius). */
  readonly cells: { start: number; count: number; sphere: Sphere }[];
}

interface Tuft {
  x: number;
  y: number;
  z: number;
  yaw: number;
  height: number;
  width: number;
  tint: Color;
}

const FLOWER_COLOURS = [0xf6f3e8, 0xf2d24b, 0xb58be0, 0xe8618c, 0xf5a13a].map((hex) =>
  new Color(hex).convertSRGBToLinear(),
);

export function buildGrass(
  net: Network,
  elevation: RoadElevation,
  terrainAt: (x: number, y: number) => number,
  wetAt: (x: number, y: number) => boolean,
  clumps: number,
  kit: { tuft: BufferGeometry; flower: BufferGeometry; grass: Material; flowers: Material },
): GrassField {
  const group = new Group();
  group.name = 'grass';
  const tufts = new Map<string, Tuft[]>();
  const flowers = new Map<string, Tuft[]>();
  const push = (bucket: Map<string, Tuft[]>, tuft: Tuft): void => {
    const key = `${Math.floor(tuft.x / CHUNK)}:${Math.floor(tuft.y / CHUNK)}`;
    const list = bucket.get(key);
    if (list) list.push(tuft);
    else bucket.set(key, [tuft]);
  };

  /**
   * One clump at (cx, cy), from its own generator: the centre is tested
   * against the roads, the water and the slope, then its tufts are laid.
   */
  const clump = (rng: Rng, cx: number, cy: number): boolean => {
    const radius = 2.5 + rng.float() * 5;
    const road = elevation.roadAt(cx, cy);
    if (road.type >= 0 && Math.abs(road.across) < road.half + radius * 0.6 + 0.8) return false;
    if (wetAt(cx, cy)) return false;
    const slope =
      Math.abs(terrainAt(cx + 4, cy) - terrainAt(cx - 4, cy)) +
      Math.abs(terrainAt(cx, cy + 4) - terrainAt(cx, cy - 4));
    if (slope > 6) return false;

    // Dense enough to read as a patch of long grass. At 16 to 42 blades over
    // a clump several metres wide they were scattered dark specks - dirt on
    // the screen, not grass.
    const count = 44 + Math.floor(rng.float() * 50);
    // Each clump has its own colour: lush, pale, or gone to seed.
    const dry = rng.float();
    const clumpHue = dry > 0.8 ? new Color(1.25, 1.12, 0.72) : new Color(0.92 + dry * 0.12, 1, 0.9 + dry * 0.1);
    for (let i = 0; i < count; i++) {
      // Denser in the middle of a clump, as grass grows out from a patch.
      const r = radius * Math.sqrt(rng.float()) * (0.4 + rng.float() * 0.6);
      const a = rng.float() * Math.PI * 2;
      const x = cx + Math.cos(a) * r;
      const y = cy + Math.sin(a) * r;
      // A tuft at the edge of a clump can still reach a road.
      if (road.type >= 0 && Math.abs(road.across) - r < road.half + 0.6) {
        const near = elevation.roadAt(x, y);
        if (near.type >= 0 && Math.abs(near.across) < near.half + 0.6) continue;
      }
      if (wetAt(x, y)) continue;
      const z = terrainAt(x, y) - 0.05;
      const shade = 0.95 + rng.float() * 0.22;
      const tuft: Tuft = {
        x,
        y,
        z,
        yaw: rng.float() * Math.PI * 2,
        height: TUFT_MIN + rng.float() * TUFT_RANGE * (1 - r / (radius * 1.4)),
        width: 0.9 + rng.float() * 0.6,
        tint: clumpHue.clone().multiplyScalar(shade),
      };
      if (rng.float() < 0.045) {
        push(flowers, {
          ...tuft,
          height: FLOWER_MIN + rng.float() * FLOWER_RANGE,
          width: 1,
          tint: (FLOWER_COLOURS[Math.floor(rng.float() * FLOWER_COLOURS.length)] as Color).clone(),
        });
      } else {
        push(tufts, tuft);
      }
    }
    return true;
  };
  let openClumps = 0;
  let roadsideClumps = 0;

  // Every candidate clump is seeded by the map cell it falls in and its own
  // number there, never by a stream shared with the rest of the map. The
  // stream used to be shared, and roadside clumps were dropped along a road
  // picked at random from the list, so drawing any road anywhere moved 90 %
  // of the grass on screen: every edit made the whole meadow jump. Now a
  // clump is there or not by what is at its own spot, and an edit changes
  // only the grass beside the road it touched.
  if (clumps > 0 && net.ribbons.size > 0) {
    const limit = TERRAIN_HALF - 8;
    // Densities that reproduce the old placement on the player map, measured:
    // per unit of road (12 800 units there) for the roadside clumps, and per
    // unit of area for the scattered ones, whose share of the budget works out
    // at the whole 4 800-unit map.
    const perRoad = (clumps * ROADSIDE_SHARE) / 12_800;
    const perArea = (clumps * (1 - ROADSIDE_SHARE)) / (4_800 * 4_800);
    // Roadside candidates are thrown over the whole cell and kept within the
    // verge band, more readily close to the casing; the band is 2 x 16 wide
    // and keeps on average 1/1.6 of what lands in it.
    const roadsideTries = (perRoad / (2 * 16 / 1.6)) * CHUNK * CHUNK;
    const openTries = perArea * CHUNK * CHUNK;
    // Grass grows within OPEN_REACH of some road, and roadside candidates are
    // thrown only in cells a road comes near. Both are unions of per-road
    // boxes, so drawing a road can only add cells round itself. They were a
    // box about the whole network's extent, which a road drawn far away
    // shifted, dropping and adding grass along its opposite edge.
    const nearRoad = new Set<number>();
    const grown = new Set<number>();
    const key = (ix: number, iy: number): number => (ix + 4096) * 8192 + (iy + 4096);
    const mark = (into: Set<number>, box: { minX: number; minY: number; maxX: number; maxY: number }, pad: number): void => {
      const x0 = Math.floor(Math.max(-limit, box.minX - pad) / CHUNK);
      const x1 = Math.floor(Math.min(limit, box.maxX + pad) / CHUNK);
      const y0 = Math.floor(Math.max(-limit, box.minY - pad) / CHUNK);
      const y1 = Math.floor(Math.min(limit, box.maxY + pad) / CHUNK);
      for (let ix = x0; ix <= x1; ix++) for (let iy = y0; iy <= y1; iy++) into.add(key(ix, iy));
    };
    for (const box of elevation.shapeBounds()) {
      mark(nearRoad, box, 20);
      mark(grown, box, OPEN_REACH);
    }
    const seedOf = (ix: number, iy: number, k: number, kind: number): number => {
      let h = Math.imul(ix, 0x27d4eb2d) ^ Math.imul(iy, 0x165667b1) ^ Math.imul(k + 1, 0x9e3779b1) ^ (kind * 0x85ebca6b) ^ 0x9a55;
      h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
      h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
      return (h ^ (h >>> 15)) >>> 0;
    };
    for (const cellKey of grown) {
      const ix = Math.floor(cellKey / 8192) - 4096;
      const iy = (cellKey % 8192) - 4096;
      {
        const cell = new Rng(seedOf(ix, iy, -1, 0));
        const open = Math.floor(openTries + cell.float());
        for (let k = 0; k < open; k++) {
          const rng = new Rng(seedOf(ix, iy, k, 1));
          const x = (ix + rng.float()) * CHUNK;
          const y = (iy + rng.float()) * CHUNK;
          if (Math.abs(x) > limit || Math.abs(y) > limit) continue;
          if (clump(rng, x, y)) openClumps++;
        }
        if (!nearRoad.has(key(ix, iy))) continue;
        const roadside = Math.floor(roadsideTries + cell.float());
        for (let k = 0; k < roadside; k++) {
          const rng = new Rng(seedOf(ix, iy, k, 2));
          const x = (ix + rng.float()) * CHUNK;
          const y = (iy + rng.float()) * CHUNK;
          if (Math.abs(x) > limit || Math.abs(y) > limit) continue;
          const road = elevation.roadAt(x, y);
          if (road.type < 0) continue;
          // Just past the casing, either side, thinning out over 16 units.
          const out = (Math.abs(road.across) - road.half - 1.5) / 16;
          if (out < 0 || out > 1 || rng.float() > (1 - out) ** 0.6) continue;
          if (clump(rng, x, y)) roadsideClumps++;
        }
      }
    }
  }

  group.userData.clumps = { open: openClumps, roadside: roadsideClumps };
  let triangles = 0;
  const fields: Field[] = [];
  const object = new Object3D();
  const emit = (bucket: Map<string, Tuft[]>, geometry: BufferGeometry, material: Material, name: string): void => {
    let total = 0;
    for (const list of bucket.values()) total += list.length;
    if (total === 0) return;
    const perInstance = geometry.getAttribute('position').count / 3;
    const mesh = new InstancedMesh(geometry, material, total);
    mesh.name = name;
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    // Culled by cell in `cull`; a sphere round the whole map rejects nothing.
    mesh.frustumCulled = false;
    mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    const cells: Field['cells'] = [];
    let index = 0;
    for (const list of bucket.values()) {
      let minX = Infinity;
      let minY = Infinity;
      let minZ = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      let maxZ = -Infinity;
      const first = index;
      for (const tuft of list) {
        object.position.set(tuft.x, tuft.z, -tuft.y);
        object.rotation.set(0, tuft.yaw, 0);
        object.scale.set(tuft.height * tuft.width, tuft.height, tuft.height * tuft.width);
        object.updateMatrix();
        mesh.setMatrixAt(index, object.matrix);
        mesh.setColorAt(index, tuft.tint);
        index++;
        const reach = tuft.height * Math.max(1, tuft.width);
        minX = Math.min(minX, tuft.x - reach);
        maxX = Math.max(maxX, tuft.x + reach);
        minY = Math.min(minY, tuft.z);
        maxY = Math.max(maxY, tuft.z + tuft.height);
        minZ = Math.min(minZ, -tuft.y - reach);
        maxZ = Math.max(maxZ, -tuft.y + reach);
      }
      const sphere = new Sphere();
      sphere.center.set((minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2);
      sphere.radius = Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) / 2;
      cells.push({ start: first, count: list.length, sphere });
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) {
      mesh.instanceColor.setUsage(DynamicDrawUsage);
      mesh.instanceColor.needsUpdate = true;
    }
    group.add(mesh);
    fields.push({
      mesh,
      matrices: Float32Array.from(mesh.instanceMatrix.array as Float32Array),
      colours: Float32Array.from((mesh.instanceColor?.array ?? new Float32Array(0)) as Float32Array),
      cells,
    });
    triangles += perInstance * total;
  };
  emit(tufts, kit.tuft, kit.grass, 'grass-tufts');
  emit(flowers, kit.flower, kit.flowers, 'wildflowers');

  let culledFor: Matrix4 | null = null;
  return {
    group,
    triangles,
    cull(frustum, view) {
      if (culledFor && culledFor.equals(view)) return;
      culledFor = culledFor ? culledFor.copy(view) : view.clone();
      for (const field of fields) {
        const matrices = field.mesh.instanceMatrix.array as Float32Array;
        const colours = field.mesh.instanceColor?.array as Float32Array | undefined;
        let n = 0;
        for (const cell of field.cells) {
          if (!frustum.intersectsSphere(cell.sphere)) continue;
          matrices.set(field.matrices.subarray(cell.start * 16, (cell.start + cell.count) * 16), n * 16);
          if (colours) colours.set(field.colours.subarray(cell.start * 3, (cell.start + cell.count) * 3), n * 3);
          n += cell.count;
        }
        field.mesh.count = n;
        field.mesh.instanceMatrix.clearUpdateRanges();
        if (n > 0) field.mesh.instanceMatrix.addUpdateRange(0, n * 16);
        field.mesh.instanceMatrix.needsUpdate = true;
        if (field.mesh.instanceColor) {
          field.mesh.instanceColor.clearUpdateRanges();
          if (n > 0) field.mesh.instanceColor.addUpdateRange(0, n * 3);
          field.mesh.instanceColor.needsUpdate = true;
        }
        field.mesh.visible = n > 0;
      }
    },
    dispose() {
      // Geometry and materials belong to the kit and outlive a rebuild; only
      // the per-instance buffers are this field's.
      for (const field of fields) field.mesh.dispose();
      group.clear();
    },
  };
}

