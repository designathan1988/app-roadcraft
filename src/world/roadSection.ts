/** Authored symmetric road section. Widths use world units; sidewalk includes the kerb. */
export interface RoadSection {
  readonly laneWidth: number;
  readonly sidewalk: number;
  readonly median: number;
  readonly speedKmh: number;
  readonly priority: number;
}

/** Physical edit bounds, shared by persistence and the section editor. */
export const ROAD_SECTION_LIMITS = {
  laneWidth: [5, 15],
  sidewalk: [1.2, 30],
  median: [0, 20],
  speedKmh: [10, 130],
  priority: [0, 5],
} as const;

/** Rejects incomplete/non-finite input; clamps finite values at the document boundary. */
export function normalizeRoadSection(raw: unknown): RoadSection | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  const result = {} as { -readonly [K in keyof RoadSection]: number };
  for (const key of Object.keys(ROAD_SECTION_LIMITS) as (keyof RoadSection)[]) {
    const number = value[key];
    if (typeof number !== 'number' || !Number.isFinite(number)) return undefined;
    const [min, max] = ROAD_SECTION_LIMITS[key];
    result[key] = Math.max(min, Math.min(max, key === 'priority' ? Math.round(number) : number));
  }
  return result;
}

export function sameRoadSection(a: RoadSection | undefined, b: RoadSection | undefined): boolean {
  if (!a || !b) return a === b;
  return (Object.keys(ROAD_SECTION_LIMITS) as (keyof RoadSection)[]).every((key) => a[key] === b[key]);
}
