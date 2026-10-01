import { BufferGeometry, Float32BufferAttribute, Group, LineBasicMaterial, LineSegments, type Scene } from 'three';
import type { Network } from '@world/network';
import { FOOTWAY_RISE } from '@world/roadTypes';
import { buildWalkways, type WalkwayKind } from '@world/walkways';
import type { RoadStructure } from '@world/structures';

/**
 * DEVELOPMENT ONLY: the pedestrian network (`world/walkways.ts`) drawn over
 * the city, to photograph it where it lies - footways blue, corners red,
 * crossings yellow - a little above the paving. Not used by the game.
 */
const COLOURS: Readonly<Record<WalkwayKind, number>> = { footway: 0x1e6fd9, corner: 0xe03010, crossing: 0xf0c000 };
const NAME = 'debug-walkways';

export function showWalkways(
  scene: Scene,
  net: Network,
  heightAt: (x: number, y: number, structure: RoadStructure) => number,
): number {
  hideWalkways(scene);
  const g = buildWalkways(net);
  const group = new Group();
  group.name = NAME;
  for (const kind of ['footway', 'corner', 'crossing'] as const) {
    const pos: number[] = [];
    for (const w of g.ways) {
      if (w.kind !== kind) continue;
      const pts = w.path.toPoints();
      const lift = w.kind === 'crossing' ? 0.15 : FOOTWAY_RISE + 0.15;
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1]!, b = pts[i]!;
        // World (x, y, h) is three's (x, h, -y).
        pos.push(a.x, heightAt(a.x, a.y, w.structure) + lift, -a.y, b.x, heightAt(b.x, b.y, w.structure) + lift, -b.y);
      }
    }
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new Float32BufferAttribute(pos, 3));
    const lines = new LineSegments(geometry, new LineBasicMaterial({ color: COLOURS[kind], depthTest: false }));
    lines.renderOrder = 10;
    group.add(lines);
  }
  scene.add(group);
  return g.ways.length;
}

export function hideWalkways(scene: Scene): void {
  const old = scene.getObjectByName(NAME);
  if (old) scene.remove(old);
}
