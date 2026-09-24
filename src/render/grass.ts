import { Color, Group, InstancedMesh, Object3D, type BufferGeometry, type Material } from 'three';

import { Rng } from '@core/rng';
import type { Network } from '@world/network';
import type { RoadElevation } from '@world/elevation';
import { casingHalf } from '@world/roadTypes';
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
 * One `InstancedMesh` per 96-unit cell, each with its own bounding sphere, so
 * at the zoom grass is drawn at (it is hidden further out - see
 * `GRASS_MIN_ZOOM`) the frustum throws away everything off screen.
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
/** Share of clumps put along roads rather than scattered over open ground. */
const ROADSIDE_SHARE = 0.65;

export interface GrassField {
  readonly group: Group;
  readonly triangles: number;
  dispose(): void;
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

  const ribbons = [...net.ribbons.values()];
  if (clumps > 0 && ribbons.length > 0) {
    const rng = new Rng(0x9a55);
    const limit = TERRAIN_HALF - 8;
    const bounds = extent(net);
    const reach = Math.max(700, Math.max(bounds.w, bounds.h) * 0.7);

    for (let attempt = 0; attempt < clumps; attempt++) {
      let cx: number;
      let cy: number;
      if (rng.float() < ROADSIDE_SHARE) {
        // Just past the casing of a random road, either side.
        const ribbon = ribbons[Math.floor(rng.float() * ribbons.length)];
        if (!ribbon) continue;
        const frame = ribbon.full.sampleAt(rng.float() * ribbon.full.length);
        const side = rng.float() < 0.5 ? -1 : 1;
        const out = casingHalf(ribbon.road) + 1.5 + rng.float() ** 1.6 * 16;
        cx = frame.p.x + frame.n.x * out * side;
        cy = frame.p.y + frame.n.y * out * side;
      } else {
        cx = bounds.cx + (rng.float() * 2 - 1) * reach;
        cy = bounds.cy + (rng.float() * 2 - 1) * reach;
      }
      if (Math.abs(cx) > limit || Math.abs(cy) > limit) continue;

      const radius = 2.5 + rng.float() * 5;
      const road = elevation.roadAt(cx, cy);
      if (road.type >= 0 && Math.abs(road.across) < road.half + radius * 0.6 + 0.8) continue;
      if (wetAt(cx, cy)) continue;
      const slope =
        Math.abs(terrainAt(cx + 4, cy) - terrainAt(cx - 4, cy)) +
        Math.abs(terrainAt(cx, cy + 4) - terrainAt(cx, cy - 4));
      if (slope > 6) continue;

      const count = 16 + Math.floor(rng.float() * 26);
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
        const shade = 0.85 + rng.float() * 0.3;
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
    }
  }

  let triangles = 0;
  const meshes: InstancedMesh[] = [];
  const object = new Object3D();
  const emit = (bucket: Map<string, Tuft[]>, geometry: BufferGeometry, material: Material, name: string): void => {
    const perInstance = geometry.getAttribute('position').count / 3;
    for (const [key, list] of bucket) {
      const mesh = new InstancedMesh(geometry, material, list.length);
      mesh.name = `${name}-${key}`;
      mesh.castShadow = false;
      mesh.receiveShadow = true;
      list.forEach((tuft, index) => {
        object.position.set(tuft.x, tuft.z, -tuft.y);
        object.rotation.set(0, tuft.yaw, 0);
        object.scale.set(tuft.height * tuft.width, tuft.height, tuft.height * tuft.width);
        object.updateMatrix();
        mesh.setMatrixAt(index, object.matrix);
        mesh.setColorAt(index, tuft.tint);
      });
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.computeBoundingSphere();
      group.add(mesh);
      meshes.push(mesh);
      triangles += perInstance * list.length;
    }
  };
  emit(tufts, kit.tuft, kit.grass, 'grass-tufts');
  emit(flowers, kit.flower, kit.flowers, 'wildflowers');

  return {
    group,
    triangles,
    dispose() {
      // Geometry and materials belong to the kit and outlive a rebuild; only
      // the per-instance buffers are this field's.
      for (const mesh of meshes) mesh.dispose();
      group.clear();
    },
  };
}

function extent(net: Network): { cx: number; cy: number; w: number; h: number } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const node of net.doc.nodes.values()) {
    minX = Math.min(minX, node.x);
    minY = Math.min(minY, node.y);
    maxX = Math.max(maxX, node.x);
    maxY = Math.max(maxY, node.y);
  }
  if (!Number.isFinite(minX)) return { cx: 0, cy: 0, w: 0, h: 0 };
  return { cx: (minX + maxX) / 2, cy: (minY + maxY) / 2, w: maxX - minX, h: maxY - minY };
}
