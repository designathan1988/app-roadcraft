import { clamp } from '@core/scalar';
import type { Vec2 } from '@core/vec2';

/**
 * How big the world is.
 *
 * The ground is a finite plate, and this is its size. It lived in
 * `render/terrain.ts`, which made it a fact about the PICTURE — so everything
 * that authored a position (a node, a pole) had no way to know where the world
 * ended, because `world` may not import `render`. The consequence was visible:
 * roads, poles and the street furniture hanging off them could be built past
 * the edge of the map, standing on nothing.
 *
 * It belongs here, where the document can see it.
 */
export const MAP_SIZE = 4_800;
export const MAP_HALF = MAP_SIZE / 2;

/**
 * How far inside the edge anything the player builds is kept.
 *
 * Not zero, because a road is WIDE: a centreline exactly on the rim puts half
 * a carriageway, its footway and its casing out over the void. The widest road
 * in the game is under 30 units of casing half-width, and a junction between
 * two of them reaches further still, so this is that with room to spare.
 */
export const MAP_MARGIN = 64;

/** Whether a point is on the plate at all. */
export const insideMap = (p: Vec2, margin = 0): boolean =>
  p.x >= -MAP_HALF + margin &&
  p.x <= MAP_HALF - margin &&
  p.y >= -MAP_HALF + margin &&
  p.y <= MAP_HALF - margin;

/**
 * The nearest point on the plate to `p`.
 *
 * Clamping rather than refusing, and deliberately: a drag that runs off the
 * edge should build a road up to the edge, which is what the player was
 * plainly asking for. Refusing it would make the last stretch of a drag do
 * nothing, with no explanation.
 */
export const clampToMap = (p: Vec2, margin = MAP_MARGIN): Vec2 => ({
  x: clamp(p.x, -MAP_HALF + margin, MAP_HALF - margin),
  y: clamp(p.y, -MAP_HALF + margin, MAP_HALF - margin),
});
