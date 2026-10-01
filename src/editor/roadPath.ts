import { shapeFromControl, type CurveShape } from '@core/bezier';
import { type Vec2, dist } from '@core/vec2';

/** An authored point. Heights are offsets from the designed ground in world units. */
export interface RoadPathPoint {
  readonly at: Vec2;
  readonly heightOffset: number;
}

/** One quadratic in a continuous road gesture. Neighbouring pieces share an end. */
export interface RoadPathPiece {
  readonly start: RoadPathPoint;
  readonly end: RoadPathPoint;
  readonly curve: CurveShape | null;
}

const MIN_CONTROL_SPACING = 18;
const MAX_CONTROLS = 48;

const midpoint = (a: RoadPathPoint, b: RoadPathPoint): RoadPathPoint => ({
  at: { x: (a.at.x + b.at.x) / 2, y: (a.at.y + b.at.y) / 2 },
  heightOffset: (a.heightOffset + b.heightOffset) / 2,
});

function distanceToChord(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length2 = dx * dx + dy * dy;
  if (length2 < 1e-9) return dist(p, a);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / length2));
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
}

/** Keeps the path's turns and every requested height change without storing pointer noise. */
function simplify(points: readonly RoadPathPoint[], tolerance: number): RoadPathPoint[] {
  const keep = new Set<number>([0, points.length - 1]);
  const visit = (from: number, to: number): void => {
    if (to - from < 2) return;
    let best = -1;
    let error = tolerance;
    const a = points[from] as RoadPathPoint;
    const b = points[to] as RoadPathPoint;
    for (let i = from + 1; i < to; i++) {
      const p = points[i] as RoadPathPoint;
      const xy = distanceToChord(p.at, a.at, b.at);
      const fraction = dist(a.at, p.at) / Math.max(1e-6, dist(a.at, b.at));
      const expectedHeight = a.heightOffset + (b.heightOffset - a.heightOffset) * fraction;
      const vertical = Math.abs(p.heightOffset - expectedHeight) * 4;
      const candidate = Math.max(xy, vertical);
      if (candidate > error) {
        error = candidate;
        best = i;
      }
    }
    if (best >= 0) {
      keep.add(best);
      visit(from, best);
      visit(best, to);
    }
  };
  visit(0, points.length - 1);
  return [...keep].sort((a, b) => a - b).map((i) => points[i] as RoadPathPoint);
}

/**
 * Converts a freehand gesture into a chain of tangent-continuous quadratics.
 * A straight gesture stays one exact line. Interior gesture points act as
 * quadratic controls; adjacent pieces meet at their shared control midpoint,
 * where both tangents have the same direction.
 */
export function roadPathFromGesture(
  samples: readonly RoadPathPoint[],
  start: RoadPathPoint,
  end: RoadPathPoint,
): RoadPathPiece[] {
  if (dist(start.at, end.at) < 1e-6 &&
    samples.reduce((sum, sample, i) =>
      i === 0 ? 0 : sum + dist(sample.at, samples[i - 1]!.at), 0) < MIN_CONTROL_SPACING * 2) return [];
  const raw: RoadPathPoint[] = [start];
  for (const sample of samples) {
    const previous = raw[raw.length - 1] as RoadPathPoint;
    if (dist(previous.at, sample.at) >= MIN_CONTROL_SPACING) raw.push(sample);
    else if (raw.length > 1 && Math.abs(previous.heightOffset - sample.heightOffset) >= 0.5) {
      // A height changed where the stroke stood (Page Up/Down mid-drag): the
      // last control takes it. Pushed as a point of its own, a few units on,
      // it made a piece too short to be a road, and the road had a gap there.
      raw[raw.length - 1] = { at: previous.at, heightOffset: sample.heightOffset };
    }
  }
  if (dist((raw[raw.length - 1] as RoadPathPoint).at, end.at) < MIN_CONTROL_SPACING) raw.pop();
  raw.push(end);

  let tolerance = 5;
  let controls = simplify(raw, tolerance);
  while (controls.length > MAX_CONTROLS) {
    tolerance *= 1.5;
    controls = simplify(raw, tolerance);
  }
  if (controls.length === 2) return [{ start, end, curve: null }];

  const pieces: RoadPathPiece[] = [];
  let from = start;
  for (let i = 1; i < controls.length - 1; i++) {
    const control = controls[i] as RoadPathPoint;
    const to = i === controls.length - 2
      ? end
      : midpoint(control, controls[i + 1] as RoadPathPoint);
    if (dist(from.at, to.at) >= 1e-6) {
      pieces.push({ start: from, end: to, curve: shapeFromControl(from.at, to.at, control.at) });
    }
    from = to;
  }
  return pieces;
}
