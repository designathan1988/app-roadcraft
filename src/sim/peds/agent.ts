import { DT } from '@sim/params';
import { m } from '@world/units';
import type { SimWorld } from '../world';
import type { Ped } from './state';
import type { SidewalkEdge } from './sidewalk';
import { type PedestrianClearance, PERSON_RELEASED_SPACING, STUCK_RELEASE } from './clearance';
import { PED_BEHAVIOUR } from './behaviour';

/**
 * A pedestrian as an AGENT: it looks ahead, sees what is coming, and chooses
 * how to move before it gets there.
 *
 * The walker used to be a point on a line along the footway, moved forward
 * until a gate refused the step, with sideways nudges added by separate rules
 * - pass the slower one, give way to the oncoming one, go round the bench,
 * dodge when stuck. Nothing saw the tree until the step into it was refused,
 * so people walked up to obstacles and stopped in front of them, twelve
 * people meeting on a footway pushed into one another and stood (198 s stuck
 * in the lab's crowd scene), and the competing nudges zigzagged.
 *
 * Here each tick a walker:
 *  1. PERCEIVES everything within a few seconds' walk - people with the way
 *     they are moving, street furniture, stopped vehicles - from the
 *     clearance grid;
 *  2. CHOOSES a velocity from those its body can reach next (a fan of
 *     headings either side of its way, at several speeds, plus stopping),
 *     scoring each by how far it is from the velocity it wants, how sharply
 *     it changes the one it has, how soon it would bring the walker into
 *     contact with anything it sees - the time-to-collision energy of
 *     Karamouzas, Skinner & Guy (2014), which makes a near threat far more
 *     pressing than a distant one - and whether it keeps to the footway;
 *  3. MOVES at that velocity within a walker's acceleration, the clearance
 *     gate kept only as the last guard against contact.
 * Going round a tree, easing behind a slower walker or passing them, keeping
 * right for somebody coming the other way and stopping short of a crowd are
 * then all the same decision, taken early, instead of separate rules.
 */

export interface AgentIntent {
  /** Pace wanted along the way, world units a second, already capped for any stop ahead. */
  readonly along: number;
  /** Line across the footway wanted, from its centre (+ to the walker's left). */
  readonly lat: number;
}

/** Seconds ahead a contact counts. */
const HORIZON = 4;
/** Time constant of the collision energy, s: how quickly a distant threat stops mattering. */
const TAU0 = 2.6;
/** Weight of the collision energy against the other terms. */
const K_COLLIDE = 2.4;
/** Weight of being away from the velocity wanted. */
const W_PREF = 1;
/** The line across is a wish, the pace a need: sideways deviation counts this share. */
const W_LATERAL = 0.6;
/** Weight of changing the velocity one has: smooth motion, no zigzag. */
const W_CHANGE = 0.55;
/** Weight of drifting off the footway within a second. */
const W_WALL = 8;
/** Weight of passing an oncoming walker on the left rather than the right. */
const W_SIDE = 0.35;
/** Radius a person keeps from others, and from furniture. */
const PERSON = m(0.3);
const PERSON_GAP = m(0.12);
const FURNITURE_GAP = m(0.1);
/** Companions walk closer: shoulder to shoulder. */
const COMPANION_RADIUS = m(0.31);
/** How far a walker looks. */
const SEE = m(8);
/** Sideways speed ever wanted to reach the chosen line, u/s. */
const LAT_MAX = m(0.75);
/** Seconds over which the wanted line is closed. */
const LAT_RELAX = 0.9;
/** Acceleration along, and braking; sideways acceleration; u/s². */
const ACCEL = m(1.1);
const BRAKE = m(2.2);
const LAT_ACCEL = m(1.6);

/** Cost of standing still, per second already stood where one wants to walk, and its most. */
const IMPATIENCE = 0.9;
const IMPATIENCE_MAX = 2;
/** Fastest sideways motion: a side-step (`PED_BEHAVIOUR.lateralRate`). */
const LAT_STEP = PED_BEHAVIOUR.lateralRate;
/** Seconds held up before a walker escalates: no stranger margin, headings to ±110°. */
const ESCALATE_AFTER = 1.2;
const WIDE_ANGLES = [1.45, -1.45, 1.7, -1.7, 1.92, -1.92];
/** Speed below which stepping aside on the spot is among the choices, and its pace. */
const STEP_BACK_BELOW = m(0.4);
const STEP_BACK = m(0.35);

/** Headings either side of the way, radians, and shares of the pace: the fan of choices. */
const ANGLES = [0, 0.1, -0.1, 0.22, -0.22, 0.38, -0.38, 0.58, -0.58, 0.85, -0.85, 1.2, -1.2];
const SHARES = [1.12, 1, 0.8, 0.55, 0.3];

/** Threats seen this tick, as flat arrays: relative position, velocity, combined radius, weight. */
const TX: number[] = [];
const TY: number[] = [];
const TVX: number[] = [];
const TVY: number[] = [];
const TR: number[] = [];
const TW: number[] = [];
const TONCOMING: boolean[] = [];

const WALLS = { lo: 0, hi: 0 };

/** How far ahead the line is planned round street furniture. */
const PLAN_AHEAD = m(10);
/** Clearance planned between a body and a piece of furniture it walks past. */
const PLAN_GAP = m(0.2);
const FURNITURE_IDS = -1_000_000;
const PLANNED: { along: number; lat: number; half: number; reach: number }[] = [];
/**
 * The pace at which the line planned round the furniture ahead can still be
 * reached before the furniture is: set by `plannedLine`. A walker never
 * arrives at an obstacle faster than it can step round it - if somebody
 * walks on the side it has to move to, it slows, lets them go ahead, and
 * falls in behind - as braking distance bounds the pace towards a stop.
 */
export const PLAN_CAP = { speed: Infinity };

/**
 * The line to walk on, planned round the street furniture ahead: where a
 * lamp column, a tree pit or a bench stands on the line wanted, the line
 * moves to the side of it with room - decided up to `PLAN_AHEAD` before, so
 * the walker drifts across in good time instead of meeting the obstacle and
 * having to stop. The side that keeps the walker nearest the line they want
 * is taken, and it is kept for every obstacle further on that it also clears.
 */
export function plannedLine(w: SimWorld, p: Ped, edge: SidewalkEdge, wanted: number,
  space: PedestrianClearance): number {
  const path = w.sidewalks.orientedPath(edge, p.entry);
  const frame = path.sampleAt(p.s);
  const rev = p.entry !== edge.from;
  PLANNED.length = 0;
  space.around(frame.p.x, frame.p.y, PLAN_AHEAD, (other) => {
    if (other.id > FURNITURE_IDS) return;
    const dx = other.x - frame.p.x, dy = other.y - frame.p.y;
    const along = dx * frame.t.x + dy * frame.t.y;
    if (along < -m(0.5) || along > PLAN_AHEAD) return;
    const lat = dx * frame.n.x + dy * frame.n.y;
    let across = other.radius;
    if (other.forward && other.halfLength !== undefined && other.halfWidth !== undefined) {
      const c = Math.abs(other.forward.x * frame.t.x + other.forward.y * frame.t.y);
      const sn = Math.abs(other.forward.x * frame.n.x + other.forward.y * frame.n.y);
      across = sn * other.halfLength + c * other.halfWidth;
    }
    let reachAlong = other.radius;
    if (other.forward && other.halfLength !== undefined && other.halfWidth !== undefined) {
      const c = Math.abs(other.forward.x * frame.t.x + other.forward.y * frame.t.y);
      const sn = Math.abs(other.forward.x * frame.n.x + other.forward.y * frame.n.y);
      reachAlong = c * other.halfLength + sn * other.halfWidth;
    }
    PLANNED.push({ along, lat, half: across + PERSON + PLAN_GAP, reach: reachAlong + PERSON });
  });
  PLAN_CAP.speed = Infinity;
  if (!PLANNED.length) return wanted;
  PLANNED.sort((a, b) => a.along - b.along);
  let line = wanted;
  for (const item of PLANNED) {
    // The walker is still on a line into this one: it must be off it before
    // it gets there. Time to step across, against time to arrive.
    const into = Math.abs(p.lat - item.lat) < item.half - PLAN_GAP;
    if (Math.abs(line - item.lat) >= item.half) {
      if (into) capFor(item, line, p.lat);
      continue;
    }
    edge.corridor.bounds(Math.min(edge.length, p.s + item.along), rev, WALLS);
    const left = item.lat + item.half;
    const right = item.lat - item.half;
    const leftOk = left <= WALLS.hi;
    const rightOk = right >= WALLS.lo;
    if (leftOk && rightOk) line = Math.abs(left - line) <= Math.abs(right - line) ? left : right;
    else if (leftOk) line = left;
    else if (rightOk) line = right;
    // Neither side has room for a body with a margin: squeeze past on the
    // wider one; the collision choice below decides how.
    else line = WALLS.hi - item.lat > item.lat - WALLS.lo ? (WALLS.hi + item.lat + item.half - PLAN_GAP) / 2 : (WALLS.lo + item.lat - item.half + PLAN_GAP) / 2;
    if (into) capFor(item, line, p.lat);
  }
  return line;
}

/** Closest two people's centres may be brought, and the room kept from furniture and vehicles. */
const CONTACT = m(0.45);
const HARD = { x: 0, y: 0, tx: 0, ty: 0, nx: 0, ny: 0 };

/**
 * The last guard: a step is refused only if it takes the body into street
 * furniture or a vehicle, or brings it closer than `CONTACT` to another
 * person than it already is. Refusing any step that closes on anybody
 * within a full personal space froze a party of four that had come off a
 * zebra bunched together: every move was closer to one of them.
 */
function admissible(p: Ped, edge: SidewalkEdge, s: number, lat: number,
  space: PedestrianClearance): boolean {
  const rev = p.entry !== edge.from;
  edge.corridor.place(p.s, p.lat, rev, HARD);
  const cx = HARD.x, cy = HARD.y;
  edge.corridor.place(s, lat, rev, HARD);
  const x = HARD.x, y = HARD.y;
  let ok = true;
  space.around(x, y, m(2), (other) => {
    if (!ok || other.id === p.id) return;
    const next = space.distanceTo(other, x, y);
    const now = space.distanceTo(other, cx, cy);
    if (other.id > 0) {
      // Held up past the release, people may brush shoulder to shoulder -
      // never through one another - as the clearance has always allowed.
      const contact = p.stuck >= STUCK_RELEASE ? PERSON_RELEASED_SPACING : CONTACT;
      if (next < contact && next < now - 1e-6) ok = false;
      return;
    }
    // Furniture or a vehicle: its edge, and a body's radius from it.
    const floor = PERSON + (other.halfLength === undefined ? other.radius : 0);
    if (next < floor && next < now - 1e-6) ok = false;
  });
  return ok;
}

/** Caps the pace so the sideways step from `lat` to `line` is done before `item` is reached. */
function capFor(item: { along: number; reach: number; half: number; lat: number }, line: number, lat: number): void {
  const room = item.along - item.reach;
  const across = Math.max(0, Math.abs(line - lat) - PLAN_GAP);
  // Already level with it: the plan has nothing left to pace; the collision
  // choice below takes the walker past.
  if (across <= 0 || room <= 0) return;
  const time = across / (LAT_STEP_PLAN * 0.8);
  PLAN_CAP.speed = Math.min(PLAN_CAP.speed, Math.max(0, room) / time);
}
/** Sideways stepping pace the plan counts on. */
const LAT_STEP_PLAN = PED_BEHAVIOUR.lateralRate;

/**
 * One tick of an agent walking along `edge`: chooses and applies its velocity.
 * Leaves `p.s`, `p.lat`, `p.v` (along) and `p.latV` (across) as the walker's
 * motion this tick; the edge's end is the caller's business.
 */
export function stepAgent(w: SimWorld, p: Ped, edge: SidewalkEdge, intent: AgentIntent,
  space: PedestrianClearance): void {
  const path = w.sidewalks.orientedPath(edge, p.entry);
  const frame = path.sampleAt(p.s);
  const tx = frame.t.x, ty = frame.t.y, nx = frame.n.x, ny = frame.n.y;
  const hx = frame.p.x + nx * p.lat, hy = frame.p.y + ny * p.lat;
  const rev = p.entry !== edge.from;

  // Held up past `ESCALATE_AFTER`: shoulder to shoulder with strangers is
  // acceptable, and headings well aside are considered (never back along the
  // way). Furniture keeps its margin always.
  const escalated = p.stuck > ESCALATE_AFTER;
  const strangerGap = escalated ? 0 : PERSON_GAP;
  // ---- 1. perceive
  let n = 0;
  space.around(hx, hy, SEE, (other) => {
    if (other.id === p.id) return;
    const dx = other.x - hx, dy = other.y - hy;
    // Behind and moving away, or far behind: nothing to plan for.
    if (dx * tx + dy * ty < -m(1.2) && Math.hypot(dx, dy) > m(1.5)) return;
    const push = (x: number, y: number, vx: number, vy: number, r: number, weight: number, oncoming: boolean): void => {
      TX[n] = x; TY[n] = y; TVX[n] = vx; TVY[n] = vy; TR[n] = r; TW[n] = weight; TONCOMING[n] = oncoming; n++;
    };
    if (other.id > 0) {
      const q = w.peds.get(other.id);
      const vx = q ? (q.x - q.prev.x) / DT : 0;
      const vy = q ? (q.y - q.prev.y) / DT : 0;
      const friend = q !== undefined && q.party === p.party;
      const oncoming = vx * tx + vy * ty < -m(0.2);
      const released = p.stuck >= STUCK_RELEASE;
      push(dx, dy, vx, vy, released ? PERSON_RELEASED_SPACING : friend ? COMPANION_RADIUS * 2 : PERSON * 2 + strangerGap,
        friend || released ? 0.35 : 1, oncoming);
      return;
    }
    // Furniture, or a stopped vehicle: a long one as a row of circles.
    if (other.forward && other.halfLength !== undefined && other.halfWidth !== undefined && other.halfLength > other.halfWidth) {
      const count = Math.ceil(other.halfLength / other.halfWidth);
      for (let i = 0; i <= count; i++) {
        const along = -other.halfLength + (2 * other.halfLength * i) / count;
        push(dx + other.forward.x * along, dy + other.forward.y * along, 0, 0,
          PERSON + other.halfWidth + FURNITURE_GAP, 1.2, false);
      }
      return;
    }
    push(dx, dy, 0, 0, PERSON + other.radius + FURNITURE_GAP, 1.2, false);
  });

  // ---- 2. choose
  const want = Math.max(0, intent.along);
  const prefA = want;
  const prefL = Math.max(-LAT_MAX, Math.min(LAT_MAX, (intent.lat - p.lat) / LAT_RELAX));
  const scale = Math.max(want, m(0.6));
  let bestA = 0, bestL = 0, bestCost = Infinity;
  const consider = (ca: number, cl: number): void => {
    // A body steps sideways, it does not slide: no faster than a side-step.
    if (Math.abs(cl) > LAT_STEP + 1e-9) cl = Math.sign(cl) * LAT_STEP;
    let cost = W_PREF * Math.hypot(ca - prefA, (cl - prefL) * W_LATERAL) / scale +
      W_CHANGE * Math.hypot(ca - p.v, cl - p.latV) / scale;
    // Impatience: standing still where one wants to walk grows costlier the
    // longer it has lasted, until stepping back and round is the better way.
    if (want > 1e-6 && Math.hypot(ca, cl) < m(0.05)) cost += Math.min(IMPATIENCE_MAX, p.stuck * IMPATIENCE);
    // Off the footway within a second.
    edge.corridor.bounds(Math.min(edge.length, p.s + ca), rev, WALLS);
    const lat1 = p.lat + cl;
    const out = Math.max(0, lat1 - WALLS.hi, WALLS.lo - lat1);
    if (out > 0) cost += W_WALL * out / PERSON;
    const vx = tx * ca + nx * cl, vy = ty * ca + ny * cl;
    for (let i = 0; i < n; i++) {
      const rx = vx - TVX[i]!, ry = vy - TVY[i]!;
      const dx = TX[i]!, dy = TY[i]!;
      const r = TR[i]!;
      const c = dx * dx + dy * dy - r * r;
      const b = dx * rx + dy * ry;
      if (c < 0) {
        // Already too close: only moving apart is free.
        if (b > 0) cost += TW[i]! * K_COLLIDE * 40 * (b / (Math.sqrt(dx * dx + dy * dy) + 1e-6)) / scale;
        continue;
      }
      if (b <= 0) continue;
      const a = rx * rx + ry * ry;
      const disc = b * b - a * c;
      if (disc <= 0 || a < 1e-9) continue;
      const tau = (b - Math.sqrt(disc)) / a;
      if (tau > HORIZON) continue;
      cost += TW[i]! * K_COLLIDE * Math.exp(-tau / TAU0) / (tau * tau + 0.04);
      // Meeting somebody head on: pass them keeping to one's right, as they will.
      if (TONCOMING[i] && tau < 2.5 && cl > 0) cost += W_SIDE * cl / scale;
    }
    if (cost < bestCost) { bestCost = cost; bestA = ca; bestL = cl; }
  };
  consider(prefA, prefL);
  consider(0, 0);
  for (const share of SHARES) {
    const speed = share * scale;
    for (const angle of ANGLES) consider(speed * Math.cos(angle), speed * Math.sin(angle));
    if (escalated) for (const angle of WIDE_ANGLES) consider(speed * Math.cos(angle), speed * Math.sin(angle));
  }
  // Nearly stopped, a person can also step aside on the spot. Never back
  // along the way: walking is forward, and the planned line takes the
  // walker round furniture before it is reached.
  if (p.v < STEP_BACK_BELOW) { consider(0, STEP_BACK); consider(0, -STEP_BACK); }
  bestA = Math.max(0, Math.min(bestA, Math.max(want, 0)));

  // ---- 3. move, within a walker's acceleration, the clearance as the last guard
  const a = bestA >= p.v ? Math.min(bestA, p.v + ACCEL * DT) : Math.max(bestA, p.v - BRAKE * DT);
  const l = Math.max(-LAT_STEP, Math.min(LAT_STEP, Math.max(p.latV - LAT_ACCEL * DT, Math.min(p.latV + LAT_ACCEL * DT, bestL))));
  const s1 = Math.min(edge.length, p.s + a * DT);
  edge.corridor.bounds(s1, rev, WALLS);
  const lat1 = Math.max(WALLS.lo, Math.min(WALLS.hi, p.lat + l * DT));
  const s0 = p.s, lat0 = p.lat;
  if (admissible(p, edge, s1, lat1, space)) { p.s = s1; p.lat = lat1; }
  else if (admissible(p, edge, s1, lat0, space)) { p.s = s1; }
  else if (admissible(p, edge, s0, lat1, space)) { p.lat = lat1; }
  p.v = (p.s - s0) / DT;
  p.latV = (p.lat - lat0) / DT;
}
