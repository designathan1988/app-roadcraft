import characterLicense from '../../public/models/citizens/LICENSE-MICROSOFT.txt?raw';
import animationLicense from '../../public/models/citizens/LICENSE-ANIMATIONS.txt?raw';

/** Only the reviewed roster is bundled; legacy public assets are not copied. */
const files = import.meta.glob<string>([
  '../../public/models/citizens/*.glb',
  '!../../public/models/citizens/female_01.glb',
], {
  query: '?url', import: 'default', eager: true,
});
const sourceUrls: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(files).map(([filename, url]) => [filename.split('/').pop()!.replace(/\.glb$/, ''), url]),
);
/**
 * The official facial export keeps the same body, rig and texture atlas as
 * `female_01`, plus a compact Headbox expression set. The public identity is
 * deliberately still `female_01`: casting, saves and all ordinary model
 * consumers continue to address the same person.
 */
export const CITIZEN_ASSET_URLS: Readonly<Record<string, string>> = {
  ...sourceUrls,
  female_01: sourceUrls['female_01_facial']!,
};

/** License notices remain in the shipped bundle and in scene metadata. */
export const CITIZEN_LICENSES = { characters: characterLicense, animations: animationLicense };
