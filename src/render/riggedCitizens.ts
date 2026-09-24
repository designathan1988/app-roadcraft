import {
  AnimationMixer, BufferGeometry, DataTexture, DynamicDrawUsage, FloatType, Group, InstancedMesh,
  Matrix4, MeshDepthMaterial, MeshStandardMaterial, Object3D, RGBAFormat,
  RGBADepthPacking, SkinnedMesh, Texture, Vector3, type BufferAttribute,
} from 'three';
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { clone } from 'three/addons/utils/SkeletonUtils.js';
import { pedHash } from '@sim/peds/behaviour';
import type { Ped } from '@sim/peds/state';
import { DT } from '@sim/params';
import { m } from '@world/units';
import { CITIZEN_MODELS } from './citizenCatalog';
import { CITIZEN_ASSET_URLS, CITIZEN_LICENSES } from './citizenAssets';

export { CITIZEN_MODELS } from './citizenCatalog';
const CLIPS = [
  'Idle_Loop', 'Idle_Talking_Loop', 'Walk_Loop', 'Walk_Formal_Loop', 'Jog_Fwd_Loop',
  // Seated: at the wheel, riding along, and riding along in conversation.
  'Driving_Loop', 'Sitting_Idle_Loop', 'Sitting_Talking_Loop',
];
/** Indices into the baked clips for the seated poses. */
export const SEAT_DRIVE = 5;
export const SEAT_RIDE = 6;
export const SEAT_TALK = 7;
const CAPACITY = 1000;
const FPS = 30;
interface ClipFrames {
  data: Float32Array; frames: number; duration: number; stride: number;
  /** Height of the pelvis above the model origin in the first frame, metres. */
  pelvisY: number;
}
interface CitizenBatch {
  meshes: InstancedMesh[]; local: Matrix4[]; clips: ClipFrames[];
  texture: DataTexture; pixels: Float32Array; width: number; count: number;
  rows: number; uniform: { value: DataTexture };
  lods: BufferGeometry[][];
}
interface Motion {
  time: number; heading: number; x: number; y: number; phase: number;
  blend: number; run: number;
}

/**
 * How one person walks, fixed for life from their id.
 *
 * Every citizen used to play one of two walk cycles, chosen by a single bit,
 * at a cadence set by one shared stride: a crowd marching in step, stiff and
 * identical, the reported "hard, angry" gait. The cycles are now MIXED per
 * person, continuously: how formal the stride is, how much of the relaxed
 * standing pose rides on the upper body (looser arms, softer posture), how
 * long the stride is (which sets the cadence at a given speed), and a phase
 * of their own. None of it is re-rolled; it is who they are.
 */
interface Gait {
  /** Share of the formal walk cycle in the stride, 0..0.65. */
  readonly formal: number;
  /** Share of the standing pose blended into walking, 0..0.2: arm swing and posture. */
  readonly relaxed: number;
  /** Stride length relative to the clip's, 0.87..1.13. */
  readonly stride: number;
  /** Speed at which this person breaks into a jog, m/s. */
  readonly jogAt: number;
}

function gaitOf(hash: number): Gait {
  const byte = (shift: number): number => ((hash >>> shift) & 255) / 255;
  return {
    formal: 0.65 * byte(3) * byte(11),
    relaxed: 0.2 * byte(17),
    stride: 0.87 + 0.26 * byte(25),
    jogAt: 1.65 + 0.35 * byte(9),
  };
}

/** Speeds (m/s) between which the stride fades in from standing. */
const WALK_FADE_LOW = 0.06;
const WALK_FADE_HIGH = 0.45;
/** Seconds over which a figure settles into, or out of, walking. */
const BLEND_TIME = 0.35;
const RUN_TIME = 0.6;

const smoothstep = (lo: number, hi: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - lo) / (hi - lo)));
  return t * t * (3 - 2 * t);
};

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

/** Clips were retargeted offline. No skeleton traversal occurs during drawing. */
function bake(asset: GLTF): ClipFrames[] {
  const rig = clone(asset.scene);
  let reference: SkinnedMesh | undefined;
  rig.traverse(o => { if (o instanceof SkinnedMesh && !reference) reference = o; });
  if (!reference) throw new Error('Citizen model has no rig');
  const skeleton = reference.skeleton;
  const mixer = new AnimationMixer(rig);
  const left = rig.getObjectByName('Bip01_L_Foot');
  const right = rig.getObjectByName('Bip01_R_Foot');
  const pelvis = rig.getObjectByName('Bip01_Pelvis');
  const position = new Vector3();
  const clips: ClipFrames[] = [];
  for (const name of CLIPS) {
    const clip = asset.animations.find(a => a.name === name);
    if (!clip) throw new Error(`Citizen is missing ${name}`);
    mixer.stopAllAction();
    mixer.clipAction(clip).play();
    const frames = Math.ceil(clip.duration * FPS);
    const width = skeleton.bones.length * 16;
    const data = new Float32Array((frames + 1) * width);
    let low = Infinity, high = -Infinity;
    let pelvisY = 0;
    for (let i = 0; i <= frames; i++) {
      mixer.setTime((i % frames) * clip.duration / frames);
      rig.updateMatrixWorld(true);
      skeleton.update();
      data.set(skeleton.boneMatrices!, i * width);
      if (i === 0 && pelvis) pelvisY = pelvis.getWorldPosition(position).y;
      for (const foot of [left, right]) {
        if (!foot) continue;
        foot.getWorldPosition(position);
        low = Math.min(low, position.z);
        high = Math.max(high, position.z);
      }
    }
    clips.push({ data, frames, duration: clip.duration,
      stride: Math.max(0.75, Math.min(2.8, (high - low) * 2)), pelvisY });
  }
  mixer.stopAllAction();
  mixer.uncacheRoot(rig);
  return clips;
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
  const motion = new WeakMap<Ped, Motion>();
  const transform = new Object3D();
  const matrix = new Matrix4();
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
    const asset = await loader.loadAsync(url);
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
      const clips = bake(asset);
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
      const batch: CitizenBatch = { meshes: [], local: [], clips, texture, pixels, width, rows, uniform, count: 0, lods: [] };
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

  /** Who may take which seat: any citizen rides along; only adults drive. */
  const adults: number[] = [];
  const everyone: number[] = [];
  /** Bodies a pedestrian may be drawn as, by their sex. */
  const female: number[] = [];
  const male: number[] = [];
  models.forEach((id, index) => {
    everyone.push(index);
    if (!id.includes('_child')) adults.push(index);
    (id.includes('female') ? female : male).push(index);
  });

  /**
   * The bodies one pedestrian may be drawn as.
   *
   * A woman is drawn as a woman: the model was picked by a hash of the id
   * alone, so with a mixed roster half the women on the street were men.
   * Falls back to the whole roster when a sex has no model in it.
   */
  function poolFor(ped: Pick<Ped, 'gender'>): readonly number[] {
    const bySex = ped.gender === 'f' ? female : male;
    return bySex.length ? bySex : everyone;
  }
  const seatedClips: ClipFrames[] = [];
  const seatedPhases: number[] = [0];
  const SEATED_WEIGHTS = [1];

  /** Writes one citizen: blended bone palette plus instance transform. */
  function emit(batch: CitizenBatch, clips: readonly ClipFrames[], phases: readonly number[],
    weights: readonly number[], x: number, height: number, y: number, heading: number, scale: number): void {
    const offset = batch.count * batch.width;
    batch.pixels.fill(0, offset, offset + batch.width);
    for (let c = 0; c < clips.length; c++) {
      const weight = weights[c]!;
      if (weight < 0.001) continue;
      const clip = clips[c]!;
      const f = phases[c]!;
      const fraction = f % 1;
      const start = Math.floor(f) * batch.width;
      for (let k = 0; k < batch.width; k++) {
        batch.pixels[offset + k] = batch.pixels[offset + k]! + weight *
          (clip.data[start + k]! * (1 - fraction) + clip.data[start + batch.width + k]! * fraction);
      }
    }
    transform.position.set(x, height, -y);
    transform.rotation.set(0, heading + Math.PI / 2, 0);
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
    preload(): Promise<void> {
      return Promise.all(models.map((_, index) => request(index))).then(() => {});
    },
    begin(level = 2, zoom = Infinity) {
      detail = level;
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
    draw(ped: Ped, x: number, y: number, heading: number, deck: number, alpha: number) {
      const hash = pedHash(ped.id);
      const pool = poolFor(ped);
      const index = pool[hash % pool.length]!;
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
      const scale = 0.92 + ((hash >>> 8) & 255) / 255 * 0.17;
      let state = motion.get(ped);
      if (!state) {
        state = { time, x, y, heading, phase: (hash % 997) / 997, blend: ped.v > 0.05 ? 1 : 0, run: 0 };
        motion.set(ped, state);
      }
      const elapsed = Math.max(0, time - state.time);
      const dt = Math.min(elapsed, 0.2);
      // Distance and speed come from the SIMULATION, not from the difference of
      // two drawn positions: frame pacing, pauses and interpolation made that
      // difference noisy, and the noise flipped figures between standing and
      // walking poses from one frame to the next.
      const speed = ped.v / m(1);
      const travel = ped.v * dt;
      state.time = time; state.x = x; state.y = y;
      // The simulation already turns the body at a human rate; this only
      // absorbs frame-to-frame interpolation.
      const delta = Math.atan2(Math.sin(heading - state.heading), Math.cos(heading - state.heading));
      state.heading += delta * (1 - Math.exp(-dt * 18));
      const gait = gaitOf(hash);
      state.blend += (smoothstep(WALK_FADE_LOW, WALK_FADE_HIGH, speed) - state.blend) * (1 - Math.exp(-dt / BLEND_TIME));
      state.run += (smoothstep(gait.jogAt, gait.jogAt + 0.6, speed) - state.run) * (1 - Math.exp(-dt / RUN_TIME));
      const walk = batch.clips[2]!;
      const formal = batch.clips[3]!;
      const jog = batch.clips[4]!;
      const stride = m(scale) * gait.stride *
        ((walk.stride * (1 - gait.formal) + formal.stride * gait.formal) * (1 - state.run) + jog.stride * state.run);
      state.phase += travel / stride;
      // Companions who have stopped together talk; everybody else stands.
      const idle = batch.clips[ped.party.size > 1 && (ped.pause > 0 || (hash & 3) === 0) ? 1 : 0]!;
      const idlePhase = (time * (0.88 + ((hash >>> 20) & 15) / 60) / idle.duration + (hash % 701) / 701) % 1;
      const cycle = state.phase % 1;
      const phases = [idlePhase * idle.frames, cycle * walk.frames, cycle * formal.frames, cycle * jog.frames];
      const clips = [idle, walk, formal, jog];
      const walking = state.blend * (1 - state.run);
      // The standing pose keeps a share of the upper body while walking: a
      // looser, less drilled stride for the relaxed walkers.
      const standing = 1 - state.blend + walking * gait.relaxed;
      const striding = walking * (1 - gait.relaxed);
      const weights = [standing, striding * (1 - gait.formal), striding * gait.formal, state.blend * state.run];
      emit(batch, clips, phases, weights, x, deck, y, state.heading, m(scale));
    },
    /**
     * A person seated in a vehicle: the driver at the wheel, passengers riding
     * along, some of them talking. The same people who walk the streets, so a
     * car is driven by somebody rather than by a painted box.
     *
     * `hipY` is the world height of the seat; the figure is lowered so its
     * pelvis sits on it. `seed` picks the person and their timing, and a
     * driver is always an adult.
     */
    drawSeated(seed: number, x: number, y: number, heading: number, hipY: number,
      pose: number, time: number, adult: boolean) {
      const hash = pedHash(seed);
      const pool = adult ? adults : everyone;
      if (!pool.length) return;
      const index = pool[hash % pool.length]!;
      const batch = batches.get(index);
      if (!batch) {
        if (!loading.has(index)) void request(index).catch(() => {});
        return;
      }
      if (batch.count >= CAPACITY) return;
      if (batch.count >= batch.rows) grow(batch);
      const clip = batch.clips[pose] ?? batch.clips[SEAT_RIDE]!;
      const phase = ((time / clip.duration + (hash % 997) / 997) % 1) * clip.frames;
      const scale = 0.96 + ((hash >>> 8) & 255) / 255 * 0.08;
      seatedClips[0] = clip;
      seatedPhases[0] = phase;
      emit(batch, seatedClips, seatedPhases, SEATED_WEIGHTS, x, hipY - clip.pelvisY * m(scale), y, heading, m(scale));
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
