import { EPS } from './scalar';

/**
 * 2D vector helpers.
 *
 * Convention, fixed once and never fought: the world is a **right-handed frame
 * that renders +Y UP**. The renderer maps `(x, y)` to three's `(x, h, -y)`, so
 * projecting `(0, 100)` lands above the origin on screen, not below it.
 *
 * `perp(v)` returns `(-v.y, v.x)`: a quarter turn counter-clockwise, which is
 * the **left** of `v` when facing along `v`. Every normal in this codebase is
 * that one, and every consequence follows from it — traffic keeps to `-perp`
 * because that is the right-hand side, signal heads stand on `-perp` because
 * that is the right-hand kerb, and a positive heading change is a left turn.
 *
 * This note used to say +Y was down. It was wrong, and `classifyTurn` was
 * written to match it, which mirrored every left and right turn in the
 * simulation. Rings are wound so that signed area is positive
 * (`POSITIVE_AREA`), which with Y up reads visually counter-clockwise.
 */
export interface Vec2 {
  readonly x: number;
  readonly y: number;
}

export const vec = (x: number, y: number): Vec2 => ({ x, y });
export const ZERO: Vec2 = { x: 0, y: 0 };

export const add = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y });
export const scale = (a: Vec2, k: number): Vec2 => ({ x: a.x * k, y: a.y * k });
export const neg = (a: Vec2): Vec2 => ({ x: -a.x, y: -a.y });

export const dot = (a: Vec2, b: Vec2): number => a.x * b.x + a.y * b.y;
/** Scalar cross product (z component of the 3D cross). */
export const cross = (a: Vec2, b: Vec2): number => a.x * b.y - a.y * b.x;

export const lenSq = (a: Vec2): number => a.x * a.x + a.y * a.y;
export const len = (a: Vec2): number => Math.hypot(a.x, a.y);
export const dist = (a: Vec2, b: Vec2): number => Math.hypot(a.x - b.x, a.y - b.y);
export const distSq = (a: Vec2, b: Vec2): number => {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
};

/** The left-hand normal: a quarter turn counter-clockwise. */
export const perp = (a: Vec2): Vec2 => ({ x: -a.y, y: a.x });

export function normalize(a: Vec2): Vec2 {
  const l = Math.hypot(a.x, a.y);
  return l < EPS ? { x: 1, y: 0 } : { x: a.x / l, y: a.y / l };
}

export const lerpVec = (a: Vec2, b: Vec2, t: number): Vec2 => ({
  x: a.x + (b.x - a.x) * t,
  y: a.y + (b.y - a.y) * t,
});

export const angleOf = (a: Vec2): number => Math.atan2(a.y, a.x);

export const fromAngle = (a: number, r = 1): Vec2 => ({
  x: Math.cos(a) * r,
  y: Math.sin(a) * r,
});

export function rotate(a: Vec2, angle: number): Vec2 {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return { x: a.x * c - a.y * s, y: a.x * s + a.y * c };
}

/** `a + b * k` without an intermediate allocation at the call site. */
export const addScaled = (a: Vec2, b: Vec2, k: number): Vec2 => ({
  x: a.x + b.x * k,
  y: a.y + b.y * k,
});

export const equals = (a: Vec2, b: Vec2, tol = EPS): boolean =>
  Math.abs(a.x - b.x) <= tol && Math.abs(a.y - b.y) <= tol;

export const isFiniteVec = (a: Vec2): boolean =>
  Number.isFinite(a.x) && Number.isFinite(a.y);
