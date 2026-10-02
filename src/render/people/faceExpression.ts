import { personHash } from '@sim/people/view';

/**
 * A person's face this instant, as weights of the ARKit blendshapes
 * (`expressions.ts`), plus the eyeballs' turn (`lookLeft`/`lookRight`,
 * `facialMorphs.ts`).
 *
 * Emotions are the Facial Action Coding System's prototypes (Ekman & Friesen,
 * EMFACS) written as ARKit shapes, which are themselves FACS action units:
 * joy AU6+12, sadness AU1+4+15, anger AU4+5+7+23, surprise AU1+2+5+26,
 * disgust AU9+15+16, fear AU1+2+4+5+20+26. Speech is a run of visemes (the
 * Oculus/MPEG-4 set) mapped to ARKit mouth shapes, one per syllable.
 */
export type FaceWeights = Record<string, number>;

export type Emotion = 'neutral' | 'joy' | 'sadness' | 'anger' | 'surprise' | 'disgust' | 'fear';

const EMOTION: Record<Emotion, FaceWeights> = {
  neutral: {},
  joy: { cheekSquintLeft: 0.55, cheekSquintRight: 0.55, mouthSmileLeft: 0.75, mouthSmileRight: 0.75, eyeSquintLeft: 0.2, eyeSquintRight: 0.2 },
  sadness: { browInnerUp: 0.7, browDownLeft: 0.25, browDownRight: 0.25, mouthFrownLeft: 0.55, mouthFrownRight: 0.55, mouthShrugLower: 0.2 },
  anger: { browDownLeft: 0.85, browDownRight: 0.85, eyeSquintLeft: 0.35, eyeSquintRight: 0.35, eyeWideLeft: 0.15, eyeWideRight: 0.15,
    mouthPressLeft: 0.5, mouthPressRight: 0.5, noseSneerLeft: 0.2, noseSneerRight: 0.2 },
  surprise: { browInnerUp: 0.75, browOuterUpLeft: 0.75, browOuterUpRight: 0.75, eyeWideLeft: 0.6, eyeWideRight: 0.6, jawOpen: 0.3 },
  disgust: { noseSneerLeft: 0.65, noseSneerRight: 0.65, mouthUpperUpLeft: 0.4, mouthUpperUpRight: 0.4, mouthFrownLeft: 0.3, mouthFrownRight: 0.3,
    browDownLeft: 0.3, browDownRight: 0.3, mouthLowerDownLeft: 0.2, mouthLowerDownRight: 0.2 },
  fear: { browInnerUp: 0.65, browOuterUpLeft: 0.35, browOuterUpRight: 0.35, browDownLeft: 0.25, browDownRight: 0.25,
    eyeWideLeft: 0.55, eyeWideRight: 0.55, mouthStretchLeft: 0.45, mouthStretchRight: 0.45, jawOpen: 0.12 },
};

/** Visemes as ARKit mouths. */
const VISEMES: FaceWeights[] = [
  { jawOpen: 0.5 }, // aa
  { jawOpen: 0.22, mouthStretchLeft: 0.35, mouthStretchRight: 0.35 }, // E
  { jawOpen: 0.12, mouthSmileLeft: 0.22, mouthSmileRight: 0.22, mouthStretchLeft: 0.2, mouthStretchRight: 0.2 }, // I
  { jawOpen: 0.3, mouthFunnel: 0.55 }, // O
  { jawOpen: 0.08, mouthPucker: 0.7 }, // U
  { mouthClose: 0.5, mouthPressLeft: 0.35, mouthPressRight: 0.35 }, // PP
  { jawOpen: 0.06, mouthRollLower: 0.5, mouthUpperUpLeft: 0.2, mouthUpperUpRight: 0.2 }, // FF
  { jawOpen: 0.18 }, // DD / nn / kk
  { jawOpen: 0.07, mouthStretchLeft: 0.3, mouthStretchRight: 0.3 }, // SS
];
const SYLLABLES = 4.2; // per second, ordinary speech

/** What the person is doing, as the face shows it. */
const ACTIVITY: Record<string, { emotion: Emotion; amount: number; talk?: boolean; laugh?: boolean }> = {
  talk: { emotion: 'joy', amount: 0.25, talk: true },
  listen: { emotion: 'joy', amount: 0.15 },
  laugh: { emotion: 'joy', amount: 1, laugh: true },
  cheer: { emotion: 'joy', amount: 0.9, laugh: true },
  wave: { emotion: 'joy', amount: 0.6 },
  argue: { emotion: 'anger', amount: 0.8, talk: true },
  angry: { emotion: 'anger', amount: 0.9 },
  phone: { emotion: 'neutral', amount: 0, talk: true },
  dance: { emotion: 'joy', amount: 0.7 },
};

function add(out: FaceWeights, shape: FaceWeights, amount: number): void {
  if (amount <= 0) return;
  for (const name in shape) out[name] = (out[name] ?? 0) + shape[name]! * amount;
}

/** The face of person `seed` at `time` (s), doing `activity`, in a mood from -1 (low) to 1 (bright). */
export function faceAt(seed: number, time: number, activity?: string, mood = 0, emotion?: Emotion): FaceWeights {
  const hash = personHash(seed ^ 0x4c9e3721);
  const out: FaceWeights = {};
  // Blinks: one every 3-5 s, 150 ms closing and opening.
  const blinkPhase = (time * (0.22 + ((hash >>> 8) & 15) * 0.008) + (hash & 255) / 255) % 1;
  const blink = blinkPhase > 0.965 ? Math.sin((blinkPhase - 0.965) / 0.035 * Math.PI) : 0;
  // Gaze wanders, the eyeballs turning.
  const look = Math.sin(time * 0.55 + (hash >>> 5)) * 0.32;
  out.lookLeft = Math.max(0, look);
  out.lookRight = Math.max(0, -look);

  const act = activity ? ACTIVITY[activity] : undefined;
  // The resting face: the mood, a little.
  if (mood > 0) add(out, EMOTION.joy, mood * 0.3);
  else if (mood < 0) add(out, EMOTION.sadness, -mood * 0.35);
  if (emotion) add(out, EMOTION[emotion], 1);
  if (act) add(out, EMOTION[act.emotion], act.amount);

  if (act?.talk) {
    const beat = time * SYLLABLES + ((hash >>> 16) & 255) / 64;
    const syllable = Math.floor(beat);
    const open = Math.sin((beat - syllable) * Math.PI);
    add(out, VISEMES[personHash(hash ^ syllable) % VISEMES.length]!, open);
    // Stressed syllables lift the brows.
    if (personHash(hash ^ (syllable * 7)) % 5 === 0) add(out, { browInnerUp: 0.25, browOuterUpLeft: 0.2, browOuterUpRight: 0.2 }, open);
  }
  if (act?.laugh) {
    const shake = 0.5 + 0.5 * Math.sin(time * 9 + (hash & 63));
    add(out, { jawOpen: 0.35 }, shake);
  }
  out.eyeBlinkLeft = Math.min(1, Math.max(out.eyeBlinkLeft ?? 0, blink));
  out.eyeBlinkRight = Math.min(1, Math.max(out.eyeBlinkRight ?? 0, blink));
  return out;
}

/** Writes a face into a mesh's morph influences (names from its dictionary). */
export function applyFace(influences: number[], dictionary: Record<string, number>, face: FaceWeights): void {
  influences.fill(0);
  for (const name in face) {
    const index = dictionary[name];
    if (index !== undefined) influences[index] = Math.min(1, face[name]!);
  }
}
