import {
  BufferGeometry, DataTexture, DynamicDrawUsage, FloatType, Group, InstancedMesh,
  Matrix4, MeshDepthMaterial, MeshStandardMaterial, Object3D, Quaternion, RGBAFormat,
  RGBADepthPacking, SkinnedMesh, Texture, Vector3, type BufferAttribute,
} from 'three';
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { clone } from 'three/addons/utils/SkeletonUtils.js';
import { pedHash } from '@sim/peds/behaviour';
import type { Ped, PedParty } from '@sim/peds/state';
import { DT } from '@sim/params';
import { m } from '@world/units';
import { CITIZEN_MODELS, type DressStyle, wardrobeOf } from './citizenCatalog';
import { NO_HELMET, RIDER_CLIPS, helmetShape, type RiderClip, type RiderClipKey } from './riderPoses';
import { CITIZEN_ASSET_URLS, CITIZEN_LICENSES } from './citizenAssets';
import {
  WALK_ADVANCE, clipTransferFor, loadRocketboxLibrary, neutralWalkFor, strideShare, walkDuration, walkSource,
  type LibraryClip, type LibraryClipName, type RocketboxLibrary, type WalkAmplitude, type WalkSex,
} from './citizenWalk';
import {
  ELDER_AMPLITUDE, SHUFFLE_AMPLITUDE, bakeFps, createGait, gaitClipOf, gaitHeading, gaitPlays, stepGait,
  type Gait, type GaitClipName, type GaitClips, type GaitPlay,
} from './citizenGait';

export { CITIZEN_MODELS } from './citizenCatalog';
/*
 * The citizen GLBs carry no clips. The Quaternius capture once converted onto
 * this skeleton is what hunched every walker, and nothing played it, so it was
 * stripped (`scripts/strip-citizen-animations.mjs`). A pedestrian plays
 * Rocketbox captures (`WALK`, `LIBRARY`), and a person in or on a vehicle an IK
 * pose (`RIDER_CLIPS`).
 */
/** The Rocketbox neutral walk of the body's sex, exactly as captured. */
const WALK = 0;
/** The same walk with an older person's shorter step and quieter arms. */
const WALK_ELDER = 1;
/** The Rocketbox slow walk with its swing shrunk: short steps, for inching along. */
const WALK_SHUFFLE = 2;
/** The Rocketbox library clips, baked after the walks in this order. */
const LIBRARY = [
  'start', 'stop', 'run', 'turnLeft', 'turnRight',
  'idle', 'look', 'phone', 'talk', 'listen', 'sitDown', 'sitIdle', 'standUp', 'walkSlow',
] as const satisfies readonly LibraryClipName[];
type Played = (typeof LIBRARY)[number];
const LIBRARY_AT = Object.fromEntries(LIBRARY.map((name, i) => [name, WALK_SHUFFLE + 1 + i])) as
  Readonly<Record<Played, number>>;
/** Where each clip the gait plays (`citizenGait.ts`) is baked. */
const GAIT_AT: Readonly<Record<GaitClipName, number>> = {
  ...LIBRARY_AT, walk: WALK, walkElder: WALK_ELDER, walkShuffle: WALK_SHUFFLE,
};
/**
 * People in and on vehicles (`riderPoses.ts`): car seats reclined to fit a
 * cabin, astride a motorcycle, pedalling a bicycle. Baked after the library.
 */
const RIDER_AT = Object.fromEntries(RIDER_CLIPS.map((clip, i) => [clip.key, WALK_SHUFFLE + 1 + LIBRARY.length + i])) as
  Readonly<Record<RiderClipKey, number>>;
/** Anything `drawClip` can play. */
export type CitizenClipKey = RiderClipKey | 'walk' | Played;

const CAPACITY = 1000;
const FPS = 30;
interface ClipFrames {
  data: Float32Array;
  /** Intervals between baked frames; `data` holds `frames + 2` rows (the last repeated). */
  frames: number; duration: number;
  /** Ground one cycle covers on this body at scale 1, metres. */
  stride: number;
  /** Height of the pelvis above the model origin in the first frame, metres. */
  pelvisY: number;
  /** The pelvis's offset from the origin in plan in the first frame (model +X left, +Z forward), metres. */
  pelvisX: number;
  pelvisZ: number;
  loop: boolean;
  /** Ground covered by each baked frame on this body at scale 1, metres (start, stop). */
  travel?: Float32Array;
  /** Angle turned by each baked frame, radians, unsigned (turns). */
  yaw?: Float32Array;
  /** A rider's head bone in the first frame, in the model's frame: where a helmet goes. */
  head?: Matrix4;
}
interface CitizenBatch {
  meshes: InstancedMesh[]; local: Matrix4[]; clips: ClipFrames[];
  /** The same baked clips, by the name the gait plays them by. */
  gait: GaitClips;
  texture: DataTexture; pixels: Float32Array; width: number; count: number;
  rows: number; uniform: { value: DataTexture };
  lods: BufferGeometry[][];
  /** This body's helmet in its head bone's frame (`riderPoses.helmetShape`), or null. */
  helmet: Matrix4 | null;
}

/**
 * Size of a child drawn on an adult body, when the roster has no child model
 * of their sex: without it a child walked the street at full adult height.
 */
/** No two people within this distance of each other wear the same body, if the roster allows. */
const CAST_NEAR = m(25);

/**
 * How a party is dressed: colleagues in office clothes, one lone walker in
 * four too (people on their way to or from work), everybody else casual.
 */
export function dressFor(party: Pick<PedParty, 'id' | 'archetype'>): DressStyle {
  if (party.archetype === 'colleagues') return 'business';
  if (party.archetype === 'solo') return (pedHash(party.id ^ 0x5eed) & 3) === 0 ? 'business' : 'casual';
  return 'casual';
}
/** Frames undrawn after which a person's body is forgotten: about a minute. */
const CAST_FORGET = 3600;
const CHILD_ON_ADULT = 0.64;

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

function skinMaterial(material: MeshStandardMaterial | MeshDepthMaterial, uniform: { value: DataTexture }, mesh: SkinnedMesh): void {
  material.defines = { ...material.defines, USE_SKINNING: '' };
  material.onBeforeCompile = shader => {
    shader.uniforms.citizenBones = uniform;
    shader.uniforms.bindMatrix = { value: mesh.bindMatrix };
    shader.uniforms.bindMatrixInverse = { value: mesh.bindMatrixInverse };
    shader.vertexShader = shader.vertexShader.replace('#include <skinning_pars_vertex>', SKINNING);
  };
  material.customProgramCacheKey = () => 'citizen-skinning-v1';
}

/** Longest stretch of baking between two frames, milliseconds. */
const SLICE_MS = 4;
let sliceStart = 0;

/**
 * Lets the frame loop in once this stretch of baking has run for `SLICE_MS`.
 * A body bakes some twenty-five clips, and baked in one go each body a
 * pedestrian first needed was a frame of 100 to 350 ms: the hitch every few
 * seconds while the crowd's bodies loaded.
 */
async function breathe(): Promise<void> {
  if (performance.now() - sliceStart < SLICE_MS) return;
  await new Promise<void>(resolve => setTimeout(resolve, 0));
  sliceStart = performance.now();
}

/** One copy of a body to bake on, and the way back to its rest pose. */
interface BakeRig {
  readonly rig: Object3D;
  readonly mesh: SkinnedMesh;
  /** Puts every node back where the asset has it, as a fresh copy would be. */
  reset(): void;
}

function restRig(asset: GLTF): BakeRig {
  const rig = clone(asset.scene);
  let mesh: SkinnedMesh | undefined;
  rig.traverse(o => { if (o instanceof SkinnedMesh && !mesh) mesh = o; });
  if (!mesh) throw new Error('Citizen model has no rig');
  const rest: { o: Object3D; p: Vector3; q: Quaternion; s: Vector3 }[] = [];
  rig.traverse(o => rest.push({ o, p: o.position.clone(), q: o.quaternion.clone(), s: o.scale.clone() }));
  return {
    rig, mesh,
    reset() {
      for (const { o, p, q, s } of rest) {
        o.position.copy(p);
        o.quaternion.copy(q);
        o.scale.copy(s);
      }
      rig.updateMatrixWorld(true);
    },
  };
}

/**
 * Bakes a pose function into bone palettes: `frames` intervals over
 * `duration`, one row more for the end, one more repeated so interpolation
 * past the last frame reads a real pose.
 */
async function bakeFrames(body: BakeRig, pose: (time: number) => void, duration: number,
  loop: boolean, fps = FPS): Promise<{ data: Float32Array; frames: number; pelvisY: number; pelvisX: number; pelvisZ: number }> {
  const { rig, mesh } = body;
  const skeleton = mesh.skeleton;
  const frames = Math.max(1, Math.round(duration * fps));
  const width = skeleton.bones.length * 16;
  const data = new Float32Array((frames + 2) * width);
  const pelvis = rig.getObjectByName('Bip01_Pelvis');
  const position = new Vector3();
  let pelvisY = 0;
  let pelvisX = 0;
  let pelvisZ = 0;
  for (let i = 0; i <= frames; i++) {
    await breathe();
    pose(loop ? (i % frames) * duration / frames : i * duration / frames);
    skeleton.update();
    data.set(skeleton.boneMatrices!, i * width);
    if (i === 0 && pelvis) {
      pelvis.getWorldPosition(position);
      pelvisY = position.y;
      pelvisX = position.x;
      pelvisZ = position.z;
    }
  }
  data.copyWithin((frames + 1) * width, frames * width, (frames + 1) * width);
  return { data, frames, pelvisY, pelvisX, pelvisZ };
}

/**
 * Bakes the Rocketbox walk onto one body: `amplitude` untouched is the capture
 * as recorded, anything less the elder's. `stride` is the ground one cycle
 * covers on THIS body, so moving it by that much per cycle plants the feet.
 */
async function bakeWalk(body: BakeRig, sex: WalkSex, amplitude?: WalkAmplitude): Promise<ClipFrames> {
  body.reset();
  const walk = neutralWalkFor(body.rig, body.mesh, sex, amplitude);
  const duration = walkDuration(sex);
  const baked = await bakeFrames(body, time => walk.pose(time), duration, true);
  const share = amplitude ? strideShare(walkSource(sex), amplitude) : 1;
  return { ...baked, duration, loop: true, stride: WALK_ADVANCE[sex] * walk.scale * share };
}

/**
 * Bakes one library clip onto one body, with its travel and turn curves
 * resampled to the baked frames (`gaitClipOf`). A cycle baked with its swing
 * shrunk to `amplitude` covers that much less ground.
 */
async function bakeLibraryClip(body: BakeRig, clip: LibraryClip, amplitude?: WalkAmplitude): Promise<ClipFrames> {
  body.reset();
  const transfer = clipTransferFor(body.rig, body.mesh, clip, amplitude);
  // A long standing or seated loop is slow motion, captured at 10 fps in the
  // library; baking it at 30 tripled the memory and the load for nothing.
  const baked = await bakeFrames(body, time => transfer.pose(time), clip.duration, clip.loop, bakeFps(clip));
  const facts = gaitClipOf(clip, transfer.scale, baked.frames);
  const share = amplitude ? strideShare(clip.source, amplitude) : 1;
  return { ...baked, ...facts, stride: facts.stride * share };
}

/**
 * Bakes everything one body plays, on one copy of it put back to rest between
 * clips, a few milliseconds at a time. No skeleton traversal occurs during
 * drawing.
 */
async function bake(asset: GLTF, sex: WalkSex, library: RocketboxLibrary): Promise<{ clips: ClipFrames[]; helmet: Matrix4 | null }> {
  const body = restRig(asset);
  // A helmet is fitted to this head, at rest, once.
  const helmet = helmetShape(body.rig);
  const clips: ClipFrames[] = [];
  // The elder's step, and the shuffle's, cover less ground in the same time,
  // in proportion to how far the feet then reach fore and aft (`strideShare`).
  clips[WALK] = await bakeWalk(body, sex);
  clips[WALK_ELDER] = await bakeWalk(body, sex, ELDER_AMPLITUDE);
  clips[WALK_SHUFFLE] = await bakeLibraryClip(body, library[sex].walkSlow, SHUFFLE_AMPLITUDE);
  for (const name of LIBRARY) clips[LIBRARY_AT[name]] = await bakeLibraryClip(body, library[sex][name]);
  for (const clip of RIDER_CLIPS) clips[RIDER_AT[clip.key]] = await bakeRiderClip(body, clip);
  return { clips, helmet };
}

/**
 * Bakes one IK pose of a person in or on a vehicle. The rig is put back to its
 * rest pose before every frame, because the IK aims bones from wherever they
 * are. A still pose needs two frames, not thirty.
 */
async function bakeRiderClip(body: BakeRig, clip: RiderClip): Promise<ClipFrames> {
  const pose = (time: number): void => {
    body.reset();
    clip.pose(body.rig, time);
  };
  const still = clip.key !== 'bikePedal';
  const baked = await bakeFrames(body, pose, clip.duration, clip.loop, still ? 2 : FPS);
  pose(0);
  const head = body.rig.getObjectByName('Bip01_Head')?.matrixWorld.clone();
  return { ...baked, duration: clip.duration, loop: clip.loop, stride: 1, ...(head ? { head } : {}) };
}

/** The baked clips of one body, by the name the gait plays them by. */
function gaitClips(clips: readonly ClipFrames[]): GaitClips {
  return Object.fromEntries(Object.entries(GAIT_AT).map(([name, at]) => [name, clips[at]!])) as unknown as GaitClips;
}

export function createRiggedCitizens(models: readonly string[] = CITIZEN_MODELS,
  onAssetsReady: () => void = () => {}) {
  const group = new Group();
  group.name = 'rigged-citizens';
  const batches = new Map<number, CitizenBatch>();
  const loading = new Map<number, Promise<void>>();
  const slots: Promise<void>[] = [Promise.resolve(), Promise.resolve(), Promise.resolve()];
  let nextSlot = 0;
  const resources = new Set<{ dispose(): void }>();
  const motion = new WeakMap<Ped, Gait>();
  const plays: GaitPlay[] = [];
  const transform = new Object3D();
  const matrix = new Matrix4();
  const helmetBone = new Matrix4();
  let disposed = false;
  let detail = 2;
  let lod = 0;
  group.userData.availableModels = models.length;
  group.userData.models = models;
  group.userData.licenses = CITIZEN_LICENSES;

  async function load(index: number): Promise<void> {
    const loader = new GLTFLoader();
    const url = CITIZEN_ASSET_URLS[models[index]!];
    if (!url) throw new Error(`Missing citizen asset: ${models[index]}`);
    const [asset, library] = await Promise.all([loader.loadAsync(url), loadRocketboxLibrary()]);
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
      const { clips, helmet } = await bake(asset, models[index]!.includes('female') ? 'female' : 'male', library);
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
      const batch: CitizenBatch = { meshes: [], local: [], clips, gait: gaitClips(clips), texture, pixels, width, rows,
        uniform, count: 0, lods: [], helmet };
      const parts: SkinnedMesh[] = [];
      asset.scene.traverse(o => { if (o instanceof SkinnedMesh) parts.push(o); });
      for (const o of parts) {
        const variants = [o.geometry];
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
        const materials = original.map(source => {
          const material = (source as MeshStandardMaterial).clone();
          material.color.setHex(0xffffff); // Preserve authored skin; never tint the whole citizen.
          material.roughness = 0.88;
          material.metalness = 0;
          skinMaterial(material, uniform, o);
          resources.add(material);
          return material;
        });
        const mesh = new InstancedMesh(o.geometry, Array.isArray(o.material) ? materials : materials[0]!, CAPACITY);
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
        batch.lods.push(variants);
        batch.local.push(o.matrixWorld.clone());
        group.add(mesh);
      }
      batches.set(index, batch);
      group.userData.animationBytes = (group.userData.animationBytes ?? 0) + clips.reduce((sum, clip) => sum + clip.data.byteLength, 0);
    group.userData.ready = true;
    group.userData.loadedModels = batches.size;
    onAssetsReady();
  }

  function request(index: number): Promise<void> {
    const pending = loading.get(index);
    if (pending) return pending;
    const slot = nextSlot++ % slots.length;
    const work = slots[slot]!.then(() => disposed ? undefined : load(index));
    slots[slot] = work.catch(() => {});
    loading.set(index, work);
    return work;
  }

  const everyone: number[] = [];
  /** Bodies a pedestrian may be drawn as, by sex and by whether it is a child's. */
  const pools = {
    f: { adult: [] as number[], business: [] as number[], child: [] as number[] },
    m: { adult: [] as number[], business: [] as number[], child: [] as number[] },
  };
  models.forEach((id, index) => {
    // Uniforms are not street clothes (`citizenCatalog.wardrobeOf`).
    const wardrobe = wardrobeOf(id);
    if (wardrobe === 'uniform') return;
    everyone.push(index);
    const child = id.includes('_child');
    const sex = pools[id.includes('female') ? 'f' : 'm'];
    if (child) sex.child.push(index);
    else if (wardrobe === 'business') sex.business.push(index);
    else sex.adult.push(index);
  });
  /** Adult bodies a helmet fits on (`riderPoses.NO_HELMET`): motorcyclists are drawn from these. */
  const helmeted = {
    f: pools.f.adult.filter((i) => !NO_HELMET.has(models[i]!)),
    m: pools.m.adult.filter((i) => !NO_HELMET.has(models[i]!)),
  };

  /**
   * The body one pedestrian is drawn as, and at what size.
   *
   * A woman is drawn as a woman and a child as a child: the model used to be
   * picked from the id alone, so half the women were men and children walked
   * at full adult height. A child with no child body of their sex in the
   * roster is drawn on an adult one, scaled down to a child's height; an
   * older person walks on an adult body with the elder's walk.
   */
  function poolFor(ped: Pick<Ped, 'gender' | 'ageClass'>, helmet: boolean, style: DressStyle = 'casual'):
    { pool: readonly number[]; size: number; spare?: readonly number[]; spareSize?: number } | null {
    const sex = pools[ped.gender === 'f' ? 'f' : 'm'];
    const other = pools[ped.gender === 'f' ? 'm' : 'f'];
    const fits = helmeted[ped.gender === 'f' ? 'f' : 'm'];
    if (helmet && ped.ageClass !== 'child' && fits.length) return { pool: fits, size: 1 };
    if (ped.ageClass === 'child') {
      // There are one girl's body and two boys' in the roster: a second child
      // nearby, who would be the first one's twin, is drawn on an adult body
      // at a child's height instead.
      if (sex.child.length) return { pool: sex.child, size: 1, spare: sex.adult, spareSize: CHILD_ON_ADULT };
      if (sex.adult.length) return { pool: sex.adult, size: CHILD_ON_ADULT };
      if (other.child.length) return { pool: other.child, size: 1 };
    } else {
      // Everybody in a group dressed alike: colleagues in office clothes, the
      // rest - families, couples, friends - in everyday ones.
      if (style === 'business' && ped.ageClass === 'adult' && sex.business.length) return { pool: sex.business, size: 1 };
      if (sex.adult.length) return { pool: sex.adult, size: 1 };
      if (other.adult.length) return { pool: other.adult, size: 1 };
    }
    return everyone.length ? { pool: everyone, size: 1 } : null;
  }

  /**
   * The casting registry: which body each person is drawn as, chosen once,
   * the first time they are drawn, and kept for as long as they are about.
   *
   * It used to be `pool[hash % pool.length]` - every person drawn
   * independently of everybody round them - and with forty-odd bodies to a
   * sex that put the same person twice among ten people near each other two
   * times in three, and now and then twins side by side in one car. Now a
   * body is dealt from a deck starting where the hash points, skipping any
   * body worn by somebody within `CAST_NEAR` or by somebody of the same party
   * or vehicle; if every one is taken, the one worn farthest away. A person is
   * the same identity seated, getting out and walking off (the vehicle seat's
   * seed is the pedestrian's id), so they keep their body throughout.
   */
  interface Cast { index: number; size: number; x: number; y: number; seen: number; group: number }
  const cast = new Map<number, Cast>();
  const wearers = new Map<number, Set<number>>();
  let castFrame = 0;
  function bodyFor(ped: Pick<Ped, 'gender' | 'ageClass'>, hash: number, helmet: boolean,
    seed: number, x: number, y: number, company: number, style: DressStyle = 'casual'): { index: number; size: number } | null {
    const known = cast.get(seed);
    if (known) {
      known.x = x; known.y = y; known.seen = castFrame;
      return known;
    }
    const choice = poolFor(ped, helmet, style);
    if (!choice) return null;
    const { pool, spare } = choice;
    let size = choice.size;
    let index = -1;
    let fallback = pool[hash % pool.length]!;
    let farthest = -1;
    const deck = pool.length + (spare?.length ?? 0);
    for (let k = 0; k < deck; k++) {
      const fromSpare = k >= pool.length;
      const candidate = fromSpare ? spare![(hash + k) % spare!.length]! : pool[(hash + k) % pool.length]!;
      let nearest = Infinity;
      let taken = false;
      for (const other of wearers.get(candidate) ?? []) {
        const worn = cast.get(other);
        if (!worn) continue;
        if (company !== 0 && worn.group === company) { taken = true; break; }
        nearest = Math.min(nearest, Math.hypot(worn.x - x, worn.y - y));
      }
      if (taken) continue;
      if (nearest >= CAST_NEAR) {
        index = candidate;
        if (fromSpare) size = choice.spareSize ?? size;
        break;
      }
      if (!fromSpare && nearest > farthest) { farthest = nearest; fallback = candidate; }
    }
    if (index < 0) index = fallback;
    const entry: Cast = { index, size, x, y, seen: castFrame, group: company };
    cast.set(seed, entry);
    const list = wearers.get(index);
    if (list) list.add(seed);
    else wearers.set(index, new Set([seed]));
    return entry;
  }
  /** Forgets whoever has not been drawn for `CAST_FORGET` frames: gone, or long out of sight. */
  function forgetCast(): void {
    for (const [seed, entry] of cast) {
      if (castFrame - entry.seen < CAST_FORGET) continue;
      cast.delete(seed);
      wearers.get(entry.index)?.delete(seed);
    }
  }
  const mixClips: ClipFrames[] = [];
  const mixPhases: number[] = [];
  const mixWeights: number[] = [];

  /** Writes one citizen: blended bone palette plus instance transform. */
  function emit(batch: CitizenBatch, clips: readonly ClipFrames[], phases: readonly number[],
    weights: readonly number[], x: number, height: number, y: number, heading: number, scale: number,
    lean = 0): void {
    const offset = batch.count * batch.width;
    batch.pixels.fill(0, offset, offset + batch.width);
    let total = 0;
    for (let c = 0; c < clips.length; c++) total += Math.max(0, weights[c]!);
    for (let c = 0; c < clips.length; c++) {
      const weight = Math.max(0, weights[c]!) / (total || 1);
      if (weight < 0.001) continue;
      const clip = clips[c]!;
      const f = Math.min(clip.frames, Math.max(0, phases[c]!));
      const fraction = f % 1;
      const start = Math.floor(f) * batch.width;
      for (let k = 0; k < batch.width; k++) {
        batch.pixels[offset + k] = batch.pixels[offset + k]! + weight *
          (clip.data[start + k]! * (1 - fraction) + clip.data[start + batch.width + k]! * fraction);
      }
    }
    transform.position.set(x, height, -y);
    // Yaw, then a roll about the body's own forward axis (+Z on the model; a
    // lean to the left tips +Y towards the model's +X, its left).
    transform.rotation.set(0, heading + Math.PI / 2, -lean, 'YXZ');
    transform.scale.set(scale, scale, scale);
    transform.updateMatrix();
    for (let i = 0; i < batch.meshes.length; i++) {
      matrix.multiplyMatrices(transform.matrix, batch.local[i]!);
      batch.meshes[i]!.setMatrixAt(batch.count, matrix);
    }
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
      detail = level;
      castFrame++;
      if (castFrame % 240 === 0) forgetCast();
      lod = zoom >= 8 ? 0 : zoom >= 2 ? 1 : 2;
      group.userData.lod = lod;
      for (const batch of batches.values()) {
        batch.count = 0;
        for (let i = 0; i < batch.meshes.length; i++) {
          const variants = batch.lods[i]!;
          batch.meshes[i]!.geometry = variants[Math.min(lod, variants.length - 1)]!;
        }
      }
    },
    /**
     * Draws one pedestrian, the body playing what `citizenGait.ts` decides
     * from how the simulation moves it: walks blended by pace and advanced by
     * the ground the drawn body covers, the walk start and stop, turns stepped
     * round by the angle turned, and the stands, talk, phone and bench.
     */
    draw(ped: Ped, x: number, y: number, heading: number, deck: number, alpha: number) {
      const hash = pedHash(ped.id);
      const body = bodyFor(ped, hash, false, ped.id, x, y, ped.party.size > 1 ? ped.party.id + 1 : 0, dressFor(ped.party));
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
      for (const play of plays) {
        mixClips.push(batch.clips[GAIT_AT[play.name]]!);
        mixPhases.push(play.frame);
        mixWeights.push(play.weight);
      }
      emit(batch, mixClips, mixPhases, mixWeights, x, deck, y, gaitHeading(gait), m(scale));
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
    drawClip(identity: { readonly seed: number; readonly gender: 'f' | 'm'; readonly ageClass: 'child' | 'adult' | 'elder';
      /** Who they are with - a vehicle's occupants, negative - so none of them wears the same body. */
      readonly company?: number;
      /** How the people they are with are dressed. */
      readonly style?: DressStyle },
      pelvisX: number, pelvisY: number, pelvisHeight: number, heading: number,
      plays: readonly { readonly key: CitizenClipKey; readonly phase: number; readonly weight: number;
        /** For a walk: ground covered, world units; the phase then follows this body's own stride. */
        readonly distance?: number }[],
      lean = 0, maxScale = Infinity, fromGround: boolean | 'pelvisOver' = false, fixedScale = 0,
      helmet: Matrix4 | null = null): number {
      const hash = pedHash(identity.seed);
      const body = bodyFor(identity, hash, helmet !== null, identity.seed, pelvisX, pelvisY, identity.company ?? 0,
        identity.style ?? 'casual');
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
        pelvisY - leftY * drop * Math.sin(lean) - leftY * shiftLeft - aheadY * shiftAhead, heading, scale, lean);
      if (helmet) {
        // This body's helmet on the head of the pose carrying the most
        // weight, through the transform `emit` just drew the body with: at
        // this body's size, leaned and turned with it.
        if (!headClip?.head || !batch.helmet) return -scale;
        helmet.multiplyMatrices(transform.matrix, helmetBone.multiplyMatrices(headClip.head, batch.helmet));
      }
      return scale;
    },
    finish() {
      for (const batch of batches.values()) {
        if (batch.count > 0) {
          batch.texture.clearUpdateRanges();
          // three.js uploads each DataTexture update range as one image row.
          // A range spanning multiple citizens exceeds the texture width and
          // leaves their bone palettes frozen on the GPU.
          for (let i = 0; i < batch.count; i++) {
            batch.texture.addUpdateRange(i * batch.width, batch.width);
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
