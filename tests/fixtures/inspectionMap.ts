import { RoadDoc } from '@world/doc';
import type { NodeId, SegmentId } from '@world/ids';

/**
 * THE INSPECTION MAP: every situation a vehicle or a pedestrian has to sit
 * right on, in one document, for the contact tests and the harness shots.
 *
 *  - `slope`: a street over a hill, climbing, cresting and descending (grade
 *    change), crossed at its foot by a signalised junction whose footways
 *    lie on the slope;
 *  - `crossfall`: a street along a hillside, the ground rising to one side;
 *  - `bridge`: a bridge over a river;
 *  - `elevated`: an elevated road ramping up from grade and down again;
 *  - `tunnel`: a tunnel through a hill;
 *  - `acute`: a junction of two streets at 32 degrees.
 *
 * Built through the document's public API, so it is geometry the editor can
 * make. Imported by node tests and, through the dev server, by the page.
 */
export interface InspectionMap {
  readonly doc: RoadDoc;
  readonly segments: Readonly<Record<'slope' | 'crossfall' | 'bridge' | 'elevated' | 'tunnel' | 'acuteA' | 'acuteB' | 'cross', SegmentId>>;
  readonly nodes: Readonly<Record<'signal' | 'acute', NodeId>>;
}

export function buildInspectionMap(doc = new RoadDoc()): InspectionMap {
  const road = (a: { x: number; y: number }, b: { x: number; y: number }, type: number): { id: SegmentId; a: NodeId; b: NodeId } => {
    const na = doc.addNode(a);
    const nb = doc.addNode(b);
    const seg = doc.addSegment(na.id, nb.id, type);
    if (!seg) throw new Error('inspection map: segment refused');
    return { id: seg.id, a: na.id, b: nb.id };
  };

  // ---- slope: a hill centred on x = -500, a street straight over it.
  const west = doc.addNode({ x: -1300, y: 0 });
  const signal = doc.addNode({ x: -1000, y: 0 });
  const east = doc.addNode({ x: 100, y: 0 });
  const slopeA = doc.addSegment(west.id, signal.id, 2);
  const slope = doc.addSegment(signal.id, east.id, 2);
  const north = doc.addNode({ x: -1000, y: -300 });
  const south = doc.addNode({ x: -1000, y: 300 });
  const cross = doc.addSegment(north.id, signal.id, 2);
  doc.addSegment(signal.id, south.id, 2);
  if (!slopeA || !slope || !cross) throw new Error('inspection map: slope refused');
  doc.setNodeControl(signal.id, 'signal');
  for (let i = 0; i < 7; i++) {
    doc.addTerrainStamp({ x: -760 + i * 70, y: 0, radius: 240, strength: 9, mode: 'raise' });
  }

  // ---- crossfall: a street along a hillside at y = 700.
  const crossfall = road({ x: -1300, y: 700 }, { x: -200, y: 700 }, 2);
  for (let i = 0; i < 8; i++) {
    doc.addTerrainStamp({ x: -1250 + i * 140, y: 860, radius: 230, strength: 10, mode: 'raise' });
  }

  // ---- bridge over a river at x = 800.
  const bridge = road({ x: 500, y: 0 }, { x: 1100, y: 0 }, 2);
  doc.setSegmentStructure(bridge.id, 'bridge');
  for (let i = 0; i < 9; i++) {
    doc.addTerrainStamp({ x: 800, y: -400 + i * 100, radius: 70, strength: 8, mode: 'river' });
  }

  // ---- elevated road at y = -700, joining at grade at both ends.
  const eWest = doc.addNode({ x: 300, y: -700 });
  const eA = doc.addNode({ x: 500, y: -700 });
  const eB = doc.addNode({ x: 1100, y: -700 });
  const eEast = doc.addNode({ x: 1300, y: -700 });
  doc.addSegment(eWest.id, eA.id, 2);
  const elevated = doc.addSegment(eA.id, eB.id, 2);
  doc.addSegment(eB.id, eEast.id, 2);
  if (!elevated) throw new Error('inspection map: elevated refused');
  doc.setSegmentStructure(elevated.id, 'elevated');

  // ---- tunnel at y = 700, east side.
  const tunnel = road({ x: 200, y: 700 }, { x: 1400, y: 700 }, 2);
  doc.setSegmentStructure(tunnel.id, 'tunnel');
  for (let i = 0; i < 6; i++) {
    doc.addTerrainStamp({ x: 670 + i * 52, y: 700, radius: 260, strength: 22, mode: 'raise' });
  }

  // ---- acute junction at (-500, -800).
  const acute = doc.addNode({ x: -500, y: -800 });
  const farA = doc.addNode({ x: 100, y: -800 });
  const angle = (32 * Math.PI) / 180;
  const farB = doc.addNode({ x: -500 + Math.cos(angle) * 600, y: -800 - Math.sin(angle) * 600 });
  const farC = doc.addNode({ x: -1100, y: -800 });
  const acuteA = doc.addSegment(acute.id, farA.id, 2);
  const acuteB = doc.addSegment(acute.id, farB.id, 2);
  doc.addSegment(farC.id, acute.id, 2);
  if (!acuteA || !acuteB) throw new Error('inspection map: acute refused');

  return {
    doc,
    segments: { slope: slope.id, crossfall: crossfall.id, bridge: bridge.id, elevated: elevated.id, tunnel: tunnel.id,
      acuteA: acuteA.id, acuteB: acuteB.id, cross: cross.id },
    nodes: { signal: signal.id, acute: acute.id },
  };
}
