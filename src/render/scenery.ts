import {
  BoxGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  InstancedMesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  SphereGeometry,
  type BufferGeometry,
  type Material,
} from 'three';

import { angleOf } from '@core/vec2';
import { Rng } from '@core/rng';
import type { Network } from '@world/network';
import type { RoadElevation } from '@world/elevation';
import { GROUND_ONLY } from '@world/elevation';
import { m } from '@world/units';
import { TERRAIN_HALF } from './terrain';

/**
 * Everything standing on the ground that is not a road: lamp columns and
 * vegetation.
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
 * Everything is instanced — one draw call per part, whatever the count — and
 * every mesh carries a real bounding sphere so the frustum can reject it.
 */

export interface Scenery {
  readonly meshes: readonly InstancedMesh[];
  readonly triangles: number;
  dispose(): void;
}

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

/**
 * Street furniture, written from real-world figures.
 *
 * `units.ts` says the metre helper exists so that derived constants can be
 * written from real figures AND CHECKED, and these had drifted a long way
 * from anything checkable. A lamp column was 11.8 world units, which at
 * 0.4 m per unit is 4.7 m - shorter than a double-decker bus, about head
 * height for the lamp itself. Against a 8.8 m carriageway and correctly-sized
 * 1.5-to-1.9 m pedestrians, the whole roadside read as a model village: the
 * people looked tiny because everything beside them was built half-size.
 *
 * Real values: a residential lighting column is 8 to 10 m with a 1.5 to 2.5 m
 * outreach; street trees are 6 to 14 m.
 */
export const LAMP_HEIGHT = m(9);
const LAMP_TOP_RADIUS = m(0.08);
const LAMP_BASE_RADIUS = m(0.13);
/** How far the arm reaches out over the carriageway. */
export const LAMP_OUTREACH = m(2.1);
const LAMP_HEAD_LONG = m(0.62);
const LAMP_HEAD_TALL = m(0.16);
const LAMP_HEAD_WIDE = m(0.32);
const LAMP_ARM_THICK = m(0.12);

export const TREE_MIN_HEIGHT = m(6);
export const TREE_HEIGHT_RANGE = m(8);

const LAMP_SPACING = 88;
/** Nothing is planted closer than this to the edge of a road's casing. */
const PLANT_CLEARANCE = 16;
/** Keeps a canopy from overhanging the edge of the terrain plate. */
const PLANT_EDGE_MARGIN = 24;

function build(
  name: string,
  geometry: BufferGeometry,
  material: Material,
  placements: readonly Placement[],
): InstancedMesh | null {
  if (placements.length === 0) return null;
  const mesh = new InstancedMesh(geometry, material, placements.length);
  mesh.name = name;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
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
  if (tinted && mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.computeBoundingSphere();
  return mesh;
}

export function buildScenery(
  net: Network,
  elevation: RoadElevation,
  terrainAt: (x: number, y: number) => number,
  vegetationCount: number,
): Scenery {
  const poles: Placement[] = [];
  const arms: Placement[] = [];
  const lamps: Placement[] = [];

  for (const ribbon of net.ribbons.values()) {
    const length = ribbon.full.length;
    const start = Math.min(36, length * 0.24);
    for (let s = start; s < length - start; s += LAMP_SPACING) {
      const frame = ribbon.full.sampleAt(s);
      const side = (Math.floor(s / LAMP_SPACING) + ribbon.id) % 2 === 0 ? -1 : 1;
      const out = ribbon.road.width / 2 + ribbon.road.sidewalk * 0.55;
      const x = frame.p.x + frame.n.x * out * side;
      const y = frame.p.y + frame.n.y * out * side;
      const base = elevation.at(x, y) + 0.36;
      const inwardYaw = angleOf({ x: -frame.n.x * side, y: -frame.n.y * side });
      // The column is drawn from its centre, so half its height above base.
      poles.push({ x, y, z: base + LAMP_HEIGHT / 2, yaw: 0, sx: 1, sy: 1, sz: 1 });
      // The arm spans from the column to the head, so it is centred half way.
      arms.push({
        x: x - frame.n.x * side * (LAMP_OUTREACH / 2),
        y: y - frame.n.y * side * (LAMP_OUTREACH / 2),
        z: base + LAMP_HEIGHT - LAMP_ARM_THICK,
        yaw: inwardYaw,
        sx: LAMP_OUTREACH,
        sy: LAMP_ARM_THICK,
        sz: LAMP_ARM_THICK,
      });
      lamps.push({
        x: x - frame.n.x * side * LAMP_OUTREACH,
        y: y - frame.n.y * side * LAMP_OUTREACH,
        z: base + LAMP_HEIGHT - LAMP_ARM_THICK - LAMP_HEAD_TALL / 2,
        yaw: inwardYaw,
        sx: LAMP_HEAD_LONG,
        sy: LAMP_HEAD_TALL,
        sz: LAMP_HEAD_WIDE,
      });
    }
  }

  // ------------------------------------------------------------- vegetation
  const trunks: Placement[] = [];
  const canopies: Placement[] = [];
  const bushes: Placement[] = [];
  if (vegetationCount > 0) {
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
    const attempts = maxX > minX && maxY > minY ? vegetationCount * 3 : 0;
    let planted = 0;
    for (let i = 0; i < attempts && planted < vegetationCount; i++) {
      const x = minX + rng.float() * (maxX - minX);
      const y = minY + rng.float() * (maxY - minY);
      // Nothing grows on the carriageway or its verge.
      if (Math.abs(elevation.at(x, y, GROUND_ONLY) - terrainAt(x, y)) < 40) {
        const road = elevation.roadAt(x, y);
        if (Math.abs(road.across) < PLANT_CLEARANCE + 24) continue;
      }
      const ground = terrainAt(x, y);
      // Steep rock and river beds stay bare, which makes the slope readable.
      const slope =
        Math.abs(terrainAt(x + 6, y) - terrainAt(x - 6, y)) +
        Math.abs(terrainAt(x, y + 6) - terrainAt(x, y - 6));
      if (slope > 7 || ground < -1.2) continue;
      planted++;
      const bush = rng.float() < 0.42;
      const scale = 0.7 + rng.float() * 0.7;
      if (bush) {
        bushes.push({
          x,
          y,
          z: ground + 1.5 * scale,
          yaw: rng.float() * Math.PI,
          sx: 2.6 * scale,
          sy: 1.7 * scale,
          sz: 2.6 * scale,
          tint: new Color().setHSL(0.26 + rng.float() * 0.05, 0.4, 0.22 + rng.float() * 0.1),
        });
        continue;
      }
      const height = TREE_MIN_HEIGHT + rng.float() * TREE_HEIGHT_RANGE;
      trunks.push({
        x,
        y,
        z: ground + height * 0.3,
        yaw: rng.float() * Math.PI,
        sx: 0.55 * scale,
        sy: height * 0.6,
        sz: 0.55 * scale,
      });
      canopies.push({
        x,
        y,
        z: ground + height * 0.72,
        yaw: rng.float() * Math.PI,
        sx: 3.4 * scale,
        sy: height * 0.62,
        sz: 3.4 * scale,
        tint: new Color().setHSL(0.24 + rng.float() * 0.07, 0.42, 0.2 + rng.float() * 0.12),
      });
    }
  }

  const metal = new MeshStandardMaterial({ color: 0x2f3736, roughness: 0.52, metalness: 0.55 });
  const glow = new MeshBasicMaterial({ color: 0xffeec0, toneMapped: false });
  const bark = new MeshStandardMaterial({ color: 0x5a4632, roughness: 0.95, metalness: 0 });
  const leaf = new MeshStandardMaterial({ color: 0xffffff, roughness: 0.92, metalness: 0 });

  const poleGeometry = new CylinderGeometry(
    LAMP_TOP_RADIUS,
    LAMP_BASE_RADIUS,
    LAMP_HEIGHT,
    8,
  );
  const boxGeometry = new BoxGeometry(1, 1, 1);
  const trunkGeometry = new CylinderGeometry(0.7, 1, 1, 6);
  const canopyGeometry = new ConeGeometry(1, 1, 7);
  const bushGeometry = new SphereGeometry(1, 7, 5);

  const meshes = [
    build('street-light-poles', poleGeometry, metal, poles),
    build('street-light-arms', boxGeometry, metal, arms),
    build('street-light-lamps', boxGeometry, glow, lamps),
    build('tree-trunks', trunkGeometry, bark, trunks),
    build('tree-canopies', canopyGeometry, leaf, canopies),
    build('bushes', bushGeometry, leaf, bushes),
  ].filter((mesh): mesh is InstancedMesh => mesh !== null);

  let triangles = 0;
  for (const mesh of meshes) {
    const position = mesh.geometry.getAttribute('position');
    triangles += ((mesh.geometry.index?.count ?? position.count) / 3) * mesh.count;
  }

  const geometries = [poleGeometry, boxGeometry, trunkGeometry, canopyGeometry, bushGeometry];
  const materials = [metal, glow, bark, leaf];

  return {
    meshes,
    triangles,
    dispose() {
      for (const geometry of geometries) geometry.dispose();
      for (const material of materials) material.dispose();
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
