import type { Vec2 } from '@core/vec2';
import { Rng as RngStream } from '@core/rng';
import type { RoadDoc } from './doc';
import type { NodeId } from './ids';
import type { RoadStructure } from './structures';
import { Level, ROAD_TYPES, halfWidth, type RoadType } from './roadTypes';
import type { TerrainMode, TerrainStamp } from './terrain';
import { type BlueprintBody } from './buildings/blueprints';
import { Model, mat } from './buildings/cityBuildings';
import type { BuildingFunction, LotSurface } from './buildings/types';
import { type Box, type Edge, facingBody, inside, overlaps } from './sampleTown';
import { courtyard, houses, park, perimeter, varied, type Placer } from './town';
import { m } from './units';

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

/** The town generators draw from a plain stream, as the ones in town.ts do. */
type Rng = () => number;

const LOCAL = ROAD_TYPES.findIndex((t) => t.id === 'local');
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
  // East of the last street the avenue is a street again, and the works' own
  // road takes over at its end: a four-lane carriageway with a 6-unit footway
  // on it reaching into the yard frontage would hold the sheds ten units back
  // from their own street.
  nodes.run(point(XS[6] as number, AVENUE), point(EAST_END, AVENUE), LOCAL);

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

// ---------------------------------------------------------------- occupancy

/** Half a street's width at its widest band: how far a lot starts from the line. */
const casingOf = (type: number): number => halfWidth(ROAD_TYPES[type] as RoadType, Level.Casing);
const LOCAL_OFF = casingOf(LOCAL);
const AVENUE_OFF = casingOf(AVENUE_CLASS);

/** The lot of the block between two street lines: the rectangle the paving leaves. */
function lotOf(i: number, j: number): Box {
  // A block is inset by whatever street bounds it, and the avenue is nearly
  // twice as wide as a street: insetting the avenue's own side by a street's
  // half-width put the shops' fronts into its footway, which the building
  // validator reports as standing on a road.
  const side = (line: number): number => (line === AVENUE ? AVENUE_OFF : LOCAL_OFF);
  const x0 = (XS[i] as number) + LOCAL_OFF;
  const x1 = (XS[i + 1] as number) - LOCAL_OFF;
  const y0 = (YS[j] as number) + side(YS[j] as number);
  const y1 = (YS[j + 1] as number) - side(YS[j + 1] as number);
  return { x0, y0, x1, y1 };
}

/** What fronts the street round each block of the avenue's north side. */
const NORTH_FRONT: readonly (readonly BuildingFunction[])[] = [
  ['bank', 'shop', 'townhouse', 'bakery', 'shop'],
  ['shop', 'townhouse', 'restaurant', 'shop', 'pharmacy'],
  ['hotel', 'shop', 'bar', 'shop', 'townhouse'],
  ['cinema', 'restaurant', 'shop', 'townhouse', 'shop'],
  ['postOffice', 'shop', 'council', 'apartments', 'shop'],
];
/** South of the avenue: the shops that face the square, and the works' gate. */
const SOUTH_FRONT: readonly (readonly BuildingFunction[])[] = [
  ['shop', 'shop', 'bakery', 'townhouse', 'shop'],
  ['restaurant', 'bar', 'shop', 'snackBar', 'townhouse'],
  ['pharmacy', 'shop', 'townhouse', 'shop', 'apartments'],
  ['shop', 'townhouse', 'restaurant', 'clinic', 'shop'],
  ['police', 'shop', 'townhouse', 'apartments', 'bank'],
];
/** The northern band of terraces, school and library. */
const TERRACE_FRONT: readonly (readonly BuildingFunction[])[] = [
  ['townhouse', 'townhouse', 'bakery', 'townhouse', 'apartments', 'townhouse'],
  ['clinic', 'townhouse', 'townhouse', 'shop', 'townhouse', 'townhouse'],
  ['library', 'townhouse', 'apartments', 'townhouse', 'bakery', 'townhouse'],
];
const FILL_SHOP: readonly BuildingFunction[] = ['shop', 'townhouse'];
const FILL_TERRACE: readonly BuildingFunction[] = ['townhouse', 'shop'];

/**
 * A lot of open ground, as the model's own blocks.
 *
 * A block may not be bigger than 160 m on a side (`MAX_SIZE`), and a plaza,
 * a yard or a car park is: they are tiled here in pieces under that, which is
 * also how such ground is really made - in bays and bays.
 */
function paved(model: Model, x: number, y: number, w: number, d: number, surface: LotSurface, piece = 50): void {
  const nx = Math.max(1, Math.ceil(w / piece));
  const ny = Math.max(1, Math.ceil(d / piece));
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < ny; j++) {
      model.lot(x + (i * w) / nx, y + (j * d) / ny, w / nx, d / ny, surface);
    }
  }
}

/**
 * A straight run of paving or of parking bays, laid in PIECES.
 *
 * An element may not be longer than 40 m (`MAX_ELEMENT`), and the walks
 * across a square and the bays of a car park are longer than that. Cut into
 * lengths, a 90 m walk is four pieces of paving, which is what a paved walk
 * is made of anyway - and the model keeps its own rules.
 */
function runOf(
  model: Model,
  kind: 'pavement' | 'parking',
  x: number,
  y: number,
  length: number,
  across: number,
  facing: 0 | 1,
  piece = 24,
): void {
  const count = Math.max(1, Math.ceil(length / piece));
  for (let i = 0; i < count; i++) {
    const t = (i + 0.5) * (length / count);
    // 0.12 m: the thinnest a part may be (`MIN_ELEMENT`), which is why a
    // paving slab is a kerb's height and not a sheet of paper.
    model.el(kind, facing === 0 ? x + t : x, facing === 0 ? y : y + t, facing,
      { w: length / count, d: across, h: kind === 'pavement' ? 0.12 : 0.12 });
  }
}

/**
 * The market square: paving from edge to edge, a fountain where the ways
 * cross, rows of trees, benches, market canopies and flower beds. The town's
 * one big room, and the reason the avenue has a bend worth walking to.
 */
function plaza(rng: Rng, Wm: number, Dm: number): BlueprintBody {
  const model = new Model('square', 'commercial', 3);
  const w = Wm;
  const d = Dm;
  paved(model, 0, 0, w, d, 'paving');
  // The fountain: a stone basin with water in it, at the middle of the square.
  const fx = w / 2;
  const fy = d / 2;
  model.lot(fx - 3, fy - 3, 6, 6, 'water');
  model.el('pillar', fx, fy, 0, { w: 0.8, d: 0.8, h: 2.4, material: mat('stone', 0xc9c0ae) });
  model.el('rocks', fx - 2.4, fy - 1.6, 0, { w: 1.2, d: 0.9, h: 0.5, material: mat('stone', 0xb3aa98) });
  model.el('rocks', fx + 2.2, fy + 1.8, 0, { w: 1, d: 0.8, h: 0.4, material: mat('stone', 0xb3aa98) });
  // Two walks across, meeting at the fountain.
  runOf(model, 'pavement', 2, d / 2, w - 4, 3, 0);
  runOf(model, 'pavement', w / 2, 2, d - 4, 3, 1);
  void rng;
  // Rows of trees down the sides, with benches between them, and flower beds.
  for (const side of [0, 1]) {
    const y = side === 0 ? 4.2 : d - 4.2;
    model.row('tree', 7, y, w - 7, y, Math.max(3, Math.min(8, Math.round(w / 18))));
    model.row('bench', 8, side === 0 ? y + 2.6 : y - 2.6, w - 8, side === 0 ? y + 2.6 : y - 2.6, 4, side === 0 ? 2 : 0);
  }
  model.row('flowers', 10, d * 0.22, w - 10, d * 0.22, 3);
  model.row('flowers', 10, d * 0.78, w - 10, d * 0.78, 3);
  // The market: canopies along the square's length, a stall under each.
  const stalls = Math.max(3, Math.min(6, Math.round(w / 26)));
  for (let k = 0; k < stalls; k++) {
    const x = 12 + (k * (w - 24)) / Math.max(1, stalls - 1);
    model.el('canopy', x, fy - 8, 0, { w: 6, d: 4, h: 0.2, z: 2.6 });
    model.el('slab', x, fy - 8, 0, { w: 3.4, d: 1.4, h: 0.9, material: mat('wood', 0x8c6b4c) });
  }
  return model.build();
}

/**
 * A car park: hard standing, marked bays, and a row of trees along each
 * aisle - which is what keeps a forecourt from reading as a grey rectangle.
 */
function parkingBody(Wm: number, Dm: number, surface: LotSurface): BlueprintBody {
  const model = new Model('square', 'commercial', 1);
  paved(model, 0, 0, Wm, Dm, surface, 60);
  const rows = Math.max(1, Math.min(4, Math.round(Dm / 14)));
  for (let k = 0; k < rows; k++) {
    const y = ((k + 0.5) * Dm) / rows;
    runOf(model, 'parking', 3, y, Math.max(2, Wm - 6), 5, 0, 30);
  }
  // A row of trees along the two long sides, which is what breaks a forecourt
  // up: a paved rectangle with nothing in it reads as a hole in the town.
  const trees = Math.max(2, Math.min(9, Math.round(Wm / 22)));
  model.row('tree', 4, 3.4, Wm - 4, 3.4, trees);
  model.row('tree', 4, Dm - 3.4, Wm - 4, Dm - 3.4, trees);
  // A part may not be one of a handful: 64 elements is a whole building's
  // budget (`MAX_ELEMENTS`), and a car park is not allowed to spend it alone.
  return model.build();
}

/**
 * The works: yards, warehouses and the factory, with their aprons fenced off
 * the street. One lot of the industrial estate, in its own frame: the caller
 * says where it stands and which way it faces.
 */
function yard(rng: Rng, Wm: number, Dm: number, kind: 'factory' | 'warehouse' | 'store'): BlueprintBody {
  const model = new Model(kind === 'store' ? 'warehouse' : kind, 'industrial', 7);
  const w = Wm;
  const d = Dm;
  // The boundary is a FENCE, not a wall all the way round: a ring of 4 m
  // panels round an 90 m lot is eighty parts, which is more than a building
  // may have. A dog-leg along the street side and the yard's lane is what an
  // estate actually shows the town.
  const boundary = (): void => {
    model.row('fence', 2, d - 1, w - 2, d - 1, Math.max(3, Math.round(w / 6)));
    model.row('fence', 1, 2, 1, d * 0.6, Math.max(2, Math.round(d / 12)));
  };
  if (kind === 'store') {
    // A yard of hard standing: gravel, containers as slabs, a hut.
    paved(model, 0, 0, w, d, 'gravel');
    for (let k = 0; k < 6; k++) {
      const x = 5 + (k % 3) * 11;
      const y = 6 + Math.floor(k / 3) * 9;
      model.el('slab', x, y, 0, { w: 7, d: 2.6, h: 2.6, material: mat('metal', 0x5d6b70) });
    }
    model.block({ x: w - 14, y: d - 12, w: 9, d: 7, storeys: 1, roof: 'shed', door: 'middle' });
    boundary();
  } else if (kind === 'factory') {
    paved(model, 0, 0, w, d, 'paving');
    model.block({ x: 12, y: 10, w: 36, d: 24, storeys: 1, roof: 'sawtooth', fill: 'ribbon', ground: 'loadingDoor' });
    model.block({ x: 52, y: 12, w: 3, d: 3, storeys: 8, fill: 'wall' });   // the chimney
    model.block({ x: 12, y: 40, w: 10, d: 9, storeys: 2, door: 'middle' }); // the office
    runOf(model, 'parking', 30, d - 8, 30, 5, 0);
    model.row('tree', 58, 8, 58, d - 12, 3);
    boundary();
  } else {
    paved(model, 0, 0, w, d, 'paving');
    model.block({ x: 6, y: 14, w: 30, d: 24, storeys: 1, roof: 'shed', fill: 'wall', ground: 'loadingDoor' });
    // The turning apron and the bays are in FRONT of the shed: a part never
    // stands inside a volume, and a lorry needs the room anyway.
    runOf(model, 'parking', 6, 6, Math.max(20, w - 14), 5, 0);
    model.row('tree', 46, 18, 46, d - 8, 3);
    boundary();
  }
  void rng;
  return model.build();
}

/** Everything that stands on the blocks, district by district. */
function occupy(doc: RoadDoc, stream: RngStream): number {
  const rng = (): number => stream.float();
  const placed: Box[] = [];
  let count = 0;
  const into: Placer = {
    placed,
    put(body, box) {
      doc.buildings.add(body);
      placed.push(box);
      count++;
    },
  };
  /** An open block (a square, a park, a yard) laid on its lot, no front gap. */
  const putOpen = (body: BlueprintBody, fn: BuildingFunction, lot: Box, inset = 0): void => {
    const x0 = lot.x0 + inset;
    const y0 = lot.y0 + inset;
    const edge: Edge = { start: { x: x0, y: y0 }, along: { x: 1, y: 0 }, inward: { x: 0, y: 1 }, length: lot.x1 - lot.x0 - inset * 2 };
    const f = facingBody(body, fn, edge, 0, 0);
    if (!inside(f.box, lot)) return;
    into.put({ ...f.body, function: fn }, f.box);
  };
  /** The biggest room left in a block's middle, for a court or a garden. */
  const middle = (lot: Box, fn: (w: number, d: number) => BlueprintBody, fnName: BuildingFunction): void => {
    for (let inset = m(12); inset < Math.min(lot.x1 - lot.x0, lot.y1 - lot.y0) / 2 - m(8); inset += m(2)) {
      const box: Box = { x0: lot.x0 + inset, y0: lot.y0 + inset, x1: lot.x1 - inset, y1: lot.y1 - inset };
      if (placed.some((o) => overlaps(box, o, m(1)))) continue;
      putOpen(fn((box.x1 - box.x0) / m(1), (box.y1 - box.y0) / m(1)), fnName, box);
      return;
    }
  };

  // ---- the avenue's north side: the shops, with the flats above them
  for (let i = 0; i < 5; i++) {
    const lot = lotOf(i, 2);
    perimeter(rng, lot, [...(NORTH_FRONT[i] as readonly BuildingFunction[])], FILL_SHOP, into);
    middle(lot, (w, d) => courtyard(rng, w, d), 'square');
  }
  // The north-east block is the supermarket and its car park: a big shed is
  // not something to line up with the shops.
  {
    const lot = lotOf(5, 2);
    const body = varied(rng, 'supermarket') as BlueprintBody;
    const edge: Edge = { start: { x: lot.x0 + 8, y: lot.y0 + 2 }, along: { x: 1, y: 0 }, inward: { x: 0, y: 1 }, length: lot.x1 - lot.x0 - 16 };
    const f = facingBody(body, 'supermarket', edge, 0, m(0.4));
    into.put({ ...f.body, function: 'supermarket' }, f.box);
    // Parking in front of it, and the way in from the avenue.
    const park = { x0: f.box.x0 + m(2), y0: f.box.y1 + m(2), x1: f.box.x1 - m(2), y1: lot.y1 - m(2) };
    putOpen(parkingBody((park.x1 - park.x0) / m(1), (park.y1 - park.y0) / m(1), 'paving'), 'square', park);
  }

  // ---- the avenue's south side, with the market square in the middle
  for (const i of [0, 1, 2, 4]) {
    const lot = lotOf(i, 1);
    perimeter(rng, lot, [...(SOUTH_FRONT[i] as readonly BuildingFunction[])], FILL_SHOP, into);
    middle(lot, (w, d) => courtyard(rng, w, d), 'square');
  }
  {
    // The square: the block between the avenue and the street behind it, from
    // x = -300 to 0, opening on the avenue. The city hall stands at its west
    // end and the church at its east, both facing into the plaza, and the
    // plaza fills the ground between them. The market street runs along its
    // eastern side, so the square is on a corner of the grid and not a hole
    // cut through it.
    const lot: Box = lotOf(3, 1);
    let west = lot.x0;
    let east = lot.x1;
    for (const [fn, atWest] of [['cityHall', true], ['church', false]] as const) {
      const body = varied(rng, fn);
      if (!body) continue;
      // Facing the plaza: the model's front is set against `inward`, so a
      // building at the west end faces east with inward pointing west.
      const inward: Vec2 = { x: atWest ? -1 : 1, y: 0 };
      const probe = facingBody(body, fn, { start: { x: 0, y: 0 }, along: { x: 0, y: 1 }, inward, length: 1 }, 0, 0);
      const width = probe.box.y1 - probe.box.y0;
      const depth = probe.box.x1 - probe.box.x0;
      const start: Vec2 = {
        x: atWest ? lot.x0 + depth + m(1) : lot.x1 - depth - m(1),
        y: lot.y0 + (lot.y1 - lot.y0 - width) / 2,
      };
      const edge: Edge = { start, along: { x: 0, y: 1 }, inward, length: width };
      const f = facingBody(body, fn, edge, 0, m(1));
      if (!inside(f.box, lot)) continue;
      into.put({ ...f.body, function: fn }, f.box);
      if (atWest) west = Math.max(west, f.box.x1 + m(3));
      else east = Math.min(east, f.box.x0 - m(3));
    }
    if (east - west > m(20)) {
      putOpen(plaza(rng, (east - west) / m(1), (lot.y1 - lot.y0) / m(1)), 'square',
        { x0: west, y0: lot.y0, x1: east, y1: lot.y1 });
    }
  }
  {
    const lot = lotOf(5, 1);
    perimeter(rng, lot, ['gym', 'shop', 'townhouse', 'apartments', 'police'], FILL_SHOP, into);
    middle(lot, (w, d) => courtyard(rng, w, d), 'square');
  }

  // ---- the northern band: terraces, the school, the park, the library
  for (const i of [0, 1, 3, 5]) {
    const lot = lotOf(i, 3);
    perimeter(rng, lot, [...(TERRACE_FRONT[(i + 1) % TERRACE_FRONT.length] as readonly BuildingFunction[])], FILL_TERRACE, into);
    middle(lot, (w, d) => courtyard(rng, w, d), 'square');
  }
  {
    // The school: its own campus against the avenue's back street.
    const lot = lotOf(2, 3);
    const edge: Edge = { start: { x: lot.x0 + 2, y: lot.y0 + 4 }, along: { x: 1, y: 0 }, inward: { x: 0, y: 1 }, length: lot.x1 - lot.x0 - 4 };
    const f = facingBody(varied(rng, 'school') as BlueprintBody, 'school', edge, 0, m(0.4));
    if (inside(f.box, lot)) into.put({ ...f.body, function: 'school' }, f.box);
  }
  {
    // The park: on the block behind the shops, with the pond and its walks.
    const lot = lotOf(4, 3);
    putOpen(park(rng, (lot.x1 - lot.x0) / m(1), (lot.y1 - lot.y0) / m(1)), 'park', lot);
  }

  // ---- the southern band: the residential blocks, each a pair of rows of
  // houses back to back, every house its own - its plan, its roof, its garden.
  for (let i = 0; i < 6; i++) {
    const lot = lotOf(i, 0);
    houses(rng, lot, into);
    // The middle of the block: a garden, a court, a playground.
    if (i % 2 === 0) middle(lot, (w, d) => courtyard(rng, w, d), 'square');
  }

  // ---- the works, east of the last street
  //
  // Two columns of yards with the lane between them, and the service strip
  // along the southern road: the garage and its forecourt on the way out of
  // town, the sheds up the lane, and a lorry park at the foot of the western
  // column. Every lot is placed from the same two lines, so none of them has
  // to be nudged to clear its neighbour.
  {
    const west = WORKS.west + LOCAL_OFF;
    const east = WORKS.east - LOCAL_OFF;
    const north = WORKS.north - LOCAL_OFF;
    const south = WORKS.south + LOCAL_OFF;
    const westEast = west + m(88);
    const eastWest = east - m(88);
    // The western column, from the northern lane down.
    putOpen(yard(rng, 88, 70, 'factory'), 'factory', { x0: west, y0: north - m(72), x1: westEast, y1: north });
    putOpen(yard(rng, 66, 60, 'warehouse'), 'warehouse', { x0: west, y0: north - m(134), x1: west + m(68), y1: north - m(74) });
    putOpen(yard(rng, 74, 54, 'store'), 'warehouse', { x0: west, y0: north - m(190), x1: west + m(76), y1: north - m(136) });
    // The eastern column.
    putOpen(yard(rng, 88, 74, 'warehouse'), 'warehouse', { x0: eastWest, y0: north - m(76), x1: east, y1: north });
    putOpen(yard(rng, 88, 70, 'store'), 'warehouse', { x0: eastWest, y0: north - m(148), x1: east, y1: north - m(78) });
    // The garage, its forecourt, and the way in from the avenue.
    const forecourt: Box = { x0: west + m(74), y0: south + m(2), x1: east, y1: south + m(46) };
    putOpen(parkingBody((forecourt.x1 - forecourt.x0) / m(1), (forecourt.y1 - forecourt.y0) / m(1), 'paving'), 'square', forecourt);
    const station = varied(rng, 'gasStation');
    if (station) {
      const near: Box = { x0: west + m(76), y0: south + m(48), x1: west + m(128), y1: south + m(82) };
      const edge: Edge = { start: { x: near.x0, y: near.y0 }, along: { x: 1, y: 0 }, inward: { x: 0, y: 1 }, length: near.x1 - near.x0 };
      const f = facingBody(station, 'gasStation', edge, 0, 0);
      if (inside(f.box, near)) into.put({ ...f.body, function: 'gasStation' }, f.box);
    }
  }

  return count;
}

// ---------------------------------------------------------------- the dressing

/**
 * The town's own fittings: the wires along the avenue and out to the works,
 * and the hedges that hold the built town off the fields it was cut out of.
 *
 * Lamps, street trees, bins and benches are NOT here: they are laid along
 * every street by `world/streetFurniture.ts`, from the roads themselves, so
 * the pedestrians walk round the same list the renderer draws.
 */
function dress(doc: RoadDoc): void {
  // A pole run down the avenue's northern footway, and another along the
  // works' lane: the overhead pair a town like this is supplied by. Poles
  // stand where the ground is, and the wires sag between them.
  const runOfPoles = (points: readonly Vec2[]): void => {
    let previous: ReturnType<RoadDoc['addPole']> | null = null;
    for (const point of points) {
      const pole = doc.addPole(point, true);
      if (previous) doc.addPoleSpan(previous.id, pole.id);
      previous = pole;
    }
  };
  const avenueLine: Vec2[] = [];
  for (let x = -1_180; x <= 620; x += 74) avenueLine.push({ x, y: AVENUE_OFF - 2.6 });
  runOfPoles(avenueLine);
  const worksLine: Vec2[] = [];
  for (let y = AVENUE - 60; y >= WORKS.south + 20; y -= 78) worksLine.push({ x: WORKS.west - LOCAL_OFF + 2.6, y });
  runOfPoles(worksLine);

  // The hedgerows along the two edges of the built town, on the far side of
  // the outer streets: what stops a grid of houses from just stopping.
  const hedgeAlong = (from: Vec2, to: Vec2, step = 30): void => {
    const length = Math.hypot(to.x - from.x, to.y - from.y);
    const count = Math.max(2, Math.round(length / step));
    const points: Vec2[] = [];
    for (let i = 0; i <= count; i++) {
      const t = i / count;
      // A hedge is planted, not surveyed: it wanders by a unit or two.
      const wobble = Math.sin(i * 1.7) * 3;
      points.push({
        x: from.x + (to.x - from.x) * t + wobble,
        y: from.y + (to.y - from.y) * t - wobble,
      });
    }
    doc.addBarrier('hedge', points);
  };
  hedgeAlong({ x: -1_250, y: YS[0] as number - 34 }, { x: 640, y: (YS[0] as number) - 40 });
  hedgeAlong({ x: -1_250, y: (YS[4] as number) + 34 }, { x: 640, y: (YS[4] as number) + 40 });
  hedgeAlong({ x: (XS[0] as number) - 34, y: -400 }, { x: (XS[0] as number) - 40, y: 420 });
  // And a wall round the park, which is the one plot in the town that is not
  // somebody's front garden.
  const park = lotOf(4, 3);
  doc.addBarrier('wall', [
    { x: park.x0 - 2, y: park.y0 - 2 },
    { x: park.x1 + 2, y: park.y0 - 2 },
    { x: park.x1 + 2, y: park.y1 + 2 },
    { x: park.x0 - 2, y: park.y1 + 2 },
    { x: park.x0 - 2, y: park.y0 - 2 },
  ]);
}

/** Builds the town on `doc`, which should be empty. Returns how many buildings it put up. */
export function buildDefaultTown(doc: RoadDoc): number {
  const stream = new RngStream(0x70a1_2026);
  layLandform(doc);
  layStreets(doc);
  const count = occupy(doc, stream);
  dress(doc);
  return count;
}
