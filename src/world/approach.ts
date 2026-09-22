/**
 * The approach zone: what sits between a road and a junction mouth.
 *
 * Measured as distance from the junction NODE, the layout an approaching driver
 * meets is, in order:
 *
 *     stop line          trim + setback + depth + barSetback
 *     crosswalk          trim + setback + depth/2
 *     junction mouth     trim
 *
 * All three derive from the SAME `trim` that the junction polygon and the road
 * ribbon use, so they cannot drift apart. Everything that needs one of these
 * distances — the lanelet builder, the sidewalk graph, the painter — imports it
 * from here.
 *
 * Getting this order wrong is not cosmetic. If the stop line coincides with the
 * junction mouth there is no room for a crossing in front of it, and any kerb
 * placed for that crossing lands inside the carriageway.
 */

/** Clear space between the junction mouth and the near edge of the zebra. */
export const CROSSWALK_SETBACK = 3.0;
/** Depth of the zebra along the direction of travel. */
export const CROSSWALK_DEPTH = 4.4;
/** Clear space between the far edge of the zebra and the stop line. */
export const STOP_BAR_SETBACK = 1.6;
/** Painted width of the stop bar itself. */
export const STOP_BAR_WIDTH = 1.0;

/** Distance from the node to the centre of the crossing. */
export const crosswalkDistance = (trim: number): number =>
  trim + CROSSWALK_SETBACK + CROSSWALK_DEPTH / 2;

/** Distance from the node to the stop line, i.e. the end of a link lanelet. */
export const stopLineDistance = (trim: number): number =>
  trim + CROSSWALK_SETBACK + CROSSWALK_DEPTH + STOP_BAR_SETBACK;

/** How much further back than the junction mouth the approach zone reaches. */
export const APPROACH_DEPTH =
  CROSSWALK_SETBACK + CROSSWALK_DEPTH + STOP_BAR_SETBACK;

/**
 * Drivable length every link must retain between two approach zones.
 *
 * This is a GEOMETRIC constraint expressing a simulation requirement: a link
 * has to hold the longest vehicle plus its standstill gap, or a queue can never
 * discharge into it and the network wedges — the failure mode that made the V6
 * monolith deadlock on short blocks (defect 2.2).
 *
 * When a segment is too short to give both junctions the trim they want AND
 * keep this much drivable road, the junctions are shrunk rather than the link.
 * A visually tight junction is a cosmetic compromise; a link that cannot hold a
 * vehicle is a functional dead end.
 *
 * A test asserts this stays at or above the simulation's own `L_MIN`, so the
 * two definitions cannot drift apart.
 */
export const MIN_LINK_LENGTH = 36;

/** Total length a segment must reserve for drivable road plus both approaches. */
export const MIN_DRIVABLE_RESERVE = MIN_LINK_LENGTH + 2 * APPROACH_DEPTH;

/**
 * The fractional caps that stop one end of a segment eating the whole thing.
 *
 * They are named, and they live here beside the distances they cap, because
 * bare fractions scattered across the geometry are exactly how this engine's
 * worst defect class arrives. `0.48` and `0.86` are the same literals the V6
 * monolith used in its two competing trim formulas — see the header of
 * `junction/trim.ts` — and an unnamed `0.45` in `lanelets.ts` silently undid
 * the stop-line ordering that `network.ts` had just guaranteed.
 *
 * If you find yourself writing `length * 0.4x` somewhere new, the question to
 * answer first is which of these you meant.
 */

/** Ceiling on one leg's own trim guess, before the solver reconciles legs. */
export const LEG_TRIM_CAP = 0.48;

/** Ceiling on the drivable reserve a short segment is asked to keep. */
export const RESERVE_CAP = 0.86;

/** Ceiling on the stop line's distance from a node. */
export const STOP_LINE_CAP = 0.45;

/** Ceiling on the crossing's distance from a node. */
export const CROSSWALK_CAP = 0.49;
