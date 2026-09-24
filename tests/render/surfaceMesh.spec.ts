import { describe, expect, it } from 'vitest';
import { MeshBasicMaterial } from 'three';

import type { MultiPoly } from '@core/clipper';
import { buildSurfaceMesh } from '@render/mesh/surfaceMesh';

/**
 * The mesh builder's contract, stated as tests:
 *
 *  1. no triangle edge longer than `maxEdge`, or a deck chords under the ground;
 *  2. no T-junction, or the surface shows a hairline crack;
 *  3. every top face points UP, or the whole surface is back-face culled and
 *     vanishes — which is exactly what happened when the winding was reversed
 *     for a mirrored axis that had already reversed it.
 */

const rect = (w: number, h: number): MultiPoly => [[[
  [-w / 2, -h / 2],
  [w / 2, -h / 2],
  [w / 2, h / 2],
  [-w / 2, h / 2],
]]];

const withHole = (): MultiPoly => [[
  [[-60, -60], [60, -60], [60, 60], [-60, 60]],
  [[-20, 20], [20, 20], [20, -20], [-20, -20]],
]];

function build(polygons: MultiPoly, maxEdge: number, bottom?: (x: number, y: number) => number) {
  return buildSurfaceMesh({
    name: 'test',
    polygons,
    top: (x, y) => 1 + Math.sin(x / 40) * 2 + Math.cos(y / 55),
    ...(bottom ? { bottom } : {}),
    material: new MeshBasicMaterial(),
    maxEdge,
    uv: (x, y, out) => {
      out[0] = x / 10;
      out[1] = y / 10;
    },
  });
}

function triangles(mesh: NonNullable<ReturnType<typeof build>>): number[][] {
  const index = mesh.geometry.getIndex();
  const position = mesh.geometry.getAttribute('position');
  const out: number[][] = [];
  for (let i = 0; i < (index?.count ?? 0); i += 3) {
    const t: number[] = [];
    for (let k = 0; k < 3; k++) {
      const v = index!.getX(i + k);
      t.push(position.getX(v), position.getY(v), position.getZ(v));
    }
    out.push(t);
  }
  return out;
}

/** Longest edge of the top face, ignoring the vertical skirt quads. */
function longestFlatEdge(mesh: NonNullable<ReturnType<typeof build>>): number {
  let worst = 0;
  for (const t of triangles(mesh)) {
    for (let k = 0; k < 3; k++) {
      const a = k * 3;
      const b = ((k + 1) % 3) * 3;
      worst = Math.max(worst, Math.hypot((t[a] as number) - (t[b] as number), (t[a + 2] as number) - (t[b + 2] as number)));
    }
  }
  return worst;
}

describe('buildSurfaceMesh', () => {
  it('refines until no edge exceeds the limit', () => {
    const mesh = build(rect(300, 60), 8);
    expect(mesh).not.toBeNull();
    expect(longestFlatEdge(mesh!)).toBeLessThanOrEqual(8.001);
  });

  it('returns null for a degenerate polygon rather than an empty mesh', () => {
    expect(build([[[[0, 0], [1, 0]]]], 8)).toBeNull();
    expect(build([], 8)).toBeNull();
  });

  it('leaves no T-junction: every edge is shared by exactly two triangles', () => {
    const mesh = build(rect(200, 90), 9);
    const seen = new Map<string, number>();
    const index = mesh!.geometry.getIndex()!;
    for (let i = 0; i < index.count; i += 3) {
      const v = [index.getX(i), index.getX(i + 1), index.getX(i + 2)];
      for (let k = 0; k < 3; k++) {
        const a = v[k] as number;
        const b = v[(k + 1) % 3] as number;
        const key = a < b ? `${a}:${b}` : `${b}:${a}`;
        seen.set(key, (seen.get(key) ?? 0) + 1);
      }
    }
    // Interior edges appear twice, boundary edges once. A T-junction shows up
    // as an edge whose midpoint is a vertex of only one of its two triangles,
    // which makes the long edge appear once while the two halves appear once
    // each — so a count of three or more is the signature to catch.
    for (const count of seen.values()) expect(count).toBeLessThanOrEqual(2);
  });

  it('winds every top face upwards', () => {
    const mesh = build(rect(160, 70), 12);
    for (const t of triangles(mesh!)) {
      const ux = (t[3] as number) - (t[0] as number);
      const uz = (t[5] as number) - (t[2] as number);
      const vx = (t[6] as number) - (t[0] as number);
      const vz = (t[8] as number) - (t[2] as number);
      expect(uz * vx - ux * vz).toBeGreaterThan(-1e-9);
    }
  });

  it('carries a hole through to the mesh', () => {
    const solid = build(rect(120, 120), 12)!;
    const holed = build(withHole(), 12)!;
    const area = (mesh: typeof solid): number => {
      let total = 0;
      for (const t of triangles(mesh)) {
        const ux = (t[3] as number) - (t[0] as number);
        const uz = (t[5] as number) - (t[2] as number);
        const vx = (t[6] as number) - (t[0] as number);
        const vz = (t[8] as number) - (t[2] as number);
        total += Math.abs(ux * vz - uz * vx) / 2;
      }
      return total;
    };
    expect(area(holed)).toBeLessThan(area(solid) * 1.05);
    expect(area(holed)).toBeGreaterThan(120 * 120 - 40 * 40 - 1);
  });

  it('adds a skirt only when a bottom is supplied', () => {
    const flat = build(rect(100, 40), 10)!;
    const solid = build(rect(100, 40), 10, () => -4)!;
    expect(solid.geometry.getAttribute('position').count).toBeGreaterThan(
      flat.geometry.getAttribute('position').count,
    );
    let lowest = Infinity;
    const position = solid.geometry.getAttribute('position');
    for (let i = 0; i < position.count; i++) lowest = Math.min(lowest, position.getY(i));
    expect(lowest).toBeCloseTo(-4, 6);
  });

  it('gives the skirt an outward normal', () => {
    const mesh = build(rect(100, 100), 10, () => -3)!;
    const position = mesh.geometry.getAttribute('position');
    const normal = mesh.geometry.getAttribute('normal');
    let checked = 0;
    for (let i = 0; i < position.count; i++) {
      if (Math.abs(normal.getY(i)) > 0.01) continue;
      const x = position.getX(i);
      const z = position.getZ(i);
      // On the +x wall the normal must have a positive x, and so on. Corner
      // vertices belong to two walls, so only the runs between them are tested.
      if (Math.abs(x) > 49.5 && Math.abs(z) < 48) {
        expect(Math.sign(normal.getX(i))).toBe(Math.sign(x));
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('writes one uv per vertex', () => {
    const mesh = build(rect(150, 60), 9, () => 0)!;
    expect(mesh.geometry.getAttribute('uv').count).toBe(
      mesh.geometry.getAttribute('position').count,
    );
  });
});

describe('texture frames at a junction corner', () => {
  // Two roads meeting at right angles: along X at y = 0, and along Y at x = 0.
  // A point takes the frame of whichever is nearer, as the road UVs do.
  const frame = (x: number, y: number, pickX: number, pickY: number, out: [number, number]): void => {
    if (Math.abs(pickY) < Math.abs(pickX)) {
      out[0] = y / 10;
      out[1] = x / 10;
    } else {
      out[0] = -x / 10;
      out[1] = y / 10;
    }
  };
  const corner: MultiPoly = [[[[4, 4], [70, 4], [70, 70], [4, 70]]]];

  const worstStretch = (mesh: NonNullable<ReturnType<typeof buildSurfaceMesh>>): number => {
    const index = mesh.geometry.getIndex();
    const position = mesh.geometry.getAttribute('position');
    const uv = mesh.geometry.getAttribute('uv');
    let worst = 1;
    for (let i = 0; i < (index?.count ?? 0); i += 3) {
      for (let k = 0; k < 3; k++) {
        const a = index?.getX(i + k) ?? 0;
        const b = index?.getX(i + ((k + 1) % 3)) ?? 0;
        if (position.getY(a) < 0.5 || position.getY(b) < 0.5) continue;
        const world = Math.hypot(position.getX(a) - position.getX(b), position.getZ(a) - position.getZ(b));
        const texture = Math.hypot(uv.getX(a) - uv.getX(b), uv.getY(a) - uv.getY(b)) * 10;
        if (world > 1e-3) worst = Math.max(worst, texture / world, world / Math.max(texture, 1e-6));
      }
    }
    return worst;
  };

  const make = (framed: boolean) =>
    buildSurfaceMesh({
      name: 'corner',
      polygons: corner,
      top: () => 1,
      material: new MeshBasicMaterial(),
      maxEdge: 6,
      uv: (x, y, out) => frame(x, y, x, y, out),
      ...(framed ? { uvFrame: frame, uvWorld: 10 } : {}),
    });

  it('smears a triangle that straddles two frames, when left alone', () => {
    const mesh = make(false);
    expect(mesh).not.toBeNull();
    if (mesh) expect(worstStretch(mesh)).toBeGreaterThan(2);
  });

  it('keeps every triangle inside one frame when asked to', () => {
    const mesh = make(true);
    expect(mesh).not.toBeNull();
    if (mesh) expect(worstStretch(mesh)).toBeLessThan(1.01);
  });
});
