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
const CLIPS = ['Idle_Loop', 'Idle_Talking_Loop', 'Walk_Loop', 'Walk_Formal_Loop', 'Jog_Fwd_Loop'];
const CAPACITY = 1000;
const FPS = 30;
interface ClipFrames { data: Float32Array; frames: number; duration: number; stride: number }
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
    for (let i = 0; i <= frames; i++) {
      mixer.setTime((i % frames) * clip.duration / frames);
      rig.updateMatrixWorld(true);
      skeleton.update();
      data.set(skeleton.boneMatrices!, i * width);
      for (const foot of [left, right]) {
        if (!foot) continue;
        foot.getWorldPosition(position);
        low = Math.min(low, position.z);
        high = Math.max(high, position.z);
      }
    }
    clips.push({ data, frames, duration: clip.duration, stride: Math.max(0.75, Math.min(2.8, (high - low) * 2)) });
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
        mesh.receiveShadow = true;
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
      const index = hash % models.length;
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
      const travel = elapsed > 0.5 ? ped.v * dt : Math.hypot(x - state.x, y - state.y);
      const speed = dt > 0 ? travel / dt / m(1) : ped.v / m(1);
      state.time = time; state.x = x; state.y = y;
      const delta = Math.atan2(Math.sin(heading - state.heading), Math.cos(heading - state.heading));
      state.heading += delta * (1 - Math.exp(-dt * 10));
      state.blend += ((speed > 0.035 ? 1 : 0) - state.blend) * (1 - Math.exp(-dt * 14));
      state.run += (Math.max(0, Math.min(1, (speed - 1.75) / 0.65)) - state.run) * (1 - Math.exp(-dt * 7));
      const walk = batch.clips[(hash & 8) !== 0 ? 3 : 2]!;
      const jog = batch.clips[4]!;
      state.phase += travel / (m(scale) * (walk.stride * (1 - state.run) + jog.stride * state.run));
      const idle = batch.clips[ped.party.size > 1 && (hash & 3) === 0 ? 1 : 0]!;
      const idlePhase = (time * (0.88 + ((hash >>> 20) & 15) / 60) / idle.duration + (hash % 701) / 701) % 1;
      const phases = [idlePhase * idle.frames, (state.phase % 1) * walk.frames, (state.phase % 1) * jog.frames];
      const clips = [idle, walk, jog];
      const weights = [1 - state.blend, state.blend * (1 - state.run), state.blend * state.run];
      const offset = batch.count * batch.width;
      batch.pixels.fill(0, offset, offset + batch.width);
      for (let c = 0; c < 3; c++) {
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
      transform.position.set(x, deck, -y);
      transform.rotation.set(0, state.heading + Math.PI / 2, 0);
      transform.scale.set(m(scale), m(scale), m(scale));
      transform.updateMatrix();
      for (let i = 0; i < batch.meshes.length; i++) {
        matrix.multiplyMatrices(transform.matrix, batch.local[i]!);
        batch.meshes[i]!.setMatrixAt(batch.count, matrix);
      }
      batch.count++;
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
