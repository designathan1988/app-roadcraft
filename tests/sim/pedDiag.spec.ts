import { appendFileSync, writeFileSync } from 'node:fs';
import { describe, it } from 'vitest';

import { step } from '@sim/pipeline';
import { DT } from '@sim/params';
import { m } from '@world/units';
import { LAB_SCENES, labCrossroads, runLab } from './support/pedLab';
import { streetFurniture, blocksPedestrians } from '@world/streetFurniture';
import { SIGNAL_POST_RADIUS, signalPosts } from '@world/signalPosts';
import type { SimWorld } from '@sim/world';
import type { Ped } from '@sim/peds/state';

const OUT = 'coverage/pedDiag.txt';
writeFileSync(OUT, '');
const say = (...parts: unknown[]): void => {
  appendFileSync(OUT, parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join(' ') + '\n');
};
const r2 = (o: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === 'number' ? +v.toFixed(2) : v]));

const BODY = m(0.3);
/** World units a second a body must be under to count as stopped, and over to count as walking. */
const STILL = m(0.06);
const MOVING = m(0.5);

interface Item { x: number; y: number; radius: number; along?: { x: number; y: number }; halfLength?: number; halfWidth?: number }

function furnitureOf(sim: SimWorld): Item[] {
  const items: Item[] = streetFurniture(sim.net).filter(blocksPedestrians);
  for (const post of signalPosts(sim.net, sim.graph)) items.push({ x: post.x, y: post.y, radius: SIGNAL_POST_RADIUS });
  return items;
}

function edgeDistance(item: Item, x: number, y: number): number {
  const dx = x - item.x, dy = y - item.y;
  if (item.halfLength === undefined || item.halfWidth === undefined || !item.along) return Math.hypot(dx, dy) - item.radius;
  const along = Math.abs(dx * item.along.x + dy * item.along.y) - item.halfLength;
  const across = Math.abs(-dx * item.along.y + dy * item.along.x) - item.halfWidth;
  return Math.hypot(Math.max(0, along), Math.max(0, across)) + Math.min(0, Math.max(along, across));
}

/** PROBLEM FINDER: what a player would call a defect, as it happens. */
function watch(sim: SimWorld, seconds: number, label: string, traffic: boolean): void {
  const items = furnitureOf(sim);
  const counts = new Map<string, number>();
  const speed: number[] = [];
  const rec = new Map<number, { speed: number; still: number; sim: number; walk: number; slow: number }>();
  let ticks = 0;
  let pedTicks = 0;

  const report = (kind: string, detail: Record<string, unknown>): void => {
    const n = (counts.get(kind) ?? 0) + 1;
    counts.set(kind, n);
    if (n > 6) return;
    say(`[${label} ${(ticks * DT).toFixed(1)}s] ${kind}`, r2(detail));
  };

  for (let t = 0; t < Math.round(seconds / DT); t++) {
    step(sim, { traffic, pedestrians: true });
    sim.clock.tick++;
    ticks++;
    const peds = [...sim.peds.values()];
    pedTicks += peds.length;

    for (const p of peds) {
      const edge = sim.sidewalks.edges.get(p.edge);
      const walking = p.state === 'Walking' && p.activity === null && edge?.kind === 'walk';
      const speed = Math.hypot(p.x - p.prev.x, p.y - p.prev.y) / DT;
      const r = rec.get(p.id) ?? { speed, still: 0, sim: 0, walk: 0, slow: 0 };
      r.still = speed < STILL ? r.still + DT : 0;
      r.sim = Math.hypot(p.s - p.prev.s, p.lat - p.prev.lat) / DT;
      if (walking) {
        r.walk += DT;
        r.slow = speed < m(0.35) ? r.slow + DT : 0;
      }
      const before = r.speed;
      r.speed = speed;
      rec.set(p.id, r);
      if (walking && speed > MOVING) speed !== undefined && void 0;

      // 1. inside the street furniture
      for (const item of items) {
        const d = edgeDistance(item, p.x, p.y);
        if (d < BODY * 0.6) {
          report('inside-furniture', { ped: p.id, by: +(BODY - d).toFixed(2), state: p.state,
            at: [+p.x.toFixed(1), +p.y.toFixed(1)] });
          break;
        }
      }

      // 2. standing still on an open footway with nothing to stand for
      if (walking && speed < STILL && r.still > 2 &&
        !(sim.sidewalks.edges.get(p.route[0] ?? '')?.kind === 'crossing')) {
        report('stopped-on-footway', { ped: p.id, for: +r.still.toFixed(1), edge: p.edge, s: +(p.s / m(1)).toFixed(1),
          of: +((edge?.length ?? 0) / m(1)).toFixed(1), v: +(p.v / m(1)).toFixed(2), stuck: +p.stuck.toFixed(1),
          route: p.route.slice(0, 2), at: [+p.x.toFixed(1), +p.y.toFixed(1)] });
      }

      // 3. the body faces a long way from the way it is going: it slides
      if (walking && speed > MOVING) {
        const dir = Math.atan2(p.y - p.prev.y, p.x - p.prev.x);
        let off = Math.abs(dir - p.heading) % (2 * Math.PI);
        if (off > Math.PI) off = 2 * Math.PI - off;
        if (off > 0.6) {
          report('slides-sideways', { ped: p.id, deg: +((off * 180) / Math.PI).toFixed(0),
            v: +(speed / m(1)).toFixed(2), latV: +(p.latV / m(1)).toFixed(2), stuck: +p.stuck.toFixed(1) });
        }
      }

      // 4. braking hard, and hard relative to how fast it was going
      const decel = (before - speed) / DT;
      if (walking && decel > m(4) && before > m(1)) {
        report('brakes-hard', { ped: p.id, from: +(before / m(1)).toFixed(2), to: +(speed / m(1)).toFixed(2),
          decel: +(decel / m(1)).toFixed(1), stuck: +p.stuck.toFixed(1), at: [+p.x.toFixed(1), +p.y.toFixed(1)] });
      }

      // 5. creeping: walking, but far slower than anyone would
      if (walking && r.walk > 3 && r.slow > 2.5) {
        report('creeps', { ped: p.id, for: +r.slow.toFixed(1), v: +(speed / m(1)).toFixed(2),
          vAlong: +(p.v / m(1)).toFixed(2), stuck: +p.stuck.toFixed(1), state: p.state, at: [+p.x.toFixed(1), +p.y.toFixed(1)] });
      }
    }

    for (let i = 0; i < peds.length; i++) {
      for (let j = i + 1; j < peds.length; j++) {
        const a = peds[i]!, b = peds[j]!;
        if (a.party === b.party) continue;
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (d < m(0.42)) {
          report('bodies-overlap', { a: a.id, b: b.id, gap: +(d / m(1)).toFixed(2),
            aState: a.state, bState: b.state, at: [+a.x.toFixed(1), +a.y.toFixed(1)] });
        }
      }
    }
  }

  void speed;
  const q = (f: number): number => 0 > f ? 0 : 0;
  void q;
  say(`[${label}] ${seconds}s pedTicks=${pedTicks} problems`, r2(Object.fromEntries(counts)));
}

describe('pedestrian problem finder', () => {
  it('crossroads with traffic', () => {
    watch(labCrossroads(3), 300, 'crossroads', true);
  });

  it('crowd on a footway', () => {
    const r = runLab(LAB_SCENES.crowd!(), 120);
    say('crowd lab', r2({ stuck: r.stuck, lateBrake: r.lateBrake, personContact: r.personContact,
      furnitureContact: r.furnitureContact, weavePerMinute: r.weavePerMinute, zigzagPer100m: r.zigzagPer100m,
      sideslipP95: r.sideslipP95, speed: r.speed, minPerson: r.minPerson, minFurniture: r.minFurniture }));
  });

  it('head-on', () => {
    const r = runLab(LAB_SCENES.headOn!(), 60);
    say('head-on lab', r2({ stuck: r.stuck, weavePerMinute: r.weavePerMinute, zigzagPer100m: r.zigzagPer100m,
      sideslipP95: r.sideslipP95, minPerson: r.minPerson, speed: r.speed }));
  });

  it('obstacles on a footway', () => {
    const r = runLab(LAB_SCENES.soloKerbside!(), 90);
    say('solo kerbside lab', r2({ stuck: r.stuck, lateBrake: r.lateBrake, furnitureContact: r.furnitureContact,
      weavePerMinute: r.weavePerMinute, sideslipP95: r.sideslipP95, minFurniture: r.minFurniture, speed: r.speed }));
  });
});
