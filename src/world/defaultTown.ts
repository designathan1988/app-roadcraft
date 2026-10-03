import type { Vec2 } from '@core/vec2';
import { Rng } from '@core/rng';
import type { RoadDoc } from './doc';
import type { NodeId } from './ids';
import type { RoadStructure } from './structures';
import { ROAD_TYPES } from './roadTypes';
import type { TerrainMode, TerrainStamp } from './terrain';

/**
 * THE TOWN THE GAME OPENS ON.
 *
 * A small town, planned rather than scattered: one avenue as its spine, the
 * shops and the square on that spine, neighbourhoods of houses and terraces
 * behind them, a school and a park between the two, and the works - the
 * factory, the yards, the warehouses - on the flat ground by the water at the
 * edge, where industry belongs. Hills to the west and north, a ridge behind
 * the town, a stream along the east: the land the town was built in, not a
 * plate the town was poured onto.
 *
 * ## How it is planned (in the order a town is really planned)
 *
 * 1. `layLandform` - the ground first: the shelf the town stands on, the
 *    hills and the ridge that frame it, the stream and its valley.
 * 2. `layStreets` - the avenue east to west, the cross streets that make
 *    blocks, the road out to the works, the bridge over the stream.
 * 3. `occupy` - what stands on each block: the shops on the avenue, the
 *    square, the houses of the residential blocks, the school, the park, the
 *    works.
 * 4. `dress` - the boundaries (hedges, fences, walls), the poles and wires.
 *
 * Streets and blocks come BEFORE anything is placed on them, which is why
 * the grid is a table of node lines rather than a list of buildings: a block
 * is the rectangle between four lines, and what goes on it is decided from
 * its own size, frontage by frontage, the way `town.ts` does it.
 *
 * Everything here is deterministic (one seeded stream), so the same town
 * opens every time.
 */

// ---------------------------------------------------------------- the plan

/**
 * Node lines of the street grid, world units (0.4 m each: 300 units is a 120 m
 * block, which is a town block; 210 units is 84 m of depth, two rows of plots
 * back to back).
 *
 * The avenue is `y = 0`. The streets either side are at ±210 units - the first
 * row of blocks each way - and the outer pair at ±420 units.
 */
const XS = [-1200, -900, -600, -300, 0, 300, 600] as const;
const YS = [-420, -210, 0, 210, 420] as const;
/** The avenue's own line, and where it runs out at each end. */
const AVENUE = 0;
const WEST_END = -1560;
const EAST_END = 900;
/** The works: their own lines, east of the last street of the grid. */
const WORKS = { west: 900, east: 1440, south: -420, north: 210 } as const;
/** The stream, running north-south along the east of the town. */
const STREAM_X = 1960;

const LOCAL = ROAD_TYPES.findIndex((t) => t.id === 'local');
const URBAN = ROAD_TYPES.findIndex((t) => t.id === 'urban');
const AVENUE_CLASS = ROAD_TYPES.findIndex((t) => t.id === 'avenue');

/** The ground the town stands on, before the hills: world units above datum. */
const TOWN_LEVEL = 14;

// ---------------------------------------------------------------- landform

const stamp = (
  x: number, y: number, radius: number, strength: number, mode: TerrainMode, level?: number,
): Omit<TerrainStamp, 'id'> =>
  ({ x, y, radius, strength, mode, ...(level === undefined ? {} : { level }) });

/**
 * A mass of high ground along a line, the way a hill is really shaped.
 *
 * A dab on its own raises the ground by its strength and no more, and its
 * smoothstep falloff means a row of them adds up to something much less than
 * their sum. So a landform is written as a PROFILE: stations along a path,
 * each with its own strength (a bell along the line: low shoulders, a high
 * crest), stamped in two passes so the shoulders fill in under the crest.
 * One dab would be a cone; this is a hill.
 */
function ridge(
  doc: RoadDoc,
  from: Vec2,
  to: Vec2,
  radius: number,
  peak: number,
  stations = 7,
  passes = 2,
): void {
  const length = Math.hypot(to.x - from.x, to.y - from.y);
  // What one dab must add for the line to add up to `peak`: a dab reaches
  // `radius` either way, so the line's own overlap is `2 * radius / spacing`
  // dabs deep. Without this the crest came out an order of magnitude over the
  // number asked for - a 300-unit hill arrived at the clamp, 560.
  const spacing = Math.max(1, length / Math.max(1, stations - 1));
  const each = (peak * spacing) / (2 * radius) / passes;
  for (let pass = 0; pass < passes; pass++) {
    for (let i = 0; i < stations; i++) {
      const t = stations === 1 ? 0.5 : i / (stations - 1);
      // A bell across the line, so the ends are shoulders and not cliffs.
      const bell = 0.5 + 0.5 * Math.sin(Math.PI * t);
      doc.addTerrainStamp(stamp(
        from.x + (to.x - from.x) * t,
        from.y + (to.y - from.y) * t,
        radius, each * bell, 'raise',
      ));
    }
  }
}

/**
 * The land the town was built in.
 *
 * The numbers are world units (0.4 m). The town's own ground falls about four
 * per cent from the west end of the avenue to the works - 3 m over 90 m - which
 * is enough for the streets to have been built onto the land and gentle enough
 * that nothing has to be terraced. Around it: a 70 m hill closing the western
 * view, a 110 m ridge behind the town, and 150-200 m mountains on the far side
 * of the map, so the horizon is landscape rather than a lawn.
 */
function layLandform(doc: RoadDoc): void {
  // The town's own ground: high in the west, falling east towards the works
  // and the water. Written as wide, shallow masses rather than a flatten,
  // because a town on a slope reads as built; a town on a plane reads as a
  // diagram. About four per cent across the town - a street you can see is
  // going somewhere.
  doc.addTerrainStamp(stamp(-1_500, -100, 1_400, 34, 'raise'));
  doc.addTerrainStamp(stamp(-2_000, -400, 1_000, 22, 'raise'));
  doc.addTerrainStamp(stamp(900, -60, 1_200, 26, 'lower'));
  doc.addTerrainStamp(stamp(1_900, 40, 900, 20, 'lower'));

  // And the relief INSIDE the town, which is what a town on real ground has
  // and a poured slab does not: a knoll the church stands on, a rise the
  // northern terraces step up, a slope the southern houses sit below. The
  // streets round them are cut and filled as they cross, exactly as a street
  // is; the blocks on them are graded under each building. Kept to 20-30
  // units (8-12 m): a town's own ground, not a mountain range in a grid.
  doc.addTerrainStamp(stamp(-430, -470, 260, 28, 'raise'));
  doc.addTerrainStamp(stamp(-1_020, 300, 250, 26, 'raise'));
  doc.addTerrainStamp(stamp(760, 320, 230, 24, 'raise'));
  doc.addTerrainStamp(stamp(180, -330, 220, 18, 'raise'));
  doc.addTerrainStamp(stamp(-1_150, -720, 300, 24, 'raise'));
  doc.addTerrainStamp(stamp(430, 560, 300, 20, 'lower'));

  // The hill that closes the avenue's western view, and the rise behind the
  // town's last street of houses. The RADIUS is what a landform is read by: a
  // 250-unit hill spread over a 900-unit base is a two-degree slope, which is
  // invisible from this camera however tall it is. At 380-420 its flanks are
  // thirty degrees - a hill, with a shadow side and a silhouette.
  ridge(doc, { x: -1_950, y: -350 }, { x: -1_520, y: -950 }, 400, 260, 5, 2);
  ridge(doc, { x: -2_100, y: 250 }, { x: -1_300, y: 250 }, 400, 200, 3, 2);
  // The hill the avenue runs towards: its western end is against this, which
  // is what closes the town's longest view.
  doc.addTerrainStamp(stamp(-2_450, 60, 560, 40, 'raise'));
  doc.addTerrainStamp(stamp(-2_150, -260, 380, 30, 'raise'));

  // The ridge behind the town, close enough to be the town's backdrop and
  // far enough that the northern street is not on it: the rise starts just
  // past the last row of houses.
  ridge(doc, { x: -2_100, y: 980 }, { x: 1_900, y: 900 }, 420, 250, 12, 2);

  // The south side: a hillside the southern houses step down, rising to the
  // mountains at the map's far edge.
  ridge(doc, { x: -1_900, y: -1_180 }, { x: 900, y: -1_400 }, 420, 210, 11, 2);

  // The stream's valley, along the east: shallow and wide, so the water is the
  // bottom of the view and not a wall in it.
  for (let i = 0; i < 9; i++) {
    doc.addTerrainStamp(stamp(STREAM_X + 60, -1_800 + i * 460, 420, 12, 'lower'));
  }
  // The channel itself, with the water in it.
  //
  // Dabbed at a fifth of its own width - the spacing the brush itself uses on
  // a dragged stroke - so the channel is one body of water. At a dab every 250
  // units the discs did not merge into a river at all: they read as a string
  // of round ponds, which is exactly what the union of distant discs is.
  const streamAt = (t: number): Vec2 => ({
    x: STREAM_X + Math.sin(t * Math.PI * 2.4) * 95 + Math.sin(t * 7.1) * 22,
    y: 1_420 - t * 2_620,
  });
  // A 26-unit (10 m) channel with a 64-unit brush: the water is twice the
  // brush's own width, which is a stream forty metres bank to bank. At the
  // radius a hole was dug with, the "stream" came out 160 m across.
  const CHANNEL_STEP = 26;
  for (let d = 0; d * CHANNEL_STEP < 2_620; d++) {
    const t = (d * CHANNEL_STEP) / 2_620;
    const at = streamAt(t);
    doc.addTerrainStamp(stamp(at.x, at.y, 64, 9, 'river'));
  }
  // The mill pond at the foot of the stream: wider, shallower, and the reason
  // the works are where they are.
  for (let i = 0; i < 6; i++) {
    doc.addTerrainStamp(stamp(1_850 + (i % 3) * 55, -1_250 - Math.floor(i / 3) * 60, 110, 6, 'river'));
  }
  // The works' flat, on the low ground between the town and the water.
  for (let i = 0; i < 2; i++) doc.addTerrainStamp(stamp(1_150, -100, 560, 6, 'flatten', TOWN_LEVEL - 16));

  // The far east, past the stream: the bank rises again, so the town has a
  // horizon on that side too.
  ridge(doc, { x: 2_250, y: 1_600 }, { x: 2_150, y: -1_700 }, 380, 150, 7, 2);

  // Mountains proper, on the map's far side: the horizon is landscape.
  ridge(doc, { x: -2_050, y: 1_950 }, { x: 1_600, y: 1_900 }, 500, 520, 11, 2);
  ridge(doc, { x: -1_950, y: -1_950 }, { x: 300, y: -2_000 }, 500, 470, 8, 2);
  ridge(doc, { x: 1_300, y: -2_050 }, { x: 2_150, y: -1_150 }, 440, 340, 5, 2);
}

// ---------------------------------------------------------------- streets

/** Nodes by coordinate, so a street run can name its ends. */
class Nodes {
  private readonly byKey = new Map<string, NodeId>();
  constructor(private readonly doc: RoadDoc) {}
  at(x: number, y: number): NodeId {
    const key = `${Math.round(x)},${Math.round(y)}`;
    const found = this.byKey.get(key);
    if (found !== undefined) return found;
    const id = this.doc.addNode({ x, y }).id;
    this.byKey.set(key, id);
    return id;
  }
  /** A road from one point to another, through `bends` if it has any. */
  run(a: Vec2, b: Vec2, type: number, bends: readonly Vec2[] = [], structure: RoadStructure = 'ground'): void {
    const points = [a, ...bends, b];
    for (let i = 0; i + 1 < points.length; i++) {
      const from = points[i] as Vec2;
      const to = points[i + 1] as Vec2;
      this.doc.addSegment(this.at(from.x, from.y), this.at(to.x, to.y), type, null, 0, 'both', null, structure);
    }
  }
}

/**
 * The streets.
 *
 * Every street is cut at every line it crosses, so the junction builder gets
 * plain four-way crossings and the blocks between them are the rectangles the
 * plan says they are. The avenue is the exception only in its class: it is
 * laid the same way, and the only bends in the whole grid are where the roads
 * out of town leave it.
 */
function layStreets(doc: RoadDoc): Nodes {
  const nodes = new Nodes(doc);
  const point = (x: number, y: number): Vec2 => ({ x, y });

  // The avenue, west to east: in from the hill, through the town, out to the
  // works. Its western end carries on off the map - the road IN, which is how
  // a town of this size has always been entered - over the saddle between the
  // hill and the ridge.
  nodes.run(point(-2_200, AVENUE + 130), point(XS[0] as number, AVENUE), AVENUE_CLASS, [
    point(-1_800, AVENUE + 70),
    point(WEST_END, AVENUE + 34),
    point(-1_360, AVENUE + 14),
  ]);
  for (let i = 0; i + 1 < XS.length; i++) {
    nodes.run(point(XS[i] as number, AVENUE), point(XS[i + 1] as number, AVENUE), AVENUE_CLASS);
  }
  nodes.run(point(XS[6] as number, AVENUE), point(EAST_END, AVENUE), URBAN);

  // The cross streets, north-south: one segment per band between the avenue's
  // neighbours, so each crossing is a node of its own.
  for (const x of XS) {
    for (let j = 0; j + 1 < YS.length; j++) {
      nodes.run(point(x, YS[j] as number), point(x, YS[j + 1] as number), LOCAL);
    }
  }

  // The cross streets, east-west: the town's own grid runs from -1200 to 600;
  // the two southern ones carry on east to the works' road, and the northern
  // pair stop at the last street of the grid, where the town gives way to the
  // hillside.
  for (const y of [YS[1] as number, YS[3] as number]) {
    for (let i = 0; i + 1 < XS.length; i++) {
      nodes.run(point(XS[i] as number, y), point(XS[i + 1] as number, y), LOCAL);
    }
  }
  for (const y of [YS[0] as number, YS[4] as number]) {
    for (let i = 0; i + 1 < XS.length; i++) {
      nodes.run(point(XS[i] as number, y), point(XS[i + 1] as number, y), LOCAL);
    }
    nodes.run(point(XS[6] as number, y), point(WORKS.west, y), LOCAL);
  }

  // The works: a service road down the district's western edge, one along its
  // northern side, one along the water, and the cross road at its far end. The
  // district is a rectangle of roads with the yards between them, not a
  // scatter of driveways - and the western one crosses the avenue, so the
  // works are reached from the town's own spine.
  nodes.run(point(WORKS.west, YS[4] as number), point(WORKS.west, YS[3] as number), LOCAL);
  nodes.run(point(WORKS.west, YS[3] as number), point(WORKS.west, AVENUE), LOCAL);
  nodes.run(point(WORKS.west, AVENUE), point(WORKS.west, YS[1] as number), LOCAL);
  nodes.run(point(WORKS.west, YS[1] as number), point(WORKS.west, WORKS.south), LOCAL);
  nodes.run(point(WORKS.west, WORKS.north), point(WORKS.east, WORKS.north), LOCAL);
  nodes.run(point(WORKS.west, WORKS.south), point(WORKS.east, WORKS.south), LOCAL);
  nodes.run(point(WORKS.east, WORKS.north), point(WORKS.east, WORKS.south), LOCAL);

  // Out to the stream and over it: the lane along the works, the town's bridge,
  // and the road beyond it that carries on off the map.
  nodes.run(point(EAST_END, WORKS.south), point(1_760, WORKS.south), LOCAL, [point(1_180, WORKS.south - 10)]);
  nodes.run(point(1_760, WORKS.south), point(1_980, WORKS.south), LOCAL, [], 'bridge');
  // And off the map on the east bank: the road out, which is why the bridge is
  // there at all.
  nodes.run(point(1_980, WORKS.south), point(2_320, WORKS.south + 120), LOCAL, [
    point(2_140, WORKS.south + 20),
    point(2_260, WORKS.south + 60),
  ]);

  return nodes;
}

/** Builds the town on `doc`, which should be empty. Returns how many buildings it put up. */
export function buildDefaultTown(doc: RoadDoc): number {
  const rng = new Rng(0x70a1_2026);
  void rng;
  layLandform(doc);
  layStreets(doc);
  return 0;
}
