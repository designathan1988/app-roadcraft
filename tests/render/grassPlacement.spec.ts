import { describe, expect, it } from 'vitest';
import { BufferGeometry, Float32BufferAttribute, MeshBasicMaterial, type InstancedMesh } from 'three';

import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { buildRoadElevation } from '@world/elevation';
import { buildGrass } from '@render/grass';

/** A one-triangle stand-in for the tuft and flower models. */
function kit() {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3));
  const material = new MeshBasicMaterial();
  return { tuft: geometry, flower: geometry, grass: material, flowers: material };
}

/** Every tuft's ground position, rounded to a centimetre-ish grid. */
function tufts(doc: RoadDoc): Set<string> {
  const net = new Network(doc);
  net.rebuild();
  const elevation = buildRoadElevation(net, () => 0);
  const field = buildGrass(net, elevation, () => 0, () => false, 1_400, kit());
  const out = new Set<string>();
  for (const child of field.group.children) {
    const mesh = child as InstancedMesh;
    const m = mesh.instanceMatrix.array;
    for (let i = 0; i < m.length / 16; i++) out.add(`${Math.round(m[i * 16 + 12]! * 10)},${Math.round(m[i * 16 + 14]! * 10)}`);
  }
  field.dispose();
  return out;
}

/**
 * Drawing a road anywhere moved 90 % of the grass on screen: placement drew
 * from one random stream shared by the whole map, and its roadside clumps were
 * dropped along a road picked at random from the list. The meadow jumped on
 * every edit. Grass is seeded by map cell now, so an edit changes only the
 * grass beside the road it touched.
 */
describe('grass placement', () => {
  function grid(): RoadDoc {
    const doc = new RoadDoc();
    const nodes = [];
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) nodes.push(doc.addNode({ x: i * 300 - 300, y: j * 300 - 300 }));
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        const here = nodes[i * 3 + j]!;
        if (i < 2) doc.addSegment(here.id, nodes[(i + 1) * 3 + j]!.id, 2);
        if (j < 2) doc.addSegment(here.id, nodes[i * 3 + j + 1]!.id, 1);
      }
    }
    return doc;
  }

  it('is the same grass after a road is drawn somewhere else', () => {
    const before = tufts(grid());
    expect(before.size).toBeGreaterThan(5_000);
    const edited = grid();
    const a = edited.addNode({ x: 900, y: -900 });
    const b = edited.addNode({ x: 1_050, y: -920 });
    edited.addSegment(a.id, b.id, 1);
    const after = tufts(edited);
    let kept = 0;
    for (const key of before) if (after.has(key)) kept++;
    // The new road is 1 000 units from the grid; nothing near the grid moves.
    expect(kept / before.size).toBeGreaterThan(0.97);
  });

  it('is the same grass every time it is built', () => {
    expect([...tufts(grid())].sort()).toEqual([...tufts(grid())].sort());
  });
});
