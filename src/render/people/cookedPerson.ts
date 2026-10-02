import {
  Bone, BufferAttribute, BufferGeometry, Group, Matrix4, MaterialLoader, type Material, type Object3D, Skeleton, SkinnedMesh, Vector3,
} from 'three';

/**
 * A person's body cooked ahead (`scripts/cook-people.mjs`): the output of
 * building it (shape, garments, rig, face shapes, levels of detail) stored
 * as it is, to be read back instead of built - as engines cook their assets
 * and Unreal's Mutable bakes fixed characters in production.
 *
 * Not glTF: a glTF round trip splits a body's material groups into separate
 * meshes, renames its own attributes and has no place for its levels of
 * detail; the game draws one mesh with groups. The face shapes are stored
 * sparse (glTF's sparse accessor idea): only the vertices that move.
 *
 * Layout: u32 header length, the header as JSON (utf-8), padding to 4, the
 * buffers one after the other (each 4-aligned).
 */

type ArrayKind = 'f32' | 'u32' | 'u16' | 'u8';
interface BufferRef { readonly at: number; readonly length: number; readonly kind: ArrayKind }
interface CookedAttribute { readonly name: string; readonly itemSize: number; readonly normalized: boolean; readonly data: BufferRef }
interface CookedMorph { readonly name: string; readonly vertices: BufferRef; readonly deltas: BufferRef }
interface CookedMesh {
  readonly attributes: CookedAttribute[];
  readonly index: BufferRef | null;
  readonly groups: { start: number; count: number; materialIndex: number }[];
  readonly morphs: CookedMorph[];
  readonly morphRelative: boolean;
  readonly dictionary: Record<string, number>;
  readonly influences: number[];
  readonly lods: { readonly index: BufferRef; readonly groups: { start: number; count: number; materialIndex: number }[] }[];
  readonly bones: number[];
  /** Full precision (the skeleton works in doubles): 16 numbers a bone. */
  readonly inverses: number[];
  readonly bind: number[];
  readonly bindMode: string;
  readonly materials: unknown[];
  readonly materialArray: boolean;
  /** What the shaders read off the geometry (`skinAppearance.ts`): the face's origin and scale, the garments worn. */
  readonly extra: { faceOrigin?: number[]; faceScale?: number; wornGroups?: string[] };
}
interface CookedNode {
  readonly name: string;
  readonly kind: 'bone' | 'skinned' | 'group' | 'node';
  readonly parent: number;
  readonly p: number[];
  readonly q: number[];
  readonly s: number[];
  readonly mesh?: CookedMesh;
}
interface CookedHeader { readonly version: 2; readonly nodes: CookedNode[] }

const KINDS: Record<ArrayKind, { new (buffer: ArrayBuffer, at: number, length: number): ArrayLike<number> & { buffer: ArrayBufferLike }; bytes: number }> = {
  f32: Float32Array as never, u32: Uint32Array as never, u16: Uint16Array as never, u8: Uint8Array as never,
};
const kindOf = (a: ArrayLike<number>): ArrayKind =>
  a instanceof Float32Array ? 'f32' : a instanceof Uint32Array ? 'u32' : a instanceof Uint16Array ? 'u16' : a instanceof Uint8Array ? 'u8' : 'f32';
const BYTES: Record<ArrayKind, number> = { f32: 4, u32: 4, u16: 2, u8: 1 };
/** A face shape's move below this (metres) is rounding left by the fitting, not a movement. */
const MORPH_EPSILON = 1e-5;

/** Packs a built person (its scene, its levels already made) into one buffer. */
export function cookPerson(scene: Object3D): ArrayBuffer {
  const chunks: Uint8Array[] = [];
  let size = 0;
  const put = (array: ArrayLike<number>): BufferRef => {
    const kind = kindOf(array);
    const typed = array instanceof Float32Array || array instanceof Uint32Array || array instanceof Uint16Array || array instanceof Uint8Array
      ? array : Float32Array.from(array);
    const bytes = new Uint8Array(typed.buffer, typed.byteOffset, typed.byteLength);
    const padded = (bytes.byteLength + 3) & ~3;
    const copy = new Uint8Array(padded);
    copy.set(bytes);
    const ref = { at: size, length: typed.length, kind };
    chunks.push(copy);
    size += padded;
    return ref;
  };
  const order: Object3D[] = [];
  scene.traverse((o) => order.push(o));
  const at = new Map(order.map((o, i) => [o, i] as const));
  const nodes = order.map((o): CookedNode => {
    const base = {
      name: o.name, parent: o.parent && at.has(o.parent) ? at.get(o.parent)! : -1,
      p: o.position.toArray(), q: o.quaternion.toArray() as number[], s: o.scale.toArray(),
    };
    if (!(o instanceof SkinnedMesh)) {
      return { ...base, kind: (o as Bone).isBone ? 'bone' : (o as Group).isGroup ? 'group' : 'node' };
    }
    const g: BufferGeometry = o.geometry;
    const count = g.getAttribute('position').count;
    const morphs: CookedMorph[] = (g.morphAttributes['position'] ?? []).map((m, k) => {
      const moved: number[] = [];
      const deltas: number[] = [];
      for (let v = 0; v < count; v++) {
        const x = m.getX(v), y = m.getY(v), z = m.getZ(v);
        // Under a hundredth of a millimetre is arithmetic, not a movement.
        if (Math.hypot(x, y, z) < MORPH_EPSILON) continue;
        moved.push(v);
        deltas.push(x, y, z);
      }
      return { name: m.name || String(k), vertices: put(Uint32Array.from(moved)), deltas: put(Float32Array.from(deltas)) };
    });
    const lodIndices = (g.userData['lodIndices'] as BufferAttribute[] | undefined) ?? [];
    const lodGroups = (g.userData['lodGroups'] as { start: number; count: number; materialIndex: number }[][] | undefined) ?? [];
    const inverses = o.skeleton.boneInverses.flatMap((m) => [...m.elements]);
    const materials = Array.isArray(o.material) ? o.material : [o.material];
    return {
      ...base,
      kind: 'skinned',
      mesh: {
        attributes: Object.entries(g.attributes).map(([name, a]) => ({
          name, itemSize: a.itemSize, normalized: a.normalized, data: put(a.array as ArrayLike<number>),
        })),
        index: g.index ? put(g.index.array as ArrayLike<number>) : null,
        groups: g.groups.map((gr) => ({ start: gr.start, count: gr.count, materialIndex: gr.materialIndex ?? 0 })),
        morphs,
        morphRelative: g.morphTargetsRelative,
        dictionary: { ...(o.morphTargetDictionary ?? {}) },
        influences: [...(o.morphTargetInfluences ?? [])],
        lods: lodIndices.map((index, level) => ({ index: put(index.array as ArrayLike<number>), groups: lodGroups[level] ?? [] })),
        bones: o.skeleton.bones.map((b) => at.get(b) ?? -1),
        inverses,
        bind: [...o.bindMatrix.elements],
        bindMode: o.bindMode,
        materials: materials.map((m) => m.toJSON()),
        materialArray: Array.isArray(o.material),
        extra: {
          ...(g.userData['faceOrigin'] instanceof Vector3 ? { faceOrigin: (g.userData['faceOrigin'] as Vector3).toArray() } : {}),
          ...(typeof g.userData['faceScale'] === 'number' ? { faceScale: g.userData['faceScale'] as number } : {}),
          ...(Array.isArray(g.userData['wornGroups']) ? { wornGroups: [...(g.userData['wornGroups'] as string[])] } : {}),
        },
      },
    };
  });
  const header = new TextEncoder().encode(JSON.stringify({ version: 2, nodes } satisfies CookedHeader));
  const headerPadded = (header.byteLength + 3) & ~3;
  const out = new Uint8Array(4 + headerPadded + size);
  new DataView(out.buffer).setUint32(0, header.byteLength, true);
  out.set(header, 4);
  let offset = 4 + headerPadded;
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.byteLength; }
  return out.buffer;
}

/** The person's scene read back from `cookPerson`'s buffer: bones, skinned mesh, face shapes, levels. */
export function uncookPerson(buffer: ArrayBuffer): Group {
  const view = new DataView(buffer);
  const headerLength = view.getUint32(0, true);
  const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 4, headerLength))) as CookedHeader;
  if (header.version !== 2) throw new Error(`Cooked person version ${String(header.version)}`);
  const base = 4 + ((headerLength + 3) & ~3);
  const get = (ref: BufferRef): ArrayLike<number> => {
    const Kind = KINDS[ref.kind];
    // A copy of its own, 4-aligned: the views are handed to WebGL as they are.
    const bytes = buffer.slice(base + ref.at, base + ref.at + ref.length * BYTES[ref.kind]);
    return new Kind(bytes, 0, ref.length);
  };
  const loader = new MaterialLoader();
  const built: Object3D[] = header.nodes.map((n) => {
    let o: Object3D;
    if (n.kind === 'bone') o = new Bone();
    else if (n.kind === 'skinned' && n.mesh) {
      const m = n.mesh;
      const g = new BufferGeometry();
      for (const a of m.attributes) g.setAttribute(a.name, new BufferAttribute(get(a.data) as Float32Array, a.itemSize, a.normalized));
      if (m.index) g.setIndex(new BufferAttribute(get(m.index) as Uint32Array, 1));
      for (const gr of m.groups) g.addGroup(gr.start, gr.count, gr.materialIndex);
      const count = g.getAttribute('position').count;
      if (m.morphs.length) {
        g.morphAttributes['position'] = m.morphs.map((morph) => {
          const full = new Float32Array(count * 3);
          const vertices = get(morph.vertices);
          const deltas = get(morph.deltas);
          for (let i = 0; i < vertices.length; i++) {
            const v = vertices[i]!;
            full[v * 3] = deltas[i * 3]!; full[v * 3 + 1] = deltas[i * 3 + 1]!; full[v * 3 + 2] = deltas[i * 3 + 2]!;
          }
          const attribute = new BufferAttribute(full, 3);
          attribute.name = morph.name;
          return attribute;
        });
        g.morphTargetsRelative = m.morphRelative;
      }
      g.userData['lodIndices'] = m.lods.map((l) => new BufferAttribute(get(l.index) as Uint32Array, 1));
      g.userData['lodGroups'] = m.lods.map((l) => l.groups);
      g.userData['lodReady'] = Promise.resolve();
      if (m.extra?.faceOrigin) g.userData['faceOrigin'] = new Vector3().fromArray(m.extra.faceOrigin);
      if (m.extra?.faceScale !== undefined) g.userData['faceScale'] = m.extra.faceScale;
      if (m.extra?.wornGroups) g.userData['wornGroups'] = [...m.extra.wornGroups];
      g.computeBoundingBox();
      g.computeBoundingSphere();
      const materials = m.materials.map((json) => loader.parse(json) as Material);
      const mesh = new SkinnedMesh(g, m.materialArray ? materials : materials[0]!);
      if (m.influences.length) {
        mesh.morphTargetInfluences = [...m.influences];
        mesh.morphTargetDictionary = { ...m.dictionary };
      }
      o = mesh;
    } else o = n.kind === 'group' ? new Group() : new Group();
    o.name = n.name;
    o.position.fromArray(n.p);
    o.quaternion.fromArray(n.q);
    o.scale.fromArray(n.s);
    return o;
  });
  header.nodes.forEach((n, i) => { if (n.parent >= 0) built[n.parent]!.add(built[i]!); });
  const root = built[0]!;
  root.updateMatrixWorld(true);
  header.nodes.forEach((n, i) => {
    if (!n.mesh) return;
    const mesh = built[i] as SkinnedMesh;
    const bones = n.mesh.bones.map((b) => built[b] as Bone);
    const inverses = bones.map((_, k) => new Matrix4().fromArray(n.mesh!.inverses, k * 16));
    mesh.bindMode = n.mesh.bindMode as SkinnedMesh['bindMode'];
    mesh.bind(new Skeleton(bones, inverses), new Matrix4().fromArray(n.mesh.bind));
  });
  if (!(root as Group).isGroup) {
    const wrap = new Group();
    wrap.add(root);
    return wrap;
  }
  return root as Group;
}

declare const __PEOPLE_COOK_HASH__: string | undefined;
/** The fingerprint of how people are built in this build (`cook-plugin.ts`); null in tests. */
const COOK_HASH = typeof __PEOPLE_COOK_HASH__ !== 'undefined' ? __PEOPLE_COOK_HASH__ : null;
let manifest: Promise<ReadonlySet<string> | null> | null = null;

/** The ids cooked for this build, or null when there are none (or another build's). */
function cookedIds(): Promise<ReadonlySet<string> | null> {
  manifest ??= (async () => {
    if (!COOK_HASH || typeof fetch === 'undefined') return null;
    if (typeof location !== 'undefined' && new URLSearchParams(location.search).has('nocook')) return null;
    try {
      const response = await fetch('/cooked/people/manifest.json', { cache: 'no-cache' });
      if (!response.ok) return null;
      const m = (await response.json()) as { hash?: string; ids?: string[] };
      return m.hash === COOK_HASH && Array.isArray(m.ids) ? new Set(m.ids) : null;
    } catch {
      return null;
    }
  })();
  return manifest;
}

/** The person cooked for this build, read back; null when it was not cooked (it is built instead). */
export async function loadCookedPerson(id: string): Promise<Group | null> {
  const ids = await cookedIds();
  if (!ids?.has(id)) return null;
  try {
    const response = await fetch(`/cooked/people/${id}.bin`);
    if (!response.ok) return null;
    return uncookPerson(await response.arrayBuffer());
  } catch {
    return null;
  }
}

/** This build's fingerprint, for the cook to stamp its manifest with. */
export const peopleCookHash = (): string | null => COOK_HASH;
