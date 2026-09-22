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
import { GROUND_ONLY, type RoadElevation } from '@world/elevation';
import { FOOTWAY_RISE } from './roadSurfaces';
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

    // The cross-arm lies SQUARE to the line, so its own direction is the
    // line's normal. A pole with no wires on it yet has no line to be square
    // to, and gets an arbitrary but stable bearing rather than a random one.
    const arm = armDirection(bearing.get(pole.id));
    const armYaw = angleOf(arm);

    // An instanced box is scaled on its LOCAL X and then rotated about Y, so
    // the length goes on sx and the yaw is the direction that length points
    // in. Putting the length on sz instead - which is what this did - turns
    // every arm ninety degrees, and a row of poles comes out looking twisted.
    arms.push({
      x: pole.x,
      y: pole.y,
      z: top - POLE_ARM_DROP,
      yaw: armYaw,
      sx: POLE_ARM_HALF * 2,
      sy: POLE_ARM_THICK,
      sz: POLE_ARM_THICK,
    });

    if (!pole.lamp) continue;
    // The lamp reaches out along the arm, over the road side.
    lampArms.push({
      x: pole.x + arm.x * (POLE_LAMP_REACH / 2),
      y: pole.y + arm.y * (POLE_LAMP_REACH / 2),
      z: top - POLE_LAMP_DROP,
      yaw: armYaw,
      sx: POLE_LAMP_REACH,
      sy: POLE_ARM_THICK * 0.8,
      sz: POLE_ARM_THICK * 0.8,
    });
    lampHeads.push({
      x: pole.x + arm.x * POLE_LAMP_REACH,
      y: pole.y + arm.y * POLE_LAMP_REACH,
      z: top - POLE_LAMP_DROP - POLE_LAMP_TALL / 2,
      yaw: armYaw,
      sx: POLE_LAMP_LONG,
      sy: POLE_LAMP_TALL,
      sz: POLE_LAMP_WIDE,
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

    // Each wire leaves its own insulator, so the two ends of a span have to
    // use the SAME course and offset but each pole's own arm direction.
    const armA = armDirection(bearing.get(a.id));
    const armB = armDirection(bearing.get(b.id));

    for (const course of WIRE_COURSES) {
      for (const offset of WIRE_OFFSETS) {
        const ax = a.x + armA.x * POLE_ARM_HALF * offset;
        const ay = a.y + armA.y * POLE_ARM_HALF * offset;
        const bx = b.x + armB.x * POLE_ARM_HALF * offset;
        const by = b.y + armB.y * POLE_ARM_HALF * offset;
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

/**
 * Unit direction of a pole's cross-arm: square to the line it carries.
 *
 * A pole on a bend splits the difference between the two spans reaching it,
 * which is what a real one does. A pole carrying nothing yet still needs an
 * arm pointing somewhere, and the answer has to be STABLE - deriving it from
 * anything that changes as the network is edited makes standing poles spin
 * when a neighbour is added.
 */
function armDirection(along: { x: number; y: number } | undefined): { x: number; y: number } {
  if (!along) return { x: 0, y: 1 };
  const length = Math.hypot(along.x, along.y);
  if (!(length > 1e-9)) return { x: 0, y: 1 };
  // Normal of the run direction.
  return { x: -along.y / length, y: along.x / length };
}

/**
 * Ground a pole stands on: the footway where there is one, the terrain where
 * there is not.
 *
 * A pole beside a street is installed ON the pavement, and the pavement is a
 * kerb height above the carriageway. The terrain is shaped to meet the road,
 * so reading the bare terrain put every pole a kerb-height BELOW the surface
 * it is standing on - which is the "poles do not sit on the footway" defect.
 *
 * Only the ground level is considered. A pole must not climb onto a viaduct
 * passing overhead, and `GROUND_ONLY` is the same filter every other
 * ground-level pass uses.
 */
export function poleGroundAt(
  elevation: RoadElevation,
  terrainAt: (x: number, y: number) => number,
): (x: number, y: number) => number {
  return (x, y) => {
    const road = elevation.roadAt(x, y, GROUND_ONLY);
    // `half` is the CASING half-width, which runs a little past the footway.
    // A pole out on the casing margin is on the verge, not the pavement.
    const onFootway = road.type >= 0 && Math.abs(road.across) <= road.half;
    if (!onFootway) return terrainAt(x, y);
    return elevation.at(x, y, GROUND_ONLY) + FOOTWAY_RISE;
  };
}
