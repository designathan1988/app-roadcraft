import {
  BufferGeometry, Color, DataTexture, DynamicDrawUsage, Float32BufferAttribute, FloatType, Group, InstancedMesh,
  Matrix4, MeshDepthMaterial, MeshStandardMaterial, Object3D, Quaternion, RGBAFormat,
  RGBADepthPacking, SkinnedMesh, Texture, Vector3, type BufferAttribute,
} from 'three';
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { clone } from 'three/addons/utils/SkeletonUtils.js';
import { personHash, type PartyView, type PedView } from '@sim/people/view';
import { DT } from '@sim/params';
import { m } from '@world/units';
import { CROWD, CROWD_IDS, CastingRegistry, type CastingContext, type Company } from './citizenCasting';
import { NO_HELMET, RIDER_CLIPS, helmetShape, type RiderClip, type RiderClipKey } from './riderPoses';
import { CITIZEN_ASSET_URLS, CITIZEN_LICENSES } from './citizenAssets';
import type { CitizenModel } from './citizenCasting';
import { loadPeopleAssets } from '@people/body/assets';
import { Morpher } from '@people/body/morph';
import { createPersonRig, personSimplifier } from './people/personRig';
import { compileAhead } from './uploads';
import { HELD, createHeldProps } from './people/heldProps';
import { attachFacialMorphs } from './people/facialMorphs';
import { expressionShapes } from '@people/body/expressions';
import { applySkinAppearance, loadSkinAppearance, type SkinAppearance } from './people/skinAppearance';
import { loadProxyItem, type ProxyItem } from '@people/body/proxy';
import { wornItems } from '@people/spec';
import { captureBind, captureBindRotations } from './citizenWalk';
import { type Gradient, shearMatrix } from './groundShear';
import {
  WALK_ADVANCE, clipTransferFor, loadRocketboxLibrary, neutralWalkFor, strideShare, walkDuration, walkSource,
  type LibraryClip, type LibraryClipName, type RocketboxLibrary, type WalkAmplitude, type WalkSex,
} from './citizenWalk';
import {
  ELDER_AMPLITUDE, SHUFFLE_AMPLITUDE, REST_AMPLITUDE, bakeFps, createGait, gaitClipOf, gaitHeading, gaitPlays, stepGait,
  type Gait, type GaitClipName, type GaitClips, type GaitPlay,
} from './citizenGait';
import { directionalWalkFor } from './citizenStride';

export { CROWD_IDS } from './citizenCasting';
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
  'idle', 'look', 'phone', 'talk', 'listen', 'sitDown', 'sitIdle', 'standUp', 'walkSlow', 'walkDrunk',
  'read', 'bag', 'trolley', 'umbrella', 'cheer', 'dance', 'wave', 'drink', 'photo', 'crouchDown', 'crouchIdle', 'crouchUp', 'laugh', 'angry', 'argue', 'knock', 'headphones', 'eatIdle', 'workTable',
] as const satisfies readonly LibraryClipName[];
type Played = (typeof LIBRARY)[number];
const LIBRARY_AT = Object.fromEntries(LIBRARY.map((name, i) => [name, WALK_SHUFFLE + 1 + i])) as
  Readonly<Record<Played, number>>;
const DIRECTIONAL = ['walkRest', 'walkBack', 'walkLeft', 'walkRight'] as const;
const DIRECTIONAL_AT = Object.fromEntries(DIRECTIONAL.map((name, i) => [name, WALK_SHUFFLE + 1 + LIBRARY.length + i])) as
  Readonly<Record<(typeof DIRECTIONAL)[number], number>>;
/** Where each clip the gait plays (`citizenGait.ts`) is baked. */
const GAIT_AT: Readonly<Record<GaitClipName, number>> = {
  ...LIBRARY_AT, ...DIRECTIONAL_AT, walk: WALK, walkElder: WALK_ELDER, walkShuffle: WALK_SHUFFLE,
};
/**
 * People in and on vehicles (`riderPoses.ts`): car seats reclined to fit a
 * cabin, astride a motorcycle, pedalling a bicycle. Baked after the library.
 */
const RIDER_AT = Object.fromEntries(RIDER_CLIPS.map((clip, i) => [clip.key, WALK_SHUFFLE + 1 + LIBRARY.length + DIRECTIONAL.length + i])) as
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
  /** Per baked frame, the right then the left hand bone, in the model's frame (16 + 16): where a held thing goes. */
  hands?: Float32Array;
}
interface CitizenBatch {
  meshes: InstancedMesh[]; sources: SkinnedMesh[]; local: Matrix4[]; clips: ClipFrames[];
  /** The same baked clips, by the name the gait plays them by. */
  gait: GaitClips;
  texture: DataTexture; pixels: Float32Array; width: number; count: number;
  rows: number; uniform: { value: DataTexture };
  lods: BufferGeometry[][];
  /** This body's helmet in its head bone's frame (`riderPoses.helmetShape`), or null. */
  helmet: Matrix4 | null;
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

interface FacialExpression {
  readonly blink: number;
  readonly smile: number;
  readonly brow: number;
  readonly jaw: number;
  readonly lookLeft: number;
  readonly lookRight: number;
  readonly frown: number;
  /** Mouth shapes of the syllable being said: rounded, spread, closed. */
  readonly visemeO: number;
  readonly visemeE: number;
  readonly visemeM: number;
}

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

/** Syllables per second of ordinary speech, and how far the jaw opens on one (full open is a shout). */
const SYLLABLES = 4.2;
const SPEECH_JAW = 0.16;

/** Each person carries a quiet, deterministic facial beat rather than a shared loop. */
function facialExpression(seed: number, time: number, activity?: string, mood = 0): FacialExpression {
  const hash = personHash(seed ^ 0x4c9e3721);
  const blinkPhase = (time * (0.72 + ((hash >>> 8) & 15) * 0.018) + (hash & 255) / 255) % 1;
  const blink = blinkPhase > 0.93 ? Math.sin((blinkPhase - 0.93) / 0.07 * Math.PI) : 0;
  const look = Math.sin(time * 0.55 + (hash >>> 5)) * 0.32;
  // Speech: one syllable after another, the jaw opening and closing on each,
  // each syllable with its own mouth shape - never the same loop for all.
  let jaw = 0, visemeO = 0, visemeE = 0, visemeM = 0;
  if (activity === 'talk') {
    const beat = time * SYLLABLES + ((hash >>> 16) & 255) / 64;
    const syllable = Math.floor(beat);
    const open = Math.sin((beat - syllable) * Math.PI);
    const shape = personHash(hash ^ syllable) % 4;
    jaw = SPEECH_JAW * open;
    visemeO = shape === 0 ? 0.45 * open : 0;
    visemeE = shape === 1 ? 0.45 * open : 0;
    visemeM = shape === 2 ? 0.5 * (1 - open) : 0;
  }
  return {
    blink,
    smile: Math.max(0, (activity === 'talk' ? 0.22 : ((hash >>> 24) & 3) === 0 ? 0.12 : 0) + mood * 0.25),
    brow: activity === 'talk' ? 0.08 : 0,
    jaw,
    lookLeft: Math.max(0, look),
    lookRight: Math.max(0, -look),
    frown: Math.max(0, -mood) * 0.25,
    visemeO, visemeE, visemeM,
  };
}

function setFacialExpression(batch: CitizenBatch, slot: number, expression: FacialExpression): void {
  for (let i = 0; i < batch.meshes.length; i++) {
    const source = batch.sources[i]!;
    const influences = source.morphTargetInfluences;
    const targets = source.morphTargetDictionary;
    if (!influences || !targets) continue;
    influences.fill(0);
    const set = (name: string, value: number): void => {
      const index = targets[name];
      if (index !== undefined) influences[index] = value;
    };
    set('blinkLeft', expression.blink);
    set('blinkRight', expression.blink);
    set('smile', expression.smile);
    set('browLeftUp', expression.brow);
    set('browRightUp', expression.brow);
    set('open', expression.jaw);
    set('visemeO', expression.visemeO);
    set('visemeE', expression.visemeE);
    set('visemeM', expression.visemeM);
    set('frownLeft', expression.frown);
    set('frownRight', expression.frown);
    set('lookLeft', expression.lookLeft);
    set('lookRight', expression.lookRight);
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
  await afterFrame();
  sliceStart = performance.now();
}

/**
 * Resolves just after the next frame has been drawn: one slice of work per
 * frame. Resumed by a bare zero timeout, several slices ran back to back
 * between two frames and took the time the frame needed; waiting for the
 * browser's idle callback, a game drawing every frame never had any and the
 * bodies were never finished.
 */
function afterFrame(): Promise<void> {
  if (typeof requestAnimationFrame !== 'function') return new Promise<void>(resolve => setTimeout(resolve, 0));
  return new Promise<void>(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)));
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
  loop: boolean, fps = FPS, withHands = false): Promise<{ data: Float32Array; frames: number; pelvisY: number; pelvisX: number; pelvisZ: number; hands?: Float32Array }> {
  const { rig, mesh } = body;
  const skeleton = mesh.skeleton;
  const frames = Math.max(1, Math.round(duration * fps));
  const width = skeleton.bones.length * 16;
  const data = new Float32Array((frames + 2) * width);
  const pelvis = rig.getObjectByName('Bip01_Pelvis');
  const handR = withHands ? rig.getObjectByName('Bip01_R_Hand') : undefined;
  const handL = withHands ? rig.getObjectByName('Bip01_L_Hand') : undefined;
  const hands = handR && handL ? new Float32Array((frames + 2) * 32) : undefined;
  const position = new Vector3();
  let pelvisY = 0;
  let pelvisX = 0;
  let pelvisZ = 0;
  for (let i = 0; i <= frames; i++) {
    await breathe();
    pose(loop ? (i % frames) * duration / frames : i * duration / frames);
    skeleton.update();
    data.set(skeleton.boneMatrices!, i * width);
    if (hands) {
      handR!.updateWorldMatrix(true, false);
      handL!.updateWorldMatrix(true, false);
      hands.set(handR!.matrixWorld.elements, i * 32);
      hands.set(handL!.matrixWorld.elements, i * 32 + 16);
    }
    if (i === 0 && pelvis) {
      pelvis.getWorldPosition(position);
      pelvisY = position.y;
      pelvisX = position.x;
      pelvisZ = position.z;
    }
  }
  data.copyWithin((frames + 1) * width, frames * width, (frames + 1) * width);
  if (hands) hands.copyWithin((frames + 1) * 32, frames * 32, (frames + 1) * 32);
  return { data, frames, pelvisY, pelvisX, pelvisZ, ...(hands ? { hands } : {}) };
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
async function bakeLibraryClip(body: BakeRig, clip: LibraryClip, amplitude?: WalkAmplitude, name?: string): Promise<ClipFrames> {
  body.reset();
  const transfer = clipTransferFor(body.rig, body.mesh, clip, amplitude);
  const room = LIMB_ROOM[name ?? ''] ?? LIMB_ROOM_DEFAULT;
  // A long standing or seated loop is slow motion, captured at 10 fps in the
  // library; baking it at 30 tripled the memory and the load for nothing.
  const baked = await bakeFrames(body, time => { transfer.pose(time); clearLimbs(body.rig, room[0], room[1]); }, clip.duration, clip.loop, bakeFps(clip),
    HELD_CLIPS.has(name ?? ''));
  const facts = gaitClipOf(clip, transfer.scale, baked.frames);
  const share = amplitude ? strideShare(clip.source, amplitude) : 1;
  return { ...baked, ...facts, stride: facts.stride * share };
}

/**
 * Room for the arms, by clip: how far the upper arms are carried out from the
 * body and the forearms lifted, degrees. The captures were taken on slimmer
 * bodies than the people they are played on: seated, the hands sank into the
 * thighs and the arms into the sides.
 */
const LIMB_ROOM: Readonly<Record<string, readonly [number, number]>> = {
  sitIdle: [13, 16], sitDown: [11, 12], standUp: [11, 12],
  idle: [8, 0], look: [8, 0], listen: [8, 0], talk: [6, 0], phone: [5, 0],
  start: [6, 0], stop: [6, 0], run: [6, 0], walkSlow: [6, 0],
  turnLeft: [7, 0], turnRight: [7, 0], turnLeft180: [7, 0], turnRight180: [7, 0],
};
const LIMB_ROOM_DEFAULT: readonly [number, number] = [6, 0];

/** The clips whose hands hold something (`HELD`): their hand bones are baked too. */
const HELD_CLIPS = new Set(['read', 'drink', 'phone', 'photo', 'bag', 'umbrella']);

const limbA = new Vector3(), limbB = new Vector3(), limbAxis = new Vector3();
const limbQ = new Quaternion(), limbWorld = new Quaternion(), limbParent = new Quaternion();

/** Turns `bone` in world space by `q`, keeping its parent where it is. */
function turnInWorld(bone: Object3D, q: Quaternion): void {
  bone.getWorldQuaternion(limbWorld);
  if (bone.parent) bone.parent.getWorldQuaternion(limbParent); else limbParent.identity();
  bone.quaternion.copy(limbParent.invert().multiply(q.clone().multiply(limbWorld)));
  bone.updateMatrixWorld(true);
}

/**
 * Carries each upper arm out from the chest by `abduct` degrees and lifts each
 * forearm by `lift`, on the pose the rig is in, so a body broader than the
 * capture's keeps its limbs outside itself.
 */
function clearLimbs(rig: Object3D, abduct: number, lift: number): void {
  if (abduct <= 0 && lift <= 0) return;
  rig.updateMatrixWorld(true);
  const chest = rig.getObjectByName('Bip01_Spine2');
  if (!chest) return;
  chest.getWorldPosition(limbB);
  for (const side of ['L', 'R']) {
    const upper = rig.getObjectByName(`Bip01_${side}_UpperArm`);
    const fore = rig.getObjectByName(`Bip01_${side}_Forearm`);
    const hand = rig.getObjectByName(`Bip01_${side}_Hand`);
    if (!upper || !fore) continue;
    if (abduct > 0) {
      // Out, away from the chest: about the axis that turns "down" towards it.
      upper.getWorldPosition(limbA);
      const out = limbA.sub(limbB).setY(0);
      if (out.lengthSq() > 1e-8) {
        out.normalize();
        limbAxis.set(0, -1, 0).cross(out).normalize();
        turnInWorld(upper, limbQ.setFromAxisAngle(limbAxis, (abduct * Math.PI) / 180));
      }
    }
    if (lift > 0 && hand) {
      // The forearm turned up, about the axis across its own length.
      fore.getWorldPosition(limbA);
      hand.getWorldPosition(limbB.clone());
      const along = new Vector3();
      hand.getWorldPosition(along);
      along.sub(limbA);
      if (along.lengthSq() > 1e-8) {
        along.normalize();
        limbAxis.copy(along).cross(new Vector3(0, 1, 0)).normalize();
        if (limbAxis.lengthSq() > 1e-8) turnInWorld(fore, limbQ.setFromAxisAngle(limbAxis, (-lift * Math.PI) / 180));
      }
      chest.getWorldPosition(limbB);
    }
  }
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
  for (const name of LIBRARY) clips[LIBRARY_AT[name]] = await bakeLibraryClip(body, library[sex][name], undefined, name);
  body.reset();
  const rest = clipTransferFor(body.rig, body.mesh, library[sex].walkSlow, REST_AMPLITUDE);
  const restFrames = await bakeFrames(body, () => rest.pose(0), 1, true, 1);
  clips[DIRECTIONAL_AT.walkRest] = { ...restFrames, frames: 1, duration: 1, loop: true, stride: 0 };
  for (const [name, angle] of [['walkBack', Math.PI], ['walkLeft', Math.PI / 2], ['walkRight', -Math.PI / 2]] as const) {
    body.reset();
    const warped = directionalWalkFor(body.rig, body.mesh, library[sex].walkSlow, SHUFFLE_AMPLITUDE, angle);
    const facts = clips[WALK_SHUFFLE]!;
    const frames = await bakeFrames(body, time => warped.pose(time), facts.duration, true);
    clips[DIRECTIONAL_AT[name]] = { ...frames, duration: facts.duration, loop: true, stride: facts.stride * warped.strideScale };
  }
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
  // A held pose is two frames; a seated idle loop (`SEATED_IDLE` s) six a
  // second, enough for breathing and a turn of the head.
  const still = clip.key !== 'bikePedal' && clip.duration <= 1;
  const baked = await bakeFrames(body, pose, clip.duration, clip.loop, still ? 2 : clip.key === 'bikePedal' ? FPS : 6);
  pose(0);
  const head = body.rig.getObjectByName('Bip01_Head')?.matrixWorld.clone();
  return { ...baked, duration: clip.duration, loop: clip.loop, stride: 1, ...(head ? { head } : {}) };
}

/** The baked clips of one body, by the name the gait plays them by. */
function gaitClips(clips: readonly ClipFrames[]): GaitClips {
  return Object.fromEntries(Object.entries(GAIT_AT).map(([name, at]) => [name, clips[at]!])) as unknown as GaitClips;
}

export function createRiggedCitizens(models: readonly string[] = CROWD_IDS,
  onAssetsReady: () => void = () => {}) {
  const group = new Group();
  group.name = 'rigged-citizens';
  const batches = new Map<number, CitizenBatch>();
  const loading = new Map<number, Promise<void>>();
  const slots: Promise<void>[] = [Promise.resolve(), Promise.resolve(), Promise.resolve()];
  let nextSlot = 0;
  const resources = new Set<{ dispose(): void }>();
  const motion = new WeakMap<PedView, Gait>();
  const plays: GaitPlay[] = [];
  const transform = new Object3D();
  // What people hold while they stop to do something (`heldProps.ts`).
  const held = createHeldProps();
  group.add(held.group);
  resources.add(held);
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
  async function personAsset(model: CitizenModel): Promise<GLTF> {
    const people = await loadPeopleAssets();
    morpher ??= new Morpher(people.packs);
    const person = model.person!;
  
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
      await attachFacialMorphs(input, rig, await expressionShapes(person.body));
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
      const { clips, helmet } = await bake(asset, sex, library);
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
        uniform, count: 0, lods: [], helmet };
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
      batches.set(index, batch);
      group.userData.animationBytes = (group.userData.animationBytes ?? 0) + clips.reduce((sum, clip) => sum + clip.data.byteLength, 0);
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
  const registry = new CastingRegistry(CROWD.filter((m) => models.includes(m.id))
    .sort((p, q) => models.indexOf(p.id) - models.indexOf(q.id)), CAST_FORGET);
  const helmetFits = (id: string): boolean => !NO_HELMET.has(id);
  function bodyFor(ctx: CastingContext): { index: number; size: number } | null {
    return registry.pickCitizenModel(ctx, helmetFits);
  }
  const mixClips: ClipFrames[] = [];
  const mixPhases: number[] = [];
  const mixWeights: number[] = [];

  /** Writes one citizen: blended bone palette plus instance transform. */
  function emit(batch: CitizenBatch, clips: readonly ClipFrames[], phases: readonly number[],
    weights: readonly number[], x: number, height: number, y: number, heading: number, scale: number,
    lean = 0, ground: Gradient | null = null, expression?: FacialExpression): void {
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
      lod = zoom >= 8 ? 0 : zoom >= 2 ? 1 : 2;
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
      for (const play of plays) {
        mixClips.push(batch.clips[GAIT_AT[play.name]]!);
        mixPhases.push(play.frame);
        mixWeights.push(play.weight);
      }
      emit(batch, mixClips, mixPhases, mixWeights, x, deck, y, gaitHeading(gait), m(scale), lean, ground,
        lod === 0 ? facialExpression(ped.id, time, ped.gesture?.kind, CROWD[index]?.person?.mood) : undefined);
      // In the hand, what the gesture is done with, where the hand is in the
      // clip carrying the most weight this frame.
      const thing = ped.gesture ? HELD[ped.gesture.kind] : undefined;
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
        lod === 0 ? facialExpression(identity.seed, performance.now() / 1000 + identity.seed * 0.13,
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
