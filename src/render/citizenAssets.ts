import characterLicense from '../../public/models/citizens/LICENSE-MICROSOFT.txt?raw';
import animationLicense from '../../public/models/citizens/LICENSE-ANIMATIONS.txt?raw';

/** Only the reviewed roster is bundled; legacy public assets are not copied. */
const files = import.meta.glob<string>('../../public/models/citizens/*.glb', {
  query: '?url', import: 'default', eager: true,
});
export const CITIZEN_ASSET_URLS: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(files).map(([filename, url]) => [filename.split('/').pop()!.replace(/\.glb$/, ''), url]),
);

/** License notices remain in the shipped bundle and in scene metadata. */
export const CITIZEN_LICENSES = { characters: characterLicense, animations: animationLicense };
