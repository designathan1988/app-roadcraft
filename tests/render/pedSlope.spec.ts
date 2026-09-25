import { describe, expect, it } from 'vitest';
import { Matrix4, Vector3 } from 'three';
import { Network } from '@world/network';
import { buildRoadElevation } from '@world/elevation';
import { FOOTWAY_RISE, roadType, sidewalkHalf } from '@world/roadTypes';
import { sampleTerrainHeight } from '@world/terrain';
import { m } from '@world/units';
import { groundGradient, shearMatrix, shearedHeight } from '@render/groundShear';
import { buildInspectionMap } from '../fixtures/inspectionMap';

/**
 * BOTH FEET ON A SLOPED FOOTWAY. Along the footways of the inspection map's
 * hill and hillside, a walker's feet - half a stride ahead and behind, a hip
 * apart - must stand within 1 cm of the paving. Set down level at the height
 * under its centre, as before, one foot sank and the other floated by up to
 * the gradient times half a stride.
 */
const TOLERANCE = m(0.01);
const HALF_STRIDE = m(0.38);
const HIP = m(0.12);

describe('pedestrian feet on a slope', () => {
  const map = buildInspectionMap();
  const net = new Network(map.doc);
  net.rebuild();
  const elevation = buildRoadElevation(net, (x, y) => sampleTerrainHeight(map.doc.terrainStamps, x, y));

  it('stands both feet on the footway on the hill and on the hillside', () => {
    let checked = 0;
    let levelWorst = 0;
    const bad: string[] = [];
    for (const seg of [map.segments.slope, map.segments.crossfall]) {
      const line = net.polylines.get(map.doc, seg);
      const segment = map.doc.segment(seg)!;
      const offset = sidewalkHalf(roadType(segment.type)) - roadType(segment.type).sidewalk / 2;
      const paving = (x: number, y: number): number => elevation.onSegment(seg, x, y) + FOOTWAY_RISE;
      for (let s = 60; s < line.length - 60; s += 5) {
        const f = line.sampleAt(s);
        for (const side of [1, -1]) {
          const x = f.p.x + f.n.x * offset * side;
          const y = f.p.y + f.n.y * offset * side;
          const h = paving(x, y);
          const g = groundGradient((px, py) => elevation.onSegment(seg, px, py), x, y, h - FOOTWAY_RISE);
          for (const heading of [Math.atan2(f.t.y, f.t.x), Math.atan2(-f.t.y, -f.t.x)]) {
            const ux = Math.cos(heading), uy = Math.sin(heading);
            for (const along of [HALF_STRIDE, -HALF_STRIDE]) {
              for (const across of [HIP, -HIP]) {
                const fx = x + ux * along - uy * across;
                const fy = y + uy * along + ux * across;
                const error = Math.abs(shearedHeight(g, x, y, h, fx, fy) - paving(fx, fy));
                levelWorst = Math.max(levelWorst, Math.abs(h - paving(fx, fy)));
                checked++;
                if (error > TOLERANCE) bad.push(`seg ${seg} s ${s} err ${error.toFixed(3)}`);
              }
            }
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(1000);
    // The hill is steep enough that standing level would put a foot out.
    expect(levelWorst).toBeGreaterThan(TOLERANCE * 2);
    expect(bad.slice(0, 10)).toEqual([]);
  });

  it('shears the instance matrix exactly as shearedHeight says', () => {
    const g = { gx: 0.1, gy: -0.07 };
    const matrix = new Matrix4().makeTranslation(40, 3, -25);
    shearMatrix(matrix, g, 40, -25);
    // A foot 2 units ahead in world x and 1 in world y (three: -Z) of the centre.
    const foot = new Vector3(2, 0, -1).applyMatrix4(matrix);
    expect(foot.y).toBeCloseTo(shearedHeight(g, 40, 25, 3, 42, 26), 9);
    expect(foot.x).toBeCloseTo(42, 9);
    expect(foot.z).toBeCloseTo(-26, 9);
  });
});
