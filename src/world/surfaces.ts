import { type MultiPoly, difference, union } from '@core/clipper';
import { Level, type SurfaceLevel } from './roadTypes';
import type { Network } from './network';
import type { NodeId, SegmentId } from './ids';
import { roadStructure } from './structures';

export type SurfaceSegmentFilter = (segment: SegmentId) => boolean;

/**
 * The network's surfaces as real polygons.
 *
 * A mesh needs the outline as DATA — with its holes, and with one boundary per
 * connected piece rather than a pile of overlapping rings — so the union of the
 * ribbons and the junction outlines is computed here rather than painted.
 *
 * Lives in `world` rather than in the renderer because it is geometry, not a
 * picture: the mesh builder, the marking clipper and the minimap all want the
 * same shapes, and none of them owns them. It knows nothing about cameras,
 * materials or three.js.
 */

/** Every surface of the network, one entry per level, outermost first. */
export interface Surfaces {
  readonly casing: MultiPoly;
  readonly sidewalk: MultiPoly;
  readonly curb: MultiPoly;
  readonly asphalt: MultiPoly;
}

/**
 * Bands, each the part of one level not covered by the level inside it.
 *
 * This is why no polygon offsetting is needed. Every level already has its own
 * half-width and its own trim — that is what makes the level rings nest — so
 * the footway is simply the footway level minus the kerb level, and the kerb is
 * the kerb level minus the carriageway. One source for every width, and no
 * second way to compute a distance.
 */
export interface Bands {
  /** The verge between the footway and the terrain. */
  readonly casing: MultiPoly;
  /** The footway itself, from the kerb outward. */
  readonly footway: MultiPoly;
  /** The kerb face, between carriageway and footway. */
  readonly kerb: MultiPoly;
  /** The carriageway. */
  readonly carriageway: MultiPoly;
}

/**
 * Whether this pass draws the junction at a node.
 *
 * A junction's rings are built once, from ALL of the node's legs, whatever
 * structure each belongs to — so they cannot simply be drawn in every pass that
 * has a leg there. Doing that painted the same shape twice at two elevations:
 * on a saved map the ground throat and the raised ring crossed each other and
 * one road's markings cut across the other's deck. Skipping them in every pass
 * is the other half of the same defect: a segment ending on another structure
 * keeps its own closed end, so its kerb and footway bands close ACROSS the
 * carriageway and paint a pale stripe over the join, and the mouth it was cut
 * for is filled by nothing at all.
 *
 * The junction belongs to the pass whose deck is at grade — the lowest structure
 * at that node. A road on the ground keeps its mouth and its markings; a raised
 * deck arriving there comes down to it along its own ramp and draws no junction
 * of its own. (A road network draws a junction where roads CONNECT and a
 * crossing where they pass at different levels — see the OpenDRIVE junction
 * model. Here, every node the editor allows is a connection: the raised deck
 * ramps down to the ground at it.) Tunnels are left out of the choice because
 * they build no surface at all.
 */
function ownsJunction(net: Network, nodeId: NodeId, include: SurfaceSegmentFilter): boolean {
  const node = net.doc.node(nodeId);
  if (!node) return false;
  let lowest = Infinity;
  let owns = false;
  for (const id of node.incident) {
    const structure = net.doc.segment(id)?.structure ?? 'ground';
    if (structure === 'tunnel') continue;
    const clearance = roadStructure(structure).clearance;
    if (clearance < lowest) {
      lowest = clearance;
      owns = include(id);
    }
  }
  return owns;
}

/** Every ring of one level, as clipper input. */
function ringsAt(net: Network, level: SurfaceLevel, include?: SurfaceSegmentFilter): MultiPoly {
  const out: MultiPoly = [];

  for (const ribbon of net.ribbons.values()) {
    if (include && !include(ribbon.id)) continue;
    const ring = ribbon.rings[level];
    if (ring && !ring.isEmpty) out.push([ring.flatten().map((p) => [p.x, p.y])]);
  }

  for (const [nodeId, byLevel] of net.junctions) {
    if (include && !ownsJunction(net, nodeId, include)) continue;
    const junction = byLevel.get(level);
    if (!junction) continue;
    for (const ring of junction.rings) {
      if (!ring.isEmpty) out.push([ring.flatten().map((p) => [p.x, p.y])]);
    }
  }

  return out;
}

/** One merged polygon set per surface level. */
export function levelPolygons(net: Network, level: SurfaceLevel, include?: SurfaceSegmentFilter): MultiPoly {
  return union(ringsAt(net, level, include));
}

export function surfaces(net: Network, include?: SurfaceSegmentFilter): Surfaces {
  return {
    casing: levelPolygons(net, Level.Casing, include),
    sidewalk: levelPolygons(net, Level.Sidewalk, include),
    curb: levelPolygons(net, Level.Curb, include),
    asphalt: levelPolygons(net, Level.Asphalt, include),
  };
}

export function bands(s: Surfaces): Bands {
  return {
    casing: difference(s.casing, s.sidewalk),
    footway: difference(s.sidewalk, s.curb),
    kerb: difference(s.curb, s.asphalt),
    carriageway: s.asphalt,
  };
}

