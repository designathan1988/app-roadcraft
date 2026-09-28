import { describe, expect, it } from 'vitest';
import type { MeshStandardMaterial } from 'three';

import { DEFAULT_MODULE } from '@world/buildings/types';

import { RoadDoc } from '@world/doc';
import { BLUEPRINTS, generateBody } from '@world/buildings/blueprints';
import { flightRun, foundationOf } from '@world/buildings/foundation';
import { type Building, asBuildingId } from '@world/buildings/types';
import { type BuildingChunk, assembleBuildingMeshes, emitChunk } from '@render/buildings/buildingMesh';
import { PART_KINDS, createBuildingKit } from '@render/buildings/kit';
import { FINISHES } from '@world/buildings/materials';
import { createBuildingLayer } from '@render/buildings/layer';
import { shapeBody } from '@editor/buildingPlans';
import { addRoofDetail, updateRoofDetail } from '@editor/buildingRoofs';
import { applyFacadePattern } from '@editor/buildingFacade';
import { m } from '@world/units';

/** `n` default modules, world units. */
const bays = (n: number): number => n * DEFAULT_MODULE;

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
  let wrong = 0;
  for (const part of Object.values(chunk.shells)) {
    const p = part.position;
    const n = part.normal;
    for (let t = 0; t < part.index.length; t += 3) {
      const a = part.index[t]! * 3;
      const b = part.index[t + 1]! * 3;
      const c = part.index[t + 2]! * 3;
      const ux = p[b]! - p[a]!, uy = p[b + 1]! - p[a + 1]!, uz = p[b + 2]! - p[a + 2]!;
      const vx = p[c]! - p[a]!, vy = p[c + 1]! - p[a + 1]!, vz = p[c + 2]! - p[a + 2]!;
      const gx = uy * vz - uz * vy;
      const gy = uz * vx - ux * vz;
      const gz = ux * vy - uy * vx;
      if (gx * n[a]! + gy * n[a + 1]! + gz * n[a + 2]! < 0) wrong++;
    }
  }
  return wrong;
}

/** Every shell vertex position of a chunk, all finishes (three's axes). */
const positions = (chunk: BuildingChunk): number[] => Object.values(chunk.shells).flatMap((part) => [...part.position]);
const triangleCount = (chunk: BuildingChunk): number =>
  Object.values(chunk.shells).reduce((n, part) => n + part.index.length / 3, 0);

describe('building shell', () => {
  it('renders a glazed lookout and adjustable spire with finite outward-facing triangles', () => {
    const b = { ...shapeBody('circle', m(10), m(10), 2), id: asBuildingId(18), x: 0, y: 0, rotation: .4 } as Building;
    const v = b.volumes[0]!;
    expect(applyFacadePattern(b, { scope: 'volume', volume: v.id }, 'observation')).toBe(true);
    expect(addRoofDetail(b, v.id, 'spire', { x: v.x + v.w / 2, y: v.y + v.d / 2 })).toBe(1);
    expect(updateRoofDetail(b, v.id, 1, { flag: 'saoPaulo' })).toBe(true);
    const chunk = emitChunk(b, () => 0);
    expect(wrongWinding(chunk)).toBe(0);
    expect(positions(chunk).every(Number.isFinite)).toBe(true);
    expect(Math.max(...positions(chunk).filter((_, index) => index % 3 === 1))).toBeGreaterThan(m(15));
  });
  it('renders authored solar and vent parts on a shaped roof without inverted triangles', () => {
    const b = { ...shapeBody('l', 50, 40, 2), id: asBuildingId(1), x: 0, y: 0, rotation: 0 } as Building;
    const v = b.volumes[0]!;
    v.roof = 'gable';
    expect(addRoofDetail(b, v.id, 'solar', { x: 10, y: 8 })).not.toBeNull();
    expect(addRoofDetail(b, v.id, 'vent', { x: 14, y: 12 })).not.toBeNull();
    const chunk = emitChunk(b, () => 0);
    expect(wrongWinding(chunk)).toBe(0);
    expect(positions(chunk).every(Number.isFinite)).toBe(true);
  });
  it('builds visible finite surfaces with correct winding for concave and curved plans', () => {
    for (const shape of ['l', 'u', 'circle', 'hexagon'] as const) {
      for (const roof of ['flat', 'terrace', 'gable', 'hip', 'shed', 'sawtooth'] as const) {
        const b = { ...shapeBody(shape, 40, 32, 3), id: asBuildingId(1), x: 0, y: 0, rotation: .4 } as Building;
        b.volumes[0]!.roof = roof;
        const chunk = emitChunk(b, () => 0);
        expect(triangleCount(chunk), `${shape}/${roof}`).toBeGreaterThan(20);
        expect(wrongWinding(chunk), `${shape}/${roof}`).toBe(0);
        expect(positions(chunk).every(Number.isFinite), `${shape}/${roof}`).toBe(true);
      }
    }
  });
  it('winds every triangle towards its normal, for every preset at any rotation', () => {
    for (let i = 0; i < BLUEPRINTS.length; i++) {
      for (const rotation of [0, 0.7, -2.2]) {
        const chunk = emitChunk(placed(i, rotation), slope);
        expect(triangleCount(chunk)).toBeGreaterThan(0);
        expect(wrongWinding(chunk), `${BLUEPRINTS[i]!.key} at ${rotation}`).toBe(0);
        expect(positions(chunk).every(Number.isFinite)).toBe(true);
        for (const part of Object.values(chunk.shells)) {
          expect(part.uv.length / 2).toBe(part.position.length / 3);
          expect([...part.uv].every(Number.isFinite)).toBe(true);
        }
      }
    }
  });

  it('winds reliefs and every roof shape towards their normals', () => {
    for (const roof of ['gable', 'hip', 'shed', 'sawtooth'] as const) {
      for (const turn of [{}, { ridge: 'y' as const }, { ridge: 'x' as const, pitch: 50 }, { fall: 1 as const }, { fall: 2 as const }, { fall: 3 as const }]) {
        const b = { ...generateBody('residential', 30, 22.5, 3), id: asBuildingId(1), x: 0, y: 0, rotation: 0.4 } as Building;
        const v = b.volumes[0]!;
        Object.assign(v, { roof, ...turn });
        b.elements = [
          { id: 1, kind: 'stair', x: 40, y: 8, facing: 1, w: 3, d: 9, z: 0, h: 4 },
          { id: 2, kind: 'ramp', x: -8, y: 8, facing: 3, w: 3, d: 12, z: 0, h: 1 },
          { id: 3, kind: 'canopy', x: 15, y: -1.5, facing: 0, w: 6, d: 3, z: 7, h: 0.4 },
          { id: 4, kind: 'pillar', x: 15, y: -5, facing: 0, w: 1, d: 1, z: 0, h: 7 },
        ];
        v.reliefs = [
          { side: 0, bay0: 1, bay1: 2, storey0: 1, storey1: 2, depth: 2 },
          { side: 2, bay0: 0, bay1: 1, storey0: 0, storey1: 1, depth: -3 },
        ];
        const chunk = emitChunk(b, slope);
        expect(wrongWinding(chunk), `${roof} ${JSON.stringify(turn)}`).toBe(0);
        expect(positions(chunk).every(Number.isFinite)).toBe(true);
      }
    }
  });

  it('sets a flight into the building rather than across the footway it backs onto', () => {
    // A house whose front (y = 100, facing -y) is on the back of a footway,
    // on land a little higher than the footway.
    const b = { ...generateBody('residential', bays(4), bays(3), 2), id: asBuildingId(1), x: 100, y: 100, rotation: 0 } as Building;
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
    const p = positions(emitChunk(b, land, footway));
    let onFootway = 0;
    for (let i = 0; i < p.length; i += 3) {
      if (p[i + 1]! < f.floor - 1e-3 && -p[i + 2]! < 100 - 0.3 - 1e-3) onFootway++;
    }
    expect(onFootway).toBe(0);
    // Without the footway the same flight stands outside, down to the land.
    const q = positions(emitChunk(b, land));
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
    // At most one shell per finish and one batch per part: the draw calls do
    // not grow with the number of buildings.
    expect(meshes.group.children.length).toBeLessThanOrEqual(FINISHES.length + PART_KINDS.length);
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

describe('building materials', () => {
  it('never draws a building part with a default or unassigned material', () => {
    const kit = createBuildingKit();
    const all = [...Object.entries(kit.material), ...Object.entries(kit.shell)];
    for (const [kind, material] of all) {
      const m = material as MeshStandardMaterial;
      expect(m.name, kind).toMatch(/^building-/);
      // White, untextured and without vertex or instance colours is three's
      // default: a part that fell through to it. The awning is tinted per
      // instance; the shell by its vertex colours.
      const white = m.color.getHex() === 0xffffff;
      if (white && !m.map) expect(kind === 'awning' || m.vertexColors, kind).toBe(true);
    }
    // Every finish the shell can be drawn in has its material.
    for (const finish of FINISHES) expect(kit.shell[finish], finish).toBeDefined();
    kit.dispose();
  });
});
