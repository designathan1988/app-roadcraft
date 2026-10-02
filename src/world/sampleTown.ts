import type { Vec2 } from '@core/vec2';
import { instantiate } from './buildings/blueprints';
import { cityBuilding } from './buildings/cityBuildings';
import { footprintRects } from './buildings/geometry';
import type { Building, BuildingFunction } from './buildings/types';
import type { RoadDoc } from './doc';
import { Level, ROAD_TYPES, halfWidth } from './roadTypes';
import { m } from './units';

/**
 * A small town, built on an empty map: a grid of streets round an avenue, and
 * on every block buildings shoulder to shoulder, their fronts on the
 * pavement, the way a town centre stands - homes, a school and a church, the
 * shops and the bank on the avenue, the city hall on its square, restaurants
 * and a cinema for the evening. The streets furnish themselves (lamps,
 * trees, benches: `streetFurniture`).
 *
 * Every building is the catalogue's own model (`cityBuildings`), so every one
 * can be edited, entered and lived in like any other.
 */

/** Node lines of the grid, world units. */
const XS = [-270, -90, 90, 270];
const YS = [-180, 0, 180];
/** Road types: the avenue across the middle, residential streets round it. */
const LOCAL = ROAD_TYPES.findIndex((t) => t.id === 'local');
const URBAN = ROAD_TYPES.findIndex((t) => t.id === 'urban');
/** Between the pavement's edge and a facade; between two neighbours. */
const FRONT_GAP = 0.05;
const PARTY_GAP = 0;

/** What stands on each block, in order round it from its first corner. */
const BLOCKS: readonly (readonly BuildingFunction[])[] = [
  ['apartments', 'townhouse', 'townhouse', 'bakery', 'townhouse', 'apartments', 'house', 'pharmacy', 'townhouse', 'house'],
  ['school', 'church', 'library', 'townhouse', 'townhouse', 'clinic', 'townhouse'],
  ['residentialTower', 'townhouse', 'shop', 'townhouse', 'apartments', 'house', 'snackBar', 'townhouse'],
  ['supermarket', 'bank', 'shop', 'pharmacy', 'bakery', 'shop', 'apartments', 'townhouse', 'townhouse'],
  ['cityHall', 'postOffice', 'council', 'office', 'police', 'townhouse', 'shop'],
  ['restaurant', 'bar', 'cinema', 'hotel', 'snackBar', 'office', 'apartments', 'gym', 'townhouse'],
];
/** Narrow fronts that close the gaps left between the others. */
const FILLERS: readonly BuildingFunction[] = ['shop', 'townhouse', 'house'];
/** What the middle of a block becomes, if there is room. */
const COURTYARDS: readonly BuildingFunction[] = ['square', 'playground', 'sportsCourt'];

interface Box { x0: number; y0: number; x1: number; y1: number }

function boxOf(b: Omit<Building, 'id'>): Box {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const ring of footprintRects(b as Building)) {
    for (const p of ring) {
      x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y);
      x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y);
    }
  }
  return { x0, y0, x1, y1 };
}

const overlaps = (a: Box, b: Box, gap: number): boolean =>
  a.x0 < b.x1 + gap && a.x1 > b.x0 - gap && a.y0 < b.y1 + gap && a.y1 > b.y0 - gap;

const inside = (a: Box, b: Box): boolean =>
  a.x0 >= b.x0 - 0.5 && a.x1 <= b.x1 + 0.5 && a.y0 >= b.y0 - 0.5 && a.y1 <= b.y1 + 0.5;

interface Edge { readonly start: Vec2; readonly along: Vec2; readonly inward: Vec2; readonly length: number }

/** A model turned to face the street on `edge`, its front centre at `t` along it. */
function facing(fn: BuildingFunction, edge: Edge, t: number): { body: Omit<Building, 'id'>; box: Box; width: number } | null {
  const model = cityBuilding(fn);
  if (!model) return null;
  // The model's front (local -y) towards the street, which is against `inward`.
  const rotation = Math.atan2(-edge.inward.x, edge.inward.y);
  const probe = instantiate(model.body, { x: 0, y: 0 }, rotation, fn);
  const pb = boxOf(probe);
  const width = edge.along.x !== 0 ? pb.x1 - pb.x0 : pb.y1 - pb.y0;
  const at = {
    x: edge.start.x + edge.along.x * (t + width / 2) + edge.inward.x * FRONT_GAP,
    y: edge.start.y + edge.along.y * (t + width / 2) + edge.inward.y * FRONT_GAP,
  };
  const body = { ...instantiate(model.body, at, rotation, fn), function: fn };
  return { body, box: boxOf(body), width };
}

/** Builds the town on `doc`, which should be empty. Returns how many buildings it put up. */
export function buildSampleTown(doc: RoadDoc): number {
  const ids = new Map<string, number>();
  for (const y of YS) for (const x of XS) ids.set(`${x},${y}`, doc.addNode({ x, y }).id);
  const node = (x: number, y: number) => ids.get(`${x},${y}`)! as Parameters<RoadDoc['addSegment']>[0];
  const typeAt = (y: number): number => (y === 0 ? URBAN : LOCAL);
  for (const y of YS) for (let i = 0; i + 1 < XS.length; i++) doc.addSegment(node(XS[i]!, y), node(XS[i + 1]!, y), typeAt(y));
  for (const x of XS) for (let j = 0; j + 1 < YS.length; j++) doc.addSegment(node(x, YS[j]!), node(x, YS[j + 1]!), LOCAL);

  // Fronts on the back of the footway: no verge between pavement and wall.
  const half = (type: number): number => halfWidth(ROAD_TYPES[type]!, Level.Sidewalk);
  const placed: Box[] = [];
  let count = 0;
  const put = (body: Omit<Building, 'id'>, box: Box): void => {
    doc.buildings.add(body);
    placed.push(box);
    count++;
  };

  let block = 0;
  for (let j = 0; j + 1 < YS.length; j++) {
    for (let i = 0; i + 1 < XS.length; i++) {
      const lot: Box = {
        x0: XS[i]! + half(LOCAL), x1: XS[i + 1]! - half(LOCAL),
        y0: YS[j]! + half(typeAt(YS[j]!)), y1: YS[j + 1]! - half(typeAt(YS[j + 1]!)),
      };
      const w = lot.x1 - lot.x0, d = lot.y1 - lot.y0;
      // Round the block: along each street, its fronts facing it.
      const edges: Edge[] = [
        { start: { x: lot.x0, y: lot.y0 }, along: { x: 1, y: 0 }, inward: { x: 0, y: 1 }, length: w },
        { start: { x: lot.x1, y: lot.y0 }, along: { x: 0, y: 1 }, inward: { x: -1, y: 0 }, length: d },
        { start: { x: lot.x1, y: lot.y1 }, along: { x: -1, y: 0 }, inward: { x: 0, y: -1 }, length: w },
        { start: { x: lot.x0, y: lot.y1 }, along: { x: 0, y: -1 }, inward: { x: 1, y: 0 }, length: d },
      ];
      const wanted = [...(BLOCKS[block % BLOCKS.length] ?? [])];
      block++;
      // Twice round: the block's own buildings, then the gaps closed.
      for (const pass of [wanted, null] as const) {
        for (const edge of edges) {
          let t = 0;
          while (t < edge.length - m(4)) {
            const choices = pass ? pass.slice(0, 1) : FILLERS;
            let done = false;
            for (const fn of choices) {
              const f = facing(fn, edge, t);
              if (!f) continue;
              if (t + f.width > edge.length + 0.5) continue;
              if (!inside(f.box, lot) || placed.some((o) => overlaps(f.box, o, -0.05))) continue;
              put(f.body, f.box);
              if (pass) pass.shift();
              t += f.width + PARTY_GAP;
              done = true;
              break;
            }
            if (pass && !pass.length) break;
            if (!done) t += m(1);
          }
        }
      }
      // The middle of the block: a square or a court where there is room.
      const middle = { x: (lot.x0 + lot.x1) / 2, y: (lot.y0 + lot.y1) / 2 };
      for (const fn of COURTYARDS) {
        const model = cityBuilding(fn);
        if (!model) continue;
        const probe = instantiate(model.body, { x: 0, y: 0 }, 0, fn);
        const pb = boxOf(probe);
        const body = { ...instantiate(model.body, { x: middle.x, y: middle.y - (pb.y1 - pb.y0) / 2 }, 0, fn), function: fn };
        const box = boxOf(body);
        if (!inside(box, lot) || placed.some((o) => overlaps(box, o, m(1)))) continue;
        put(body, box);
        break;
      }
    }
  }
  return count;
}
