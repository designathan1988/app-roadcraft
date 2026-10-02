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
import { fitProxy, proxySkin, sampleTexture, type ProxyItem } from '@people/body/proxy';
import { wornItems } from '@people/spec';

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
  readonly texturedSkin?: boolean;
  /** The capture avatar's bind, by capture bone name (`captureBind`). */
  readonly capture: ReadonlyMap<string, Vector3>;
  /** And its bones' own axes (`captureBindRotations`). */
  readonly captureAxes?: ReadonlyMap<string, Quaternion>;
  /** The MakeHuman items the look wears, loaded (`loadProxyItem`), by name. */
  readonly proxies?: ReadonlyMap<string, ProxyItem>;
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
  let lowestDm = Infinity;
  for (const [a, b] of bodyRange) for (let v = a; v <= b; v++) lowestDm = Math.min(lowestDm, positions[v * 3 + 1]!);
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

  // Dressed in the look's MakeHuman garments when they are all to hand; the
  // older tailored shells otherwise.
  const items = wornItems(look);
  const dressed = items.length > 0 && items.every((name) => input.proxies?.has(name));
  const pose = (dm: Float32Array, skin: { joints: Uint16Array; weights: Float32Array }): Float32Array => {
    // The steps the body went through: to metres with the body's feet, the
    // posture turn by the item's own skin weights, feet on the ground.
    const out = new Float32Array(dm.length);
    const at = new Vector3(), moved = new Vector3();
    for (let v = 0; v < dm.length / 3; v++) {
      at.set(dm[v * 3]! / 10, (dm[v * 3 + 1]! - lowestDm) / 10, dm[v * 3 + 2]! / 10);
      let x = 0, y = 0, z = 0, sum = 0;
      for (let k = 0; k < 4; k++) {
        const w = skin.weights[v * 4 + k]!;
        if (w <= 0) continue;
        moved.copy(at).applyMatrix4(correction[skin.joints[v * 4 + k]!]!);
        x += moved.x * w; y += moved.y * w; z += moved.z * w; sum += w;
      }
      out[v * 3] = sum > 0 ? x / sum : at.x;
      out[v * 3 + 1] = (sum > 0 ? y / sum : at.y) - lowest;
      out[v * 3 + 2] = sum > 0 ? z / sum : at.z;
    }
    return out;
  };
  const fitted = dressed ? items.map((name) => {
    const item = input.proxies!.get(name)!;
    const skin = proxySkin(item.pack, data.joints, data.weights);
    return { name, item, positions: pose(fitProxy(item.pack, positions), skin), skin };
  }) : [];
  // Child clothing remains tailored to child anatomy. Accessories do not turn
  // a clothed child into the bare body used underneath an adult outfit.
  const shell = !look.outfit && fitted.length
    ? clothedGeometry(data, posed, fitted.some(w => w.item.pack.kind === 'hair')
      ? { ...look, hairStyle: 'none' } : look, input.texturedSkin) : undefined;
  const geometry = dressed
    ? dressedGeometry(data, posed, look, fitted, input.texturedSkin, shell)
    : clothedGeometry(data, posed, look, input.texturedSkin);
  shell?.dispose();
  const skeleton = new Skeleton(bones);
  if (input.texturedSkin) {
    const anchor = (name: string): Vector3 => {
      const point = new Vector3(); let count = 0;
      for (const [a, b] of data.vertexGroups[name] ?? []) for (let v = a; v <= b; v++) {
        point.x += posed[v * 3]!; point.y += posed[v * 3 + 1]!; point.z += posed[v * 3 + 2]!; count++;
      }
      return point.divideScalar(Math.max(1, count));
    };
    const mouth = anchor('joint-mouth'), jaw = anchor('joint-jaw'), crown = anchor('joint-head-2');
    geometry.userData['faceOrigin'] = mouth;
    geometry.userData['faceScale'] = Math.max(0.08, crown.distanceTo(jaw));
  }
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
export function clothedGeometry(data: PersonMeshData, posed: Float32Array, look: PersonLook, texturedSkin = false): BufferGeometry {
  // The tailoring is measured in the packs' decimetres.
  const cut = tailor(data, posed.map((x) => x * 10));
  const parts = facesFor(data, look, cut);
  const planes = hemPlanes(data, posed, look);
  const out: Builder = { positions: [], colours: [], joints: [], weights: [], index: [] };
  const colourOf = partColours(look);
  const uvs: number[] = [], skinMask: number[] = [];
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
  const emitOriginal = (part: Part, v: number, uv: number): number => {
    const key = `${part}:${v}${texturedSkin ? `:${uv}` : ''}`;
    const known = copied.get(key);
    if (known !== undefined) return known;
    const at = out.positions.length / 3;
    out.positions.push(posed[v * 3]!, posed[v * 3 + 1]!, posed[v * 3 + 2]!);
    out.colours.push(...vertexColour(part, v));
    uvs.push(data.uvs?.[uv * 2] ?? 0, data.uvs?.[uv * 2 + 1] ?? 0);
    skinMask.push(part === 'skin' ? 1 - (look.hairStyle === 'none' ? 0 : cut.hair[v]!) : 0);
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
    for (let k = 0; k < 2; k++) uvs.push(uvs[lo * 2 + k]! + (uvs[hi * 2 + k]! - uvs[lo * 2 + k]!) * s);
    skinMask.push(skinMask[lo]! + (skinMask[hi]! - skinMask[lo]!) * s);
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
        let polygon = tri.map((v) => emitOriginal(part, v, data.faceUvs?.[f * 4 + quad.indexOf(v)] ?? 0));
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
  if (texturedSkin) {
    geometry.setAttribute('uv', new BufferAttribute(new Float32Array(uvs), 2));
    geometry.setAttribute('skinMask', new BufferAttribute(new Float32Array(skinMask), 1));
    geometry.setAttribute('hairMask', new BufferAttribute(new Float32Array(out.positions.length / 3), 1));
  }
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(out.positions), 3));
  geometry.setAttribute('color', new BufferAttribute(new Float32Array(out.colours), 3));
  geometry.setAttribute('skinIndex', new BufferAttribute(new Uint16Array(out.joints), 4));
  geometry.setAttribute('skinWeight', new BufferAttribute(new Float32Array(out.weights), 4));
  geometry.setIndex(out.index);
  geometry.computeVertexNormals();
  if (texturedSkin) smoothSkinSeams(geometry);
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  // Coarser levels for people further off (`riggedCitizens.ts` picks one per
  // figure): the same vertices, fewer triangles.
  geometry.userData['lodIndices'] = LOD_CELLS.map((cell) => new BufferAttribute(clusterIndex(out.positions, out.colours, out.index, cell), 1));
  return geometry;
}

/** An sRGB channel, 0..1, to linear. */
const toLinear = (c: number): number => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

/** A MakeHuman item as worn: fitted and posed, metres, with its skin weights. */
export interface WornItem {
  readonly name: string;
  readonly item: ProxyItem;
  readonly positions: Float32Array;
  readonly skin: { readonly joints: Uint16Array; readonly weights: Float32Array };
}

/** Below this texture opacity a hair or lash card is a gap, not hair, in the crowd. */
const SOLID = 0.45;

/**
 * The person dressed in MakeHuman garments: the body, less the skin they hide
 * (each item names the base vertices it covers), its eyes, and each item
 * fitted to the body - colours sampled from the items' textures into the
 * vertices, hair dyed the look's colour, an outfit dyed when the look says
 * so. One geometry, skin weights per vertex, as the crowd draws it.
 */
export function dressedGeometry(data: PersonMeshData, posed: Float32Array, look: PersonLook, worn: readonly WornItem[], texturedSkin = false, shell?: BufferGeometry): BufferGeometry {
  const values = (name: string): number[] => shell ? Array.from(shell.getAttribute(name).array) : [];
  const out: Builder = {
    positions: values('position'), colours: values('color'), joints: values('skinIndex'), weights: values('skinWeight'),
    index: shell?.index ? Array.from(shell.index.array) : [],
  };
  // Texture coordinates and a draw group per item, for drawing it textured
  // close up (`personPreview.ts`); the crowd draws the vertex colours whole.
  const uvs: number[] = shell?.hasAttribute('uv') ? values('uv') : new Array(out.positions.length / 3 * 2).fill(0);
  const skinMask: number[] = shell?.hasAttribute('skinMask') ? values('skinMask') : new Array(out.positions.length / 3).fill(0);
  const hairMask: number[] = new Array(out.positions.length / 3).fill(0);
  const garmentSlot: number[] = new Array(out.positions.length / 3).fill(0);
  const groups: { start: number; count: number; name: string }[] = [];
  const headBone = data.boneNames.indexOf('head');
  const pushSkin = (joints: ArrayLike<number>, weights: ArrayLike<number>, o: number, scale: number): void => {
    // The skull is rigid (as in `clothedGeometry`): hair and brows with it.
    let head = 0;
    for (let k = 0; k < 4; k++) if (joints[o + k] === headBone) head += weights[o + k]! / scale;
    for (let k = 0; k < 4; k++) {
      if (head >= 0.5) { out.joints.push(k === 0 ? headBone : 0); out.weights.push(k === 0 ? 1 : 0); }
      else { out.joints.push(joints[o + k]!); out.weights.push(weights[o + k]! / scale); }
    }
  };

  // --- the body: skin where no garment covers it, the scalp under the hair
  const hidden = new Set<number>();
  for (const w of worn) for (const v of w.item.pack.deleteVerts) hidden.add(v);
  const cut = tailor(data, posed.map((x) => x * 10));
  const skin = new Color(look.skin), hair = new Color(look.hair);
  const hairy = worn.some((w) => w.item.pack.kind === 'hair');
  const iris = new Color(look.eyes);
  const eyeOf = eyeColourer(data, posed, iris);
  const body = data.faceGroups.indexOf('body');
  const eyes = new Set([data.faceGroups.indexOf('helper-l-eye'), data.faceGroups.indexOf('helper-r-eye')]);
  const emitted = new Map<string, number>();
  const emit = (v: number, colour: [number, number, number], uv: number, skin: number): number => {
    const key = texturedSkin ? `${v}:${uv}` : `${v}`;
    const known = emitted.get(key);
    if (known !== undefined) return known;
    const at = out.positions.length / 3;
    out.positions.push(posed[v * 3]!, posed[v * 3 + 1]!, posed[v * 3 + 2]!);
    out.colours.push(...colour);
    uvs.push(data.uvs?.[uv * 2] ?? 0, data.uvs?.[uv * 2 + 1] ?? 0);
    skinMask.push(skin);
    pushSkin(data.joints, data.weights, v * 4, 65535);
    emitted.set(key, at);
    return at;
  };
  const bodyColour = (v: number): [number, number, number] => {
    // Under hair the scalp takes its colour, so no skin shows between strands.
    const h = hairy ? Math.min(1, cut.hair[v]! * 1.6) : 0;
    return [skin.r + (hair.r * 0.8 - skin.r) * h, skin.g + (hair.g * 0.8 - skin.g) * h, skin.b + (hair.b * 0.8 - skin.b) * h];
  };
  for (let f = 0; !shell && f < data.faceGroup.length; f++) {
    const g = data.faceGroup[f]!;
    const isEye = eyes.has(g);
    if (g !== body && !isEye) continue;
    const quad = [data.faces[f * 4]!, data.faces[f * 4 + 1]!, data.faces[f * 4 + 2]!, data.faces[f * 4 + 3]!];
    if (!isEye && quad.some((v) => hidden.has(v))) continue;
    const o = quad.map((v, corner) => emit(v, isEye ? eyeOf(v) : bodyColour(v), data.faceUvs?.[f * 4 + corner] ?? 0,
      isEye ? 0 : 1 - (hairy ? Math.min(1, cut.hair[v]! * 1.6) : 0)));
    out.index.push(o[0]!, o[1]!, o[2]!);
    if (quad[3] !== quad[2]) out.index.push(o[0]!, o[2]!, o[3]!);
  }

  while (hairMask.length < out.positions.length / 3) hairMask.push(0);
  while (garmentSlot.length < out.positions.length / 3) garmentSlot.push(0);
  groups.push({ start: 0, count: out.index.length, name: 'body' });
  // --- the items
  const tint = look.outfitTint === null || look.outfitTint === undefined ? null : new Color(look.outfitTint);
  for (const w of worn) {
    const { pack, texture, transparent } = w.item;
    const kind = pack.kind;
    const base = out.positions.length / 3;
    const n = w.positions.length / 3;
    const alpha = new Float32Array(n);
    for (let v = 0; v < n; v++) {
      out.positions.push(w.positions[v * 3]!, w.positions[v * 3 + 1]!, w.positions[v * 3 + 2]!);
      uvs.push(pack.uvs?.[v * 2] ?? 0, pack.uvs?.[v * 2 + 1] ?? 0);
      hairMask.push(kind === 'hair' ? 1 : 0);
      garmentSlot.push(w.name === look.outfit ? 1 : w.name === look.footwear ? 2 : w.name === look.hat ? 3 : 0);
      // Texture pixels are sRGB; vertex colours are drawn as linear (as
      // `Color` converts the look's colours). Taken raw, every garment came
      // out pale and washed out.
      const raw = sampleTexture(texture, pack.uvs?.[v * 2] ?? 0, pack.uvs?.[v * 2 + 1] ?? 0) ?? [0.55, 0.55, 0.55, 1];
      const t: [number, number, number, number] = [toLinear(raw[0]), toLinear(raw[1]), toLinear(raw[2]), raw[3]];
      alpha[v] = t[3];
      const lum = 0.3 * t[0] + 0.59 * t[1] + 0.11 * t[2];
      let rgb: [number, number, number];
      if (kind === 'hair' || kind === 'eyebrows') {
        // Grey strands, dyed: the texture's light and shade over the look's colour.
        const k = (kind === 'eyebrows' ? 0.7 : 1) * (0.45 + 1.1 * lum);
        rgb = [Math.min(1, hair.r * k), Math.min(1, hair.g * k), Math.min(1, hair.b * k)];
      } else if (kind === 'eyelashes') {
        rgb = [0.06, 0.05, 0.045];
      } else if (tint && w.name === look.outfit) {
        const k = 0.3 + 1.15 * lum;
        rgb = [t[0] + (Math.min(1, tint.r * k) - t[0]) * 0.8, t[1] + (Math.min(1, tint.g * k) - t[1]) * 0.8, t[2] + (Math.min(1, tint.b * k) - t[2]) * 0.8];
      } else rgb = [t[0], t[1], t[2]];
      out.colours.push(...rgb);
      pushSkin(w.skin.joints, w.skin.weights, v * 4, 1);
    }
    const idx = pack.index;
    const start = out.index.length;
    for (let i = 0; i + 2 < idx.length; i += 3) {
      const a = idx[i]!, b = idx[i + 1]!, c = idx[i + 2]!;
      // A crowd draws no see-through cloth: of a hair card only what is hair.
      if (transparent && texture && !(texturedSkin && pack.kind === 'hair') && (alpha[a]! + alpha[b]! + alpha[c]!) / 3 < SOLID) continue;
      out.index.push(base + a, base + b, base + c);
    }
    groups.push({ start, count: out.index.length - start, name: w.name });
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('uv', new BufferAttribute(new Float32Array(uvs), 2));
  if (texturedSkin) {
    while (skinMask.length < out.positions.length / 3) skinMask.push(0);
    geometry.setAttribute('skinMask', new BufferAttribute(new Float32Array(skinMask), 1));
    geometry.setAttribute('hairMask', new BufferAttribute(new Float32Array(hairMask), 1));
    geometry.setAttribute('garmentSlot', new BufferAttribute(new Float32Array(garmentSlot), 1));
  }
  groups.forEach((g, i) => geometry.addGroup(g.start, g.count, i));
  geometry.userData['wornGroups'] = groups.map((g) => g.name);
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(out.positions), 3));
  geometry.setAttribute('color', new BufferAttribute(new Float32Array(out.colours), 3));
  geometry.setAttribute('skinIndex', new BufferAttribute(new Uint16Array(out.joints), 4));
  geometry.setAttribute('skinWeight', new BufferAttribute(new Float32Array(out.weights), 4));
  geometry.setIndex(out.index);
  geometry.computeVertexNormals();
  if (texturedSkin) smoothSkinSeams(geometry);
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  geometry.userData['lodIndices'] = LOD_CELLS.map((cell) => new BufferAttribute(clusterIndex(out.positions, out.colours, out.index, cell), 1));
  return geometry;
}

/** UV splits must not produce a lighting seam across continuous skin. */
function smoothSkinSeams(geometry: BufferGeometry): void {
  const positions = geometry.getAttribute('position'), normals = geometry.getAttribute('normal');
  const mask = geometry.getAttribute('skinMask');
  const groups = new Map<string, number[]>();
  for (let i = 0; i < positions.count; i++) {
    if (mask.getX(i) <= 0) continue;
    const key = `${positions.getX(i)},${positions.getY(i)},${positions.getZ(i)}`;
    const ids = groups.get(key);
    if (ids) ids.push(i); else groups.set(key, [i]);
  }
  const sum = new Vector3();
  for (const ids of groups.values()) {
    if (ids.length < 2) continue;
    sum.set(0, 0, 0);
    for (const i of ids) {
      sum.x += normals.getX(i); sum.y += normals.getY(i); sum.z += normals.getZ(i);
    }
    sum.normalize();
    for (const i of ids) normals.setXYZ(i, sum.x, sum.y, sum.z);
  }
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
