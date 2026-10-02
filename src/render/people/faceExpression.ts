import { personHash } from '@sim/people/view';

/**
 * A person's face this instant.
 *
 * The vocabulary is ARKit's 52 blendshapes (`expressions.ts`), but a face is
 * driven through a few CHANNELS - emotions, mouth shapes, blink, brows, gaze -
 * each one a fixed mix of ARKit shapes. The crowd's bodies carry one morph
 * per channel (13, built from the ARKit shapes by `channelShapes`): every
 * morph is read for every vertex of every instanced body each frame, and 54
 * of them made the town crawl. A single close-up body (the lab, the
 * creator) may carry all 52 and gets the channels expanded into them.
 *
 * Emotions are the Facial Action Coding System's prototypes (Ekman & Friesen,
 * EMFACS) as ARKit shapes, themselves FACS action units: joy AU6+12, sadness
 * AU1+4+15, anger AU4+5+7+23, surprise AU1+2+5+26. Speech is a run of visemes
 * (the Oculus/MPEG-4 set) folded into five mouth shapes, one per syllable.
 */
export type FaceWeights = Record<string, number>;

/** Each channel as ARKit shapes. */
export const CHANNELS: Record<string, FaceWeights> = {
  faceBlink: { eyeBlinkLeft: 1, eyeBlinkRight: 1 },
  faceJoy: { cheekSquintLeft: 0.55, cheekSquintRight: 0.55, mouthSmileLeft: 0.75, mouthSmileRight: 0.75, eyeSquintLeft: 0.2, eyeSquintRight: 0.2 },
  faceSadness: { browInnerUp: 0.7, browDownLeft: 0.25, browDownRight: 0.25, mouthFrownLeft: 0.55, mouthFrownRight: 0.55, mouthShrugLower: 0.2 },
  faceAnger: { browDownLeft: 0.85, browDownRight: 0.85, eyeSquintLeft: 0.35, eyeSquintRight: 0.35, eyeWideLeft: 0.15, eyeWideRight: 0.15,
    mouthPressLeft: 0.5, mouthPressRight: 0.5, noseSneerLeft: 0.2, noseSneerRight: 0.2 },
  faceSurprise: { browInnerUp: 0.75, browOuterUpLeft: 0.75, browOuterUpRight: 0.75, eyeWideLeft: 0.6, eyeWideRight: 0.6, jawOpen: 0.3 },
  faceBrowRaise: { browInnerUp: 0.6, browOuterUpLeft: 0.5, browOuterUpRight: 0.5 },
  mouthOpen: { jawOpen: 0.5 }, // aa, DD, nn, kk
  mouthRound: { jawOpen: 0.3, mouthFunnel: 0.55 }, // O
  mouthPuckered: { jawOpen: 0.08, mouthPucker: 0.7 }, // U
  mouthSpread: { jawOpen: 0.15, mouthStretchLeft: 0.35, mouthStretchRight: 0.35, mouthSmileLeft: 0.1, mouthSmileRight: 0.1 }, // E, I, SS
  mouthShut: { mouthClose: 0.5, mouthPressLeft: 0.35, mouthPressRight: 0.35, mouthRollLower: 0.2 }, // PP, FF
};
/** The eyeballs' turn, a channel of its own (`facialMorphs.ts`). */
const GAZE = ['lookLeft', 'lookRight'];

/** The crowd's morphs: one per channel, mixed from the ARKit shapes. */
export function channelShapes(arkit: Record<string, Float32Array>): Record<string, Float32Array> {
  const out: Record<string, Float32Array> = {};
  for (const [channel, mix] of Object.entries(CHANNELS)) {
    let shape: Float32Array | undefined;
    for (const [name, weight] of Object.entries(mix)) {
      const unit = arkit[name];
      if (!unit) continue;
      shape ??= new Float32Array(unit.length);
      for (let i = 0; i < unit.length; i++) shape[i] = shape[i]! + unit[i]! * weight;
    }
    if (shape) out[channel] = shape;
  }
  return out;
}

const VISEMES = ['mouthOpen', 'mouthSpread', 'mouthSpread', 'mouthRound', 'mouthPuckered', 'mouthShut', 'mouthShut', 'mouthOpen', 'mouthSpread'];
const SYLLABLES = 4.2; // per second, ordinary speech

/** What the person is doing, as the face shows it. */
const ACTIVITY: Record<string, { channel?: string; amount: number; talk?: boolean; laugh?: boolean }> = {
  talk: { channel: 'faceJoy', amount: 0.25, talk: true },
  listen: { channel: 'faceJoy', amount: 0.15 },
  laugh: { channel: 'faceJoy', amount: 1, laugh: true },
  cheer: { channel: 'faceJoy', amount: 0.9, laugh: true },
  wave: { channel: 'faceJoy', amount: 0.6 },
  argue: { channel: 'faceAnger', amount: 0.8, talk: true },
  angry: { channel: 'faceAnger', amount: 0.9 },
  phone: { amount: 0, talk: true },
  dance: { channel: 'faceJoy', amount: 0.7 },
};

/** The face of person `seed` at `time` (s), doing `activity`, in a mood from -1 (low) to 1 (bright): channel weights. */
export function faceAt(seed: number, time: number, activity?: string, mood = 0): FaceWeights {
  const hash = personHash(seed ^ 0x4c9e3721);
  const out: FaceWeights = {};
  const add = (channel: string, amount: number): void => { if (amount > 0) out[channel] = (out[channel] ?? 0) + amount; };
  // Blinks: one every 3-5 s, 150 ms closing and opening.
  const blinkPhase = (time * (0.22 + ((hash >>> 8) & 15) * 0.008) + (hash & 255) / 255) % 1;
  add('faceBlink', blinkPhase > 0.965 ? Math.sin((blinkPhase - 0.965) / 0.035 * Math.PI) : 0);
  // Gaze wanders, the eyeballs turning.
  const look = Math.sin(time * 0.55 + (hash >>> 5)) * 0.32;
  add('lookLeft', look);
  add('lookRight', -look);

  const act = activity ? ACTIVITY[activity] : undefined;
  if (mood > 0) add('faceJoy', mood * 0.3);
  else add('faceSadness', -mood * 0.35);
  if (act?.channel) add(act.channel, act.amount);
  if (act?.talk) {
    const beat = time * SYLLABLES + ((hash >>> 16) & 255) / 64;
    const syllable = Math.floor(beat);
    const open = Math.sin((beat - syllable) * Math.PI);
    add(VISEMES[personHash(hash ^ syllable) % VISEMES.length]!, open);
    // Stressed syllables lift the brows.
    if (personHash(hash ^ (syllable * 7)) % 5 === 0) add('faceBrowRaise', 0.4 * open);
  }
  if (act?.laugh) add('mouthOpen', 0.7 * (0.5 + 0.5 * Math.sin(time * 9 + (hash & 63))));
  return out;
}

/**
 * Writes a face into a mesh's morph influences: straight into channel
 * morphs (the crowd), or expanded into ARKit shapes when the mesh has those.
 */
export function applyFace(influences: number[], dictionary: Record<string, number>, face: FaceWeights): void {
  influences.fill(0);
  const channels = dictionary['faceBlink'] !== undefined;
  for (const name in face) {
    const amount = face[name]!;
    if (channels || GAZE.includes(name)) {
      const index = dictionary[name];
      if (index !== undefined) influences[index] = Math.min(1, amount);
      continue;
    }
    const mix = CHANNELS[name];
    if (!mix) continue;
    for (const unit in mix) {
      const index = dictionary[unit];
      if (index !== undefined) influences[index] = Math.min(1, influences[index]! + mix[unit]! * amount);
    }
  }
}
