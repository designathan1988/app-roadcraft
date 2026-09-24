import { describe, expect, it } from 'vitest';

import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { commitDraft } from '@editor/commit';
import { findAnchor, snapEndpoint } from '@editor/snap';

const deg = (r: number): number => (r * 180) / Math.PI;
/** The smaller angle between two directions, in degrees, 0 to 90. */
const between = (a: number, b: number): number => {
  const d = Math.abs(((deg(a - b) % 180) + 180) % 180);
  return Math.min(d, 180 - d);
};

/**
 * A road drawn onto another road near a junction swung away from where it was
 * drawn: the heading snapped to the WORLD grid even when the road it landed on
 * was not on that grid, so a street drawn square onto an avenue at 21 degrees
 * arrived at 105 - fifteen degrees off - and onto a bend it arrived square to
 * the world axis instead of to the bend.
 */
describe('drawing a road onto another road', () => {
  function drawOnto(rotation: number, curved: boolean, relative: number, zoom = 1) {
    const doc = new RoadDoc();
    const c = Math.cos(rotation);
    const s = Math.sin(rotation);
    const a = doc.addNode({ x: -300 * c, y: -300 * s });
    const b = doc.addNode({ x: 300 * c, y: 300 * s });
    const existing = doc.addSegment(a.id, b.id, 2, curved ? { t: 0.5, h: 120 } : null)!;
    const net = new Network(doc);
    net.rebuild();
    const line = net.polylines.get(doc, existing.id);
    const target = line.sampleAt(line.length * 0.5 + 40);
    const dir = Math.atan2(target.t.y, target.t.x) + (relative * Math.PI) / 180;
    const from = { x: target.p.x - Math.cos(dir) * 200, y: target.p.y - Math.sin(dir) * 200 };
    const start = findAnchor(doc, net, from, zoom);
    const snap = snapEndpoint(doc, net, start, target.p, zoom);
    const end = findAnchor(doc, net, snap.at, zoom);
    const result = commitDraft(doc, net, start, end.kind === 'free' ? { kind: 'free', at: snap.at } : end, 2, null, 'ground');
    net.rebuild();
    return { doc, net, snap, result, target };
  }

  it('meets the road at the angle it was drawn, measured from that road', () => {
    for (const rotation of [0, 0.37, 1.1]) {
      for (const relative of [90, 60, 45]) {
        const { doc, net, snap, result } = drawOnto(rotation, false, relative);
        expect(result.committed).toBe(true);
        expect(snap.guide).not.toBe('orthogonal');
        // The new road is the one whose far end is not on the old line.
        const built = [...doc.segments.values()].at(-1)!;
        const line = net.polylines.get(doc, built.id);
        const heading = Math.atan2(line.point(line.n - 1).y - line.point(0).y, line.point(line.n - 1).x - line.point(0).x);
        expect(between(heading, rotation), `rotation ${rotation} drawn ${relative}`).toBeCloseTo(relative, 1);
      }
    }
  });

  it('meets a bend square to the bend, not to the world', () => {
    for (const rotation of [0, 0.37]) {
      const { snap, target } = drawOnto(rotation, true, 90);
      const tangent = Math.atan2(target.t.y, target.t.x);
      expect(between((snap.angleDeg * Math.PI) / 180, tangent)).toBeGreaterThan(88);
    }
  });

  it('still lands on the road where the pointer is', () => {
    const { snap, target } = drawOnto(0.37, true, 60, 0.5);
    expect(Math.hypot(snap.at.x - target.p.x, snap.at.y - target.p.y)).toBeLessThan(20);
  });
});
