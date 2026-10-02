import {
  BoxGeometry, BufferGeometry, ConeGeometry, CylinderGeometry, DynamicDrawUsage, Float32BufferAttribute, Group,
  InstancedMesh, Matrix4, MeshStandardMaterial, Quaternion, Vector3,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * What people hold while they do something (`sim/people` gestures): a
 * newspaper, a cup, a phone, a camera, a shopping bag, an umbrella. Each is
 * one small model in metres, its grip at the origin of the hand bone it is
 * held in, drawn instanced: one draw per kind for the whole town.
 */
export type HeldKind = 'newspaper' | 'cup' | 'phone' | 'camera' | 'bag' | 'umbrella';

/** Which hand holds what each gesture shows, and what it is. */
export const HELD: Readonly<Partial<Record<string, { kind: HeldKind; left?: boolean }>>> = {
  read: { kind: 'newspaper' }, // a book, held as the phone is (`citizenGait` plays the phone clip)
  drink: { kind: 'cup' },
  phone: { kind: 'phone' },
  photo: { kind: 'camera' },
  bag: { kind: 'bag' },
  umbrella: { kind: 'umbrella' },
};

type RGB = readonly [number, number, number];
const hex = (h: number): RGB => [((h >> 16) & 255) / 255, ((h >> 8) & 255) / 255, (h & 255) / 255];

function paint(g: BufferGeometry, c: RGB, x = 0, y = 0, z = 0): BufferGeometry {
  g.translate(x, y, z);
  const flat = g.index ? g.toNonIndexed() : g;
  const n = flat.getAttribute('position').count;
  const colours = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) colours.set(c, i * 3);
  flat.setAttribute('color', new Float32BufferAttribute(colours, 3));
  if (flat.hasAttribute('uv')) flat.deleteAttribute('uv');
  return flat;
}

function model(kind: HeldKind): BufferGeometry {
  // In the hand bone's frame: +X from the wrist along the fingers, +Y out
  // through the thumb, +Z out of the back of the hand (the palm is -Z).
  // Measured with coloured axes on a drawn figure.
  const parts: BufferGeometry[] = [];
  switch (kind) {
    case 'newspaper':
      // A book (or a magazine) open on the palm, read held in front.
      parts.push(paint(new BoxGeometry(0.21, 0.16, 0.025), hex(0x7a2e2e), 0.09, 0.02, -0.03));
      parts.push(paint(new BoxGeometry(0.2, 0.15, 0.02), hex(0xf1ece0), 0.09, 0.02, -0.045));
      break;
    case 'cup':
      // Upright (\`UPRIGHT\`): gripped round its middle.
      parts.push(paint(new CylinderGeometry(0.04, 0.033, 0.11, 12), hex(0xf3f1ea), 0, 0, 0));
      parts.push(paint(new CylinderGeometry(0.041, 0.041, 0.012, 12), hex(0x3a2a20), 0, 0.055, 0));
      break;
    case 'phone':
      parts.push(paint(new BoxGeometry(0.14, 0.07, 0.01), hex(0x16191c), 0.08, 0.0, -0.025));
      break;
    case 'camera':
      parts.push(paint(new BoxGeometry(0.1, 0.13, 0.07), hex(0x202326), 0.07, 0.02, -0.06));
      parts.push(paint(new CylinderGeometry(0.03, 0.03, 0.06, 10).rotateX(Math.PI / 2), hex(0x111214), 0.07, 0.02, -0.12));
      break;
    case 'bag':
      // Upright: hanging from the fist, the handles up to it, the bag below.
      parts.push(paint(new BoxGeometry(0.012, 0.1, 0.012), hex(0x6b5134), 0, -0.05, 0));
      parts.push(paint(new BoxGeometry(0.3, 0.34, 0.12), hex(0xb08a5a), 0, -0.27, 0));
      break;
    case 'umbrella': {
      // Upright: the shaft through the fist, the canopy above the head.
      parts.push(paint(new CylinderGeometry(0.012, 0.012, 0.95, 6), hex(0x2a2a2a), 0, 0.33, 0));
      parts.push(paint(new ConeGeometry(0.55, 0.22, 16, 1, true), hex(0x1d3557), 0, 0.9, 0));
      break;
    }
  }
  const merged = mergeGeometries(parts, false)!;
  for (const g of parts) g.dispose();
  merged.computeVertexNormals();
  return merged;
}

/**
 * Things that hang or stand by their own weight - a cup, a bag, an umbrella -
 * are drawn upright where the hand holds them, turned the way its thumb
 * points; the rest lie in the hand as it turns. The value is where in the
 * hand (its bone's frame, metres) the grip is.
 */
const UPRIGHT: Partial<Record<HeldKind, readonly [number, number, number]>> = {
  cup: [0.07, 0.0, -0.05],
  bag: [0.08, 0.0, -0.02],
  umbrella: [0.06, 0.0, -0.03],
};

const UP = new Vector3(0, 1, 0);
const HELD_KINDS: readonly HeldKind[] = ['newspaper', 'cup', 'phone', 'camera', 'bag', 'umbrella'];
const CAPACITY = 300;

export interface HeldProps {
  readonly group: Group;
  begin(): void;
  /** One `kind` in the hand whose matrix (model to world) is `hand`, on a body drawn at `scale` world units per metre. */
  place(kind: HeldKind, hand: Matrix4, scale: number): void;
  dispose(): void;
}

export function createHeldProps(): HeldProps {
  const group = new Group();
  group.name = 'held-props';
  const material = new MeshStandardMaterial({ vertexColors: true, roughness: 0.7, metalness: 0 });
  const meshes = new Map<HeldKind, InstancedMesh>();
  for (const kind of HELD_KINDS) {
    const mesh = new InstancedMesh(model(kind), material, CAPACITY);
    mesh.name = `held-${kind}`;
    mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    mesh.frustumCulled = false;
    mesh.castShadow = true;
    mesh.count = 0;
    meshes.set(kind, mesh);
    group.add(mesh);
  }
  const position = new Vector3(), turn = new Quaternion(), size = new Vector3(), out = new Matrix4();
  const grip = new Vector3(), thumb = new Vector3(), upright = new Quaternion();
  return {
    group,
    begin() {
      for (const mesh of meshes.values()) mesh.count = 0;
    },
    place(kind, hand, scale) {
      const mesh = meshes.get(kind)!;
      if (mesh.count >= CAPACITY) return;
      // The hand's place and turn; the thing's own size, at the body's scale.
      hand.decompose(position, turn, size);
      const at = UPRIGHT[kind];
      if (at) {
        // Where the fist is, standing straight, turned to the thumb.
        position.add(grip.set(at[0], at[1], at[2]).multiplyScalar(scale).applyQuaternion(turn));
        thumb.set(0, 1, 0).applyQuaternion(turn);
        upright.setFromAxisAngle(UP, Math.atan2(-thumb.z, thumb.x));
        out.compose(position, upright, size.set(scale, scale, scale));
      } else out.compose(position, turn, size.set(scale, scale, scale));
      mesh.setMatrixAt(mesh.count++, out);
      mesh.instanceMatrix.needsUpdate = true;
    },
    dispose() {
      for (const mesh of meshes.values()) { mesh.geometry.dispose(); mesh.dispose(); }
      material.dispose();
    },
  };
}
