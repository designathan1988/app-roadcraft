import { writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { pointInPolygon } from '@core/polygon';
import type { Vec2 } from '@core/vec2';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { LaneletGraph, type Lanelet } from '@world/lanelets';
import { Level } from '@world/roadTypes';
import { levelPolygons } from '@world/surfaces';
import { ARCHETYPES } from '@sim/vehicles/archetypes';
import type { MultiPoly } from '@core/clipper';

function contains(surface: MultiPoly, point: Vec2): boolean {
  return surface.some(polygon => {
    const outer = polygon[0];
    return !!outer && pointInPolygon(point, outer.map(([x, y]) => ({ x: x!, y: y! }))) &&
      !polygon.slice(1).some(hole => pointInPolygon(point, hole.map(([x, y]) => ({ x: x!, y: y! }))));
  });
}

interface Configuration { name: string; bearings: readonly number[]; types: readonly number[];
  oneWay?: boolean }

const configurations: Configuration[] = [
  { name: 'four-way-avenues', bearings: [0, 90, 180, 270], types: [3, 3, 3, 3] },
  { name: 'mixed-T', bearings: [0, 90, 180], types: [2, 1, 3] },
  { name: 'skewed', bearings: [0, 67, 175, 257], types: [1, 2, 3, 2] },
  { name: 'five-leg', bearings: [0, 68, 145, 218, 293], types: [2, 1, 3, 2, 1] },
  { name: 'one-way-mix', bearings: [0, 90, 180, 270], types: [2, 3, 1, 2], oneWay: true },
];

function setup(config: Configuration) {
  const doc = new RoadDoc();
  const centre = doc.addNode({ x: 0, y: 0 });
  config.bearings.forEach((degrees, index) => {
    const angle = degrees * Math.PI / 180;
    const far = doc.addNode({ x: Math.cos(angle) * 420, y: Math.sin(angle) * 420 });
    const segment = doc.addSegment(centre.id, far.id, config.types[index]!);
    if (!segment) throw new Error(`Invalid ${config.name} leg ${index}`);
    if (config.oneWay && index % 2 === 0) doc.setSegmentDirection(segment.id, index === 0 ? 'aToB' : 'bToA');
  });
  doc.setNodeControl(centre.id, 'signal');
  const net = new Network(doc); net.rebuild();
  const graph = new LaneletGraph(); graph.build(doc, net);
  return { net, graph, centre: centre.id };
}

function bodyFrame(front: number, length: number, inbound: Lanelet, crossing: Lanelet, outbound: Lanelet) {
  const centre = front - length / 2;
  if (centre < 0) return inbound.centre.sampleAt(inbound.length + centre);
  if (centre <= crossing.length) return crossing.centre.sampleAt(centre);
  return outbound.centre.sampleAt(centre - crossing.length);
}

describe('physical junction movements', () => {
  it('records complete body clearance across mixed junction shapes', () => {
    const findings: { configuration: string; origin: string; fromLane: number; turn: string;
      connector: string; destination: string; toLane: number; archetype: string;
      firstOutside: Vec2 | null; path: Vec2[] }[] = [];
    let checked = 0;
    for (const config of configurations) {
      const { net, graph, centre } = setup(config);
      const asphalt = levelPolygons(net, Level.Asphalt);
      const kerb = levelPolygons(net, Level.Curb);
      for (const connector of graph.connectors.values()) {
        if (connector.node !== centre) continue;
        const inbound = graph.lanelets.get(connector.fromLane);
        const crossing = graph.lanelets.get(connector.lanelet);
        const outbound = graph.lanelets.get(connector.toLane);
        if (!inbound || !crossing || !outbound) continue;
        for (const archetype of ARCHETYPES) {
          let firstOutside: Vec2 | null = null;
          for (let sample = 0; sample <= 64; sample++) {
            const front = (crossing.length + archetype.length) * sample / 64;
            const frame = bodyFrame(front, archetype.length, inbound, crossing, outbound);
            for (const along of [-0.5, 0, 0.5]) for (const across of [-0.5, 0, 0.5]) {
              const point = { x: frame.p.x + frame.t.x * along * archetype.length
                - frame.t.y * across * archetype.width,
              y: frame.p.y + frame.t.y * along * archetype.length
                + frame.t.x * across * archetype.width };
              checked++;
              if (!contains(asphalt, point) && !contains(kerb, point) && !firstOutside) firstOutside = point;
            }
          }
          findings.push({ configuration: config.name, origin: String(inbound.segment),
            fromLane: inbound.laneIndex!, turn: connector.turn, connector: connector.id,
            destination: String(outbound.segment), toLane: outbound.laneIndex!,
            archetype: archetype.id, firstOutside, path: crossing.centre.toPoints() });
        }
      }
    }
    if (process.env['ROADCRAFT_RECORD_MOVEMENTS'] === '1') {
      writeFileSync('docs/audit/junction-body-movements.json', JSON.stringify({
        checked, movements: findings.length, findings,
      }, null, 2) + '\n');
    }
    expect(checked).toBeGreaterThan(10_000);
    expect(findings.filter(finding => finding.firstOutside).map(finding => ({
      configuration: finding.configuration, connector: finding.connector,
      archetype: finding.archetype, firstOutside: finding.firstOutside,
    })).slice(0, 15)).toEqual([]);
  });
});
