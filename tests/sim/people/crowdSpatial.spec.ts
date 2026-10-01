import { beforeAll, expect, it } from 'vitest';
import { Network } from '@world/network';
import { SimWorld } from '@sim/world';
import { initCrowd } from '@sim/people/crowd';
import { buildCrowdNav } from '@sim/people/crowdNav';
import type { Narrow, Zebra } from '@sim/people/crowdNav';
import { buildCrowdSpatial, CrowdPointIndex } from '@sim/people/crowdIndex';
import type { Aabb } from '@core/aabb';
import type { Walkway } from '@world/walkways';
import { m } from '@world/units';
import { SCENARIOS } from '../../fixtures/crowdScenarios';

beforeAll(initCrowd);

it('builds static candidate indices with the crowd navigation geometry', () => {
  const scenario = SCENARIOS.find((s) => s.name === 'head-on')!;
  const net = new Network(scenario.doc);
  net.rebuild();
  const world = new SimWorld(scenario.doc, net, 0x5ce7);
  world.rebuildTopology();
  const nav = buildCrowdNav(world);
  try {
    expect(nav).not.toBeNull();
    expect(nav).toHaveProperty('spatial');
  } finally {
    nav?.query.destroy();
    nav?.navMesh.destroy();
  }
});

const contains = (box: Aabb, x: number, y: number): boolean =>
  x >= box.minX && x <= box.maxX && y >= box.minY && y <= box.maxY;

it('keeps closed boundaries, negative cells, overlap order and oversized geometry identical to a scan', () => {
  const boxes = [
    { minX: -8, maxX: 4, minY: -4, maxY: 4 },
    { minX: -1e6, maxX: 1e6, minY: -1e6, maxY: 1e6 },
    { minX: 0, maxX: 4, minY: 0, maxY: 4 },
    { minX: -4, maxX: -4, minY: -4, maxY: -4 },
    { minX: 8, maxX: 12, minY: -12, maxY: -8 },
  ];
  const index = new CrowdPointIndex(boxes, (box) => box, 4);
  const values = [-100, -12, -8, -4, -4 + 1e-12, -1e-12, 0, 4 - 1e-12, 4, 4 + 1e-12, 8, 12, 100];
  for (const x of values) for (const y of values) {
    expect(index.at(x, y).filter((box) => contains(box, x, y)))
      .toEqual(boxes.filter((box) => contains(box, x, y)));
    const candidates = index.around(x, y, 8);
    expect(new Set(candidates).size).toBe(candidates.length);
    expect(candidates.map((box) => boxes.indexOf(box))).toEqual(candidates.map((box) => boxes.indexOf(box)).sort((a, b) => a - b));
    const intersects = (box: Aabb): boolean => box.minX <= x + 8 && box.maxX >= x - 8 && box.minY <= y + 8 && box.maxY >= y - 8;
    expect(candidates.filter(intersects)).toEqual(boxes.filter(intersects));
  }
});

it('rejects distant geometry without scanning or allocating all map entries for each point', () => {
  const boxes = Array.from({ length: 1000 }, (_, i) => ({ minX: i * 100, maxX: i * 100 + 1, minY: 0, maxY: 1 }));
  const index = new CrowdPointIndex(boxes, (box) => box, 4);
  const candidates = index.at(40_000, 0);
  expect(candidates).toEqual([boxes[400]]);
  expect(index.at(40_000, 0)).toBe(candidates);
  expect(index.at(-100, 0)).toEqual([]);
});

function zebra(id: string, ax: number, ay: number, bx: number, by: number, half = 2): Zebra {
  return { id, a: { x: ax, y: ay }, b: { x: bx, y: by }, half, kerb: 0, way: 0, edge: {} as Zebra['edge'] };
}

// Reference predicates intentionally copied from the original full scans. The
// broad phase must keep every match, including the original first-match order.
function onRoad(z: Zebra, x: number, y: number): boolean {
  const lx = z.b.x - z.a.x, ly = z.b.y - z.a.y, len = Math.hypot(lx, ly) || 1;
  const ux = lx / len, uy = ly / len;
  const along = (x - z.a.x) * ux + (y - z.a.y) * uy;
  const across = -(x - z.a.x) * uy + (y - z.a.y) * ux;
  const at = along >= 0 && along <= len && Math.abs(across) <= z.half ? along : null;
  const length = Math.hypot(z.b.x - z.a.x, z.b.y - z.a.y);
  return at !== null && at >= z.kerb && at <= length - z.kerb;
}

function inNarrow(n: Narrow, x: number, y: number, radius: number): boolean {
  const len = Math.hypot(n.b.x - n.a.x, n.b.y - n.a.y);
  const along = (x - n.a.x) * n.dir.x + (y - n.a.y) * n.dir.y;
  const across = -(x - n.a.x) * n.dir.y + (y - n.a.y) * n.dir.x;
  return along >= -2 * radius && along <= len + 2 * radius && Math.abs(across) <= n.reach;
}

it('matches zebra and passage scans for rotated, merged and degenerate axes', () => {
  const zebras = [zebra('first', -20, -20, 20, 20), zebra('second', -20, -20, 20, 20), zebra('vertical', 4, -10, 4, 10), zebra('degenerate', 0, 0, 0, 0)];
  const narrows: Narrow[] = [
    { id: 7, a: { x: 0, y: 0 }, b: { x: 0, y: 20 }, dir: { x: 1, y: 0 }, reach: 2, width: 1 },
    { id: 1, a: { x: -20, y: -10 }, b: { x: 20, y: 10 }, dir: { x: 0.6, y: 0.8 }, reach: 3, width: 1 },
    { id: 9, a: { x: 10, y: 0 }, b: { x: -10, y: 0 }, dir: { x: -1, y: 0 }, reach: 4, width: 1 },
    { id: 3, a: { x: 0, y: 0 }, b: { x: 10, y: 0 }, dir: { x: 0.5, y: 0 }, reach: 2, width: 1 },
  ];
  const radius = 0.5;
  const spatial = buildCrowdSpatial(zebras, narrows, [], radius);
  const points: { x: number; y: number }[] = [];
  for (let x = -40; x <= 40; x += 2) for (let y = -40; y <= 40; y += 2) points.push({ x, y });
  for (const n of narrows) {
    const len = Math.hypot(n.b.x - n.a.x, n.b.y - n.a.y);
    const norm = n.dir.x * n.dir.x + n.dir.y * n.dir.y;
    for (const along of [-2 * radius, len + 2 * radius]) for (const across of [-n.reach, n.reach]) {
      points.push({ x: n.a.x + (n.dir.x * along - n.dir.y * across) / norm, y: n.a.y + (n.dir.y * along + n.dir.x * across) / norm });
    }
  }
  for (const { x, y } of points) {
    expect(spatial.zebras.at(x, y).filter((z) => onRoad(z, x, y))).toEqual(zebras.filter((z) => onRoad(z, x, y)));
    expect(spatial.narrows.at(x, y).filter((n) => inNarrow(n, x, y, radius))).toEqual(narrows.filter((n) => inNarrow(n, x, y, radius)));
    const within = (n: Narrow): boolean => Math.hypot((n.a.x + n.b.x) / 2 - x, (n.a.y + n.b.y) / 2 - y) < 12;
    expect(spatial.narrowCentres.around(x, y, 12).filter(within)).toEqual(narrows.filter(within));
  }
});

it('keeps every overlapping deck and the original road boundary candidates', () => {
  const way = (id: number, box: Aabb): Walkway => ({ id, path: { bbox: box } }) as Walkway;
  const ways = [
    way(11, { minX: -20, maxX: 20, minY: -1, maxY: 1 }),
    way(2, { minX: -1, maxX: 1, minY: -20, maxY: 20 }),
    way(9, { minX: -20, maxX: 20, minY: -1, maxY: 1 }),
  ];
  const spatial = buildCrowdSpatial([], [], ways, 0.5);
  for (const x of [-20 - m(4), -m(4), 0, m(4), 20 + m(4)]) for (const y of [-20 - m(4), -m(4), 0, m(4), 20 + m(4)]) {
    const included = (w: Walkway): boolean => {
      const bb = w.path.bbox;
      return !(x < bb.minX - m(4) || x > bb.maxX + m(4) || y < bb.minY - m(4) || y > bb.maxY + m(4));
    };
    expect(spatial.ways.at(x, y).filter(included)).toEqual(ways.filter(included));
  }
  expect(spatial.ways.at(0, 0)).toEqual(ways);
});
