import { Color, Group, Mesh } from 'three';

import { intersection, union, type MultiPoly } from '@core/clipper';
import { offsetPolyline } from '@core/offset';
import type { SegmentId } from '@world/ids';
import type { Network } from '@world/network';
import { Level, ROAD_TYPES } from '@world/roadTypes';
import { bands, surfaces } from '@world/surfaces';
import {
  ROAD_STRUCTURES,
  isRaised,
  roadStructure,
  type RoadStructure,
} from '@world/structures';
import type { RoadElevation } from '@world/elevation';
import { buildMarkings, disposeMarkings } from './markings';
import type { SceneMaterials } from './materials';
import { TERRAIN_CELL } from './terrain';
import {
  buildSurfaceMesh,
  disposeMesh,
  type HeightFn,
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

export interface RoadSurfaces {
  readonly group: Group;
  readonly meshes: readonly Mesh[];
  readonly triangles: number;
  dispose(): void;
}

const offset = (base: HeightFn, amount: number): HeightFn => (x, y) => base(x, y) + amount;

/** Linear-space tints per road class, so the asphalt mesh can vary by class. */
const CLASS_TINT: readonly Color[] = ROAD_TYPES.map((type) =>
  new Color(type.color).convertSRGBToLinear(),
);
/** The tint the asphalt material is authored against, so 1.0 means "as baked". */
const TINT_REFERENCE = new Color(0x3a3d3f).convertSRGBToLinear();

export function buildRoadSurfaces(
  net: Network,
  elevation: RoadElevation,
  materials: SceneMaterials,
  terrainAt: (x: number, y: number) => number,
): RoadSurfaces {
  const group = new Group();
  group.name = 'road-network';
  const meshes: Mesh[] = [];
  let triangles = 0;

  const add = (mesh: Mesh | null): void => {
    if (!mesh) return;
    group.add(mesh);
    meshes.push(mesh);
    triangles += (mesh.geometry.index?.count ?? 0) / 3;
  };

  for (const structure of ROAD_STRUCTURES) {
    const present = [...net.doc.segments.values()].some(
      (segment) => segment.structure === structure.id,
    );
    if (!present) continue;

    const only: ReadonlySet<RoadStructure> = new Set([structure.id]);
    const include = (id: SegmentId): boolean =>
      (net.doc.segment(id)?.structure ?? 'ground') === structure.id;
    const layer = bands(surfaces(net, include));
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
    add(
      buildSurfaceMesh({
        name: `verge${suffix}`,
        polygons: layer.casing,
        top: offset(deck, -VERGE_DROP),
        bottom: soffit,
        material: raised ? materials.deck : materials.verge,
        maxEdge,
        ...uvFor(raised ? materials.scale.deck : materials.scale.verge),
        castShadow: raised,
        receiveShadow: true,
        skirtUvScale: raised ? materials.scale.deck : materials.scale.verge,
      }),
    );
    add(
      buildSurfaceMesh({
        name: `footway${suffix}`,
        polygons: layer.footway,
        top: offset(deck, FOOTWAY_RISE),
        bottom: offset(deck, -VERGE_DROP),
        material: materials.footway,
        maxEdge,
        ...uvFor(materials.scale.footway),
        castShadow: raised,
        receiveShadow: true,
        skirtUvScale: materials.scale.footway,
      }),
    );
    add(
      buildSurfaceMesh({
        name: `kerb${suffix}`,
        polygons: layer.kerb,
        top: offset(deck, KERB_RISE),
        bottom: deck,
        material: materials.kerb,
        maxEdge,
        ...uvFor(materials.scale.kerb),
        receiveShadow: true,
        skirtUvScale: materials.scale.kerb,
      }),
    );
    add(
      buildSurfaceMesh({
        name: `asphalt${suffix}`,
        polygons: layer.carriageway,
        top: deck,
        ...(raised ? { bottom: soffit } : {}),
        material: raised ? materials.asphaltRaised : materials.asphalt,
        maxEdge,
        ...uvFor(materials.scale.asphalt),
        tint: asphaltTint,
        castShadow: raised,
        receiveShadow: true,
        skirtUvScale: materials.scale.deck,
      }),
    );

    // --------------------------------------------------------------- medians
    const islands = medianPolygons(net, include, layer.carriageway);
    if (islands.kerb.length > 0) {
      add(
        buildSurfaceMesh({
          name: `median-kerb${suffix}`,
          polygons: islands.kerb,
          top: offset(deck, MEDIAN_KERB),
          bottom: deck,
          material: materials.kerb,
          maxEdge,
          ...uvFor(materials.scale.kerb),
          receiveShadow: true,
          skirtUvScale: materials.scale.kerb,
        }),
      );
      add(
        buildSurfaceMesh({
          name: `median-planting${suffix}`,
          polygons: islands.planting,
          top: offset(deck, MEDIAN_PLANTING),
          bottom: offset(deck, MEDIAN_KERB),
          material: materials.verge,
          maxEdge,
          ...uvFor(materials.scale.verge),
          receiveShadow: true,
          skirtUvScale: materials.scale.kerb,
        }),
      );
    }

    const markings = buildMarkings(
      net,
      include,
      offset(deck, 0.02),
      structure.id === 'ground',
      suffix,
    );
    group.add(markings);
    for (const child of markings.children) {
      if (child instanceof Mesh) triangles += (child.geometry.index?.count ?? 0) / 3;
    }
  }

  return {
    group,
    meshes,
    triangles,
    dispose() {
      for (const child of group.children) {
        if (child instanceof Mesh) disposeMesh(child);
        else if (child instanceof Group) disposeMarkings(child);
      }
      group.clear();
    },
  };
}

/**
 * The central reservation, as two real polygons rather than as paint.
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
 * overlapping ones.
 */
function medianPolygons(
  net: Network,
  include: (segment: SegmentId) => boolean,
  carriageway: MultiPoly,
): { kerb: MultiPoly; planting: MultiPoly } {
  const kerbRings: MultiPoly = [];
  const plantingRings: MultiPoly = [];

  for (const ribbon of net.ribbons.values()) {
    if (!include(ribbon.id)) continue;
    const median = ribbon.road.median;
    if (median <= 0) continue;
    const centre = ribbon.centre[Level.Asphalt];
    if (!centre || centre.n < 2) continue;
    const points = centre.toPoints();
    kerbRings.push(strip(points, (median + 1.4) / 2));
    plantingRings.push(strip(points, median / 2));
  }

  if (kerbRings.length === 0) return { kerb: [], planting: [] };
  const kerb = intersection(union(kerbRings), carriageway);
  const planting = intersection(union(plantingRings), carriageway);
  return { kerb, planting };
}

/** A closed ribbon `half` wide either side of a centreline. */
function strip(points: readonly { x: number; y: number }[], half: number): MultiPoly[number] {
  const left = offsetPolyline(points, half);
  const right = offsetPolyline(points, -half).reverse();
  return [[...left, ...right].map((p) => [p.x, p.y])];
}
