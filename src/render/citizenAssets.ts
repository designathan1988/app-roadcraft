import characterLicense from '../../public/models/citizens/LICENSE-MICROSOFT.txt?raw';
import animationLicense from '../../public/models/citizens/LICENSE-ANIMATIONS.txt?raw';

/**
 * The Rocketbox models are gone: the street's people are MakeHuman bodies
 * (`people/roster.ts`, rigged by `render/people/personRig.ts`). What remains
 * of Rocketbox is its motion captures (`motion/`, MIT), and this notice.
 * No model is loaded from a file any more.
 */
export const CITIZEN_ASSET_URLS: Readonly<Record<string, string>> = {};

/** License notices remain in the shipped bundle and in scene metadata. */
export const CITIZEN_LICENSES = { characters: characterLicense, animations: animationLicense };
