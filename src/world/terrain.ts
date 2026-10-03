import { clamp } from '@core/scalar';

export type TerrainMode = 'raise' | 'lower' | 'flatten' | 'river';

export interface TerrainStamp {
  readonly id: number;
  readonly x: number;
  readonly y: number;
  readonly radius: number;
  readonly strength: number;
  readonly mode: TerrainMode;
  /**
   * Height a `flatten` stamp levels towards. Absent means sea level, which is
   * what every stamp written before this field existed meant, so a saved map
   * loads unchanged.
   *
   * Levelling towards a TARGET is the difference between a tool that flattens
   * and a tool that levels. The old rule scaled the ground towards zero, so
   * "flatten" on a hillside pulled a plateau down to the datum instead of
   * making the ground under the cursor level with itself — which is what a
   * player levelling a site for a junction is actually asking for.
   */
  readonly level?: number;
}

/**
 * How many brush dabs one map may hold.
 *
 * It was 512, and a river painted across the map is several hundred on its own:
 * the oldest dabs were silently dropped off the front of the list and the start
 * of the player's own river disappeared while they were still drawing the end
 * of it. The spatial index makes the sampling cost depend on local density
 * rather than on this number, so the cap can be generous.
 */
export const MAX_TERRAIN_STAMPS = 4_096;
/**
 * The vertical extent of the land, in world units: how deep a pit and how high
 * a mountain the brush may ever make.
 *
 * They were -26 and +34 — ten metres down, fourteen up — which is a garden
 * terrace: a sustained stroke stopped moving the ground and the terrain simply
 * planed off into a plateau at the ceiling. A map wanted mountains, valleys and
 * cuttings, and none of them fit.
 *
 * The map is 4 800 units (1 920 m) across, so the range is set against it: a
 * 560-unit mountain is 224 m over a plate two kilometres wide — a real
 * landform — and a 360-unit pit is 144 m, deeper than anything a player is
 * likely to dig on purpose. Deliberately NOT symmetric, because a town sits on
 * the land at 0 and the interesting relief (ridges, hillsides, lookouts) is
 * almost all above it.
 *
 * These are absolute bounds of the height FIELD, not a brush strength: a dab
 * still moves the ground by its own `strength`, and only the accumulated
 * result is clamped.
 */
export const TERRAIN_MIN_HEIGHT = -360;
export const TERRAIN_MAX_HEIGHT = 560;
export const TERRAIN_WATER_HEIGHT = 0.12;
/** The extra factor a river stamp carves with, over a raise of the same strength. */
export const RIVER_CARVE = 1.45;

/**
 * How much a stamp of strength 1 bends the ground `unit` of the way out, where
 * `unit` runs from 1 at its centre to 0 at its edge (the smoothstep). Monotone,
 * so it can be inverted to find where a carve is a given depth — which is where
 * a shoreline sits.
 */
export const terrainInfluence = (unit: number): number => unit * unit * (3 - 2 * unit);

// --------------------------------------------------------------- base relief

/**
 * The land the map starts with, before the player touches it.
 *
 * A perfectly flat plane is the single biggest reason a 3D scene reads as a
 * drawing: with no relief there is nothing for the sun to shade, so the ground
 * is one flat colour from horizon to horizon whatever the lighting does.
 *
 * Four octaves of smooth, deterministic noise give the eye slopes to read. The
 * amplitudes were set by MEASURING the result rather than by taste: at a broad
 * wavelength alone the field's median slope came out at 2 degrees and its
 * steepest at 7, which changes how much sun a face takes by about a tenth —
 * under the eye's threshold for reading shape, and the reason the ground still
 * looked painted after the lighting was fixed. Shortening the wavelengths and
 * splitting the amplitude across four octaves brings the median to roughly 7
 * degrees and the steepest to around 20, which the sun models clearly, while
 * the largest landforms stay gentle enough for a road at grade to climb.
 *
 * Deterministic and analytic: no array, no seeding step, identical in the
 * renderer, the simulation and a headless test.
 */
const BASE_AMPLITUDE = 32;

function hash2(x: number, y: number): number {
  let h = Math.imul(x | 0, 374_761_393) ^ Math.imul(y | 0, 668_265_263);
  h = Math.imul(h ^ (h >>> 13), 1_274_126_177);
  return ((h ^ (h >>> 16)) >>> 0) / 2_147_483_648 - 1;
}

function valueNoise(x: number, y: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const a = hash2(x0, y0);
  const b = hash2(x0 + 1, y0);
  const c = hash2(x0, y0 + 1);
  const d = hash2(x0 + 1, y0 + 1);
  return (a * (1 - sx) + b * sx) * (1 - sy) + (c * (1 - sx) + d * sx) * sy;
}

/** The procedural land under every map, in world units. */
export function baseRelief(x: number, y: number): number {
  const broad = valueNoise(x / 620, y / 620);
  const middle = valueNoise(x / 210 + 13.7, y / 210 - 4.1);
  const fine = valueNoise(x / 88 - 7.3, y / 88 + 19.2);
  const grain = valueNoise(x / 48 + 31.5, y / 48 - 12.8);
  return BASE_AMPLITUDE * (broad * 0.42 + middle * 0.29 + fine * 0.2 + grain * 0.09);
}

// -------------------------------------------------------------- stamp lookup

/**
 * A uniform grid over the stamps, so a height query touches only nearby ones.
 *
 * `sampleTerrainHeight` runs once per terrain vertex on every terrain edit, and
 * again for every road profile station and every mesh vertex of every road. With
 * a linear scan and the stamp cap at 512 that was over fifty million distance
 * tests per brush stroke, which is precisely the stall felt while painting.
 */
export class TerrainIndex {
  private readonly cell: number;
  private readonly buckets = new Map<number, TerrainStamp[]>();
  readonly stamps: readonly TerrainStamp[];
  /** Incremented whenever the index is rebuilt, for cache invalidation. */
  readonly revision: number;

  constructor(stamps: readonly TerrainStamp[], revision: number) {
    // COPIED, not aliased. The document's stamp list is mutated in place, so
    // holding the live array made every index look identical to the next one and
    // the renderer could never tell what had just changed.
    this.stamps = stamps.slice();
    this.revision = revision;
    let widest = 64;
    for (const stamp of stamps) widest = Math.max(widest, stamp.radius);
    this.cell = widest;
    for (const stamp of stamps) {
      const x0 = Math.floor((stamp.x - stamp.radius) / this.cell);
      const x1 = Math.floor((stamp.x + stamp.radius) / this.cell);
      const y0 = Math.floor((stamp.y - stamp.radius) / this.cell);
      const y1 = Math.floor((stamp.y + stamp.radius) / this.cell);
      for (let x = x0; x <= x1; x++) {
        for (let y = y0; y <= y1; y++) {
          const key = x * 73_856_093 + y * 19_349_663;
          const bucket = this.buckets.get(key);
          if (bucket) bucket.push(stamp);
          else this.buckets.set(key, [stamp]);
        }
      }
    }
  }

  /**
   * The stamps that can affect a point, in authoring order.
   *
   * Order matters: `flatten` scales whatever the stamps before it produced, so
   * applying them out of order gives a different surface.
   */
  near(x: number, y: number): readonly TerrainStamp[] {
    const key = Math.floor(x / this.cell) * 73_856_093 + Math.floor(y / this.cell) * 19_349_663;
    return this.buckets.get(key) ?? EMPTY;
  }
}

const EMPTY: readonly TerrainStamp[] = [];

/**
 * The height of the land at a point: base relief plus every stamp over it.
 *
 * Pass a `TerrainIndex` whenever the same stamp list is sampled more than a
 * handful of times; the plain array overload is kept for one-off queries and
 * for tests.
 */
export function sampleTerrainHeight(
  stamps: readonly TerrainStamp[] | TerrainIndex,
  x: number,
  y: number,
): number {
  const list = stamps instanceof TerrainIndex ? stamps.near(x, y) : stamps;
  let height = baseRelief(x, y);
  for (const stamp of list) {
    const dx = x - stamp.x;
    const dy = y - stamp.y;
    const distanceSquared = dx * dx + dy * dy;
    if (distanceSquared >= stamp.radius * stamp.radius) continue;
    const influence = terrainInfluence(1 - Math.sqrt(distanceSquared) / stamp.radius);
    if (stamp.mode === 'raise') height += stamp.strength * influence;
    else if (stamp.mode === 'lower') height -= stamp.strength * influence;
    else if (stamp.mode === 'river') height -= stamp.strength * RIVER_CARVE * influence;
    else {
      // Level towards the stamp's own target. With `level` absent this is
      // `height * (1 - k)` — algebraically the rule it replaced, so old maps
      // are bit-for-bit unaffected.
      const target = stamp.level ?? 0;
      height += (target - height) * Math.min(1, stamp.strength / 10) * influence;
    }
  }
  return clamp(height, TERRAIN_MIN_HEIGHT, TERRAIN_MAX_HEIGHT);
}

export const isTerrainMode = (value: unknown): value is TerrainMode =>
  value === 'raise' || value === 'lower' || value === 'flatten' || value === 'river';
