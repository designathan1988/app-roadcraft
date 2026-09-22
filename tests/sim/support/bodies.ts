import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { RoadDoc } from '@world/doc';
import type { NodeId } from '@world/ids';
import { Network } from '@world/network';
import { SimWorld } from '@sim/world';
import { vehiclePose } from '@sim/pose';
import type { Vehicle } from '@sim/vehicles/state';
import type { Vec2 } from '@core/vec2';

/**
 * Shared harness for measuring what the player actually sees: two vehicle
 * BODIES occupying the same piece of road at the same instant.
 *
 * Every other safety check in the suite asks a proxy question — is a conflict
 * point claimed, is the arc gap positive, is the lanelet order monotone. A
 * collision is none of those; it is two rectangles, at their real length,
 * width and drawn angle, overlapping. This module answers that directly, so a
 * proxy that is right on paper and wrong on screen cannot hide behind itself.
 */

export interface Body {
  readonly vehicle: Vehicle;
  readonly c: Vec2;
  /** Unit heading. */
  readonly u: Vec2;
  readonly halfLength: number;
  readonly halfWidth: number;
}

/**
 * Overlap tolerance, in world units, removed from each half-dimension.
 *
 * 0.1 u is 4 cm: two bodies touching paint to paint are not a collision, and a
 * floating-point sliver at a bumper is not one either.
 */
export const BODY_TOLERANCE = 0.1;

export function bodyOf(w: SimWorld, v: Vehicle): Body | null {
  const pose = vehiclePose(w, v, 1);
  if (!pose) return null;
  return {
    vehicle: v,
    c: pose.p,
    u: { x: Math.cos(pose.angle), y: Math.sin(pose.angle) },
    halfLength: v.archetype.length / 2 - BODY_TOLERANCE,
    halfWidth: v.archetype.width / 2 - BODY_TOLERANCE,
  };
}

/** Separating-axis test between two oriented rectangles. */
export function bodiesOverlap(a: Body, b: Body): boolean {
  const dx = b.c.x - a.c.x;
  const dy = b.c.y - a.c.y;
  for (const axis of [a.u, { x: -a.u.y, y: a.u.x }, b.u, { x: -b.u.y, y: b.u.x }]) {
    const distance = Math.abs(dx * axis.x + dy * axis.y);
    const ra = projectedRadius(a, axis);
    const rb = projectedRadius(b, axis);
    if (distance >= ra + rb) return false;
  }
  return true;
}

function projectedRadius(body: Body, axis: Vec2): number {
  const along = Math.abs(body.u.x * axis.x + body.u.y * axis.y);
  const across = Math.abs(-body.u.y * axis.x + body.u.x * axis.y);
  return body.halfLength * along + body.halfWidth * across;
}

export interface Collision {
  readonly a: Vehicle;
  readonly b: Vehicle;
  readonly category: string;
}

/**
 * Every overlapping pair of vehicle bodies at this instant.
 *
 * A uniform grid keeps it linear in the fleet size; the cell is larger than the
 * longest body, so only neighbouring cells need testing.
 */
export function collisions(w: SimWorld): Collision[] {
  const cell = 40;
  const grid = new Map<string, Body[]>();
  const bodies: Body[] = [];
  for (const v of w.vehiclesInIdOrder()) {
    const body = bodyOf(w, v);
    if (!body) continue;
    bodies.push(body);
    const key = `${Math.floor(body.c.x / cell)},${Math.floor(body.c.y / cell)}`;
    const list = grid.get(key);
    if (list) list.push(body);
    else grid.set(key, [body]);
  }

  const out: Collision[] = [];
  for (const a of bodies) {
    const cx = Math.floor(a.c.x / cell);
    const cy = Math.floor(a.c.y / cell);
    for (let ix = cx - 1; ix <= cx + 1; ix++) {
      for (let iy = cy - 1; iy <= cy + 1; iy++) {
        for (const b of grid.get(`${ix},${iy}`) ?? []) {
          if (b.vehicle.id <= a.vehicle.id) continue;
          if (!bodiesOverlap(a, b)) continue;
          out.push({ a: a.vehicle, b: b.vehicle, category: categorise(w, a.vehicle, b.vehicle) });
        }
      }
    }
  }
  return out;
}

/** Why two bodies are allowed to be near each other at all, as a label. */
export function categorise(w: SimWorld, a: Vehicle, b: Vehicle): string {
  const la = w.lanelet(a.lanelet);
  const lb = w.lanelet(b.lanelet);
  if (Math.abs(a.lateral) > 0.02 || Math.abs(b.lateral) > 0.02) return 'lane-change';
  if (a.lanelet === b.lanelet) return 'same-lanelet';
  const aPath = [a.lanelet, ...a.rearPath.slice(0, 3)];
  const bPath = [b.lanelet, ...b.rearPath.slice(0, 3)];
  if (aPath.some((id) => bPath.includes(id))) return 'shared-path';
  if (la?.kind === 'connector' || lb?.kind === 'connector') {
    const turns = [la?.turn ?? 'link', lb?.turn ?? 'link'].sort().join('/');
    return `junction:${turns}`;
  }
  const aConnector = a.rearPath.slice(0, 3).some((id) => w.lanelet(id)?.kind === 'connector');
  const bConnector = b.rearPath.slice(0, 3).some((id) => w.lanelet(id)?.kind === 'connector');
  if (aConnector || bConnector) return 'junction-exit';
  return 'link';
}

// ------------------------------------------------------------------ scenarios

export interface Layout {
  readonly name: string;
  readonly bearings: readonly number[];
  readonly types: readonly number[];
  readonly lanes?: readonly number[];
  readonly oneWay?: boolean;
}

/**
 * The junction shapes every physical-conflict measurement runs against. The
 * same five the connector-footprint test uses, plus a mixed-lane-count cross.
 */
export const LAYOUTS: readonly Layout[] = [
  { name: 'four-way-avenues', bearings: [0, 90, 180, 270], types: [3, 3, 3, 3] },
  { name: 'mixed-T', bearings: [0, 90, 180], types: [2, 1, 3] },
  { name: 'skewed', bearings: [0, 67, 175, 257], types: [1, 2, 3, 2] },
  { name: 'five-leg', bearings: [0, 68, 145, 218, 293], types: [2, 1, 3, 2, 1] },
  { name: 'one-way-mix', bearings: [0, 90, 180, 270], types: [2, 3, 1, 2], oneWay: true },
  { name: 'mixed-lanes', bearings: [0, 90, 180, 270], types: [3, 2, 3, 2], lanes: [3, 1, 2, 2] },
];

export function layoutDoc(layout: Layout, radius = 420): { doc: RoadDoc; centre: NodeId } {
  const doc = new RoadDoc();
  const centre = doc.addNode({ x: 0, y: 0 });
  layout.bearings.forEach((degrees, index) => {
    const angle = (degrees * Math.PI) / 180;
    const far = doc.addNode({ x: Math.cos(angle) * radius, y: Math.sin(angle) * radius });
    const segment = doc.addSegment(centre.id, far.id, layout.types[index] as number);
    if (!segment) throw new Error(`invalid ${layout.name} leg ${index}`);
    const lanes = layout.lanes?.[index];
    if (lanes !== undefined) doc.setSegmentLanes(segment.id, lanes);
    if (layout.oneWay && index % 2 === 0) {
      doc.setSegmentDirection(segment.id, index === 0 ? 'aToB' : 'bToA');
    }
  });
  doc.setNodeControl(centre.id, 'signal');
  return { doc, centre: centre.id };
}

export function simOf(doc: RoadDoc, seed: number, intensity = 2): SimWorld {
  const net = new Network(doc);
  net.rebuild();
  const sim = new SimWorld(doc, net, seed);
  sim.rebuildTopology();
  sim.trafficIntensity = intensity;
  sim.demandMultiplier = intensity;
  sim.clock.paused = false;
  return sim;
}

export function fixtureDoc(): RoadDoc {
  const raw = JSON.parse(
    readFileSync(join(process.cwd(), 'tests', 'fixtures', 'grid-and-bends.json'), 'utf8'),
  ) as { document: unknown };
  return RoadDoc.fromJSON(raw.document as never);
}
