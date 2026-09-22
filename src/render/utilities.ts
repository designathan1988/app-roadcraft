import {
  BufferGeometry,
  CylinderGeometry,
  BoxGeometry,
  Float32BufferAttribute,
  Group,
  InstancedMesh,
  LineSegments,
  LineBasicMaterial,
  Material,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
} from 'three';

import type { RoadDoc } from '@world/doc';
import {
  POLE_ARM_DROP,
  POLE_ARM_HALF,
  POLE_ARM_THICK,
  POLE_BASE_RADIUS,
  POLE_HEIGHT,
  POLE_LAMP_DROP,
  POLE_LAMP_LONG,
  POLE_LAMP_REACH,
  POLE_LAMP_TALL,
  POLE_LAMP_WIDE,
  POLE_TOP_RADIUS,
  WIRE_COURSES,
  WIRE_OFFSETS,
  sampleWire,
} from '@world/utilities';
import { angleOf } from '@core/vec2';

/**
 * The overhead utility network on screen: poles, cross-arms, wires and lamps.
 *
 * Built exactly like every other derived structure — inside `rebuildWorld`,
 * behind the revision gate, never in a draw call. The poles and arms are
 * instanced because there are many identical ones; the wires are a single
 * `LineSegments` because a wire is one pixel wide at every zoom this game is
 * played at, and giving each one a tube would spend thousands of triangles on
 * something that reads as a line either way.
 *
 * The sag is what sells it. A straight segment between two poles reads as a
 * stick; the same span with a metre of droop reads as a cable. See
 * `world/utilities.ts` for why the curve is a quadratic and not a `cosh`.
 */

export interface Utilities {
  readonly group: Group;
  readonly triangles: number;
  dispose(): void;
}

interface Placement {
  x: number;
  y: number;
  /** Height above the ground, in world units. */
  z: number;
  yaw: number;
  sx: number;
  sy: number;
  sz: number;
}

function instanced(
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
  placements.forEach((placement, index) => {
    // World y is mirrored into three's z, as everywhere else in this layer.
    object.position.set(placement.x, placement.z, -placement.y);
    object.rotation.set(0, placement.yaw, 0);
    object.scale.set(placement.sx, placement.sy, placement.sz);
    object.updateMatrix();
    mesh.setMatrixAt(index, object.matrix);
  });
  mesh.instanceMatrix.needsUpdate = true;
  mesh.computeBoundingSphere();
  return mesh;
}

export function buildUtilities(
  doc: RoadDoc,
  groundAt: (x: number, y: number) => number,
): Utilities {
  const group = new Group();
  group.name = 'utilities';

  const masts: Placement[] = [];
  const arms: Placement[] = [];
  const lampArms: Placement[] = [];
  const lampHeads: Placement[] = [];
  const wirePoints: number[] = [];

  /** Crown height of each pole, so the wires and the arms agree on it. */
  const crown = new Map<number, number>();

  for (const pole of doc.poles.values()) {
    const base = groundAt(pole.x, pole.y);
    crown.set(pole.id, base + POLE_HEIGHT);

    masts.push({
      x: pole.x,
      y: pole.y,
      z: base + POLE_HEIGHT / 2,
      yaw: 0,
      sx: 1,
      sy: 1,
      sz: 1,
    });
  }

  // A pole's cross-arm is square to the LINE it carries, so it has to know
  // which way the wires leave. A pole on a bend splits the difference, which
  // is what a real one does.
  const bearing = new Map<number, { x: number; y: number }>();
  for (const span of doc.poleSpans.values()) {
    const a = doc.poles.get(span.a as never);
    const b = doc.poles.get(span.b as never);
    if (!a || !b) continue;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const length = Math.hypot(dx, dy) || 1;
    for (const [pole, sign] of [
      [a, 1],
      [b, -1],
    ] as const) {
      const acc = bearing.get(pole.id) ?? { x: 0, y: 0 };
      acc.x += (dx / length) * sign;
      acc.y += (dy / length) * sign;
      bearing.set(pole.id, acc);
    }
  }

  for (const pole of doc.poles.values()) {
    const top = crown.get(pole.id);
    if (top === undefined) continue;
    const along = bearing.get(pole.id);
    const yaw = along && (along.x || along.y) ? angleOf({ x: along.x, y: along.y }) : 0;

    arms.push({
      x: pole.x,
      y: pole.y,
      z: top - POLE_ARM_DROP,
      yaw,
      sx: POLE_ARM_THICK,
      sy: POLE_ARM_THICK,
      sz: POLE_ARM_HALF * 2,
    });

    if (!pole.lamp) continue;
    // The lamp reaches out square to the line, on the +side of the arm.
    const nx = -Math.sin(yaw);
    const ny = Math.cos(yaw);
    lampArms.push({
      x: pole.x + nx * (POLE_LAMP_REACH / 2),
      y: pole.y + ny * (POLE_LAMP_REACH / 2),
      z: top - POLE_LAMP_DROP,
      yaw,
      sx: POLE_ARM_THICK * 0.8,
      sy: POLE_ARM_THICK * 0.8,
      sz: POLE_LAMP_REACH,
    });
    lampHeads.push({
      x: pole.x + nx * POLE_LAMP_REACH,
      y: pole.y + ny * POLE_LAMP_REACH,
      z: top - POLE_LAMP_DROP - POLE_LAMP_TALL / 2,
      yaw,
      sx: POLE_LAMP_WIDE,
      sy: POLE_LAMP_TALL,
      sz: POLE_LAMP_LONG,
    });
  }

  // ------------------------------------------------------------------ wires
  for (const span of doc.poleSpans.values()) {
    const a = doc.poles.get(span.a as never);
    const b = doc.poles.get(span.b as never);
    if (!a || !b) continue;
    const topA = crown.get(a.id);
    const topB = crown.get(b.id);
    if (topA === undefined || topB === undefined) continue;

    const yawA = bearingYaw(bearing.get(a.id));
    const yawB = bearingYaw(bearing.get(b.id));

    for (const course of WIRE_COURSES) {
      for (const offset of WIRE_OFFSETS) {
        const ax = a.x + Math.cos(yawA) * POLE_ARM_HALF * offset;
        const ay = a.y + Math.sin(yawA) * POLE_ARM_HALF * offset;
        const bx = b.x + Math.cos(yawB) * POLE_ARM_HALF * offset;
        const by = b.y + Math.sin(yawB) * POLE_ARM_HALF * offset;
        const az = topA - POLE_ARM_DROP + course;
        const bz = topB - POLE_ARM_DROP + course;

        const points = sampleWire(ax, ay, az, bx, by, bz);
        for (let i = 0; i + 1 < points.length; i++) {
          const p = points[i];
          const q = points[i + 1];
          if (!p || !q) continue;
          wirePoints.push(p.x, p.z, -p.y, q.x, q.z, -q.y);
        }
      }
    }
  }

  const metal = new MeshStandardMaterial({
    color: 0x4a4a46,
    roughness: 0.68,
    metalness: 0.35,
  });
  const timber = new MeshStandardMaterial({
    color: 0x6b5941,
    roughness: 0.9,
    metalness: 0,
  });
  const glow = new MeshBasicMaterial({ color: 0xffeec0, toneMapped: false });
  const wireMaterial = new LineBasicMaterial({ color: 0x1b1d1f });

  const mastGeometry = new CylinderGeometry(
    POLE_TOP_RADIUS,
    POLE_BASE_RADIUS,
    POLE_HEIGHT,
    8,
  );
  const boxGeometry = new BoxGeometry(1, 1, 1);

  const meshes = [
    instanced('utility-poles', mastGeometry, timber, masts),
    instanced('utility-arms', boxGeometry, timber, arms),
    instanced('utility-lamp-arms', boxGeometry, metal, lampArms),
    instanced('utility-lamp-heads', boxGeometry, glow, lampHeads),
  ].filter((mesh): mesh is InstancedMesh => mesh !== null);

  let triangles = 0;
  for (const mesh of meshes) {
    group.add(mesh);
    const index = mesh.geometry.index;
    const position = mesh.geometry.getAttribute('position');
    const perInstance = (index ? index.count : position.count) / 3;
    triangles += perInstance * mesh.count;
  }

  let wires: LineSegments | null = null;
  if (wirePoints.length) {
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new Float32BufferAttribute(wirePoints, 3));
    geometry.computeBoundingSphere();
    wires = new LineSegments(geometry, wireMaterial);
    wires.name = 'utility-wires';
    group.add(wires);
  }

  return {
    group,
    triangles,
    dispose() {
      for (const mesh of meshes) mesh.dispose();
      if (wires) wires.geometry.dispose();
      mastGeometry.dispose();
      boxGeometry.dispose();
      metal.dispose();
      timber.dispose();
      glow.dispose();
      wireMaterial.dispose();
      group.clear();
    },
  };
}

const bearingYaw = (along: { x: number; y: number } | undefined): number => {
  if (!along || (!along.x && !along.y)) return 0;
  // The arm is SQUARE to the line, so its own axis is the line's normal.
  return angleOf({ x: -along.y, y: along.x });
};
