import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { SURFACE_LEVELS } from '@world/roadTypes';
import { levelPolygons } from '@world/surfaces';
import { area, union, type MultiPoly } from '@core/clipper';
import type { Vec2 } from '@core/vec2';

/**
 * A SURFACE THAT GOES IN MUST COME OUT.
 *
 * The player sent a saved map with a stretch of road rendered as pavement with
 * no carriageway at all. It was not a geometry fault: every ring the junction
 * builder and the ribbon builder produced for that road was simple, positively
 * wound and in the right place. It was the UNION that lost them — one
 * `Clipper.Union` call over the 144 rings of a level dropped whole rings, and
 * a dropped ring is a road that is not drawn.
 *
 * Measured on this fixture, which is that map: the old single call lost 39 of
 * the 576 input rings across the four surface levels, taking 59,644 square
 * units of footway and 47,332 of kerb with it. Two smaller maps by the same
 * player lost nothing, which is why this survived until somebody built
 * something big enough.
 *
 * The invariant is the obvious one and it had never been stated: the union of
 * a set of rings contains every one of them. It is what these tests assert,
 * ring by ring, rather than comparing a total area that can hide a loss here
 * behind a gain there.
 */

const FIXTURE = join(process.cwd(), 'tests', 'fixtures', 'grid-and-bends.json');

function fixtureNetwork(): Network {
  const raw = JSON.parse(readFileSync(FIXTURE, 'utf8')) as { document: unknown };
  const doc = RoadDoc.fromJSON(raw.document as never);
  const net = new Network(doc);
  net.rebuild();
  return net;
}

/** A point strictly inside a simple ring: centroid of its lowest-leftmost corner. */
function interiorPoint(ring: readonly Vec2[]): Vec2 {
  let at = 0;
  for (let i = 1; i < ring.length; i++) {
    const p = ring[i] as Vec2;
    const best = ring[at] as Vec2;
    if (p.y < best.y || (p.y === best.y && p.x < best.x)) at = i;
  }
  const n = ring.length;
  const prev = ring[(at - 1 + n) % n] as Vec2;
  const here = ring[at] as Vec2;
  const next = ring[(at + 1) % n] as Vec2;
  return { x: (prev.x + here.x + next.x) / 3, y: (prev.y + here.y + next.y) / 3 };
}

function pointInRing(p: Vec2, ring: readonly number[][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i] as number[];
    const b = ring[j] as number[];
    const ay = a[1] as number;
    const by = b[1] as number;
    if (ay > p.y === by > p.y) continue;
    const ax = a[0] as number;
    const bx = b[0] as number;
    if (p.x < ((bx - ax) * (p.y - ay)) / (by - ay) + ax) inside = !inside;
  }
  return inside;
}

function covered(p: Vec2, mp: MultiPoly): boolean {
  for (const poly of mp) {
    const outer = poly[0];
    if (!outer || !pointInRing(p, outer)) continue;
    let inHole = false;
    for (let k = 1; k < poly.length; k++) {
      if (pointInRing(p, poly[k] as number[][])) inHole = true;
    }
    if (!inHole) return true;
  }
  return false;
}

/** Every ring the surface builder feeds into the union, for one level. */
function inputRings(net: Network, level: number): { label: string; ring: Vec2[] }[] {
  const out: { label: string; ring: Vec2[] }[] = [];
  for (const ribbon of net.ribbons.values()) {
    const ring = ribbon.rings[level];
    if (ring && !ring.isEmpty) out.push({ label: `ribbon ${String(ribbon.id)}`, ring: ring.flatten() });
  }
  for (const [node, byLevel] of net.junctions) {
    const junction = byLevel.get(level as never);
    if (!junction) continue;
    junction.rings.forEach((ring, i) => {
      if (!ring.isEmpty) out.push({ label: `junction ${String(node)} r${i}`, ring: ring.flatten() });
    });
  }
  return out;
}

describe('surface union', () => {
  it('covers samples throughout every source surface, independent of input order', () => {
    const net = fixtureNetwork();
    let checked = 0;
    for (const level of SURFACE_LEVELS) {
      const inputs = inputRings(net, level);
      const merged = levelPolygons(net, level);
      const reversed = union(inputs.slice().reverse().map(({ ring }) =>
        [ring.map(point => [point.x, point.y]) ]));
      expect(area(reversed)).toBeCloseTo(area(merged), 3);
      const missing: string[] = [];
      for (const { label, ring } of inputs) {
        const xy = ring.map(point => [point.x, point.y]);
        const minX = Math.min(...ring.map(point => point.x));
        const maxX = Math.max(...ring.map(point => point.x));
        const minY = Math.min(...ring.map(point => point.y));
        const maxY = Math.max(...ring.map(point => point.y));
        for (let x = 0; x < 7; x++) for (let y = 0; y < 7; y++) {
          const point = { x: minX + (maxX - minX) * (x + 0.381) / 7,
            y: minY + (maxY - minY) * (y + 0.619) / 7 };
          if (!pointInRing(point, xy)) continue;
          checked++;
          if (!covered(point, merged) || !covered(point, reversed)) missing.push(label);
        }
      }
      expect(missing.slice(0, 20), `missing interior coverage at level ${level}`).toEqual([]);
    }
    expect(checked).toBeGreaterThan(5000);
  });

  it('keeps every ring of the player map that reported a missing carriageway', () => {
    const net = fixtureNetwork();
    const lost: string[] = [];

    for (const level of SURFACE_LEVELS) {
      const merged = levelPolygons(net, level);
      for (const { label, ring } of inputRings(net, level)) {
        if (ring.length < 3) continue;
        if (covered(interiorPoint(ring), merged)) continue;
        lost.push(`level ${level}: ${label}`);
      }
    }

    expect(lost, `these surfaces went into the union and did not come out:\n${lost.join('\n')}`).toEqual([]);
  });

  it('loses no area on a large map', () => {
    // The total is a weaker statement than the one above and is here as a
    // second opinion: the merged surface can never be smaller than the single
    // largest thing that went into it.
    const net = fixtureNetwork();

    for (const level of SURFACE_LEVELS) {
      const merged = levelPolygons(net, level);
      let mergedArea = 0;
      for (const poly of merged) {
        poly.forEach((ring, i) => {
          const a = Math.abs(shoelace(ring));
          mergedArea += i === 0 ? a : -a;
        });
      }

      let biggest = 0;
      for (const { ring } of inputRings(net, level)) {
        biggest = Math.max(biggest, Math.abs(shoelace(ring.map((p) => [p.x, p.y]))));
      }

      expect(mergedArea).toBeGreaterThanOrEqual(biggest);
    }
  });

  it('still merges two overlapping squares into one', () => {
    // The ordinary case, so the robustness work above cannot quietly change
    // what a union means.
    const square = (x: number, y: number, size: number): number[][] => [
      [x, y],
      [x + size, y],
      [x + size, y + size],
      [x, y + size],
    ];
    const merged = union([[square(0, 0, 10)], [square(5, 0, 10)]]);

    expect(merged).toHaveLength(1);
    expect(merged[0]).toHaveLength(1);
    expect(Math.abs(shoelace(merged[0]![0] as number[][]))).toBeCloseTo(150, 6);
  });

  it('keeps a hole when one square is unioned round another', () => {
    const ring = (x0: number, y0: number, x1: number, y1: number): number[][] => [
      [x0, y0],
      [x1, y0],
      [x1, y1],
      [x0, y1],
    ];
    // A frame: the outer square minus nothing, built from four bars, leaving a
    // hole in the middle.
    const merged = union([
      [ring(0, 0, 30, 5)],
      [ring(0, 25, 30, 30)],
      [ring(0, 0, 5, 30)],
      [ring(25, 0, 30, 30)],
    ]);

    expect(merged).toHaveLength(1);
    expect(merged[0]).toHaveLength(2);
  });
});

function shoelace(ring: readonly number[][]): number {
  let sum = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i] as number[];
    const b = ring[j] as number[];
    sum += ((b[0] as number) - (a[0] as number)) * ((b[1] as number) + (a[1] as number));
  }
  return sum / 2;
}
