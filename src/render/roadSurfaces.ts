import { Color, Group, type Material, type Mesh } from 'three';

import { difference, intersection, union, type MultiPoly, type Poly } from '@core/clipper';
import { Digest } from '@core/digest';
import { offsetPolyline } from '@core/offset';
import type { SegmentId } from '@world/ids';
import type { Network } from '@world/network';
import { Level, ROAD_TYPES, type SurfaceLevel } from '@world/roadTypes';
import { levelRings } from '@world/surfaces';
import {
  ROAD_STRUCTURES,
  isRaised,
  roadStructure,
  type RoadStructure,
} from '@world/structures';
import type { RoadElevation } from '@world/elevation';
import { PAINT_RISE, markingQuads, paintMaterial } from './markings';
import type { SceneMaterials } from './materials';
import { TERRAIN_CELL } from './terrain';
import {
  clipToRect,
  disposeMesh,
  mergeTiles,
  meshTile,
  type HeightFn,
  type SurfaceMeshOptions,
  type Tile,
  type TileRect,
  type TintFn,
  type UvFn,
  type UvFrameFn,
} from './mesh/surfaceMesh';

/**
 * The road network's surface bands, per structural level.
 *
 * ## Cross-section
 *
 * Every band sits at a fixed offset from ONE shared deck height, and each one
 * draws a skirt down to the band outside it. That is what turns four flat
 * ribbons into a built cross-section:
 *
 * ```
 *          footway  +0.36 ─────┐
 *   kerb face  ─────┐          │  (skirt down to the verge)
 *   asphalt  0.00 ──┘  +0.02   └── verge  -0.10
 * ```
 *
 * Because every offset is measured from the same `RoadElevation`, two bands can
 * never disagree about where the road is — the defect that left steps and gaps
 * between the carriageway and its kerb.
 *
 * ## Per-class colour, in one mesh
 *
 * A residential street is grey and a boulevard is near-black, but they share a
 * junction and therefore a polygon. The class tint is written per VERTEX from
 * the nearest road, so one asphalt mesh carries every class and the colour
 * blends where two classes meet instead of stopping at an invented seam.
 */

/**
 * Height of the kerb face above the carriageway.
 *
 * A hair ABOVE the footway rather than a hair below it. At 0.34 the kerb sat
 * 0.02 under the footway and read as part of it: nothing on screen said where
 * the kerb was. Standing 0.04 proud, its inner arris catches the light and
 * throws a line of shade, and the granite kerb reads as a separate edge.
 */
const KERB_RISE = 0.4;
/** Height of the footway above the carriageway. */
export const FOOTWAY_RISE = 0.36;
/** Depth of the verge below the carriageway, where the grass starts. */
const VERGE_DROP = 0.1;
/**
 * Drop of the verge skirt into the ground.
 *
 * Small, because the ground is now shaped to meet the road (`shapeAt` in
 * `world/elevation.ts`): the embankment is real terrain with a forty-five unit
 * batter, not a vertical face hung off the edge of the surface. This is only
 * the seal that stops a hairline of sky showing under the rim.
 */
const VERGE_SKIRT = 0.5;

/**
 * Longest triangle edge on a road at grade.
 *
 * This is NOT sized against the terrain's curvature. The deck reads a solved
 * profile whose every station has already been raised to clear the ground
 * within a window wider than this edge (`DILATE` in `world/elevation.ts`), so a
 * chord this long is guaranteed above the ground at both ends and everywhere
 * between them. The tessellation only has to be fine enough to SHADE well.
 */
const GROUND_MAX_EDGE = TERRAIN_CELL / 2;
/** A raised deck follows nothing, so it needs vertices only for its shading. */
const RAISED_MAX_EDGE = TERRAIN_CELL;

/** Height of the median island's kerb above the carriageway. */
const MEDIAN_KERB = 0.4;
/** Height of the planting inside it. */
export const MEDIAN_PLANTING = 0.62;

/**
 * What one build of the surfaces keeps for the next, so an edit rebuilds only
 * the tiles it reaches. Owned by the renderer; a build without it makes
 * everything afresh.
 */
export interface SurfaceReuse {
  /** The tiles of the last build, per structural level. */
  readonly tiles: Map<RoadStructure, Map<number, TileBundle>>;
  /**
   * A digest of everything the height field and the texture frames read in a
   * rectangle: the solved roads near it and the ground under it, both as
   * shaped and as it naturally lies.
   */
  readonly dependsOn: (minX: number, minY: number, maxX: number, maxY: number) => number;
  /** The paint materials, by colour: made once, not on every rebuild. */
  readonly paint: Map<string, Material>;
}

/** Every surface of one tile, by mesh name. */
export type TileBundle = ReadonlyMap<string, Tile>;

export interface RoadSurfaces {
  readonly group: Group;
  readonly meshes: readonly Mesh[];
  readonly triangles: number;
  /** Tiles the build made afresh, and copied from the build before. */
  readonly built: number;
  readonly reused: number;
  dispose(): void;
}

/**
 * World size of one tile.
 *
 * A road edit used to merge, cut and triangulate every band of the whole
 * network: a quarter of a million triangles and every polygon boolean, most of
 * the time a new road took to appear, and more on a bigger map. Everything is
 * now done a tile at a time from the rings that reach the tile, and a tile
 * whose rings and surroundings (`SurfaceReuse.dependsOn`) have not changed is
 * copied from the last build, so an edit pays for the tiles it reaches. A
 * multiple of the ground and deck spans (8 x 6 and 16 x 6), so a tile holds
 * whole pieces.
 */
const TILE = 192;
/**
 * Where the tile grid starts. Off any round number, so no road drawn on a
 * round coordinate has its edge lie along a tile line, where it would be taken
 * for a cut and lose its kerb (`meshTile`).
 */
const TILE_ORIGIN = 0.371;
/** How far round a tile a ring may reach and still be read by it. */
const TILE_REACH = 0.5;
const TILE_BIAS = 1 << 15;

/** One ring of input, with its box and its digest, measured once per build. */
interface Input {
  readonly poly: Poly;
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
  readonly digest: number;
}

function inputOf(poly: Poly): Input | null {
  const outer = poly[0];
  if (!outer || outer.length < 3) return null;
  const digest = new Digest();
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const ring of poly) {
    digest.add(ring.length);
    for (const point of ring) {
      const x = point[0] as number;
      const y = point[1] as number;
      digest.add(x).add(y);
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  return { poly, minX, minY, maxX, maxY, digest: digest.value() };
}

const offset = (base: HeightFn, amount: number): HeightFn => (x, y) => base(x, y) + amount;

/** Linear-space tints per road class, so the asphalt mesh can vary by class. */
const CLASS_TINT: readonly Color[] = ROAD_TYPES.map((type) =>
  new Color(type.color).convertSRGBToLinear(),
);
/** The tint the asphalt material is authored against, so 1.0 means "as baked". */
const TINT_REFERENCE = new Color(0x3a3d3f).convertSRGBToLinear();

/** What each surface of a tile is made from. */
type Source =
  | { readonly kind: 'band'; readonly band: 'verge' | 'footway' | 'kerb' | 'asphalt' }
  | { readonly kind: 'median'; readonly part: 'kerb' | 'planting' }
  | { readonly kind: 'paint'; readonly color: string };

/** One surface of a structural level: how it is meshed, and from what. */
interface SurfaceSpec {
  readonly source: Source;
  readonly options: Omit<SurfaceMeshOptions, 'polygons'>;
  readonly renderOrder?: number;
}

export function buildRoadSurfaces(
  net: Network,
  elevation: RoadElevation,
  materials: SceneMaterials,
  terrainAt: (x: number, y: number) => number,
  reuse?: SurfaceReuse,
): RoadSurfaces {
  const group = new Group();
  group.name = 'road-network';
  const meshes: Mesh[] = [];
  let triangles = 0;
  let built = 0;
  let reused = 0;
  // Without a caller to own them, the paint materials belong to this build.
  const paint = reuse?.paint ?? new Map<string, Material>();
  const paintFor = (color: string): Material => {
    let material = paint.get(color);
    if (!material) {
      material = paintMaterial(color);
      paint.set(color, material);
    }
    return material;
  };

  for (const structure of ROAD_STRUCTURES) {
    const present = [...net.doc.segments.values()].some(
      (segment) => segment.structure === structure.id,
    );
    if (!present) {
      reuse?.tiles.delete(structure.id);
      continue;
    }

    const only: ReadonlySet<RoadStructure> = new Set([structure.id]);
    const include = (id: SegmentId): boolean =>
      (net.doc.segment(id)?.structure ?? 'ground') === structure.id;
    const raised = isRaised(structure.id);
    const maxEdge = raised ? RAISED_MAX_EDGE : GROUND_MAX_EDGE;

    /** The single deck height every band of this structure is measured from. */
    const deck: HeightFn = (x, y) => elevation.at(x, y, only);
    /** Underside of the whole structure — the soffit of a deck, or the ground. */
    const soffit: HeightFn = raised
      ? (x, y) => deck(x, y) - roadStructure(structure.id).deck - FOOTWAY_RISE
      : (x, y) => Math.min(deck(x, y) - VERGE_SKIRT, terrainAt(x, y) - 0.2);

    const frameFor = (tile: number): UvFrameFn => (x, y, pickX, pickY, out) => {
      const frame = elevation.surfaceFrameAt(x, y, only, pickX, pickY);
      out[0] = frame.across / tile;
      out[1] = frame.along / tile;
    };
    /** Road-framed UVs, with every triangle kept inside one road's frame. */
    const uvFor = (tile: number): { uv: UvFn; uvFrame: UvFrameFn; uvWorld: number } => {
      const uvFrame = frameFor(tile);
      return { uv: (x, y, out) => uvFrame(x, y, x, y, out), uvFrame, uvWorld: tile };
    };

    /**
     * The carriageway's tint, taken from the class of the nearest road and
     * normalised against the colour the asphalt texture was baked at — so the
     * reference class comes out exactly as authored and the others shift from
     * it rather than being multiplied twice.
     */
    const asphaltTint: TintFn = (x, y, out) => {
      const road = elevation.roadAt(x, y, only);
      const tint = CLASS_TINT[road.type] ?? TINT_REFERENCE;
      out[0] = tint.r / TINT_REFERENCE.r;
      out[1] = tint.g / TINT_REFERENCE.g;
      out[2] = tint.b / TINT_REFERENCE.b;
    };

    const suffix = structure.id === 'ground' ? '' : `-${structure.id}`;

    // Outermost first, so a nearer band's skirt lands on the one outside it.
    const specs: SurfaceSpec[] = [
      {
        source: { kind: 'band', band: 'verge' },
        options: {
          name: `verge${suffix}`,
          top: offset(deck, -VERGE_DROP),
          bottom: soffit,
          material: raised ? materials.deck : materials.verge,
          maxEdge,
          ...uvFor(raised ? materials.scale.deck : materials.scale.verge),
          castShadow: raised,
          receiveShadow: true,
          skirtUvScale: raised ? materials.scale.deck : materials.scale.verge,
        },
      },
      {
        source: { kind: 'band', band: 'footway' },
        options: {
          name: `footway${suffix}`,
          top: offset(deck, FOOTWAY_RISE),
          bottom: offset(deck, -VERGE_DROP),
          material: materials.footway,
          maxEdge,
          ...uvFor(materials.scale.footway),
          castShadow: raised,
          receiveShadow: true,
          skirtUvScale: materials.scale.footway,
        },
      },
      {
        source: { kind: 'band', band: 'kerb' },
        options: {
          name: `kerb${suffix}`,
          top: offset(deck, KERB_RISE),
          bottom: deck,
          material: materials.kerb,
          maxEdge,
          ...uvFor(materials.scale.kerb),
          receiveShadow: true,
          skirtUvScale: materials.scale.kerb,
        },
      },
      {
        source: { kind: 'band', band: 'asphalt' },
        options: {
          name: `asphalt${suffix}`,
          top: deck,
          ...(raised ? { bottom: soffit } : {}),
          material: raised ? materials.asphaltRaised : materials.asphalt,
          maxEdge,
          ...uvFor(materials.scale.asphalt),
          tint: asphaltTint,
          castShadow: raised,
          receiveShadow: true,
          skirtUvScale: materials.scale.deck,
        },
      },
      {
        source: { kind: 'median', part: 'kerb' },
        options: {
          name: `median-kerb${suffix}`,
          top: offset(deck, MEDIAN_KERB),
          bottom: deck,
          material: materials.kerb,
          maxEdge,
          ...uvFor(materials.scale.kerb),
          receiveShadow: true,
          skirtUvScale: materials.scale.kerb,
        },
      },
      {
        source: { kind: 'median', part: 'planting' },
        options: {
          name: `median-planting${suffix}`,
          top: offset(deck, MEDIAN_PLANTING),
          bottom: offset(deck, MEDIAN_KERB),
          material: materials.verge,
          maxEdge,
          ...uvFor(materials.scale.verge),
          receiveShadow: true,
          skirtUvScale: materials.scale.kerb,
        },
      },
    ];

    // ---------------------------------------------------------------- inputs
    const levels: Record<'casing' | 'sidewalk' | 'curb' | 'asphalt', Input[]> = {
      casing: inputsOf(levelRings(net, Level.Casing as SurfaceLevel, include)),
      sidewalk: inputsOf(levelRings(net, Level.Sidewalk as SurfaceLevel, include)),
      curb: inputsOf(levelRings(net, Level.Curb as SurfaceLevel, include)),
      asphalt: inputsOf(levelRings(net, Level.Asphalt as SurfaceLevel, include)),
    };
    const strips = medianStrips(net, include);
    const medians = { kerb: inputsOf(strips.kerb), planting: inputsOf(strips.planting) };
    // Paint belongs to the road legs, not to the shared intersection interior,
    // so it is clipped to the ribbons' carriageway alone.
    const ribbonAsphalt: Input[] = [];
    for (const ribbon of net.ribbons.values()) {
      if (!include(ribbon.id)) continue;
      const ring = ribbon.rings[Level.Asphalt];
      if (!ring || ring.isEmpty) continue;
      const input = inputOf([ring.flatten().map((point) => [point.x, point.y])]);
      if (input) ribbonAsphalt.push(input);
    }
    // ...and to the tapers where a road carries on at another width, whose lane
    // lines and edge lines run on through them (see transitionMarkings).
    for (const node of net.transitions) {
      const junction = net.junctions.get(node)?.get(Level.Asphalt as SurfaceLevel);
      const leg = junction?.legs[0];
      if (!junction || !leg || !include(leg.seg)) continue;
      const input = inputOf([junction.ring.flatten().map((point) => [point.x, point.y])]);
      if (input) ribbonAsphalt.push(input);
    }
    const quads = new Map<string, Input[]>();
    for (const [color, rings] of markingQuads(net, include, structure.id === 'ground')) {
      quads.set(color, inputsOf(rings.map((ring) => [ring])));
      specs.push({
        source: { kind: 'paint', color },
        options: {
          name: `markings-${color.slice(1)}${suffix}`,
          top: offset(deck, 0.02 + PAINT_RISE),
          material: paintFor(color),
          // Paint follows the road it is painted on, so it needs the same vertex
          // density the deck has or it floats over a crest and sinks into a dip.
          maxEdge: 5,
          uv: (x, y, out) => {
            out[0] = x / 12;
            out[1] = y / 12;
          },
          receiveShadow: true,
        },
        renderOrder: 3,
      });
    }

    // ----------------------------------------------------------------- tiles
    /** Everything that reaches each tile, by kind, in input order. */
    interface Reach {
      readonly levels: Record<keyof typeof levels, Input[]>;
      readonly medians: Record<keyof typeof medians, Input[]>;
      readonly ribbons: Input[];
      readonly quads: Map<string, Input[]>;
    }
    const reach = new Map<number, Reach>();
    const reachOf = (key: number): Reach => {
      let value = reach.get(key);
      if (!value) {
        value = {
          levels: { casing: [], sidewalk: [], curb: [], asphalt: [] },
          medians: { kerb: [], planting: [] },
          ribbons: [],
          quads: new Map(),
        };
        reach.set(key, value);
      }
      return value;
    };
    const file = (input: Input, add: (into: Reach) => void): void => {
      const x0 = Math.floor((input.minX - TILE_REACH - TILE_ORIGIN) / TILE);
      const x1 = Math.floor((input.maxX + TILE_REACH - TILE_ORIGIN) / TILE);
      const y0 = Math.floor((input.minY - TILE_REACH - TILE_ORIGIN) / TILE);
      const y1 = Math.floor((input.maxY + TILE_REACH - TILE_ORIGIN) / TILE);
      for (let ix = x0; ix <= x1; ix++) {
        for (let iy = y0; iy <= y1; iy++) add(reachOf((ix + TILE_BIAS) * 0x1_0000 + (iy + TILE_BIAS)));
      }
    };
    for (const name of ['casing', 'sidewalk', 'curb', 'asphalt'] as const) {
      for (const input of levels[name]) file(input, (into) => into.levels[name].push(input));
    }
    for (const name of ['kerb', 'planting'] as const) {
      for (const input of medians[name]) file(input, (into) => into.medians[name].push(input));
    }
    for (const input of ribbonAsphalt) file(input, (into) => into.ribbons.push(input));
    for (const [color, list] of quads) {
      for (const input of list) {
        file(input, (into) => {
          const bucket = into.quads.get(color);
          if (bucket) bucket.push(input);
          else into.quads.set(color, [input]);
        });
      }
    }

    // Everything a tile's build reads besides its rings and its surroundings:
    // the constants of every surface, so a change to one is a change to all.
    const salt = new Digest().addText(structure.id);
    for (const spec of specs) {
      salt.addText(spec.options.name).add(spec.options.maxEdge).add(spec.options.uvWorld ?? 0)
        .add(spec.options.skirtUvScale ?? 0).add(spec.options.bottom ? 1 : 0).add(spec.options.tint ? 1 : 0);
    }
    const saltValue = salt.value();

    const previous = reuse?.tiles.get(structure.id);
    const kept = new Map<number, TileBundle>();
    const parts = new Map<string, Tile[]>();
    for (const spec of specs) parts.set(spec.options.name, []);
    // In tile order, so a mesh is laid out the same however it was reached.
    for (const key of [...reach.keys()].sort((a, b) => a - b)) {
      const into = reach.get(key)!;
      const ix = Math.floor(key / 0x1_0000) - TILE_BIAS;
      const iy = (key % 0x1_0000) - TILE_BIAS;
      const rect: TileRect = [
        ix * TILE + TILE_ORIGIN, iy * TILE + TILE_ORIGIN, (ix + 1) * TILE + TILE_ORIGIN, (iy + 1) * TILE + TILE_ORIGIN,
      ];
      const digest = new Digest().add(saltValue).add(key);
      const addAll = (list: readonly Input[]): void => {
        digest.add(list.length);
        for (const input of list) digest.add(input.digest);
      };
      addAll(into.levels.casing);
      addAll(into.levels.sidewalk);
      addAll(into.levels.curb);
      addAll(into.levels.asphalt);
      addAll(into.medians.kerb);
      addAll(into.medians.planting);
      addAll(into.ribbons);
      for (const [color, list] of into.quads) {
        digest.addText(color);
        addAll(list);
      }
      if (reuse) digest.add(reuse.dependsOn(rect[0] - 1, rect[1] - 1, rect[2] + 1, rect[3] + 1));
      const value = digest.value();
      let bundle = previous?.get(value);
      if (bundle) reused++;
      else {
        bundle = buildTile(into, rect, specs);
        built++;
      }
      kept.set(value, bundle);
      for (const [name, tile] of bundle) parts.get(name)?.push(tile);
    }
    reuse?.tiles.set(structure.id, kept);

    for (const spec of specs) {
      const mesh = mergeTiles(parts.get(spec.options.name) ?? [], spec.options);
      if (!mesh) continue;
      if (spec.renderOrder !== undefined) mesh.renderOrder = spec.renderOrder;
      group.add(mesh);
      meshes.push(mesh);
      triangles += (mesh.geometry.index?.count ?? 0) / 3;
    }
  }

  return {
    group,
    meshes,
    triangles,
    built,
    reused,
    dispose() {
      for (const mesh of meshes) disposeMesh(mesh);
      group.clear();
      if (!reuse) for (const material of paint.values()) material.dispose();
    },
  };
}

function inputsOf(polys: readonly Poly[]): Input[] {
  const out: Input[] = [];
  for (const poly of polys) {
    const input = inputOf(poly);
    if (input) out.push(input);
  }
  return out;
}

/**
 * Every surface of one tile, from the rings that reach it: merged, banded and
 * clipped exactly as the whole network would be, then cut to the tile.
 */
function buildTile(
  into: {
    readonly levels: Record<'casing' | 'sidewalk' | 'curb' | 'asphalt', readonly Input[]>;
    readonly medians: Record<'kerb' | 'planting', readonly Input[]>;
    readonly ribbons: readonly Input[];
    readonly quads: ReadonlyMap<string, readonly Input[]>;
  },
  rect: TileRect,
  specs: readonly SurfaceSpec[],
): TileBundle {
  const merged = (list: readonly Input[]): MultiPoly => list.length > 0 ? union(list.map((input) => input.poly)) : [];
  const casing = merged(into.levels.casing);
  const sidewalk = merged(into.levels.sidewalk);
  const curb = merged(into.levels.curb);
  const asphalt = merged(into.levels.asphalt);
  const bands: Record<'verge' | 'footway' | 'kerb' | 'asphalt', MultiPoly> = {
    verge: difference(casing, sidewalk),
    footway: difference(sidewalk, curb),
    kerb: difference(curb, asphalt),
    asphalt,
  };
  let ribbonsOnly: MultiPoly | null = null;
  const bundle = new Map<string, Tile>();
  for (const spec of specs) {
    const source = spec.source;
    let polygons: MultiPoly;
    if (source.kind === 'band') polygons = bands[source.band];
    else if (source.kind === 'median') {
      const list = into.medians[source.part];
      polygons = list.length > 0 ? intersection(merged(list), asphalt) : [];
    } else {
      const list = into.quads.get(source.color) ?? [];
      if (list.length === 0) polygons = [];
      else {
        ribbonsOnly ??= merged(into.ribbons);
        polygons = intersection(merged(list), ribbonsOnly);
      }
    }
    const inside = polygons.length > 0 ? clipToRect(polygons, rect) : [];
    if (inside.length > 0) bundle.set(spec.options.name, meshTile({ ...spec.options, polygons: inside }, rect));
  }
  return bundle;
}

/**
 * The central reservation's outlines, as two real polygons rather than as paint.
 *
 * It used to be drawn as two overlapping marking strokes at the same height —
 * a wide kerb colour with a narrower green inside it — which put two coplanar
 * surfaces in the depth buffer and produced the torn green scribble a player
 * photographed down the middle of every boulevard. A median is not paint: it is
 * a kerbed island with something growing in it, so it is built like one, with
 * its own height and its own skirt.
 *
 * Clipped against the carriageway so it can never leak past the kerb line, and
 * unioned so two medians meeting at a junction are one shape rather than two
 * overlapping ones - both a tile at a time, in `buildRoadSurfaces`.
 */
function medianStrips(
  net: Network,
  include: (segment: SegmentId) => boolean,
): { kerb: Poly[]; planting: Poly[] } {
  const kerb: Poly[] = [];
  const planting: Poly[] = [];
  for (const ribbon of net.ribbons.values()) {
    if (!include(ribbon.id)) continue;
    const median = ribbon.road.median;
    if (median <= 0) continue;
    const centre = ribbon.centre[Level.Asphalt];
    if (!centre || centre.n < 2) continue;
    const points = centre.toPoints();
    kerb.push(strip(points, (median + 1.4) / 2));
    planting.push(strip(points, median / 2));
  }
  return { kerb, planting };
}

/** A closed ribbon `half` wide either side of a centreline. */
function strip(points: readonly { x: number; y: number }[], half: number): MultiPoly[number] {
  const left = offsetPolyline(points, half);
  const right = offsetPolyline(points, -half).reverse();
  return [[...left, ...right].map((p) => [p.x, p.y])];
}
