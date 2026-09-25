import type { MultiPoly } from '@core/clipper';
import type { Vec2 } from '@core/vec2';
import type { RoadDoc } from '@world/doc';
import type { Network } from '@world/network';
import type { NodeId, SegmentId } from '@world/ids';
import { CROSSWALK_DEPTH } from '@world/approach';
import { buildRoadElevation } from '@world/elevation';
import { LaneletGraph, type Lanelet } from '@world/lanelets';
import { Level, halfWidth } from '@world/roadTypes';
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
    for (let s = 0.5; s < line.length - 0.5 && !first; s += step) {
      const f = line.sampleAt(s);
      for (const across of [-1, 0, 1]) {
        const p = { x: f.p.x + f.n.x * hw * across, y: f.p.y + f.n.y * hw * across };
        if (!asphalt.contains(p)) {
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
    const off = firstOffSurface(inbound, crossing, outbound, largest.length, largest.width, asphalt, kerb);
    if (off) out.push(defect('turnOffSurface', connector.id, `${connector.turn} at (${off.x.toFixed(1)}, ${off.y.toFixed(1)})`));
  }

  // ---- the footway graph holds together at every junction -----------------
  const sidewalks = new SidewalkGraph();
  sidewalks.build(doc, net, graph);
  for (const [nodeId, node] of doc.nodes) {
    if (node.incident.length < 2) continue;
    const split = footwaySplit(sidewalks, nodeId);
    if (split) out.push(defect('sidewalkSplit', `node ${nodeId}`, split));
  }

  return out;
}

function firstOffSurface(
  inbound: Lanelet, crossing: Lanelet, outbound: Lanelet, length: number, width: number,
  asphalt: Surface, kerb: Surface,
): Vec2 | null {
  const samples = Math.max(16, Math.ceil((crossing.length + length) / 1.5));
  for (let i = 0; i <= samples; i++) {
    const front = ((crossing.length + length) * i) / samples;
    const centre = front - length / 2;
    const frame = centre < 0
      ? inbound.centre.sampleAt(Math.max(0, inbound.length + centre))
      : centre <= crossing.length
        ? crossing.centre.sampleAt(centre)
        : outbound.centre.sampleAt(Math.min(outbound.length, centre - crossing.length));
    for (const along of [-0.5, 0, 0.5]) {
      for (const across of [-0.5, 0.5]) {
        const p = {
          x: frame.p.x + frame.t.x * along * length - frame.t.y * across * width,
          y: frame.p.y + frame.t.y * along * length + frame.t.x * across * width,
        };
        if (!asphalt.contains(p) && !kerb.contains(p)) return p;
      }
    }
  }
  return null;
}

/** Null when every kerb node of the junction reaches every other by corners and zebras. */
function footwaySplit(graph: SidewalkGraph, node: NodeId): string | null {
  const kerbs = [...graph.nodes.values()].filter((k) => k.node === node).map((k) => k.id);
  if (kerbs.length < 2) return null;
  const seen = new Set<string>([kerbs[0] as string]);
  const queue = [kerbs[0] as string];
  while (queue.length) {
    const at = queue.pop() as string;
    for (const edgeId of graph.edgesAt(at)) {
      const edge = graph.edges.get(edgeId);
      if (!edge || edge.kind === 'walk') continue;
      const next = graph.other(edge, at);
      if (!seen.has(next)) { seen.add(next); queue.push(next); }
    }
  }
  const missing = kerbs.filter((k) => !seen.has(k));
  return missing.length ? `${missing.length}/${kerbs.length} kerbs unreachable: ${missing.slice(0, 3).join(', ')}` : null;
}

export type { SegmentId };
