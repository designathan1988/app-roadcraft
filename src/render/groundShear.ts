import type { Matrix4 } from 'three';

/**
 * FEET ON A SLOPE, WITHOUT IK.
 *
 * A walker's clips are baked on level ground and skinned on the GPU, so no
 * foot can be placed on its own. Set down at the height under its centre on a
 * 12 % footway, a body had its leading foot 4 cm into the paving and its
 * trailing foot 4 cm in the air. A vertical SHEAR by the ground's gradient -
 * every point raised by the slope times its offset from the centre - puts
 * both feet on the plane of the ground and leaves the body upright: a torso a
 * few centimetres across moves by a few millimetres, where tilting the whole
 * figure would have leaned it like a falling post.
 */
export interface Gradient {
  readonly gx: number;
  readonly gy: number;
}

/** Steepest gradient a body is sheared to; beyond it the ground is a step, not a slope. */
export const MAX_SHEAR_GRADIENT = 0.3;

/** The ground's gradient at a point, from two forward differences off the height already known there. */
export function groundGradient(heightAt: (x: number, y: number) => number, x: number, y: number, h: number,
  reach = 0.75): Gradient {
  const clampGradient = (value: number): number =>
    Number.isFinite(value) && Math.abs(value) <= MAX_SHEAR_GRADIENT ? value : 0;
  return {
    gx: clampGradient((heightAt(x + reach, y) - h) / reach),
    gy: clampGradient((heightAt(x, y + reach) - h) / reach),
  };
}

/** Height a point of the body at world (x, y), level at `h0` over (x0, y0), is sheared to. */
export const shearedHeight = (g: Gradient, x0: number, y0: number, h0: number, x: number, y: number): number =>
  h0 + g.gx * (x - x0) + g.gy * (y - y0);

/**
 * Premultiplies `matrix` (three's axes: world y is -Z) by the shear about the
 * body's centre (X0, Z0): Y += gx (X - X0) - gy (Z - Z0).
 */
export function shearMatrix(matrix: Matrix4, g: Gradient, X0: number, Z0: number): void {
  if (g.gx === 0 && g.gy === 0) return;
  const e = matrix.elements;
  const a = g.gx;
  const b = -g.gy;
  // Row Y of S·M = row Y of M + a·row X + b·row Z - (a·X0 + b·Z0)·row W.
  const c = a * X0 + b * Z0;
  for (let col = 0; col < 4; col++) {
    const i = col * 4;
    e[i + 1] = e[i + 1]! + a * e[i]! + b * e[i + 2]! - c * e[i + 3]!;
  }
}
