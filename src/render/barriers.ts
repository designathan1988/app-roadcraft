import { BoxGeometry, Group, InstancedMesh, type Material, MeshStandardMaterial, Object3D } from 'three';

import { BARRIER_SIZE, type Barrier } from '@world/barriers';
import type { RoadDoc } from '@world/doc';
import { m } from '@world/units';

/**
 * Walls, fences and hedges on screen (`world/barriers.ts`).
 *
 * Every piece is one unit box, instanced and placed: a wall is a run of
 * blocks with a coping on top, a fence posts every couple of metres with two
 * rails between them, a hedge a run of clipped green blocks. A run is cut
 * into pieces no longer than `PIECE` so it follows the ground it stands on.
 * Built behind its own revision (`doc.barrierRevision`), like the poles.
 */
export interface Barriers {
  readonly group: Group;
  readonly triangles: number;
  dispose(): void;
}

/** Longest straight piece a run is cut into, world units. */
const PIECE = m(4);
/** Distance between fence posts, world units. */
const POST_STEP = m(2);
/** How far a piece is sunk into the ground, so a slope never shows under it. */
const SINK = m(0.15);

interface Box { x: number; y: number; z: number; yaw: number; length: number; width: number; height: number }

export function buildBarriers(doc: RoadDoc, groundAt: (x: number, y: number) => number): Barriers {
  const group = new Group();
  group.name = 'barriers';
  const walls: Box[] = [], copings: Box[] = [], posts: Box[] = [], rails: Box[] = [], hedges: Box[] = [];
  for (const barrier of doc.barriers.values()) placeBarrier(barrier, groundAt, { walls, copings, posts, rails, hedges });

  const unit = new BoxGeometry(1, 1, 1);
  const materials: Material[] = [];
  const material = (colour: number, roughness: number, metalness = 0): MeshStandardMaterial => {
    const mat = new MeshStandardMaterial({ color: colour, roughness, metalness });
    materials.push(mat);
    return mat;
  };
  let triangles = 0;
  const add = (name: string, boxes: readonly Box[], mat: Material): void => {
    if (boxes.length === 0) return;
    const mesh = new InstancedMesh(unit, mat, boxes.length);
    mesh.name = name;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    const o = new Object3D();
    boxes.forEach((b, i) => {
      // World y is three's -z, as everywhere in the renderer.
      o.position.set(b.x, b.z + b.height / 2, -b.y);
      o.rotation.set(0, b.yaw, 0);
      o.scale.set(b.length, b.height, b.width);
      o.updateMatrix();
      mesh.setMatrixAt(i, o.matrix);
    });
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
    group.add(mesh);
    triangles += boxes.length * 12;
  };
  add('barrier-wall', walls, material(0xd8d0bf, 0.92));
  add('barrier-coping', copings, material(0xb9b2a4, 0.85));
  add('barrier-post', posts, material(0x4b5153, 0.55, 0.5));
  add('barrier-rail', rails, material(0x4b5153, 0.55, 0.5));
  add('barrier-hedge', hedges, material(0x3d6532, 1));
  return {
    group,
    triangles,
    dispose() {
      unit.dispose();
      for (const mat of materials) mat.dispose();
      group.clear();
    },
  };
}

function placeBarrier(barrier: Barrier, groundAt: (x: number, y: number) => number,
  out: { walls: Box[]; copings: Box[]; posts: Box[]; rails: Box[]; hedges: Box[] }): void {
  const size = BARRIER_SIZE[barrier.kind];
  const height = m(size.height);
  const thickness = m(size.thickness);
  let sincePost = Infinity;
  for (let i = 1; i < barrier.points.length; i++) {
    const a = barrier.points[i - 1]!, b = barrier.points[i]!;
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    if (length < 1e-6) continue;
    const yaw = Math.atan2(b.y - a.y, b.x - a.x);
    const pieces = Math.max(1, Math.ceil(length / PIECE));
    for (let k = 0; k < pieces; k++) {
      const t0 = k / pieces, t1 = (k + 1) / pieces;
      const x0 = a.x + (b.x - a.x) * t0, y0 = a.y + (b.y - a.y) * t0;
      const x1 = a.x + (b.x - a.x) * t1, y1 = a.y + (b.y - a.y) * t1;
      const g0 = groundAt(x0, y0), g1 = groundAt(x1, y1);
      const low = Math.min(g0, g1) - SINK;
      const rise = Math.max(g0, g1) - Math.min(g0, g1);
      const piece = { x: (x0 + x1) / 2, y: (y0 + y1) / 2, yaw, length: length / pieces };
      if (barrier.kind === 'wall') {
        // Overlapping its neighbours by its own thickness, so the corners close.
        out.walls.push({ ...piece, length: piece.length + thickness, z: low, width: thickness, height: height + rise + SINK });
        out.copings.push({ ...piece, length: piece.length + thickness * 1.3, z: Math.max(g0, g1) + height, width: thickness * 1.3, height: m(0.06) });
      } else if (barrier.kind === 'hedge') {
        out.hedges.push({ ...piece, length: piece.length + thickness * 0.5, z: low, width: thickness, height: height + rise + SINK });
      } else {
        const top = Math.max(g0, g1);
        for (const level of [0.35, 0.85]) {
          out.rails.push({ ...piece, z: top + height * level - m(0.03), width: m(0.04), height: m(0.06) });
        }
      }
    }
    if (barrier.kind === 'fence') {
      // Posts along the run, carried over its corners, and one at every corner.
      for (let s = 0; s <= length + 1e-6; s += POST_STEP) {
        if (s > 0 && s < length - 1e-6 && sincePost + s < POST_STEP * 0.5) continue;
        const x = a.x + (b.x - a.x) * (s / length), y = a.y + (b.y - a.y) * (s / length);
        const g = groundAt(x, y);
        out.posts.push({ x, y, yaw, z: g - SINK, length: m(0.08), width: m(0.08), height: height + SINK });
      }
      sincePost = 0;
      const last = barrier.points[barrier.points.length - 1]!;
      if (i === barrier.points.length - 1 && length % POST_STEP > POST_STEP * 0.25) {
        out.posts.push({ x: last.x, y: last.y, yaw, z: groundAt(last.x, last.y) - SINK, length: m(0.08), width: m(0.08), height: height + SINK });
      }
    }
  }
}
