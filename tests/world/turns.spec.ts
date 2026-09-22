import { describe, expect, it } from 'vitest';

import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { LaneletGraph, classifyTurn } from '@world/lanelets';
import { perp } from '@core/vec2';
import { createIsoRig } from '@render/isoViewport';

/**
 * WHICH WAY IS LEFT.
 *
 * `classifyTurn` was mirrored: it labelled every left turn 'right' and every
 * right turn 'left'. Nothing caught it, because nothing in the suite pinned
 * the handedness of the world frame — the whole thing passed identically with
 * the sign either way round. That is the hole these tests close.
 *
 * Everything keyed on the label was therefore applied to the opposite
 * movement: which lane a turn may be taken from, which turn is allowed to go
 * on red, how long a gap it needs and how fast it takes the curve. On screen
 * that is cars turning across a junction from the wrong lane and crossing a
 * green stream to do it — the reported "signals with the wrong turn".
 *
 * The chain of facts, each measured rather than assumed:
 *
 *   1. the renderer puts +Y UP on screen;
 *   2. so the frame is right-handed and `perp` is the LEFT normal;
 *   3. so a positive heading change is a left turn;
 *   4. so a right turn leaves from the kerb lane and does not cross oncoming
 *      traffic, and a left turn leaves from the innermost lane and does.
 */

describe('the world frame', () => {
  it('renders +Y upwards, which is what makes perp the left normal', () => {
    const rig = createIsoRig({ x: 0, y: 0 }, 200);
    rig.resize(1000, 800);

    const origin = rig.viewport.toScreen({ x: 0, y: 0 }, 1000, 800, 0);
    const north = rig.viewport.toScreen({ x: 0, y: 100 }, 1000, 800, 0);

    // Canvas y grows downwards, so "above the origin" is a SMALLER y.
    expect(north.y).toBeLessThan(origin.y);
  });

  it('classifies a turn towards perp as a left turn', () => {
    const east = { x: 1, y: 0 };
    const left = perp(east);

    // Thirty degrees towards the left normal.
    const turned = {
      x: east.x * Math.cos(0.6) + left.x * Math.sin(0.6),
      y: east.y * Math.cos(0.6) + left.y * Math.sin(0.6),
    };

    expect(classifyTurn(east, turned)).toBe('left');
    expect(classifyTurn(turned, east)).toBe('right');
    expect(classifyTurn(east, east)).toBe('through');
    expect(classifyTurn(east, { x: -1, y: 0 })).toBe('uturn');
  });
});

/** A signalised cross with several lanes each way, and its lane graph. */
function cross(type = 3): { doc: RoadDoc; net: Network; graph: LaneletGraph } {
  const doc = new RoadDoc();
  const centre = doc.addNode({ x: 0, y: 0 });
  for (const deg of [0, 90, 180, 270]) {
    const r = (deg * Math.PI) / 180;
    const far = doc.addNode({ x: Math.cos(r) * 430, y: Math.sin(r) * 430 });
    doc.addSegment(centre.id, far.id, type);
  }
  doc.setNodeControl(centre.id, 'signal');

  const net = new Network(doc);
  net.rebuild();
  const graph = new LaneletGraph();
  graph.build(doc, net);
  return { doc, net, graph };
}

describe('junction movements', () => {
  it('turns the way its own geometry turns', () => {
    const { graph } = cross();
    let checked = 0;

    for (const connector of graph.connectors.values()) {
      const lane = graph.lanelets.get(connector.lanelet);
      if (!lane || lane.length < 1) continue;

      // The connector's own curve: where it comes in and where it leaves.
      const inDir = lane.centre.sampleAt(0).t;
      const outDir = lane.centre.sampleAt(lane.length).t;
      const left = perp(inDir);
      const lean = outDir.x * left.x + outDir.y * left.y;

      checked++;
      if (connector.turn === 'left') expect(lean).toBeGreaterThan(0);
      if (connector.turn === 'right') expect(lean).toBeLessThan(0);
      if (connector.turn === 'through') expect(Math.abs(lean)).toBeLessThan(0.5);
    }

    expect(checked).toBeGreaterThan(8);
  });

  it('takes a right turn from the kerb lane and a left from the inner one', () => {
    const { graph } = cross();
    const seen = { left: 0, right: 0 };

    for (const connector of graph.connectors.values()) {
      const from = graph.lanelets.get(connector.fromLane);
      const to = graph.lanelets.get(connector.toLane);
      if (from?.laneIndex === undefined || to?.laneIndex === undefined) continue;

      // Lane 0 is the innermost, nearest the centreline; the highest index is
      // the kerb lane. A right turn belongs on the kerb, a left on the inside,
      // and getting this backwards is what made both turns cross their own
      // approach's through traffic.
      if (connector.turn === 'left') {
        seen.left++;
        expect(from.laneIndex).toBe(0);
        expect(to.laneIndex).toBe(0);
      }
      if (connector.turn === 'right') {
        seen.right++;
        const lanes = [...graph.lanelets.values()].filter(
          (l) => l.segment === from.segment && l.from === from.from && l.kind === 'link',
        ).length;
        expect(from.laneIndex).toBe(lanes - 1);
      }
    }

    expect(seen.left).toBeGreaterThan(0);
    expect(seen.right).toBeGreaterThan(0);
  });

  it('keeps a right turn on its own side of the road, and sends a left across', () => {
    const { graph } = cross();
    let rights = 0;
    let lefts = 0;

    for (const connector of graph.connectors.values()) {
      const lane = graph.lanelets.get(connector.lanelet);
      if (!lane || lane.length < 1) continue;

      // Offset of the whole movement from where it started, across the
      // approach. A right turn stays on the near side; a left turn has to
      // reach the far side, which is exactly why it crosses oncoming traffic
      // and may never be let through on red.
      const start = lane.centre.sampleAt(0);
      const end = lane.centre.sampleAt(lane.length);
      const left = perp(start.t);
      const across = (end.p.x - start.p.x) * left.x + (end.p.y - start.p.y) * left.y;

      if (connector.turn === 'right') {
        rights++;
        expect(across).toBeLessThan(0);
      }
      if (connector.turn === 'left') {
        lefts++;
        expect(across).toBeGreaterThan(0);
      }
    }

    expect(rights).toBeGreaterThan(0);
    expect(lefts).toBeGreaterThan(0);
  });

  it('gives an approach no two movements that cross each other', () => {
    // Within ONE approach the movements fan out and must never meet: the
    // mirrored label put the left turn in the kerb lane and the right turn on
    // the inside, so each crossed the other and both crossed the through
    // lanes between them. Two movements from the same approach cross when
    // their lane order and their exit order disagree.
    const { graph } = cross();
    const byApproach = new Map<string, { lane: number; rank: number }[]>();

    for (const connector of graph.connectors.values()) {
      const from = graph.lanelets.get(connector.fromLane);
      if (from?.laneIndex === undefined) continue;
      const rank = connector.turn === 'left' ? 0 : connector.turn === 'through' ? 1 : 2;
      const key = `${String(from.segment)}:${String(from.from)}`;
      const list = byApproach.get(key) ?? [];
      list.push({ lane: from.laneIndex, rank });
      byApproach.set(key, list);
    }

    expect(byApproach.size).toBeGreaterThan(0);
    for (const [approach, movements] of byApproach) {
      for (const a of movements) {
        for (const b of movements) {
          if (a.lane >= b.lane) continue;
          // A lane further out may not be assigned a movement that turns
          // further in than one beside it.
          expect(a.rank, `approach ${approach}`).toBeLessThanOrEqual(b.rank);
        }
      }
    }
  });
});
