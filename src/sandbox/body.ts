import { type Group, Matrix4, type MeshStandardMaterial, SkinnedMesh, Vector3 } from 'three';

import { type CitizenModel } from '@render/citizenCasting';
import { bake, type ClipFrames, type Deferred } from '@render/citizenBake';
import { bakeInWorker } from '@render/bakePool';
import { loadRocketboxLibrary, type WalkSex } from '@render/citizenWalk';
import { loadCookedPerson } from '@render/people/cookedPerson';
import { applySkinAppearance, loadSkinAppearance } from '@render/people/skinAppearance';

/**
 * One person's body in the sandbox: a roster person as the game cooks it
 * (`cookedPerson.ts`), posed by the game's own baked clips (`citizenBake.ts`).
 *
 * The baked rows are the skeleton's bone matrices (bone world times its
 * inverse, the rig at the origin), so they go straight into the skinned
 * mesh's `boneMatrices`; the mesh is bound `detached`, and the group it hangs
 * from places and turns it in the world.
 */
export interface Layer {
  /** Clip slot (`GAIT_AT`, `LIBRARY_AT`, ...). */
  readonly at: number;
  /** Frame in the clip, fractional. */
  readonly frame: number;
  readonly weight: number;
}

export interface Body {
  readonly root: Group;
  readonly mesh: SkinnedMesh;
  readonly sex: WalkSex;
  readonly name: string;
  readonly clips: ClipFrames[];
  /** True once the clip at `at` is baked (a deferred one bakes on first `want`). */
  ready(at: number): boolean;
  /** Asks for a clip baked on demand; resolves when it is. */
  want(at: number): Promise<void>;
  /** Poses the body: the clips blended by weight. */
  pose(layers: readonly Layer[]): void;
  /** Where a bone is, in the body's own frame (metres), in the pose last set. */
  boneAt(name: string, out: Vector3): Vector3;
}

export async function loadBody(model: CitizenModel): Promise<Body> {
  const scene = await loadCookedPerson(model.id);
  if (!scene) throw new Error(`Pessoa ${model.id} não está cozida: rode npm run cook:people`);
  const sex: WalkSex = model.gender === 'f' ? 'female' : 'male';
  let mesh: SkinnedMesh | undefined;
  scene.traverse((o) => { if (o instanceof SkinnedMesh && !mesh) mesh = o; });
  if (!mesh) throw new Error(`Pessoa ${model.id} sem malha`);
  const skin = await loadSkinAppearance(model.person!);
  const materials = (Array.isArray(mesh.material) ? mesh.material : [mesh.material]) as MeshStandardMaterial[];
  for (const material of materials) {
    material.color.setHex(0xffffff);
    material.roughness = 0.88;
    material.metalness = 0;
    applySkinAppearance(material, mesh.geometry, skin);
  }
  mesh.castShadow = true;
  mesh.receiveShadow = false;
  mesh.frustumCulled = false;

  const library = await loadRocketboxLibrary();
  // The core clips on the other cores (as the game does), the rest on demand.
  const given = await bakeInWorker(scene, sex);
  const baked = await bake(scene, sex, library, given ?? undefined);
  const clips = baked.clips;
  const deferred: Deferred = baked.deferred;
  const pending = new Map<number, Promise<void>>();

  // Posed by hand: the bone matrices are written here, not by the skeleton.
  scene.updateMatrixWorld(true);
  mesh.bindMode = 'detached';
  mesh.bindMatrixInverse.copy(mesh.bindMatrix).invert();
  const skeleton = mesh.skeleton;
  const width = skeleton.bones.length * 16;
  const palette = new Float32Array(width);
  skeleton.update = () => {
    skeleton.boneMatrices!.set(palette);
    if (skeleton.boneTexture) skeleton.boneTexture.needsUpdate = true;
  };
  const boneIndex = new Map(skeleton.bones.map((b, i) => [b.name, i] as const));
  const scratch = new Matrix4();

  return {
    root: scene,
    mesh,
    sex,
    name: model.id,
    clips,
    ready: (at) => !deferred.has(at) && !pending.has(at),
    want(at) {
      const known = pending.get(at);
      if (known) return known;
      const job = deferred.get(at);
      if (!job) return Promise.resolve();
      deferred.delete(at);
      const work = job.make().then((clip) => { clips[at] = clip; pending.delete(at); });
      pending.set(at, work);
      return work;
    },
    pose(layers) {
      palette.fill(0);
      let total = 0;
      for (const l of layers) total += Math.max(0, l.weight);
      if (total <= 0) return;
      for (const l of layers) {
        const weight = Math.max(0, l.weight) / total;
        if (weight < 0.001) continue;
        const clip = clips[l.at];
        if (!clip) continue;
        const f = Math.min(clip.frames, Math.max(0, l.frame));
        const fraction = f % 1;
        const start = Math.floor(f) * width;
        const a = weight * (1 - fraction), b = weight * fraction;
        const data = clip.data;
        for (let k = 0; k < width; k++) palette[k] = palette[k]! + a * data[start + k]! + b * data[start + width + k]!;
      }
    },
    boneAt(name, out) {
      const i = boneIndex.get(name);
      if (i === undefined) return out.set(0, 0, 0);
      // palette = boneWorld * boneInverse; the bone's world is palette * inverse(boneInverse).
      scratch.fromArray(palette, i * 16).multiply(new Matrix4().copy(skeleton.boneInverses[i]!).invert());
      return out.setFromMatrixPosition(scratch);
    },
  };
}
