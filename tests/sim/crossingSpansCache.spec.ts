import { describe, expect, it } from 'vitest';
import { CrossingSpans } from '@sim/intersections/crossingSpans';
import type { SimWorld } from '@sim/world';
import type { CrossingId } from '@sim/signals/plan';
import { fixtureDoc, simOf } from './support/bodies';

/**
 * Crossing spans are reused from the previous topology build wherever the
 * movement and the crossing are unchanged. A reused span must be exactly the
 * span a cold build measures, or a turning vehicle waits for the wrong person.
 */

function allSpans(w: SimWorld, spans: CrossingSpans): unknown[] {
  const out: unknown[] = [];
  const ids = [...w.graph.connectors.keys()].sort();
  for (const id of ids) {
    const c = w.graph.connectors.get(id);
    if (!c) continue;
    for (const segment of [c.inSegment, c.outSegment]) {
      const crossing = `${c.node}:${segment}` as CrossingId;
      out.push([id, crossing, spans.span(id, crossing)]);
    }
  }
  return out;
}

describe('crossing span cache', () => {
  it('gives the spans a cold build gives, after an edit', () => {
    const doc = fixtureDoc();
    const sim = simOf(doc, 3);
    const busiest = [...doc.nodes.values()]
      .filter((n) => n.incident.length >= 3)
      .sort((a, b) => b.incident.length - a.incident.length || a.id - b.id)[0];
    if (!busiest) throw new Error('fixture has no junction');
    const far = doc.addNode({ x: busiest.x + 180, y: busiest.y + 330 });
    expect(doc.addSegment(busiest.id, far.id, 2)).not.toBeNull();
    sim.net.rebuild();
    sim.rebuildTopology();

    const cold = new CrossingSpans();
    cold.build(sim);
    const warm = allSpans(sim, sim.crossingSpans);
    expect(warm.some((row) => (row as unknown[])[2] !== undefined)).toBe(true);
    expect(warm).toEqual(allSpans(sim, cold));
  });
});
