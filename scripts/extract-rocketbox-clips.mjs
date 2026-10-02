/**
 * Extracts the Microsoft Rocketbox animations the citizens play into one
 * compact motion library per sex (src/render/motion/rocketbox*.json).
 *
 *   node scripts/extract-rocketbox-clips.mjs <folder of .max.fbx files>
 *
 * The folder holds the files named in CLIPS, downloaded from
 * https://github.com/microsoft/Microsoft-Rocketbox (Assets/Animations/
 * all_animations_max_motextr_{xy,xyz,static}/), MIT, Copyright (c) 2020
 * Microsoft; e.g. `m_walk_start.max.fbx` saved as `m_walk_start.fbx`.
 *
 * WHY THE SAME TRANSFER AS THE WALK. The neutral walks in motion/walk*.json
 * came from the user's Rocketbox package, captured on Male_Adult_01 and
 * Female_Adult_01. Loading m_walk_neutral / f_walk_neutral from the repository
 * with three's FBXLoader gives, for every one of the 80 bones in every frame,
 * the SAME world rotation as the package (largest difference 0.6 degrees,
 * rounding) in the same Y-up, +Z-forward frame; only the unit (centimetres)
 * and the forward travel differ. So every clip here is written as world
 * rotations and transferred exactly the way the walk is — relative to the
 * package avatar's bind pose, which each library names — and none needs a
 * retarget of its own.
 *
 * WHAT IS TAKEN OUT. The game, not the clip, decides where a person is and
 * which way they face. Each clip is turned to face +Z at its first frame, and:
 *   cycle   the pelvis keeps its sway, loses the steady advance; `travel`
 *           records the ground covered, so the game can plant the feet.
 *   forward (walk start/stop) the pelvis is held over the origin; `travel`
 *           is the forward progress, frame by frame.
 *   turn    the body's own yaw is removed frame by frame and recorded in
 *           `turned`; the game turns the body and plays the steps to match.
 *   static  kept as captured, relative to where the pelvis starts.
 *   sit     kept as captured: a sitter steps back and down onto the seat.
 * Long loops are sampled at 10 fps (their motion is slow); the rest
 * at 30, the capture's own rate. A long loop has its last half second eased
 * into the first frame so the seam never pops. A gait cycle cannot be
 * treated that way — half a second is half its stride, and easing it towards
 * frame 0 flattens that half — so its residual (the pose one cycle on, less
 * the first) is spread evenly over the whole cycle instead.
 *
 * GAITS BLENDED BY SPEED. `walkSlow` is played against the neutral walk in
 * motion/walk*.json on one shared phase, so it is rotated to start where the
 * walk starts: at the same point of the left thigh's swing (`ALIGN`).
 *
 * A clip whose file is not in the folder keeps what the library already
 * holds, so one clip can be added without fetching the other thirty.
 */
import fs from 'node:fs';
import path from 'node:path';
import { AnimationMixer, LoopOnce, Quaternion, Vector3 } from 'three';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';

const dir = process.argv[2];
if (!dir) throw new Error('Usage: node scripts/extract-rocketbox-clips.mjs <fbx folder>');

/** name in the game → [file stem without sex prefix, kind, loop] */
const CLIPS = {
  start: ['walk_start', 'forward', false],
  stop: ['walk_stop', 'forward', false],
  run: ['run_neutral', 'cycle', true],
  turnLeft: ['turn_left_90', 'turn', false],
  turnRight: ['turn_right_90', 'turn', false],
  turnLeft180: ['turn_left_180', 'turn', false],
  turnRight180: ['turn_right_180', 'turn', false],
  idle: ['idle_neutral_01', 'static', true],
  look: ['idle_look_around_01', 'static', false],
  phone: ['cell_phone_textmessage', 'static', true],
  talk: ['gestic_talk_neutral_01', 'static', true],
  listen: ['gestic_listen_neutral_01', 'static', true],
  sitDown: ['sit_down_chair_01', 'sit', false],
  sitIdle: ['sit_chair_idle_neutral_01', 'sit', true],
  standUp: ['sit_stand_up_chair_01', 'sit', false],
  walkSlow: ['walk_slow_01', 'cycle', true],
  // Things people do (`citizenGait.ts`, the gestures of `sim/people`).
  read: ['newspaper_hand_idle', 'static', true],
  bag: [{ m: 'hold_bag_idle', f: 'hold_bag_idle_01' }, 'static', true],
  trolley: ['trolley_idle', 'static', true],
  umbrella: ['umbrella_idle_01', 'static', true],
  cheer: ['cheer_01', 'static', false],
  dance: ['dancing_neutral', 'static', true],
  wave: ['wave_01', 'static', false],
  drink: ['drink_drinking', 'static', true],
  photo: ['take_picture', 'static', false],
  crouchDown: ['crouch_in', 'static', false],
  crouchIdle: ['crouch_idle', 'static', true],
  crouchUp: ['crouch_out', 'static', false],
  laugh: ['gestic_laugh_loud', 'static', true],
  angry: ['idle_angry_01', 'static', true],
  argue: ['gestic_talk_angry_01', 'static', true],
  knock: ['knock_door', 'static', false],
  headphones: ['headphones_idle', 'static', true],
  eatIdle: ['sit_table_idle_neutral_01', 'sit', true],
  workTable: ['work_table', 'static', true],
  walkDrunk: ['walk_drunk', 'cycle', true],
  runFast: ['run_fast_01', 'cycle', true],
};
/** Cycles phase-aligned to the neutral walk, because they are blended with it. */
const ALIGN = new Set(['walkSlow']);
const LIBRARIES = { male: ['m', 'walkMale.json'], female: ['f', 'walkFemale.json'] };
const out = path.join('src', 'render', 'motion');

const load = (file) => {
  const buffer = fs.readFileSync(file);
  return new FBXLoader().parse(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength), '');
};
const f32 = (values) => Buffer.from(new Float32Array(values).buffer).toString('base64');
const i16 = (values) => Buffer.from(new Int16Array(values.map((v) => Math.round(Math.max(-1, Math.min(1, v)) * 32767))).buffer).toString('base64');
const yawAbout = (angle) => new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), angle);

/**
 * How far forward the left thigh points, frame by frame, from world rotations
 * relative to the walk avatar's bind pose (`q` as [x, y, z, w] per bone).
 */
function leftThighSwing(walk, frames) {
  const thigh = walk.bones.indexOf('Bip01_L_Thigh');
  const calf = walk.bones.indexOf('Bip01_L_Calf');
  const bind = new Quaternion(...walk.bind[thigh].q).invert();
  const along = new Vector3(...walk.bind[calf].p).sub(new Vector3(...walk.bind[thigh].p)).normalize();
  return frames.map((q) => along.clone().applyQuaternion(new Quaternion(...q[thigh]).multiply(bind)).z);
}

/** Frames to rotate `curve` by so that it lines up best with `reference`, both one cycle. */
function bestShift(reference, curve) {
  const samples = 240;
  const at = (c, u) => {
    const x = (((u % 1) + 1) % 1) * c.length;
    const k = Math.floor(x) % c.length;
    return c[k] + (c[(k + 1) % c.length] - c[k]) * (x - Math.floor(x));
  };
  let best = 0, bestScore = -Infinity;
  for (let s = 0; s < samples; s++) {
    let score = 0;
    for (let i = 0; i < samples; i++) score += at(reference, i / samples) * at(curve, i / samples + s / samples);
    if (score > bestScore) { bestScore = score; best = s; }
  }
  return Math.round(best / samples * curve.length) % curve.length;
}

for (const [sex, [prefix, walkFile]] of Object.entries(LIBRARIES)) {
  const walk = JSON.parse(fs.readFileSync(path.join(out, walkFile), 'utf8'));
  const bones = walk.bones;
  const target = path.join(out, `rocketbox${sex === 'male' ? 'Male' : 'Female'}.json`);
  const existing = fs.existsSync(target) ? JSON.parse(fs.readFileSync(target, 'utf8')) : null;
  const library = {
    source: 'https://github.com/microsoft/Microsoft-Rocketbox Assets/Animations',
    license: 'Microsoft Rocketbox, MIT, Copyright (c) 2020 Microsoft',
    bind: walkFile,
    bones,
    clips: {},
  };
  let seatBack = null;
  for (const [name, [stem, kind, loop]] of Object.entries(CLIPS)) {
    const file = path.join(dir, `${prefix}_${typeof stem === 'string' ? stem : stem[prefix]}.fbx`);
    if (!fs.existsSync(file)) {
      const kept = existing?.clips?.[name];
      if (!kept) throw new Error(`${file} is missing and the library has no ${name} to keep`);
      library.clips[name] = kept;
      console.log(`${sex} ${name.padEnd(13)} kept (no ${path.basename(file)})`);
      continue;
    }
    const scene = load(file);
    const clip = scene.animations[0];
    const mixer = new AnimationMixer(scene);
    // Played once and held, so the last key can be read: a looping action
    // wraps its end back to its start.
    const action = mixer.clipAction(clip);
    action.setLoop(LoopOnce, 1);
    action.clampWhenFinished = true;
    action.play();
    const nodes = bones.map((b) => scene.getObjectByName(b));
    const missing = bones.filter((_, i) => !nodes[i]);
    if (missing.length) throw new Error(`${file}: missing ${missing.join(', ')}`);
    const pelvis = scene.getObjectByName('Bip01_Pelvis');
    const thighL = scene.getObjectByName('Bip01_L_Thigh');
    const thighR = scene.getObjectByName('Bip01_R_Thigh');
    const feet = ['Bip01_L_Foot', 'Bip01_R_Foot', 'Bip01_L_Toe0', 'Bip01_R_Toe0'].map((n) => scene.getObjectByName(n));
    const fps = loop && clip.duration > 6 ? 10 : 30;
    // A loop's last key repeats its first, so it is not stored; a one-shot
    // keeps its last pose.
    const count = Math.max(2, Math.round(clip.duration * fps) + (loop ? 0 : 1));
    const step = clip.duration / (loop ? count : count - 1);
    // Facing from the hips: forward is up × (left hip − right hip).
    const facing = () => {
      const l = thighL.getWorldPosition(new Vector3());
      const r = thighR.getWorldPosition(new Vector3());
      return Math.atan2(l.z - r.z, -(l.x - r.x)) + Math.PI;
    };
    const raw = [];
    let unwrapped = 0;
    let previous = null;
    for (let k = 0; k < count; k++) {
      mixer.setTime(Math.min(k * step, clip.duration - 1e-4));
      scene.updateMatrixWorld(true);
      const f = facing();
      if (previous !== null) unwrapped += Math.atan2(Math.sin(f - previous), Math.cos(f - previous));
      previous = f;
      raw.push({
        q: nodes.map((n) => n.getWorldQuaternion(new Quaternion())),
        pelvis: pelvis.getWorldPosition(new Vector3()).multiplyScalar(0.01),
        feet: feet.map((n) => n.getWorldPosition(new Vector3()).multiplyScalar(0.01)),
        yaw: unwrapped,
        facing: f,
      });
    }
    // Turn the clip so that it faces +Z at its first frame (the walk's own
    // heading). `yaw` is measured from that start.
    const start = raw[0].facing;
    const toForward = yawAbout(-start);
    const origin = raw[0].pelvis.clone().applyQuaternion(toForward);
    const frames = raw.map((frame) => {
      // Turns: the body's own yaw comes off, frame by frame.
      const unturn = kind === 'turn' ? yawAbout(-frame.yaw) : new Quaternion();
      const rotate = unturn.clone().multiply(toForward);
      const q = frame.q.map((w) => rotate.clone().multiply(w));
      const p = frame.pelvis.clone().applyQuaternion(rotate);
      const o = origin;
      const lowest = Math.min(...frame.feet.map((v) => v.y));
      return { q, p, o, lowest, yaw: frame.yaw };
    });
    // The pose one full cycle on, from the key after the last: its steady
    // advance, and what is left over once it has come round to the start.
    let end = null;
    if (kind === 'cycle') {
      mixer.setTime(clip.duration);
      scene.updateMatrixWorld(true);
      end = {
        q: nodes.map((n) => toForward.clone().multiply(n.getWorldQuaternion(new Quaternion()))),
        p: pelvis.getWorldPosition(new Vector3()).multiplyScalar(0.01).applyQuaternion(toForward),
      };
    }
    const advance = end ? end.p.z - origin.z : 0;
    if (end) {
      // Close the cycle over its whole length: each frame takes its share of
      // the rotation that carries the next cycle's first pose onto this one's.
      const residual = end.q.map((q, b) => frames[0].q[b].clone().multiply(q.clone().invert()));
      frames.forEach((frame, k) => frame.q.forEach((q, b) => q.premultiply(new Quaternion().slerp(residual[b], k / count))));
    }
    let travel = [];
    let pelvisOut = [];
    frames.forEach((frame, k) => {
      const t = k / count;
      const forward = frame.p.z - frame.o.z;
      travel.push(forward);
      let x = frame.p.x - frame.o.x, z = forward;
      if (kind === 'cycle') z = forward - advance * t;
      if (kind === 'forward' || kind === 'turn') { x = 0; z = 0; }
      if (end) {
        // The same for the pelvis: its sideways and vertical drift over a cycle.
        x -= (end.p.x - origin.x) * t;
        pelvisOut.push(x, frame.p.y - (end.p.y - frames[0].p.y) * t, z);
      } else {
        pelvisOut.push(x, frame.p.y, z);
      }
    });
    if (ALIGN.has(name)) {
      // Start where the neutral walk starts, so the two share one phase.
      const shift = bestShift(leftThighSwing(walk, walk.frames.map((f) => f.q)),
        leftThighSwing(walk, frames.map((f) => f.q.map((r) => [r.x, r.y, r.z, r.w]))));
      const turn = (list, stride) => [...list.slice(shift * stride), ...list.slice(0, shift * stride)];
      frames.splice(0, frames.length, ...turn(frames, 1));
      pelvisOut = turn(pelvisOut, 3);
      const x0 = pelvisOut[0], z0 = pelvisOut[2];
      for (let k = 0; k < pelvisOut.length; k += 3) { pelvisOut[k] -= x0; pelvisOut[k + 2] -= z0; }
      travel = travel.map((_, k) => travel[(k + shift) % count] + (k + shift >= count ? advance : 0));
      console.log(`${sex} ${name.padEnd(13)} rotated ${shift} of ${count} frames onto the walk's phase`);
    }
    if (name === 'sitDown') seatBack = [pelvisOut[pelvisOut.length - 3], pelvisOut[pelvisOut.length - 1]];
    if ((name === 'sitIdle' || name === 'standUp') && seatBack) {
      for (let k = 0; k < pelvisOut.length; k += 3) { pelvisOut[k] += seatBack[0]; pelvisOut[k + 2] += seatBack[1]; }
    }
    // Ease a long loop's seam: the last half second slides into the first frame.
    if (loop && !end) {
      const window = Math.min(count - 1, Math.round(0.5 * fps));
      for (let k = count - window; k < count; k++) {
        const w = (k - (count - window) + 1) / (window + 1);
        frames[k].q.forEach((q, b) => q.slerp(frames[0].q[b], w * w * (3 - 2 * w)));
        for (let c = 0; c < 3; c++) pelvisOut[k * 3 + c] += (pelvisOut[c] - pelvisOut[k * 3 + c]) * w;
      }
    }
    const q = [];
    for (const frame of frames) for (const r of frame.q) {
      // One hemisphere per bone keeps interpolation between keys short.
      q.push(r.x, r.y, r.z, r.w);
    }
    library.clips[name] = {
      file: `${prefix}_${stem}.max.fbx`,
      kind, loop, fps, frames: count,
      duration: loop ? clip.duration : step * (count - 1),
      advance: kind === 'cycle' ? advance : travel[travel.length - 1] - travel[0],
      turned: kind === 'turn' ? frames[frames.length - 1].yaw : 0,
      q: i16(q),
      pelvis: f32(pelvisOut),
      travel: f32(travel.map((v) => v - travel[0])),
      yaw: f32(frames.map((f) => f.yaw)),
      lowest: f32(frames.map((f) => f.lowest)),
    };
    console.log(`${sex} ${name.padEnd(13)} ${kind.padEnd(8)} ${count} frames @${fps} ${clip.duration.toFixed(2)}s` +
      (kind === 'turn' ? ` turned ${(frames[frames.length - 1].yaw * 57.3).toFixed(0)} deg` : '') +
      (kind === 'forward' || kind === 'cycle' ? ` travel ${library.clips[name].advance.toFixed(2)} m` : '') +
      ` pelvis y ${frames[0].p.y.toFixed(2)}..${frames[frames.length - 1].p.y.toFixed(2)}`);
  }
  fs.writeFileSync(target, JSON.stringify(library));
  console.log(`wrote ${target}: ${(fs.statSync(target).size / 1024).toFixed(0)} KB`);
}
