import type { MultiPoly } from '@core/clipper';
import { CROSSWALK_DEPTH } from '@world/approach';
import { footprintRects } from '@world/buildings/geometry';
import type { SegmentId } from '@world/ids';
import { buildNavMesh, FOOTWAY, KERB, isZebra, type NavCrossingInput, type NavInput, type NavMesh, type NavObstacle, type NavStrip } from '@world/nav/navmesh';
import { Level, halfWidth } from '@world/roadTypes';
import { m } from '@world/units';
import { signalPosts, SIGNAL_POST_RADIUS } from '@world/signalPosts';
import { blocksPedestrians, streetFurniture } from '@world/streetFurniture';
import type { RoadStructure } from '@world/structures';
import { difference } from '@core/clipper';
import { surfaces } from '@world/surfaces';
import { POLE_BASE_RADIUS } from '@world/utilities';
import type { CrossingId } from '../signals/plan';
import type { SimWorld } from '../world';

/** The navmesh of the current map, with what the simulation needs to read it. */
export interface WorldNav {
  readonly mesh: NavMesh;
  /** Per triangle: the road whose deck it lies on (for its height), or -1. */
  readonly segment: Int32Array;
  /** Per crossing index of the mesh: its id, as signals and vehicles know it. */
  readonly crossingIds: readonly CrossingId[];
  /** Per crossing index: the node and the road it crosses. */
  readonly crossingNode: readonly number[];
  readonly crossingSegment: readonly SegmentId[];
  /**
   * Where people come from and go to: building doors, and the footway at the
   * end of a road that runs off the map. Nobody appears or vanishes anywhere
   * else once the city is populated.
   */
  readonly sources: readonly { readonly x: number; readonly y: number; readonly t: number; readonly door: boolean }[];
  /**
   * Every bench seat: where a sitter stands in front of it (on the mesh),
   * the way they face (the footway, back to the backrest) and a key.
   */
  readonly seats: readonly {
    readonly key: string;
    /** Where the sitter stands, just in front of the seat (off the mesh: benches stand at its edge). */
    readonly x: number;
    readonly y: number;
    /** The nearest point of the mesh, walked to first, and its triangle. */
    readonly mx: number;
    readonly my: number;
    readonly t: number;
    readonly face: number;
  }[];
  /** When it was built. */
  readonly trafficRevision: number;
  readonly buildingsRevision: number;
  readonly utilityRevision: number;
}

const DECKS: readonly RoadStructure[] = ['ground', 'elevated', 'bridge', 'tunnel'];
/** Mean authored height above which a road at grade is walked as a raised deck, u. */
const RAISED_BY_HAND = m(2.5);
/** Seats either side of a bench's centre, and how far in front of the seat a sitter stands. */
const SEAT_OFFSET = m(0.45);
const STAND_IN_FRONT = m(0.48);
/** Farthest a seat may be from the walkable mesh, u. */
const SEAT_REACH = m(1.5);

/** Builds the walkable mesh from the map as it stands. */
export function buildWorldNav(w: SimWorld): WorldNav {
  const net = w.net;
  // The deck a road's footways belong to. A road at grade raised by hand
  // (its own heights) is a viaduct for whoever walks it: kept with the raised
  // decks. With the roads at grade, its footways merged with those below it
  // and people walked off its edge, and the ground footway beside it took its
  // height - walkers drawn in the air beside the deck.
  const structureOf = (id: SegmentId): RoadStructure => {
    const seg = net.doc.segment(id);
    const structure = seg?.structure ?? 'ground';
    if (!seg || structure !== 'ground') return structure;
    const lift = ((net.doc.node(seg.a)?.heightOffset ?? 0) + (net.doc.node(seg.b)?.heightOffset ?? 0)) / 2;
    return lift > RAISED_BY_HAND ? 'elevated' : 'ground';
  };
  const layers: MultiPoly[] = [];
  const kerbs: MultiPoly[] = [];
  const layerOf = new Map<RoadStructure, number>();
  for (const deck of DECKS) {
    let any = false;
    for (const id of net.ribbons.keys()) if (structureOf(id) === deck) { any = true; break; }
    if (!any) continue;
    layerOf.set(deck, layers.length);
    // The footway proper: the kerb stone is not walked along (a player reads
    // a walker on it, squeezed between a street tree and the road, as lost).
    const deckSurfaces = surfaces(net, (id) => structureOf(id) === deck);
    layers.push(difference(deckSurfaces.sidewalk, deckSurfaces.curb));
    kerbs.push(difference(deckSurfaces.curb, deckSurfaces.asphalt));
  }

  const crossings: NavCrossingInput[] = [];
  const crossingIds: CrossingId[] = [];
  const crossingNode: number[] = [];
  const crossingSegment: SegmentId[] = [];
  const crossingLayers: number[] = [];
  for (const [id, edgeId] of [...w.sidewalks.crossings].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const edge = w.sidewalks.edges.get(edgeId);
    if (!edge || edge.node === undefined || edge.segment === undefined) continue;
    const a = edge.path.point(0);
    const b = edge.path.point(edge.path.n - 1);
    crossings.push({ id, ax: a.x, ay: a.y, bx: b.x, by: b.y, halfWidth: CROSSWALK_DEPTH / 2 });
    crossingIds.push(id);
    crossingNode.push(edge.node);
    crossingSegment.push(edge.segment);
    crossingLayers.push(layerOf.get(structureOf(edge.segment)) ?? 0);
  }

  const obstacles: NavObstacle[] = [];
  const benches: { x: number; y: number; face: number; key: string }[] = [];
  for (const item of streetFurniture(net)) {
    if (item.kind === 'bench' && blocksPedestrians(item)) {
      const face = Math.atan2(-item.outward.y, -item.outward.x);
      for (const k of [-1, 1]) {
        const sx = item.x + item.along.x * SEAT_OFFSET * k, sy = item.y + item.along.y * SEAT_OFFSET * k;
        benches.push({ x: sx + Math.cos(face) * STAND_IN_FRONT, y: sy + Math.sin(face) * STAND_IN_FRONT, face, key: `${Math.round(item.x * 10)}:${Math.round(item.y * 10)}:${k}` });
      }
    }
    if (!blocksPedestrians(item)) continue;
    if (item.halfLength !== undefined && item.halfWidth !== undefined) {
      const count = Math.max(1, Math.ceil(item.halfLength / item.halfWidth));
      for (let i = 0; i <= count; i++) {
        const t = -item.halfLength + (2 * item.halfLength * i) / count;
        obstacles.push({ x: item.x + item.along.x * t, y: item.y + item.along.y * t, r: item.halfWidth });
      }
    } else obstacles.push({ x: item.x, y: item.y, r: item.radius });
  }
  for (const post of signalPosts(net, w.graph)) obstacles.push({ x: post.x, y: post.y, r: SIGNAL_POST_RADIUS });
  for (const pole of w.doc.poles.values()) obstacles.push({ x: pole.x, y: pole.y, r: POLE_BASE_RADIUS });

  const solids = [...w.doc.buildings.all()].flatMap((b) => footprintRects(b));

  // Paths to doors, run half a metre on past the door into the building, so
  // the door itself stands on the mesh once the footprint is cut out.
  const paths: NavStrip[] = [];
  const doors: { x: number; y: number }[] = [];
  for (const edge of w.sidewalks.edges.values()) {
    if (edge.kind !== 'access') continue;
    const a = edge.path.point(0), b = edge.path.point(edge.path.n - 1);
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len < 1e-6) continue;
    const ux = (b.x - a.x) / len, uy = (b.y - a.y) / len;
    paths.push({ ax: a.x, ay: a.y, bx: b.x + ux * m(0.5), by: b.y + uy * m(0.5), halfWidth: Math.max(edge.halfWidth, m(0.5)) });
    doors.push({ x: b.x, y: b.y });
  }
  // Road ends: the footway beside the last metres of a road that leads off.
  const ends: { x: number; y: number }[] = [];
  for (const [id, ribbon] of net.ribbons) {
    const seg = net.doc.segment(id);
    if (!seg) continue;
    for (const [node, atStart] of [[seg.a, true], [seg.b, false]] as const) {
      if (net.doc.degree(node) !== 1) continue;
      const s = atStart ? m(1.5) : ribbon.full.length - m(1.5);
      const f = ribbon.full.sampleAt(Math.max(0, Math.min(ribbon.full.length, s)));
      const lateral = (halfWidth(ribbon.road, Level.Curb) + halfWidth(ribbon.road, Level.Sidewalk)) / 2;
      for (const side of [1, -1]) ends.push({ x: f.p.x + f.n.x * lateral * side, y: f.p.y + f.n.y * lateral * side });
    }
  }

  const input: NavInput = {
    layers,
    crossingLayers,
    road: surfaces(net).asphalt,
    kerbs,
    crossings,
    obstacles,
    solids,
    paths,
  };
  const mesh = buildNavMesh(input);

  // Each triangle's road, for the height it is drawn at: the nearest ribbon
  // of its own deck. Zebras belong to the road they cross.
  const segment = new Int32Array(mesh.count).fill(-1);
  const CELL = 24;
  const grid = new Map<string, SegmentId[]>();
  for (const [id, ribbon] of net.ribbons) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < ribbon.full.n; i++) {
      const p = ribbon.full.point(i);
      x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y);
    }
    const pad = 40;
    for (let cx = Math.floor((x0 - pad) / CELL); cx <= Math.floor((x1 + pad) / CELL); cx++) {
      for (let cy = Math.floor((y0 - pad) / CELL); cy <= Math.floor((y1 + pad) / CELL); cy++) {
        const key = `${cx},${cy}`;
        const list = grid.get(key);
        if (list) list.push(id);
        else grid.set(key, [id]);
      }
    }
  }
  const decks = [...layerOf.entries()];
  for (let t = 0; t < mesh.count; t++) {
    const region = mesh.region[t]!;
    if (isZebra(region)) { segment[t] = crossingSegment[region]!; continue; }
    if (region !== FOOTWAY && region !== KERB) continue;
    const deck = decks.find(([, i]) => i === mesh.layer[t])?.[0] ?? 'ground';
    const c = mesh.centroid(t);
    let best = -1;
    let bestD = Infinity;
    for (const id of grid.get(`${Math.floor(c.x / CELL)},${Math.floor(c.y / CELL)}`) ?? []) {
      if (structureOf(id) !== deck) continue;
      const d = net.ribbons.get(id)!.full.closestPoint(c).distance;
      if (d < bestD) { bestD = d; best = id; }
    }
    segment[t] = best;
  }

  const seats: { key: string; x: number; y: number; mx: number; my: number; t: number; face: number }[] = [];
  for (const b of benches) {
    const at = mesh.nearest(b.x, b.y, SEAT_REACH);
    if (at && mesh.region[at.t] === FOOTWAY) seats.push({ key: b.key, x: b.x, y: b.y, mx: at.x, my: at.y, t: at.t, face: b.face });
  }
  const sources: { x: number; y: number; t: number; door: boolean }[] = [];
  for (const [list, door] of [[doors, true], [ends, false]] as const) {
    for (const p of list) {
      const at = mesh.nearest(p.x, p.y, m(1.5));
      if (at && mesh.region[at.t]! < 0) sources.push({ x: at.x, y: at.y, t: at.t, door });
    }
  }

  return {
    mesh, segment, sources, seats, crossingIds, crossingNode, crossingSegment,
    trafficRevision: net.trafficRevision,
    buildingsRevision: w.doc.buildings.revision,
    utilityRevision: w.doc.utilityRevision,
  };
}
