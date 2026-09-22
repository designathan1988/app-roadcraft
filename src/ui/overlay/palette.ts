/**
 * EDITOR FEEDBACK, and nothing else.
 *
 * The selection tint, the hover tint, the colour of a draft the editor will
 * refuse. These are interface, not scenery, so they are flat CSS colours
 * rather than lit surfaces.
 *
 * The marking colours used to live here too, and that made `world` import
 * `ui` — the one cycle in the project. They are a property of the road class,
 * so they are in `world/roadTypes.ts` now. Everything that shades a real
 * surface is in `render/materials.ts`.
 */

/** The minimap's background, dark enough for the network to read over it. */
export const TERRAIN_SHADE = '#3d5537';

/** Editor feedback. */
export const SELECTION = '#a6ff6a';
export const HOVER = '#f4f7f4';
export const INVALID = '#ff6f63';

