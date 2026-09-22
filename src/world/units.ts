/**
 * The engine has exactly ONE unit system: the world unit.
 *
 * The V6 monolith mixed scales inside single expressions — a "sedan" of 9.6
 * against road widths of 15..46 and speeds of 28..54 — which is how the
 * downstream-storage formula came out negative for any block under ~32 units
 * (defect 2.2 of RELATORIO.md). Nothing in `src/world` or `src/sim` may convert
 * units; the constant below exists so that *derived* constants can be written
 * from real-world figures and checked, not so that runtime code can convert.
 *
 * Calibration: road widths are preserved from V6 (15/22/34/46), and
 * `METERS_PER_UNIT` is chosen so those read as real carriageways:
 *
 *   local      15 u =  6.0 m  ->  2 lanes @ 3.0 m
 *   street     22 u =  8.8 m  ->  2 lanes @ 4.4 m
 *   avenue     34 u = 13.6 m  ->  4 lanes @ 3.4 m
 *   boulevard  46 u = 18.4 m  ->  4 lanes @ 4.0 m + 2.4 m median
 */
export const METERS_PER_UNIT = 0.4;
export const UNITS_PER_METER = 1 / METERS_PER_UNIT;

/** Converts a real-world metre figure into world units. Build-time only. */
export const m = (metres: number): number => metres * UNITS_PER_METER;

/** Converts a km/h figure into world units per second. Build-time only. */
export const kmh = (kmPerHour: number): number => m((kmPerHour * 1000) / 3600);
