import { describe, expect, it } from 'vitest';

import { RoadDoc } from '@world/doc';
import { BLUEPRINTS, generateBody } from '@world/buildings/blueprints';
import { flightRun, foundationOf } from '@world/buildings/foundation';
import { type Building, asBuildingId } from '@world/buildings/types';
import { type BuildingChunk, assembleBuildingMeshes, emitChunk } from '@render/buildings/buildingMesh';
import { createBuildingKit } from '@render/buildings/kit';
import { createBuildingLayer } from '@render/buildings/layer';

/**
 * The building meshes (docs/buildings.md section 5). Winding is measured, not
 * assumed (AGENTS.md trap: world y is mirrored into three's z), so every
 * shell triangle must face the way its normal says - or the back-face cull
 * removes it and the wall is simply not there.
 */

const slope = (x: number, y: number): number => x * 0.05 + y * 0.03;

function placed(index: number, rotation: number): Building {
  const bp = BLUEPRINTS[index]!;
  return { ...JSON.parse(JSON.stringify(bp.body)), id: index + 1, x: index * 60, y: 20, rotation } as Building;
}

/** Shell triangles that face away from their own normal (and would be culled). */
function wrongWinding(chunk: BuildingChunk): number {
  const p = chunk.position;
  const n = chunk.normal;
  let wrong = 0;
  for (let t = 0; t < chunk.index.length; t += 3) {
    const a = chunk.index[t]! * 3;
    const b = chunk.index[t + 1]! * 3;
    const c = chunk.index[t + 2]! * 3;
    const ux = p[b]! - p[a]!, uy = p[b + 1]! - p[a + 1]!, uz = p[b + 2]! - p[a + 2]!;
    const vx = p[c]! - p[a]!, vy = p[c + 1]! - p[a + 1]!, vz = p[c + 2]! - p[a + 2]!;
    const gx = uy * vz - uz * vy;
    const gy = uz * vx - ux * vz;
    const gz = ux * vy - uy * vx;
    if (gx * n[a]! + gy * n[a + 1]! + gz * n[a + 2]! < 0) wrong++;
  }
  return wrong;
}

describe('building shell', () => {
  it('winds every triangle towards its normal, for every preset at any rotation', () => {
    for (let i = 0; i < BLUEPRINTS.length; i++) {
      for (const rotation of [0, 0.7, -2.2]) {
        const chunk = emitChunk(placed(i, rotation), slope);
        expect(chunk.index.length).toBeGreaterThan(0);
        expect(wrongWinding(chunk), `${BLUEPRINTS[i]!.key} at ${rotation}`).toBe(0);
        expect([...chunk.position].every(Number.isFinite)).toBe(true);
      }
    }
  });

  it('sets a flight into the building rather than across the footway it backs onto', () => {
    // A house whose front (y = 100, facing -y) is on the back of a footway,
    // on land a little higher than the footway.
    const b = { ...generateBody('residential', 4, 3, 2), id: asBuildingId(1), x: 100, y: 100, rotation: 0 } as Building;
    const land = (_x: number, y: number): number => (y >= 100 ? 0.8 : 0);
    const footway = (_x: number, y: number): number => (y < 99.7 ? 0 : NaN);
    const f = foundationOf(b, land, undefined, footway);
    const door = f.entrances.find((e) => e.component === 'door')!;
    expect(door.steps).toBeGreaterThan(0);
    expect(door.recess).toBeCloseTo(flightRun(door.steps), 9);
    for (const rotation of [0, 0.7]) {
      const chunk = emitChunk({ ...b, rotation }, land, footway);
      expect(wrongWinding(chunk), `rotation ${rotation}`).toBe(0);
    }
    // Nothing below the floor stands in front of the plinth: no step is out
    // on the footway. (Three's z is world -y, its y is height; positions are float32.)
    const p = emitChunk(b, land, footway).position;
    let onFootway = 0;
    for (let i = 0; i < p.length; i += 3) {
      if (p[i + 1]! < f.floor - 1e-3 && -p[i + 2]! < 100 - 0.3 - 1e-3) onFootway++;
    }
    expect(onFootway).toBe(0);
    // Without the footway the same flight stands outside, down to the land.
    const q = emitChunk(b, land).position;
    let outside = 0;
    for (let i = 0; i < q.length; i += 3) if (q[i + 1]! < f.floor - 1e-6 && -q[i + 2]! < 99) outside++;
    expect(outside).toBeGreaterThan(0);
  });

  it('instances the facade parts and concatenates buildings into one batch each', () => {
    const kit = createBuildingKit();
    const a = emitChunk(placed(2, 0), slope);
    const b = emitChunk(placed(3, 0.4), slope);
    expect(a.parts.glass.count).toBeGreaterThan(0);
    const meshes = assembleBuildingMeshes([a, b], kit);
    const glass = meshes.group.children.find((m) => m.name === 'building-glass') as unknown as { count: number };
    expect(glass.count).toBe(a.parts.glass.count + b.parts.glass.count);
    // One shell and at most one batch per part: the draw calls do not grow
    // with the number of buildings.
    expect(meshes.group.children.length).toBeLessThanOrEqual(10);
    meshes.dispose();
    kit.dispose();
  });
});

describe('buildings layer', () => {
  it('rebuilds only when the buildings or the ground move', () => {
    const doc = new RoadDoc();
    for (let i = 0; i < 4; i++) doc.buildings.add(placed(i, 0));
    const layer = createBuildingLayer();
    expect(layer.update(doc, slope, 'g1')).toBe(true);
    expect(layer.update(doc, slope, 'g1')).toBe(false);
    const first = [...doc.buildings.all()][0]!;
    doc.buildings.put({ ...first, rotation: 0.3 });
    expect(layer.update(doc, slope, 'g1')).toBe(true);
    expect(layer.update(doc, slope, 'g2')).toBe(true);
    expect(layer.covers(first.x + 1, first.y + 1)).toBe(true);
    expect(layer.covers(-900, -900)).toBe(false);
    layer.dispose();
  });
});
