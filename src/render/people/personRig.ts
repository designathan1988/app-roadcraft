import {
  Bone,
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  Group,
  Matrix4,
  MeshStandardMaterial,
  Quaternion,
  Skeleton,
  SkinnedMesh,
  Vector3,
  type Plane,
} from 'three';

import type { PersonLook } from '@people/spec';
import { PART_ORDER, facesFor, hemPlanes, tailor, toMetres, type Part, type PersonMeshData } from './personMesh';

/**
 * A MakeHuman person rigged for the crowd (Person track, H2): a SkinnedMesh
 * the existing bake pipeline (`riggedCitizens.ts`) can play every Rocketbox
 * capture on, as it plays them on a Rocketbox model.
 *
 * The clips are transferred as rotations relative to each body's bind pose,
 * by bone name (`citizenWalk.ts`). So the person is:
 *
 *  1. fitted with the game_engine skeleton, from the joint cubes of THIS
 *     morphed body;
 *  2. put in the capture avatar's posture: MakeHuman rests with its arms 50
 *     degrees down and its legs apart, the captures' avatar with its arms at
 *     44 and its feet under the hips. Each limb is turned, parents first, to
 *     the avatar's direction, and the mesh follows by its skin weights;
 *  3. bound there, its bones named as the captures name theirs (Bip01_*).
 *
 * The clothes' hems are cut INTO the geometry here - every triangle that
 * straddles a hem is clipped against it, new vertices on the cut edges, their
 * skin weights blended - because a crowd of instances cannot carry a clipping
 * plane each. All colour is in the vertices, so the crowd's single material
 * draws the whole person.
 */

/** The armature's scale: bones in centimetres, as the capture avatars have them. */
const ARMATURE_SCALE = 0.01;

/** game_engine bone -> the capture's name for it. */
const CAPTURE_NAME: Readonly<Record<string, string>> = (() => {
  const names: Record<string, string> = {
    Root: 'Bip01', pelvis: 'Bip01_Pelvis', spine_01: 'Bip01_Spine', spine_02: 'Bip01_Spine1', spine_03: 'Bip01_Spine2',
    neck_01: 'Bip01_Neck', head: 'Bip01_Head',
  };
  const fingers = ['thumb', 'index', 'middle', 'ring', 'pinky'];
  for (const [side, s] of [['l', 'L'], ['r', 'R']] as const) {
    Object.assign(names, {
      [`clavicle_${side}`]: `Bip01_${s}_Clavicle`, [`upperarm_${side}`]: `Bip01_${s}_UpperArm`,
      [`lowerarm_${side}`]: `Bip01_${s}_Forearm`, [`hand_${side}`]: `Bip01_${s}_Hand`,
      [`thigh_${side}`]: `Bip01_${s}_Thigh`, [`calf_${side}`]: `Bip01_${s}_Calf`,
      [`foot_${side}`]: `Bip01_${s}_Foot`, [`ball_${side}`]: `Bip01_${s}_Toe0`,
    });
    fingers.forEach((finger, f) => {
      names[`${finger}_01_${side}`] = `Bip01_${s}_Finger${f}`;
      names[`${finger}_02_${side}`] = `Bip01_${s}_Finger${f}1`;
      names[`${finger}_03_${side}`] = `Bip01_${s}_Finger${f}2`;
    });
  }
  return names;
})();

/** Bones turned to the avatar's posture, and the bone whose head they point at. */
const POSTURE: readonly (readonly [string, string])[] = (['l', 'r'] as const).flatMap((s) => [
  [`thigh_${s}`, `calf_${s}`], [`calf_${s}`, `foot_${s}`], [`foot_${s}`, `ball_${s}`],
  [`clavicle_${s}`, `upperarm_${s}`], [`upperarm_${s}`, `lowerarm_${s}`], [`lowerarm_${s}`, `hand_${s}`],
  [`hand_${s}`, `middle_01_${s}`],
] as const);

export interface SkeletonMeta {
  readonly bones: readonly {
    readonly name: string;
    readonly parent: string | null;
    readonly head: { readonly strategy: string; readonly cubeName?: string; readonly vertexIndices?: readonly number[] };
  }[];
}

/** Where a bone's head is on this body, metres. */
function headOf(bone: SkeletonMeta['bones'][number], data: PersonMeshData, metres: Float32Array): Vector3 {
  const verts: number[] = [];
  if (bone.head.strategy === 'CUBE' && bone.head.cubeName) {
    for (const [a, b] of data.vertexGroups[bone.head.cubeName] ?? []) for (let v = a; v <= b; v++) verts.push(v);
  } else {
    verts.push(...(bone.head.vertexIndices ?? []));
  }
  const c = new Vector3();
  for (const v of verts) c.add(new Vector3(metres[v * 3]!, metres[v * 3 + 1]!, metres[v * 3 + 2]!));
  return verts.length ? c.divideScalar(verts.length) : c;
}

export interface PersonRigInput {
  readonly data: PersonMeshData;
  readonly skeleton: SkeletonMeta;
  readonly bodyRange: readonly (readonly [number, number])[];
  /** The morphed body, decimetres (`Morpher.shape`). */
  readonly positions: Float32Array;
  readonly look: PersonLook;
  /** The capture avatar's bind, by capture bone name (`captureBind`). */
  readonly capture: ReadonlyMap<string, Vector3>;
  /** And its bones' own axes (`captureBindRotations`). */
  readonly captureAxes?: ReadonlyMap<string, Quaternion>;
}

export interface PersonRig {
  /** As a GLTF scene would be: a root holding the bones and the skinned mesh. */
  readonly scene: Group;
  readonly mesh: SkinnedMesh;
  /** Standing height in the bind posture, metres. */
  readonly height: number;
}

export function createPersonRig(input: PersonRigInput): PersonRig {
  const { data, skeleton: meta, bodyRange, positions, look, capture } = input;
  const metres = new Float32Array(positions.length);
  toMetres(positions, metres, bodyRange);
  const names = meta.bones.map((b) => b.name);
  const index = new Map(names.map((n, i) => [n, i]));
  const heads = meta.bones.map((b) => headOf(b, data, metres));

  // 2. The posture: a world correction per bone, parents first.
  const order: number[] = [];
  const visit = (i: number): void => {
    order.push(i);
    meta.bones.forEach((b, j) => {
      if (b.parent === names[i]) visit(j);
    });
  };
  meta.bones.forEach((b, i) => {
    if (b.parent === null) visit(i);
  });
  const correction = meta.bones.map(() => new Matrix4());
  const target = new Map(POSTURE);
  for (const i of order) {
    const bone = meta.bones[i]!;
    const parent = bone.parent === null ? undefined : index.get(bone.parent);
    const c = parent === undefined ? new Matrix4() : correction[parent]!.clone();
    const towards = target.get(bone.name);
    const child = towards === undefined ? undefined : index.get(towards);
    const from = capture.get(CAPTURE_NAME[bone.name] ?? '');
    const to = towards === undefined ? undefined : capture.get(CAPTURE_NAME[towards] ?? '');
    if (child !== undefined && from && to) {
      const head = heads[i]!.clone().applyMatrix4(c);
      const now = heads[child]!.clone().applyMatrix4(c).sub(head).normalize();
      const want = to.clone().sub(from).normalize();
      const turn = new Matrix4().makeRotationFromQuaternion(new Quaternion().setFromUnitVectors(now, want));
      c.premultiply(new Matrix4().makeTranslation(-head.x, -head.y, -head.z))
        .premultiply(turn)
        .premultiply(new Matrix4().makeTranslation(head.x, head.y, head.z));
    }
    correction[i] = c;
  }

  // The mesh follows by its skin weights; the bones' heads by their parents.
  const posed = new Float32Array(metres.length);
  const p = new Vector3();
  const q = new Vector3();
  for (let v = 0; v < data.vertexCount; v++) {
    p.set(metres[v * 3]!, metres[v * 3 + 1]!, metres[v * 3 + 2]!);
    let sum = 0;
    let x = 0, y = 0, z = 0;
    for (let k = 0; k < 4; k++) {
      const w = data.weights[v * 4 + k]! / 65535;
      if (w === 0) continue;
      q.copy(p).applyMatrix4(correction[data.joints[v * 4 + k]!]!);
      x += q.x * w;
      y += q.y * w;
      z += q.z * w;
      sum += w;
    }
    if (sum > 0) {
      posed[v * 3] = x / sum;
      posed[v * 3 + 1] = y / sum;
      posed[v * 3 + 2] = z / sum;
    } else {
      posed[v * 3] = p.x;
      posed[v * 3 + 1] = p.y;
      posed[v * 3 + 2] = p.z;
    }
  }
  const boneHead = meta.bones.map((b, i) => {
    const parent = b.parent === null ? undefined : index.get(b.parent);
    return heads[i]!.clone().applyMatrix4(parent === undefined ? correction[i]! : correction[parent]!);
  });
  // Feet on the ground again after the turn.
  let lowest = Infinity;
  let highest = -Infinity;
  for (const [a, b] of bodyRange) {
    for (let v = a; v <= b; v++) {
      lowest = Math.min(lowest, posed[v * 3 + 1]!);
      highest = Math.max(highest, posed[v * 3 + 1]!);
    }
  }
  for (let v = 0; v < data.vertexCount; v++) posed[v * 3 + 1] = posed[v * 3 + 1]! - lowest;
  for (const h of boneHead) h.y -= lowest;

  // 3. Bones in the bind posture, named as the captures name them, and built
  //    as the capture avatar's are: each bone turned to that avatar's own
  //    axes for it, in centimetres under an armature scaled to metres. Code
  //    written for those bodies - the helmet fitted in the head's frame, the
  //    rider's IK aiming a bone along its own axis - then holds on this one.
  const armature = new Group();
  armature.name = 'Armature';
  armature.scale.setScalar(ARMATURE_SCALE);
  armature.updateMatrixWorld(true);
  const bones = meta.bones.map((b) => {
    const bone = new Bone();
    bone.name = CAPTURE_NAME[b.name] ?? b.name;
    return bone;
  });
  const worldOf = meta.bones.map((b, i) => new Matrix4().compose(
    boneHead[i]!,
    input.captureAxes?.get(CAPTURE_NAME[b.name] ?? '') ?? new Quaternion(),
    new Vector3(ARMATURE_SCALE, ARMATURE_SCALE, ARMATURE_SCALE),
  ));
  for (const i of order) {
    const b = meta.bones[i]!;
    const parent = b.parent === null ? undefined : index.get(b.parent);
    const parentWorld = parent === undefined ? armature.matrixWorld : worldOf[parent]!;
    const local = parentWorld.clone().invert().multiply(worldOf[i]!);
    local.decompose(bones[i]!.position, bones[i]!.quaternion, bones[i]!.scale);
    (parent === undefined ? armature : bones[parent]!).add(bones[i]!);
  }
  const roots = [armature];

  const geometry = clothedGeometry(data, posed, look);
  const skeleton = new Skeleton(bones);
  const material = new MeshStandardMaterial({ vertexColors: true, roughness: 0.82, metalness: 0, side: DoubleSide });
  const mesh = new SkinnedMesh(geometry, material);
  mesh.name = 'person';
  const scene = new Group();
  scene.add(...roots, mesh);
  scene.updateMatrixWorld(true);
  mesh.bind(skeleton);
  return { scene, mesh, height: highest - lowest };
}

// ---------------------------------------------------------------- geometry

interface Builder {
  positions: number[];
  colours: number[];
  joints: number[];
  weights: number[];
  index: number[];
}

/**
 * The person as one indexed geometry, hems cut in, colours in the vertices,
 * skin weights per vertex (bone indices in the skeleton's order).
 */
export function clothedGeometry(data: PersonMeshData, posed: Float32Array, look: PersonLook): BufferGeometry {
  // The tailoring is measured in the packs' decimetres.
  const cut = tailor(data, posed.map((x) => x * 10));
  const parts = facesFor(data, look, cut);
  const planes = hemPlanes(data, posed, look);
  const out: Builder = { positions: [], colours: [], joints: [], weights: [], index: [] };
  const colourOf = partColours(look);
  // Original vertices are copied once per part they appear in (a vertex has one colour).
  const copied = new Map<string, number>();
  const edges = new Map<string, number>();
  const skin = new Color(look.skin);
  const hair = new Color(look.hair);
  const iris = new Color(look.eyes);
  const eyeOf = eyeColourer(data, posed, iris);

  const vertexColour = (part: Part, v: number): [number, number, number] => {
    if (part === 'skin' && look.hairStyle !== 'none') {
      const h = cut.hair[v]!;
      return [skin.r + (hair.r - skin.r) * h, skin.g + (hair.g - skin.g) * h, skin.b + (hair.b - skin.b) * h];
    }
    if (part === 'eyes') return eyeOf(v);
    return colourOf[part];
  };
  // The skull is rigid: a vertex the head bone mostly owns moves with the
  // head alone. Shared with the neck, it flexed when the neck turned, and a
  // helmet fitted at rest no longer held it.
  const headBone = data.boneNames.indexOf('head');
  const emitOriginal = (part: Part, v: number): number => {
    const key = `${part}:${v}`;
    const known = copied.get(key);
    if (known !== undefined) return known;
    const at = out.positions.length / 3;
    out.positions.push(posed[v * 3]!, posed[v * 3 + 1]!, posed[v * 3 + 2]!);
    out.colours.push(...vertexColour(part, v));
    let head = 0;
    for (let k = 0; k < 4; k++) if (data.joints[v * 4 + k] === headBone) head += data.weights[v * 4 + k]! / 65535;
    for (let k = 0; k < 4; k++) {
      if (head >= 0.5) {
        out.joints.push(k === 0 ? headBone : 0);
        out.weights.push(k === 0 ? 1 : 0);
      } else {
        out.joints.push(data.joints[v * 4 + k]!);
        out.weights.push(data.weights[v * 4 + k]! / 65535);
      }
    }
    copied.set(key, at);
    return at;
  };
  /**
   * A new vertex where a plane crosses the edge between two OUTPUT vertices:
   * position and colour blended, skin weights merged and the four strongest
   * kept. Shared by the triangles on both sides of the edge.
   */
  const emitCut = (a: number, b: number, t: number, plane: number): number => {
    const lo = Math.min(a, b), hi = Math.max(a, b);
    const s = a < b ? t : 1 - t;
    const key = `${lo}:${hi}:${plane}`;
    const known = edges.get(key);
    if (known !== undefined) return known;
    const at = out.positions.length / 3;
    for (let k = 0; k < 3; k++) out.positions.push(out.positions[lo * 3 + k]! + (out.positions[hi * 3 + k]! - out.positions[lo * 3 + k]!) * s);
    for (let k = 0; k < 3; k++) out.colours.push(out.colours[lo * 3 + k]! + (out.colours[hi * 3 + k]! - out.colours[lo * 3 + k]!) * s);
    const blend = new Map<number, number>();
    for (const [v, share] of [[lo, 1 - s], [hi, s]] as const) {
      for (let k = 0; k < 4; k++) {
        const w = out.weights[v * 4 + k]! * share;
        if (w > 0) blend.set(out.joints[v * 4 + k]!, (blend.get(out.joints[v * 4 + k]!) ?? 0) + w);
      }
    }
    const top = [...blend].sort((x, y) => y[1] - x[1]).slice(0, 4);
    const total = top.reduce((sum, [, w]) => sum + w, 0) || 1;
    for (let k = 0; k < 4; k++) {
      out.joints.push(top[k]?.[0] ?? 0);
      out.weights.push((top[k]?.[1] ?? 0) / total);
    }
    edges.set(key, at);
    return at;
  };

  const planeList: Plane[] = [];
  const planeFor = new Map<Part, Plane[]>([['top', planes.top], ['sleeves', planes.sleeves], ['bottom', planes.bottom]]);
  for (const list of planeFor.values()) planeList.push(...list);
  const where = new Vector3();
  const distance = (plane: Plane, o: number): number =>
    plane.distanceToPoint(where.set(out.positions[o * 3]!, out.positions[o * 3 + 1]!, out.positions[o * 3 + 2]!));

  for (const part of PART_ORDER) {
    const hems = planeFor.get(part) ?? [];
    for (const f of parts.get(part)!) {
      const quad = [data.faces[f * 4]!, data.faces[f * 4 + 1]!, data.faces[f * 4 + 2]!, data.faces[f * 4 + 3]!];
      const triangles = quad[3] === quad[2] ? [[quad[0]!, quad[1]!, quad[2]!]] : [[quad[0]!, quad[1]!, quad[2]!], [quad[0]!, quad[2]!, quad[3]!]];
      for (const tri of triangles) {
        // Sutherland-Hodgman against every hem of the part, in turn: what is
        // left of the triangle after each cut is cut by the next.
        let polygon = tri.map((v) => emitOriginal(part, v));
        for (const plane of hems) {
          const ds = polygon.map((o) => distance(plane, o));
          if (ds.every((d) => d >= 0)) continue;
          if (ds.every((d) => d < 0)) {
            polygon = [];
            break;
          }
          const pi = planeList.indexOf(plane);
          const kept: number[] = [];
          for (let k = 0; k < polygon.length; k++) {
            const a = polygon[k]!, b = polygon[(k + 1) % polygon.length]!;
            const da = ds[k]!, db = ds[(k + 1) % polygon.length]!;
            if (da >= 0) kept.push(a);
            if ((da >= 0) !== (db >= 0)) kept.push(emitCut(a, b, da / (da - db), pi));
          }
          polygon = kept;
        }
        for (let k = 1; k + 1 < polygon.length; k++) out.index.push(polygon[0]!, polygon[k]!, polygon[k + 1]!);
      }
    }
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(out.positions), 3));
  geometry.setAttribute('color', new BufferAttribute(new Float32Array(out.colours), 3));
  geometry.setAttribute('skinIndex', new BufferAttribute(new Uint16Array(out.joints), 4));
  geometry.setAttribute('skinWeight', new BufferAttribute(new Float32Array(out.weights), 4));
  geometry.setIndex(out.index);
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  // Coarser levels for people further off (`riggedCitizens.ts` picks one per
  // figure): the same vertices, fewer triangles.
  geometry.userData['lodIndices'] = LOD_CELLS.map((cell) => new BufferAttribute(clusterIndex(out.positions, out.colours, out.index, cell), 1));
  return geometry;
}

/** Cell sizes of the coarser levels, metres. */
const LOD_CELLS = [0.03, 0.08] as const;

/**
 * Vertex clustering: every vertex is replaced by the first one in its cell
 * of a grid (a cell per colour, so a hem keeps its edge), and the triangles
 * that collapse are dropped. The result indexes the same vertex buffers, so
 * skinning and colours are untouched.
 */
export function clusterIndex(positions: readonly number[], colours: readonly number[], index: readonly number[], cell: number): Uint32Array {
  const representative = new Map<string, number>();
  const map = new Uint32Array(positions.length / 3);
  for (let v = 0; v < map.length; v++) {
    const key = `${Math.floor(positions[v * 3]! / cell)},${Math.floor(positions[v * 3 + 1]! / cell)},${Math.floor(positions[v * 3 + 2]! / cell)}`
      + `|${Math.round(colours[v * 3]! * 8)},${Math.round(colours[v * 3 + 1]! * 8)},${Math.round(colours[v * 3 + 2]! * 8)}`;
    let r = representative.get(key);
    if (r === undefined) representative.set(key, (r = v));
    map[v] = r;
  }
  const out: number[] = [];
  const seen = new Set<string>();
  for (let i = 0; i + 2 < index.length; i += 3) {
    const a = map[index[i]!]!, b = map[index[i + 1]!]!, c = map[index[i + 2]!]!;
    if (a === b || b === c || a === c) continue;
    const key = [a, b, c].sort((x, y) => x - y).join(',');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(a, b, c);
  }
  return Uint32Array.from(out);
}

function partColours(look: PersonLook): Record<Part, [number, number, number]> {
  const c = (hex: number): [number, number, number] => {
    const k = new Color(hex);
    return [k.r, k.g, k.b];
  };
  return {
    skin: c(look.skin), top: c(look.topColour), sleeves: c(look.topColour), bottom: c(look.bottomColour),
    shoes: c(look.shoes), hair: c(look.hair), eyes: c(0xeeeae2), lashes: c(0x16110e),
  };
}

/** The eye colour of a vertex of either eyeball: white, iris, pupil. */
function eyeColourer(data: PersonMeshData, posed: Float32Array, iris: Color): (v: number) => [number, number, number] {
  const range = new Map<number, { front: number; depth: number }>();
  for (const name of ['helper-l-eye', 'helper-r-eye']) {
    const g = data.faceGroups.indexOf(name);
    const verts: number[] = [];
    for (let f = 0; f < data.faceGroup.length; f++) {
      if (data.faceGroup[f] !== g) continue;
      for (let c = 0; c < 4; c++) verts.push(data.faces[f * 4 + c]!);
    }
    let front = -Infinity, back = Infinity;
    for (const v of verts) {
      front = Math.max(front, posed[v * 3 + 2]!);
      back = Math.min(back, posed[v * 3 + 2]!);
    }
    for (const v of verts) range.set(v, { front, depth: Math.max(1e-6, front - back) });
  }
  return (v) => {
    const r = range.get(v);
    if (!r) return [0.93, 0.91, 0.88];
    const t = (r.front - posed[v * 3 + 2]!) / r.depth;
    return t < 0.02 ? [0.05, 0.04, 0.035] : t < 0.07 ? [iris.r, iris.g, iris.b] : [0.93, 0.91, 0.88];
  };
}
