import { describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { Network } from '@world/network';
import { LaneletGraph } from '@world/lanelets';
import { BODY_CLASSES, BODY_CLASS_NAMES, ConflictIndex } from '@world/conflictPoints';
import { LAYOUTS, fixtureDoc, layoutDoc } from '../sim/support/bodies';

/**
 * Conflict zones are measured from swept bodies, not centrelines.
 *
 * These are the properties the claim table relies on and cannot check for
 * itself: that a smaller body's zone lies inside a larger one's, that a
 * conflict with no line crossing is still found, that no zone reaches a body
 * waiting at its own stop line, and that the index is cheap enough to rebuild
 * on every edit.
 */

function indexOf(doc: ReturnType<typeof layoutDoc>['doc']) {
  const net = new Network(doc);
  net.rebuild();
  const graph = new LaneletGraph();
  graph.build(doc, net);
  const conflicts = new ConflictIndex();
  const t0 = performance.now();
  conflicts.build(graph);
  return { graph, conflicts, ms: performance.now() - t0 };
}

describe('swept conflict zones', () => {
  it('finds the body conflicts that no centreline crossing reveals', () => {
    const { graph, conflicts } = indexOf(layoutDoc(LAYOUTS[0]!).doc);
    const swept = conflicts.points.filter((p) => p?.kind === 'swept');
    expect(swept.length).toBeGreaterThan(0);
    // Paths whose centrelines never meet, yet whose bodies do - a bus's tail
    // swinging over the movement beside it. The centreline index never saw
    // them. (Opposing left turns used to be the example; since turn paths are
    // as round as the kerbs allow, they now pass clear of each other.)
    expect(swept.some((p) => p.zone(p.a, 2, 2) !== null && graph.connectors.get(p.a)?.inSegment !==
      graph.connectors.get(p.b)?.inSegment)).toBe(true);
  });

  it('nests: a smaller body is inside the zone of a larger one', () => {
    for (const layout of LAYOUTS) {
      const { conflicts } = indexOf(layoutDoc(layout).doc);
      for (const p of conflicts.points) {
        if (!p) continue;
        for (const on of [p.a, p.b]) {
          for (const theirs of BODY_CLASSES) {
            for (const mine of BODY_CLASSES.slice(0, -1)) {
              const small = p.zone(on, mine, theirs);
              const large = p.zone(on, (mine + 1) as 1 | 2, theirs);
              if (!small) continue;
              expect(large, `${layout.name} ${on}`).not.toBeNull();
              // Centres differ in range by the half-length difference only.
              expect(small.enter).toBeGreaterThanOrEqual(large!.enter - 1e-9);
            }
          }
        }
      }
    }
  });

  it('never reaches a vehicle still waiting behind its own stop line', () => {
    // A claim protects a body that is moving through the box. A zone that
    // starts before the stop line would put a queued, unadmitted vehicle
    // inside another movement's swept area where nothing can protect it.
    const report: Record<string, unknown> = {};
    for (const layout of LAYOUTS) {
      const { conflicts } = indexOf(layoutDoc(layout).doc);
      report[layout.name] = conflicts.queueIntrusions.map((q) => ({
        ...q, mine: BODY_CLASS_NAMES[q.mine], theirs: BODY_CLASS_NAMES[q.theirs],
      }));
      // Two cars: never. Heavy vehicles are recorded rather than asserted,
      // because the carriageway geometry, not the index, decides them.
      expect(conflicts.queueIntrusions.filter((q) => q.mine < 2 && q.theirs < 2), layout.name)
        .toEqual([]);
    }
    if (process.env['ROADCRAFT_RECORD_MOVEMENTS'] === '1') {
      writeFileSync('docs/audit/junction-queue-intrusions.json', JSON.stringify(report, null, 2) + '\n');
    }
  });

  it('builds a whole player map inside an edit budget', () => {
    // The best of three cold builds, each on a fresh index. One build alone
    // timed the JIT warming up and whatever else the suite was running beside
    // it: 150 ms on its own, nearly 2 s under the full suite with coverage.
    let best = Infinity;
    for (let run = 0; run < 3; run++) {
      const { conflicts, ms } = indexOf(fixtureDoc());
      expect(conflicts.points.filter(Boolean).length).toBeGreaterThan(100);
      best = Math.min(best, ms);
    }
    // Rebuilt on every topology edit. Generous for a CI machine, and still a
    // hard stop on anything quadratic in the sampled rectangles.
    expect(best).toBeLessThan(1500);
  });

  it('keeps a conflict id stable across a rebuild', () => {
    const { doc } = layoutDoc(LAYOUTS[0]!);
    const net = new Network(doc);
    net.rebuild();
    const graph = new LaneletGraph();
    graph.build(doc, net);
    const conflicts = new ConflictIndex();
    conflicts.build(graph);
    const before = new Map(conflicts.points.filter(Boolean).map((p) => [`${p.a}|${p.b}`, p.id]));
    conflicts.build(graph);
    for (const p of conflicts.points.filter(Boolean)) {
      expect(before.get(`${p.a}|${p.b}`)).toBe(p.id);
    }
  });
});
