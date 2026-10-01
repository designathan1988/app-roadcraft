import { beforeEach, describe, expect, it } from 'vitest';

import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { buildRoadElevation, type RoadElevation } from '@world/elevation';
import { Level } from '@world/roadTypes';
import { applyOp, freshState, type FuzzOp } from '../fuzz/support/ops';
import {
  ROAD_GROUND_CLEARANCE,
  TUNNEL_BORE,
  TUNNEL_GRADE,
  roadStructure,
} from '@world/structures';

/**
 * The elevation field is the single source of height for every road surface, so
 * these are the properties the mesh depends on:
 *
 *  - CONTINUITY, because a step in the field is a crack in the mesh;
 *  - CLEARANCE, because a deck under the terrain is a road cut into plates;
 *  - AGREEMENT AT A NODE, because two legs at different heightsis a visible step.
 */

function flatGround(): (x: number, y: number) => number {
  return () => 0;
}

function hill(cx: number, cy: number, radius: number, height: number) {
  return (x: number, y: number): number => {
    const d = Math.hypot(x - cx, y - cy);
    if (d >= radius) return 0;
    const u = 1 - d / radius;
    return height * u * u * (3 - 2 * u);
  };
}

function crossNetwork(): { doc: RoadDoc; net: Network } {
  const doc = new RoadDoc();
  const centre = doc.addNode({ x: 0, y: 0 });
  const north = doc.addNode({ x: 0, y: -300 });
  const south = doc.addNode({ x: 0, y: 300 });
  const west = doc.addNode({ x: -300, y: 0 });
  const east = doc.addNode({ x: 300, y: 0 });
  doc.addSegment(north.id, centre.id, 3);
  doc.addSegment(centre.id, south.id, 3);
  doc.addSegment(west.id, centre.id, 2);
  doc.addSegment(centre.id, east.id, 2);
  const net = new Network(doc);
  net.rebuild();
  return { doc, net };
}

/** The largest jump the field makes between two points `step` apart. */
function worstStep(field: RoadElevation, radius: number, step: number): number {
  let worst = 0;
  for (let x = -radius; x <= radius; x += step) {
    for (let y = -radius; y <= radius; y += step) {
      const here = field.at(x, y);
      worst = Math.max(worst, Math.abs(field.at(x + step, y) - here), Math.abs(field.at(x, y + step) - here));
    }
  }
  return worst;
}

/**
 * Continuity, measured rather than assumed.
 *
 * A continuous field's worst jump shrinks in proportion to the sampling step; a
 * field with a cliff in it keeps the same jump however finely it is sampled.
 * Halving the step and requiring the jump to halve with it is therefore the test
 * that actually distinguishes the two — and the one that caught an 8.8-unit
 * cliff a few tens of units off the kerb, where the road's influence simply
 * stopped and the answer fell to the bare ground.
 */
function continuityRatio(field: RoadElevation, radius: number): number {
  const coarse = worstStep(field, radius, 2);
  const fine = worstStep(field, radius, 0.5);
  return fine / Math.max(1e-9, coarse);
}

it('keeps an elevated ramp within grade after a short-span split', () => {
  const state = freshState();
  const ops = [
    { op: 'draw', a: [539.89, -698.3], b: [685.21, -608.5], type: 0, curve: null, structure: 'ground' },
    { op: 'draw', a: [563.79, -674.76], b: [656.27, -700], type: 3, curve: { t: 0.39, h: -31.07 }, structure: 'ground' },
    { op: 'removeNode', pick: 0.34 },
    { op: 'structure', pick: 0.67, structure: 'elevated' },
    { op: 'removeNode', pick: 0.08 },
    { op: 'split', pick: 0.1, at: 0.65 },
  ] as FuzzOp[];
  for (const op of ops) applyOp(state, op);
  const elevation = buildRoadElevation(state.net, flatGround());
  for (const [id, ribbon] of state.net.ribbons) {
    if (state.doc.segment(id)?.structure !== 'elevated') continue;
    let previous: number | null = null;
    for (let s = 0; s <= ribbon.full.length; s += 0.25) {
      const p = ribbon.full.sampleAt(s).p;
      const height = elevation.onSegment(id, p.x, p.y);
      if (previous !== null) expect(Math.abs(height - previous)).toBeLessThan(0.05);
      previous = height;
    }
  }
});

describe('road elevation on flat ground', () => {
  let field: RoadElevation;
  beforeEach(() => {
    const { net } = crossNetwork();
    field = buildRoadElevation(net, flatGround());
  });

  it('lays the deck one clearance above the ground', () => {
    expect(field.at(120, 0)).toBeCloseTo(ROAD_GROUND_CLEARANCE, 6);
  });

  it('is flat across the junction, so the plate cannot dish', () => {
    const centre = field.at(0, 0);
    for (const [x, y] of [[8, 8], [-8, 8], [14, 0], [0, -14], [20, 20]] as const) {
      expect(field.at(x, y)).toBeCloseTo(centre, 6);
    }
  });

  it('has no step anywhere: continuity is what keeps the mesh watertight', () => {
    expect(worstStep(field, 340, 4)).toBeLessThan(0.05);
    expect(continuityRatio(field, 340)).toBeLessThan(0.4);
  });
});

describe('road elevation over a hill', () => {
  const terrain = hill(0, 0, 160, 18);
  let field: RoadElevation;
  beforeEach(() => {
    const { net } = crossNetwork();
    field = buildRoadElevation(net, terrain);
  });

  it('cuts into what rises above it and fills over what falls away', () => {
    // The contract a road at grade actually has. It is NOT "stay above the
    // ground": a road that never cuts has to ride over every hummock, which is
    // the rippling ribbon a player photographed. It designs a line through the
    // ground and the terrain is reshaped to meet it, so both signs must appear.
    let deepestCut = 0;
    let highestFill = 0;
    for (let s = -300; s <= 300; s += 3) {
      for (const [x, y] of [[s, 0], [0, s]] as const) {
        const offset = field.at(x, y) - terrain(x, y);
        deepestCut = Math.min(deepestCut, offset);
        highestFill = Math.max(highestFill, offset);
      }
    }
    expect(deepestCut).toBeLessThan(-1);
    expect(highestFill).toBeGreaterThan(0.2);
  });

  it('keeps the earthwork bounded', () => {
    // A cut is a design decision, not a licence to excavate the map. Nothing on
    // an 18-unit hill should move more earth than the hill is tall.
    for (let s = -300; s <= 300; s += 3) {
      for (const [x, y] of [[s, 0], [0, s]] as const) {
        expect(Math.abs(field.at(x, y) - terrain(x, y))).toBeLessThan(10);
      }
    }
  });

  it('is far smoother than the ground it crosses', () => {
    // The point of the whole exercise, stated as a number: the designed line
    // must curve less than the ground does. Second difference, summed.
    let road = 0;
    let ground = 0;
    for (let x = -290; x <= 290; x += 4) {
      road += Math.abs(field.at(x - 4, 0) - 2 * field.at(x, 0) + field.at(x + 4, 0));
      ground += Math.abs(terrain(x - 4, 0) - 2 * terrain(x, 0) + terrain(x + 4, 0));
    }
    expect(road).toBeLessThan(ground * 0.6);
  });

  it('follows the hill rather than bridging it', () => {
    expect(field.at(0, 0)).toBeGreaterThan(9);
    expect(field.at(290, 0)).toBeLessThan(3);
  });

  it('respects the ground road gradient limit', () => {
    let steepest = 0;
    for (let s = -300; s < 300; s += 2) {
      steepest = Math.max(steepest, Math.abs(field.at(s + 2, 0) - field.at(s, 0)) / 2);
    }
    // 12% is the stated limit; the plate and the blend may add a hair.
    expect(steepest).toBeLessThan(0.14);
  });

  it('still keeps every leg of the junction at one height', () => {
    const centre = field.at(0, 0);
    for (const [x, y] of [[10, 10], [-10, 10], [16, 0], [0, -16]] as const) {
      expect(Math.abs(field.at(x, y) - centre)).toBeLessThan(0.01);
    }
  });

  it('has no step anywhere over broken ground', () => {
    // A quarter of the sampling step: the field is Lipschitz, not cliffed.
    expect(continuityRatio(field, 340)).toBeLessThan(0.4);
  });

  it('is decided by the road, not the ground, everywhere a surface is drawn', () => {
    // The widest casing is 31.5 units; nothing the mesh builds reaches further.
    for (let s = -280; s <= 280; s += 7) {
      for (const across of [-31, -16, 0, 16, 31]) {
        const onRoad = field.at(s, across);
        const centre = field.at(s, 0);
        expect(Math.abs(onRoad - centre)).toBeLessThan(0.02);
      }
    }
  });
});

describe('raised structures', () => {
  function elevatedChain(structure: 'elevated' | 'bridge', span: number) {
    const doc = new RoadDoc();
    const a = doc.addNode({ x: -span, y: 0 });
    const b = doc.addNode({ x: -span / 3, y: 0 });
    const c = doc.addNode({ x: span / 3, y: 0 });
    const d = doc.addNode({ x: span, y: 0 });
    doc.addSegment(a.id, b.id, 2);
    const raised = doc.addSegment(b.id, c.id, 2);
    doc.addSegment(c.id, d.id, 2);
    doc.setSegmentStructure(raised!.id, structure);
    const net = new Network(doc);
    net.rebuild();
    return { doc, net, raised: raised!.id, landing: [b.id, c.id] as const };
  }

  it('lands exactly on the road at grade it connects to', () => {
    const { net, landing } = elevatedChain('elevated', 900);
    const field = buildRoadElevation(net, flatGround());
    for (const node of landing) {
      expect(field.nodeHeight(node)).toBeCloseTo(ROAD_GROUND_CLEARANCE, 6);
    }
  });

  it('reaches its design clearance when the span is long enough', () => {
    const { net } = elevatedChain('elevated', 1_400);
    const field = buildRoadElevation(net, flatGround());
    const spec = roadStructure('elevated');
    expect(field.at(0, 0)).toBeGreaterThan(spec.clearance * 0.9);
  });

  it('lowers the deck rather than steepening the ramp on a short span', () => {
    const { net } = elevatedChain('elevated', 220);
    const field = buildRoadElevation(net, flatGround());
    let steepest = 0;
    for (let x = -220; x < 220; x += 2) {
      steepest = Math.max(steepest, Math.abs(field.at(x + 2, 0) - field.at(x, 0)) / 2);
    }
    expect(steepest).toBeLessThan(0.165);
  });

  it('keeps the ground pass and the raised pass apart', () => {
    const { net } = elevatedChain('elevated', 1_400);
    const field = buildRoadElevation(net, flatGround());
    const ground = new Set(['ground' as const]);
    const raised = new Set(['elevated' as const]);
    expect(field.at(0, 0, raised)).toBeGreaterThan(field.at(0, 0, ground) + 5);
  });
});

describe('ramps between a raised deck and the ground', () => {
  const rolling = (x: number, y: number): number => 3 * Math.sin(x / 90) + 2 * Math.sin((x + y) / 37);

  /** One elevated segment of `span`, alone (both ends on the ground) or between two roads at grade. */
  function elevated(span: number, ground: (x: number, y: number) => number, standalone = true) {
    const doc = new RoadDoc();
    const b = doc.addNode({ x: -span / 2, y: 0 });
    const c = doc.addNode({ x: span / 2, y: 0 });
    if (!standalone) {
      doc.addSegment(doc.addNode({ x: -span / 2 - 300, y: 0 }).id, b.id, 2);
      doc.addSegment(c.id, doc.addNode({ x: span / 2 + 300, y: 0 }).id, 2);
    }
    const raised = doc.addSegment(b.id, c.id, 2)!;
    doc.setSegmentStructure(raised.id, 'elevated');
    const net = new Network(doc);
    net.rebuild();
    const field = buildRoadElevation(net, ground);
    const heights: number[] = [];
    for (let s = 0; s <= span; s += 1) heights.push(field.onSegment(raised.id, -span / 2 + s, 0));
    return { field, heights, span, b: b.id, c: c.id };
  }

  /**
   * The two ramps and the deck between them. A ramp runs from where the road
   * leaves its plate to where it stops climbing faster than a deck may
   * (`DECK_GRADE`, 5 %); the deck is everything between the two ramps.
   */
  function anatomy(heights: readonly number[]) {
    const grade = (i: number): number => Math.abs((heights[i + 4] as number) - (heights[i] as number)) / 4;
    const foot = heights[0] as number;
    const upStart = heights.findIndex((h) => h > foot + 0.02);
    // The first units of a ramp are its sag curve, where the grade is still
    // building up from level and is below a deck's; the ramp does not end
    // there. `SAG` is the curve's length (`RAMP_CURVE`).
    const SAG = 12;
    let upEnd = upStart;
    while (upEnd < heights.length - 5 && (grade(upEnd) > 0.052 || upEnd - upStart < SAG)) upEnd++;
    const end = heights.length - 1;
    const tail = heights[end] as number;
    let downStart = end;
    while (downStart > 0 && (heights[downStart] as number) <= tail + 0.02) downStart--;
    let downEnd = downStart;
    while (downEnd > 4 && (grade(downEnd - 4) > 0.052 || downStart - downEnd < SAG)) downEnd--;
    let steepest = 0;
    for (let i = 0; i + 4 < heights.length; i++) steepest = Math.max(steepest, grade(i));
    return {
      rampA: upEnd - upStart,
      rampB: downStart - downEnd,
      deck: (downEnd - upEnd) / heights.length,
      deckFrom: upEnd,
      deckTo: downEnd,
      steepest,
      top: Math.max(...heights) - foot,
    };
  }

  it('climbs to its full height in at most 100 units, and is level at full height between', () => {
    // The player's complaint, twice: "the ramp must be a few metres, not a thing
    // with no end". Measured on the first version: 262 units to climb 15, a
    // smoothstep with a mean grade of 5.3 %; on the second, 183 units, and a
    // deck that followed the land so it never looked level.
    for (const standalone of [true, false]) {
      const { heights } = elevated(600, flatGround(), standalone);
      const shape = anatomy(heights);
      expect(shape.top).toBeGreaterThan(roadStructure('elevated').clearance - 0.1);
      expect(shape.rampA).toBeLessThanOrEqual(100);
      expect(shape.rampB).toBeLessThanOrEqual(100);
      expect(shape.deck).toBeGreaterThanOrEqual(0.6);
      expect(shape.steepest).toBeLessThan(0.162);
      // Level: the deck between the ramps is within the crest's rounding of
      // its height, and most of the span stands at that height.
      const deck = heights.slice(shape.deckFrom, shape.deckTo);
      expect(Math.max(...deck) - Math.min(...deck)).toBeLessThan(0.25);
      const top = Math.max(...heights);
      expect(heights.filter((h) => h > top - 0.25).length / heights.length).toBeGreaterThanOrEqual(0.6);
    }
  });

  it('keeps short ramps and a straight deck on rolling ground', () => {
    for (const standalone of [true, false]) {
      const { heights, span } = elevated(600, rolling, standalone);
      const shape = anatomy(heights);
      expect(shape.rampA).toBeLessThanOrEqual(100);
      expect(shape.rampB).toBeLessThanOrEqual(100);
      expect(shape.deck).toBeGreaterThanOrEqual(0.6);
      // A straight line from end to end: it does not follow the land.
      const from = shape.deckFrom;
      const to = shape.deckTo;
      for (let i = from; i <= to; i += 10) {
        const t = (i - from) / Math.max(1, to - from);
        const chord = (heights[from] as number) + ((heights[to] as number) - (heights[from] as number)) * t;
        expect(Math.abs((heights[i] as number) - chord)).toBeLessThan(0.3);
      }
      // ...and it still stands clear of the ground under it.
      for (let i = from; i <= to; i += 5) {
        expect((heights[i] as number) - rolling(-span / 2 + i, 0)).toBeGreaterThan(8);
      }
    }
  });

  it('climbs one clearance over its landing however low the landing sits', () => {
    // Landings sunk below the plain by 0, 4 and 8 units.
    const lengths: number[] = [];
    for (const depth of [0, 4, 8]) {
      const sunk = (x: number): number => -depth * Math.exp(-(((Math.abs(x) - 300) / 150) ** 2));
      const shape = anatomy(elevated(600, sunk).heights);
      expect(shape.steepest).toBeLessThan(0.162);
      lengths.push(shape.rampA);
    }
    // The deck starts one clearance over the junction it lands on and runs
    // straight to the other end, so a lower landing tilts the deck a little
    // rather than lengthening the ramp.
    for (const length of lengths) expect(length).toBeLessThanOrEqual(100);
  });

  it('lowers the deck of a span too short for two ramps, never steepens it', () => {
    const shape = anatomy(elevated(120, flatGround()).heights);
    expect(shape.steepest).toBeLessThan(0.162);
    expect(shape.top).toBeLessThan(roadStructure('elevated').clearance);
  });

  it('spans a valley level as a bridge, rim to rim', () => {
    const valley = (x: number): number => (Math.abs(x) < 180 ? -20 * (1 - Math.abs(x) / 180) : 0);
    const doc = new RoadDoc();
    const b = doc.addNode({ x: -350, y: 0 });
    const c = doc.addNode({ x: 350, y: 0 });
    doc.addSegment(doc.addNode({ x: -650, y: 0 }).id, b.id, 2);
    const span = doc.addSegment(b.id, c.id, 2)!;
    doc.addSegment(c.id, doc.addNode({ x: 650, y: 0 }).id, 2);
    doc.setSegmentStructure(span.id, 'bridge');
    const net = new Network(doc);
    net.rebuild();
    const field = buildRoadElevation(net, valley);
    expect(field.onSegment(span.id, 0, 0)).toBeGreaterThan(field.onSegment(span.id, -170, 0) - 0.1);
  });

  it('brings a raised road that simply ends down to the ground', () => {
    // A raised dead end used to stay at its full height: a deck ending in mid-air.
    const { field, b, c, span } = elevated(600, flatGround());
    expect(field.nodeHeight(b)).toBeCloseTo(ROAD_GROUND_CLEARANCE, 3);
    expect(field.nodeHeight(c)).toBeCloseTo(ROAD_GROUND_CLEARANCE, 3);
    expect(field.at(0, 0)).toBeGreaterThan(roadStructure('elevated').clearance - 0.1);
    expect(span).toBe(600);
  });

  it('stays continuous through the ramps and over the deck', () => {
    const { field } = elevated(600, rolling, false);
    let coarse = 0;
    let fine = 0;
    for (let x = -400; x <= 400; x += 2) {
      coarse = Math.max(coarse, Math.abs(field.at(x + 2, 0) - field.at(x, 0)));
      fine = Math.max(fine, Math.abs(field.at(x + 0.5, 0) - field.at(x, 0)));
    }
    expect(fine / coarse).toBeLessThan(0.4);
  });
});

describe('where a leg meets its junction plate', () => {
  /** Broken ground: three waves, ±19 units, the kind a few brush strokes leave. */
  const hilly = (x: number, y: number): number =>
    9 * Math.sin(x / 140) + 6 * Math.sin((x - y) / 70) + 4 * Math.cos(y / 55);

  type Layout = 'all-elevated' | 'elevated-over-ground' | 'elevated-landing-on-streets';

  /**
   * A crossroads whose four arms are CHAINS of `count` segments of `length`:
   * a boulevard north-south, `typeEW` east-west. A chain is what a player
   * draws - a road is rarely one segment - and it is what the regression
   * needed: the lift a deck takes over a rise travels one node along the
   * chain per round of the solve, and after the third round it simply stopped,
   * leaving a plate up to two units above the node its junction was solved at.
   */
  function crossroads(typeEW: number, count: number, length: number, layout: Layout) {
    const doc = new RoadDoc();
    const centre = doc.addNode({ x: 0, y: 0 });
    const arms = [[0, -1], [1, 0], [0, 1], [-1, 0]] as const;
    arms.forEach(([dx, dy], arm) => {
      let previous = centre;
      for (let k = 1; k <= count; k++) {
        const node = doc.addNode({ x: dx * length * k, y: dy * length * k });
        const segment = doc.addSegment(previous.id, node.id, arm % 2 === 0 ? 3 : typeEW);
        if (!segment) throw new Error('the fixture failed to build a segment');
        const raised = layout === 'all-elevated' ||
          (layout === 'elevated-over-ground' && arm % 2 === 0) ||
          (layout === 'elevated-landing-on-streets' && k < count);
        if (raised) doc.setSegmentStructure(segment.id, 'elevated');
        previous = node;
      }
    });
    const net = new Network(doc);
    net.rebuild();
    return { doc, net };
  }

  /**
   * The worst height difference across every seam between a leg and the
   * junction plate it ends on: at the junction outline (the casing trim),
   * half a unit either side of it, at five points across the carriageway, and
   * against the one height the node has.
   */
  function worstSeam(doc: RoadDoc, net: Network, field: RoadElevation): number {
    let worst = 0;
    for (const [id, ribbon] of net.ribbons) {
      const segment = doc.segment(id);
      const trims = net.trims.get(id);
      if (!segment || !trims) continue;
      const line = ribbon.full;
      const only = new Set([segment.structure]);
      const half = ribbon.road.width / 2;
      for (const end of ['a', 'b'] as const) {
        const node = end === 'a' ? segment.a : segment.b;
        const trim = trims[end][Level.Casing] ?? 0;
        const plate = field.nodeHeight(node);
        // Where only the structure changes on one road (a ramp landing) the
        // node is a seam, not a plate: the grade runs on through it, so the
        // deck is measured against the road it continues, point for point.
        const seam = net.transitions.has(node);
        for (const delta of [-0.5, 0, 0.5]) {
          const reach = Math.min(line.length, Math.max(0, trim + delta));
          const s = end === 'a' ? reach : line.length - reach;
          const frame = line.sampleAt(s);
          const road = field.onSegment(id, frame.p.x, frame.p.y);
          worst = Math.max(worst, Math.abs(road - (seam ? road : plate)));
          for (const across of [-0.9, -0.45, 0, 0.45, 0.9]) {
            const x = frame.p.x + frame.n.x * half * across;
            const y = frame.p.y + frame.n.y * half * across;
            worst = Math.max(worst, Math.abs(field.at(x, y, only) - (seam ? road : plate)));
          }
        }
        if (seam) {
          // ...and the two roads meet at the node at one height: no step.
          const n = doc.node(node)!;
          for (const other of n.incident) {
            if (other === id) continue;
            worst = Math.max(worst, Math.abs(field.onSegment(id, n.x, n.y) - field.onSegment(other, n.x, n.y)));
          }
        }
      }
    }
    return worst;
  }

  const cases: Array<[string, (x: number, y: number) => number]> = [['flat', flatGround()], ['hilly', hilly]];
  for (const [ground, terrain] of cases) {
    for (const [name, typeEW] of [['boulevards', 3], ['a boulevard and an avenue', 2]] as const) {
      for (const layout of ['all-elevated', 'elevated-over-ground', 'elevated-landing-on-streets'] as const) {
        it(`meets it exactly: ${name}, ${layout}, ${ground} ground`, () => {
          for (const [count, length] of [[3, 150], [2, 200]] as const) {
            const { doc, net } = crossroads(typeEW, count, length, layout);
            const field = buildRoadElevation(net, terrain);
            // Invariant 3: the plate is flat and every leg is flat over its
            // reach at the SAME height. Measured before this was fixed: 1.94
            // units on hilly ground.
            expect(worstSeam(doc, net, field)).toBeLessThan(1e-3);
          }
        });
      }
    }
  }

  it('stays continuous over an elevated crossroads on broken ground', () => {
    for (const layout of ['all-elevated', 'elevated-over-ground'] as const) {
      const { net } = crossroads(2, 3, 150, layout);
      const field = buildRoadElevation(net, hilly);
      expect(continuityRatio(field, 200)).toBeLessThan(0.4);
    }
  });
});

describe('tunnels', () => {
  /** A straight road driven through the middle of a hill. */
  function throughHill(structure: 'ground' | 'tunnel', length = 900) {
    const doc = new RoadDoc();
    const a = doc.addNode({ x: -length / 2, y: 0 });
    const b = doc.addNode({ x: length / 2, y: 0 });
    const segment = doc.addSegment(a.id, b.id, 2);
    if (!segment) throw new Error('the fixture failed to build its segment');
    doc.setSegmentStructure(segment.id, structure);
    const net = new Network(doc);
    net.rebuild();
    const ground = hill(0, 0, 320, 40);
    return { doc, net, ground, field: buildRoadElevation(net, ground), a: a.id, b: b.id };
  }

  it('dives under the hill it passes through', () => {
    const { field, ground } = throughHill('tunnel');
    const cover = ground(0, 0) - field.at(0, 0);
    expect(cover).toBeGreaterThan(TUNNEL_BORE);
  });

  it('meets the ground at both portals', () => {
    // The ends are where a tunnel joins the street network, so they must be at
    // grade. A tunnel solved as one sunken slab left a cliff at each end.
    const { field, a, b, ground } = throughHill('tunnel');
    for (const node of [a, b]) {
      const height = field.nodeHeight(node);
      const x = node === a ? -450 : 450;
      expect(Math.abs(height - (ground(x, 0) + ROAD_GROUND_CLEARANCE))).toBeLessThan(1.5);
    }
  });

  it('is solved quite differently from the same road at grade', () => {
    // A road at grade cuts into the crest by a few units; a tunnel goes under
    // it by its whole design depth. The gap between the two is the guarantee
    // that `solveSunken` is doing something a shallow cut could not.
    const bored = throughHill('tunnel');
    const surface = throughHill('ground');
    const crest = surface.ground(0, 0);
    expect(surface.field.at(0, 0)).toBeGreaterThan(crest - 8);
    expect(bored.field.at(0, 0)).toBeLessThan(surface.field.at(0, 0) - 20);
  });

  it('stays continuous along its whole length', () => {
    // A step in the field is a crack in the mesh, and the sunken solver is a
    // second place a discontinuity could be introduced.
    const { field } = throughHill('tunnel');
    let worst = 0;
    for (let x = -600; x <= 600; x += 2) {
      worst = Math.max(worst, Math.abs(field.at(x + 2, 0) - field.at(x, 0)));
    }
    expect(worst).toBeLessThan(2 * TUNNEL_GRADE * 2.5);
  });

  it('gets less deep as the span gets shorter', () => {
    // Honest failure, stated as a monotone property rather than as a threshold:
    // the ramps have to fit, so a span that cannot hold them at the design
    // gradient has its floor raised until they do, and the terrain shaper then
    // leaves a shallow trench open instead of closing a hill over a road that is
    // barely below it. Where exactly the crossover falls depends on how deeply
    // the approach cutting has already taken the road down, which is a property
    // of the ground, not of the tunnel.
    const long = throughHill('tunnel', 900);
    const short = throughHill('tunnel', 180);
    const shorter = throughHill('tunnel', 90);
    const cover = (t: ReturnType<typeof throughHill>): number => t.ground(0, 0) - t.field.at(0, 0);
    expect(cover(long)).toBeGreaterThan(cover(short));
    expect(cover(short)).toBeGreaterThan(cover(shorter));
    expect(cover(shorter)).toBeLessThan(TUNNEL_BORE);
  });

  it('leaves the ground shaper intact over the bore and open at the mouth', () => {
    const { field, ground } = throughHill('tunnel');
    const deep = field.shapeAt(0, 0, ground(0, 0));
    expect(deep.weight).toBeLessThan(0.01);
    const mouth = field.shapeAt(-430, 0, ground(-430, 0));
    expect(mouth.weight).toBeGreaterThan(0.5);
  });
});
