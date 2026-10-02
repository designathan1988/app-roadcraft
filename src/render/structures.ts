import {
  BoxGeometry,
  BufferGeometry,
  CylinderGeometry,
  Float32BufferAttribute,
  Group,
  InstancedMesh,
  Mesh,
  Object3D,
  type Material,
} from 'three';

import { angleOf } from '@core/vec2';
import type { Frame, Polyline } from '@core/polyline';
import type { Network, SegmentRibbon } from '@world/network';
import type { SegmentId } from '@world/ids';
import type { RoadElevation } from '@world/elevation';
import { Level, casingHalf, roadProfile, sidewalkHalf } from '@world/roadTypes';
import {
  TUNNELS_DRAWN,
  TUNNEL_ARCH,
  TUNNEL_BORE,
  TUNNEL_HEADROOM,
  TUNNEL_PORTAL_COVER,
  isRaised,
  roadStructure,
  type RoadStructure,
} from '@world/structures';
import type { SceneMaterials } from './materials';

/**
 * The parts of a raised structure that are not its deck: piers, pier caps,
 * the parapet along its edges and the abutment where it leaves the ground.
 *
 * These are what make an elevated road read as a structure rather than as a
 * ribbon floating in the air. The parapet in particular does most of the work:
 * it gives the deck a silhouette with thickness, and it catches the sun along
 * its top edge, which is the line the eye follows to read the road's height.
 */

export interface StructureDetails {
  readonly group: Group;
  readonly triangles: number;
  dispose(): void;
}

/** Bearing inset: the deck rests ON the pier, so its top stops just under it. */
const BEARING = 0.2;
/**
 * How slender a column is allowed to be: height divided by width.
 *
 * Column width used to be one number per structure, so on rolling ground a
 * bent whose feet sat in a dip got a column nearly three times longer than its
 * neighbour at exactly the same width. A real pier is sized for what it
 * carries, so its proportions stay roughly constant however far it has to
 * reach: width grows with height, and the structure's own base radius is a
 * FLOOR rather than the answer.
 *
 * Eight, not eleven: a 1.2 m box girder carrying four lanes stands on columns
 * of 1.5 to 2 m, and at eleven every pier on the map read as a stick.
 */
const PIER_SLENDERNESS = 8;
/** Nothing gets fatter than this, however tall the deck. */
const PIER_MAX_WIDTH_FACTOR = 1.8;
/** Shortest pier worth building. Below this the deck is on the ground. */
const MIN_SUPPORT = 0.9;
/**
 * Where a bent's columns stand, as a fraction of the deck's half-width.
 *
 * A single column on the CENTRE LINE is invisible in this game, and that is a
 * property of the camera rather than an accident of modelling. The view is
 * locked at 48 degrees, so a deck `h` above the ground is drawn where the
 * ground `0.9 h` further from the camera would be, and it lands exactly on top
 * of the column that holds it. Standing the columns out at the deck's edges
 * moves them clear of that silhouette on the side facing the camera, which is
 * also how a two-column bent is actually built.
 */
const BENT_SPREAD = 0.55;
/** Depth of the crossbeam along the road, as a multiple of a column's radius. */
const CAP_DEPTH = 2.2;
/** Depth of the crossbeam the columns carry. */
const CAP_HEIGHT = 1.8;
/** How far the crossbeam reaches past the outermost column. */
const CAP_OVERHANG = 1.6;
/**
 * The parapet: a solid concrete barrier along each edge of a deck.
 *
 * It used to be a row of boxes six units apart, each scaled 0.7 along the road
 * and 6.25 ACROSS it - the two axes swapped - so every deck carried a comb of
 * thin fins standing out over its edge, which is the saw-toothed parapet the
 * player photographed. It is now one continuous extrusion that follows the
 * edge and the deck height, and it tapers out where the structure comes down
 * to the ground rather than stopping on a square end.
 */
const PARAPET_HEIGHT = 2.2;
/** Width of the barrier at its foot and at its top: the traffic face leans back. */
const PARAPET_FOOT = 0.9;
const PARAPET_TOP = 0.5;
/** Spacing of the extrusion's cross-sections along the edge. */
const PARAPET_STEP = 3;
/**
 * Height of the deck over the ground between which the parapet grows from
 * nothing to its full height. Below the first the ramp is on its embankment and
 * the kerb is its edge; above the second it is a structure and needs a barrier.
 */
const PARAPET_FROM = 1.6;
const PARAPET_FULL = 3.2;
/**
 * Height of the deck over the ground at which a ramp leaves its solid approach
 * for the first span on piers, and where the abutment stands.
 *
 * Below it the deck's own edge face (its full depth, `spec.deck`) already
 * reaches the ground, so the approach reads as a retained fill; above it there
 * is daylight under the soffit and the span needs something to rest on.
 */
const ABUTMENT_LIFT = 1.2;
/** Depth of an abutment along the road. */
const ABUTMENT_DEPTH = 4;
/** How far a pier must stand from an abutment: less than this and it is one wall. */
const PIER_ABUTMENT_GAP = 26;
/** How far a tunnel portal's face reaches past the road, to close the cutting. */
const PORTAL_WING = 14;
/** Depth of the portal face along the road. Thick enough to cover a grid cell. */
const PORTAL_THICKNESS = 4;

interface Placement {
  readonly x: number;
  readonly y: number;
  readonly yaw: number;
  readonly sx: number;
  readonly sy: number;
  readonly sz: number;
  readonly cy: number;
}

/**
 * A grid of every road's casing, so "is this point on another road" is O(1).
 *
 * The pier placer used to ask that question by walking every segment in the
 * document for every candidate position, which is quadratic in the size of the
 * network and showed up as a rebuild stall on a large map.
 */
class CasingIndex {
  private readonly cell = 48;
  private readonly buckets = new Map<number, SegmentId[]>();

  constructor(private readonly net: Network) {
    for (const [id, segment] of net.doc.segments) {
      const line = net.polylines.get(net.doc, id);
      const reach = casingHalf(roadProfile(segment.type, segment.lanes, segment.direction, segment.section));
      for (let i = 0; i < line.n; i++) {
        const point = line.point(i);
        const x0 = Math.floor((point.x - reach) / this.cell);
        const x1 = Math.floor((point.x + reach) / this.cell);
        const y0 = Math.floor((point.y - reach) / this.cell);
        const y1 = Math.floor((point.y + reach) / this.cell);
        for (let x = x0; x <= x1; x++) {
          for (let y = y0; y <= y1; y++) {
            const key = x * 73_856_093 + y * 19_349_663;
            const bucket = this.buckets.get(key);
            if (bucket) {
              if (!bucket.includes(id)) bucket.push(id);
            } else {
              this.buckets.set(key, [id]);
            }
          }
        }
      }
    }
  }

  /** True when the point falls inside the casing of a road other than `self`. */
  blocked(self: SegmentId, x: number, y: number): boolean {
    const key = Math.floor(x / this.cell) * 73_856_093 + Math.floor(y / this.cell) * 19_349_663;
    for (const id of this.buckets.get(key) ?? []) {
      if (id === self) continue;
      const segment = this.net.doc.segment(id);
      if (!segment) continue;
      const reach = casingHalf(roadProfile(segment.type, segment.lanes, segment.direction, segment.section));
      if (this.net.polylines.get(this.net.doc, id).distanceTo({ x, y }) <= reach) return true;
    }
    return false;
  }
}

function instanced(
  name: string,
  geometry: BufferGeometry,
  material: Material,
  placements: readonly Placement[],
): InstancedMesh | null {
  if (placements.length === 0) return null;
  const mesh = new InstancedMesh(geometry, material, placements.length);
  mesh.name = name;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  const object = new Object3D();
  placements.forEach((placement, index) => {
    object.position.set(placement.x, placement.cy, -placement.y);
    object.rotation.set(0, placement.yaw, 0);
    object.scale.set(placement.sx, placement.sy, placement.sz);
    object.updateMatrix();
    mesh.setMatrixAt(index, object.matrix);
  });
  mesh.instanceMatrix.needsUpdate = true;
  mesh.computeBoundingSphere();
  return mesh;
}

/**
 * A box placement whose LENGTH runs along the road and whose WIDTH runs across
 * it, in world units.
 *
 * The rotation is about three's y axis, and three's z is world `-y`, so after
 * `yaw = angleOf(tangent)` the box's local x lies along the road and its local
 * z across it. Getting that backwards is exactly how the parapet became a
 * comb, so every box is placed through this one function.
 */
function boxAlong(frame: Frame, along: number, across: number, height: number, centreY: number, offset = 0): Placement {
  return {
    x: frame.p.x + frame.n.x * offset,
    y: frame.p.y + frame.n.y * offset,
    yaw: angleOf(frame.t),
    sx: along,
    sy: height,
    sz: across,
    cy: centreY,
  };
}

/** Flat-shaded triangles, built in world coordinates and mapped into three's frame once. */
class Extrusion {
  readonly positions: number[] = [];
  readonly normals: number[] = [];
  readonly uvs: number[] = [];

  /**
   * One quad `a b c d` (counter-clockwise seen from `normal`), in world
   * `(x, y, height)`. The winding is checked against the normal rather than
   * trusted, because the world-to-three mapping mirrors `y` and flips it.
   */
  quad(
    a: readonly [number, number, number],
    b: readonly [number, number, number],
    c: readonly [number, number, number],
    d: readonly [number, number, number],
    normal: readonly [number, number, number],
    uv: readonly [number, number, number, number],
  ): void {
    const to3 = (p: readonly [number, number, number]): [number, number, number] => [p[0], p[2], -p[1]];
    const n3: [number, number, number] = [normal[0], normal[2], -normal[1]];
    const pa = to3(a);
    const pc = to3(c);
    let pb = to3(b);
    let pd = to3(d);
    const ux = pb[0] - pa[0], uy = pb[1] - pa[1], uz = pb[2] - pa[2];
    const vx = pc[0] - pa[0], vy = pc[1] - pa[1], vz = pc[2] - pa[2];
    const facing = (uy * vz - uz * vy) * n3[0] + (uz * vx - ux * vz) * n3[1] + (ux * vy - uy * vx) * n3[2];
    const [u0, v0, u1, v1] = uv;
    const uvA = [u0, v0];
    const uvC = [u1, v1];
    let uvB = [u1, v0];
    let uvD = [u0, v1];
    if (facing < 0) {
      [pb, pd] = [pd, pb];
      [uvB, uvD] = [uvD, uvB];
    }
    for (const [p, t] of [[pa, uvA], [pb, uvB], [pc, uvC], [pa, uvA], [pc, uvC], [pd, uvD]] as const) {
      this.positions.push(p[0], p[1], p[2]);
      this.normals.push(n3[0], n3[1], n3[2]);
      this.uvs.push(t[0] as number, t[1] as number);
    }
  }

  mesh(name: string, material: Material): Mesh | null {
    if (this.positions.length === 0) return null;
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new Float32BufferAttribute(this.positions, 3));
    geometry.setAttribute('normal', new Float32BufferAttribute(this.normals, 3));
    geometry.setAttribute('uv', new Float32BufferAttribute(this.uvs, 2));
    geometry.computeBoundingSphere();
    const mesh = new Mesh(geometry, material);
    mesh.name = name;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    return mesh;
  }
}

/** 0 below `a`, 1 above `b`, smooth in between. */
function smoothstep(a: number, b: number, value: number): number {
  const u = Math.min(1, Math.max(0, (value - a) / Math.max(1e-6, b - a)));
  return u * u * (3 - 2 * u);
}

/**
 * The barrier along one edge of a raised deck, as a continuous extrusion.
 *
 * `side` is +1 for the left edge and -1 for the right. Each cross-section is
 * placed at the deck's own height at that point of the edge, so the barrier
 * follows the ramps, and scaled by how far the deck stands off the ground, so
 * it grows out of the embankment and never ends on a cut face.
 */
function parapetRun(
  out: Extrusion,
  centre: Polyline,
  side: 1 | -1,
  edge: number,
  deckAt: (x: number, y: number) => number,
  terrainAt: (x: number, y: number) => number,
  tile: number,
): void {
  const length = centre.length;
  if (length <= 0) return;
  const count = Math.max(1, Math.ceil(length / PARAPET_STEP));
  interface Section { x: number; y: number; ox: number; oy: number; bottom: number; top: number; s: number; tx: number; ty: number; grow: number }
  const sections: Section[] = [];
  for (let k = 0; k <= count; k++) {
    const s = (length * k) / count;
    const f = centre.sampleAt(s);
    const ox = f.n.x * side;
    const oy = f.n.y * side;
    const x = f.p.x + ox * edge;
    const y = f.p.y + oy * edge;
    const deck = deckAt(x, y);
    const grow = smoothstep(PARAPET_FROM, PARAPET_FULL, deck - terrainAt(x, y));
    sections.push({ x, y, ox, oy, bottom: deck - 0.3, top: deck + 0.36 + PARAPET_HEIGHT * grow, s, tx: f.t.x, ty: f.t.y, grow });
  }
  type P = [number, number, number];
  const outerFoot = (q: Section): P => [q.x, q.y, q.bottom];
  const outerTop = (q: Section): P => [q.x, q.y, q.top];
  const innerTop = (q: Section): P => [q.x - q.ox * PARAPET_TOP, q.y - q.oy * PARAPET_TOP, q.top];
  const innerFoot = (q: Section): P => [q.x - q.ox * PARAPET_FOOT, q.y - q.oy * PARAPET_FOOT, q.bottom];
  const cap = (q: Section, sign: number): void => {
    out.quad(outerFoot(q), innerFoot(q), innerTop(q), outerTop(q), [q.tx * sign, q.ty * sign, 0],
      [0, q.bottom / tile, PARAPET_FOOT / tile, q.top / tile]);
  };
  let open = false;
  for (let k = 0; k + 1 < sections.length; k++) {
    const a = sections[k] as Section;
    const b = sections[k + 1] as Section;
    if (a.grow <= 0.001 && b.grow <= 0.001) {
      open = false;
      continue;
    }
    if (!open && a.grow > 0.001) cap(a, -1);
    open = true;
    const u0 = a.s / tile;
    const u1 = b.s / tile;
    const ox = (a.ox + b.ox) / 2;
    const oy = (a.oy + b.oy) / 2;
    // Outer face, top, and the traffic face leaning back towards the road.
    out.quad(outerFoot(a), outerFoot(b), outerTop(b), outerTop(a), [ox, oy, 0], [u0, a.bottom / tile, u1, a.top / tile]);
    out.quad(outerTop(a), outerTop(b), innerTop(b), innerTop(a), [0, 0, 1], [u0, 0, u1, PARAPET_TOP / tile]);
    const lean = (PARAPET_FOOT - PARAPET_TOP) / Math.max(0.1, a.top - a.bottom);
    const nl = Math.hypot(1, lean);
    out.quad(innerTop(a), innerTop(b), innerFoot(b), innerFoot(a), [-ox / nl, -oy / nl, lean / nl],
      [u0, a.top / tile, u1, a.bottom / tile]);
    if (k + 2 === sections.length && b.grow > 0.001) cap(b, 1);
  }
}

export function buildStructureDetails(
  net: Network,
  elevation: RoadElevation,
  terrainAt: (x: number, y: number) => number,
  materials: SceneMaterials,
): StructureDetails {
  const group = new Group();
  group.name = 'road-structure-details';

  const samples = (ribbon: SegmentRibbon,
    predicate: (cover: number) => boolean): boolean => {
    for (let s = 0; s <= ribbon.full.length; s += Math.max(4, ribbon.full.length / 32)) {
      const p = ribbon.full.sampleAt(s).p;
      const cover = elevation.onSegment(ribbon.id, p.x, p.y) - terrainAt(p.x, p.y);
      if (predicate(cover)) return true;
    }
    return false;
  };
  const raised = [...net.ribbons.values()].filter((ribbon) =>
    isRaised(net.doc.segment(ribbon.id)?.structure ?? 'ground') || samples(ribbon, (lift) => lift > 5),
  );
  const tunnels = TUNNELS_DRAWN
    ? [...net.ribbons.values()].filter((ribbon) =>
      ribbon.full.length > 0 &&
      (net.doc.segment(ribbon.id)?.structure === 'tunnel' || samples(ribbon, (lift) => lift < -TUNNEL_BORE)))
    : [];

  const piers: Placement[] = [];
  const caps: Placement[] = [];
  const abutments: Placement[] = [];
  const parapets = new Extrusion();
  const casings = new CasingIndex(net);

  for (const ribbon of raised) {
    const segment = net.doc.requireSegment(ribbon.id);
    const structure = segment.structure as RoadStructure;
    const deckAt = (x: number, y: number): number => elevation.onSegment(segment.id, x, y);
    const spec = roadStructure(isRaised(structure) ? structure : 'elevated');
    const spacing = structure === 'bridge' ? 96 : 74;
    const radius = structure === 'bridge' ? 3.2 : 2.6;
    const length = ribbon.full.length;
    const casing = casingHalf(ribbon.road);

    // ------------------------------------------------------------ abutments
    //
    // Where a ramp leaves the ground, its deck stops being a retained fill -
    // its own edge face reaching down to the earth - and starts to span. A real
    // structure has an abutment there: a wall across the road that the first
    // span rests on. Without one the deck simply lifted off the grass with
    // daylight under its end, which is the "deck ending in mid-air" the player
    // saw at the foot of every ramp.
    const liftAt = (s: number): number => {
      const f = ribbon.full.sampleAt(s);
      return deckAt(f.p.x, f.p.y) - spec.deck - 0.36 - terrainAt(f.p.x, f.p.y);
    };
    const abutmentAt: number[] = [];
    const scan = 2;
    let before = liftAt(0);
    for (let s = scan; s <= length; s += scan) {
      const here = liftAt(s);
      if ((before < ABUTMENT_LIFT) !== (here < ABUTMENT_LIFT)) {
        const at = s - scan / 2;
        const f = ribbon.full.sampleAt(at);
        const soffit = deckAt(f.p.x, f.p.y) - spec.deck - 0.36;
        const foot = Math.min(terrainAt(f.p.x, f.p.y), soffit) - 1;
        abutments.push(boxAlong(f, ABUTMENT_DEPTH, casing * 2, soffit - foot, (soffit + foot) / 2));
        abutmentAt.push(at);
      }
      before = here;
    }

    // ---------------------------------------------------------------- piers
    // Columns stand out at the deck edges rather than under its centre line;
    // see `BENT_SPREAD`. The second clamp keeps a column under the deck it
    // carries on a narrow class, where the fraction alone would push it out
    // past the parapet.
    const halfDeck = sidewalkHalf(ribbon.road);
    const spread = Math.max(0, Math.min(halfDeck * BENT_SPREAD, halfDeck - radius - 1));
    const sides: readonly number[] = spread > 0 ? [-1, 1] : [0];

    /**
     * One bent: a crossbeam under the soffit, on a column at each deck edge.
     *
     * A column is dropped on its own rather than with the bent, because the two
     * sides can meet different ground — and because one of them landing on
     * another road is a reason to leave that side out, not to leave the span
     * unsupported.
     */
    const placeBent = (frame: Frame): void => {
      const soffit = deckAt(frame.p.x, frame.p.y) - spec.deck - 0.36 - BEARING;
      const beam = soffit - CAP_HEIGHT;

      const feet: { readonly x: number; readonly y: number; readonly ground: number }[] = [];
      for (const side of sides) {
        const x = frame.p.x + frame.n.x * spread * side;
        const y = frame.p.y + frame.n.y * spread * side;
        if (casings.blocked(segment.id, x, y)) continue;
        const ground = terrainAt(x, y);
        if (beam - ground < MIN_SUPPORT) continue;
        feet.push({ x, y, ground });
      }
      if (feet.length === 0) return;

      // One width for the whole bent, from the TALLEST of its feet: sizing each
      // column against its own height makes the two legs of one bent different
      // widths wherever the ground slopes across the deck.
      const tallest = feet.reduce((mx, foot) => Math.max(mx, beam - foot.ground), 0);
      const width = Math.min(radius * PIER_MAX_WIDTH_FACTOR, Math.max(radius, tallest / PIER_SLENDERNESS));

      for (const foot of feet) {
        const height = beam - foot.ground + 0.5;
        piers.push({ x: foot.x, y: foot.y, yaw: angleOf(frame.t), sx: width, sy: height, sz: width, cy: foot.ground - 0.5 + height / 2 });
      }
      // The crossbeam follows the columns it rests on, or a tall bent grows a
      // beam narrower than the legs under it.
      caps.push(boxAlong(frame, width * CAP_DEPTH, spread * 2 + width + CAP_OVERHANG * 2, CAP_HEIGHT, beam + CAP_HEIGHT / 2));
    };

    let placed = 0;
    for (let s = spacing * 0.5; s < length - spacing * 0.35; s += spacing) {
      if (abutmentAt.some((at) => Math.abs(at - s) < PIER_ABUTMENT_GAP)) continue;
      placeBent(ribbon.full.sampleAt(s));
      placed++;
    }
    if (placed === 0 && length > 0) {
      const mid = length / 2;
      if (!abutmentAt.some((at) => Math.abs(at - mid) < PIER_ABUTMENT_GAP)) placeBent(ribbon.full.sampleAt(mid));
    }

    // ------------------------------------------------------------- parapets
    //
    // Along the casing's own centreline, which the network trims back at a
    // junction mouth and leaves whole at a node where one deck simply carries on
    // into the next - so a chain of spans has one unbroken barrier.
    const centre = ribbon.centre[Level.Casing] ?? ribbon.full;
    const edge = casing - 0.05;
    for (const side of [1, -1] as const) {
      parapetRun(parapets, centre, side, edge, deckAt, terrainAt, materials.scale.deck);
    }
  }

  let triangles = 0;
  const attach = (mesh: InstancedMesh | Mesh | null): void => {
    if (!mesh) return;
    group.add(mesh);
    const count = mesh.geometry.index?.count ?? mesh.geometry.getAttribute('position').count;
    triangles += (count / 3) * (mesh instanceof InstancedMesh ? mesh.count : 1);
  };

  const pierGeometry = new CylinderGeometry(1, 1.08, 1, 16);
  const capGeometry = new BoxGeometry(1, 1, 1);
  attach(instanced('structure-piers', pierGeometry, materials.concrete, piers));
  attach(instanced('structure-pier-caps', capGeometry, materials.concrete, caps));
  attach(instanced('structure-abutments', capGeometry, materials.concrete, abutments));
  const parapetMesh = parapets.mesh('structure-parapets', materials.parapet);
  attach(parapetMesh);

  const owned: BufferGeometry[] = [pierGeometry, capGeometry];
  if (parapetMesh) owned.push(parapetMesh.geometry);

  // ---------------------------------------------------------------- portals
  //
  // A portal is NOT at the end of a tunnel segment. The segment's ends are at
  // grade — a tunnel begins as a cutting and dives — so anchoring the headwall
  // to the segment's endpoints, which is what this used to do, put it in open
  // country with the road passing under it at full depth.
  //
  // The portal belongs where the ground closes over the arch, which is a depth,
  // not an arc position: walk the alignment and place a headwall wherever the
  // COVER over the road crosses `TUNNEL_PORTAL_COVER`. That reads the same
  // number the terrain shaper fades on, so the wall lands exactly in the seam
  // between the open cutting and the intact hill — and a tunnel that dips under
  // two hills with a gap between them correctly gets four portals, with no code
  // that knows about such a case.
  if (TUNNELS_DRAWN && tunnels.length > 0) {
    const jambs: Placement[] = [];
    const lintels: Placement[] = [];
    const headwalls: Placement[] = [];

    for (const ribbon of tunnels) {
      const segment = net.doc.requireSegment(ribbon.id);
      const length = ribbon.full.length;
      const step = Math.min(6, Math.max(2, length / 200));
      const half = sidewalkHalf(ribbon.road);
      const jambWidth = 2.2;

      const coverAt = (s: number): number => {
        const frame = ribbon.full.sampleAt(s);
        return terrainAt(frame.p.x, frame.p.y) - elevation.onSegment(segment.id, frame.p.x, frame.p.y);
      };

      let previous = coverAt(0);
      const buriedJoin = (nodeId: typeof segment.a): boolean => {
        const node = net.doc.node(nodeId);
        return !!node && node.incident.length > 1 && node.heightOffset < -TUNNEL_HEADROOM;
      };
      for (let s = step; s <= length; s += step) {
        const cover = coverAt(s);
        const crossed =
          (previous < TUNNEL_PORTAL_COVER && cover >= TUNNEL_PORTAL_COVER) ||
          (previous >= TUNNEL_PORTAL_COVER && cover < TUNNEL_PORTAL_COVER);
        previous = cover;
        if (!crossed) continue;
        // A portal belongs to the alignment that actually reaches daylight.
        // At a buried turn, the adjacent segment can reshape the shared ground
        // enough to make the old leg appear to cross the cover threshold at its
        // endpoint. A wall there slices across the turning road.
        if ((s < 40 && buriedJoin(segment.a)) ||
          (length - s < 40 && buriedJoin(segment.b))) continue;

        // Linear interpolation is enough: the cover changes by at most a few
        // tenths of a unit over one step.
        const frame = ribbon.full.sampleAt(s - step / 2);
        const road = elevation.onSegment(segment.id, frame.p.x, frame.p.y);
        const yaw = angleOf(frame.t);
        const opening = TUNNEL_HEADROOM;
        const crown = road + opening + TUNNEL_ARCH;
        // The face has to be at least as wide as the band of ground the cutting
        // held down, because that whole band steps back up here and the wall is
        // what closes it. `CUT_SHOULDER` is the number that band is sized by.
        const faceHalf = half + jambWidth + PORTAL_WING;
        // Tall enough to carry the arch and stand proud of the ground at the
        // foot of the cutting, which is the whole reason the portal is here
        // rather than at the depth the bore closes.
        const top = Math.max(crown + 1.5, terrainAt(frame.p.x, frame.p.y) + 2);

        // Two piers either side of the opening, carried to the full height of
        // the face, and a lintel across the top of it: a rectangular hole in a
        // slab, rather than a slab with pillars in front of it.
        for (const side of [-1, 1] as const) {
          const inner = half + jambWidth / 2;
          const width = faceHalf - inner + jambWidth / 2;
          const centre = inner + (width - jambWidth) / 2;
          jambs.push({
            x: frame.p.x + frame.n.x * centre * side,
            y: frame.p.y + frame.n.y * centre * side,
            yaw,
            sx: PORTAL_THICKNESS,
            sy: top - road,
            sz: width,
            cy: road + (top - road) / 2,
          });
        }
        lintels.push({
          x: frame.p.x,
          y: frame.p.y,
          yaw,
          sx: PORTAL_THICKNESS,
          sy: Math.max(0.8, top - crown),
          sz: (half + jambWidth) * 2,
          cy: crown + Math.max(0.8, top - crown) / 2,
        });
        // A coping course along the top, which is what gives the portal a lit
        // edge against the hillside instead of a flat grey rectangle.
        headwalls.push({
          x: frame.p.x,
          y: frame.p.y,
          yaw,
          sx: PORTAL_THICKNESS + 1.6,
          sy: 0.9,
          sz: faceHalf * 2 + 1.6,
          cy: top + 0.45,
        });
      }
    }

    const portalGeometry = new BoxGeometry(1, 1, 1);
    attach(instanced('tunnel-jambs', portalGeometry, materials.concrete, jambs));
    attach(instanced('tunnel-lintels', portalGeometry, materials.concrete, lintels));
    attach(instanced('tunnel-headwalls', portalGeometry, materials.concrete, headwalls));
    owned.push(portalGeometry);
  }

  return {
    group,
    triangles,
    dispose() {
      for (const geometry of owned) geometry.dispose();
      group.clear();
    },
  };
}
