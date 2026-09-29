import { LANE_LINE, ROAD_TYPES, type RoadType } from '@world/roadTypes';

/**
 * A picture of a road class, drawn from the same numbers the meshes are built
 * from: the footway and its casing, the kerb, the carriageway, the central
 * reservation where the class has one, and the paint between the lanes.
 *
 * Off a 2D canvas rather than the 3D scene, because the palette wants these
 * before the first frame and at tile size a plan view says more than a
 * perspective. Every class shares one scale, so a boulevard's tile is visibly
 * fatter than a ramp's - the width IS the choice.
 */

const CASING = 0.9;
const MARGIN = 6;

/** World units a tile's full height covers: the widest class, plus margin. */
const MAX_SPAN = Math.max(
  ...ROAD_TYPES.map((rt) => rt.width + rt.sidewalk * 2 + CASING * 2),
);

const GRASS_TOP = '#4c6b3d';
const GRASS_BOTTOM = '#3a5432';
const CASING_COLOR = '#8f9a8d';
const FOOTWAY_COLOR = '#b3b7ad';
const MEDIAN_GREEN = '#5f7f4c';

/** Paint dashed along a line, so it reads as a marking and not as an edge. */
function dashed(ctx: CanvasRenderingContext2D, y: number, width: number, dash: number, colour: string): void {
  ctx.fillStyle = colour;
  for (let x = 0; x < width; x += dash * 2) ctx.fillRect(x, y, Math.min(dash, width - x), 1.5);
}

export function roadSwatch(rt: RoadType, width = 148, height = 78, dpr = 2): string {
  const canvas = document.createElement('canvas');
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';
  ctx.scale(dpr, dpr);

  const grass = ctx.createLinearGradient(0, 0, 0, height);
  grass.addColorStop(0, GRASS_TOP);
  grass.addColorStop(1, GRASS_BOTTOM);
  ctx.fillStyle = grass;
  ctx.fillRect(0, 0, width, height);

  const scale = (height - MARGIN * 2) / MAX_SPAN;
  const mid = height / 2;
  const band = (halfUnits: number, colour: string): void => {
    const h = halfUnits * scale;
    ctx.fillStyle = colour;
    ctx.fillRect(0, mid - h, width, h * 2);
  };

  const half = rt.width / 2;
  band(half + rt.sidewalk + CASING, CASING_COLOR);
  band(half + rt.sidewalk, FOOTWAY_COLOR);
  band(half, rt.color);

  // Kerbs: the pale line where the carriageway meets the footway.
  ctx.fillStyle = rt.curb;
  ctx.fillRect(0, mid - half * scale - 1, width, 1);
  ctx.fillRect(0, mid + half * scale, width, 1);

  if (rt.median > 0) {
    band(rt.median / 2, rt.curb);
    band(rt.median / 2 - 0.6, MEDIAN_GREEN);
  }

  // Paint: the centre line of a two-way street, the dividers between the lanes
  // of a wider one, nothing at all on a residential street.
  const lane = (rt.width - rt.median) / rt.lanes;
  const offsets: number[] = [];
  if (rt.median > 0) {
    for (let k = 1; k < rt.lanes / 2; k++) {
      const d = rt.median / 2 + lane * k;
      offsets.push(-d, d);
    }
  } else {
    for (let k = 1; k < rt.lanes; k++) offsets.push(lane * k - half);
  }
  if (rt.markings === 'center') {
    ctx.fillStyle = rt.line;
    ctx.fillRect(0, mid - 1, width, 2);
  } else if (rt.markings === 'lanes') {
    for (const offset of offsets) {
      const y = mid + offset * scale;
      if (Math.abs(offset) < 1e-6) {
        ctx.fillStyle = rt.line;
        ctx.fillRect(0, y - 1, width, 2);
      } else {
        dashed(ctx, y, width, 5, LANE_LINE);
      }
    }
  }

  return canvas.toDataURL('image/png');
}
