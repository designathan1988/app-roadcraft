import type { RoadType } from '@world/roadTypes';

/**
 * The colours that are NOT decided by a material.
 *
 * Two kinds of thing live here, and nothing else:
 *
 *  - **Editor feedback** drawn on the 2D overlay canvas — the selection tint,
 *    the hover tint, the colour of a draft the editor will refuse. These are
 *    interface, not scenery, so they are flat CSS colours rather than lit
 *    surfaces.
 *  - **Marking colours**, which belong to the road class rather than to the
 *    renderer: the same yellow centre line has to be produced by the mesh
 *    builder and by the minimap, so the value has one home.
 *
 * Everything that shades a real surface lives in `render/materials.ts`.
 */

/** The minimap's background, dark enough for the network to read over it. */
export const TERRAIN_SHADE = '#3d5537';

/** Editor feedback. */
export const SELECTION = '#a6ff6a';
export const HOVER = '#f4f7f4';
export const INVALID = '#ff6f63';

/** The class's own line colour — yellow for a centre line, white for lanes. */
export const markingColor = (rt: RoadType): string => rt.line;

/**
 * Edge lines.
 *
 * Two of them, because an edge line has to read against the asphalt on one side
 * and the kerb on the other; drawing one colour left it invisible against
 * whichever it happened to match.
 */
export const EDGE_LINE_LIGHT = '#8f9490';
export const EDGE_LINE_DARK = '#2b2f30';
