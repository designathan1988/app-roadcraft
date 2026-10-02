import clipping from 'polygon-clipping';
import type { Vec2 } from '@core/vec2';
import { signedArea } from '@core/polygon';
import { asPolygon, localFootprint, roofPartFits, validOutline } from './footprints';
import { MIN_SIZE } from './geometry';
import type { Building, Volume } from './types';

/**
 * A building is blocks put together like bricks, and the blocks are never
 * changed by being put together. What is DRAWN is resolved from them here:
 *
 * - solid blocks (no `mode`) add their space - two overlapping blocks read as
 *   one mass, and either can be moved away again;
 * - a 'void' block takes its space out of the solid blocks it overlaps, on the
 *   levels it spans - a notch, a courtyard, an arcade, a hole through a tower;
 * - an 'intersect' block keeps, of the solid blocks it overlaps, only what lies
 *   inside it, on its levels.
 *
 * The stored record keeps every block whole; this returns a copy whose
 * volumes are the result, cut by polygon difference/intersection per range of
 * levels. A block nothing touches is passed through untouched, with all its
 * facade work. Pure and deterministic, so the renderer can call it on every
 * rebuild.
 */
export function resolveBlocks(b: Building): Building {
  const solids = b.volumes.filter((v) => !v.mode);
  const voids = b.volumes.filter((v) => v.mode === 'void');
  const clips = b.volumes.filter((v) => v.mode === 'intersect');
  const xors = b.volumes.filter((v) => v.mode === 'xor');
  if (voids.length === 0 && clips.length === 0 && xors.length === 0) return b;
  const out: Volume[] = [];
  let nextId = Math.max(b.nextVolumeId, ...b.volumes.map((v) => v.id + 1)) + 1000;
  const top = (v: Volume): number => v.base + v.storeys.length;
  const levelsMeet = (a: Volume, l0: number, l1: number): boolean => a.base < l1 && top(a) > l0;

  // An exclusive block cuts the solids where it meets them, and stands as a
  // solid where it meets none: it is resolved as a void for the solids and
  // as a solid cut by the solids.
  const cutters = [...voids, ...xors];
  const xorIds = new Set(xors.map((x) => x.id));
  const asSolid = (x: Volume): Volume => {
    const copy = { ...x };
    delete copy.mode;
    return copy;
  };
  for (const s of [...solids, ...xors.map(asSolid)]) {
    const ring = localFootprint(s);
    const isXor = xorIds.has(s.id);
    const touching = (list: Volume[]): Volume[] => list.filter((o) => levelsMeet(o, s.base, top(s)) &&
      polygonArea(clipping.intersection(asPolygon(ring), asPolygon(localFootprint(o)))) > 1e-6);
    const myVoids = isXor ? touching(solids) : touching(cutters).filter((o) => o.id !== s.id);
    const myClips = isXor ? [] : clips.filter((o) => levelsMeet(o, s.base, top(s)));
    if (myVoids.length === 0 && myClips.length === 0) {
      out.push(isXor ? { ...s, id: nextId++ } : s);
      continue;
    }
    // Cut the block into ranges of levels inside which the same voids and
    // clips apply.
    const breaks = new Set<number>([s.base, top(s)]);
    for (const o of [...myVoids, ...myClips]) {
      if (o.base > s.base && o.base < top(s)) breaks.add(o.base);
      if (top(o) > s.base && top(o) < top(s)) breaks.add(top(o));
    }
    const levels = [...breaks].sort((a, c) => a - c);
    for (let i = 0; i + 1 < levels.length; i++) {
      const l0 = levels[i]!;
      const l1 = levels[i + 1]!;
      let shape: clipping.MultiPolygon = [asPolygon(ring)];
      const activeClips = myClips.filter((o) => levelsMeet(o, l0, l1));
      if (activeClips.length > 0) {
        shape = clipping.intersection(shape, clipping.union(asPolygon(localFootprint(activeClips[0]!)),
          ...activeClips.slice(1).map((o) => asPolygon(localFootprint(o)))));
      }
      const activeVoids = myVoids.filter((o) => levelsMeet(o, l0, l1));
      if (activeVoids.length > 0) shape = clipping.difference(shape, ...activeVoids.map((o) => asPolygon(localFootprint(o))));
      const whole = activeClips.length === 0 && activeVoids.length === 0;
      const storeys = s.storeys.slice(l0 - s.base, l1 - s.base);
      if (whole) {
        // The range nothing cuts keeps the block's own plan and facade.
        out.push({ ...structuredClone(s), id: nextId++, base: l0, storeys, roof: l1 === top(s) ? s.roof : 'flat' });
        continue;
      }
      for (const poly of shape) {
        for (const piece of simplePieces(poly)) {
          const v = volumeOf(s, piece, l0, storeys, l1 === top(s) ? s.roof : 'flat', nextId);
          if (v) {
            out.push(v);
            nextId++;
          }
        }
      }
    }
  }
  return { ...b, volumes: out };
}

function polygonArea(poly: clipping.MultiPolygon): number {
  return poly.reduce((total, rings) => total + rings.reduce((sum, ring, index) =>
    sum + (index === 0 ? 1 : -1) * Math.abs(signedArea(ring.map(([x, y]) => ({ x, y })))), 0), 0);
}

/** A ring with holes as simple rings: split in two through the first hole. */
function simplePieces(poly: clipping.Polygon, depth = 0): Vec2[][] {
  const outer = poly[0];
  if (!outer) return [];
  if (poly.length === 1 || depth > 4) {
    const ring = outer.slice(0, -1).map(([x, y]) => ({ x, y }));
    return [signedArea(ring) < 0 ? ring.reverse() : ring];
  }
  const hole = poly[1]!;
  const xs = hole.map(([x]) => x);
  const cut = (Math.min(...xs) + Math.max(...xs)) / 2;
  const ox = outer.map(([x]) => x);
  const oy = outer.map(([, y]) => y);
  const x0 = Math.min(...ox) - 1, x1 = Math.max(...ox) + 1, y0 = Math.min(...oy) - 1, y1 = Math.max(...oy) + 1;
  const left: clipping.Polygon = [[[x0, y0], [cut, y0], [cut, y1], [x0, y1], [x0, y0]]];
  const right: clipping.Polygon = [[[cut, y0], [x1, y0], [x1, y1], [cut, y1], [cut, y0]]];
  return [...clipping.intersection(poly, left), ...clipping.intersection(poly, right)].flatMap((p) => simplePieces(p, depth + 1));
}

function volumeOf(s: Volume, ring: readonly Vec2[], base: number, storeys: Volume['storeys'], roof: Volume['roof'], id: number): Volume | null {
  if (ring.length < 3 || ring.length > 64) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of ring) {
    minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
  }
  const w = maxX - minX;
  const d = maxY - minY;
  if (w < MIN_SIZE / 4 || d < MIN_SIZE / 4) return null;
  const outline = ring.map((p) => ({ x: (p.x - minX) / w, y: (p.y - minY) / d }));
  if (!validOutline(outline)) return null;
  const v: Volume = {
    ...structuredClone(s),
    id, x: minX, y: minY, w, d, outline, base, storeys: structuredClone(storeys), roof,
  };
  // Bay-by-bay work belongs to the block's own sides; on a cut piece the
  // sides are new, so the piece keeps the block's look and pattern only.
  delete v.reliefs;
  delete v.facadeGeometry;
  for (const storey of v.storeys) {
    delete storey.facade.bays;
    delete storey.facade.sides;
  }
  if (v.materials?.sides) delete v.materials.sides;
  if (v.roofDetails) v.roofDetails = v.roofDetails.filter((part) => roofPartFits(v, part));
  return v;
}
