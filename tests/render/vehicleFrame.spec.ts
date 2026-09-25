import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Network } from '@world/network';
import { LaneletGraph } from '@world/lanelets';
import { buildRoadElevation } from '@world/elevation';
import { sampleTerrainHeight } from '@world/terrain';
import { ARCHETYPES } from '@sim/vehicles/archetypes';
import { axleStations } from '@render/vehicleModels';
import { framePoint, roadFrame } from '@render/vehicleFrame';
import { m } from '@world/units';
import { buildInspectionMap } from '../fixtures/inspectionMap';

/**
 * EVERY WHEEL ON THE ROAD, ON EVERY KIND OF ROAD.
 *
 * On the inspection map - a hill with a crest, a hillside, a bridge, an
 * elevated road with its ramps, a tunnel, an acute junction - each road
 * vehicle is set down along every lane, and each of its four wheel contacts
 * must be within 2 cm of its own road's surface. The height is the road's,
 * never the ground's: a bridge or a bore is what it rides on.
 */
const TOLERANCE = m(0.02);

describe('vehicle frame', () => {
  const map = buildInspectionMap();
  const net = new Network(map.doc);
  net.rebuild();
  const stamps = map.doc.terrainStamps;
  const elevation = buildRoadElevation(net, (x, y) => sampleTerrainHeight(stamps, x, y));
  const graph = new LaneletGraph();
  graph.build(map.doc, net);

  it('puts all four wheels within 2 cm of the road, on slopes, crossfall, bridge, elevated and tunnel', () => {
    const worst: { error: number; where: string }[] = [];
    let checked = 0;
    for (const lane of graph.lanelets.values()) {
      if (lane.kind !== 'link' || lane.segment === undefined) continue;
      const seg = lane.segment;
      const heightAt = (x: number, y: number): number => elevation.onSegment(seg, x, y);
      for (const a of ARCHETYPES) {
        if (a.shape === 'motorcycle' || a.shape === 'bicycle') continue;
        const axles = axleStations(a);
        const front = axles[0]!;
        const rear = axles[axles.length - 1]!;
        const tread = a.width * 0.14;
        const track = a.width * 0.5 - tread * 0.5;
        for (let s = a.length; s < lane.length - a.length; s += 3) {
          const f = lane.centre.sampleAt(s);
          const heading = Math.atan2(f.t.y, f.t.x);
          const frame = roadFrame(heightAt, f.p.x, f.p.y, heading, front, rear, track, heightAt(f.p.x, f.p.y));
          for (const along of [front, rear]) {
            for (const side of [track, -track]) {
              const c = framePoint(frame, f.p.x, f.p.y, heading, along, side);
              const error = Math.abs(c.h - heightAt(c.x, c.y));
              checked++;
              if (error > TOLERANCE) worst.push({ error: +error.toFixed(3), where: `${a.id} seg ${seg} s ${s.toFixed(0)}` });
            }
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(5000);
    worst.sort((p, q) => q.error - p.error);
    expect(worst.slice(0, 8)).toEqual([]);
  });

  it('really climbs: the slope, the elevated ramps and the bridge are not flat', () => {
    const pitchOn = (seg: number): number => {
      let most = 0;
      for (const lane of graph.lanelets.values()) {
        if (lane.kind !== 'link' || lane.segment !== seg) continue;
        for (let s = 10; s < lane.length - 10; s += 5) {
          const f = lane.centre.sampleAt(s);
          const frame = roadFrame((x, y) => elevation.onSegment(seg as never, x, y), f.p.x, f.p.y,
            Math.atan2(f.t.y, f.t.x), 6, -6, 3, 0);
          most = Math.max(most, Math.abs(frame.pitch));
        }
      }
      return most;
    };
    expect(pitchOn(map.segments.slope)).toBeGreaterThan(0.02);
  });

  it('places every part of a vehicle through its one transform', () => {
    // No part computes its own height: place, the steering wheel and the
    // seats all go through `toWorld`, which applies the vehicle's quaternion.
    const source = readFileSync('src/render/agents.ts', 'utf8');
    for (const fn of ['const place = (', 'const placeSteeringWheel = (', 'const seatWorldInto = (']) {
      const start = source.indexOf(fn);
      expect(start, fn).toBeGreaterThan(0);
      const body = source.slice(start, source.indexOf('\n  };', start));
      expect(body, fn).toContain('toWorld(');
      expect(body, fn).not.toMatch(/fdeck \+/);
    }
  });
});
