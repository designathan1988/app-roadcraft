/**
 * A vehicle's one frame on the road: height, pitch and roll, from the road
 * surface under its wheels. Pure, so the renderer (`agents.ts`) and the
 * contact tests (`tests/render/vehicleFrame.spec.ts`) use the same numbers.
 *
 * The frame is: yaw about the vertical, then pitch about the vehicle's
 * lateral axis (nose up positive), then roll about its forward axis (left
 * side up positive). A point `along` forward and `side` to the left on the
 * frame's ground plane is at `contactHeight`.
 */
export interface RoadFrame {
  readonly deck: number;
  readonly pitch: number;
  readonly roll: number;
}

/** Steepest gradient and camber a frame will take from its samples. */
export const MAX_FRAME_PITCH = 0.35;
export const MAX_FRAME_ROLL = 0.25;

/**
 * The frame through the road under the axles and the sides.
 *
 * `heightAt` is the height of the vehicle's OWN road at a point (its deck on a
 * bridge, its bore in a tunnel, never the ground over or under it). `front`
 * and `rear` are the axle stations along the body (rear negative), `track`
 * half the distance between the wheels, 0 for a two-wheeler.
 */
export function roadFrame(
  heightAt: (x: number, y: number) => number,
  cx: number,
  cy: number,
  heading: number,
  front: number,
  rear: number,
  track: number,
  fallback: number,
): RoadFrame {
  const ux = Math.cos(heading);
  const uy = Math.sin(heading);
  const base = Math.max(1e-3, front - rear);
  let hFront: number;
  let hRear: number;
  let roll = 0;
  if (track > 0) {
    // Each axle's height is the mean of its two wheels; the roll is the mean
    // of the two axles' side-to-side differences. Four contacts, one plane.
    const lx = -uy * track;
    const ly = ux * track;
    const fl = heightAt(cx + ux * front + lx, cy + uy * front + ly);
    const fr = heightAt(cx + ux * front - lx, cy + uy * front - ly);
    const rl = heightAt(cx + ux * rear + lx, cy + uy * rear + ly);
    const rr = heightAt(cx + ux * rear - lx, cy + uy * rear - ly);
    hFront = (fl + fr) / 2;
    hRear = (rl + rr) / 2;
    roll = Math.atan2((fl - fr + rl - rr) / 2, 2 * track);
  } else {
    hFront = heightAt(cx + ux * front, cy + uy * front);
    hRear = heightAt(cx + ux * rear, cy + uy * rear);
  }
  let pitch = Math.atan2(hFront - hRear, base);
  let deck = hRear + (0 - rear) * (hFront - hRear) / base;
  if (!Number.isFinite(pitch) || Math.abs(pitch) > MAX_FRAME_PITCH || !Number.isFinite(deck)) {
    pitch = 0;
    deck = fallback;
  }
  if (!Number.isFinite(roll) || Math.abs(roll) > MAX_FRAME_ROLL) roll = 0;
  return { deck, pitch, roll };
}

/** World (x, y, h) of a point on the frame's ground plane, `along` forward and `side` left. */
export function framePoint(
  frame: RoadFrame, cx: number, cy: number, heading: number, along: number, side: number,
): { x: number; y: number; h: number } {
  // Roll about forward, then pitch about the lateral axis, then yaw.
  const sr = Math.sin(frame.roll);
  const cr = Math.cos(frame.roll);
  const sp = Math.sin(frame.pitch);
  const cp = Math.cos(frame.pitch);
  // Local (forward, up, left).
  const up1 = side * sr;
  const left1 = side * cr;
  const forward2 = along * cp - up1 * sp;
  const up2 = along * sp + up1 * cp;
  const ux = Math.cos(heading);
  const uy = Math.sin(heading);
  return { x: cx + ux * forward2 - uy * left1, y: cy + uy * forward2 + ux * left1, h: frame.deck + up2 };
}
