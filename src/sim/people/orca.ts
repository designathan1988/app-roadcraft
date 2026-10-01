/**
 * Optimal Reciprocal Collision Avoidance (van den Berg, Guy, Lin & Manocha,
 * "Reciprocal n-body collision avoidance", 2011), written from the paper.
 *
 * Each neighbour adds a half-plane of velocities that keeps the two bodies
 * apart for `horizon` seconds, given that the neighbour takes its share of
 * the avoidance. The velocity chosen is the one closest to the preferred
 * velocity inside every half-plane and within the top speed. When no velocity
 * satisfies them all - a dense crowd - the one that violates them least is
 * taken. Either way a velocity always comes out: a body is never left with
 * "nothing allowed" and made to stand, which is how crowds used to lock.
 */

/** A half-plane: velocities on the left of the directed line through `p` along `d` (unit). */
export interface OrcaLine { px: number; py: number; dx: number; dy: number }

export interface OrcaBody {
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
}

const EPS = 1e-6;
const det = (ax: number, ay: number, bx: number, by: number): number => ax * by - ay * bx;

/**
 * The half-plane `a` must keep to so as not to meet `b` within `horizon`,
 * taking `share` of the avoidance (0.5 each by default; 1 when `b` will not
 * move out of the way at all). `dt` is the step length: overlapping bodies
 * are pushed apart within one step.
 */
export function orcaLine(a: OrcaBody, b: OrcaBody, horizon: number, dt: number, share: number, out: OrcaLine): OrcaLine {
  const rpx = b.x - a.x, rpy = b.y - a.y;
  const rvx = a.vx - b.vx, rvy = a.vy - b.vy;
  const distSq = rpx * rpx + rpy * rpy;
  const r = a.radius + b.radius;
  const rSq = r * r;
  let ux: number, uy: number, dx: number, dy: number;
  if (distSq > rSq) {
    const inv = 1 / horizon;
    // Vector from the cutoff centre to the relative velocity.
    const wx = rvx - inv * rpx, wy = rvy - inv * rpy;
    const wLenSq = wx * wx + wy * wy;
    const dot = wx * rpx + wy * rpy;
    if (dot < 0 && dot * dot > rSq * wLenSq) {
      // Project on the cutoff circle.
      const wLen = Math.sqrt(wLenSq) || EPS;
      const nx = wx / wLen, ny = wy / wLen;
      dx = ny; dy = -nx;
      ux = (r * inv - wLen) * nx; uy = (r * inv - wLen) * ny;
    } else {
      // Project on a leg of the cone.
      const leg = Math.sqrt(Math.max(0, distSq - rSq));
      if (det(rpx, rpy, wx, wy) > 0) {
        dx = (rpx * leg - rpy * r) / distSq; dy = (rpx * r + rpy * leg) / distSq;
      } else {
        dx = -(rpx * leg + rpy * r) / distSq; dy = -(-rpx * r + rpy * leg) / distSq;
      }
      const along = rvx * dx + rvy * dy;
      ux = along * dx - rvx; uy = along * dy - rvy;
    }
  } else {
    // Already overlapping: get apart within this very step.
    const inv = 1 / dt;
    const wx = rvx - inv * rpx, wy = rvy - inv * rpy;
    const wLen = Math.hypot(wx, wy) || EPS;
    const nx = wx / wLen, ny = wy / wLen;
    dx = ny; dy = -nx;
    ux = (r * inv - wLen) * nx; uy = (r * inv - wLen) * ny;
  }
  out.px = a.vx + share * ux;
  out.py = a.vy + share * uy;
  out.dx = dx; out.dy = dy;
  return out;
}

/** Result of the 1-D program on line `i`; false when infeasible. */
function program1(lines: readonly OrcaLine[], i: number, max: number, ox: number, oy: number, dirOpt: boolean, res: { x: number; y: number }): boolean {
  const L = lines[i]!;
  const dot = L.px * L.dx + L.py * L.dy;
  const disc = dot * dot + max * max - (L.px * L.px + L.py * L.py);
  if (disc < 0) return false;
  const sq = Math.sqrt(disc);
  let tl = -dot - sq, tr = -dot + sq;
  for (let j = 0; j < i; j++) {
    const M = lines[j]!;
    const den = det(L.dx, L.dy, M.dx, M.dy);
    const num = det(M.dx, M.dy, L.px - M.px, L.py - M.py);
    if (Math.abs(den) <= EPS) {
      if (num < 0) return false;
      continue;
    }
    const t = num / den;
    if (den >= 0) tr = Math.min(tr, t);
    else tl = Math.max(tl, t);
    if (tl > tr) return false;
  }
  let t: number;
  if (dirOpt) t = ox * L.dx + oy * L.dy > 0 ? tr : tl;
  else {
    t = L.dx * (ox - L.px) + L.dy * (oy - L.py);
    if (t < tl) t = tl; else if (t > tr) t = tr;
  }
  res.x = L.px + t * L.dx;
  res.y = L.py + t * L.dy;
  return true;
}

/** The 2-D program: index of the first line that failed, or `lines.length`. */
function program2(lines: readonly OrcaLine[], max: number, ox: number, oy: number, dirOpt: boolean, res: { x: number; y: number }): number {
  if (dirOpt) { res.x = ox * max; res.y = oy * max; }
  else if (ox * ox + oy * oy > max * max) {
    const l = Math.hypot(ox, oy);
    res.x = ox / l * max; res.y = oy / l * max;
  } else { res.x = ox; res.y = oy; }
  for (let i = 0; i < lines.length; i++) {
    const L = lines[i]!;
    if (det(L.dx, L.dy, L.px - res.x, L.py - res.y) > 0) {
      const tx = res.x, ty = res.y;
      if (!program1(lines, i, max, ox, oy, dirOpt, res)) { res.x = tx; res.y = ty; return i; }
    }
  }
  return lines.length;
}

/**
 * The 3-D program: the velocity breaking the people's half-planes from
 * `begin` on least, never breaking the first `hard` ones (walls).
 */
function program3(lines: readonly OrcaLine[], hard: number, begin: number, max: number, res: { x: number; y: number }): void {
  let distance = 0;
  const proj: OrcaLine[] = [];
  for (let i = begin; i < lines.length; i++) {
    const L = lines[i]!;
    if (det(L.dx, L.dy, L.px - res.x, L.py - res.y) <= distance) continue;
    proj.length = 0;
    for (let j = 0; j < hard; j++) proj.push(lines[j]!);
    for (let j = hard; j < i; j++) {
      const M = lines[j]!;
      const den = det(L.dx, L.dy, M.dx, M.dy);
      let px: number, py: number;
      if (Math.abs(den) <= EPS) {
        if (L.dx * M.dx + L.dy * M.dy > 0) continue;
        px = 0.5 * (L.px + M.px); py = 0.5 * (L.py + M.py);
      } else {
        const t = det(M.dx, M.dy, L.px - M.px, L.py - M.py) / den;
        px = L.px + t * L.dx; py = L.py + t * L.dy;
      }
      let dx = M.dx - L.dx, dy = M.dy - L.dy;
      const n = Math.hypot(dx, dy) || EPS;
      dx /= n; dy /= n;
      proj.push({ px, py, dx, dy });
    }
    const tx = res.x, ty = res.y;
    if (program2(proj, max, -L.dy, L.dx, true, res) < proj.length) { res.x = tx; res.y = ty; }
    distance = det(L.dx, L.dy, L.px - res.x, L.py - res.y);
  }
}

/**
 * A wall as a hard half-plane: from a point `d` away from it along the unit
 * normal `(nx, ny)` (pointing off the wall), the body may close on it no
 * faster than covers that gap in `horizon` seconds.
 */
export function wallLine(nx: number, ny: number, d: number, horizon: number, out: OrcaLine): OrcaLine {
  const c = -Math.max(0, d) / horizon;
  out.px = nx * c; out.py = ny * c;
  out.dx = ny; out.dy = -nx;
  return out;
}

/**
 * The velocity nearest `(prefX, prefY)`, no faster than `max`, keeping to
 * every half-plane - or, when they can not all be kept, breaking the
 * people's least and the first `hard` (walls) never.
 */
export function solveOrca(lines: readonly OrcaLine[], prefX: number, prefY: number, max: number, out: { x: number; y: number }, hard = 0): { x: number; y: number } {
  const failed = program2(lines, max, prefX, prefY, false, out);
  if (failed < lines.length) program3(lines, hard, Math.max(failed, hard), max, out);
  return out;
}

/** How far to the right a walker bears with people about, radians. */
export const KEEP_RIGHT = 0.08;

/**
 * The preferred velocity borne a little to the right when there are people
 * about, as walkers keep right: two people, or a ring of them, all giving way
 * exactly alike otherwise stand facing each other for good - the one case
 * ORCA can not settle by itself.
 */
export function keepRight(x: number, y: number, crowded: boolean): [number, number] {
  if (!crowded) return [x, y];
  const c = Math.cos(KEEP_RIGHT), s = Math.sin(KEEP_RIGHT);
  return [x * c + y * s, -x * s + y * c];
}
