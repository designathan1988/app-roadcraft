import {
  BoxGeometry,
  CylinderGeometry,
  Group,
  InstancedMesh,
  Object3D,
  type BufferGeometry,
  type Material,
} from 'three';

import { angleOf } from '@core/vec2';
import type { Frame } from '@core/polyline';
import type { Network } from '@world/network';
import type { SegmentId } from '@world/ids';
import type { RoadElevation } from '@world/elevation';
import { casingHalf, roadProfile, sidewalkHalf } from '@world/roadTypes';
import {
  TUNNELS_DRAWN,
  TUNNEL_ARCH,
  TUNNEL_HEADROOM,
  TUNNEL_PORTAL_COVER,
  isRaised,
  roadStructure,
  type RoadStructure,
} from '@world/structures';
import type { SceneMaterials } from './materials';

/**
 * The parts of a raised structure that are not its deck: piers, pier caps and
 * the parapet along its edge.
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
 * neighbour at exactly the same width. Measured on one 1200-unit viaduct,
 * column length ran from 10.3 to 27.3 units at a fixed radius of 1.8 - the
 * short ones read as stumps and the tall ones as sticks, and a row of them
 * read as a mistake rather than as a structure.
 *
 * A real pier is sized for what it carries, so its proportions stay roughly
 * constant however far it has to reach. Width therefore grows with height and
 * the structure's own base radius becomes a FLOOR rather than the answer.
 */
const PIER_SLENDERNESS = 11;
/** Nothing gets fatter than this, however tall the deck. */
const PIER_MAX_WIDTH_FACTOR = 2.1;
/** Shortest pier worth building. Below this the deck is on the ground. */
const MIN_SUPPORT = 0.9;
/**
 * Where a bent's columns stand, as a fraction of the deck's half-width.
 *
 * A single column on the CENTRE LINE is invisible in this game, and that is a
 * property of the camera rather than an accident of modelling. The view is
 * locked at 48 degrees, so a point `h` above the ground is drawn where the
 * ground point `h / tan(48°) = 0.9 h` further from the camera would be: a
 * fifteen-unit deck slides about thirteen units across the screen, which is
 * less than an urban street's half-width. The deck therefore lands exactly on
 * top of the column that holds it and every elevated road read as a ribbon
 * lying in the grass — the whole structure was being drawn, and none of it
 * could be seen.
 *
 * Standing the columns out at the deck's edges moves them clear of that
 * silhouette on the side facing the camera, which is also how a two-column
 * bent is actually built. Measured on the reported map: at this spread the
 * near column clears the deck edge by about twelve units at either of the two
 * orientations most of the network uses.
 */
const BENT_SPREAD = 0.55;
/** Depth of the crossbeam along the road, as a multiple of a column's radius. */
const CAP_DEPTH = 2.4;
/** Depth of the crossbeam the columns carry. */
const CAP_HEIGHT = 1.1;
/** How far the crossbeam reaches past the outermost column. */
const CAP_OVERHANG = 1.6;
/** Height of the parapet above the deck's footway. */
const PARAPET_HEIGHT = 1.35;
const PARAPET_THICKNESS = 0.7;
/** Spacing of parapet panels along the edge of a deck. */
const PARAPET_STEP = 6;
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
      const reach = casingHalf(roadProfile(segment.type, segment.lanes, segment.direction));
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
      const reach = casingHalf(roadProfile(segment.type, segment.lanes, segment.direction));
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

export function buildStructureDetails(
  net: Network,
  elevation: RoadElevation,
  terrainAt: (x: number, y: number) => number,
  materials: SceneMaterials,
): StructureDetails {
  const group = new Group();
  group.name = 'road-structure-details';

  const raised = [...net.ribbons.values()].filter((ribbon) =>
    isRaised(net.doc.segment(ribbon.id)?.structure ?? 'ground'),
  );
  const tunnels = TUNNELS_DRAWN
    ? [...net.ribbons.values()].filter((ribbon) => net.doc.segment(ribbon.id)?.structure === 'tunnel')
    : [];

  const piers: Placement[] = [];
  const caps: Placement[] = [];
  const parapets: Placement[] = [];
  const casings = new CasingIndex(net);

  for (const ribbon of raised) {
    const segment = net.doc.requireSegment(ribbon.id);
    const structure = segment.structure as RoadStructure;
    const only: ReadonlySet<RoadStructure> = new Set([structure]);
    const spec = roadStructure(structure);
    const spacing = structure === 'bridge' ? 108 : structure === 'viaduct' ? 58 : 74;
    const radius = structure === 'bridge' ? 2.6 : 1.8;
    const length = ribbon.full.length;

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
      const yaw = angleOf(frame.t);
      const soffit = elevation.at(frame.p.x, frame.p.y, only) - spec.deck - BEARING;
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

      // One width for the whole bent, from the TALLEST of its feet.
      //
      // Sizing each column against its own height would make the two legs of a
      // single bent different widths wherever the ground slopes across the
      // deck, which is the same inconsistency one step smaller.
      const tallest = feet.reduce((mx, foot) => Math.max(mx, beam - foot.ground), 0);
      const width = Math.min(
        radius * PIER_MAX_WIDTH_FACTOR,
        Math.max(radius, tallest / PIER_SLENDERNESS),
      );

      for (const foot of feet) {
        const height = beam - foot.ground;
        piers.push({
          x: foot.x,
          y: foot.y,
          yaw,
          sx: width,
          sy: height,
          sz: width,
          cy: foot.ground + height / 2,
        });
      }
      caps.push({
        x: frame.p.x,
        y: frame.p.y,
        yaw,
        // Follows the columns it rests on, or a tall bent grows a beam
        // narrower than the legs under it.
        sx: width * CAP_DEPTH,
        sy: CAP_HEIGHT,
        sz: spread * 2 + CAP_OVERHANG * 2,
        cy: beam + CAP_HEIGHT / 2,
      });
    };

    let placed = 0;
    for (let s = spacing * 0.5; s < length - spacing * 0.35; s += spacing) {
      placeBent(ribbon.full.sampleAt(s));
      placed++;
    }
    if (placed === 0 && length > 0) {
      placeBent(ribbon.full.sampleAt(length / 2));
    }

    // Parapet panels down both edges, skipped where the deck has come down to
    // the ground: a barrier beside a road at grade is a kerb, not a parapet.
    const edge = sidewalkHalf(ribbon.road) - PARAPET_THICKNESS / 2;
    for (let s = PARAPET_STEP / 2; s < length; s += PARAPET_STEP) {
      const frame = ribbon.full.sampleAt(s);
      const yaw = angleOf(frame.t);
      for (const side of [-1, 1] as const) {
        const x = frame.p.x + frame.n.x * edge * side;
        const y = frame.p.y + frame.n.y * edge * side;
        const deck = elevation.at(x, y, only);
        if (deck - terrainAt(x, y) < 2.4) continue;
        parapets.push({
          x,
          y,
          yaw,
          sx: PARAPET_THICKNESS,
          sy: PARAPET_HEIGHT,
          sz: PARAPET_STEP + 0.25,
          cy: deck + 0.36 + PARAPET_HEIGHT / 2,
        });
      }
    }
  }

  let triangles = 0;
  const attach = (mesh: InstancedMesh | null): void => {
    if (!mesh) return;
    group.add(mesh);
    triangles += ((mesh.geometry.index?.count ?? mesh.geometry.getAttribute('position').count) / 3) * mesh.count;
  };

  const pierGeometry = new CylinderGeometry(1, 1.12, 1, 12);
  const capGeometry = new BoxGeometry(1, 1, 1);
  const parapetGeometry = new BoxGeometry(1, 1, 1);
  attach(instanced('structure-piers', pierGeometry, materials.concrete, piers));
  attach(instanced('structure-pier-caps', capGeometry, materials.concrete, caps));
  attach(instanced('structure-parapets', parapetGeometry, materials.deck, parapets));

  const owned: BufferGeometry[] = [pierGeometry, capGeometry, parapetGeometry];

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
      for (let s = step; s <= length; s += step) {
        const cover = coverAt(s);
        const crossed =
          (previous < TUNNEL_PORTAL_COVER && cover >= TUNNEL_PORTAL_COVER) ||
          (previous >= TUNNEL_PORTAL_COVER && cover < TUNNEL_PORTAL_COVER);
        previous = cover;
        if (!crossed) continue;

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
