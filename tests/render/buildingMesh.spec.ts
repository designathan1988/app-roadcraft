import { describe, expect, it } from 'vitest';

import { RoadDoc } from '@world/doc';
import { BLUEPRINTS } from '@world/buildings/blueprints';
import type { Building } from '@world/buildings/types';
import { assembleBuildingMeshes, emitChunk } from '@render/buildings/buildingMesh';
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

describe('building shell', () => {
  it('winds every triangle towards its normal, for every preset at any rotation', () => {
    for (let i = 0; i < BLUEPRINTS.length; i++) {
      for (const rotation of [0, 0.7, -2.2]) {
        const chunk = emitChunk(placed(i, rotation), slope);
        const p = chunk.position;
        const n = chunk.normal;
        expect(chunk.index.length).toBeGreaterThan(0);
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
        expect(wrong, `${BLUEPRINTS[i]!.key} at ${rotation}`).toBe(0);
        expect([...p].every(Number.isFinite)).toBe(true);
      }
    }
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
