import type { MultiPoly } from '@core/clipper';
import type { Vec2 } from '@core/vec2';
import type { RoadDoc } from '@world/doc';
import type { Network } from '@world/network';
import type { NodeId, SegmentId } from '@world/ids';
import { CROSSWALK_DEPTH } from '@world/approach';
import { buildRoadElevation } from '@world/elevation';
import { LaneletGraph, type Lanelet } from '@world/lanelets';
import { Level, halfWidth, roadProfile } from '@world/roadTypes';
import { carriesPedestrians } from '@world/pedestrianAccess';
import { levelPolygons } from '@world/surfaces';
import { ARCHETYPES } from '@sim/vehicles/archetypes';
import { SidewalkGraph } from '@sim/peds/sidewalk';

/**
 * What the fuzzer asserts about a built WORLD after every gesture.
 *
 * Each check returns defects rather than throwing, tagged with a category, so
 * the shrinker can ask "does this sequence still produce THAT defect" and a
 * run can be tallied by kind.
 */
export type WorldCategory =
  | 'exception'
  | 'nonFinite'
  | 'surfaceGap'
  | 'elevationStep'
  | 'nodeHeightMismatch'
  | 'trimOrder'
  | 'deadLanelet'
  | 'turnOffSurface'
  | 'sidewalkSplit';

export interface Defect {
  readonly category: string;
  readonly subject: string;
  readonly detail: string;
}

const defect = (category: string, subject: string | number, detail: string): Defect =>
  ({ category, subject: String(subject), detail });

interface Indexed {
  readonly outer: readonly Vec2[];
  readonly holes: readonly (readonly Vec2[])[];
  readonly minX: number; readonly minY: number; readonly maxX: number; readonly maxY: number;
}

/** A merged surface, with a bounding box per polygon so containment stays cheap. */
export class Surface {
  private readonly polys: Indexed[];

  constructor(multi: MultiPoly) {
    this.polys = multi.filter((p) => p[0]).map((polygon) => {
      const outer = (polygon[0] as number[][]).map(([x, y]) => ({ x: x as number, y: y as number }));
      let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
      for (const p of outer) {
        minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
        maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
      }
      const holes = polygon.slice(1).map((ring) => (ring as number[][]).map(([x, y]) => ({ x: x as number, y: y as number })));
      return { outer, holes, minX, minY, maxX, maxY };
    });
  }

  /** Distance from a point to the nearest edge of any polygon (inside or out). */
  edgeDistance(p: Vec2): number {
    let best = Infinity;
    for (const poly of this.polys) {
      if (p.x < poly.minX - best || p.x > poly.maxX + best || p.y < poly.minY - best || p.y > poly.maxY + best) continue;
      for (const ring of [poly.outer, ...poly.holes]) {
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
          best = Math.min(best, segmentDistance(p, ring[j] as Vec2, ring[i] as Vec2));
        }
      }
    }
    return best;
  }

  contains(p: Vec2): boolean {
    for (const poly of this.polys) {
      if (p.x < poly.minX || p.x > poly.maxX || p.y < poly.minY || p.y > poly.maxY) continue;
      if (!inside(p, poly.outer)) continue;
      if (poly.holes.some((hole) => inside(p, hole))) continue;
      return true;
    }
    return false;
  }
}

function segmentDistance(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0;
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

function inside(p: Vec2, ring: readonly Vec2[]): boolean {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i] as Vec2;
    const b = ring[j] as Vec2;
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) hit = !hit;
  }
  return hit;
}

const finite = (p: Vec2): boolean => Number.isFinite(p.x) && Number.isFinite(p.y);

/**
 * Every world invariant, in one pass. `graph` and `sidewalks` are built here
 * the same way `SimWorld.rebuildTopology` builds them.
 */
export function checkWorld(doc: RoadDoc, net: Network): Defect[] {
  const out: Defect[] = [];

  // ---- finite geometry ----------------------------------------------------
  for (const [id, ribbon] of net.ribbons) {
    for (const ring of Object.values(ribbon.rings)) {
      if (ring && !ring.isEmpty && !ring.flatten().every(finite)) out.push(defect('nonFinite', `seg ${id}`, 'ribbon ring'));
    }
  }
  for (const [node, byLevel] of net.junctions) {
    for (const junction of byLevel.values()) {
      for (const ring of junction.rings) {
        if (!ring.isEmpty && !ring.flatten().every(finite)) out.push(defect('nonFinite', `node ${node}`, 'junction ring'));
      }
    }
  }
  for (const [id, trims] of net.trims) {
    for (const value of [...Object.values(trims.a), ...Object.values(trims.b)]) {
      if (!Number.isFinite(value)) out.push(defect('nonFinite', `seg ${id}`, 'trim'));
    }
  }
  if (out.length) return out;

  const asphalt = new Surface(levelPolygons(net, Level.Asphalt));
  const kerb = new Surface(levelPolygons(net, Level.Curb));

  // ---- carriageway continuity: no hole along a road, none at its mouths ---
  for (const [id, ribbon] of net.ribbons) {
    const line = ribbon.full;
    const hw = halfWidth(ribbon.road, Level.Asphalt) * 0.8;
    const step = 1.5;
    let first: string | null = null;
    // The ribbon's own span, plus a band reaching 1.5 units into each junction
    // plate across its mouth - where a seam would open. Deeper inside a plate
    // the kerb legitimately curves in (the outer corner of a bend).
    const trims = net.trims.get(id);
    const from = Math.max(0.5, (trims?.a[Level.Asphalt] ?? 0) - 1.5);
    const to = line.length - Math.max(0.5, (trims?.b[Level.Asphalt] ?? 0) - 1.5);
    for (let s = from; s < to && !first; s += step) {
      const f = line.sampleAt(s);
      for (const across of [-1, 0, 1]) {
        const p = { x: f.p.x + f.n.x * hw * across, y: f.p.y + f.n.y * hw * across };
        // The integer clip grid and the point-in-polygon probe can disagree
        // by micrometres exactly on a mouth boundary. Such a point is on the
        // road; a visible opening has measurable distance from every edge.
        if (!asphalt.contains(p) && asphalt.edgeDistance(p) > 0.005) {
          first = `s=${s.toFixed(1)}/${line.length.toFixed(1)} across=${across} at (${p.x.toFixed(1)}, ${p.y.toFixed(1)})`;
          break;
        }
      }
    }
    if (first) out.push(defect('surfaceGap', `seg ${id}`, first));
  }

  // ---- elevation: continuous along each deck, agreed at each node --------
  const elevation = buildRoadElevation(net, () => 0);
  for (const [id, ribbon] of net.ribbons) {
    const line = ribbon.full;
    let previous: number | null = null;
    let worst = 0;
    let where = 0;
    for (let s = 0; s <= line.length; s += 0.25) {
      const p = line.sampleAt(Math.min(s, line.length)).p;
      const h = elevation.onSegment(id, p.x, p.y);
      if (!Number.isFinite(h)) { out.push(defect('nonFinite', `seg ${id}`, `deck height at s=${s}`)); break; }
      if (previous !== null && Math.abs(h - previous) > worst) { worst = Math.abs(h - previous); where = s; }
      previous = h;
    }
    // A quarter-unit step on a 12 % ramp rises 0.03; 0.25 is a visible cliff.
    if (worst > 0.25) out.push(defect('elevationStep', `seg ${id}`, `jump ${worst.toFixed(2)} at s=${where.toFixed(2)}`));
  }
  for (const [nodeId, node] of doc.nodes) {
    if (node.incident.length < 2) continue;
    const heights = node.incident
      .filter((seg) => net.ribbons.has(seg))
      .map((seg) => elevation.onSegment(seg, node.x, node.y));
    if (heights.length < 2) continue;
    const spread = Math.max(...heights) - Math.min(...heights);
    if (spread > 0.1) out.push(defect('nodeHeightMismatch', `node ${nodeId}`, `legs differ by ${spread.toFixed(2)}`));
  }

  // ---- one trim, read in the right order by everything --------------------
  const graph = new LaneletGraph();
  graph.build(doc, net);
  for (const [segId, seg] of doc.segments) {
    const line = net.polylines.get(doc, segId);
    for (const node of [seg.a, seg.b]) {
      if (doc.degree(node) < 3) continue;
      const mouth = net.mouthDistance(segId, node);
      const crossing = net.crosswalkDistanceAt(segId, node);
      const stop = net.stopLineDistance(segId, node);
      if (crossing > 0 && crossing - CROSSWALK_DEPTH / 2 < mouth - 0.05) {
        out.push(defect('trimOrder', `seg ${segId}@${node}`, `zebra ${crossing.toFixed(2)} starts inside mouth ${mouth.toFixed(2)}`));
      }
      if (crossing > 0 && stop < crossing + CROSSWALK_DEPTH / 2 - 0.05) {
        out.push(defect('trimOrder', `seg ${segId}@${node}`, `stop ${stop.toFixed(2)} on zebra ${crossing.toFixed(2)}`));
      }
      if (stop < mouth - 0.05) out.push(defect('trimOrder', `seg ${segId}@${node}`, `stop ${stop.toFixed(2)} inside mouth ${mouth.toFixed(2)}`));
      // Where the lanelets actually end, measured on the road itself.
      for (const lane of graph.lanelets.values()) {
        if (lane.kind !== 'link' || lane.segment !== segId) continue;
        const end = lane.to === node ? lane.centre.point(lane.centre.n - 1) : lane.from === node ? lane.centre.point(0) : null;
        if (!end) continue;
        const along = line.closestPoint(end).s;
        const fromNode = seg.a === node ? along : line.length - along;
        if (fromNode < mouth - 0.5) {
          out.push(defect('trimOrder', `lane ${lane.id}`, `ends ${fromNode.toFixed(2)} from node, inside mouth ${mouth.toFixed(2)}`));
        }
      }
    }
  }

  // ---- every lane goes somewhere -------------------------------------------
  for (const lane of graph.lanelets.values()) {
    if (lane.kind !== 'link' || lane.to === undefined) continue;
    if (doc.degree(lane.to) < 2) continue;
    if (!(graph.outbound.get(lane.to) ?? []).length) continue;
    if (graph.exitsOf(lane.id).length === 0) out.push(defect('deadLanelet', lane.id, `no exit at node ${lane.to}`));
  }

  // ---- the largest body stays on asphalt or kerb through every turn -------
  const largest = ARCHETYPES.reduce((a, b) => (b.length > a.length ? b : a));
  for (const connector of graph.connectors.values()) {
    const inbound = graph.lanelets.get(connector.fromLane);
    const crossing = graph.lanelets.get(connector.lanelet);
    const outbound = graph.lanelets.get(connector.toLane);
    if (!inbound || !crossing || !outbound) continue;
    const off = worstOffSurface(inbound, crossing, outbound, largest.length, largest.width, asphalt, kerb);
    if (off && off.by > TURN_TOLERANCE) {
      out.push(defect('turnOffSurface', connector.id,
        `${connector.turn} ${off.by.toFixed(2)} outside at (${off.p.x.toFixed(1)}, ${off.p.y.toFixed(1)})`));
    }
  }

  // ---- the footway graph holds together at every junction -----------------
  const sidewalks = new SidewalkGraph();
  sidewalks.build(doc, net, graph);
  for (const [nodeId, node] of doc.nodes) {
    if (node.incident.length < 2) continue;
    // Limited-access shoulders are not public footways. A junction containing
    // one is intentionally absent from the pedestrian graph, so connectivity
    // across that road is not a sidewalk invariant.
    if (node.incident.some((id) => {
      const segment = doc.segment(id);
      return segment && !carriesPedestrians(roadProfile(segment.type, segment.lanes, segment.direction));
    })) continue;
    const split = footwaySplit(sidewalks, net, nodeId);
    if (split) out.push(defect('sidewalkSplit', `node ${nodeId}`, split));
  }

  return out;
}

/**
 * How far a body corner may leave the kerb's outer edge, in world units. A
 * corner a few centimetres over the kerb line is paint, not a crash.
 */
export const TURN_TOLERANCE = Number(process.env['FUZZ_TURN_TOLERANCE'] ?? 0.25);

/** The body corner furthest outside asphalt and kerb over one movement, if any. */
function worstOffSurface(
  inbound: Lanelet, crossing: Lanelet, outbound: Lanelet, length: number, width: number,
  asphalt: Surface, kerb: Surface,
): { p: Vec2; by: number } | null {
  let worst: { p: Vec2; by: number } | null = null;
  const samples = Math.max(16, Math.ceil((crossing.length + length) / 1.5));
  for (let i = 0; i <= samples; i++) {
    const front = ((crossing.length + length) * i) / samples;
    const centre = front - length / 2;
    // Only where the whole body is on these three lanes: behind a short
    // inbound lane it is on some upstream lane this check knows nothing of,
    // and clamping it to the lane's start would hang it off the road.
    if (front - length < -inbound.length || front > crossing.length + outbound.length) continue;
    // A connector where a road simply runs on has no length, and no tangent.
    const frame = centre < 0 || (crossing.length < 1e-3 && centre === 0)
      ? inbound.centre.sampleAt(inbound.length + centre)
      : centre <= crossing.length && crossing.length >= 1e-3
        ? crossing.centre.sampleAt(centre)
        : outbound.centre.sampleAt(centre - crossing.length);
    for (const along of [-0.5, 0, 0.5]) {
      for (const across of [-0.5, 0.5]) {
        const p = {
          x: frame.p.x + frame.t.x * along * length - frame.t.y * across * width,
          y: frame.p.y + frame.t.y * along * length + frame.t.x * across * width,
        };
        if (asphalt.contains(p) || kerb.contains(p)) continue;
        const by = kerb.edgeDistance(p);
        if (!worst || by > worst.by) worst = { p, by };
      }
    }
  }
  return worst;
}

/** Every kerb must connect to its neighbouring footway, and only to a painted crossing. */
function footwaySplit(graph: SidewalkGraph, net: Network, node: NodeId): string | null {
  for (const kerb of graph.nodes.values()) {
    if (kerb.node !== node) continue;
    const edges = graph.edgesAt(kerb.id).map((id) => graph.edges.get(id));
    const corners = edges.filter((edge) => edge?.kind === 'corner');
    const crossings = edges.filter((edge) => edge?.kind === 'crossing');
    const painted = net.crosswalkDistanceAt(kerb.segment, node) > 0;
    if (corners.length !== 1 || crossings.length !== Number(painted)) {
      return `${kerb.id}: ${corners.length} corner links, ${crossings.length} crossings, painted=${painted}`;
    }
  }
  return null;
}

export type { SegmentId };
