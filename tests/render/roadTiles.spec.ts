import { readFileSync } from 'node:fs';
import { MeshBasicMaterial, type BufferGeometry, type Object3D } from 'three';
import { describe, expect, it } from 'vitest';

import { Digest } from '@core/digest';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { buildRoadElevation, type RoadElevation } from '@world/elevation';
import type { SceneMaterials } from '@render/materials';
import { buildRoadSurfaces, type SurfaceReuse } from '@render/roadSurfaces';

/**
 * The road surfaces are built a tile at a time, and a tile an edit does not
 * reach is copied from the build before. That is only safe if the copy is
 * exactly what building it again would give, so this compares an edited
 * network rebuilt from the cache with the same network built from nothing,
 * bit for bit.
 */

const materials = new Proxy({}, {
  get: (_target, key) => key === 'scale' ? new Proxy({}, { get: () => 4 }) : new MeshBasicMaterial(),
}) as unknown as SceneMaterials;

/** Gently rolling ground, read the way the terrain mesh would be. */
const ground = (x: number, y: number): number => 2 * Math.sin(x / 90) + 1.5 * Math.cos(y / 70);

function fixture(): RoadDoc {
  return RoadDoc.fromJSON(JSON.parse(readFileSync('tests/fixtures/grid-and-bends.json', 'utf8')).document);
}

function fingerprint(root: Object3D): number {
  const digest = new Digest();
  root.traverse((object) => {
    const geometry = (object as { geometry?: BufferGeometry }).geometry;
    if (!geometry) return;
    digest.addText(object.name);
    for (const name of ['position', 'normal', 'uv', 'color']) digest.addAll(geometry.getAttribute(name).array);
    digest.addAll(geometry.getIndex()!.array);
  });
  return digest.value();
}

function reuseFor(elevation: () => RoadElevation): SurfaceReuse {
  return {
    tiles: new Map(),
    // The ground here is a fixed function, so the roads are all there is to digest.
    dependsOn: (minX, minY, maxX, maxY) => elevation().digest(minX, minY, maxX, maxY),
    paint: new Map(),
  };
}

describe('road surface tiles', () => {
  const doc = fixture();
  const net = new Network(doc);
  net.rebuild();
  let elevation = buildRoadElevation(net, ground);
  const reuse = reuseFor(() => elevation);
  const cold = buildRoadSurfaces(net, elevation, materials, ground, reuse);

  it('builds every tile the first time', () => {
    expect(cold.built).toBeGreaterThan(20);
    expect(cold.reused).toBe(0);
  });

  it('builds nothing again when nothing changed', () => {
    const again = buildRoadSurfaces(net, elevation, materials, ground, reuse);
    expect(again.built).toBe(0);
    expect(again.reused).toBe(cold.built);
    expect(fingerprint(again.group)).toBe(fingerprint(cold.group));
  });

  it('rebuilds only what an edit reaches, into exactly the mesh a fresh build makes', () => {
    const first = [...doc.nodes.values()][0]!;
    const far = doc.addNode({ x: first.x + 40, y: first.y - 260 });
    doc.addSegment(first.id, far.id, 2);
    net.rebuild();
    elevation = buildRoadElevation(net, ground);

    const warm = buildRoadSurfaces(net, elevation, materials, ground, reuse);
    expect(warm.built).toBeGreaterThan(0);
    expect(warm.reused).toBeGreaterThan(warm.built * 2);

    const fresh = buildRoadSurfaces(net, elevation, materials, ground, reuseFor(() => elevation));
    expect(fresh.reused).toBe(0);
    expect(fingerprint(warm.group)).toBe(fingerprint(fresh.group));
    expect(warm.triangles).toBe(fresh.triangles);
  });

  it('forgets a structural level that is no longer built', () => {
    for (const segment of [...doc.segments.values()]) {
      if (segment.structure !== 'ground') doc.setSegmentStructure(segment.id, 'ground');
    }
    net.rebuild();
    elevation = buildRoadElevation(net, ground);
    buildRoadSurfaces(net, elevation, materials, ground, reuse);
    expect([...reuse.tiles.keys()]).toEqual(['ground']);
  });

  it('draws a road raised in one stroke as one surface, not a piece at a time', () => {
    // Four pieces at authored heights, bending a little at each node: one
    // alignment pass. A pass per segment closed every piece's ends, and the
    // joins showed as lines across the road and notched kerbs.
    const doc = new RoadDoc();
    const pts: [number, number, number][] = [[0, 0, 0], [60, 4, 5], [120, 0, 9], [180, 6, 5], [240, 0, 0]];
    const nodes = pts.map(([x, y, h]) => doc.addNode({ x, y }, h));
    for (let i = 1; i < nodes.length; i++) doc.addSegment(nodes[i - 1]!.id, nodes[i]!.id, 1);
    const net = new Network(doc);
    net.rebuild();
    const reuse = reuseFor(() => buildRoadElevation(net, ground));
    buildRoadSurfaces(net, buildRoadElevation(net, ground), materials, ground, reuse);
    expect([...reuse.tiles.keys()].filter((id) => id.startsWith('alignment-'))).toHaveLength(1);
  });
});
