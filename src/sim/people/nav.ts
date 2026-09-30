import type { MultiPoly } from '@core/clipper';
import { CROSSWALK_DEPTH } from '@world/approach';
import { footprintRects } from '@world/buildings/geometry';
import type { SegmentId } from '@world/ids';
import { buildNavMesh, FOOTWAY, type NavCrossingInput, type NavInput, type NavMesh, type NavObstacle } from '@world/nav/navmesh';
import { signalPosts, SIGNAL_POST_RADIUS } from '@world/signalPosts';
import { blocksPedestrians, streetFurniture } from '@world/streetFurniture';
import type { RoadStructure } from '@world/structures';
import { bands, surfaces } from '@world/surfaces';
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
  /** When it was built. */
  readonly trafficRevision: number;
  readonly buildingsRevision: number;
  readonly utilityRevision: number;
}

const DECKS: readonly RoadStructure[] = ['ground', 'elevated', 'bridge', 'tunnel'];

/** Builds the walkable mesh from the map as it stands. */
export function buildWorldNav(w: SimWorld): WorldNav {
  const net = w.net;
  const structureOf = (id: SegmentId): RoadStructure => net.doc.segment(id)?.structure ?? 'ground';
  const layers: MultiPoly[] = [];
  const layerOf = new Map<RoadStructure, number>();
  for (const deck of DECKS) {
    let any = false;
    for (const id of net.ribbons.keys()) if (structureOf(id) === deck) { any = true; break; }
    if (!any) continue;
    layerOf.set(deck, layers.length);
    layers.push(bands(surfaces(net, (id) => structureOf(id) === deck)).footway);
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
  for (const item of streetFurniture(net)) {
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

  const input: NavInput = {
    layers,
    crossingLayers,
    road: surfaces(net).curb,
    crossings,
    obstacles,
    solids,
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
    if (region !== FOOTWAY) { segment[t] = crossingSegment[region]!; continue; }
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

  return {
    mesh, segment, crossingIds, crossingNode, crossingSegment,
    trafficRevision: net.trafficRevision,
    buildingsRevision: w.doc.buildings.revision,
    utilityRevision: w.doc.utilityRevision,
  };
}
