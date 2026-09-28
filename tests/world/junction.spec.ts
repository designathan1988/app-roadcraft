import { describe, expect, it } from 'vitest';

import { RoadDoc } from '@world/doc';
import { PolylineCache } from '@world/geometry';
import { buildJunction, surfaceMode } from '@world/junction/build';
import { Level, ROAD_TYPES, SURFACE_LEVELS } from '@world/roadTypes';
import { Network } from '@world/network';
import { isSimple } from '@core/polygon';
import type { NodeId } from '@world/ids';

/**
 * The junction builder had no test file at all.
 *
 * Several comments in `src/world/junction/` cite measurements from a fuzz
 * sweep, a `trim-equality` spec and a `probe-tongues.mjs` script — none of
 * which exist in the repository. Every claim in them was therefore
 * unverifiable, and two critical defects lived in that blind spot:
 *
 *   1. `buildLegs` consumed its trim guesses in SEGMENT-ID order and returned
 *      the legs in ANGLE order, so each refinement pass framed every leg at
 *      another leg's trim distance.
 *   2. The parallel-boundary test could not tell a straight road (psi near PI)
 *      from a hairpin fork (psi near 0) and gave both a ZERO setback, so two
 *      legs three degrees apart had completely overlapping carriageways.
 *
 * These are properties rather than examples: a property keeps holding when the
 * numbers move, and neither defect above is visible in any single case.
 */

const DEG = Math.PI / 180;
/** Far enough that the trim solver is never the thing under length pressure. */
const ARM = 420;

interface Arm {
  /** Outgoing bearing from the centre node, in degrees. */
  readonly deg: number;
  /** Index into ROAD_TYPES. */
  readonly type?: number;
}

/** A node with one arm per bearing. */
function junctionAt(arms: readonly Arm[]): {
  doc: RoadDoc;
  cache: PolylineCache;
  centre: NodeId;
} {
  const doc = new RoadDoc();
  const centre = doc.addNode({ x: 0, y: 0 });
  for (const arm of arms) {
    const far = doc.addNode({
      x: Math.cos(arm.deg * DEG) * ARM,
      y: Math.sin(arm.deg * DEG) * ARM,
    });
    doc.addSegment(centre.id, far.id, arm.type ?? 3);
  }
  return { doc, cache: new PolylineCache(), centre: centre.id };
}

/** Casing, sidewalk, curb, asphalt — the four levels that carry a surface. */
const LEVELS = SURFACE_LEVELS;

/**
 * Smallest gap between any two bearings, in degrees.
 *
 * The sweeps below only assert over shapes the editor would actually let a
 * player build. Under `MIN_LEG_ANGLE` the builder degrades on purpose — a map
 * may still contain such a node, from a file or an undo, and refusing to draw
 * it would destroy the player's work — so asserting a clean ring there would
 * be asserting against a documented decision rather than against a defect.
 */
const smallestGapDeg = (bearings: readonly number[]): number => {
  const sorted = [...bearings].map((d) => ((d % 360) + 360) % 360).sort((p, q) => p - q);
  let smallest = 360;
  for (let i = 0; i < sorted.length; i++) {
    const here = sorted[i] as number;
    const next = i + 1 < sorted.length ? (sorted[i + 1] as number) : (sorted[0] as number) + 360;
    smallest = Math.min(smallest, next - here);
  }
  return smallest;
};

/** Matches MIN_LEG_ANGLE in src/world/legAngles.ts. */
const MIN_GAP_DEG = 25;

describe('junction geometry', () => {
  describe('the ring is a simple polygon', () => {
    // A self-intersecting ring is what a "defective crossing" looks like on
    // screen: the boundary folds through itself and the clipper either drops
    // the shape or paints the slivers that fan across the asphalt.
    it('never self-intersects over a full sweep of the fourth leg', () => {
      const failures: string[] = [];

      for (let bearing = 5; bearing < 360; bearing += 5) {
        // Three fixed legs plus one swept leg, so the swept leg passes through
        // every relationship with each of them.
        if (smallestGapDeg([0, 120, 240, bearing]) < MIN_GAP_DEG) continue;
        const { doc, cache, centre } = junctionAt([
          { deg: 0 },
          { deg: 120 },
          { deg: 240 },
          { deg: bearing },
        ]);

        for (const level of LEVELS) {
          const junction = buildJunction(doc, cache, centre, level);
          if (!junction) {
            failures.push(`bearing ${bearing} level ${level}: no junction built`);
            continue;
          }
          if (junction.rings.length === 0) {
            // Shallow merges are covered by the union of their road ribbons.
            expect(junction.ring.isEmpty).toBe(true);
            continue;
          }
          const flat = junction.ring.flatten();
          if (flat.length < 3) {
            failures.push(`bearing ${bearing} level ${level}: degenerate ring`);
            continue;
          }
          if (!isSimple(flat)) {
            failures.push(`bearing ${bearing} level ${level}: ring self-intersects`);
          }
        }
      }

      expect(failures).toEqual([]);
    });

    it('never falls back to a convex hull on a well-formed sweep', () => {
      // The hull fallback is the builder admitting it could not trace the
      // boundary. It may exist, but it must not be how ordinary junctions are
      // drawn — and on collinear mouths it can emit an EMPTY ring, which
      // draws nothing whatsoever.
      const fellBack: number[] = [];
      for (let bearing = 30; bearing <= 330; bearing += 5) {
        if (smallestGapDeg([0, 150, bearing]) < MIN_GAP_DEG) continue;
        const { doc, cache, centre } = junctionAt([{ deg: 0 }, { deg: 150 }, { deg: bearing }]);
        const junction = buildJunction(doc, cache, centre, Level.Asphalt);
        if (junction?.usedHullFallback) fellBack.push(bearing);
      }
      expect(fellBack).toEqual([]);
    });
  });

  describe('the trim is a continuous function of the leg angle', () => {
    /**
     * The test that actually distinguishes a smooth solver from a cliff.
     *
     * A continuous function's worst jump between neighbouring samples shrinks
     * in proportion to the sampling step; a function with a step keeps the
     * same jump however finely it is sampled. So sweep, halve the step, sweep
     * again, and require the jump to come down with it.
     *
     * Same technique as `tests/world/elevation.spec.ts`, and it is what
     * catches the defect where 2.99 degrees gave a trim of 0 and 3.01 gave 428.
     */
    const worstJumpOver = (from: number, to: number, step: number): number => {
      let previous: number | null = null;
      let worst = 0;
      for (let bearing = from; bearing <= to + 1e-9; bearing += step) {
        const { doc, cache, centre } = junctionAt([{ deg: 0 }, { deg: bearing }]);
        const junction = buildJunction(doc, cache, centre, Level.Asphalt);
        const total = junction ? junction.trims.reduce((sum, t) => sum + t, 0) : 0;
        if (previous !== null) worst = Math.max(worst, Math.abs(total - previous));
        previous = total;
      }
      return worst;
    };

    it('has no cliff across the parallel-boundary threshold', () => {
      // SIN_EPS is 3 degrees: the band where `lineLine` stops finding a
      // crossing. Both sides of it have to agree.
      const coarse = worstJumpOver(1, 8, 0.5);
      const fine = worstJumpOver(1, 8, 0.25);
      expect(fine).toBeLessThan(coarse * 0.75 + 1);
    });

    it('has no cliff across the straight-through threshold', () => {
      const coarse = worstJumpOver(172, 179, 0.5);
      const fine = worstJumpOver(172, 179, 0.25);
      expect(fine).toBeLessThan(coarse * 0.75 + 1);
    });
  });

  describe('a hairpin fork is separated, not collapsed', () => {
    it('gives two nearly-parallel legs a real setback', () => {
      // Two legs 2 degrees apart overlap almost completely, so a zero trim
      // puts each mouth deep inside the other's carriageway. This is the
      // shape that used to be classified as "collinear".
      const { doc, cache, centre } = junctionAt([{ deg: 0 }, { deg: 2 }]);
      const junction = buildJunction(doc, cache, centre, Level.Asphalt);

      expect(junction).not.toBeNull();
      const widest = Math.max(...(junction?.legs.map((l) => l.hw) ?? [0]));
      for (const trim of junction?.trims ?? []) {
        expect(trim).toBeGreaterThan(widest);
      }
    });

    it('still gives a straight road through the node no setback at all', () => {
      // The other side of the same test: two legs 180 degrees apart of equal
      // width are one road, and one road needs no junction setback.
      const { doc, cache, centre } = junctionAt([{ deg: 0 }, { deg: 180 }]);
      const junction = buildJunction(doc, cache, centre, Level.Asphalt);
      for (const trim of junction?.trims ?? []) {
        expect(trim).toBeLessThan(1);
      }
    });
  });

  describe('trims stay inside the road they are cut from', () => {
    /**
     * Note what is NOT asserted here.
     *
     * A raw junction trim may legitimately exceed its own leg: a shallow fork
     * really does need a long gore, and `corners.ts` says so explicitly. The
     * bound that actually has to hold is applied globally, by
     * `Network.reconcile`, after both ends of a segment have bid for it. So
     * the property is measured on the reconciled network, not on the solver's
     * intermediate answer.
     */
    it('always leaves a drivable ribbon once the network has reconciled', () => {
      const offenders: string[] = [];
      for (let bearing = 10; bearing <= 350; bearing += 10) {
        if (bearing === 200) continue; // would duplicate the third arm exactly
        const doc = new RoadDoc();
        const centre = doc.addNode({ x: 0, y: 0 });
        for (const arm of [
          { deg: 0, type: 0 },
          { deg: bearing, type: 3 },
          { deg: 200, type: 1 },
        ]) {
          const far = doc.addNode({
            x: Math.cos(arm.deg * DEG) * ARM,
            y: Math.sin(arm.deg * DEG) * ARM,
          });
          doc.addSegment(centre.id, far.id, arm.type);
        }
        const net = new Network(doc);
        net.rebuild();

        for (const segment of doc.segments.values()) {
          const ribbon = net.ribbons.get(segment.id);
          if (!ribbon) {
            offenders.push(`bearing ${bearing} seg ${segment.id}: no ribbon`);
            continue;
          }
          for (const level of LEVELS) {
            const centreline = ribbon.centre[level];
            if (!centreline || centreline.length <= 0) {
              offenders.push(`bearing ${bearing} seg ${segment.id} level ${level}: empty ribbon`);
            }
          }
        }
      }
      expect(offenders).toEqual([]);
    });

    it('keeps a ribbon on every segment of a tightly-spaced grid', () => {
      // The whole-network guarantee as opposed to the per-junction one: two
      // junctions pulling on the same short segment must still leave road
      // between them.
      const doc = new RoadDoc();
      const a = doc.addNode({ x: -70, y: 0 });
      const b = doc.addNode({ x: 0, y: 0 });
      const c = doc.addNode({ x: 70, y: 0 });
      const bNorth = doc.addNode({ x: 0, y: -200 });
      const cNorth = doc.addNode({ x: 70, y: -200 });
      const aSouth = doc.addNode({ x: -70, y: 200 });
      doc.addSegment(a.id, b.id, 3);
      doc.addSegment(b.id, c.id, 3);
      doc.addSegment(b.id, bNorth.id, 3);
      doc.addSegment(c.id, cNorth.id, 3);
      doc.addSegment(a.id, aSouth.id, 3);

      const net = new Network(doc);
      net.rebuild();

      for (const segment of doc.segments.values()) {
        const ribbon = net.ribbons.get(segment.id);
        expect(ribbon).toBeDefined();
        expect(ribbon?.centre[Level.Asphalt]?.length ?? 0).toBeGreaterThan(0);
      }
    });
  });

  describe('legs are solved by identity, not by position', () => {
    /**
     * The regression guard for the leg-index defect.
     *
     * `buildLegs` returns legs sorted by angle while the document lists them
     * by segment id. If anything downstream still pairs those two orders
     * positionally, then relabelling the SAME geometry — building the very
     * same arms in a different creation order — changes the answer.
     *
     * Geometry does not depend on the order the player drew things in.
     */
    const solveStraight = (order: readonly number[]): number[] => {
      const bearings = [0, 95, 190, 285];
      const doc = new RoadDoc();
      const centre = doc.addNode({ x: 0, y: 0 });
      for (const index of order) {
        const deg = bearings[index] as number;
        const far = doc.addNode({
          x: Math.cos(deg * DEG) * ARM,
          y: Math.sin(deg * DEG) * ARM,
        });
        doc.addSegment(centre.id, far.id, 3);
      }
      const junction = buildJunction(doc, new PolylineCache(), centre.id, Level.Asphalt);
      // Keyed by each leg's own bearing so the two runs are comparable
      // regardless of the order the builder happened to emit them in.
      return (junction?.legs ?? [])
        .map((leg, i) => ({ ang: leg.ang, trim: junction?.trims[i] ?? 0 }))
        .sort((p, q) => p.ang - q.ang)
        .map((entry) => Number(entry.trim.toFixed(6)));
    };

    it('gives the same geometry whatever order the arms were drawn in', () => {
      const drawn = solveStraight([0, 1, 2, 3]);
      expect(drawn.length).toBe(4);
      expect(solveStraight([2, 0, 3, 1])).toEqual(drawn);
      expect(solveStraight([3, 2, 1, 0])).toEqual(drawn);
    });

    it('is stable for curved legs too, where the refinement pass actually bites', () => {
      // The refinement loop exists for curves: the mouth must be cut
      // perpendicular to the tangent AT the trim distance. That is the pass
      // that was consuming mis-indexed trims.
      const specs = [
        { deg: 0, curve: 40 },
        { deg: 100, curve: -55 },
        { deg: 215, curve: 25 },
      ];
      const solve = (order: readonly number[]): number[] => {
        const doc = new RoadDoc();
        const centre = doc.addNode({ x: 0, y: 0 });
        for (const index of order) {
          const spec = specs[index] as { deg: number; curve: number };
          const far = doc.addNode({
            x: Math.cos(spec.deg * DEG) * ARM,
            y: Math.sin(spec.deg * DEG) * ARM,
          });
          const segment = doc.addSegment(centre.id, far.id, 3);
          if (segment) doc.setSegmentCurve(segment.id, { t: 0.5, h: spec.curve });
        }
        const junction = buildJunction(doc, new PolylineCache(), centre.id, Level.Asphalt);
        return (junction?.legs ?? [])
          .map((leg, i) => ({ ang: leg.ang, trim: junction?.trims[i] ?? 0 }))
          .sort((p, q) => p.ang - q.ang)
          .map((entry) => Number(entry.trim.toFixed(6)));
      };

      const base = solve([0, 1, 2]);
      expect(base.length).toBe(3);
      expect(solve([1, 2, 0])).toEqual(base);
      expect(solve([2, 1, 0])).toEqual(base);
    });
  });

  describe('a width step is tapered, not butt-jointed', () => {
    it('classifies a degree-2 node between different lane counts as a junction', () => {
      // `surfaceMode` compared only the road CLASS, but width comes from
      // class, lane count and direction together. Two segments of one class
      // with very different lane counts were merged into a single render
      // chain, so a large width step was drawn as a butt joint with no taper.
      const doc = new RoadDoc();
      const a = doc.addNode({ x: -ARM, y: 0 });
      const b = doc.addNode({ x: 0, y: 0 });
      const c = doc.addNode({ x: ARM, y: 0 });
      const narrow = doc.addSegment(a.id, b.id, 1);
      const wide = doc.addSegment(b.id, c.id, 1);
      expect(narrow).not.toBeNull();
      expect(wide).not.toBeNull();
      if (narrow) doc.setSegmentLanes(narrow.id, 2);
      if (wide) doc.setSegmentLanes(wide.id, 8);

      expect(surfaceMode(doc, new PolylineCache(), b.id)).toBe('junction');
    });
  });

  describe('every road class solves', () => {
    it('builds a finite ring for every class pair at a range of angles', () => {
      const bad: string[] = [];
      for (let left = 0; left < ROAD_TYPES.length; left++) {
        for (let right = 0; right < ROAD_TYPES.length; right++) {
          for (const bearing of [35, 70, 90, 145, 175]) {
            const { doc, cache, centre } = junctionAt([
              { deg: 0, type: left },
              { deg: bearing, type: right },
            ]);
            const junction = buildJunction(doc, cache, centre, Level.Asphalt);
            if (!junction) {
              bad.push(`${left}/${right} @${bearing}: null`);
              continue;
            }
            for (const point of junction.ring.flatten()) {
              if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
                bad.push(`${left}/${right} @${bearing}: non-finite vertex`);
                break;
              }
            }
            for (const trim of junction.trims) {
              if (!Number.isFinite(trim)) {
                bad.push(`${left}/${right} @${bearing}: non-finite trim`);
              }
            }
          }
        }
      }
      expect(bad).toEqual([]);
    });
  });
});
