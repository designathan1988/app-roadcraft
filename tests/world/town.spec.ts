import { describe, expect, it } from 'vitest';
import { RoadDoc } from '@world/doc';
import { buildTown } from '@world/town';
import { footprintRects } from '@world/buildings/geometry';
import { structuralProblem, validateBuilding } from '@world/buildings/validate';
import { Network } from '@world/network';

/** The town to explore: a centre, high streets, terraces, houses each its own, a park. */
describe('town to explore', () => {
  const doc = new RoadDoc();
  const count = buildTown(doc);
  const all = [...doc.buildings.all()];
  const boxes = all.map((b) => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const r of footprintRects(b)) for (const p of r) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
    return { b, x0, y0, x1, y1 };
  });

  it('builds a centre, high streets, houses and a park', () => {
    expect(count).toBeGreaterThan(150);
    const fns = new Set(all.map((b) => b.function));
    for (const fn of ['cityHall', 'church', 'square', 'park', 'school', 'bank', 'house', 'townhouse', 'apartments']) expect(fns.has(fn as never), fn).toBe(true);
  });

  it('gives every house its own design, gardens, and pools at many', () => {
    const houses = all.filter((b) => b.function === 'house');
    expect(houses.length).toBeGreaterThan(60);
    const looks = new Set(houses.map((b) => JSON.stringify([b.materials, b.volumes.filter((v) => !v.open).map((v) => [v.w, v.d, v.roof, v.storeys.length])])));
    expect(looks.size).toBe(houses.length);
    const pools = houses.filter((b) => b.volumes.some((v) => v.open === 'water')).length;
    expect(pools).toBeGreaterThan(houses.length * 0.25);
    for (const h of houses) {
      expect(h.volumes.some((v) => v.open === 'grass')).toBe(true);
      expect((h.elements ?? []).some((e) => e.kind === 'shrub' || e.kind === 'tree')).toBe(true);
    }
  });

  it('puts nothing on a neighbour, and every building where it may be edited', () => {
    for (const a of boxes) {
      expect(structuralProblem(a.b), String(a.b.function)).toBeNull();
      for (const c of boxes) {
        if (c === a) continue;
        expect(a.x0 < c.x1 - 0.5 && a.x1 > c.x0 + 0.5 && a.y0 < c.y1 - 0.5 && a.y1 > c.y0 + 0.5, `${a.b.function} on ${c.b.function}`).toBe(false);
      }
    }
    const net = new Network(doc);
    net.rebuild();
    for (const a of boxes) expect(validateBuilding({ doc, net, groundAt: null }, a.b, a.b.id), String(a.b.function)).toBeNull();
  });
});
