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
  /**
   * Standing here by the route's own decision - waiting its turn for a
   * crossing, or at a place it holds in the queue for one - rather than
   * because something is in the way. The walker's pace is capped to stop it
   * exactly there, so nothing in the pace itself says which of the two this
   * is, and the two want opposite things once it has been standing a while:
   * one waits for the light, the other has to find a way round.
   */
  readonly holding?: boolean;
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
// Never past a right angle: a heading beyond 90 degrees from the way is a
// step BACKWARDS, and the walker does not take one. The old list ran to 1.92
// rad (110 degrees), which is how a held-up walker ended up filming itself
// walking backwards.
const WIDE_ANGLES = [1.45, -1.45];
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
/** Oriented boxes for vehicles and benches; their real footprint, not covering circles. */
const BX: number[] = [], BY: number[] = [];
const BUX: number[] = [], BUY: number[] = [];
const BHL: number[] = [], BHW: number[] = [];

const WALLS = { lo: 0, hi: 0 };
const PLAN_FRAME = { x: 0, y: 0, tx: 0, ty: 0, nx: 0, ny: 0 };
const AGENT_FRAME = { x: 0, y: 0, tx: 0, ty: 0, nx: 0, ny: 0 };

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
export function plannedLine(_w: SimWorld, p: Ped, edge: SidewalkEdge, wanted: number,
  space: PedestrianClearance): number {
  const frame = edge.corridor.frame(p.s, p.entry !== edge.from, PLAN_FRAME);
  const rev = p.entry !== edge.from;
  PLANNED.length = 0;
  space.around(frame.x, frame.y, PLAN_AHEAD, (other) => {
    if (other.id > FURNITURE_IDS) return;
    const dx = other.x - frame.x, dy = other.y - frame.y;
    const along = dx * frame.tx + dy * frame.ty;
    if (along < -m(0.5) || along > PLAN_AHEAD) return;
    const lat = dx * frame.nx + dy * frame.ny;
    let across = other.radius;
    if (other.forward && other.halfLength !== undefined && other.halfWidth !== undefined) {
      const c = Math.abs(other.forward.x * frame.tx + other.forward.y * frame.ty);
      const sn = Math.abs(other.forward.x * frame.nx + other.forward.y * frame.ny);
      across = sn * other.halfLength + c * other.halfWidth;
    }
    let reachAlong = other.radius;
    if (other.forward && other.halfLength !== undefined && other.halfWidth !== undefined) {
      const c = Math.abs(other.forward.x * frame.tx + other.forward.y * frame.ty);
      const sn = Math.abs(other.forward.x * frame.nx + other.forward.y * frame.ny);
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

/** How far a held-up walker may brush into the margin round furniture, world units. */
const BRUSH = m(0.06);

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
      // never through one another - as the clearance has always allowed. Held
      // up longer still, they may shoulder past: a knot that has stopped
      // moving does not untie itself by everybody waiting politely, and the
      // alternative to brushing is standing in it for a minute, which is what
      // this whole file is trying not to do. The room never goes below the two
      // bodies' own radii, so no step here can put one inside another.
      const stuck = p.stuck >= STUCK_RELEASE;
      const contact = stuck ? PERSON_RELEASED_SPACING : CONTACT;
      const reach = stuck ? contact - BRUSH : contact;
      if (next < reach && next < now - 1e-6) ok = false;
      return;
    }
    // Furniture or a vehicle: its edge, and a body's radius from it. A walker
    // held up against it for a while may BRUSH past - a shoulder's width into
    // the margin - because that is what passing a lamp column on a narrow
    // footway looks like, and because the alternative is standing in front of
    // it for ever. The margin never goes below the bodies' own radii, so no
    // step here can put a body inside anything.
    const floor = PERSON + (other.halfLength === undefined ? other.radius : 0) -
      (p.stuck >= STUCK_RELEASE ? BRUSH : 0);
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
  const frame = edge.corridor.place(p.s, p.lat, p.entry !== edge.from, AGENT_FRAME);
  const tx = frame.tx, ty = frame.ty, nx = frame.nx, ny = frame.ny;
  const hx = frame.x, hy = frame.y;
  const rev = p.entry !== edge.from;

  // Held up past `ESCALATE_AFTER`: shoulder to shoulder with strangers is
  // acceptable, and headings well aside are considered (never back along the
  // way). Furniture keeps its margin always.
  const escalated = p.stuck > ESCALATE_AFTER;
  const strangerGap = escalated ? 0 : PERSON_GAP;
  // ---- 1. perceive
  let n = 0, boxes = 0;
  space.around(hx, hy, SEE, (other) => {
    if (other.id === p.id) return;
    const dx = other.x - hx, dy = other.y - hy;
    // Behind and moving away, or far behind: nothing to plan for.
    if (dx * tx + dy * ty < -m(1.2) && Math.hypot(dx, dy) > m(1.5)) return;
    const push = (x: number, y: number, vx: number, vy: number, r: number, weight: number,
      oncoming: boolean): void => {
      TX[n] = x; TY[n] = y; TVX[n] = vx; TVY[n] = vy; TR[n] = r; TW[n] = weight;
      TONCOMING[n] = oncoming; n++;
    };
    if (other.id > 0) {
      const q = w.peds.get(other.id);
      const vx = other.vx ?? 0;
      const vy = other.vy ?? 0;
      const friend = q !== undefined && q.party === p.party;
      const oncoming = vx * tx + vy * ty < -m(0.2);
      const released = p.stuck >= STUCK_RELEASE;
      push(dx, dy, vx, vy, released ? PERSON_RELEASED_SPACING : friend ? COMPANION_RADIUS * 2 : PERSON * 2 + strangerGap,
        friend || released ? 0.35 : 1, oncoming);
      return;
    }
    // The hard clearance uses oriented boxes. Sampling them as overlapping
    // circles here made corners of a parked car look several metres wider
    // than they are and left a walker frozen near the far kerb of a zebra.
    if (other.forward && other.halfLength !== undefined && other.halfWidth !== undefined) {
      BX[boxes] = dx; BY[boxes] = dy;
      BUX[boxes] = other.forward.x; BUY[boxes] = other.forward.y;
      // A stopped vehicle beside a narrow zebra may leave exactly body-width
      // room. The physical guard uses PERSON; adding a furniture comfort gap
      // here declared that real opening impassable and stopped walkers early.
      const gap = other.id > FURNITURE_IDS ? 0 : FURNITURE_GAP;
      BHL[boxes] = other.halfLength + PERSON + gap;
      BHW[boxes] = other.halfWidth + PERSON + gap;
      boxes++;
      return;
    }
    push(dx, dy, 0, 0, PERSON + other.radius + FURNITURE_GAP, 1.2, false);
  });

  // ---- 2. choose
  const want = Math.max(0, intent.along);
  const prefA = want;
  let obstacleAhead = false;
  let closestRisk = Infinity;
  let riskyBox = -1;
  for (let i = 0; i < boxes; i++) {
    const along = BX[i]! * tx + BY[i]! * ty;
    if (along > -m(0.5)) obstacleAhead = true;
    const tau = boxContactTime(BX[i]!, BY[i]!, tx * want, ty * want,
      BUX[i]!, BUY[i]!, BHL[i]!, BHW[i]!, HORIZON);
    if (tau < closestRisk) { closestRisk = tau; riskyBox = i; }
  }
  if (!obstacleAhead) p.passSide = 0;
  if (p.passSide === 0 && riskyBox >= 0 && closestRisk < HORIZON) {
    const boxLat = BX[riskyBox]! * nx + BY[riskyBox]! * ny + p.lat;
    p.passSide = p.lat >= boxLat ? 1 : -1;
  }
  edge.corridor.bounds(p.s, rev, WALLS);
  const committed = p.passSide > 0
    ? Math.max(intent.lat, Math.min(WALLS.hi, Math.max(p.lat, m(0.35))))
    : p.passSide < 0
      ? Math.min(intent.lat, Math.max(WALLS.lo, Math.min(p.lat, -m(0.35))))
      : intent.lat;
  const prefL = Math.max(-LAT_MAX, Math.min(LAT_MAX, (committed - p.lat) / LAT_RELAX));
  const scale = Math.max(want, m(0.6));
  let bestA = 0, bestL = 0, bestCost = Infinity;
  /**
   * The same, among the candidates that carry the walker FORWARD.
   *
   * Every heading in the fan lies within about seventy degrees of the way, so
   * all of them but the two side-steps have pace on them; this is the best of
   * those, and it is what a walker held up against something it cannot pass
   * falls back on. Sliding along the face of a lamp column or a stopped car -
   * shouldering past it - is not a special move: it is a heading well off the
   * way, taken at a walking pace, and the fan has always contained it. What
   * was missing was the nerve to take it, because standing still scored
   * cheaper than any wide heading. Standing is what a person does when there
   * is nothing to be done; against something they can walk round, they walk
   * round.
   */
  let bestFA = 0, bestFL = 0, bestFCost = Infinity;
  /**
   * Whether the body could actually take this velocity from where it stands:
   * the step it maps to, inside the walker's own acceleration, held on the
   * footway, against the clearance gate.
   *
   * This is what makes the choice a choice. Scoring a fan by cost and handing
   * the winner to a gate that may refuse it leaves the walker standing still
   * while it believes it is stepping aside, and no amount of tuning the costs
   * fixes that, because the cost was never asked whether the move was
   * possible. ORCA earns its guarantees the same way, by working out the set
   * of velocities that avoid collision first and only then choosing the
   * closest to the one wanted (`Exploring Dense Crowd Dynamics`, 2025).
   */
  const takeable = (ca: number, cl: number): boolean => {
    const ta = ca >= p.v ? Math.min(ca, p.v + ACCEL * DT) : Math.max(ca, p.v - BRAKE * DT);
    const tl = Math.max(-LAT_STEP, Math.min(LAT_STEP,
      Math.max(p.latV - LAT_ACCEL * DT, Math.min(p.latV + LAT_ACCEL * DT, cl))));
    const ts = Math.max(0, Math.min(edge.length, p.s + ta * DT));
    edge.corridor.bounds(ts, rev, WALLS);
    const tlat = Math.max(WALLS.lo, Math.min(WALLS.hi, p.lat + tl * DT));
    return admissible(p, edge, ts, tlat, space);
  };
  const consider = (ca: number, cl: number): void => {
    // A body steps sideways, it does not slide: no faster than a side-step.
    if (Math.abs(cl) > LAT_STEP + 1e-9) cl = Math.sign(cl) * LAT_STEP;
    if (p.passSide !== 0 && cl * p.passSide < -1e-9) return;
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
    const horizon = ca > 0 ? Math.min(HORIZON, (edge.length - p.s) / ca + DT) : HORIZON;
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
      // This candidate stops at the edge's end. Predicting its straight
      // velocity beyond that point makes a person finishing a crossing brake
      // for people already on the far footway, although the route turns there.
      // The transfer gate handles actual occupancy at the shared kerb.
      if (tau > horizon) continue;
      cost += TW[i]! * K_COLLIDE * Math.exp(-tau / TAU0) / (tau * tau + 0.04);
      // Meeting somebody head on: pass them keeping to one's right, as they will.
      if (TONCOMING[i] && tau < 2.5 && cl > 0) cost += W_SIDE * cl / scale;
    }
    for (let i = 0; i < boxes; i++) {
      const tau = boxContactTime(BX[i]!, BY[i]!, vx, vy,
        BUX[i]!, BUY[i]!, BHL[i]!, BHW[i]!, horizon);
      if (tau === Infinity) continue;
      cost += 1.2 * K_COLLIDE * Math.exp(-tau / TAU0) / (tau * tau + 0.04);
    }
    // Only the candidates that would win are put to the gate, so the walker
    // pays for this once or twice a tick rather than for every heading it
    // thinks of.
    if (cost < bestCost && takeable(ca, cl)) { bestCost = cost; bestA = ca; bestL = cl; }
    if (ca > 1e-9 && cost < bestFCost) { bestFCost = cost; bestFA = ca; bestFL = cl; }
  };
  consider(prefA, prefL);
  consider(0, 0);
  for (const share of SHARES) {
    const speed = share * scale;
    for (const angle of ANGLES) consider(speed * Math.cos(angle), speed * Math.sin(angle));
    if (escalated) for (const angle of WIDE_ANGLES) consider(speed * Math.cos(angle), speed * Math.sin(angle));
  }
  // Nearly stopped, a person can also step aside on the spot.
  if (p.v < STEP_BACK_BELOW) { consider(0, STEP_BACK); consider(0, -STEP_BACK); }
  // WALKING IS FORWARD. There is no velocity behind a walker among the ones it
  // may choose: the pace falls to nothing and never below. Every mechanism
  // that ever moved a body backwards - the step back offered to a walker held
  // up against something it could not pass, the half step back along an edge
  // when a step aside was refused, the body put back where it stood last tick
  // - is gone. A figure that steps forward and is dragged back reads as broken
  // whatever the reason was, and a walker boxed in is better off standing:
  // standing is what a person does, and the crowd comes to it.
  bestA = Math.min(Math.max(bestA, 0), want);
  // Held up and choosing to stand, with nowhere the choice can go that is not
  // backwards: slide along whatever is in the way. This is the forward-only
  // answer to being boxed in - the walker keeps a walking pace and leans off
  // its line, shouldering past the lamp column instead of queueing behind it
  // for a minute - and it is why nothing ever has to step back.
  if (escalated && want > m(0.1) && bestA < m(0.05) && bestFA > 1e-9) {
    bestA = Math.min(bestFA, want);
    bestL = bestFL;
  }

  // ---- 3. move, within a walker's acceleration, the clearance as the last guard
  const a = bestA >= p.v ? Math.min(bestA, p.v + ACCEL * DT) : Math.max(bestA, p.v - BRAKE * DT);
  const l = Math.max(-LAT_STEP, Math.min(LAT_STEP, Math.max(p.latV - LAT_ACCEL * DT, Math.min(p.latV + LAT_ACCEL * DT, bestL))));
  const s1 = Math.max(0, Math.min(edge.length, p.s + a * DT));
  edge.corridor.bounds(s1, rev, WALLS);
  const lat1 = Math.max(WALLS.lo, Math.min(WALLS.hi, p.lat + l * DT));
  const s0 = p.s, lat0 = p.lat;
  // The choice above is a preference among velocities; the clearance is the
  // gate, and the two disagree when a body is held off its line. A velocity
  // the gate refuses is not a choice: the walker goes on believing it is
  // stepping aside while its body does not move.
  //
  // What it keeps, it gives up in the order a person does: the place across
  // the footway first, then pace, and walking last.
  if (a > 1e-9 || Math.abs(l) > 1e-9) {
    if (admissible(p, edge, s1, lat1, space)) { p.s = s1; p.lat = lat1; }
    else if (a > 1e-9 && admissible(p, edge, s1, lat0, space)) p.s = s1;
    else if (Math.abs(l) > 1e-9 && admissible(p, edge, s0, lat1, space)) p.lat = lat1;
    else if (a <= 1e-9 && want > 1e-9) {
      // Boxed in sideways with the choice to stand: walk on the way it wanted
      // to, past whatever holds the line, and cross after it.
      const walked = Math.min(edge.length, s0 + Math.min(want, p.v + ACCEL * DT) * DT);
      if (admissible(p, edge, walked, lat0, space)) p.s = walked;
    }
  }
  p.v = (p.s - s0) / DT;
  p.latV = (p.lat - lat0) / DT;
}

/** First contact of a moving point with an expanded oriented obstacle box. */
function boxContactTime(dx: number, dy: number, vx: number, vy: number,
  ux: number, uy: number, halfLength: number, halfWidth: number, horizon: number): number {
  const along = -dx * ux - dy * uy;
  const across = dx * uy - dy * ux;
  const alongV = vx * ux + vy * uy;
  const acrossV = -vx * uy + vy * ux;
  let enter = 0, leave = horizon;
  if (Math.abs(alongV) < 1e-9) {
    if (Math.abs(along) > halfLength) return Infinity;
  } else {
    const a = (-halfLength - along) / alongV, b = (halfLength - along) / alongV;
    enter = Math.max(enter, Math.min(a, b));
    leave = Math.min(leave, Math.max(a, b));
  }
  if (Math.abs(acrossV) < 1e-9) {
    if (Math.abs(across) > halfWidth) return Infinity;
  } else {
    const a = (-halfWidth - across) / acrossV, b = (halfWidth - across) / acrossV;
    enter = Math.max(enter, Math.min(a, b));
    leave = Math.min(leave, Math.max(a, b));
  }
  return enter <= leave ? enter : Infinity;
}

/** TEMPORARY. */
