import { RegionIndex } from '@core/regionIndex';
import { step } from '@sim/pipeline';
import { DT } from '@sim/params';
import { vehiclePose } from '@sim/pose';
import { pedestrianSignalState } from '@sim/signals/query';
import { makeCrossingId } from '@sim/signals/plan';
import type { Ped } from '@sim/peds/state';
import type { SimWorld } from '@sim/world';
import { CROSSWALK_DEPTH } from '@world/approach';
import { Level } from '@world/roadTypes';
import { blocksPedestrians, streetFurniture } from '@world/streetFurniture';
import { levelPolygons } from '@world/surfaces';
import { m } from '@world/units';

/**
 * WHERE PEOPLE ARE, AND HOW THEY GET ROUND THINGS: the pedestrian audit.
 *
 * Everything here is measured against what the player sees, not against the
 * pedestrian model's own idea of itself: the drawn body centre against the
 * surface polygons the road mesh is built from (`world/surfaces.ts`), against
 * the street furniture the renderer places, against every other drawn body
 * and against the drawn vehicle bodies. So it measures the old engine and the
 * new one alike, and a model that is right about itself and wrong on screen
 * cannot pass.
 *
 *   containment   seconds with the body centre off every walkable surface:
 *                 out on the verge or the open ground, or on the carriageway
 *                 anywhere but on a zebra while crossing it. Somebody stepping
 *                 to or sitting on a bench is at the bench, and is counted
 *                 apart.
 *   furniture     seconds with the body overlapping a piece of street
 *                 furniture or a pole (centre within 0.3 m of its edge), and
 *                 with the centre inside it; the nearest approach.
 *   people        pair-seconds with two centres closer than 0.3 m; nearest.
 *   avoidance     every time a walker is on a collision course with
 *                 something — carrying straight on at its current velocity
 *                 would touch it within four seconds — the episode is followed
 *                 until it ends: resolved (no longer on course), stopped
 *                 short, or contact. How early a course is resolved, as the
 *                 time to contact left at that moment, is how early avoidance
 *                 happens; a course held to under half a second is "at the
 *                 last moment".
 *   smoothness    ticks where the direction of travel swings faster than a
 *                 person turns (over 6 rad/s at walking pace).
 *   stuck         seconds wanting to move (walking or crossing, no activity,
 *                 no pause, not queueing for a crossing) and moving less than
 *                 a quarter of a metre in two seconds; the longest spell.
 *   crossings     entries onto a signalised zebra without a WALK.
 *   vehicles      seconds on the carriageway inside the path a moving vehicle
 *                 sweeps in the next 1.5 s, and seconds touching a body.
 */

export interface PedAudit {
  pedSeconds: number;
  walkingSeconds: number;
  /** Seconds off every walkable surface, and of those, by where. */
  offWalkable: number;
  openGround: number;
  carriageway: number;
  /** Seconds off by `edge kind/state`, for finding the cause. */
  offBy: Record<string, number>;
  /** Seconds at a bench, off the footway on purpose. */
  atBench: number;
  furnitureOverlap: number;
  furnitureInside: number;
  nearestFurniture: number;
  personOverlap: number;
  nearestPerson: number;
  episodes: number;
  /** Episodes by outcome. */
  resolvedEarly: number;
  resolvedLate: number;
  stoppedShort: number;
  contact: number;
  /** Episodes whose time to contact fell under half a second. */
  lastMoment: number;
  /** Median and 10th percentile of the time to contact left when a course was resolved, s. */
  resolveTtcMedian: number;
  resolveTtcP10: number;
  /** Median distance to the obstacle's edge when a furniture course was resolved, m. */
  furnitureResolveDistance: number;
  abruptTurns: number;
  /** Abrupt-turn ticks per minute of walking. */
  abruptPerMinute: number;
  stuckSeconds: number;
  longestStuck: number;
  stuckSpells: number;
  crossingEntries: number;
  redEntries: number;
  vehiclePath: number;
  vehicleContact: number;
}

interface Obstacle { x: number; y: number; r: number; along?: { x: number; y: number } | undefined; hl?: number | undefined; hw?: number | undefined }
interface Episode { minTtc: number; lastTtc: number; lastDistance: number; furniture: boolean; seen: number }
interface Track {
  xs: Float64Array; ys: Float64Array; n: number;
  /** Every half second, for the stuck test. */
  sx: Float64Array; sy: Float64Array; sn: number;
  stuckFor: number; wasCrossing: boolean;
}

const HISTORY = 16;
const HORIZON = 4;
const PERSON = m(0.3);
/** Body radius for predicting contact: shoulders, not personal space. */
const BODY = m(0.25);

/** Distance from a point to an obstacle's edge (negative inside). */
function edgeDistance(o: Obstacle, x: number, y: number): number {
  const dx = x - o.x, dy = y - o.y;
  if (o.hl === undefined || o.hw === undefined || !o.along) return Math.hypot(dx, dy) - o.r;
  const along = Math.abs(dx * o.along.x + dy * o.along.y) - o.hl;
  const across = Math.abs(-dx * o.along.y + dy * o.along.x) - o.hw;
  return Math.hypot(Math.max(0, along), Math.max(0, across)) + Math.min(0, Math.max(along, across));
}

/** Discs standing in for an obstacle when predicting a course: a bench is three. */
function discsOf(o: Obstacle): { x: number; y: number; r: number }[] {
  if (o.hl === undefined || o.hw === undefined || !o.along) return [{ x: o.x, y: o.y, r: o.r }];
  const out: { x: number; y: number; r: number }[] = [];
  const k = Math.max(1, Math.ceil(o.hl / o.hw));
  for (let i = -k; i <= k; i++) {
    const t = (i / k) * (o.hl - o.hw * 0.5);
    out.push({ x: o.x + o.along.x * t, y: o.y + o.along.y * t, r: o.hw * 1.1 });
  }
  return out;
}

/** Time until a disc of radius `r` at relative position (dx, dy), moving at (vx, vy) relative, touches the origin. */
function ttc(dx: number, dy: number, vx: number, vy: number, r: number): number {
  const c = dx * dx + dy * dy - r * r;
  if (c <= 0) return 0;
  const b = dx * vx + dy * vy;
  if (b >= 0) return Infinity;
  const a = vx * vx + vy * vy;
  const disc = b * b - a * c;
  if (disc <= 0) return Infinity;
  return (-b - Math.sqrt(disc)) / a;
}

function median(values: number[], q = 0.5): number {
  if (!values.length) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
}

/** Whether this person is where a bench has put them rather than on the footway. */
const benchPhase = (p: Ped): boolean =>
  p.activity?.kind === 'bench' && p.activity.phase !== 'approach';

/** Waiting their turn for a crossing: standing in its queue is not being stuck. */
function queued(sim: SimWorld, p: Ped): boolean {
  if (p.state === 'WaitAtKerb' || p.state === 'ApproachKerb') return true;
  const next = p.route[0] ? sim.sidewalks.edges.get(p.route[0]) : undefined;
  if (next?.kind !== 'crossing') return false;
  const edge = sim.sidewalks.edges.get(p.edge);
  return !!edge && edge.length - p.s < m(6);
}

export function auditPedestrians(sim: SimWorld, seconds: number, onTick?: (sim: SimWorld) => void): PedAudit {
  const footprint = RegionIndex.fromMultiPoly(levelPolygons(sim.net, Level.Sidewalk));
  const asphalt = RegionIndex.fromMultiPoly(levelPolygons(sim.net, Level.Asphalt));
  const items: Obstacle[] = streetFurniture(sim.net).filter(blocksPedestrians)
    .map((i) => ({ x: i.x, y: i.y, r: i.radius, along: i.along, hl: i.halfLength, hw: i.halfWidth }));
  for (const pole of sim.doc.poles.values()) items.push({ x: pole.x, y: pole.y, r: m(0.18) });
  const CELL = m(4);
  const key = (x: number, y: number): number => Math.floor(x / CELL) * 100_003 + Math.floor(y / CELL);
  const furnitureGrid = new Map<number, number[]>();
  items.forEach((item, i) => {
    const cx = Math.floor(item.x / CELL), cy = Math.floor(item.y / CELL);
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) {
      const k = (cx + a) * 100_003 + cy + b;
      const list = furnitureGrid.get(k) ?? [];
      list.push(i);
      furnitureGrid.set(k, list);
    }
  });
  const discs = items.map(discsOf);

  const audit: PedAudit = {
    pedSeconds: 0, walkingSeconds: 0, offWalkable: 0, openGround: 0, carriageway: 0, offBy: {}, atBench: 0,
    furnitureOverlap: 0, furnitureInside: 0, nearestFurniture: Infinity, personOverlap: 0, nearestPerson: Infinity,
    episodes: 0, resolvedEarly: 0, resolvedLate: 0, stoppedShort: 0, contact: 0, lastMoment: 0,
    resolveTtcMedian: NaN, resolveTtcP10: NaN, furnitureResolveDistance: NaN,
    abruptTurns: 0, abruptPerMinute: 0, stuckSeconds: 0, longestStuck: 0, stuckSpells: 0,
    crossingEntries: 0, redEntries: 0, vehiclePath: 0, vehicleContact: 0,
  };
  const tracks = new Map<number, Track>();
  const episodes = new Map<string, Episode>();
  const resolveTtc: number[] = [];
  const resolveDistance: number[] = [];
  let tick = 0;

  const close = (id: string, e: Episode, outcome: 'resolved' | 'stopped' | 'contact'): void => {
    episodes.delete(id);
    audit.episodes++;
    if (e.minTtc < 0.5) audit.lastMoment++;
    if (outcome === 'contact') audit.contact++;
    else if (outcome === 'stopped') audit.stoppedShort++;
    else {
      if (e.lastTtc >= 1.5) audit.resolvedEarly++;
      else audit.resolvedLate++;
      resolveTtc.push(e.lastTtc);
      if (e.furniture) resolveDistance.push(e.lastDistance / m(1));
    }
  };

  const zebraOf = (p: Ped): boolean => {
    const edge = sim.sidewalks.edges.get(p.edge);
    if (edge?.kind !== 'crossing') return false;
    const a = edge.path.point(0), b = edge.path.point(edge.path.n - 1);
    const lx = b.x - a.x, ly = b.y - a.y, l = Math.hypot(lx, ly) || 1;
    const along = ((p.x - a.x) * lx + (p.y - a.y) * ly) / l;
    const across = Math.abs((p.x - a.x) * -ly + (p.y - a.y) * lx) / l;
    return along >= -m(0.3) && along <= l + m(0.3) && across <= CROSSWALK_DEPTH / 2 + m(0.1);
  };

  const velocityOf = (t: Track, span: number, back = 0): { x: number; y: number } | null => {
    if (t.n < span + back + 1) return null;
    const i0 = (t.n - 1 - back) % HISTORY, i1 = (t.n - 1 - back - span) % HISTORY;
    return { x: (t.xs[i0]! - t.xs[i1]!) / (span * DT), y: (t.ys[i0]! - t.ys[i1]!) / (span * DT) };
  };

  sim.clock.run(Math.round(seconds / DT), () => {
    step(sim, { traffic: true, pedestrians: true });
    onTick?.(sim);
    tick++;
    const peds = sim.pedsInIdOrder();
    const cells = new Map<number, Ped[]>();
    for (const p of peds) {
      const k = key(p.x, p.y);
      const list = cells.get(k);
      if (list) list.push(p); else cells.set(k, [p]);
      let t = tracks.get(p.id);
      if (!t) {
        t = { xs: new Float64Array(HISTORY), ys: new Float64Array(HISTORY), n: 0,
          sx: new Float64Array(5), sy: new Float64Array(5), sn: 0, stuckFor: 0, wasCrossing: false };
        tracks.set(p.id, t);
      }
      t.xs[t.n % HISTORY] = p.x; t.ys[t.n % HISTORY] = p.y; t.n++;
    }
    for (const id of tracks.keys()) if (!sim.peds.has(id)) tracks.delete(id);

    // Vehicles as drawn, for the carriageway checks.
    const bodies: { x: number; y: number; ux: number; uy: number; hl: number; hw: number; v: number }[] = [];
    for (const v of sim.vehiclesInIdOrder()) {
      const pose = vehiclePose(sim, v, 1);
      if (!pose) continue;
      bodies.push({ x: pose.p.x, y: pose.p.y, ux: Math.cos(pose.angle), uy: Math.sin(pose.angle),
        hl: v.archetype.length / 2, hw: v.archetype.width / 2, v: v.v });
    }

    const seenEpisodes = new Set<string>();
    for (const p of peds) {
      const t = tracks.get(p.id)!;
      audit.pedSeconds += DT;
      const walking = (p.state === 'Walking' || p.state === 'Crossing') && !p.activity && p.pause <= 0;
      if (walking) audit.walkingSeconds += DT;

      // ---- crossings
      const crossing = p.state === 'Crossing';
      if (crossing && !t.wasCrossing) {
        const edge = sim.sidewalks.edges.get(p.edge);
        if (edge?.kind === 'crossing' && edge.node !== undefined && edge.segment !== undefined) {
          audit.crossingEntries++;
          const controller = sim.controller(edge.node);
          if (controller && sim.graph.junctions.get(edge.node)?.signalised &&
            pedestrianSignalState(controller, makeCrossingId(edge.node, edge.segment), edge.length) !== 'walk') {
            audit.redEntries++;
          }
        }
      }
      t.wasCrossing = crossing;

      // ---- containment
      if (benchPhase(p)) audit.atBench += DT;
      else {
        const edge = sim.sidewalks.edges.get(p.edge);
        let where: string | null = null;
        if (!footprint.contains(p.x, p.y)) where = 'open';
        else if (asphalt.contains(p.x, p.y) && !(crossing && zebraOf(p))) where = 'road';
        if (where) {
          audit.offWalkable += DT;
          if (where === 'open') audit.openGround += DT; else audit.carriageway += DT;
          const cause = `${where}:${edge?.kind ?? '?'}:${p.state}${p.activity ? `:${p.activity.kind}` : ''}`;
          audit.offBy[cause] = (audit.offBy[cause] ?? 0) + DT;
        }
        // ---- vehicles, for anybody on the carriageway
        if (asphalt.contains(p.x, p.y)) {
          let path = false, touch = false;
          for (const b of bodies) {
            const dx = p.x - b.x, dy = p.y - b.y;
            if (Math.abs(dx) > 40 || Math.abs(dy) > 40) continue;
            const along = dx * b.ux + dy * b.uy;
            const across = Math.abs(-dx * b.uy + dy * b.ux);
            const out = Math.hypot(Math.max(0, Math.abs(along) - b.hl), Math.max(0, across - b.hw));
            if (out < m(0.25)) touch = true;
            if (b.v > m(1) && along > -b.hl && along < b.hl + b.v * 1.5 && across < b.hw + PERSON) path = true;
          }
          if (path) audit.vehiclePath += DT;
          if (touch) audit.vehicleContact += DT;
        }
      }

      // ---- furniture
      const seated = benchPhase(p);
      const nearFurniture = furnitureGrid.get(key(p.x, p.y)) ?? [];
      if (!seated && p.state !== 'Crossing') {
        let nearest = Infinity;
        for (const i of nearFurniture) nearest = Math.min(nearest, edgeDistance(items[i]!, p.x, p.y));
        if (nearest < PERSON) audit.furnitureOverlap += DT;
        if (nearest < 0) audit.furnitureInside += DT;
        audit.nearestFurniture = Math.min(audit.nearestFurniture, nearest / m(1));
      }

      // ---- people
      const cx = Math.floor(p.x / CELL), cy = Math.floor(p.y / CELL);
      const neighbours: Ped[] = [];
      for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) {
        for (const q of cells.get((cx + a) * 100_003 + cy + b) ?? []) {
          if (q.id === p.id) continue;
          neighbours.push(q);
          if (q.id > p.id) {
            const d = Math.hypot(q.x - p.x, q.y - p.y);
            audit.nearestPerson = Math.min(audit.nearestPerson, d / m(1));
            if (d < PERSON) audit.personOverlap += DT;
          }
        }
      }

      // ---- smoothness
      const now = velocityOf(t, 6), before = velocityOf(t, 6, 6);
      if (now && before && walking) {
        const s0 = Math.hypot(before.x, before.y), s1 = Math.hypot(now.x, now.y);
        if (s0 > m(0.4) && s1 > m(0.4)) {
          const turn = Math.abs(Math.atan2(before.x * now.y - before.y * now.x, before.x * now.x + before.y * now.y));
          if (turn > 0.6) audit.abruptTurns++;
        }
      }

      // ---- stuck: against where the body was two seconds ago
      if (tick % 30 === 0) { t.sx[t.sn % 5] = p.x; t.sy[t.sn % 5] = p.y; t.sn++; }
      if (walking && !queued(sim, p) && t.sn >= 5) {
        const k = (t.sn - 5) % 5;
        const moved = Math.hypot(p.x - t.sx[k]!, p.y - t.sy[k]!);
        if (moved < m(0.25)) {
          audit.stuckSeconds += DT;
          if (t.stuckFor === 0) audit.stuckSpells++;
          t.stuckFor += DT;
          audit.longestStuck = Math.max(audit.longestStuck, t.stuckFor);
        } else t.stuckFor = 0;
      } else t.stuckFor = 0;

      // ---- avoidance: collision courses with furniture and with people
      const vel = velocityOf(t, 12);
      if (!vel || !walking || seated) continue;
      const speed = Math.hypot(vel.x, vel.y);
      const consider = (id: string, dx: number, dy: number, rvx: number, rvy: number, r: number,
        distance: number, furniture: boolean): void => {
        const time = ttc(dx, dy, rvx, rvy, r);
        const e = episodes.get(id);
        if (e) seenEpisodes.add(id);
        if (!e) {
          if (time <= HORIZON && time > 0 && speed > m(0.3)) {
            episodes.set(id, { minTtc: time, lastTtc: time, lastDistance: distance, furniture, seen: tick });
            seenEpisodes.add(id);
          }
          return;
        }
        if (time === 0) { close(id, e, 'contact'); return; }
        if (speed < m(0.15)) { close(id, e, 'stopped'); return; }
        if (time > HORIZON + 0.5) { close(id, e, 'resolved'); return; }
        e.minTtc = Math.min(e.minTtc, time);
        e.lastTtc = time;
        e.lastDistance = distance;
      };
      for (const i of nearFurniture) {
        const item = items[i]!;
        const distance = edgeDistance(item, p.x, p.y);
        if (distance > m(6)) continue;
        let best = Infinity;
        for (const d of discs[i]!) best = Math.min(best, ttc(d.x - p.x, d.y - p.y, -vel.x, -vel.y, d.r + BODY));
        const id = `${p.id}:f${i}`;
        // Reuse the generic path with the best disc's time folded in.
        const e = episodes.get(id);
        if (e) seenEpisodes.add(id);
        if (!e) {
          if (best <= HORIZON && best > 0 && speed > m(0.3)) {
            episodes.set(id, { minTtc: best, lastTtc: best, lastDistance: distance, furniture: true, seen: tick });
            seenEpisodes.add(id);
          }
          continue;
        }
        if (best === 0) { close(id, e, 'contact'); continue; }
        if (speed < m(0.15)) { close(id, e, 'stopped'); continue; }
        if (best > HORIZON + 0.5) { close(id, e, 'resolved'); continue; }
        e.minTtc = Math.min(e.minTtc, best);
        e.lastTtc = best;
        e.lastDistance = distance;
      }
      for (const q of neighbours) {
        const tq = tracks.get(q.id);
        const vq = tq ? velocityOf(tq, 12) : null;
        if (!vq) continue;
        const dx = q.x - p.x, dy = q.y - p.y;
        if (dx * dx + dy * dy > m(8) * m(8)) continue;
        consider(`${p.id}:p${q.id}`, dx, dy, vq.x - vel.x, vq.y - vel.y, 2 * BODY,
          Math.hypot(dx, dy) - 2 * BODY, false);
      }
    }
    // Anybody out of sight of what they were on course with has passed it.
    for (const [id, e] of episodes) if (!seenEpisodes.has(id)) close(id, e, 'resolved');
  });
  for (const [id, e] of episodes) close(id, e, 'resolved');

  audit.resolveTtcMedian = median(resolveTtc);
  audit.resolveTtcP10 = median(resolveTtc, 0.1);
  audit.furnitureResolveDistance = median(resolveDistance);
  audit.abruptPerMinute = audit.abruptTurns / Math.max(1e-9, audit.walkingSeconds / 60);
  return audit;
}

/** A one-line-per-metric report. */
export function formatAudit(name: string, a: PedAudit): string {
  const pct = (x: number, of: number): string => `${(100 * x / Math.max(1e-9, of)).toFixed(3)} %`;
  const off = Object.entries(a.offBy).sort((x, y) => y[1] - x[1]).slice(0, 8)
    .map(([k, v]) => `${k}=${v.toFixed(1)}s`).join(' ');
  return [
    `== ${name}: ${a.pedSeconds.toFixed(0)} ped-s, ${a.walkingSeconds.toFixed(0)} walking-s`,
    `off walkable ${a.offWalkable.toFixed(1)} s (${pct(a.offWalkable, a.pedSeconds)}): open ground ${a.openGround.toFixed(1)} s, carriageway ${a.carriageway.toFixed(1)} s; at bench ${a.atBench.toFixed(1)} s`,
    `  off by cause: ${off}`,
    `furniture: overlap ${a.furnitureOverlap.toFixed(1)} s, centre inside ${a.furnitureInside.toFixed(1)} s, nearest ${a.nearestFurniture.toFixed(3)} m`,
    `people: overlap (<0.3 m) ${a.personOverlap.toFixed(1)} pair-s, nearest ${a.nearestPerson.toFixed(3)} m`,
    `avoidance: ${a.episodes} courses; resolved early ${a.resolvedEarly}, late ${a.resolvedLate}, stopped ${a.stoppedShort}, contact ${a.contact}; last moment (<0.5 s) ${a.lastMoment}; ttc at resolution median ${a.resolveTtcMedian.toFixed(2)} s p10 ${a.resolveTtcP10.toFixed(2)} s; furniture resolved at ${a.furnitureResolveDistance.toFixed(2)} m`,
    `abrupt turns: ${a.abruptTurns} ticks (${a.abruptPerMinute.toFixed(2)}/walking-min)`,
    `stuck: ${a.stuckSeconds.toFixed(1)} s in ${a.stuckSpells} spells, longest ${a.longestStuck.toFixed(1)} s`,
    `crossings: ${a.crossingEntries} entries, ${a.redEntries} without WALK`,
    `vehicles: in a moving vehicle's path ${a.vehiclePath.toFixed(1)} s, touching a body ${a.vehicleContact.toFixed(1)} s`,
  ].join('\n');
}
