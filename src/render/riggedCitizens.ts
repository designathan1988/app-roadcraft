import {
  BufferGeometry, Color, DataTexture, DynamicDrawUsage, Float32BufferAttribute, FloatType, Group, InstancedMesh,
  Matrix4, MeshDepthMaterial, MeshStandardMaterial, Object3D, Quaternion, RGBAFormat,
  RGBADepthPacking, SkinnedMesh, Texture, Vector3, type BufferAttribute,
} from 'three';
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { personHash, type PartyView, type PedView } from '@sim/people/view';
import { DT } from '@sim/params';
import { m } from '@world/units';
import { CROWD, CROWD_IDS, CastingRegistry, type CastingContext, type Company } from './citizenCasting';
import { NO_HELMET, type RiderClipKey } from './riderPoses';
import { CITIZEN_ASSET_URLS, CITIZEN_LICENSES } from './citizenAssets';
import type { CitizenModel } from './citizenCasting';
import { loadPeopleAssets } from '@people/body/assets';
import { Morpher } from '@people/body/morph';
import { createPersonRig, personSimplifier } from './people/personRig';
import { compileAhead, warmAhead } from './uploads';
import { bakeInWorker } from './bakePool';
import { cookPerson, loadCookedPerson, peopleCookHash } from './people/cookedPerson';
import { HELD, createHeldProps } from './people/heldProps';
import { attachFacialMorphs } from './people/facialMorphs';
import { applyFace, channelShapes, faceAt, type FaceWeights } from './people/faceExpression';
import { expressionShapes } from '@people/body/expressions';
import { applySkinAppearance, loadSkinAppearance, type SkinAppearance } from './people/skinAppearance';
import { loadProxyItem, type ProxyItem } from '@people/body/proxy';
import { wornItems } from '@people/spec';
import { captureBind, captureBindRotations, loadRocketboxLibrary } from './citizenWalk';
import { type Gradient, shearMatrix } from './groundShear';
import { createGait, gaitHeading, gaitPlays, stepGait, type Gait, type GaitClips, type GaitPlay } from './citizenGait';
import {
  CARRY_AT, GAIT_AT, LIBRARY_AT, RIDER_AT, WALK, WALK_ELDER, afterFrame, bake, gaitClips,
  type CitizenClipKey, type ClipFrames, type Deferred, type Played,
} from './citizenBake';

export type { CitizenClipKey } from './citizenBake';
export { CROWD_IDS } from './citizenCasting';
const CAPACITY = 1000;
interface CitizenBatch {
  meshes: InstancedMesh[]; sources: SkinnedMesh[]; local: Matrix4[]; clips: ClipFrames[];
  /** The same baked clips, by the name the gait plays them by. */
  gait: GaitClips;
  texture: DataTexture; pixels: Float32Array; width: number; count: number;
  rows: number; uniform: { value: DataTexture };
  lods: BufferGeometry[][];
  /** This body's helmet in its head bone's frame (`riderPoses.helmetShape`), or null. */
  helmet: Matrix4 | null;
  /** Clips still to bake, on first use (`Deferred`), one at a time. */
  deferred: Deferred;
  baking: Promise<void>;
}

/** The company a walker is dressed with (`citizenCasting.codesFor`): their party's kind, or alone. */
export function companyOf(party: Pick<PartyView, 'size' | 'archetype'>): Company {
  return party.size > 1 ? party.archetype : 'solo';
}

/** Frames undrawn after which a person's body is forgotten: about a minute. */
const CAST_FORGET = 3600;

/** Who a figure drawn by `drawClip` is and with whom: the casting context without the place. */
export interface ClipIdentity {
  readonly seed: number;
  readonly gender: 'f' | 'm';
  readonly ageClass: 'child' | 'adult' | 'elder';
  readonly company: Company;
  readonly companyId: number;
  readonly hasChild?: boolean;
}

const SKINNING = `
uniform sampler2D citizenBones;
uniform mat4 bindMatrix;
uniform mat4 bindMatrixInverse;
mat4 getBoneMatrix(const in float i) {
  int x = int(i)*4;
  int y = gl_InstanceID;
  return mat4(texelFetch(citizenBones,ivec2(x,y),0),
    texelFetch(citizenBones,ivec2(x+1,y),0),
    texelFetch(citizenBones,ivec2(x+2,y),0),
    texelFetch(citizenBones,ivec2(x+3,y),0));
}`;

const CHILD_SHIRTS = [0x000000, 0x479f94, 0xe5b25d, 0x9672b7] as const;

/**
 * Whether somebody seated in a vehicle is talking now: in spells of a few
 * seconds, now and then, each person on their own rhythm.
 */
function seatedChat(seed: number, time: number): boolean {
  const hash = personHash(seed ^ 0x2f6b1d93);
  if ((hash & 3) === 0) return false; // a quiet traveller
  const cycle = 14 + (hash >>> 4 & 7) * 2;
  return ((time + (hash >>> 8 & 255) / 10) % cycle) < cycle * 0.3;
}

function setFacialExpression(batch: CitizenBatch, slot: number, face: FaceWeights): void {
  for (let i = 0; i < batch.meshes.length; i++) {
    const source = batch.sources[i]!;
    const influences = source.morphTargetInfluences;
    const targets = source.morphTargetDictionary;
    if (!influences || !targets) continue;
    applyFace(influences, targets, face);
    const mesh = batch.meshes[i]!;
    // three allocates an InstancedMesh's morph texture from `count`. Batches
    // start invisible at count zero, so reserve their fixed capacity only for
    // that first allocation, then restore the visible count for this frame.
    const visible = mesh.count;
    if (mesh.morphTexture === null) mesh.count = CAPACITY;
    mesh.setMorphAt(slot, source);
    mesh.count = visible;
  }
}

function markChildShirt(mesh: SkinnedMesh): void {
  const geometry = mesh.geometry;
  if (geometry.getAttribute('clothingMask')) return;
  const uv = geometry.getAttribute('uv');
  const skin = geometry.getAttribute('skinIndex');
  const weights = geometry.getAttribute('skinWeight');
  const count = geometry.getAttribute('position').count;
  const mask = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    if (!uv || uv.getX(i) < 0.32 || uv.getX(i) > 0.68) continue;
    let torso = 0;
    for (let k = 0; k < 4; k++) {
      const bone = mesh.skeleton.bones[skin.getComponent(i, k)];
      if (bone && /^Bip01_(Pelvis|Spine|Spine1|Spine2)$/.test(bone.name)) torso += weights.getComponent(i, k);
    }
    mask[i] = torso > 0.5 ? 1 : 0;
  }
  geometry.setAttribute('clothingMask', new Float32BufferAttribute(mask, 1));
}

function skinMaterial(material: MeshStandardMaterial | MeshDepthMaterial, uniform: { value: DataTexture },
  mesh: SkinnedMesh, look = 0): void {
  material.defines = { ...material.defines, USE_SKINNING: '' };
  material.onBeforeCompile = shader => {
    shader.uniforms.citizenBones = uniform;
    shader.uniforms.bindMatrix = { value: mesh.bindMatrix };
    shader.uniforms.bindMatrixInverse = { value: mesh.bindMatrixInverse };
    shader.vertexShader = shader.vertexShader.replace('#include <skinning_pars_vertex>', SKINNING);
    if (look > 0 && material instanceof MeshStandardMaterial) {
      const tint = new Color(CHILD_SHIRTS[look]!);
      shader.vertexShader = `attribute float clothingMask; varying float vClothingMask;\n${shader.vertexShader}`
        .replace('#include <begin_vertex>', '#include <begin_vertex>\n vClothingMask = clothingMask;');
      shader.fragmentShader = `varying float vClothingMask;\n${shader.fragmentShader}`;
      // The centre island of the Rocketbox child body atlas is the shirt.
      // Its folds and printed white details remain; hands, face and hair are
      // outside that UV island and keep their authored colour.
      shader.fragmentShader = shader.fragmentShader.replace('#include <map_fragment>', `
        #include <map_fragment>
        #ifdef USE_MAP
        float shirtHigh = max(diffuseColor.r, max(diffuseColor.g, diffuseColor.b));
        float shirtLow = min(diffuseColor.r, min(diffuseColor.g, diffuseColor.b));
        if (vClothingMask > 0.5 && shirtHigh - shirtLow > 0.09) {
          float shade = clamp(shirtHigh / 0.68, 0.35, 1.2);
          diffuseColor.rgb = vec3(${tint.r.toFixed(6)}, ${tint.g.toFixed(6)}, ${tint.b.toFixed(6)}) * shade;
        }
        #endif
      `);
    }
  };
  material.customProgramCacheKey = () => `citizen-skinning-v2-look${look}`;
}

/** How far over somebody who tripped is, radians, `t` seconds into a fall that lasts `hold`. */
function fallLean(t: number, hold: number): number {
  const down = 0.7, up = 1.4;
  const ease = (u: number): number => u * u * (3 - 2 * u);
  if (t < down) return (Math.PI / 2) * Math.min(1, ease(t / down) * 1.04);
  if (t > hold - up) return (Math.PI / 2) * ease(Math.max(0, hold - t) / up);
  return Math.PI / 2;
}

export function createRiggedCitizens(models: readonly string[] = CROWD_IDS,
  onAssetsReady: () => void = () => {}) {
  const group = new Group();
  group.name = 'rigged-citizens';
  const batches = new Map<number, CitizenBatch>();
  const loading = new Map<number, Promise<void>>();
  // As many bodies in hand as there are bake workers to keep busy (`bakePool.ts`).
  const slots: Promise<void>[] = Array.from({ length: 6 }, () => Promise.resolve());
  let nextSlot = 0;
  const resources = new Set<{ dispose(): void }>();
  const motion = new WeakMap<PedView, Gait>();
  const plays: GaitPlay[] = [];
  const transform = new Object3D();
  // What people hold while they stop to do something (`heldProps.ts`).
  const held = createHeldProps();
  group.add(held.group);
  resources.add(held);
  const boxR = new Vector3(), boxL = new Vector3(), boxAt = new Vector3(), boxSize = new Vector3(), boxTurn = new Quaternion();
  const handMatrix = new Matrix4();
  const matrix = new Matrix4();
  const helmetBone = new Matrix4();
  let disposed = false;
  let morpher: Morpher | null = null;
  let detail = 2;
  let lod = 0;
  group.userData.availableModels = models.length;
  group.userData.models = models;
  group.userData.licenses = CITIZEN_LICENSES;

  /**
   * A roster person (`people/roster.ts`) as a loaded asset would be: the
   * MakeHuman body morphed, dressed and rigged for the captures.
   */
  async function personAsset(model: CitizenModel, fresh = false): Promise<GLTF> {
    const person = model.person!;
    // Cooked ahead (`cookedPerson.ts`, `npm run cook:people`): read back, not built.
    const cooked = fresh ? null : await loadCookedPerson(model.id);
    if (cooked) {
      let mesh: SkinnedMesh | undefined;
      cooked.traverse((o) => { if (o instanceof SkinnedMesh && !mesh) mesh = o; });
      if (mesh) {
        const skin = await loadSkinAppearance(person);
        resources.add(skin.texture);
        if (skin.hairTexture) resources.add(skin.hairTexture);
        for (const map of skin.garments) if (map) resources.add(map);
        mesh.geometry.userData['skinAppearance'] = skin;
        return { scene: cooked, parser: null } as unknown as GLTF;
      }
    }
    const people = await loadPeopleAssets();
    morpher ??= new Morpher(people.packs);

    // The garments it wears, loaded first; failing that it is drawn in the
    // tailored shells rather than not at all.
    const proxies = new Map<string, ProxyItem>();
    try {
      for (const [name, item] of await Promise.all(wornItems(person.look).map(async (n) => [n, await loadProxyItem(n)] as const))) proxies.set(name, item);
    } catch { proxies.clear(); }
    const input = {
      proxies,
      texturedSkin: true,
      data: people.mesh, skeleton: people.skeleton, bodyRange: people.bodyRange,
      positions: morpher.shape(person.body, person.features), look: person.look,
      capture: captureBind(model.gender === 'f' ? 'female' : 'male'), captureAxes: captureBindRotations(model.gender === 'f' ? 'female' : 'male'),
    };
    await personSimplifier;
    // A body is built in one go, just after a frame is drawn.
    await afterFrame();
    const built = performance.now();
    const rig = createPersonRig(input);
    performance.measure('person-rig', { start: built, end: performance.now() });
    // Live faces: blinking, gaze, mood, speech (measured free in the player
    // city: frame median 17 ms with and without). ?expressions=off for comparison.
    if (new URLSearchParams(location.search).get('expressions') !== 'off') {
      const faceAt = performance.now();
      await attachFacialMorphs(input, rig, channelShapes(await expressionShapes(person.body)));
      performance.measure('person-face', { start: faceAt, end: performance.now() });
    }
    {
      const skin = await loadSkinAppearance(person);
      resources.add(skin.texture);
      if (skin.hairTexture) resources.add(skin.hairTexture);
      for (const map of skin.garments) if (map) resources.add(map);
      rig.mesh.geometry.userData['skinAppearance'] = skin;
    }
    return { scene: rig.scene, parser: null } as unknown as GLTF;
  }

  async function load(index: number): Promise<void> {
    const model = CROWD[index];
    const [asset, library] = await Promise.all([
      model?.person ? personAsset(model) : (async () => {
        const url = CITIZEN_ASSET_URLS[model?.sourceId ?? models[index]!];
        if (!url) throw new Error(`Missing citizen asset: ${models[index]}`);
        return new GLTFLoader().loadAsync(url);
      })(),
      loadRocketboxLibrary(),
    ]);
      asset.scene.traverse(o => {
        if (!(o instanceof SkinnedMesh)) return;
        resources.add(o.geometry);
        const materials = Array.isArray(o.material) ? o.material : [o.material];
        for (const material of materials) {
          resources.add(material);
          for (const value of Object.values(material)) if (value instanceof Texture) resources.add(value);
        }
      });
    if (disposed) { for (const resource of resources) resource.dispose(); return; }
      const sex = model ? (model.gender === 'f' ? 'female' : 'male') : models[index]!.includes('female') ? 'female' : 'male';
      const bakeAt = performance.now();
      // The core clips on another core (`bakePool.ts`); here only if no worker can.
      const given = await bakeInWorker(asset.scene, sex);
      const { clips, helmet, deferred } = await bake(asset.scene, sex, library, given ?? undefined);
      performance.measure('person-bake', { start: bakeAt, end: performance.now() });
      if (disposed) { for (const resource of resources) resource.dispose(); return; }
      let reference: SkinnedMesh | undefined;
      asset.scene.updateMatrixWorld(true);
      asset.scene.traverse(o => { if (o instanceof SkinnedMesh && !reference) reference = o; });
      if (!reference) throw new Error('Citizen model has no mesh');
      const width = reference.skeleton.bones.length * 16;
      const rows = 16;
      const pixels = new Float32Array(rows * width);
      group.userData.paletteBytes = (group.userData.paletteBytes ?? 0) + pixels.byteLength;
      const texture = new DataTexture(pixels, width / 4, rows, RGBAFormat, FloatType);
      texture.needsUpdate = true;
      resources.add(texture);
      const uniform = { value: texture };
      const batch: CitizenBatch = { meshes: [], sources: [], local: [], clips, gait: gaitClips(clips), texture, pixels, width, rows,
        uniform, count: 0, lods: [], helmet,
        deferred, baking: Promise.resolve() };
      const parts: SkinnedMesh[] = [];
      asset.scene.traverse(o => { if (o instanceof SkinnedMesh) parts.push(o); });
      for (const o of parts) {
        if (CROWD[index]?.look) markChildShirt(o);
        const variants = [o.geometry];
        // A built person carries its levels ready-made (`personRig.ts`).
        // The coarser levels come from a worker (`personRig.ts`): waited for here, off the frame.
        await (o.geometry.userData['lodReady'] as Promise<void> | undefined);
        const ready: unknown = o.geometry.userData['lodIndices'];
        const readyGroups = o.geometry.userData['lodGroups'] as { start: number; count: number; materialIndex: number }[][] | undefined;
        if (Array.isArray(ready)) for (const [level, indices] of (ready as BufferAttribute[]).entries()) {
          const geometry = new BufferGeometry();
          for (const name of Object.keys(o.geometry.attributes)) geometry.setAttribute(name, o.geometry.getAttribute(name));
          geometry.setIndex(indices);
          // A dressed body's garments are material groups: each level has its own ranges.
          for (const g of readyGroups?.[level] ?? []) geometry.addGroup(g.start, g.count, g.materialIndex);
          geometry.morphAttributes = o.geometry.morphAttributes;
          geometry.morphTargetsRelative = o.geometry.morphTargetsRelative;
          geometry.boundingBox = o.geometry.boundingBox;
          geometry.boundingSphere = o.geometry.boundingSphere;
          variants.push(geometry);
          resources.add(geometry);
        }
        const lodIndices: unknown = o.geometry.userData['roadcraftLods'];
        if (Array.isArray(lodIndices)) for (const accessor of lodIndices) {
          const indices = await asset.parser.getDependency('accessor', accessor) as BufferAttribute;
          const geometry = new BufferGeometry();
          for (const name of Object.keys(o.geometry.attributes)) geometry.setAttribute(name, o.geometry.getAttribute(name));
          geometry.setIndex(indices);
          geometry.boundingBox = o.geometry.boundingBox;
          geometry.boundingSphere = o.geometry.boundingSphere;
          variants.push(geometry);
          resources.add(geometry);
        }
        if (disposed) { for (const resource of resources) resource.dispose(); return; }
        const original = Array.isArray(o.material) ? o.material : [o.material];
        const materials = original.map((source, materialIndex) => {
          const material = (source as MeshStandardMaterial).clone();
          material.color.setHex(0xffffff); // Preserve authored skin; never tint the whole citizen.
          // A roster person's colours are its vertices' (`personRig.ts`).
          material.roughness = 0.88;
          material.metalness = 0;
          skinMaterial(material, uniform, o, materialIndex === 0 ? (CROWD[index]?.look ?? 0) : 0);
          const skin = o.geometry.userData['skinAppearance'] as SkinAppearance | undefined;
          if (skin) applySkinAppearance(material, o.geometry, skin);
          resources.add(material);
          return material;
        });
        const mesh = new InstancedMesh(o.geometry, Array.isArray(o.material) ? materials : materials[0]!, CAPACITY);
        // InstancedMesh does not initialise this array itself. WebGL's morph
        // setup still reads it before it checks the per-instance texture.
        if (o.morphTargetInfluences) mesh.morphTargetInfluences = [...o.morphTargetInfluences];
        mesh.name = `citizen-${models[index]}-${o.name}`;
        mesh.count = 0;
        mesh.frustumCulled = false;
        mesh.instanceMatrix.setUsage(DynamicDrawUsage);
        mesh.castShadow = true;
        // Small animated figures do not receive shadow maps: the depth test
        // against their own moving limbs produced acne stripes that crawled
        // and pulsed over every walking body.
        mesh.receiveShadow = false;
        const depth = new MeshDepthMaterial({ depthPacking: RGBADepthPacking });
        const source = original[0] as MeshStandardMaterial;
        depth.map = source.map;
        depth.alphaTest = source.alphaTest;
        skinMaterial(depth, uniform, o);
        mesh.customDepthMaterial = depth;
        resources.add(mesh); resources.add(depth);
        batch.meshes.push(mesh);
        batch.sources.push(o);
        batch.lods.push(variants);
        batch.local.push(o.matrixWorld.clone());
        group.add(mesh);
      }
      // Its shaders built before it is drawn (`uploads.ts`).
      await Promise.all(batch.meshes.map((mesh) => compileAhead(mesh)));
      if (disposed) return;
      // And its geometry on the GPU, every level of it (`uploads.ts`).
      await Promise.all(batch.meshes.map((mesh, i) => warmAhead(mesh, batch.lods[i]!)));
      if (disposed) return;
      batches.set(index, batch);
      group.userData.animationBytes = (group.userData.animationBytes ?? 0) + [...new Set(clips)].reduce((sum, clip) => sum + clip.data.byteLength, 0);
      group.userData.clipFrames ??= clips.map((clip) => clip?.frames ?? 0);
    group.userData.ready = true;
    group.userData.loadedModels = batches.size;
    onAssetsReady();
  }

  function request(index: number): Promise<void> {
    // A body outside the reviewed whitelist must never be asked for; the
    // browser checks (`verify:visual`) fail on this error.
    if (!CROWD_IDS.includes(models[index] ?? '')) console.error(`Citizen outside the whitelist requested: ${models[index]}`);
    const pending = loading.get(index);
    if (pending) return pending;
    const slot = nextSlot++ % slots.length;
    const work = slots[slot]!.then(() => disposed ? undefined : load(index));
    slots[slot] = work.catch(() => {});
    loading.set(index, work);
    return work;
  }

  /**
   * Every body made ready in the background, one at a time, in the browser's
   * idle time, from shortly after the game opens. Made only when somebody
   * first needed it, each new kind of person cost the frame it appeared in
   * its building and its textures' upload - the stutter while walking the
   * camera through a town.
   */
  const prewarm = async (): Promise<void> => {
    const idle = afterFrame;
    await new Promise((resolve) => setTimeout(resolve, 2500));
    for (let index = 0; index < models.length && !disposed; index++) {
      if (!loading.has(index)) await request(index).catch(() => {});
      await idle();
    }
  };
  if (typeof requestIdleCallback === 'function') void prewarm();

  /**
   * Who is drawn as whom (`citizenCasting.ts`): the ONE casting function, for
   * walkers, parties, drivers, passengers, riders and people at the kerb
   * alike. `models` must be the crowd whitelist (`CROWD_IDS`), in its order.
   */
  if (import.meta.env.DEV) {
    // The cook (`scripts/cook-people.mjs`): every roster person built fresh,
    // packed and sent to the development server, which writes it to `cooked/`.
    (window as unknown as { __cookPeople?: () => Promise<{ hash: string | null; ids: string[]; bytes: number }> }).__cookPeople = async () => {
      const ids: string[] = [];
      let bytes = 0;
      for (const model of CROWD) {
        if (!model.person) continue;
        const asset = await personAsset(model, true);
        const waits: Promise<unknown>[] = [];
        asset.scene.traverse((o) => { if (o instanceof SkinnedMesh) waits.push(o.geometry.userData['lodReady'] as Promise<unknown>); });
        await Promise.all(waits);
        const packed = cookPerson(asset.scene);
        const response = await fetch(`/__cook/people/${model.id}.bin`, { method: 'PUT', body: packed });
        if (!response.ok) throw new Error(`Cook of ${model.id}: ${response.status}`);
        ids.push(model.id);
        bytes += packed.byteLength;
      }
      return { hash: peopleCookHash(), ids, bytes };
    };
  }

  const registry = new CastingRegistry(CROWD.filter((m) => models.includes(m.id))
    .sort((p, q) => models.indexOf(p.id) - models.indexOf(q.id)), CAST_FORGET);
  const helmetFits = (id: string): boolean => !NO_HELMET.has(id);
  function bodyFor(ctx: CastingContext): { index: number; size: number } | null {
    return registry.pickCitizenModel(ctx, helmetFits);
  }
  const mixClips: ClipFrames[] = [];
  const mixPhases: number[] = [];
  const mixWeights: number[] = [];

  /** A deferred clip asked for: baked in turn, the stand-in drawn meanwhile. */
  function want(batch: CitizenBatch, at: number): void {
    const job = batch.deferred.get(at);
    if (!job) return;
    batch.deferred.delete(at);
    batch.baking = batch.baking.then(async () => {
      const clip = await job.make();
      if (disposed) return;
      batch.clips[at] = clip;
      batch.gait = gaitClips(batch.clips);
      group.userData.animationBytes = (group.userData.animationBytes ?? 0) + clip.data.byteLength;
    }).catch(() => {});
  }

  /** Writes one citizen: blended bone palette plus instance transform. */
  function emit(batch: CitizenBatch, clips: readonly ClipFrames[], phases: readonly number[],
    weights: readonly number[], x: number, height: number, y: number, heading: number, scale: number,
    lean = 0, ground: Gradient | null = null, expression?: FaceWeights): void {
    const offset = batch.count * batch.width;
    // Far off (`lod` 2, a body a few pixels tall), the pose is the frame of
    // the clip that weighs most, copied as it is: blending clips and frames
    // bone by bone for every body was a quarter of a frame in a town, for a
    // difference no pixel shows.
    if (lod >= 2) {
      let best = -1;
      for (let c = 0; c < clips.length; c++) if (best < 0 || weights[c]! > weights[best]!) best = c;
      if (best >= 0) {
        const clip = clips[best]!;
        const start = Math.round(Math.min(clip.frames, Math.max(0, phases[best]!))) * batch.width;
        batch.pixels.set(clip.data.subarray(start, start + batch.width), offset);
      } else batch.pixels.fill(0, offset, offset + batch.width);
    } else {
      const pixels = batch.pixels;
      const width = batch.width;
      pixels.fill(0, offset, offset + width);
      let total = 0;
      for (let c = 0; c < clips.length; c++) total += Math.max(0, weights[c]!);
      for (let c = 0; c < clips.length; c++) {
        const weight = Math.max(0, weights[c]!) / (total || 1);
        if (weight < 0.001) continue;
        const clip = clips[c]!;
        const data = clip.data;
        const f = Math.min(clip.frames, Math.max(0, phases[c]!));
        const fraction = f % 1;
        const start = Math.floor(f) * width;
        const a = weight * (1 - fraction);
        const b = weight * fraction;
        for (let k = 0; k < width; k++) {
          pixels[offset + k] = pixels[offset + k]! + a * data[start + k]! + b * data[start + width + k]!;
        }
      }
    }
    transform.position.set(x, height, -y);
    // Yaw, then a roll about the body's own forward axis (+Z on the model; a
    // lean to the left tips +Y towards the model's +X, its left).
    transform.rotation.set(0, heading + Math.PI / 2, -lean, 'YXZ');
    transform.scale.set(scale, scale, scale);
    transform.updateMatrix();
    if (ground) shearMatrix(transform.matrix, ground, x, -y);
    for (let i = 0; i < batch.meshes.length; i++) {
      matrix.multiplyMatrices(transform.matrix, batch.local[i]!);
      batch.meshes[i]!.setMatrixAt(batch.count, matrix);
    }
    // Faces are read only close up: from the nearest level of detail on, no
    // expression is computed or uploaded.
    if (expression && lod === 0) setFacialExpression(batch, batch.count, expression);
    batch.count++;
  }

  function grow(batch: CitizenBatch): void {
    const rows = Math.min(CAPACITY, batch.rows * 2);
    const pixels = new Float32Array(rows * batch.width);
    pixels.set(batch.pixels);
    group.userData.paletteBytes += pixels.byteLength - batch.pixels.byteLength;
    const texture = new DataTexture(pixels, batch.width / 4, rows, RGBAFormat, FloatType);
    texture.needsUpdate = true;
    resources.delete(batch.texture);
    batch.texture.dispose();
    batch.rows = rows; batch.pixels = pixels; batch.texture = texture;
    batch.uniform.value = texture;
    resources.add(texture);
  }

  return {
    group,
    begin(level = 2, zoom = Infinity) {
      held.begin();
      detail = level;
      registry.beginFrame();
      // 3: a body a few pixels tall (the overview), drawn by its coarsest level.
      lod = zoom >= 8 ? 0 : zoom >= 2 ? 1 : zoom >= 1.2 ? 2 : 3;
      group.userData.lod = lod;
      for (const batch of batches.values()) {
        batch.count = 0;
        for (let i = 0; i < batch.meshes.length; i++) {
          const variants = batch.lods[i]!;
          batch.meshes[i]!.geometry = variants[Math.min(lod, variants.length - 1)]!;
          const material = batch.meshes[i]!.material;
          for (const m of Array.isArray(material) ? material : [material]) {
            const detail = m.userData['appearanceDetail'] as { value: number } | undefined;
            if (detail) detail.value = lod <= 1 ? 1 : 0;
          }
        }
      }
    },
    /**
     * Draws one pedestrian, the body playing what `citizenGait.ts` decides
     * from how the simulation moves it: walks blended by pace and advanced by
     * the ground the drawn body covers, the walk start and stop, turns stepped
     * round by the angle turned, and the stands, talk, phone and bench.
     */
    /** `ground`: the footway's gradient under the walker, so both feet stand on it (`groundShear.ts`). */
    draw(ped: PedView, x: number, y: number, heading: number, deck: number, alpha: number, ground: Gradient | null = null, lean = 0) {
      // A fall: over onto the ground in under a second, a few seconds there,
      // and back up (the body tipped about its feet, as a bed lays it down).
      if (ped.gesture?.kind === 'fall') lean = fallLean(ped.gesture.t, ped.gesture.hold ?? 6);
      const hash = personHash(ped.id);
      const body = bodyFor({ seed: ped.id, gender: ped.gender, ageClass: ped.ageClass, company: companyOf(ped.party),
        companyId: ped.party.id, hasChild: ped.party.hasChild, x, y });
      if (!body) return;
      const index = body.index;
      const batch = batches.get(index);
      if (!batch) {
        if (!loading.has(index)) void request(index).catch((error: unknown) => {
          group.userData.error = String(error);
          console.error('Citizen asset could not be loaded', models[index], error);
        });
        return;
      }
      if (batch.count >= CAPACITY) return;
      if (batch.count >= batch.rows) grow(batch);
      const time = Math.max(0, ped.age - (1 - alpha) * DT);
      const scale = body.size * (0.92 + ((hash >>> 8) & 255) / 255 * 0.17);
      let gait = motion.get(ped);
      if (!gait) {
        gait = createGait(ped, time, heading, hash);
        motion.set(ped, gait);
      }
      stepGait(gait, ped, batch.gait, time, heading, m(scale) / m(1), hash);
      plays.length = 0;
      gaitPlays(gait, batch.gait, plays);
      mixClips.length = 0; mixPhases.length = 0; mixWeights.length = 0;
      const carrying = ped.carry !== undefined;
      for (const play of plays) {
        const at = (carrying ? CARRY_AT[play.name] : undefined) ?? GAIT_AT[play.name];
        if (batch.deferred.size) want(batch, at);
        mixClips.push(batch.clips[at]!);
        mixPhases.push(play.frame);
        mixWeights.push(play.weight);
      }
      emit(batch, mixClips, mixPhases, mixWeights, x, deck, y, gaitHeading(gait), m(scale), lean, ground,
        lod === 0 ? faceAt(ped.id, time, ped.gesture?.kind, CROWD[index]?.person?.mood) : undefined);
      // In the hand, what the gesture is done with, where the hand is in the
      // clip carrying the most weight this frame.
      if (carrying && lod < 2) {
        // The box between the two hands, as wide as they are apart.
        let best = -1;
        for (let i = 0; i < mixWeights.length; i++) if (best < 0 || mixWeights[i]! > mixWeights[best]!) best = i;
        const clip = best >= 0 ? mixClips[best] : undefined;
        if (clip?.hands && mixWeights[best]! > 0) {
          const frame = Math.min(clip.frames, Math.max(0, Math.round(mixPhases[best]!)));
          boxR.fromArray(clip.hands, frame * 32 + 12);
          boxL.fromArray(clip.hands, frame * 32 + 28);
          const width = Math.min(0.5, Math.max(0.24, boxR.distanceTo(boxL) - 0.07));
          boxAt.addVectors(boxR, boxL).multiplyScalar(0.5);
          boxAt.z += 0.03; boxAt.y += 0.02;
          handMatrix.compose(boxAt, boxTurn, boxSize.set(width, 0.3, 0.38));
          handMatrix.premultiply(transform.matrix);
          held.placeMatrix('box', handMatrix);
        }
      }
      const thing = ped.gesture && !carrying ? HELD[ped.gesture.kind] : undefined;
      if (thing && lod < 2) {
        let best = -1;
        for (let i = 0; i < mixWeights.length; i++) if (best < 0 || mixWeights[i]! > mixWeights[best]!) best = i;
        const clip = best >= 0 ? mixClips[best] : undefined;
        if (clip?.hands && mixWeights[best]! > 0.5) {
          const frame = Math.min(clip.frames, Math.max(0, Math.round(mixPhases[best]!)));
          handMatrix.fromArray(clip.hands, frame * 32 + (thing.left ? 16 : 0));
          handMatrix.premultiply(transform.matrix);
          held.place(thing.kind, handMatrix, m(scale));
        }
      }
    },
    /**
     * Somebody in or on a vehicle, or stepping between a vehicle and the
     * footway: any baked clips, blended, with the PELVIS placed at a point.
     *
     * `identity` picks the body exactly as `draw` does for a pedestrian of that
     * id, sex and age, so a passenger who gets out and walks off keeps their
     * body and their size. `lean` tilts the whole figure about the line where
     * the vehicle meets the road, as a rider leans into a bend; the pelvis is
     * given already leaned. `maxScale` shrinks a tall person to fit a cabin.
     * With `fromGround` the point is where the feet are, not the pelvis;
     * `'pelvisOver'` puts the feet on its height but the first frame's pelvis
     * over it in plan, for somebody rising from a seat onto their feet.
     *
     * `fixedScale` (metres per metre, 0 for none) draws the body at exactly
     * that size: somebody whose hands and feet are posed onto a machine's
     * grips and pegs must be drawn at the size the pose was solved at, or
     * every contact drifts with their height. `helmet`, when given, receives
     * the matrix that puts a sphere of unit diameter round this body's head
     * as drawn (`riderPoses.helmetShape`); the return value is then negative
     * if the body has none, and the helmet must not be drawn.
     */
    drawClip(identity: ClipIdentity,
      pelvisX: number, pelvisY: number, pelvisHeight: number, heading: number,
      plays: readonly { readonly key: CitizenClipKey; readonly phase: number; readonly weight: number;
        /** For a walk: ground covered, world units; the phase then follows this body's own stride. */
        readonly distance?: number }[],
      lean = 0, maxScale = Infinity, fromGround: boolean | 'pelvisOver' = false, fixedScale = 0,
      helmet: Matrix4 | null = null): number {
      const hash = personHash(identity.seed);
      const body = bodyFor({ ...identity, helmet: helmet !== null, x: pelvisX, y: pelvisY });
      if (!body) return 0;
      const batch = batches.get(body.index);
      if (!batch) {
        if (!loading.has(body.index)) void request(body.index).catch(() => {});
        return 0;
      }
      if (batch.count >= CAPACITY) return 0;
      if (batch.count >= batch.rows) grow(batch);
      mixClips.length = 0;
      mixPhases.length = 0;
      mixWeights.length = 0;
      let pelvis = 0;
      let pelvisLeft = 0;
      let pelvisAhead = 0;
      let total = 0;
      const scale = m(fixedScale > 0 ? fixedScale : Math.min(maxScale, body.size * (0.92 + ((hash >>> 8) & 255) / 255 * 0.17)));
      let headWeight = 0;
      let headClip: ClipFrames | undefined;
      for (const play of plays) {
        const at = play.key === 'walk' ? (identity.ageClass === 'elder' ? WALK_ELDER : WALK)
          : play.key in RIDER_AT ? RIDER_AT[play.key as RiderClipKey] : LIBRARY_AT[play.key as Played];
        if (batch.deferred.size) want(batch, at);
        const clip = batch.clips[at];
        if (!clip || play.weight <= 0) continue;
        // A walk played by distance plants the feet: one cycle per stride of
        // THIS body (the capture's own stride times its drawn size).
        const phase = play.distance !== undefined ? play.distance / Math.max(1e-6, clip.stride * scale) : play.phase;
        const f = clip.loop ? ((phase % 1) + 1) % 1 : Math.min(1, Math.max(0, phase));
        mixClips.push(clip);
        mixPhases.push(f * clip.frames);
        mixWeights.push(play.weight);
        pelvis += clip.pelvisY * play.weight;
        pelvisLeft += clip.pelvisX * play.weight;
        pelvisAhead += clip.pelvisZ * play.weight;
        total += play.weight;
        if (play.weight > headWeight) {
          headWeight = play.weight;
          headClip = clip;
        }
      }
      if (!mixClips.length) return 0;
      pelvis /= total;
      // The model's origin, found back from the pelvis along the leaned up
      // axis - or, `fromGround`, the feet on the given point, as for somebody
      // standing up out of a seat onto the road. A captured sitting clip
      // carries its pelvis back from the origin, onto the chair; that offset
      // is taken out too, so the pelvis lands on the seat's hip point.
      const drop = fromGround ? 0 : pelvis * scale;
      const leftX = -Math.sin(heading);
      const leftY = Math.cos(heading);
      const aheadX = Math.cos(heading);
      const aheadY = Math.sin(heading);
      const shiftLeft = fromGround === true ? 0 : (pelvisLeft / total) * scale;
      const shiftAhead = fromGround === true ? 0 : (pelvisAhead / total) * scale;
      emit(batch, mixClips, mixPhases, mixWeights,
        pelvisX - leftX * drop * Math.sin(lean) - leftX * shiftLeft - aheadX * shiftAhead, pelvisHeight - drop * Math.cos(lean),
        pelvisY - leftY * drop * Math.sin(lean) - leftY * shiftLeft - aheadY * shiftAhead, heading, scale, lean, null,
        // In a seat a face lives too: blinking, glancing, a passenger
        // chatting now and then (wall time: the render's own clock).
        lod === 0 ? faceAt(identity.seed, performance.now() / 1000 + identity.seed * 0.13,
          seatedChat(identity.seed, performance.now() / 1000) ? 'talk' : undefined, CROWD[body.index]?.person?.mood) : undefined);
      if (helmet) {
        // This body's helmet on the head of the pose carrying the most
        // weight, through the transform `emit` just drew the body with: at
        // this body's size, leaned and turned with it.
        if (!headClip?.head || !batch.helmet) return -scale;
        helmet.multiplyMatrices(transform.matrix, helmetBone.multiplyMatrices(headClip.head, batch.helmet));
      }
      return scale;
    },
    /**
     * Every figure drawn last frame, as the casting chose them: model,
     * wardrobe, company and its dress code (the runtime census). Recording
     * starts on the first call.
     */
    census() {
      registry.recordCensus = true;
      return registry.census();
    },
    finish() {
      for (const batch of batches.values()) {
        if (batch.count > 0) {
          batch.texture.clearUpdateRanges();
          // three.js uploads each DataTexture update range as one image row.
          // A range spanning multiple citizens exceeds the texture width and
          // leaves their bone palettes frozen on the GPU.
          // Half the rows or more in use (the texture grows by doubling), the
          // whole texture goes up in ONE call: a call per body was hundreds of
          // uploads a frame in a town, for at most twice the bytes.
          if (batch.count * 2 < batch.rows) {
            for (let i = 0; i < batch.count; i++) {
              batch.texture.addUpdateRange(i * batch.width, batch.width);
            }
          }
          batch.texture.needsUpdate = true;
        }
        for (const mesh of batch.meshes) {
          mesh.count = batch.count;
          // An empty batch is still a program bind and its uniforms in every
          // pass: with the whole roster loaded, most bodies are empty most frames.
          mesh.visible = batch.count > 0;
          mesh.castShadow = detail > 0 && lod < 2;
          mesh.instanceMatrix.clearUpdateRanges();
          if (batch.count > 0) mesh.instanceMatrix.addUpdateRange(0, batch.count * 16);
          mesh.instanceMatrix.needsUpdate = true;
          if (mesh.morphTexture && lod === 0) mesh.morphTexture.needsUpdate = true;
        }
      }
    },
    dispose() {
      disposed = true;
      for (const resource of resources) resource.dispose();
      resources.clear(); batches.clear(); loading.clear(); group.clear();
    },
  };
}
