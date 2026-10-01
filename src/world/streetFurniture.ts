import type { Vec2 } from '@core/vec2';
import { Level, roadProfile } from './roadTypes';
import type { Network } from './network';
import type { SegmentId } from './ids';
import { m } from './units';
import { carriesPedestrians } from './pedestrianAccess';
import { orientedPolyline } from './geometry';
import { CROSSWALK_DEPTH } from './approach';
import { BENCH_ZONE, LAMP_ZONE, TREE_KERB_SETBACK, TREE_MIN_FOOTWAY, TREE_PIT, sectionOf } from './section';

export { TREE_PIT } from './section';

/**
 * Where every piece of street furniture stands.
 *
 * This used to be written twice: once in `render/scenery.ts`, which drew the
 * lamps, bins and benches, and once, by hand and "at the same positions", in
 * `sim/peds/clearance.ts`, which keeps pedestrians from walking through them.
 * Two copies of a layout drift - adding a street tree to one would have put a
 * tree on the pavement that people walked straight through. It is one list now,
 * derived from the network, and both read it.
 *
 * Positions only. Heights belong to the road field and are the renderer's to
 * look up; the simulation walks in plan.
 */

export type FurnitureKind =
  | 'lamp'
  | 'bin'
  | 'bench'
  | 'hydrant'
  | 'postbox'
  | 'streetTree'
  | 'medianShrub';

export interface FurnitureItem {
  readonly kind: FurnitureKind;
  readonly x: number;
  readonly y: number;
  readonly segment: SegmentId;
  /** Unit tangent of the road at the item. */
  readonly along: Vec2;
  /** Unit normal pointing AWAY from the carriageway, towards the buildings. */
  readonly outward: Vec2;
  /**
   * The footway surface the item stands on: the footway itself, or the median
   * island for a shrub planted in it. The renderer adds the matching rise.
   */
  readonly on: 'footway' | 'median';
  /** Plan footprint, for anything that must walk around it. */
  readonly radius: number;
  /** Set for a long thing (a bench): its half extent along `along`. */
  readonly halfLength?: number;
  /** Set for a long thing: its half extent along `outward`. */
  readonly halfWidth?: number;
  /**
   * Set for a seat: the way somebody sitting on it faces. A bench by the kerb
   * turns its back on the traffic and faces the footway, as on a street.
   */
  readonly faces?: Vec2;
  /** A per-item number in [0, 1), stable across rebuilds, for variety. */
  readonly seed: number;
}

/** Spacing of lamp columns along a road; every other item keys off it. */
export const LAMP_SPACING = 88;

/**
 * Each item appears on its own cycle of columns, and the cycles are coprime with
 * one another, so they do not line up into a repeating pattern along the street.
 */
const BIN_EVERY = 3;
const BENCH_EVERY = 4;
const HYDRANT_EVERY = 7;
const POSTBOX_EVERY = 11;

/** Spacing of shrubs along a planted median. */
const MEDIAN_SHRUB_SPACING = 11;

function hash01(a: number, b: number): number {
  let h = Math.imul(a | 0, 0x9e3779b1) ^ Math.imul(b | 0, 0x85ebca77);
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
  return ((h ^ (h >>> 16)) >>> 0) / 4_294_967_296;
}

export function streetFurniture(net: Network): FurnitureItem[] {
  const items: FurnitureItem[] = [];
  let column = 0;

  for (const ribbon of net.ribbons.values()) {
    if (!carriesPedestrians(ribbon.road)) continue;
    const length = ribbon.full.length;
    const start = Math.min(36, length * 0.24);
    const road = ribbon.road;
    // On a deck or in a bore there is a lamp column and nothing else: no soil
    // for a tree pit, and nobody sets a bench, a post box or a hydrant on a
    // viaduct. Trees on elevated decks were photographed growing out of the
    // footway fifteen units over the grass.
    const segment = net.doc.segment(ribbon.id);
    const authoredLift = segment ? Math.max(
      Math.abs(net.doc.node(segment.a)?.heightOffset ?? 0),
      Math.abs(net.doc.node(segment.b)?.heightOffset ?? 0),
    ) : 0;
    const built = (segment?.structure ?? 'ground') !== 'ground' || authoredLift > m(1.5);

    // Everything stands in the furnishing zone beside the kerb
    // (`section.ts`), at its own depth across it and spaced along the road
    // from the lamp column it keys off.
    const zone = sectionOf(road, segment?.direction ?? 'both').side.furnishing;
    const depth = zone.outer - zone.inner;
    const seats = depth >= BENCH_ZONE - 1e-9;

    for (let s = start; s < length - start; s += LAMP_SPACING) {
      const frame = ribbon.full.sampleAt(s);
      const side = (Math.floor(s / LAMP_SPACING) + ribbon.id) % 2 === 0 ? -1 : 1;
      const outward = { x: frame.n.x * side, y: frame.n.y * side };
      /** A point `along` the road from the column, `across` the furnishing zone from its kerb edge. */
      const at = (along: number, across: number): Vec2 => ({
        x: frame.p.x + frame.t.x * along + outward.x * (zone.inner + across),
        y: frame.p.y + frame.t.y * along + outward.y * (zone.inner + across),
      });
      const base = {
        segment: ribbon.id,
        along: frame.t,
        outward,
        on: 'footway' as const,
      };
      const seed = hash01(ribbon.id, column);

      items.push({ ...base, kind: 'lamp', ...at(0, LAMP_ZONE / 2), radius: m(0.13), seed });
      if (built) {
        column++;
        continue;
      }

      // A hydrant beside the column; bins, benches and post boxes only where
      // the zone is deep enough to hold them clear of the through zone.
      if (column % HYDRANT_EVERY === 2) items.push({ ...base, kind: 'hydrant', ...at(m(0.8), LAMP_ZONE / 2), radius: m(0.16), seed });
      if (seats && column % BIN_EVERY === 0) items.push({ ...base, kind: 'bin', ...at(m(1.2), BENCH_ZONE / 2), radius: m(0.33), seed });
      if (seats && column % BENCH_EVERY === 1) {
        items.push({
          ...base,
          kind: 'bench',
          ...at(-m(2), BENCH_ZONE / 2),
          radius: Math.hypot(m(0.9), m(0.26)),
          halfLength: m(0.9),
          halfWidth: m(0.26),
          faces: outward,
          seed,
        });
      }
      if (seats && column % POSTBOX_EVERY === 3) items.push({ ...base, kind: 'postbox', ...at(-m(1.2), BENCH_ZONE / 2), radius: m(0.33), seed });

      // Street trees, one each side, half a span on from the column.
      const mid = s + LAMP_SPACING / 2;
      if (road.sidewalk >= TREE_MIN_FOOTWAY && mid < length - start) {
        const treeFrame = ribbon.full.sampleAt(mid);
        const offset = zone.inner + TREE_KERB_SETBACK + TREE_PIT / 2;
        for (const treeSide of [-1, 1]) {
          items.push({
            kind: 'streetTree',
            x: treeFrame.p.x + treeFrame.n.x * offset * treeSide,
            y: treeFrame.p.y + treeFrame.n.y * offset * treeSide,
            segment: ribbon.id,
            along: treeFrame.t,
            outward: { x: treeFrame.n.x * treeSide, y: treeFrame.n.y * treeSide },
            on: 'footway',
            radius: TREE_PIT / 2,
            seed: hash01(ribbon.id * 31 + treeSide, column),
          });
        }
      }

      column++;
    }

    // Shrubs down a planted central reservation.
    if (road.median > 0 && !built) {
      const centre = ribbon.centre[Level.Asphalt];
      if (centre && centre.n >= 2) {
        const run = centre.length;
        let k = 0;
        for (let s = 14; s < run - 14; s += MEDIAN_SHRUB_SPACING) {
          const frame = centre.sampleAt(s);
          items.push({
            kind: 'medianShrub',
            x: frame.p.x,
            y: frame.p.y,
            segment: ribbon.id,
            along: frame.t,
            outward: frame.n,
            on: 'median',
            radius: road.median / 2,
            seed: hash01(ribbon.id * 7 + 3, k++),
          });
        }
      }
    }
  }
  // Reserve the whole crossing approach, including its landing on each
  // footway. Furniture from a nearby leg can otherwise land directly in a
  // zebra's exit: neither walking through it nor staying in the road is a
  // valid avoidance decision. This shared layout controls rendering too.
  const accesses: { x: number; y: number; tx: number; ty: number; across: number; structure: string }[] = [];
  for (const [nodeId, node] of net.doc.nodes) {
    if (node.incident.length < 2) continue;
    for (const segmentId of node.incident) {
      const crossing = net.crosswalkDistanceAt(segmentId, nodeId);
      if (crossing <= 0) continue;
      const segment = net.doc.requireSegment(segmentId);
      const road = roadProfile(segment.type, segment.lanes, segment.direction);
      const frame = orientedPolyline(net.doc, segment, nodeId).sampleAt(crossing);
      accesses.push({ x: frame.p.x, y: frame.p.y, tx: frame.t.x, ty: frame.t.y,
        across: road.width / 2 + road.sidewalk + m(0.3), structure: segment.structure });
    }
  }
  return items.filter((item) => !accesses.some((access) => {
    if (net.doc.requireSegment(item.segment).structure !== access.structure) return false;
    const dx = item.x - access.x, dy = item.y - access.y;
    return Math.abs(dx * access.tx + dy * access.ty) < CROSSWALK_DEPTH / 2 + m(0.3) + item.radius &&
      Math.abs(-dx * access.ty + dy * access.tx) < access.across + item.radius;
  }));
}

/** The items a person on the footway has to walk around. */
export const blocksPedestrians = (item: FurnitureItem): boolean => item.on === 'footway';
