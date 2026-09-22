import { describe, expect, it } from 'vitest';

import { RoadDoc } from '@world/doc';
import {
  DEFAULT_POLE_SPACING,
  MAX_POLE_SPACING,
  MIN_POLE_SPACING,
  WIRE_MAX_SAG,
  poleCarriesLamp,
  polePositions,
  sampleWire,
  spanSag,
  wireDrop,
} from '@world/utilities';
import { m } from '@world/units';

/**
 * The overhead utility network.
 *
 * A second drawable graph beside the roads, with none of their machinery: no
 * width, no junction, no trim, no elevation solve. What it does need is that
 * a run lands where the player released, that a wire hangs rather than
 * stretches, and above all that adding it to the document did not break
 * loading a map saved before it existed.
 */

describe('pole runs', () => {
  it('puts a pole at both ends of the drag, whatever the length', () => {
    // A run whose length is not a whole number of spacings must still reach
    // the point the player released, or the tool looks like it ignored them.
    for (const length of [1, 17, 40, 41.7, 199, 1000]) {
      const poles = polePositions({ x: 0, y: 0 }, { x: length, y: 0 });
      expect(poles.length, `length ${length}`).toBeGreaterThanOrEqual(2);
      expect(poles[0]?.x).toBeCloseTo(0, 6);
      expect(poles[poles.length - 1]?.x).toBeCloseTo(length, 6);
    }
  });

  it('keeps its spacing inside the legal band', () => {
    for (const length of [30, 100, 250, 900]) {
      const poles = polePositions({ x: 0, y: 0 }, { x: length, y: 0 });
      for (let i = 1; i < poles.length; i++) {
        const gap = (poles[i]?.x ?? 0) - (poles[i - 1]?.x ?? 0);
        // Half the minimum, because a short run is allowed to be one span.
        expect(gap, `length ${length}`).toBeLessThanOrEqual(MAX_POLE_SPACING + 1e-6);
        if (poles.length > 2) expect(gap).toBeGreaterThan(MIN_POLE_SPACING * 0.5);
      }
    }
  });

  it('spaces poles near the default on a long run', () => {
    const poles = polePositions({ x: 0, y: 0 }, { x: 1000, y: 0 });
    const gap = (poles[1]?.x ?? 0) - (poles[0]?.x ?? 0);
    expect(Math.abs(gap - DEFAULT_POLE_SPACING)).toBeLessThan(DEFAULT_POLE_SPACING * 0.3);
  });

  it('is degenerate-safe', () => {
    expect(polePositions({ x: 5, y: 5 }, { x: 5, y: 5 }).length).toBe(1);
  });

  it('lights every other pole, deterministically', () => {
    expect(poleCarriesLamp(0)).toBe(true);
    expect(poleCarriesLamp(1)).toBe(false);
    expect(poleCarriesLamp(2)).toBe(true);
  });
});

describe('wires hang', () => {
  it('sags in the middle and not at the ends', () => {
    expect(wireDrop(0, 5)).toBeCloseTo(0, 9);
    expect(wireDrop(1, 5)).toBeCloseTo(0, 9);
    expect(wireDrop(0.5, 5)).toBeCloseTo(5, 9);
  });

  it('is symmetric about the middle', () => {
    for (const t of [0.1, 0.25, 0.4]) {
      expect(wireDrop(t, 3)).toBeCloseTo(wireDrop(1 - t, 3), 9);
    }
  });

  it('sags more on a longer span, but not without limit', () => {
    expect(spanSag(m(40))).toBeGreaterThan(spanSag(m(10)));
    expect(spanSag(m(10_000))).toBeLessThanOrEqual(WIRE_MAX_SAG);
  });

  it('never rises above the chord between its two poles', () => {
    // A wire that bulges upward is not a wire.
    const points = sampleWire(0, 0, 20, 100, 0, 26);
    for (let i = 0; i < points.length; i++) {
      const t = i / (points.length - 1);
      const chord = 20 + (26 - 20) * t;
      expect(points[i]?.z ?? 0).toBeLessThanOrEqual(chord + 1e-9);
    }
  });

  it('meets both poles exactly', () => {
    const points = sampleWire(3, 4, 20, 90, 12, 24);
    const first = points[0];
    const last = points[points.length - 1];
    expect(first?.x).toBeCloseTo(3, 9);
    expect(first?.z).toBeCloseTo(20, 9);
    expect(last?.x).toBeCloseTo(90, 9);
    expect(last?.z).toBeCloseTo(24, 9);
  });

  it('produces only finite points, including for a zero-length span', () => {
    for (const points of [sampleWire(0, 0, 10, 0, 0, 10), sampleWire(0, 0, 5, 300, 200, 40)]) {
      for (const p of points) {
        expect(Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z)).toBe(true);
      }
    }
  });
});

describe('the document carries the network', () => {
  const runOf = (doc: RoadDoc, from: { x: number; y: number }, to: { x: number; y: number }) => {
    const ids = polePositions(from, to).map((at, i) => doc.addPole(at, poleCarriesLamp(i)).id);
    for (let i = 1; i < ids.length; i++) {
      const a = ids[i - 1];
      const b = ids[i];
      if (a !== undefined && b !== undefined) doc.addPoleSpan(a, b);
    }
    return ids;
  };

  it('survives a JSON round trip', () => {
    const doc = new RoadDoc();
    runOf(doc, { x: -200, y: 0 }, { x: 200, y: 0 });
    const poles = doc.poles.size;
    const spans = doc.poleSpans.size;
    expect(poles).toBeGreaterThan(2);
    expect(spans).toBe(poles - 1);

    const restored = RoadDoc.fromJSON(JSON.parse(JSON.stringify(doc.toJSON())));
    expect(restored.poles.size).toBe(poles);
    expect(restored.poleSpans.size).toBe(spans);
    for (const [id, pole] of doc.poles) {
      expect(restored.poles.get(id)?.x).toBeCloseTo(pole.x, 9);
      expect(restored.poles.get(id)?.lamp).toBe(pole.lamp);
    }
  });

  it('LOADS A MAP SAVED BEFORE POLES EXISTED, unchanged', () => {
    // The property that matters most. Every map the player already has was
    // written without these keys, and loading one must not fail, must not
    // drop the roads, and must not invent a network.
    const legacy = {
      version: 1 as const,
      nodes: [
        { id: 1, x: 0, y: 0 },
        { id: 2, x: 200, y: 0 },
      ],
      segments: [{ id: 1, a: 1, b: 2, type: 2, curve: null }],
    };
    const doc = RoadDoc.fromJSON(legacy);
    expect(doc.nodes.size).toBe(2);
    expect(doc.segments.size).toBe(1);
    expect(doc.poles.size).toBe(0);
    expect(doc.poleSpans.size).toBe(0);
  });

  it('drops a wire whose poles did not survive', () => {
    const doc = RoadDoc.fromJSON({
      version: 1,
      nodes: [],
      segments: [],
      poles: [{ id: 1, x: 0, y: 0 }],
      poleSpans: [{ id: 1, a: 1, b: 99 }],
    });
    expect(doc.poles.size).toBe(1);
    expect(doc.poleSpans.size).toBe(0);
  });

  it('removes every wire that reached a removed pole', () => {
    const doc = new RoadDoc();
    const ids = runOf(doc, { x: 0, y: 0 }, { x: 300, y: 0 });
    const middle = ids[1];
    expect(middle).toBeDefined();
    const before = doc.poleSpans.size;
    if (middle !== undefined) doc.removePole(middle);
    expect(doc.poles.size).toBe(ids.length - 1);
    // An interior pole carried two spans; both must go.
    expect(doc.poleSpans.size).toBe(before - 2);
    for (const span of doc.poleSpans.values()) {
      expect(span.a).not.toBe(middle);
      expect(span.b).not.toBe(middle);
    }
  });

  it('never strings the same wire twice, or a wire to itself', () => {
    const doc = new RoadDoc();
    const a = doc.addPole({ x: 0, y: 0 }).id;
    const b = doc.addPole({ x: 50, y: 0 }).id;
    doc.addPoleSpan(a, b);
    doc.addPoleSpan(a, b);
    doc.addPoleSpan(b, a);
    expect(doc.poleSpans.size).toBe(1);
    expect(doc.addPoleSpan(a, a)).toBeNull();
    expect(doc.poleSpans.size).toBe(1);
  });

  it('is carried through clone and replaceWith', () => {
    const doc = new RoadDoc();
    runOf(doc, { x: 0, y: 0 }, { x: 240, y: 60 });
    const copy = doc.clone();
    expect(copy.poles.size).toBe(doc.poles.size);
    expect(copy.poleSpans.size).toBe(doc.poleSpans.size);

    const target = new RoadDoc();
    target.replaceWith(doc);
    expect(target.poles.size).toBe(doc.poles.size);
    expect(target.poleSpans.size).toBe(doc.poleSpans.size);
  });

  it('bumps the revision so the renderer rebuilds', () => {
    const doc = new RoadDoc();
    const before = doc.revision;
    const a = doc.addPole({ x: 0, y: 0 }).id;
    const b = doc.addPole({ x: 60, y: 0 }).id;
    doc.addPoleSpan(a, b);
    expect(doc.revision).toBeGreaterThan(before);
  });

  it('finds the nearest pole within reach, and none outside it', () => {
    const doc = new RoadDoc();
    doc.addPole({ x: 0, y: 0 });
    const near = doc.addPole({ x: 10, y: 0 });
    expect(doc.poleNear({ x: 11, y: 0 }, 5)?.id).toBe(near.id);
    expect(doc.poleNear({ x: 500, y: 500 }, 5)).toBeNull();
  });
});
