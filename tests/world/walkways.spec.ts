import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { bands, surfaces } from '@world/surfaces';
import { pointInPolygon } from '@core/polygon';
import { area, type MultiPoly } from '@core/clipper';
import { roadProfile } from '@world/roadTypes';
import { sectionOf } from '@world/section';
import { buildWalkways, deckOf, type WalkGraph } from '@world/walkways';
import { fixtureDoc, LAYOUTS, layoutDoc } from '../sim/support/bodies';

/**
 * The pedestrian network (`walkways.ts`) as a player's city has it: footways
 * down the middle of the through zone, corners on the paving round every
 * kind of corner the junction builder draws, crossings over the road, every
 * piece joined to the next without a kink - and exactly as connected as the
 * paving drawn: one walking loop for each island of footway.
 */
const ring = (r: number[][]) => r.map(([x, y]) => ({ x: x!, y: y! }));
const insidePoly = (poly: number[][][], x: number, y: number): boolean => {
  const [outer, ...holes] = poly;
  if (!outer || !pointInPolygon({ x, y }, ring(outer))) return false;
  return !holes.some((h) => pointInPolygon({ x, y }, ring(h)));
};
const inside = (polys: MultiPoly, x: number, y: number): boolean => polys.some((p) => insidePoly(p, x, y));

function city(name: string): Network {
  let doc: RoadDoc;
  if (name === 'player-city') {
    const raw = JSON.parse(readFileSync(join(process.cwd(), 'tests', 'fixtures', 'player-city.json'), 'utf8')) as { document: unknown };
    doc = RoadDoc.fromJSON(raw.document as never);
  } else if (name === 'grid-and-bends') doc = fixtureDoc();
  else doc = layoutDoc(LAYOUTS.find((l) => l.name === name)!, 300).doc;
  const net = new Network(doc);
  net.rebuild();
  return net;
}

/** Connected pieces of the graph, without the crossings: node -> piece. */
function pieces(g: WalkGraph): Map<number, number> {
  const piece = new Map<number, number>();
  let next = 0;
  for (const start of g.nodes) {
    if (piece.has(start.id)) continue;
    const stack = [start.id];
    piece.set(start.id, next);
    while (stack.length) {
      const n = stack.pop()!;
      for (const wi of g.at.get(n) ?? []) {
        const w = g.ways[wi]!;
        if (w.kind === 'crossing') continue;
        for (const m of [w.a, w.b]) if (!piece.has(m)) { piece.set(m, next); stack.push(m); }
      }
    }
    next++;
  }
  return piece;
}

const CITIES = ['player-city', 'grid-and-bends', ...LAYOUTS.map((l) => l.name)];

describe('walkways', () => {
  for (const name of CITIES) {
    it(`${name}: footways run down the through zone; corners lie on the paving; crossings over the road`, () => {
      const net = city(name);
      const doc = net.doc;
      const g = buildWalkways(net);
      const paving = new Map<string, { paved: MultiPoly; road: MultiPoly }>();
      const deckPaving = (deck: string) => {
        let p = paving.get(deck);
        if (!p) {
          const b = bands(surfaces(net, (id) => deckOf(doc, id) === deck));
          p = { paved: [...b.footway, ...b.kerb], road: [...b.carriageway, ...b.kerb] };
          paving.set(deck, p);
        }
        return p;
      };
      let off = 0, samples = 0;
      const where: string[] = [];
      for (const w of g.ways) {
        if (w.kind === 'footway') {
          // Construction: the footway is its road's centreline offset to the
          // middle of the through zone - check it is (the paving of crossing
          // decks cannot tell a viaduct's footway from the road under it).
          const seg = doc.requireSegment(w.segment!);
          const through = sectionOf(roadProfile(seg.type, seg.lanes, seg.direction), seg.direction).side.through;
          const centre = net.ribbons.get(w.segment!)!.full;
          for (let s = 0; s <= w.path.length; s += 2) {
            const p = w.path.sampleAt(s).p;
            const across = centre.distanceTo(p);
            samples++;
            if (across < through.inner - 1e-3 || across > through.outer + 1e-3) { off++; if (where.length < 5) where.push(`footway#${w.id} ${across.toFixed(2)}`); }
          }
          continue;
        }
        // A corner at a ramp's foot spans both decks.
        const decks = w.kind === 'corner'
          ? [...new Set(doc.requireNode(w.node!).incident.map((id) => deckOf(doc, id)))]
          : [w.structure];
        const area = decks.flatMap((d) => (w.kind === 'crossing' ? [...deckPaving(d).road, ...deckPaving(d).paved] : deckPaving(d).paved));
        for (let s = 0; s <= w.path.length; s += 0.5) {
          const p = w.path.sampleAt(s).p;
          samples++;
          if (!inside(area, p.x, p.y)) { off++; if (where.length < 5) where.push(`${w.kind}#${w.id} at ${p.x.toFixed(1)},${p.y.toFixed(1)}`); }
        }
      }
      expect(samples).toBeGreaterThan(50);
      expect(off, where.join('; ')).toBe(0);
    });

    it(`${name}: joined without kinks`, () => {
      const g = buildWalkways(city(name));
      expect(g.ways.filter((w) => w.kind === 'corner').length).toBeGreaterThan(0);
      for (const w of g.ways.filter((x) => x.kind === 'corner')) {
        for (const [end, s] of [[w.a, 0], [w.b, w.path.length]] as const) {
          const t = w.path.sampleAt(s).t;
          for (const wi of g.at.get(end) ?? []) {
            const f = g.ways[wi]!;
            if (f.kind !== 'footway') continue;
            const ft = f.path.sampleAt(f.a === end ? 0 : f.path.length).t;
            const cos = Math.abs(t.x * ft.x + t.y * ft.y);
            expect(cos, `corner #${w.id} (road node ${w.node}) at walk node ${end}`).toBeGreaterThan(Math.cos((5 * Math.PI) / 180));
          }
        }
      }
    });

    it(`${name}: one walking loop for each island of footway drawn`, () => {
      const net = city(name);
      const doc = net.doc;
      const g = buildWalkways(net);
      const piece = pieces(g);
      // Islands of footway at grade, as drawn (big enough to walk round).
      const b = bands(surfaces(net, (id) => deckOf(doc, id) === 'ground'));
      const islands = [...b.footway, ...b.kerb];
      const merged = islands.length ? islands : [];
      // One footway polygon per island: union them.
      const union = mergedIslands(merged);
      const groundPieces = new Map<number, Set<number>>();
      for (const w of g.ways) {
        if (w.kind === 'crossing') continue;
        const pc = piece.get(w.a)!;
        const decks = groundPieces.get(pc) ?? new Set<number>();
        if (w.structure !== 'ground') decks.add(-1);
        groundPieces.set(pc, decks);
        const mid = w.path.sampleAt(w.path.length / 2).p;
        const island = union.findIndex((p) => insidePoly(p, mid.x, mid.y));
        if (w.structure === 'ground' && island >= 0) decks.add(island);
      }
      // A piece entirely at grade lies on exactly one island...
      for (const [pc, set] of groundPieces) {
        if (set.has(-1)) continue;
        expect(set.size, `piece ${pc}`).toBeLessThanOrEqual(1);
      }
      // ...and each island big enough to hold a walking line has exactly one piece on it.
      const onIsland = new Map<number, Set<number>>();
      for (const [pc, set] of groundPieces) for (const i of set) if (i >= 0) {
        const s = onIsland.get(i) ?? new Set<number>();
        s.add(pc);
        onIsland.set(i, s);
      }
      for (const [i, set] of onIsland) expect(set.size, `island ${i} (area ${area([union[i]!]).toFixed(0)})`).toBe(1);
    });
  }
});

/** Footway and kerb bands of one island are one polygon: the union of the bands. */
import { union as unionPolys } from '@core/clipper';
function mergedIslands(polys: MultiPoly): MultiPoly {
  return unionPolys(polys);
}
