import { kmh } from './units';
import type { SegmentDirection } from './doc';

/**
 * Surface levels, in painting order.
 *
 * The whole point of naming them is that a junction computes a *separate*
 * polygon, with a *separate* trim distance, for each one. The V6 monolith
 * filled seven layers that all stopped at the same distance along every leg,
 * which is why no kerb or footway existed around any junction (defect 1.2).
 */
export enum Level {
  Shadow = 0,
  Casing = 1,
  Sidewalk = 2,
  Curb = 3,
  Asphalt = 4,
  Markings = 5,
  JunctionInterior = 6,
  JunctionDetail = 7,
  Median = 8,
  Overlay = 9,
}

/** Levels that carry a filled surface built from roads and junctions alike. */
export const SURFACE_LEVELS = [
  Level.Casing,
  Level.Sidewalk,
  Level.Curb,
  Level.Asphalt,
] as const;

export type SurfaceLevel = (typeof SURFACE_LEVELS)[number];

export type MarkingStyle = 'none' | 'center' | 'lanes';

export interface RoadType {
  readonly id: string;
  /** Translation key for the class name, resolved by `ui/i18n`. */
  readonly nameKey: string;
  /** Translation key for the one-line description under the name. */
  readonly subKey: string;
  /**
   * Lane count to substitute into `subKey` when the class has been overridden.
   *
   * Null for a stock class, whose description needs no numbers. The model does
   * not format text — it states what the text is about and lets the interface
   * layer render it in whatever language is showing.
   */
  readonly subLanes: number | null;
  /** Whether an overridden description is for a one-way road. */
  readonly subOneWay: boolean;
  /** Carriageway width, kerb to kerb, in world units. */
  readonly width: number;
  /** Total lane count, both directions. */
  readonly lanes: number;
  /** Footway width on each side, in world units. */
  readonly sidewalk: number;
  /** Central reservation width, in world units. Zero when absent. */
  readonly median: number;
  /** Free-flow speed, in world units per second. */
  readonly speedLimit: number;
  /** Higher wins right of way at unsignalised junctions. */
  readonly priorityRank: number;
  readonly markings: MarkingStyle;
  readonly color: string;
  readonly edge: string;
  readonly curb: string;
  readonly line: string;
}

/**
 * The colour of a painted line.
 *
 * These lived in `ui/overlay/palette.ts`, and that made `world` import `ui` -
 * the one import cycle in the project, and a violation of the layer order in
 * AGENTS.md section 2. A line's colour is a property of the ROAD CLASS, not of
 * the interface: the same yellow centre line has to be produced by the mesh
 * builder, by the minimap and by the overlay, and three consumers in three
 * layers mean the value belongs beside the class it describes.
 */
export const markingColor = (rt: RoadType): string => rt.line;

/**
 * The line between two lanes running the SAME way: always white.
 *
 * `line` is the class's centre-line colour, and for the two street classes it
 * is yellow - the colour that tells a driver the traffic beyond it comes the
 * other way. Every divider used to be painted in it, so a one-way street was
 * marked down its middle exactly like a two-way one, and read as one.
 */
export const LANE_LINE = '#eee8d7';


/** Extra half-width of the kerb band beyond the asphalt edge. */
const CURB_BAND = 0.9;

/**
 * Height of the footway above the carriageway, world units.
 *
 * ONE number for the cross-section: the renderer lifts the footway band by it
 * and stands lamps, poles and pedestrians on it, and the elevation solver
 * counts it into a raised deck's depth. It used to be two constants of the
 * same value, `FOOTWAY_RISE` in render/roadSurfaces.ts and `FOOTWAY_DEPTH` in
 * world/elevation.ts, free to drift apart.
 */
export const FOOTWAY_RISE = 0.36;
/** Extra half-width of the casing beyond the footway edge. */
const CASING_BAND = 1.5;

export const ROAD_TYPES: readonly RoadType[] = [
  {
    id: 'local',
    nameKey: 'road.local',
    subKey: 'road.sub.local',
    subLanes: null,
    subOneWay: false,
    width: 15,
    lanes: 2,
    sidewalk: 4.5,
    median: 0,
    speedLimit: kmh(30),
    priorityRank: 0,
    markings: 'none',
    color: '#5f6365',
    edge: '#aaa9a5',
    curb: '#d5d2cb',
    line: '#e1c45a',
  },
  {
    id: 'urban',
    nameKey: 'road.urban',
    subKey: 'road.sub.urban',
    subLanes: null,
    subOneWay: false,
    width: 22,
    lanes: 2,
    sidewalk: 5,
    median: 0,
    speedLimit: kmh(50),
    priorityRank: 1,
    markings: 'center',
    color: '#3a3d3f',
    edge: '#aaa7a2',
    curb: '#d2cec7',
    line: '#e1c45a',
  },
  {
    id: 'avenue',
    nameKey: 'road.avenue',
    subKey: 'road.sub.avenue',
    subLanes: null,
    subOneWay: false,
    width: 34,
    lanes: 4,
    sidewalk: 6,
    median: 0,
    speedLimit: kmh(60),
    priorityRank: 2,
    markings: 'lanes',
    color: '#35383a',
    edge: '#aaa7a1',
    curb: '#d3cfc7',
    line: '#eee8d7',
  },
  {
    id: 'boulevard',
    nameKey: 'road.boulevard',
    subKey: 'road.sub.boulevard',
    subLanes: null,
    subOneWay: false,
    width: 46,
    lanes: 4,
    sidewalk: 7,
    median: 6,
    speedLimit: kmh(60),
    priorityRank: 3,
    markings: 'lanes',
    color: '#333638',
    edge: '#aaa69f',
    curb: '#d4cfc7',
    line: '#eee8d8',
  },
];

export const roadType = (i: number): RoadType =>
  ROAD_TYPES[Math.max(0, Math.min(ROAD_TYPES.length - 1, i))] as RoadType;

/** Supported physical lane-count range for an individually configured road. */
export const MIN_TRAVEL_LANES = 1;
export const MAX_TRAVEL_LANES = 8;

/**
 * Resolves the physical road profile for a segment.
 *
 * A configured count is the total number of drivable lanes.  Two-way roads
 * therefore split it across directions, while one-way roads use all of it.
 * Older documents omit the count and retain their exact class profile.
 */
export function roadProfile(
  typeIndex: number,
  configuredLanes?: number | null,
  direction: SegmentDirection = 'both',
): RoadType {
  const base = roadType(typeIndex);
  if ((configuredLanes === undefined || configuredLanes === null) && direction === 'both') return base;
  const lanes = configuredLanes === undefined || configuredLanes === null
    ? base.lanes
    : Math.max(MIN_TRAVEL_LANES, Math.min(MAX_TRAVEL_LANES, Math.round(configuredLanes)));
  const median = direction === 'both' && lanes >= 2 ? base.median : 0;
  if (lanes === base.lanes && median === base.median) return base;
  const width = median + laneWidth(base) * lanes;
  return {
    ...base,
    width,
    lanes,
    median,
    markings: lanes <= 1 ? 'none' : lanes === 2 ? 'center' : 'lanes',
    subKey: lanes === 1 ? 'road.sub.custom.one' : 'road.sub.custom.other',
    subLanes: lanes,
    subOneWay: direction !== 'both',
  };
}

/**
 * Half-width of a road type at a given surface level.
 *
 * These are the `hw[level][leg]` values that drive the whole junction builder.
 * They are strictly decreasing from Casing to Asphalt, which is what guarantees
 * the level rings nest (see the containment assertion in the junction tests).
 */
export function halfWidth(rt: RoadType, level: SurfaceLevel): number {
  switch (level) {
    case Level.Asphalt:
      return rt.width / 2;
    case Level.Curb:
      return rt.width / 2 + CURB_BAND;
    case Level.Sidewalk:
      return rt.width / 2 + rt.sidewalk;
    case Level.Casing:
      return rt.width / 2 + rt.sidewalk + CASING_BAND;
  }
}

export const sidewalkHalf = (rt: RoadType): number => rt.width / 2 + rt.sidewalk;
export const casingHalf = (rt: RoadType): number =>
  rt.width / 2 + rt.sidewalk + CASING_BAND;

export const lanesPerDirection = (rt: RoadType): number =>
  Math.max(1, Math.floor(rt.lanes / 2));

/** Number of lanes a vehicle may use in one travelling direction. */
export const travelLanes = (rt: RoadType, direction: SegmentDirection): number =>
  direction === 'both' ? lanesPerDirection(rt) : rt.lanes;

export const laneWidth = (rt: RoadType): number =>
  (rt.width - rt.median) / rt.lanes;

/**
 * Signed lateral offset of a lane's centreline from the road centreline.
 * For two-way roads lane 0 is the innermost (nearest the centre); higher
 * indices move outward. One-way lanes are centred as a complete carriageway.
 */
export function laneOffset(rt: RoadType, lane: number, direction: SegmentDirection = 'both'): number {
  const count = travelLanes(rt, direction);
  const idx = Math.max(0, Math.min(count - 1, lane));
  // A one-way carriageway is centred on its road centreline instead of being
  // pushed onto the right-hand half reserved by two-way traffic. `perp` is the
  // LEFT normal in this coordinate system, so right-hand traffic is negative.
  if (direction !== 'both') return -laneWidth(rt) * (idx - (count - 1) / 2);
  return -(rt.median / 2 + laneWidth(rt) * (idx + 0.5));
}
