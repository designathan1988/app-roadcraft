import { FloatArray, NavMeshQuery, Raw, type NavMesh } from '@recast-navigation/core';
import { generateTiledNavMesh } from '@recast-navigation/generators';
import type { Vec2 } from '@core/vec2';
import { m } from '@world/units';
import { CURB_BAND } from '@world/roadTypes';
import { bandMid, sectionOf } from '@world/section';
import type { SegmentId } from '@world/ids';
import { buildRoadElevation, type RoadElevation } from '@world/elevation';
import { buildWalkways, type WalkGraph, type Walkway } from '@world/walkways';
import { blocksPedestrians, streetFurniture } from '@world/streetFurniture';
import { signalPosts, SIGNAL_POST_RADIUS } from '@world/signalPosts';
import { POLE_BASE_RADIUS } from '@world/utilities';
import { makeCrossingId } from '../signals/plan';
import type { SidewalkEdge } from '../peds/sidewalk';
import type { SimWorld } from '../world';
import { buildCrowdSpatial, type CrowdSpatial } from './crowdIndex';

/**
 * THE WALKABLE SPACE of the crowd engine (`crowd.ts`), as a Recast
 * navigation mesh (Recast/Detour, via recast-navigation, MIT).
 *
 * Built from the pedestrian network (`world/walkways.ts`), not from what the
 * renderer happens to leave over: each footway, corner and crossing is a
 * strip of walkable surface as wide as its walkway reaches (kerb to footway
 * edge; the zebra's painted width), a path to each building door likewise,
 * at the height of its own road (so a viaduct's footway lies over the road
 * below it, and a ramp's footway climbs from the ground). Street furniture,
 * signal posts and utility poles stand on it as solid posts. Recast
 * voxelises it, erodes it by a body's radius and builds the polygon mesh
 * Detour's crowd walks: every wall, edge and obstacle is part of the space,
 * not a correction applied afterwards.
 *
 * Coordinates: Recast's (x, y up, z) is the game's (x, height, y).
 */

/**
 * A body's radius and height, u (0.27 m, 1.8 m): the footprint of the bodies
 * as DRAWN. Photographed from above standing side by side (2026-10-01,
 * `docs/audit/2026-10-01/body/`), the citizens' shoulders and hands reach
 * 0.25-0.27 m from their centre; at 0.22 m two people at the closest the
 * crowd lets them stand had their arms inside each other. Where a passage
 * is too narrow for this body, it is too narrow: the mesh says so.
 */
export const AGENT_RADIUS = m(0.27);
export const AGENT_HEIGHT = m(1.8);

export interface Zebra {
  /** The crossing's walkway in the network, and its id for permission and the cars. */
  readonly way: number;
  readonly id: string;
  readonly edge: SidewalkEdge;
  /**
   * Its painted band: the centreline from `a` to `b` (each end in the
   * middle of a footway) and half its width; and how far in from either end
   * the carriageway begins - the part of the band that is road.
   */
  readonly a: Vec2;
  readonly b: Vec2;
  readonly half: number;
  readonly kerb: number;
}

export interface CrowdNav {
  readonly navMesh: NavMesh;
  readonly query: NavMeshQuery;
  readonly graph: WalkGraph;
  readonly elevation: RoadElevation;
  readonly zebras: readonly Zebra[];
  /** The road each walkway's height is taken from. */
  readonly roadOf: readonly (SegmentId | undefined)[];
  /** Places people come from and go to: footway ends that run off the map, and doors. */
  readonly sources: readonly Vec2[];
  /** Footway walkways by cumulative length, for random destinations. */
  readonly footways: readonly number[];
  readonly footLength: readonly number[];
  /** Passages one person wide (`findNarrows`). */
  readonly narrows: readonly Narrow[];
  /** Conservative static candidates, in the same order as the source arrays. */
  readonly spatial: CrowdSpatial;
}

/**
 * A PASSAGE ONE PERSON WIDE: a stretch of walkway where, by the walkable
 * ground itself (the mesh, eroded by a body's radius), no two bodies fit
 * side by side - between a bin and a building's edge, a gap in a fence, a
 * post on a narrow footway. People going opposite ways cannot pass each
 * other in it. The stretch runs from `a` to `b` (its axis, `dir` a to b);
 * anyone within `reach` of that axis is in it.
 */
export interface Narrow {
  readonly id: number;
  readonly a: Vec2;
  readonly b: Vec2;
  readonly dir: Vec2;
  readonly reach: number;
  /** The widest way through it for the centre of a body, u (less than two radii). */
  readonly width: number;
}

/** Recast's settings, in world units (cells of 0.1 m). */
const CS = m(0.1);
const CH = m(0.05);

/**
 * Tile size, cells: 128 (6.4 m), doubled until the map fits in `MAX_TILES`.
 * Detour numbers tiles in at most 14 bits (recast-navigation caps it): the
 * player's city, 1.3 km across, wanted 46,000 tiles of 128 cells, and the
 * WebAssembly aborted building it.
 */
const MAX_TILES = 4096;
function tileSizeFor(positions: readonly number[]): number {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    minX = Math.min(minX, positions[i]!); maxX = Math.max(maxX, positions[i]!);
    minZ = Math.min(minZ, positions[i + 2]!); maxZ = Math.max(maxZ, positions[i + 2]!);
  }
  let size = 128;
  while (Math.ceil((maxX - minX) / (size * CS)) * Math.ceil((maxZ - minZ) / (size * CS)) > MAX_TILES) size *= 2;
  return size;
}

export function buildCrowdNav(w: SimWorld): CrowdNav | null {
  const net = w.net;
  const tW = performance.now();
  const graph = buildWalkways(net);
  if (graph.ways.length === 0) return null;
  // Road heights on flat ground: the decks stand apart where they cross, and
  // the renderer lays them on the terrain itself.
  const elevation = buildRoadElevation(net, () => 0);
  const roadOf = graph.ways.map((way) => wayRoad(w, way));

  const positions: number[] = [];
  const indices: number[] = [];
  const vertex = (x: number, h: number, y: number): number => {
    positions.push(x, h, y);
    return positions.length / 3 - 1;
  };
  // Every triangle facing up (Recast reads walkable floor from its normal).
  const tri = (a: number, b: number, c: number): void => {
    const ax = positions[a * 3]!, az = positions[a * 3 + 2]!;
    const bx = positions[b * 3]!, bz = positions[b * 3 + 2]!;
    const cx = positions[c * 3]!, cz = positions[c * 3 + 2]!;
    // y of (b - a) x (c - a) with y up: (bz - az)(cx - ax) - (bx - ax)(cz - az)
    const ny = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
    if (ny >= 0) indices.push(a, b, c);
    else indices.push(a, c, b);
  };
  const heightAt = (seg: SegmentId | undefined, x: number, y: number): number =>
    seg === undefined ? elevation.at(x, y) : elevation.onSegment(seg, x, y);

  // --- walkways: a strip from `lo` to `hi` either side of each path
  for (const way of graph.ways) {
    const pts = way.path.toPoints();
    if (pts.length < 2) continue;
    // People walk on the kerb stone too: the strip reaches the carriageway's edge.
    const lo = way.kerb < 0 ? way.lo - CURB_BAND : way.lo, hi = way.kerb > 0 ? way.hi + CURB_BAND : way.hi;
    const left = sideOffsets(pts, hi), right = sideOffsets(pts, lo);
    const seg = roadOf[way.id];
    const L: number[] = [], R: number[] = [];
    for (let i = 0; i < pts.length; i++) {
      const l = left[i]!, r = right[i]!;
      L.push(vertex(l.x, heightAt(seg, pts[i]!.x, pts[i]!.y), l.y));
      R.push(vertex(r.x, heightAt(seg, pts[i]!.x, pts[i]!.y), r.y));
    }
    for (let i = 0; i + 1 < pts.length; i++) {
      tri(L[i]!, L[i + 1]!, R[i + 1]!);
      tri(L[i]!, R[i + 1]!, R[i]!);
    }
  }
  // --- paths to doors
  for (const edge of w.sidewalks.edges.values()) {
    if (edge.kind !== 'access') continue;
    const a = edge.path.point(0), b = edge.path.point(edge.path.n - 1);
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len < 1e-6) continue;
    const ux = (b.x - a.x) / len, uy = (b.y - a.y) / len;
    const half = Math.max(edge.halfWidth, m(0.6));
    const end = { x: b.x + ux * m(0.5), y: b.y + uy * m(0.5) };
    const h = elevation.at(a.x, a.y);
    const q = [
      vertex(a.x - uy * half, h, a.y + ux * half), vertex(end.x - uy * half, h, end.y + ux * half),
      vertex(end.x + uy * half, h, end.y - ux * half), vertex(a.x + uy * half, h, a.y - ux * half),
    ];
    tri(q[0]!, q[1]!, q[2]!);
    tri(q[0]!, q[2]!, q[3]!);
  }
  // --- solid posts: street furniture, signal posts, utility poles
  const obstacles: { x: number; y: number; r: number }[] = [];
  const post = (x: number, y: number, r: number, h: number): void => {
    obstacles.push({ x, y, r });
    const n = 8, top = h + AGENT_HEIGHT, foot = h - m(0.3);
    const ring: [number, number][] = [];
    for (let k = 0; k < n; k++) ring.push([x + Math.cos((k / n) * Math.PI * 2) * r, y + Math.sin((k / n) * Math.PI * 2) * r]);
    const lowI = ring.map(([px, py]) => vertex(px, foot, py));
    const highI = ring.map(([px, py]) => vertex(px, top, py));
    for (let k = 0; k < n; k++) {
      const k2 = (k + 1) % n;
      indices.push(lowI[k]!, highI[k]!, highI[k2]!, lowI[k]!, highI[k2]!, lowI[k2]!);
    }
    for (let k = 1; k + 1 < n; k++) tri(highI[0]!, highI[k]!, highI[k + 1]!);
  };
  for (const item of streetFurniture(net)) {
    if (!blocksPedestrians(item)) continue;
    const h = elevation.onSegment(item.segment, item.x, item.y);
    if (item.halfLength !== undefined && item.halfWidth !== undefined) {
      // A bench: a row of posts along it.
      const count = Math.max(1, Math.ceil(item.halfLength / item.halfWidth));
      for (let i = 0; i <= count; i++) {
        const t = -item.halfLength + (2 * item.halfLength * i) / count;
        post(item.x + item.along.x * t, item.y + item.along.y * t, item.halfWidth, h);
      }
    } else post(item.x, item.y, item.radius, h);
  }
  for (const p of signalPosts(net, w.graph)) post(p.x, p.y, SIGNAL_POST_RADIUS, elevation.at(p.x, p.y));
  for (const pole of w.doc.poles.values()) post(pole.x, pole.y, POLE_BASE_RADIUS, elevation.at(pole.x, pole.y));

  // Zebras, their permission edges and bands.
  const zebras: Zebra[] = [];
  for (const way of graph.ways) {
    if (way.kind !== 'crossing' || way.node === undefined || way.segment === undefined) continue;
    const id = makeCrossingId(way.node, way.segment);
    const edgeId = w.sidewalks.crossings.get(id);
    const edge = edgeId !== undefined ? w.sidewalks.edges.get(edgeId) : undefined;
    if (!edge) continue;
    const pts = way.path.toPoints();
    const seg = w.doc.requireSegment(way.segment);
    const ribbon = net.ribbons.get(way.segment);
    const section = ribbon ? sectionOf(ribbon.road, seg.direction) : null;
    const kerb = section ? Math.max(0, bandMid(section.side.through) - section.carriageway) : 0;
    zebras.push({ way: way.id, id, edge, a: pts[0]!, b: pts[pts.length - 1]!, half: (way.hi - way.lo) / 2, kerb });
  }

  const tR = performance.now();
  const result = withZebraAreas(zebras, (z, x, y) => heightAt(roadOf[z.way], x, y), () => generateTiledNavMesh(positions, indices, {
    cs: CS,
    ch: CH,
    tileSize: tileSizeFor(positions),
    walkableSlopeAngle: 50,
    walkableHeight: Math.ceil(AGENT_HEIGHT / CH),
    walkableClimb: Math.ceil(m(0.3) / CH),
    walkableRadius: Math.ceil(AGENT_RADIUS / CS),
    borderSize: Math.ceil(AGENT_RADIUS / CS) + 3,
    maxEdgeLen: Math.ceil(m(4) / CS),
    maxSimplificationError: 1.1,
    minRegionArea: 8,
    mergeRegionArea: 40,
    maxVertsPerPoly: 6,
    detailSampleDist: 6,
    detailSampleMaxError: 1,
  }));
  if (!result.success) return null;
  const navMesh = result.navMesh;
  flagZebras(navMesh);
  const query = new NavMeshQuery(navMesh);
  // Sources: footway ends at roads that run off the map, and doors.
  const sources: Vec2[] = [];
  for (const way of graph.ways) {
    if (way.kind !== 'footway' || way.segment === undefined) continue;
    const seg = w.doc.segment(way.segment);
    if (!seg) continue;
    for (const end of [way.a, way.b]) {
      if ((graph.at.get(end)?.length ?? 0) !== 1) continue;
      const node = graph.nodes[end]!;
      const offMap = [seg.a, seg.b].some((n) => w.doc.degree(n) === 1 &&
        Math.hypot(w.doc.requireNode(n).x - node.x, w.doc.requireNode(n).y - node.y) < m(20));
      if (offMap) sources.push({ x: node.x, y: node.y });
    }
  }
  for (const edge of w.sidewalks.edges.values()) if (edge.kind === 'access') sources.push(edge.path.point(edge.path.n - 1));
  const footways: number[] = [], footLength: number[] = [];
  let total = 0;
  for (const way of graph.ways) {
    if (way.kind !== 'footway' || way.path.length < m(2)) continue;
    total += way.path.length;
    footways.push(way.id);
    footLength.push(total);
  }
  const tN = performance.now();
  const narrows = findNarrows(query, graph, obstacles, (way, x, y) => heightAt(roadOf[way], x, y));
  (globalThis as { __navProfile?: unknown }).__navProfile = { recast: tN - tR, narrows: performance.now() - tN, walkways: tR - tW };
  const spatial = buildCrowdSpatial(zebras, narrows, graph.ways, AGENT_RADIUS);
  return { navMesh, query, graph, elevation, zebras, roadOf, sources, footways, footLength, narrows, spatial };
}

/**
 * ZEBRAS AS THEIR OWN AREA. The road part of each zebra (kerb to kerb) is
 * walkable ground of its own kind: Recast marks it with `ZEBRA_AREA`
 * (`markConvexPolyArea`, Recast's own step for typed areas, between the
 * erosion and the regions, so no polygon is part footway and part road),
 * and its polygons carry `ZEBRA_FLAG` where the rest carries `WALK_FLAG`.
 * A query filter without `ZEBRA_FLAG` makes the road a wall to anybody
 * not let onto it: Detour itself keeps them on the kerb however they are
 * jostled (`crowd.ts` gives each person the filter its permission allows).
 *
 * recast-navigation's tiled generator leaves its "mark areas" step empty;
 * the WebAssembly erosion it calls is wrapped for the build so the zebras
 * are marked right after it, on each tile's heightfield.
 */
export const WALK_FLAG = 1;
export const ZEBRA_FLAG = 2;
const ZEBRA_AREA = 2;

function withZebraAreas<T>(zebras: readonly Zebra[], heightAt: (z: Zebra, x: number, y: number) => number, build: () => T): T {
  const recast = Raw.Recast as unknown as {
    erodeWalkableArea(ctx: unknown, radius: number, chf: unknown): boolean;
    markConvexPolyArea(ctx: unknown, verts: unknown, nverts: number, hmin: number, hmax: number, area: number, chf: unknown): void;
  };
  const erode = recast.erodeWalkableArea;
  const shapes = zebras.map((z) => {
    const len = Math.hypot(z.b.x - z.a.x, z.b.y - z.a.y) || 1;
    const ux = (z.b.x - z.a.x) / len, uy = (z.b.y - z.a.y) / len;
    const nx = -uy, ny = ux;
    const at = (s: number, d: number): [number, number] => [z.a.x + ux * s + nx * d, z.a.y + uy * s + ny * d];
    // From a body's radius before each kerb: whoever waits has all of its body on the footway.
    const from = z.kerb - AGENT_RADIUS, to = len - z.kerb + AGENT_RADIUS;
    const corners = [at(from, -z.half), at(to, -z.half), at(to, z.half), at(from, z.half)];
    const h = heightAt(z, (z.a.x + z.b.x) / 2, (z.a.y + z.b.y) / 2);
    const verts = new FloatArray();
    verts.copy(corners.flatMap(([x, y]) => [x, h, y]));
    return { verts, hmin: h - m(1), hmax: h + m(2) };
  });
  recast.erodeWalkableArea = (ctx, radius, chf) => {
    const ok = erode.call(recast, ctx, radius, chf);
    if (ok) for (const s of shapes) recast.markConvexPolyArea(ctx, s.verts.raw, 4, s.hmin, s.hmax, ZEBRA_AREA, chf);
    return ok;
  };
  try {
    return build();
  } finally {
    recast.erodeWalkableArea = erode;
    for (const s of shapes) s.verts.destroy();
  }
}

/** Flags each polygon by its area: the zebras' `ZEBRA_FLAG`, everything else `WALK_FLAG`. */
function flagZebras(navMesh: NavMesh): void {
  for (let i = 0; i < navMesh.getMaxTiles(); i++) {
    const tile = navMesh.getTile(i);
    const header = tile.header();
    if (!header) continue;
    const base = navMesh.getPolyRefBase(tile);
    for (let j = 0; j < header.polyCount(); j++) {
      const area = tile.polys(j).areaAndType() & 0x3f;
      navMesh.setPolyFlags(base | j, area === ZEBRA_AREA ? ZEBRA_FLAG : WALK_FLAG);
    }
  }
}

/** Cross-sections of a walkway are probed this far apart along it near an obstacle, and across it, u. */
const PROBE_ALONG = m(0.1);
const PROBE_ACROSS = m(0.15);

/**
 * The passages one person wide, read off the mesh: along each walkway,
 * wherever an obstacle stands near it, each cross-section is probed for the
 * widest stretch of walkable ground across it (rays cast along the mesh to
 * its edges both ways, from walkable points across). The mesh is already
 * eroded by a body's radius, so that stretch is the room for a body's
 * CENTRE: under two radii, two people cannot be side by side there. Such
 * cross-sections in a row make one narrow; narrows of different walkways
 * at the same place (a footway's end and the corner it runs into) are one.
 * Ground with no walkable point across at all is a wall, not a narrow.
 */
function findNarrows(
  query: NavMeshQuery, graph: WalkGraph, obstacles: readonly { x: number; y: number; r: number }[],
  heightAt: (way: number, x: number, y: number) => number,
): Narrow[] {
  const two = 2 * AGENT_RADIUS;
  const found: { a: Vec2; b: Vec2; dir: Vec2; reach: number; width: number }[] = [];
  for (const way of graph.ways) {
    if (way.kind === 'crossing') continue;
    const lo = way.kerb < 0 ? way.lo - CURB_BAND : way.lo, hi = way.kerb > 0 ? way.hi + CURB_BAND : way.hi;
    const reach = Math.max(-lo, hi);
    // Stretches of this walkway near an obstacle.
    const spans: [number, number][] = [];
    for (const o of obstacles) {
      const bb = way.path.bbox, pad = o.r + reach + two;
      if (o.x < bb.minX - pad || o.x > bb.maxX + pad || o.y < bb.minY - pad || o.y > bb.maxY + pad) continue;
      const hit = way.path.closestPoint(o);
      if (hit.distance > pad) continue;
      const half = o.r + two + m(0.3);
      spans.push([Math.max(0, hit.s - half), Math.min(way.path.length, hit.s + half)]);
    }
    if (!spans.length) continue;
    spans.sort((p, q) => p[0] - q[0]);
    let run: { s0: number; s1: number; width: number } | null = null;
    const close = (): void => {
      if (!run) return;
      const s0 = run.s0, s1 = Math.max(run.s1, run.s0 + PROBE_ALONG);
      const pa = way.path.sampleAt(s0).p, pb = way.path.sampleAt(s1).p;
      const t = way.path.sampleAt((s0 + s1) / 2).t;
      found.push({ a: pa, b: pb, dir: { x: t.x, y: t.y }, reach, width: run.width });
      run = null;
    };
    let last = -Infinity;
    for (const [from, to] of spans) {
      for (let s = Math.max(from, last + PROBE_ALONG); s <= to; s += PROBE_ALONG) {
        last = s;
        const f = way.path.sampleAt(s);
        const width = widestAcross(query, f.p, f.n, lo, hi, heightAt(way.id, f.p.x, f.p.y));
        if (width > 0 && width < two) {
          if (run && s - run.s1 <= PROBE_ALONG * 1.5) { run.s1 = s; run.width = Math.min(run.width, width); }
          else { close(); run = { s0: s, s1: s, width }; }
        } else if (run && s - run.s1 > PROBE_ALONG * 1.5) close();
      }
    }
    close();
  }
  // One place found from two walkways (a footway's end and the corner it
  // runs into), and narrows with no room between them to wait outside
  // either, are one narrow: people let into one way at each would meet
  // between them with nowhere to go (traced: a bench and a post 1 m apart).
  const merged: { a: Vec2; b: Vec2; dir: Vec2; reach: number; width: number }[] = [...found];
  for (let changed = true; changed;) {
    changed = false;
    for (let i = 0; i < merged.length && !changed; i++) {
      for (let j = i + 1; j < merged.length && !changed; j++) {
        const n = merged[i]!, f = merged[j]!;
        const gap = Math.min(...[n.a, n.b].flatMap((p) => [f.a, f.b].map((q) => Math.hypot(p.x - q.x, p.y - q.y))));
        if (gap > NARROW_JOIN) continue;
        // Kept along the first one's axis: the extreme ends of both along it.
        const ends = [n.a, n.b, f.a, f.b].map((p) => ({ p, s: (p.x - n.a.x) * n.dir.x + (p.y - n.a.y) * n.dir.y }));
        ends.sort((p, q) => p.s - q.s);
        merged[i] = { ...n, a: ends[0]!.p, b: ends[ends.length - 1]!.p, reach: Math.max(n.reach, f.reach), width: Math.min(n.width, f.width) };
        merged.splice(j, 1);
        changed = true;
      }
    }
  }
  return merged.map((n, id) => ({ id, ...n }));
}

/** Narrows closer than this end to end are one: less than the room to wait outside one, u. */
const NARROW_JOIN = m(2.5);

/** The widest stretch of walkable ground across a walkway at `p` (normal `n`, from `lo` to `hi` along it), u; 0 where none. */
function widestAcross(query: NavMeshQuery, p: Vec2, n: Vec2, lo: number, hi: number, h: number): number {
  let widest = 0;
  let covered = -Infinity;
  const span = hi - lo + m(1);
  for (let d = lo; d <= hi; d += PROBE_ACROSS) {
    if (d <= covered) continue;
    const seed = { x: p.x + n.x * d, y: p.y + n.y * d };
    const at = query.findClosestPoint({ x: seed.x, y: h, z: seed.y }, { halfExtents: { x: m(0.02), y: m(1), z: m(0.02) } });
    if (!at.success || !at.polyRef || Math.hypot(at.point.x - seed.x, at.point.z - seed.y) > m(0.01)) continue;
    const ray = (sign: number): number => {
      const end = { x: seed.x + n.x * sign * span, y: at.point.y, z: seed.y + n.y * sign * span };
      const r = query.raycast(at.polyRef, at.point, end);
      return r.success ? Math.min(1, r.t) * span : 0;
    };
    const up = ray(1), down = ray(-1);
    widest = Math.max(widest, up + down);
    covered = d + up;
  }
  return widest;
}

/** Points `d` to the left of each vertex of a polyline (mitred, one per vertex). */
function sideOffsets(pts: readonly Vec2[], d: number): Vec2[] {
  const out: Vec2[] = [];
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const a = pts[Math.max(0, i - 1)]!, b = pts[Math.min(n - 1, i + 1)]!;
    let nx = 0, ny = 0;
    for (const [p, q] of [[pts[Math.max(0, i - 1)]!, pts[i]!], [pts[i]!, pts[Math.min(n - 1, i + 1)]!]] as const) {
      const dx = q.x - p.x, dy = q.y - p.y, l = Math.hypot(dx, dy);
      if (l > 1e-9) { nx += -dy / l; ny += dx / l; }
    }
    const l = Math.hypot(nx, ny);
    if (l < 1e-9) { const dx = b.x - a.x, dy = b.y - a.y, ll = Math.hypot(dx, dy) || 1; nx = -dy / ll; ny = dx / ll; } else { nx /= l; ny /= l; }
    // Mitre: as far out as the offset lines of the two segments meet, within reason.
    let k = 1;
    if (i > 0 && i < n - 1) {
      const dx = pts[i]!.x - pts[i - 1]!.x, dy = pts[i]!.y - pts[i - 1]!.y, ll = Math.hypot(dx, dy) || 1;
      const c = nx * (-dy / ll) + ny * (dx / ll);
      k = 1 / Math.max(0.5, c);
    }
    out.push({ x: pts[i]!.x + nx * d * k, y: pts[i]!.y + ny * d * k });
  }
  return out;
}

/** The road a walkway's height comes from: its own, or for a corner the nearest road of its junction. */
function wayRoad(w: SimWorld, way: Walkway): SegmentId | undefined {
  if (way.segment !== undefined) return way.segment;
  const node = way.node !== undefined ? w.doc.node(way.node) : undefined;
  if (!node) return undefined;
  const mid = way.path.sampleAt(way.path.length / 2).p;
  let best: SegmentId | undefined, bd = Infinity;
  for (const id of node.incident) {
    const ribbon = w.net.ribbons.get(id);
    if (!ribbon) continue;
    const d = ribbon.full.closestPoint(mid).distance;
    if (d < bd) { bd = d; best = id; }
  }
  return best;
}
