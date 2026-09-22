import { describe, expect, it } from 'vitest';

import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { commitPoleRun, planPoleRun, snapPole } from '@editor/poles';
import { DEFAULT_POLE_SPACING } from '@world/utilities';
import { roadProfile } from '@world/roadTypes';

/**
 * The pole tool, judged by what it BUILDS rather than by what it intends.
 *
 * Every one of these is a defect that was reported by hand:
 *
 *   - poles did not snap to a footway, so a line beside a street was beside it
 *     only as accurately as the drag;
 *   - a run aimed at an existing pole built a second mast next to it instead
 *     of joining the line;
 *   - there was no discipline on the angle, while the road tool has had 15
 *     degrees all along;
 *   - a run could not be continued, so a line across a map meant restarting
 *     the tool at every corner.
 *
 * They are asserted against the plan, which is the same object the preview
 * draws and the commit applies — so a test passing here is a preview that
 * tells the truth.
 */

function street(): { doc: RoadDoc; net: Network } {
  const doc = new RoadDoc();
  const a = doc.addNode({ x: -400, y: 0 });
  const b = doc.addNode({ x: 400, y: 0 });
  doc.addSegment(a.id, b.id, 1);
  const net = new Network(doc);
  net.rebuild();
  return { doc, net };
}

/** Distance from the road centreline the furniture line sits at. */
function furnitureOffset(doc: RoadDoc): number {
  const seg = [...doc.segments.values()][0]!;
  const rt = roadProfile(seg.type, seg.lanes, seg.direction);
  return rt.width / 2 + rt.sidewalk * 0.55;
}

describe('pole snapping', () => {
  it('pulls a pole onto the footway of the road it was aimed beside', () => {
    const { doc, net } = street();
    const want = furnitureOffset(doc);

    // Aimed a little outside the furniture line, on the north side.
    const snap = snapPole(doc, net, { x: 0, y: want + 3 }, 20);

    expect(snap.kind).toBe('footway');
    expect(Math.abs(snap.at.y)).toBeCloseTo(want, 4);
    expect(snap.at.x).toBeCloseTo(0, 4);
  });

  it('keeps the side the player aimed at', () => {
    const { doc, net } = street();
    const want = furnitureOffset(doc);

    expect(snapPole(doc, net, { x: 100, y: want + 2 }, 20).at.y).toBeGreaterThan(0);
    expect(snapPole(doc, net, { x: 100, y: -want - 2 }, 20).at.y).toBeLessThan(0);
  });

  it('leaves open ground alone', () => {
    const { doc, net } = street();
    const far = { x: 0, y: 600 };
    const snap = snapPole(doc, net, far, 20);
    expect(snap.kind).toBe('free');
    expect(snap.at).toEqual(far);
  });

  it('takes an existing pole over the footway under it', () => {
    const { doc, net } = street();
    const want = furnitureOffset(doc);
    const standing = doc.addPole({ x: 120, y: want });

    const snap = snapPole(doc, net, { x: 126, y: want + 2 }, 30);
    expect(snap.kind).toBe('pole');
    expect(snap.pole).toBe(standing.id);
    expect(snap.at).toEqual({ x: 120, y: want });
  });
});

describe('pole runs', () => {
  it('holds the drawn angle to 15 degrees on open ground', () => {
    const { doc, net } = street();
    const from = { x: 0, y: 600 };
    // Four degrees off horizontal: inside the cone, so it must come out at 0.
    const to = { x: 600, y: 600 + 600 * Math.tan(0.07) };

    const plan = planPoleRun(doc, net, from, to, 20);
    const angle = Math.atan2(plan.to.at.y - plan.from.at.y, plan.to.at.x - plan.from.at.x);
    const degrees = (angle * 180) / Math.PI;
    expect(Math.abs(degrees % 15)).toBeLessThan(1e-6);
  });

  it('reuses the pole a run is aimed at instead of doubling it', () => {
    const { doc, net } = street();
    const standing = doc.addPole({ x: 0, y: 600 });

    const plan = planPoleRun(doc, net, { x: 4, y: 602 }, { x: 300, y: 600 }, 30);
    expect(plan.poles[0]!.existing).toBe(standing.id);

    const before = doc.poles.size;
    expect(commitPoleRun(doc, plan)).toBe(true);
    // Every pole of the run is new EXCEPT the one it joined.
    expect(doc.poles.size).toBe(before + plan.poles.length - 1);
  });

  it('continues an existing line rather than building beside it', () => {
    const { doc, net } = street();

    const first = planPoleRun(doc, net, { x: -300, y: 600 }, { x: 0, y: 600 }, 30);
    commitPoleRun(doc, first);
    const afterFirst = doc.poles.size;
    const end = first.poles[first.poles.length - 1]!.at;

    // Carry on from the end, as the chain does.
    const second = planPoleRun(doc, net, end, { x: 300, y: 600 }, 30);
    commitPoleRun(doc, second);

    // One shared pole at the join: the total is the two runs minus the pole
    // they have in common.
    expect(doc.poles.size).toBe(afterFirst + second.poles.length - 1);

    // And the wire is continuous through it: the join carries two spans.
    const joinId = second.poles[0]!.existing;
    expect(joinId).not.toBeNull();
    const atJoin = [...doc.poleSpans.values()].filter((s) => s.a === joinId || s.b === joinId);
    expect(atJoin).toHaveLength(2);
  });

  it('spaces poles the way a line is spaced, both ends included', () => {
    const { doc, net } = street();
    const plan = planPoleRun(doc, net, { x: 0, y: 600 }, { x: 300, y: 600 }, 20);

    expect(plan.poles.length).toBeGreaterThan(2);
    expect(plan.poles[0]!.at.x).toBeCloseTo(0, 6);
    expect(plan.poles[plan.poles.length - 1]!.at.x).toBeCloseTo(300, 6);

    for (let i = 1; i < plan.poles.length; i++) {
      const step = plan.poles[i]!.at.x - plan.poles[i - 1]!.at.x;
      expect(step).toBeGreaterThan(DEFAULT_POLE_SPACING * 0.5);
      expect(step).toBeLessThan(DEFAULT_POLE_SPACING * 1.5);
    }
  });

  it('runs along a street when it starts on its footway', () => {
    const { doc, net } = street();
    const want = furnitureOffset(doc);

    // Started on the footway and dragged roughly along it, a few degrees off.
    const plan = planPoleRun(doc, net, { x: -200, y: want + 1 }, { x: 200, y: want + 26 }, 20);

    expect(plan.from.kind).toBe('footway');
    // Every pole of the run stands on the footway line, not out in the road
    // and not out in the grass.
    for (const pole of plan.poles) {
      expect(Math.abs(Math.abs(pole.at.y) - want)).toBeLessThan(1.5);
    }
  });

  it('builds nothing from a run with a single pole in it', () => {
    const { doc, net } = street();
    const plan = planPoleRun(doc, net, { x: 0, y: 600 }, { x: 0, y: 600 }, 20);
    expect(commitPoleRun(doc, plan)).toBe(false);
    expect(doc.poles.size).toBe(0);
  });
});
