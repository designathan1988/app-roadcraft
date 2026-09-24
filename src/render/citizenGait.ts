import { SIT_DOWN_SECONDS, STAND_UP_SECONDS } from '@sim/peds/activities';
import type { Ped } from '@sim/peds/state';
import { DT } from '@sim/params';
import { m } from '@world/units';
import {
  WALK_ADVANCE, strideShare, walkDuration, walkSource,
  type LibraryClip, type LibraryClipName, type WalkAmplitude, type WalkSex,
} from './citizenWalk';

/**
 * What a pedestrian's legs play, decided from what the simulation says the
 * body is doing — and nothing else. No bone, mesh or texture is touched here;
 * `riggedCitizens.ts` bakes the clips and blends what this returns, and the
 * tests drive this directly against the real simulation (`citizenGait.spec`).
 *
 * THE BODY MOVES, SO THE LEGS STEP. The speed the gait reads is the speed
 * the DRAWN body moves at: the simulation's own tick-to-tick displacement,
 * which already holds the walk along the footway, a step aside, the catch-up
 * after a change of edge and the steps to and from a bench. Reading the
 * forward speed alone, every one of those moved a figure standing in its idle
 * pose — a ghost sliding over the pavement — and a walk stop that had played
 * out left the body gliding on at half a metre a second with its feet
 * together.
 *
 * STEPS SHORTEN WITH PACE. A person walking slowly takes shorter steps at a
 * slower cadence, not the same step slowed down. The neutral walk used to be
 * the only cycle and its stride fixed, so somebody at 0.4 m/s played it at a
 * third of its speed: slow motion. Now three captures are blended on one
 * shared phase by speed — a shuffle (the slow walk with its swing shrunk), the
 * Rocketbox slow walk, and the neutral walk (an older person's version of it
 * for elders) — each at its own natural pace, and between two of them the
 * stride is interpolated, so the cadence stays in the range a person has.
 *
 * TURNS ARE STEPPED. Turning on the spot plays the turn clips, advanced by the
 * angle the body turns, whatever else was playing; a turn made while barely
 * moving adds its footwork to the cadence. The finish of a walk stop used to
 * take precedence, and the figure swivelled on motionless legs to face a
 * crossing.
 *
 * THE BODY FACES WHERE IT GOES. Without a sideways step to play, somebody
 * stepping aside turns part way towards it, so the walk is played roughly the
 * way the feet are going rather than straight ahead of a body sliding sideways.
 */

export interface GaitClip {
  /** Intervals between baked frames. */
  readonly frames: number;
  readonly duration: number;
  readonly loop: boolean;
  /** Ground one cycle covers on this body at scale 1, metres. */
  readonly stride: number;
  /** Ground covered by each baked frame (walk start, stop), metres at scale 1. */
  readonly travel?: Float32Array;
  /** Angle turned by each baked frame (turns), radians, unsigned. */
  readonly yaw?: Float32Array;
}

export const GAIT_CLIP_NAMES = [
  'walk', 'walkElder', 'walkSlow', 'walkShuffle', 'run', 'start', 'stop', 'turnLeft', 'turnRight',
  'idle', 'look', 'phone', 'talk', 'listen', 'sitDown', 'sitIdle', 'standUp',
] as const;
export type GaitClipName = (typeof GAIT_CLIP_NAMES)[number];
export type GaitClips = Readonly<Record<GaitClipName, GaitClip>>;
/** The walk and run cycles, which 'loco' blends on one phase. */
type Cycle = 'walk' | 'walkElder' | 'walkSlow' | 'walkShuffle' | 'run';
type Single = Exclude<GaitClipName, Cycle>;
type PlayKey = 'loco' | Single;
interface Play {
  key: PlayKey;
  /** Fraction through the clip, 0..1. */
  phase: number;
  /** Distance (start, stop) or angle (turns) this play has covered. */
  acc: number;
}

/** One pedestrian's gait: what is playing and how the body is moving. */
export interface Gait {
  time: number;
  /** The simulation's heading, followed smoothly. */
  base: number;
  /** Turn of the drawn body towards the way it is moving, radians. */
  lean: number;
  /** Drawn heading last frame. */
  drawn: number;
  /** Velocity of the drawn body, smoothed, m/s. */
  vx: number;
  vy: number;
  speed: number;
  /** Rate of change of `speed`, smoothed, m/s². */
  accel: number;
  /** Shared phase of every walk and the run, 0..1. */
  cycle: number;
  run: number;
  /** The two walk cycles blended at this pace, and the second one's weight. */
  walkA: Cycle;
  walkB: Cycle;
  walkW: number;
  /** Ground the legs cover per cycle at this pace on this body, metres. */
  stride: number;
  cur: Play;
  prev: Play | null;
  /** Weight of `cur` against `prev`, rising to 1 over `fadeTime`. */
  fade: number;
  fadeTime: number;
  /** Seconds the body has been turning slowly enough to stop the turn. */
  settling: number;
  /** A walk stop may begin: not again until the body has walked on or stood. */
  armed: boolean;
  /** The stop, or kerb wait, a look round has already been played for. */
  looked: unknown;
}

/** One clip of the mix: which, at what baked frame, at what weight. */
export interface GaitPlay {
  name: GaitClipName;
  frame: number;
  weight: number;
}

/**
 * An older walker: a step about a fifth shorter, arms that swing about half as
 * far, hips that rise and roll less. The trunk keeps the capture's own
 * upright posture — nothing here leans or bends it.
 */
export const ELDER_AMPLITUDE: WalkAmplitude = { arms: 0.5, legs: 0.78, hips: 0.6 };
/**
 * The shuffle: the slow walk with its swing roughly halved. The slowest
 * capture there is walks at 0.8-0.9 m/s; a person inching forward in a knot
 * or easing into a queue takes steps half that long, not the same steps at
 * half the rate.
 */
export const SHUFFLE_AMPLITUDE: WalkAmplitude = { arms: 0.4, legs: 0.5, hips: 0.55 };

/** Baking rate of a clip: long, slow loops at 10 fps, everything else at the capture's 30. */
export const bakeFps = (clip: { readonly loop: boolean; readonly duration: number }): number =>
  clip.loop && clip.duration > 6 ? 10 : 30;
export const bakedFrames = (duration: number, fps: number): number => Math.max(1, Math.round(duration * fps));

/** Samples a per-source-frame curve of a library clip at a fraction of it. */
function curveAt(curve: Float32Array, loop: boolean, fraction: number): number {
  const count = curve.length;
  const x = loop ? fraction * count : fraction * (count - 1);
  const k0 = Math.min(count - 1, Math.max(0, Math.floor(x)));
  const k1 = loop ? (k0 + 1) % count : Math.min(count - 1, k0 + 1);
  const f = x - Math.floor(x);
  return curve[k0]! * (1 - f) + curve[k1]! * f;
}

/**
 * The gait facts of one library clip on a body of `scale`: its baked frame
 * count, its stride, and its travel (walk start, stop) and turn curves
 * resampled to the baked frames.
 */
export function gaitClipOf(clip: LibraryClip, scale: number, frames: number): GaitClip {
  const travel = new Float32Array(frames + 2);
  const yaw = new Float32Array(frames + 2);
  for (let i = 0; i <= frames + 1; i++) {
    const fraction = Math.min(1, i / frames);
    travel[i] = curveAt(clip.travel, clip.loop, clip.loop ? fraction % 1 : fraction) * scale;
    yaw[i] = Math.abs(curveAt(clip.yaw, clip.loop, fraction));
  }
  return {
    frames, duration: clip.duration, loop: clip.loop, stride: clip.advance * scale,
    ...(clip.kind === 'forward' ? { travel } : {}), ...(clip.kind === 'turn' ? { yaw } : {}),
  };
}

/** The Rocketbox library clips the gait plays, by the name the gait knows them by. */
export const GAIT_LIBRARY = [
  'walkSlow', 'start', 'stop', 'run', 'turnLeft', 'turnRight',
  'idle', 'look', 'phone', 'talk', 'listen', 'sitDown', 'sitIdle', 'standUp',
] as const satisfies readonly (LibraryClipName & GaitClipName)[];

/**
 * Every gait clip of one sex at scale 1, straight from the library: what the
 * renderer bakes, without a body to bake it on. The tests measure with this.
 */
export function gaitClipsOf(library: Readonly<Record<LibraryClipName, LibraryClip>>, sex: WalkSex): GaitClips {
  const out = {} as Record<GaitClipName, GaitClip>;
  for (const name of GAIT_LIBRARY) {
    const clip = library[name];
    out[name] = gaitClipOf(clip, 1, bakedFrames(clip.duration, bakeFps(clip)));
  }
  const duration = walkDuration(sex);
  const walk: GaitClip = { frames: bakedFrames(duration, 30), duration, loop: true, stride: WALK_ADVANCE[sex] };
  out.walk = walk;
  out.walkElder = { ...walk, stride: walk.stride * strideShare(walkSource(sex), ELDER_AMPLITUDE) };
  out.walkShuffle = { ...out.walkSlow, stride: out.walkSlow.stride * strideShare(library.walkSlow.source, SHUFFLE_AMPLITUDE) };
  return out;
}

// ------------------------------------------------------------- clip curves

/** Fraction of a clip at which its travel curve reaches `distance` (monotone curves). */
function fractionAtTravel(clip: GaitClip, distance: number): number {
  const curve = clip.travel;
  if (!curve) return 1;
  const last = clip.frames;
  if (distance <= curve[0]!) return 0;
  if (distance >= curve[last]!) return 1;
  let lo = 0, hi = last;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (curve[mid]! < distance) lo = mid; else hi = mid;
  }
  const span = curve[hi]! - curve[lo]!;
  return (lo + (span > 1e-6 ? (distance - curve[lo]!) / span : 0)) / last;
}

/** Ground a clip has covered at a fraction of it, metres at scale 1. */
function travelAt(clip: GaitClip, fraction: number): number {
  const curve = clip.travel;
  if (!curve) return 0;
  const x = Math.min(1, Math.max(0, fraction)) * clip.frames;
  const k = Math.min(clip.frames - 1, Math.floor(x));
  return curve[k]! + (curve[k + 1]! - curve[k]!) * (x - k);
}

/** Fraction of a turn clip at which it has turned `angle` radians. */
function fractionAtYaw(clip: GaitClip, angle: number): number {
  const curve = clip.yaw;
  if (!curve) return 1;
  let best = clip.frames;
  for (let i = 0; i <= clip.frames; i++) if (curve[i]! >= angle) { best = i; break; }
  if (best === 0) return 0;
  const a = curve[best - 1]!, b = curve[best]!;
  return (best - 1 + (b > a ? (angle - a) / (b - a) : 1)) / clip.frames;
}

/** Speed of a forward clip at each baked frame on a body of `size`, m/s. */
const clipSpeed = (clip: GaitClip, i: number, size: number): number =>
  (clip.travel![i]! - clip.travel![i - 1]!) * size / (clip.duration / clip.frames);

/**
 * Fraction of the walk stop at which the clip moves at `speed` on a body of
 * `size`, after its fastest point: where a slowing walker joins it.
 */
function stopEntry(clip: GaitClip, speed: number, size: number): number {
  if (!clip.travel) return 0;
  let peak = 0, peakAt = 0;
  for (let i = 1; i <= clip.frames; i++) {
    const v = clipSpeed(clip, i, size);
    if (v > peak) { peak = v; peakAt = i; }
  }
  for (let i = Math.max(1, peakAt); i <= clip.frames; i++) {
    if (clipSpeed(clip, i, size) <= speed) return (i - 1) / clip.frames;
  }
  return 1;
}

/**
 * Fraction of the walk start at which the clip first moves at `speed`: a
 * body already under way skips the weight shift the clip begins with.
 */
function startEntry(clip: GaitClip, speed: number, size: number): number {
  if (!clip.travel) return 0;
  for (let i = 1; i <= clip.frames; i++) {
    if (clipSpeed(clip, i, size) >= speed) return (i - 1) / clip.frames;
  }
  return 0;
}

// ------------------------------------------------------------------ pacing

/** Speed at which a person breaks into a run, m/s; fixed for life from their id. */
const runAt = (hash: number): number => 1.75 + 0.35 * ((hash >>> 9) & 255) / 255;

/** Walk cycles for a body, slowest first. */
const ADULT_WALKS = ['walkShuffle', 'walkSlow', 'walk'] as const satisfies readonly Cycle[];
const ELDER_WALKS = ['walkShuffle', 'walkSlow', 'walkElder'] as const satisfies readonly Cycle[];

/** Natural pace of a walk cycle on a body of `size`, m/s. */
const naturalPace = (clip: GaitClip, size: number): number => clip.stride * size / clip.duration;

/**
 * Chooses the two walk cycles for a pace, the second one's weight, and the
 * ground one blended cycle covers. At each capture's own pace it is played
 * exactly as captured; between two, the stride is interpolated; below the
 * shuffle, its stride shortens with the pace as a person's does.
 */
function pace(g: Gait, clips: GaitClips, elder: boolean, size: number, speed: number): void {
  const walks = elder ? ELDER_WALKS : ADULT_WALKS;
  const first = clips[walks[0]];
  const last = clips[walks[walks.length - 1]!];
  g.walkA = g.walkB = walks[0];
  g.walkW = 0;
  if (speed <= naturalPace(first, size)) {
    const own = naturalPace(first, size);
    g.stride = first.stride * size * Math.pow(Math.max(speed, 0.02) / own, STRIDE_EXPONENT);
    return;
  }
  for (let i = 0; i < walks.length - 1; i++) {
    const a = clips[walks[i]!], b = clips[walks[i + 1]!];
    const va = naturalPace(a, size), vb = naturalPace(b, size);
    if (speed > vb || vb <= va) continue;
    const w = (speed - va) / (vb - va);
    g.walkA = walks[i]!;
    g.walkB = walks[i + 1]!;
    g.walkW = w;
    g.stride = (a.stride + (b.stride - a.stride) * w) * size;
    return;
  }
  g.walkA = g.walkB = walks[walks.length - 1]!;
  g.stride = last.stride * size;
}

// ---------------------------------------------------------------- tuning

/** Drawn speeds, m/s, above which a body counts as moving — higher to start than to keep going. */
const MOVE_FROM_STILL = 0.14;
const KEEP_MOVING = 0.06;
/** Body turning rate, rad/s, at which the feet have to step round. */
const TURN_STEPS = 0.35;
/** The same for a body standing or creeping, which no stride carries round. */
const TURN_STEPS_STANDING = 0.2;
/** Turning rate, rad/s, a fully played turn clip carries a standing body round at. */
const STEPPED_TURN_RATE = 3.2;
/** Yaw rate, rad/s, a turn clip steps at before the body has begun to follow it. */
const FEET_LEAD_RATE = 1.2;
/** Angle, rad, a standing body may lag where it is facing before it steps round. */
const LAG_STEPS = 0.12;
/** Drawn speed below which a turn that fast is stepped with the turn clips. */
const TURN_IN_PLACE = 0.3;
/** Seconds a turn clip is held once the turning has stopped. */
const TURN_SETTLE = 0.35;
/** Angle a turn clip is entered at: into its steps, not its wind-up. */
const TURN_WINDUP = 0.05;
/** Half the width between the feet, metres: how far each foot travels as the body pivots. */
const TURN_FOOT = 0.3;
/** Walking speed, m/s, below which a braking walker plays the walk stop, and the braking it needs. */
const STOP_BELOW = 0.6;
const STOP_DECEL = 0.35;
/** Speed, m/s, below which setting off plays the walk start. */
const START_BELOW = 1.0;
/**
 * Slowest share of its own rate a start or stop is played at. Advanced only
 * by the ground covered, a start into a slow pace dragged over seconds — the
 * clip ends at 1.2 m/s and the walker never got there.
 */
const CLIP_FLOOR = 0.75;
/** Rate a stop the body has already come out of finishes at, as a share of its own. */
const STOP_SETTLE = 1.25;
/** How stride follows pace below the slowest capture (stride ∝ pace^0.6, as measured in people). */
const STRIDE_EXPONENT = 0.6;
/** Crossfades, seconds: between steps of the gait, into a turn, and between anything else. */
const GAIT_FADE = 0.18;
const TURN_FADE = 0.22;
const FADE = 0.3;
const RUN_TIME = 0.6;
/** Smoothing of the drawn velocity and of its rate of change, seconds. */
const VELOCITY_TIME = 0.12;
const ACCEL_TIME = 0.2;
/** Share of the angle between heading and motion the body turns into, its limit, and how fast. */
const LEAN_SHARE = 0.85;
const LEAN_MAX = 1.2;
const LEAN_TIME = 0.25;
/** Drawn speeds over which the lean fades in, m/s. */
const LEAN_FROM = 0.12;
const LEAN_FULL = 0.4;
/** Beyond this angle the motion is backwards, and the body does not turn to face it. */
const BACKWARDS = 1.9;
/** A tick's displacement faster than this is a re-seat, not a step, m/s. */
const JUMP = 4;

const smoothstep = (lo: number, hi: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - lo) / (hi - lo)));
  return t * t * (3 - 2 * t);
};
const wrap = (a: number): number => Math.atan2(Math.sin(a), Math.cos(a));
const approach = (dt: number, time: number): number => 1 - Math.exp(-dt / time);

// ------------------------------------------------------------------- state

/** The heading to draw the body at. */
export const gaitHeading = (g: Gait): number => g.base + g.lean;

/** Velocity of the drawn body over the last simulation tick, m/s. */
function drawnVelocity(ped: Ped): { x: number; y: number } {
  const x = (ped.x - ped.prev.x) / m(1) / DT;
  const y = (ped.y - ped.prev.y) / m(1) / DT;
  if (Math.hypot(x, y) <= JUMP) return { x, y };
  const v = ped.v / m(1);
  return { x: Math.cos(ped.heading) * v, y: Math.sin(ped.heading) * v };
}

export function createGait(ped: Ped, time: number, heading: number, hash: number): Gait {
  const v = drawnVelocity(ped);
  const speed = Math.hypot(v.x, v.y);
  return {
    time, base: heading, lean: 0, drawn: heading, vx: v.x, vy: v.y, speed, accel: 0,
    cycle: (hash % 997) / 997, run: 0, walkA: 'walk', walkB: 'walk', walkW: 0, stride: 1,
    cur: { key: speed > MOVE_FROM_STILL ? 'loco' : 'idle', phase: (hash % 613) / 613, acc: 0 },
    prev: null, fade: 1, fadeTime: FADE, settling: 0, armed: true, looked: null,
  };
}

/** Starts playing `key`, crossfading from whatever was playing. */
function play(g: Gait, key: PlayKey, phase = 0, fade = FADE): void {
  if (g.cur.key === key) return;
  g.prev = g.cur;
  g.cur = { key, phase, acc: 0 };
  g.fade = 0;
  g.fadeTime = fade;
}

/**
 * What a person standing still is doing, from what the simulation says they
 * are doing: talking or listening with their party, reading a phone,
 * looking round, or simply standing, each with a phase of their own.
 */
function standingKey(ped: Ped, g: Gait, hash: number): Single {
  const act = ped.activity;
  if (act?.kind === 'talk' && act.phase === 'hold') {
    // One speaks at a time, and the turn passes round the party.
    const turn = Math.floor((ped.age + (ped.party.id % 7) * 1.3) / 6.5) % Math.max(1, ped.party.size);
    return turn === ped.rank ? 'talk' : 'listen';
  }
  if (act?.kind === 'phone') return 'phone';
  const lookFor: unknown = act?.kind === 'look' ? act : ped.state === 'WaitAtKerb' && (hash & 3) === 1 &&
    ped.waited > 1.5 ? ped.route[0] : null;
  if (lookFor !== null && lookFor !== undefined) {
    if (g.looked !== lookFor) { g.looked = lookFor; return 'look'; }
    if (g.cur.key === 'look' && g.cur.phase < 1) return 'look';
  }
  if (ped.state === 'WaitAtKerb' && (hash & 3) === 0 && ped.waited > 2.5) return 'phone';
  return 'idle';
}

/**
 * Advances one pedestrian's gait to `time` (the pedestrian's own clock,
 * interpolated). `heading` is the simulation's, interpolated; `size` is the
 * body's scale, metres per model metre.
 */
export function stepGait(g: Gait, ped: Ped, clips: GaitClips, time: number, heading: number,
  size: number, hash: number): void {
  const dt = Math.min(Math.max(0, time - g.time), 0.2);
  g.time = time;

  // How the drawn body is moving.
  const raw = drawnVelocity(ped);
  const kv = approach(dt, VELOCITY_TIME);
  g.vx += (raw.x - g.vx) * kv;
  g.vy += (raw.y - g.vy) * kv;
  const speed = Math.hypot(g.vx, g.vy);
  if (dt > 0) g.accel += ((speed - g.speed) / dt - g.accel) * approach(dt, ACCEL_TIME);
  g.speed = speed;

  // The simulation already turns the body at a human rate; this only absorbs
  // frame-to-frame interpolation. The lean turns it towards its motion.
  if (speed < TURN_IN_PLACE && g.lean !== 0) {
    // Coming to rest, the lean into the walk becomes part of where the body
    // faces, and is stepped out like any other turn. Relaxing it freely
    // turned a standing body on still feet.
    g.base = wrap(g.base + g.lean);
    g.lean = 0;
  }
  const want = wrap(heading - g.base);
  let swing = want * approach(dt, 1 / 18);
  if (speed < TURN_IN_PLACE) {
    // Standing or creeping, the body turns only as far as its feet step it
    // round, by the weight of the turn clip now playing. It used to take the simulation's heading
    // at once, and the turn clip faded in over a body already turned - the
    // swivel on motionless legs that players kept reporting.
    const stepWeight = g.cur.key === 'turnLeft' || g.cur.key === 'turnRight'
      ? g.fade * g.fade * (3 - 2 * g.fade)
      : g.prev && (g.prev.key === 'turnLeft' || g.prev.key === 'turnRight') ? 1 - g.fade : 0;
    // Only once the steps carry most of the pose: turning while the turn clip
    // is still a faint blend over the stand is the same swivel, slower.
    const limit = STEPPED_TURN_RATE * Math.max(0, stepWeight * 2 - 1) * dt;
    swing = Math.max(-limit, Math.min(limit, swing));
  }
  g.base = wrap(g.base + swing);
  let lean = 0;
  if (speed > LEAN_FROM) {
    const off = wrap(Math.atan2(g.vy, g.vx) - g.base);
    if (Math.abs(off) < BACKWARDS) {
      lean = Math.max(-LEAN_MAX, Math.min(LEAN_MAX, off)) * LEAN_SHARE * smoothstep(LEAN_FROM, LEAN_FULL, speed);
    }
  }
  g.lean += (lean - g.lean) * approach(dt, LEAN_TIME);
  const drawn = gaitHeading(g);
  const turned = Math.abs(wrap(drawn - g.drawn));
  g.drawn = drawn;

  const act = ped.activity;
  const elder = ped.ageClass === 'elder';
  const cur = g.cur;
  const isGait = cur.key === 'loco' || cur.key === 'start' || cur.key === 'stop';
  const isTurn = cur.key === 'turnLeft' || cur.key === 'turnRight';
  // Standing, a slower turn already needs the feet: the body is not carried
  // round by a stride, so any visible rotation is footwork or a swivel.
  // A body still short of where it is facing, standing, steps round to it too.
  const lagging = speed < TURN_IN_PLACE && Math.abs(wrap(heading - g.base)) > LAG_STEPS;
  const spin = lagging || Math.abs(ped.turnV) > (speed < TURN_IN_PLACE ? TURN_STEPS_STANDING : TURN_STEPS);
  const turnSign = Math.abs(ped.turnV) > TURN_STEPS_STANDING ? Math.sign(ped.turnV) : Math.sign(wrap(heading - g.base));
  const seat = act?.kind === 'bench' ? act.phase : null;

  if (seat === 'sitDown' || seat === 'seated' || seat === 'standUp') {
    const key = seat === 'seated' ? 'sitIdle' : seat;
    play(g, key, 0, FADE);
    g.cur.phase = seat === 'sitDown' ? Math.min(1, act!.t / SIT_DOWN_SECONDS[ped.gender])
      : seat === 'standUp' ? Math.min(1, act!.t / STAND_UP_SECONDS[ped.gender])
        : (act!.t / clips.sitIdle.duration) % 1;
  } else if (speed > (isGait ? KEEP_MOVING : MOVE_FROM_STILL) && (!spin || speed >= TURN_IN_PLACE)) {
    // A fast turn while barely creeping is a turn on the spot, even out of a
    // walk: it used to stay in the walk stop, feet planted, while the body
    // swung round to face the road at every kerb - most of the rotation the
    // audit found on motionless legs.
    moving(g, ped, clips, dt, speed, size, hash, elder);
  } else {
    standing(g, ped, clips, dt, turned, spin, isTurn, hash, turnSign);
    // A walk fading out under a turn or a stop keeps stepping with whatever
    // motion is left, rather than freezing mid-stride while the body turns.
    g.cycle = (g.cycle + Math.hypot(speed, TURN_FOOT * ped.turnV) * dt / Math.max(1e-3, g.stride)) % 1;
  }

  // Whatever is fading out finishes its own steps meanwhile.
  const prev = g.prev;
  if (prev?.key === 'stop') prev.phase = Math.min(1, prev.phase + STOP_SETTLE * dt / clips.stop.duration);
  else if (prev?.key === 'start') prev.phase = Math.min(1, prev.phase + dt / clips.start.duration);
  else if (prev?.key === 'turnLeft' || prev?.key === 'turnRight') {
    // A turn handing over - to its own next step or to a walk - finishes the
    // step it is in rather than freezing with a foot in the air.
    prev.phase = Math.min(1, prev.phase + dt / clips[prev.key].duration);
  }
  if (g.fade < 1) g.fade = Math.min(1, g.fade + dt / g.fadeTime);
  if (g.fade >= 1) g.prev = null;
}

/** The branch of `stepGait` for a body not going anywhere: turning, settling, or standing. */
function standing(g: Gait, ped: Ped, clips: GaitClips, dt: number, turned: number, spin: boolean,
  isTurn: boolean, hash: number, turnSign: number): void {
  const cur = g.cur;
  if (spin || (isTurn && g.settling < TURN_SETTLE)) {
    // Turning on the spot: the feet step round, the turn clip advanced by
    // the angle the body has actually turned. This comes before the end of
    // a walk stop, which used to swivel the body on legs standing still.
    const key: Single = spin ? (turnSign > 0 ? 'turnLeft' : 'turnRight') : (cur.key as Single);
    if (spin) g.settling = 0; else g.settling += dt;
    if (g.cur.key !== key) {
      play(g, key, 0, TURN_FADE);
      g.cur.acc = TURN_WINDUP;
    }
    const clip = clips[key];
    // The feet lead a turn: they step from its first moment, and the body
    // follows once the steps carry the pose (see the swing limit above).
    g.cur.acc += spin ? Math.max(turned, FEET_LEAD_RATE * dt) : turned;
    g.cur.phase = fractionAtYaw(clip, g.cur.acc);
    if (g.cur.phase >= 0.96) {
      // Still turning past the end of the clip: step round again.
      g.prev = { ...g.cur };
      g.cur = { key, phase: 0, acc: TURN_WINDUP };
      g.fade = 0;
      g.fadeTime = 0.2;
    }
    g.armed = true;
  } else if (cur.key === 'stop' && cur.phase < 1) {
    // Come to rest before the stop has played out: its last steps settle
    // the feet, a little quicker than captured.
    cur.phase = Math.min(1, cur.phase + STOP_SETTLE * dt / clips.stop.duration);
    g.armed = true;
  } else {
    const key = standingKey(ped, g, hash);
    if (key !== g.cur.key) play(g, key, key === 'look' ? 0 : ((hash >>> 4) % 997) / 997, FADE);
    const clip = clips[key];
    g.cur.phase = clip.loop ? (g.cur.phase + dt / clip.duration) % 1 : Math.min(1, g.cur.phase + dt / clip.duration);
    g.armed = true;
  }
}

/** The moving branch of `stepGait`: set off, walk or run, or stop. */
function moving(g: Gait, ped: Ped, clips: GaitClips, dt: number, speed: number, size: number,
  hash: number, elder: boolean): void {
  g.settling = 0;
  const cur = g.cur;
  if (cur.key !== 'loco' && cur.key !== 'start' && cur.key !== 'stop') {
    // Setting off from a standstill: the walk start, joined where it moves at
    // this pace, unless already going too fast for it.
    if (speed < START_BELOW && !elder) {
      play(g, 'start', startEntry(clips.start, speed, size), GAIT_FADE);
      g.cur.acc = travelAt(clips.start, g.cur.phase) * size;
    } else {
      play(g, 'loco', 0, GAIT_FADE);
    }
  } else if (cur.key === 'loco' && g.armed && speed < STOP_BELOW && g.accel < -STOP_DECEL && !elder && g.run < 0.1) {
    // Braking to a stop: join the walk stop where it moves at this pace.
    const entry = stopEntry(clips.stop, speed, size);
    if (entry < 0.9) {
      play(g, 'stop', entry, GAIT_FADE);
      g.cur.acc = travelAt(clips.stop, entry) * size;
      g.armed = false;
    }
  } else if (cur.key === 'stop' && (speed > STOP_BELOW + 0.2 || g.accel > STOP_DECEL || cur.phase >= 0.97)) {
    // Not stopping after all, or the stop is done and the body still moves:
    // walk on, in short steps if slowly. A finished stop used to hold the
    // feet together while the body slid on.
    play(g, 'loco', 0, GAIT_FADE);
  }
  if (speed > STOP_BELOW + 0.1) g.armed = true;

  const now = g.cur;
  const travel = speed * dt;
  if (now.key === 'start') {
    now.acc += travel;
    now.phase = Math.max(fractionAtTravel(clips.start, now.acc / size), now.phase + CLIP_FLOOR * dt / clips.start.duration);
    if (now.phase >= 0.999) { g.cycle = 0; play(g, 'loco', 0, GAIT_FADE); }
  } else if (now.key === 'stop') {
    now.acc += travel;
    now.phase = Math.min(1, Math.max(fractionAtTravel(clips.stop, now.acc / size),
      now.phase + CLIP_FLOOR * dt / clips.stop.duration));
  }

  pace(g, clips, elder, size, speed);
  const runs = elder ? 0 : smoothstep(runAt(hash), runAt(hash) + 0.6, speed);
  g.run += (runs - g.run) * approach(dt, RUN_TIME);
  const stride = g.stride * (1 - g.run) + clips.run.stride * size * g.run;
  // A turn made while barely moving is footwork too.
  const stepping = Math.hypot(speed, TURN_FOOT * ped.turnV);
  g.cycle = (g.cycle + stepping * dt / Math.max(1e-3, stride)) % 1;
}

/** Appends what the body plays now, as weighted clips at baked frames. */
export function gaitPlays(g: Gait, clips: GaitClips, out: GaitPlay[]): void {
  const eased = g.fade * g.fade * (3 - 2 * g.fade);
  add(g, clips, g.cur, eased, out);
  if (g.prev) add(g, clips, g.prev, 1 - eased, out);
}

function add(g: Gait, clips: GaitClips, entry: Play, weight: number, out: GaitPlay[]): void {
  if (weight < 0.001) return;
  if (entry.key === 'loco') {
    const walk = weight * (1 - g.run);
    const push = (name: Cycle, w: number): void => {
      if (w >= 0.001) out.push({ name, frame: g.cycle * clips[name].frames, weight: w });
    };
    if (g.walkA === g.walkB) push(g.walkA, walk);
    else {
      push(g.walkA, walk * (1 - g.walkW));
      push(g.walkB, walk * g.walkW);
    }
    push('run', weight * g.run);
    return;
  }
  out.push({ name: entry.key, frame: entry.phase * clips[entry.key].frames, weight });
}
