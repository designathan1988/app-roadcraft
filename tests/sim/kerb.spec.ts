import { describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';

import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { SimWorld } from '@sim/world';
import { step } from '@sim/pipeline';
import { pedPose, vehiclePose } from '@sim/pose';
import { DT } from '@sim/params';
import { spawnVehicle } from '@sim/vehicles/spawn';
import { stepLaneChange } from '@sim/vehicles/laneChange';
import { integrateAll } from '@sim/vehicles/integrate';
import { snapshot } from '@sim/vehicles/state';
import { Level } from '@world/roadTypes';
import { levelPolygons } from '@world/surfaces';
import { pointInPolygon } from '@core/polygon';
import type { MultiPoly } from '@core/clipper';
import type { Vec2 } from '@core/vec2';

/**
 * NOBODY DRIVES ON THE PAVEMENT.
 *
 * The turning path itself was never in doubt — a connector is a Bézier through
 * the junction and the arc is right. What was never checked is the thing the
 * player actually sees: whether the BODY of a vehicle, with its real length
 * and width and at the angle it is really drawn at, stays on the asphalt for
 * the whole of a run.
 *
 * That is a different question from "is the centreline correct", and it is the
 * one that catches a lane too close to the kerb, a connector whose curve is
 * tighter than the vehicle taking it, and a lane-change lean that swings a
 * long vehicle's tail out. A long bus on a tight turn is the worst case and it
 * is deliberately in the fleet here.
 *
 * The surface is taken from `world/surfaces.ts` — the same carriageway polygon
 * the mesh is built from, so this measures against what is drawn rather than
 * against a reconstruction of it.
 */

function city(): SimWorld {
  const doc = new RoadDoc();
  // A cross and a T, with different classes meeting, so the turns include
  // tight ones between roads of unequal width.
  const centre = doc.addNode({ x: 0, y: 0 });
  const north = doc.addNode({ x: 0, y: 420 });
  const south = doc.addNode({ x: 0, y: -420 });
  const east = doc.addNode({ x: 460, y: 0 });
  const west = doc.addNode({ x: -460, y: 0 });

  doc.addSegment(south.id, centre.id, 3);
  doc.addSegment(centre.id, north.id, 3);
  doc.addSegment(west.id, centre.id, 1);
  doc.addSegment(centre.id, east.id, 2);
  doc.setNodeControl(centre.id, 'signal');

  // A second junction, so there are through routes and a T.
  const far = doc.addNode({ x: 460, y: 420 });
  doc.addSegment(east.id, far.id, 2);
  doc.addSegment(far.id, north.id, 1);

  const net = new Network(doc);
  net.rebuild();
  const sim = new SimWorld(doc, net, 0x7a1e);
  sim.rebuildTopology();
  sim.trafficIntensity = 2;
  sim.demandMultiplier = 2;
  sim.clock.paused = false;
  return sim;
}

/** Whether a point is inside any ring of a level, holes excluded. */
function onSurface(mp: MultiPoly, p: Vec2): boolean {
  for (const poly of mp) {
    const outer = poly[0];
    if (!outer) continue;
    if (!pointInPolygon(p, outer.map(([x, y]) => ({ x: x as number, y: y as number })))) continue;
    // A hole means the point is in the gap, not on the surface.
    let inHole = false;
    for (let i = 1; i < poly.length; i++) {
      const hole = poly[i];
      if (!hole) continue;
      if (pointInPolygon(p, hole.map(([x, y]) => ({ x: x as number, y: y as number })))) {
        inHole = true;
        break;
      }
    }
    if (!inHole) return true;
  }
  return false;
}

describe('the kerb', () => {
  it('rejects a stale lane-change target on a different street', () => {
    const sim = city();
    expect(spawnVehicle(sim)).toBe(true);
    const vehicle = sim.vehicles.get(1)!;
    const lane = sim.lanelet(vehicle.lanelet)!;
    const elsewhere = [...sim.graph.lanelets.values()].find(candidate =>
      candidate.kind === 'link' && candidate.segment !== lane.segment && candidate.length > vehicle.s + 20)!;
    vehicle.desiredLane = elsewhere.id;
    stepLaneChange(sim);
    expect(vehicle.laneChange).toBeNull();
    expect(vehicle.desiredLane).toBeNull();
    expect(vehicle.lanelet).toBe(lane.id);
  });

  it('drops an old approach-lane request when entering the next street', () => {
    const sim = city();
    expect(spawnVehicle(sim)).toBe(true);
    const vehicle = sim.vehicles.get(1)!;
    const connectorId = sim.graph.exitsOf(vehicle.lanelet)[0]!;
    const connector = sim.connector(connectorId)!;
    const path = sim.lanelet(connectorId)!;
    sim.exitLanelet(vehicle, vehicle.lanelet);
    vehicle.lanelet = connectorId;
    vehicle.s = path.length - 0.05;
    vehicle.v = path.speedLimit;
    vehicle.route = [connectorId, connector.toLane];
    vehicle.desiredLane = connector.fromLane;
    vehicle.prev = snapshot(vehicle);
    sim.enterLanelet(vehicle, connectorId);
    integrateAll(sim);
    expect(vehicle.lanelet).toBe(connector.toLane);
    expect(vehicle.desiredLane).toBeNull();
  });

  it('spawns the full body on the road with its front at the physical arc position', () => {
    const sim = city();
    expect(spawnVehicle(sim)).toBe(true);
    const vehicle = sim.vehicles.get(1)!;
    const lane = sim.lanelet(vehicle.lanelet)!;
    const pose = vehiclePose(sim, vehicle, 1)!;
    const front = lane.centre.sampleAt(vehicle.s);
    const bodyFront = {
      x: pose.p.x + Math.cos(pose.angle) * vehicle.archetype.length / 2,
      y: pose.p.y + Math.sin(pose.angle) * vehicle.archetype.length / 2,
    };
    expect(vehicle.s - vehicle.archetype.length).toBeGreaterThan(0);
    expect(Math.hypot(bodyFront.x - front.p.x, bodyFront.y - front.p.y)).toBeLessThan(1e-6);
    const asphalt = levelPolygons(sim.net, Level.Asphalt);
    for (const along of [-1, 1]) for (const across of [-1, 1]) {
      const corner = { x: pose.p.x + along * vehicle.archetype.length / 2 * Math.cos(pose.angle)
        - across * vehicle.archetype.width / 2 * Math.sin(pose.angle),
      y: pose.p.y + along * vehicle.archetype.length / 2 * Math.sin(pose.angle)
        + across * vehicle.archetype.width / 2 * Math.cos(pose.angle) };
      expect(onSurface(asphalt, corner)).toBe(true);
    }
  });

  it('is never crossed by a vehicle, corner by corner, for a whole run', () => {
    const sim = city();
    // The surface never changes: nothing edits the network during the run.
    const asphalt = levelPolygons(sim.net, Level.Asphalt);
    const kerb = levelPolygons(sim.net, Level.Curb);

    let worst = 0;
    let detail = '';
    let checked = 0;
    const categories = new Map<string, { count: number; sample: unknown }>();
    const lateralEvents: unknown[] = [];
    const lateralReported = new Set<number>();

    sim.clock.run(Math.round(200 / DT), () => {
      step(sim, { traffic: true, pedestrians: true });

      for (const v of sim.vehiclesInIdOrder()) {
        if (Math.abs(v.lateral) > 14 && !lateralReported.has(v.id)) {
          lateralReported.add(v.id);
          if (lateralEvents.length < 12) {
            const lane = sim.lanelet(v.lanelet), before = sim.lanelet(v.prev.lanelet);
            lateralEvents.push({ tick: sim.clock.tick, id: v.id, archetype: v.archetype.id,
              previous: v.prev, current: { lane: v.lanelet, s: v.s, lateral: v.lateral },
              from: before && { id: before.id, segment: before.segment, from: before.from,
                to: before.to, laneIndex: before.laneIndex, point: before.centre.sampleAt(v.prev.s).p },
              target: lane && { id: lane.id, segment: lane.segment, from: lane.from,
                to: lane.to, laneIndex: lane.laneIndex, point: lane.centre.sampleAt(v.s).p },
              desiredLane: v.desiredLane, route: v.route.slice(0, 5) });
          }
        }
        const pose = vehiclePose(sim, v, 1);
        if (!pose) continue;

        const half = v.archetype.length / 2;
        const side = v.archetype.width / 2;
        const cos = Math.cos(pose.angle);
        const sin = Math.sin(pose.angle);

        for (const along of [half, -half]) {
          for (const across of [side, -side]) {
            const corner = {
              x: pose.p.x + cos * along - sin * across,
              y: pose.p.y + sin * along + cos * across,
            };
            checked++;
            if (onSurface(asphalt, corner)) continue;
            // The kerb band is the face between carriageway and footway. A
            // corner overhanging it is a wing mirror over the kerb, not a
            // wheel on the pavement, and a real vehicle does that.
            if (onSurface(kerb, corner)) continue;

            worst++;
            const lane = sim.lanelet(v.lanelet)!;
            const category = lane.kind === 'connector' ? `connector:${lane.turn}:${v.archetype.id}`
              : v.s < v.archetype.length ? `link-entry:${v.archetype.id}`
                : lane.length - v.s < v.archetype.length ? `link-exit:${v.archetype.id}`
                  : Math.abs(v.lateral) > 0 ? `lane-change:${v.archetype.id}` : `link:${v.archetype.id}`;
            const recorded = categories.get(category);
            if (recorded) recorded.count++;
            else categories.set(category, { count: 1, sample: {
              tick: sim.clock.tick, id: v.id, lanelet: lane.id, s: v.s,
              length: lane.length, lateral: v.lateral, corner, pose,
              fromLane: lane.fromLane, toLane: lane.toLane,
              centreline: lane.centre.toPoints(),
            } });
            if (!detail) {
              detail =
                `vehicle ${v.id} (${v.archetype.id}) put a corner at ` +
                `${corner.x.toFixed(1)},${corner.y.toFixed(1)} off the carriageway`;
            }
          }
        }
      }
    });

    expect(checked).toBeGreaterThan(10_000);
    if (process.env['ROADCRAFT_RECORD_CONTAINMENT'] === '1') {
      writeFileSync('docs/audit/vehicle-containment-baseline.json', JSON.stringify({
        checked, violations: worst, categories: Object.fromEntries(categories), lateralEvents,
      }, null, 2) + '\n');
    }
    expect(worst, detail).toBe(0);
  });

  it('keeps pedestrians off the carriageway except where they may cross', () => {
    // The mirror of the same rule. A pedestrian on the asphalt is either on a
    // crossing or is a defect, and `crossingFsm` is what decides which — so
    // this asserts only that one who is NOT crossing stays off it.
    const sim = city();
    const asphalt = levelPolygons(sim.net, Level.Asphalt);

    let offences = 0;
    let detail = '';

    sim.clock.run(Math.round(200 / DT), () => {
      step(sim, { traffic: true, pedestrians: true });

      for (const ped of sim.pedsInIdOrder()) {
        // Only somebody walking along a footway. Crossing, approaching a kerb
        // and clearing one are all states in which being on the asphalt is
        // the correct thing to be doing.
        if (ped.state !== 'Walking') continue;
        const pose = pedPose(sim, ped, 1);
        if (!pose) continue;
        if (!onSurface(asphalt, pose.p)) continue;
        offences++;
        if (!detail) {
          detail =
            `pedestrian ${ped.id} walked onto the carriageway at ` +
            `${pose.p.x.toFixed(1)},${pose.p.y.toFixed(1)}`;
        }
      }
    });

    expect(offences, detail).toBe(0);
  });
});
