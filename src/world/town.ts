import type { BlueprintBody } from './buildings/blueprints';
import { Model, cityBuilding, mat } from './buildings/cityBuildings';
import type { MaterialSpec } from './buildings/materials';
import type { BayComponent, Building, BuildingFunction, RoofKind, Side } from './buildings/types';
import type { RoadDoc } from './doc';
import { Level, ROAD_TYPES, halfWidth } from './roadTypes';
import { type Box, type Edge, facingBody, inside, overlaps } from './sampleTown';
import { m } from './units';

/**
 * A town to explore, built on an empty map: a centre round a square - the
 * city hall and the church facing each other across it, a fountain, trees
 * and benches - high streets of shops, cafés and flats either side, a ring of
 * terraces, schools and churches, and beyond them streets of houses, every
 * one its own: its plan, its storeys, its roof, its walls, its windows, a
 * front garden with a path to the door, shrubs and a hedge or a fence, and
 * behind it a lawn with trees and, often, a pool. A park with a pond closes
 * one of the neighbourhoods.
 *
 * Every building is an ordinary building (`cityBuildings` models, varied, and
 * houses drawn up here), so each can be edited, entered and lived in.
 */

/** A small, repeatable random source: the same town every time. */
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
type Rng = () => number;
const pick = <T>(rng: Rng, list: readonly T[]): T => list[Math.floor(rng() * list.length) % list.length]!;
const between = (rng: Rng, a: number, b: number): number => a + (b - a) * rng();

// ---------------------------------------------------------------- the plan

/** Node lines, world units. The centre is the band between the two avenues. */
const XS = [-560, -240, 240, 560];
const YS = [-880, -680, -480, -160, 160, 480, 680, 880];
const LOCAL = ROAD_TYPES.findIndex((t) => t.id === 'local');
const URBAN = ROAD_TYPES.findIndex((t) => t.id === 'urban');
const FRONT_GAP = 0.12;

/** What each band of blocks is, from the south. */
type Band = 'houses' | 'terraces' | 'centre';
const BANDS: readonly Band[] = ['houses', 'houses', 'terraces', 'centre', 'terraces', 'houses', 'houses'];

// ---------------------------------------------------------------- palettes

const WALLS: readonly MaterialSpec[] = [
  mat('plaster', 0xf1ece2), mat('plaster', 0xe9dcc4), mat('plaster', 0xdcc8a8), mat('stucco', 0xe8d6b5),
  mat('plaster', 0xcfd8d2), mat('plaster', 0xe6cbbd), mat('plaster', 0xc9d1b4), mat('stucco', 0xf2e6cf),
  mat('brick', 0xa4563f), mat('brick', 0x8f4a38), mat('brick', 0xb8775c), mat('stone', 0xcfc7b6),
  mat('stone', 0xb9ae99), mat('wood', 0x8c6b4c), mat('wood', 0x6f5b48), mat('plaster', 0xf6f4ef),
  mat('concrete', 0xc8c6bf), mat('plaster', 0xd9b48f), mat('plaster', 0xbcc8d4),
];
const PITCHED_ROOFS: readonly MaterialSpec[] = [
  mat('tile', 0xb5603f), mat('tile', 0x9c4a33), mat('tile', 0x7f3d2d), mat('tile', 0xc0754e),
  mat('slate', 0x55595e), mat('slate', 0x40444a), mat('metal', 0x5d6b70), mat('roofing', 0x6b4a3a),
];
const FLAT_ROOFS: readonly MaterialSpec[] = [mat('concrete', 0x9a9890), mat('roofing', 0x5a5a58), mat('metal', 0x8b9396)];
const HEDGE = (rng: Rng): MaterialSpec => mat('wood', pick(rng, [0x3f5f33, 0x48693a, 0x3a5a36, 0x4f6f3c]));
const BOUNDARY: readonly MaterialSpec[] = [mat('stone', 0xbdb3a1), mat('plaster', 0xe9e2d4), mat('brick', 0x9b5440), mat('concrete', 0xb8b4aa)];

// ---------------------------------------------------------------- a house

interface Rect { x: number; y: number; w: number; d: number }

/** `outer` less `hole` (inside it): up to four strips round the hole. */
function around(outer: Rect, hole: Rect): Rect[] {
  const out: Rect[] = [];
  const x1 = outer.x + outer.w, y1 = outer.y + outer.d, hx1 = hole.x + hole.w, hy1 = hole.y + hole.d;
  if (hole.y - outer.y > 0.3) out.push({ x: outer.x, y: outer.y, w: outer.w, d: hole.y - outer.y });
  if (y1 - hy1 > 0.3) out.push({ x: outer.x, y: hy1, w: outer.w, d: y1 - hy1 });
  if (hole.x - outer.x > 0.3) out.push({ x: outer.x, y: hole.y, w: hole.x - outer.x, d: hole.d });
  if (x1 - hx1 > 0.3) out.push({ x: hx1, y: hole.y, w: x1 - hx1, d: hole.d });
  return out;
}

/**
 * An open lot, if it is big enough to be a block (two metres a side). A lawn
 * strip narrower than that is left to the ground, which is lawn anyway.
 */
function lotIn(model: Model, x: number, y: number, w: number, d: number, surface: 'grass' | 'paving' | 'gravel' | 'water'): void {
  if (w >= 2 && d >= 2) model.lot(x, y, w, d, surface);
}

type Style ='cottage' | 'villa' | 'modern' | 'bungalow' | 'barn';

/**
 * One house on a plot `W` wide and `D` deep (metres), its front on the
 * street at y = 0: drawn up from `rng`, so no two are alike.
 */
export function house(rng: Rng, W: number, D: number): BlueprintBody {
  const style = pick<Style>(rng, ['cottage', 'villa', 'modern', 'bungalow', 'barn', 'villa', 'cottage', 'modern']);
  const wall = style === 'modern' ? pick(rng, [mat('plaster', 0xf6f4ef), mat('concrete', 0xc8c6bf), mat('plaster', 0xe4e1da), mat('wood', 0x8c6b4c), mat('panel', 0x7d878e)])
    : style === 'barn' ? pick(rng, [mat('wood', 0x6f5b48), mat('wood', 0x8c6b4c), mat('wood', 0x5d4636), mat('plaster', 0xf1ece2)])
      : pick(rng, WALLS);
  const roofKind: RoofKind = style === 'modern' ? pick<RoofKind>(rng, ['flat', 'flat', 'shed', 'terrace'])
    : style === 'villa' ? pick<RoofKind>(rng, ['hip', 'hip', 'gable'])
      : style === 'bungalow' ? pick<RoofKind>(rng, ['hip', 'gable'])
        : 'gable';
  const roofMat = roofKind === 'flat' || roofKind === 'terrace' ? pick(rng, FLAT_ROOFS) : pick(rng, PITCHED_ROOFS);
  const pitch = roofKind === 'shed' ? between(rng, 8, 14) : roofKind === 'hip' ? between(rng, 22, 32)
    : style === 'barn' ? between(rng, 40, 50) : between(rng, 28, 42);
  const storeys = style === 'bungalow' ? 1 : style === 'modern' ? pick(rng, [1, 2, 2]) : pick(rng, [1, 2, 2, 2]);
  const fill: BayComponent = style === 'modern' ? pick<BayComponent>(rng, ['wideWindow', 'ribbon', 'window'])
    : style === 'cottage' ? pick<BayComponent>(rng, ['sashWindow', 'window'])
      : style === 'villa' ? pick<BayComponent>(rng, ['window', 'sashWindow', 'frenchWindow'])
        : 'window';
  const ground: BayComponent = style === 'modern' ? pick<BayComponent>(rng, ['frenchWindow', 'wideWindow'])
    : style === 'villa' ? pick<BayComponent>(rng, ['frenchWindow', 'bayWindow', 'window'])
      : style === 'cottage' ? pick<BayComponent>(rng, ['bayWindow', 'sashWindow'])
        : fill;

  const model = new Model('house', 'residential', Math.floor(rng() * 8)).heights(between(rng, 2.9, 3.4), between(rng, 2.8, 3.1))
    .look(wall, roofMat, pick(rng, [mat('plaster', 0xf6f4ef), mat('wood', 0x5a4636), mat('metal', 0x3a3d40)]));

  // The plan: front garden, house (and garage), back garden.
  const garage = W >= 15 && rng() < 0.55;
  const gw = garage ? between(rng, 3.4, 4) : 0;
  const hw = Math.min(W - 3 - gw, between(rng, 8, style === 'bungalow' ? 13 : 11.5));
  const hd = between(rng, 8, style === 'villa' ? 11 : 10);
  const fy = between(rng, 4.5, 7);
  const slack = W - hw - gw;
  const garageLeft = rng() < 0.5;
  const hx = garage ? (garageLeft ? gw + between(rng, 0.2, Math.max(0.2, slack - 1.5)) : between(rng, 1.2, Math.max(1.2, slack - 0.2))) : between(rng, 1.4, Math.max(1.4, slack - 1.4));
  const gx = garage ? (garageLeft ? hx - gw : hx + hw) : 0;
  const across = Math.max(1, Math.round(hw / 3));
  const door = Math.min(across - 1, Math.floor(rng() * across));
  const doorX = hx + (door + 0.5) * (hw / across);
  model.block({ x: hx, y: fy, w: hw, d: hd, storeys, roof: roofKind, pitch, fill, ground, door, doorKind: style === 'villa' && rng() < 0.4 ? 'doubleDoor' : 'door' });
  // A wing behind: an L, one storey or the same.
  let backOf = fy + hd;
  if (rng() < 0.45 && D - backOf > 12) {
    const ww = between(rng, 4, Math.min(7, hw - 1));
    const wd = between(rng, 3.5, 6);
    const wx = rng() < 0.5 ? hx : hx + hw - ww;
    model.block({ x: wx, y: fy + hd, w: ww, d: wd, storeys: rng() < 0.6 ? 1 : storeys, roof: roofKind === 'hip' ? 'gable' : roofKind, pitch, fill, roofMaterial: roofMat });
    // The rest of that strip is lawn.
    if (wx > 0.3) lotIn(model, 0, fy + hd, wx, wd, 'grass');
    if (W - (wx + ww) > 0.3) lotIn(model, wx + ww, fy + hd, W - (wx + ww), wd, 'grass');
    backOf = fy + hd + wd;
  }
  if (garage) {
    model.block({ x: gx, y: fy + between(rng, 0, 1.5), w: gw, d: between(rng, 5.6, 6.4), roof: rng() < 0.5 ? 'flat' : roofKind === 'hip' ? 'gable' : roofKind, pitch, fill: 'wall', door: 0, doorKind: 'garageDoor', roofMaterial: roofMat });
  }
  // Lawns round the house: in front, at its sides, behind.
  lotIn(model, 0, 0, W, fy, 'grass');
  const builtX0 = garage ? Math.min(hx, gx) : hx;
  const builtX1 = garage ? Math.max(hx + hw, gx + gw) : hx + hw;
  if (builtX0 > 0.3) lotIn(model, 0, fy, builtX0, hd, 'grass');
  if (W - builtX1 > 0.3) lotIn(model, builtX1, fy, W - builtX1, hd, 'grass');
  if (garage) {
    // The strip in front of or behind a garage shorter than the house.
    const gy0 = fy;
    void gy0;
  }
  const back: Rect = { x: 0, y: backOf, w: W, d: D - backOf };
  const leaf = (): MaterialSpec => HEDGE(rng);
  if (back.d > 0.5) {
    const pool = back.d >= 12 && W >= 12 && rng() < 0.6;
    if (pool) {
      const pw = between(rng, 3.2, Math.min(5.5, W - 5));
      const pd = between(rng, 6, Math.min(10, back.d - 6));
      const deck: Rect = { x: between(rng, 1.2, W - pw - 5.2), y: back.y + between(rng, 1.4, back.d - pd - 4.4), w: pw + 4, d: pd + 4 };
      const water: Rect = { x: deck.x + 2, y: deck.y + 2, w: pw, d: pd };
      for (const r of around(back, deck)) lotIn(model, r.x, r.y, r.w, r.d, 'grass');
      for (const r of around(deck, water)) lotIn(model, r.x, r.y, r.w, r.d, 'paving');
      lotIn(model, water.x, water.y, water.w, water.d, 'water');
      // Loungers' place: a bench on the deck, a planter at a corner.
      model.el('bench', deck.x + deck.w / 2, deck.y + deck.d - 0.5, 2, { w: 1.6 });
      if (rng() < 0.6) model.el('planter', deck.x + 0.5, deck.y + 0.5, 0, { w: 0.7, d: 0.7, h: 0.6 });
      // Trees away from the water.
      const far = deck.x > W / 2 ? 2.5 : W - 2.5;
      for (let i = 0; i < 1 + Math.floor(rng() * 2); i++) {
        const h = between(rng, 4.5, 8.5);
        model.el('tree', far + between(rng, -0.8, 0.8), back.y + h * 0.3 + 0.4 + rng() * Math.max(0, back.d - h * 0.6 - 0.8), 0, { w: h * 0.6, d: h * 0.6, h });
      }
    } else {
      lotIn(model, back.x, back.y, back.w, back.d, 'grass');
      for (let i = 0; i < 1 + Math.floor(rng() * 3); i++) {
        const h = between(rng, 4, 9);
        model.el('tree', between(rng, 2.5, W - 2.5), back.y + h * 0.3 + 0.4 + rng() * Math.max(0, back.d - h * 0.6 - 0.8), 0, { w: h * 0.6, d: h * 0.6, h });
      }
      if (rng() < 0.5) model.el('bench', between(rng, 2, W - 2), back.y + 1.2, 0, { w: 1.6 });
      if (rng() < 0.4) model.el('flowers', between(rng, 1.5, W - 1.5), back.y + back.d - 1.2, 0, { w: between(rng, 1.4, 3), d: 1.2 });
    }
    // Hedges along the back garden's sides and end, more often than not.
    if (rng() < 0.7) {
      const hm = leaf();
      model.el('hedge', 0.4, back.y + back.d / 2, 3, { w: back.d - 0.4, d: 0.8, h: between(rng, 1.4, 2), material: hm });
      model.el('hedge', W - 0.4, back.y + back.d / 2, 1, { w: back.d - 0.4, d: 0.8, h: between(rng, 1.4, 2), material: hm });
      model.el('hedge', W / 2, D - 0.4, 2, { w: W - 1.6, d: 0.8, h: between(rng, 1.6, 2.2), material: hm });
    }
  }

  // The front garden: a path to the door, a drive to the garage, and the
  // boundary on the street with a gap for each.
  model.el('pavement', doorX, fy / 2, 0, { w: between(rng, 1.1, 1.6), d: fy, h: 0.12, material: pick(rng, [mat('stone', 0xc9c0ae), mat('brick', 0xa86a52), mat('concrete', 0xc2bfb6), mat('stone', 0xb3aa98)]) });
  const gaps: [number, number][] = [[doorX - 0.9, doorX + 0.9]];
  if (garage) {
    model.el('pavement', gx + gw / 2, fy / 2, 0, { w: gw - 0.4, d: fy, h: 0.12, material: mat('concrete', 0xb9b6ae) });
    gaps.push([gx, gx + gw]);
  }
  const boundary = pick(rng, ['hedge', 'hedge', 'fence', 'wall', 'none'] as const);
  if (boundary !== 'none') {
    const bm = boundary === 'hedge' ? leaf() : boundary === 'wall' ? pick(rng, BOUNDARY) : mat('metal', pick(rng, [0x2f3336, 0xe9e6df, 0x4b5153]));
    const h = boundary === 'hedge' ? between(rng, 0.9, 1.3) : boundary === 'wall' ? between(rng, 0.6, 0.9) : 1;
    const d = boundary === 'hedge' ? 0.7 : boundary === 'wall' ? 0.25 : 0.12;
    const runs: [number, number][] = [];
    let from = 0.2;
    for (const [a, b] of gaps.sort((p, q) => p[0] - q[0])) {
      if (a - from > 0.4) runs.push([from, a]);
      from = Math.max(from, b);
    }
    if (W - 0.2 - from > 0.4) runs.push([from, W - 0.2]);
    for (const [a, b] of runs) model.el(boundary, (a + b) / 2, d / 2 + 0.05, 0, { w: b - a, d, h, material: bm });
  }
  // Shrubs along the front of the house, clear of the door; flowers; a tree.
  const shrubs = 2 + Math.floor(rng() * 4);
  for (let i = 0; i < shrubs; i++) {
    const x = hx + 0.8 + rng() * (hw - 1.6);
    if (Math.abs(x - doorX) < 1.4) continue;
    const s = between(rng, 0.9, 1.6);
    model.el('shrub', x, fy - s / 2 - between(rng, 0.15, 0.4), 0, { w: s, d: s, h: s * between(rng, 0.7, 1.1), material: HEDGE(rng) });
  }
  if (rng() < 0.7) model.el('flowers', doorX + pick(rng, [-1.8, 1.8]), fy * 0.45, 0, { w: between(rng, 1.2, 2.4), d: 1, h: 0.4 });
  if (rng() < 0.45) {
    const h = between(rng, 4, 7);
    const x = doorX < W / 2 ? between(rng, W - 3, W - 2) : between(rng, 2, 3);
    if (!garage || x < gx - 1.5 || x > gx + gw + 1.5) model.el('tree', x, fy * 0.5, 0, { w: h * 0.55, d: h * 0.55, h });
  }
  if (rng() < 0.3) model.el('rocks', between(rng, 1, W - 1), fy * between(rng, 0.3, 0.7), 0, { w: 1.2, d: 1, h: 0.5 });
  return model.build();
}

// ---------------------------------------------------------------- variety

/** A catalogue model made its own: other walls and roof, a storey more or less. */
export function varied(rng: Rng, fn: BuildingFunction): BlueprintBody | null {
  const model = cityBuilding(fn);
  if (!model) return null;
  const body = JSON.parse(JSON.stringify(model.body)) as BlueprintBody;
  const homes = fn === 'townhouse' || fn === 'apartments' || fn === 'house';
  const shop = fn === 'shop' || fn === 'bakery' || fn === 'pharmacy' || fn === 'snackBar' || fn === 'bar' || fn === 'restaurant';
  if (homes || shop || fn === 'office' || fn === 'hotel') {
    const wall = pick(rng, WALLS);
    const roof = body.volumes.some((v) => v.roof !== 'flat') ? pick(rng, PITCHED_ROOFS) : pick(rng, FLAT_ROOFS);
    body.materials = { ...(body.materials ?? {}), wall, roof };
    for (const v of body.volumes) if (v.materials) delete v.materials;
  }
  // Heights: terraces and shops a storey up or down, flats up to two.
  if (fn === 'townhouse' || shop || fn === 'apartments') {
    const v = body.volumes.find((o) => !o.open && o.base === 0);
    if (v) {
      const change = fn === 'apartments' ? pick(rng, [-1, 0, 1, 2]) : pick(rng, [-1, 0, 0, 1]);
      const n = Math.max(shop ? 1 : 2, v.storeys.length + change);
      while (v.storeys.length < n) v.storeys.push(JSON.parse(JSON.stringify(v.storeys[v.storeys.length - 1])));
      v.storeys.length = n;
      const top = Math.max(...body.volumes.map((o) => o.base + o.storeys.length)) - 1;
      for (const c of body.cores ?? []) c.to = Math.min(c.to, top);
      if (fn === 'apartments') for (const c of body.cores ?? []) c.to = top;
    }
  }
  // Townhouses: a window of their own, and sometimes a hipped or flat roof.
  if (fn === 'townhouse') {
    const fill = pick<BayComponent>(rng, ['window', 'sashWindow', 'frenchWindow', 'bayWindow']);
    for (const v of body.volumes) for (const s of v.storeys) s.facade.fill = fill;
    const roof = pick<RoofKind>(rng, ['gable', 'gable', 'hip', 'flat']);
    for (const v of body.volumes) v.roof = roof;
  }
  return body;
}

// ---------------------------------------------------------------- the build

/** What the terrace and centre blocks hold, in order round them. */
const TERRACE_BLOCKS: readonly (readonly BuildingFunction[])[] = [
  ['school', 'townhouse', 'townhouse', 'bakery', 'townhouse', 'townhouse', 'apartments', 'townhouse', 'townhouse'],
  ['church', 'townhouse', 'townhouse', 'apartments', 'townhouse', 'pharmacy', 'townhouse', 'townhouse', 'library'],
  ['clinic', 'townhouse', 'apartments', 'townhouse', 'snackBar', 'townhouse', 'townhouse', 'apartments', 'townhouse'],
  ['gym', 'townhouse', 'townhouse', 'apartments', 'townhouse', 'shop', 'townhouse', 'townhouse', 'postOffice'],
  ['townhouse', 'apartments', 'townhouse', 'bakery', 'townhouse', 'townhouse', 'apartments', 'townhouse', 'townhouse'],
  ['police', 'townhouse', 'townhouse', 'shop', 'apartments', 'townhouse', 'townhouse', 'townhouse', 'apartments'],
];
const HIGH_STREET: readonly (readonly BuildingFunction[])[] = [
  ['bank', 'shop', 'restaurant', 'bakery', 'pharmacy', 'shop', 'bar', 'apartments', 'hotel', 'shop', 'snackBar', 'apartments', 'office'],
  ['cinema', 'restaurant', 'shop', 'bar', 'apartments', 'shop', 'supermarket', 'snackBar', 'apartments', 'shop', 'office'],
];
const FILL_TERRACE: readonly BuildingFunction[] = ['townhouse', 'shop'];
const FILL_CENTRE: readonly BuildingFunction[] = ['shop', 'townhouse'];

export interface Placer {
  readonly placed: Box[];
  put(body: Omit<Building, 'id'>, box: Box): void;
}

/** Fronts all round `lot`, from `wanted` in order, then the gaps closed with `fillers`. */
export function perimeter(rng: Rng, lot: Box, wanted: BuildingFunction[], fillers: readonly BuildingFunction[], into: Placer): void {
  const w = lot.x1 - lot.x0, d = lot.y1 - lot.y0;
  const edges: Edge[] = [
    { start: { x: lot.x0, y: lot.y0 }, along: { x: 1, y: 0 }, inward: { x: 0, y: 1 }, length: w },
    { start: { x: lot.x1, y: lot.y0 }, along: { x: 0, y: 1 }, inward: { x: -1, y: 0 }, length: d },
    { start: { x: lot.x1, y: lot.y1 }, along: { x: -1, y: 0 }, inward: { x: 0, y: -1 }, length: w },
    { start: { x: lot.x0, y: lot.y1 }, along: { x: 0, y: -1 }, inward: { x: 1, y: 0 }, length: d },
  ];
  for (const pass of [wanted, null] as const) {
    for (const edge of edges) {
      let t = 0;
      while (t < edge.length - m(4)) {
        const choices = pass ? pass.slice(0, 1) : fillers;
        let done = false;
        for (const fn of choices) {
          const body = varied(rng, fn);
          if (!body) continue;
          const f = facingBody(body, fn, edge, t, FRONT_GAP);
          if (t + f.width > edge.length + 0.5) continue;
          if (!inside(f.box, lot) || into.placed.some((o) => overlaps(f.box, o, -0.05))) continue;
          into.put(f.body, f.box);
          if (pass) pass.shift();
          t += f.width;
          done = true;
          break;
        }
        if (pass && !pass.length) break;
        if (!done) t += m(1);
      }
    }
  }
}

/** A block of houses: two rows back to back, each house on its own plot. */
export function houses(rng: Rng, lot: Box, into: Placer): void {
  const depth = (lot.y1 - lot.y0) / 2;
  const rows: Edge[] = [
    { start: { x: lot.x0, y: lot.y0 }, along: { x: 1, y: 0 }, inward: { x: 0, y: 1 }, length: lot.x1 - lot.x0 },
    { start: { x: lot.x1, y: lot.y1 }, along: { x: -1, y: 0 }, inward: { x: 0, y: -1 }, length: lot.x1 - lot.x0 },
  ];
  for (const edge of rows) {
    let t = 0;
    while (true) {
      const left = (edge.length - t) / m(1);
      if (left < 12) break;
      // The last plot takes what is left, if a normal one would leave a sliver.
      let W = between(rng, 14, 20);
      if (left - W < 12) W = left;
      if (W > 24) W = left / 2;
      const body = house(rng, W, depth / m(1) - FRONT_GAP / m(1) - 0.1);
      const f = facingBody(body, 'house', edge, t, FRONT_GAP);
      // Plots are full width (their lawns reach both sides), so the box is the plot.
      if (inside(f.box, lot) && !into.placed.some((o) => overlaps(f.box, o, -0.05))) into.put({ ...f.body, function: 'house' }, f.box);
      t += m(W);
    }
  }
}

/**
 * The square at the heart of the town: a cross of paving with a fountain
 * where its arms meet, lawns with trees in the four corners, benches facing
 * the water, flowers and shrubs. (A building has at most 24 blocks and 64
 * parts: the plan is kept to that.)
 */
export function square(rng: Rng, Wm: number, Dm: number): BlueprintBody {
  const model = new Model('square', 'commercial', 3);
  const arm = Math.min(18, Math.max(12, Math.min(Wm, Dm) * 0.3));
  const pond: Rect = { x: Wm / 2 - arm / 2 + 3, y: Dm / 2 - arm / 2 + 3, w: arm - 6, d: arm - 6 };
  const hub: Rect = { x: Wm / 2 - arm / 2, y: Dm / 2 - arm / 2, w: arm, d: arm };
  // The arms of the cross, and the hub less the basin.
  lotIn(model, 0, hub.y, hub.x, arm, 'paving');
  lotIn(model, hub.x + arm, hub.y, Wm - hub.x - arm, arm, 'paving');
  lotIn(model, hub.x, 0, arm, hub.y, 'paving');
  lotIn(model, hub.x, hub.y + arm, arm, Dm - hub.y - arm, 'paving');
  for (const r of around(hub, pond)) lotIn(model, r.x, r.y, r.w, r.d, 'paving');
  lotIn(model, pond.x, pond.y, pond.w, pond.d, 'water');
  const lawns: Rect[] = [
    { x: 0, y: 0, w: hub.x, d: hub.y }, { x: hub.x + arm, y: 0, w: Wm - hub.x - arm, d: hub.y },
    { x: 0, y: hub.y + arm, w: hub.x, d: Dm - hub.y - arm }, { x: hub.x + arm, y: hub.y + arm, w: Wm - hub.x - arm, d: Dm - hub.y - arm },
  ];
  for (const l of lawns) lotIn(model, l.x, l.y, l.w, l.d, 'grass');
  // Trees in each lawn (a few), a flower bed and shrubs at the corner on the cross.
  for (const l of lawns) {
    const n = Math.min(4, Math.max(1, Math.floor((l.w * l.d) / 220)));
    for (let i = 0; i < n; i++) {
      const h = between(rng, 7, 11);
      const r = h * 0.3 + 0.5;
      model.el('tree', between(rng, l.x + r, l.x + l.w - r), between(rng, l.y + r, l.y + l.d - r), 0, { w: h * 0.6, d: h * 0.6, h });
    }
    const cx = l.x < hub.x ? l.x + l.w - 2 : l.x + 2;
    const cy = l.y < hub.y ? l.y + l.d - 2 : l.y + 2;
    model.el('flowers', cx, cy, 0, { w: 2.6, d: 2.6, h: 0.45 });
    model.el('shrub', cx + (l.x < hub.x ? -3 : 3), cy, 0, { w: 1.6, d: 1.6, h: 1.3, material: HEDGE(rng) });
    model.el('shrub', cx, cy + (l.y < hub.y ? -3 : 3), 0, { w: 1.4, d: 1.4, h: 1.1, material: HEDGE(rng) });
  }
  // Benches round the basin, facing it.
  const sides: [number, number, Side][] = [[Wm / 2, hub.y + 1, 2], [Wm / 2, hub.y + arm - 1, 0], [hub.x + 1, Dm / 2, 1], [hub.x + arm - 1, Dm / 2, 3]];
  for (const [x, y, f] of sides) {
    const along = f === 0 || f === 2;
    for (const k of [-3, 3]) model.el('bench', x + (along ? k : 0), y + (along ? 0 : k), f, { w: 1.8 });
  }
  return model.build();
}

/** A park: lawn, a pond, paths across it, trees in groups, shrubs, benches, a playground corner. */
export function park(rng: Rng, Wm: number, Dm: number): BlueprintBody {
  const model = new Model('park', 'commercial', 2);
  const pond: Rect = { x: Wm * between(rng, 0.45, 0.55), y: Dm * between(rng, 0.25, 0.35), w: Math.min(26, Wm * 0.3), d: Math.min(16, Dm * 0.3) };
  const pathW = 2.4;
  const cross: Rect = { x: 0, y: Dm * 0.62, w: Wm, d: pathW };
  // Lawn everywhere but the pond and the path across.
  const above: Rect = { x: 0, y: 0, w: Wm, d: cross.y };
  for (const r of around(above, pond)) lotIn(model, r.x, r.y, r.w, r.d, 'grass');
  lotIn(model, pond.x, pond.y, pond.w, pond.d, 'water');
  lotIn(model, cross.x, cross.y, cross.w, cross.d, 'gravel');
  lotIn(model, 0, cross.y + cross.d, Wm, Dm - cross.y - cross.d, 'grass');
  // Trees in clumps, avoiding the pond and the path.
  for (let i = 0; i < Math.min(26, Math.floor((Wm * Dm) / 260)); i++) {
    const x = between(rng, 3, Wm - 3), y = between(rng, 3, Dm - 3);
    if (x > pond.x - 4 && x < pond.x + pond.w + 4 && y > pond.y - 4 && y < pond.y + pond.d + 4) continue;
    if (Math.abs(y - (cross.y + pathW / 2)) < 4) continue;
    const h = between(rng, 6, 13);
    model.el('tree', x, y, 0, { w: h * 0.6, d: h * 0.6, h });
  }
  for (let i = 0; i < 14; i++) {
    const x = between(rng, 2, Wm - 2), y = between(rng, 2, Dm - 2);
    if (x > pond.x - 1.5 && x < pond.x + pond.w + 1.5 && y > pond.y - 1.5 && y < pond.y + pond.d + 1.5) continue;
    if (Math.abs(y - (cross.y + pathW / 2)) < 2.5) continue;
    const s = between(rng, 1, 2);
    model.el('shrub', x, y, 0, { w: s, d: s, h: s * 0.8, material: HEDGE(rng) });
  }
  for (let x = 8; x < Wm - 4; x += 20) {
    model.el('bench', x, cross.y - 0.6, 0, { w: 1.8 });
    model.el('flowers', x + 7, cross.y + pathW + 1, 0, { w: 3, d: 1.2 });
  }
  for (let i = 0; i < 4; i++) model.el('rocks', pond.x + between(rng, 0, pond.w), pond.y - 0.9, 0, { w: 1.2, d: 0.9, h: 0.5 });
  return model.build();
}

/**
 * The garden inside a block of terraces: lawn round a gravel walk, trees,
 * shrubs, flower beds and benches; in a big one, a games court.
 */
export function courtyard(rng: Rng, Wm: number, Dm: number): BlueprintBody {
  const model = new Model('square', 'commercial', 1);
  const walk = 2.2;
  const inner: Rect = { x: 4, y: 4, w: Wm - 8, d: Dm - 8 };
  const court = Wm > 34 && Dm > 26 && rng() < 0.6;
  // The walk all round, 4 m in; lawn outside and inside it.
  const ring: Rect = { x: inner.x - walk, y: inner.y - walk, w: inner.w + walk * 2, d: inner.d + walk * 2 };
  for (const r of around({ x: 0, y: 0, w: Wm, d: Dm }, ring)) lotIn(model, r.x, r.y, r.w, r.d, 'grass');
  for (const r of around(ring, inner)) lotIn(model, r.x, r.y, r.w, r.d, 'gravel');
  if (court) {
    const c: Rect = { x: inner.x + inner.w / 2 - 9, y: inner.y + inner.d / 2 - 6, w: 18, d: 12 };
    for (const r of around(inner, c)) lotIn(model, r.x, r.y, r.w, r.d, 'grass');
    lotIn(model, c.x, c.y, c.w, c.d, 'paving');
    model.ring('fence', c.x, c.y, c.w, c.d, 3);
  } else lotIn(model, inner.x, inner.y, inner.w, inner.d, 'grass');
  // Trees in the lawn inside the walk, clear of the court.
  const n = Math.min(14, Math.floor((inner.w * inner.d) / 120));
  for (let i = 0; i < n; i++) {
    const h = between(rng, 5, 10);
    const r = h * 0.3 + 0.4;
    const x = between(rng, inner.x + r, inner.x + inner.w - r), y = between(rng, inner.y + r, inner.y + inner.d - r);
    if (court && Math.abs(x - (inner.x + inner.w / 2)) < 9 + r + 1 && Math.abs(y - (inner.y + inner.d / 2)) < 6 + r + 1) continue;
    model.el('tree', x, y, 0, { w: h * 0.6, d: h * 0.6, h });
  }
  for (let i = 0; i < 8; i++) {
    const s = between(rng, 1, 1.8);
    const x = between(rng, inner.x + 1, inner.x + inner.w - 1), y = between(rng, inner.y + 1, inner.y + inner.d - 1);
    if (court && Math.abs(x - (inner.x + inner.w / 2)) < 11 && Math.abs(y - (inner.y + inner.d / 2)) < 8) continue;
    model.el('shrub', x, y, 0, { w: s, d: s, h: s * 0.8, material: HEDGE(rng) });
  }
  for (const [x, y, f] of [[Wm / 2, inner.y - walk - 0.6, 2], [Wm / 2, inner.y + inner.d + walk + 0.6, 0]] as const) {
    model.el('bench', x - 4, y, f as Side, { w: 1.8 });
    model.el('bench', x + 4, y, f as Side, { w: 1.8 });
    model.el('flowers', x, y, 0, { w: 3, d: 1, h: 0.4 });
  }
  return model.build();
}

/** The biggest garden that fits in the middle of `lot`, clear of what stands round it. */
function fillMiddle(rng: Rng, lot: Box, into: Placer): void {
  for (let inset = m(14); inset < Math.min(lot.x1 - lot.x0, lot.y1 - lot.y0) / 2 - m(10); inset += m(2)) {
    const box: Box = { x0: lot.x0 + inset, y0: lot.y0 + inset, x1: lot.x1 - inset, y1: lot.y1 - inset };
    if (into.placed.some((o) => overlaps(box, o, m(1)))) continue;
    const body = courtyard(rng, (box.x1 - box.x0) / m(1), (box.y1 - box.y0) / m(1));
    const edge: Edge = { start: { x: box.x0, y: box.y0 }, along: { x: 1, y: 0 }, inward: { x: 0, y: 1 }, length: box.x1 - box.x0 };
    const f = facingBody(body, 'square', edge, 0, 0);
    into.put({ ...f.body, function: 'square' }, f.box);
    return;
  }
}

/** Builds the town on `doc`, which should be empty. Returns how many buildings it put up. */
export function buildTown(doc: RoadDoc): number {
  const rng = random(0x70a1);
  const ids = new Map<string, number>();
  for (const y of YS) for (const x of XS) ids.set(`${x},${y}`, doc.addNode({ x, y }).id);
  const node = (x: number, y: number) => ids.get(`${x},${y}`)! as Parameters<RoadDoc['addSegment']>[0];
  const centreAvenue = (y: number): boolean => y === YS[3] || y === YS[4];
  const typeAt = (y: number): number => (centreAvenue(y) ? URBAN : LOCAL);
  for (const y of YS) for (let i = 0; i + 1 < XS.length; i++) doc.addSegment(node(XS[i]!, y), node(XS[i + 1]!, y), typeAt(y));
  for (const x of XS) for (let j = 0; j + 1 < YS.length; j++) {
    const centre = BANDS[j] === 'centre' && (x === XS[1] || x === XS[2]);
    doc.addSegment(node(x, YS[j]!), node(x, YS[j + 1]!), centre ? URBAN : LOCAL);
  }

  const half = (type: number): number => halfWidth(ROAD_TYPES[type]!, Level.Sidewalk);
  const into: Placer = {
    placed: [],
    put(body, box) {
      doc.buildings.add(body);
      this.placed.push(box);
      count++;
    },
  };
  let count = 0;
  let terrace = 0;
  let high = 0;
  for (let j = 0; j + 1 < YS.length; j++) {
    for (let i = 0; i + 1 < XS.length; i++) {
      const band = BANDS[j]!;
      const xType = (x: number): number => (band === 'centre' && (x === XS[1] || x === XS[2]) ? URBAN : LOCAL);
      const lot: Box = {
        x0: XS[i]! + half(xType(XS[i]!)), x1: XS[i + 1]! - half(xType(XS[i + 1]!)),
        y0: YS[j]! + half(typeAt(YS[j]!)), y1: YS[j + 1]! - half(typeAt(YS[j + 1]!)),
      };
      const Wm = (lot.x1 - lot.x0) / m(1), Dm = (lot.y1 - lot.y0) / m(1);
      if (band === 'centre' && i === 1) {
        // The square: the city hall on its south side and the church on its
        // north, each with its front on the square, facing the other.
        let y0 = lot.y0, y1 = lot.y1;
        for (const fn of ['cityHall', 'church'] as const) {
          const body = varied(rng, fn);
          if (!body) continue;
          const south = fn === 'cityHall';
          const probeEdge: Edge = { start: { x: 0, y: 0 }, along: { x: south ? -1 : 1, y: 0 }, inward: { x: 0, y: south ? -1 : 1 }, length: 1 };
          const probe = facingBody(body, fn, probeEdge, 0, FRONT_GAP);
          const depth = probe.box.y1 - probe.box.y0;
          const line = south ? lot.y0 + depth + FRONT_GAP * 2 : lot.y1 - depth - FRONT_GAP * 2;
          const edge: Edge = south
            ? { start: { x: lot.x1, y: line }, along: { x: -1, y: 0 }, inward: { x: 0, y: -1 }, length: lot.x1 - lot.x0 }
            : { start: { x: lot.x0, y: line }, along: { x: 1, y: 0 }, inward: { x: 0, y: 1 }, length: lot.x1 - lot.x0 };
          const f = facingBody(body, fn, edge, (edge.length - probe.width) / 2, FRONT_GAP);
          if (!inside(f.box, lot)) continue;
          into.put(f.body, f.box);
          if (south) y0 = Math.max(y0, f.box.y1); else y1 = Math.min(y1, f.box.y0);
        }
        // The square fills between them.
        const sx0 = lot.x0, sx1 = lot.x1, sy0 = y0 + m(0.5), sy1 = y1 - m(0.5);
        if (sy1 - sy0 > m(16)) {
          const body = square(rng, (sx1 - sx0) / m(1), (sy1 - sy0) / m(1));
          const edge: Edge = { start: { x: sx0, y: sy0 }, along: { x: 1, y: 0 }, inward: { x: 0, y: 1 }, length: sx1 - sx0 };
          const f = facingBody(body, 'square', edge, 0, 0);
          into.put({ ...f.body, function: 'square' }, f.box);
        }
        continue;
      }
      if (band === 'centre') {
        perimeter(rng, lot, [...HIGH_STREET[high++ % HIGH_STREET.length]!], FILL_CENTRE, into);
        fillMiddle(rng, lot, into);
        continue;
      }
      if (band === 'terraces') {
        perimeter(rng, lot, [...TERRACE_BLOCKS[terrace++ % TERRACE_BLOCKS.length]!], FILL_TERRACE, into);
        fillMiddle(rng, lot, into);
        continue;
      }
      // Houses; one block of them is the park.
      if (j === 1 && i === 2) {
        const body = park(rng, Wm, Dm);
        const edge: Edge = { start: { x: lot.x0, y: lot.y0 }, along: { x: 1, y: 0 }, inward: { x: 0, y: 1 }, length: lot.x1 - lot.x0 };
        const f = facingBody(body, 'park', edge, 0, 0);
        into.put({ ...f.body, function: 'park' }, f.box);
        continue;
      }
      houses(rng, lot, into);
    }
  }
  return count;
}
