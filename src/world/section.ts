import { m } from './units';
import { CURB_BAND, laneOffset, laneWidth, travelLanes, type RoadType } from './roadTypes';
import type { SegmentDirection } from './doc';
import { carriesPedestrians } from './pedestrianAccess';

/**
 * THE CROSS-SECTION OF A ROAD: what lies where across it, from the centreline
 * out, as named bands. The one description every consumer reads.
 *
 * It used to exist only implicitly. The carriageway, kerb and footway were
 * drawn as rings of decreasing half-width (`roadTypes.halfWidth`), unioned
 * per surface level and subtracted one from another (`surfaces.bands`); the
 * footway was what was LEFT OVER. Every pedestrian model then had to
 * reconstruct a walking path from that leftover - the sidewalk graph by
 * sampling its corners (centimetre reversals), the navigation mesh by eroding
 * it (an 11 cm sliver strip of kerb stone along every footway) - and both
 * walked erratically for it (study of 2026-10-01).
 *
 * Here the footway is an object with zones, as street design guides describe
 * a sidewalk (NACTO Urban Street Design Guide, "Sidewalks": frontage zone,
 * pedestrian through zone, street furniture/curb zone): the kerb stone at the
 * carriageway edge, a furnishing zone beside it where lamp columns, street
 * trees, benches and bins stand, the through zone people walk in, and a
 * frontage zone along the outer edge where the footway is wide enough to have
 * one. Vehicle lanes are bands of the
 * same section (OpenDRIVE lanes, Cities: Skylines lanes).
 *
 * Offsets are distances from the road centreline, world units, measured
 * outward on either side; the section is symmetric today (`RoadType` has one
 * footway width for both sides), so one `SideZones` describes both.
 */

/** A band across one side of the road: from `inner` to `outer`, measured from the centreline. */
export interface Band {
  readonly inner: number;
  readonly outer: number;
}

/** One side of the road beyond the carriageway edge. */
export interface SideZones {
  /** The kerb stone. */
  readonly curb: Band;
  /** Beside the kerb: lamp columns, street trees, benches, bins. */
  readonly furnishing: Band;
  /** Where people walk. */
  readonly through: Band;
  /** Along the outer edge, on a footway wide enough for one; zero width otherwise. */
  readonly frontage: Band;
}

export interface TravelLane {
  /** Signed offset of the lane's centreline (negative: right of the forward direction). */
  readonly offset: number;
  readonly width: number;
  /** Lane index within its direction, 0 innermost. */
  readonly index: number;
}

export interface CrossSection {
  /** Half the carriageway, kerb face to kerb face. */
  readonly carriageway: number;
  readonly median: number;
  /** Lanes of the forward (a to b) direction; a two-way road mirrors them for the other. */
  readonly lanes: readonly TravelLane[];
  /** Both sides (the section is symmetric). Null for a road without a footway to walk. */
  readonly side: SideZones;
  /** Whether people walk along this road at all. */
  readonly walkable: boolean;
}

/** Tree pit side and its setback from the kerb face; the street-furniture layout uses the same numbers. */
export const TREE_PIT = m(0.8);
export const TREE_KERB_SETBACK = m(0.15);
/** A footway at least this wide (`RoadType.sidewalk`, kerb included) has street trees. */
export const TREE_MIN_FOOTWAY = 6;
/** Depth a lamp column (and a hydrant) takes beside the kerb. */
export const LAMP_ZONE = m(0.35);
/** Depth a bench (0.52 m seat) or a bin (0.66 m across) takes beside the kerb. */
export const BENCH_ZONE = m(0.7);
/** Narrowest through zone a footway keeps, whatever else it holds. */
export const MIN_THROUGH = m(0.9);
/** Through zone a footway is given before any of it goes to a frontage zone (NACTO: 1.5-2.5 m). */
export const THROUGH_GOAL = m(1.5);
/** A frontage zone narrower than this is no use to anything: it is given to the through zone. */
export const MIN_FRONTAGE = m(0.6);

/** The cross-section of a resolved road profile (`roadProfile`). */
export function sectionOf(rt: RoadType, direction: SegmentDirection = 'both'): CrossSection {
  const half = rt.width / 2;
  const edge = half + rt.sidewalk;
  const curb: Band = { inner: half, outer: half + CURB_BAND };
  const footway = Math.max(0, edge - curb.outer);
  // Highways and ramps have a verge, not a footway (`pedestrianAccess.ts`).
  const walkable = carriesPedestrians(rt);
  // Street furniture stands in ONE zone beside the kerb, as on a real street:
  // lamp columns always, street trees where the footway is wide enough for
  // them, benches and bins where they still leave the through zone its
  // minimum. Lamps, bins and benches used to stand along the OUTER edge, the
  // bins and benches set a further 0.9-1.1 m out - beyond the footway, inside
  // the buildings (audit P1-16).
  const trees = rt.sidewalk >= TREE_MIN_FOOTWAY ? TREE_KERB_SETBACK + TREE_PIT : 0;
  const seats = footway - BENCH_ZONE >= MIN_THROUGH ? BENCH_ZONE : 0;
  const furnishingDepth = walkable ? Math.min(Math.max(LAMP_ZONE, trees, seats), Math.max(0, footway - MIN_THROUGH)) : 0;
  const furnishing: Band = { inner: curb.outer, outer: curb.outer + furnishingDepth };
  // A frontage zone along the outer edge only where the through zone already
  // has its full width and enough is left over to use.
  const spare = footway - furnishingDepth - THROUGH_GOAL;
  const frontage = spare >= MIN_FRONTAGE ? spare : 0;
  const through: Band = { inner: furnishing.outer, outer: edge - frontage };
  const count = travelLanes(rt, direction);
  const lanes: TravelLane[] = [];
  for (let i = 0; i < count; i++) lanes.push({ offset: laneOffset(rt, i, direction), width: laneWidth(rt), index: i });
  return {
    carriageway: half,
    median: rt.median,
    lanes,
    side: { curb, furnishing, through, frontage: { inner: edge - frontage, outer: edge } },
    walkable,
  };
}

/** Centre of a band, and its width. */
export const bandMid = (b: Band): number => (b.inner + b.outer) / 2;
export const bandWidth = (b: Band): number => b.outer - b.inner;
