import type { Vec2 } from '@core/vec2';
import {
  bayCentreLocal,
  buildingHeight,
  footprintCentre,
  levelElevation,
  levelHeight,
  localToWorld,
  SIDE_NORMAL,
  volumeCorners,
  volumeHeight,
} from '@world/buildings/geometry';
import type { Handle } from '@world/buildings/handles';
import { type Building, type Side, volumeById } from '@world/buildings/types';
import { HOVER, INVALID, SELECTION } from './palette';

/**
 * The building tool's hairlines on the overlay canvas: the hovered and the
 * selected building, the selected volume as a wire box, the picked facade bay,
 * the drag handles and a label saying what the ghost is or what is wrong with
 * it. Everything is projected through `project`, at its real height.
 */
export interface BuildingOverlayInput {
  readonly project: (x: number, y: number, z: number) => Vec2;
  readonly hover: { readonly building: Building; readonly floor: number } | null;
  readonly selected: {
    readonly building: Building;
    readonly volume: number;
    readonly floor: number;
    readonly bay: { readonly storey: number; readonly side: Side; readonly index: number } | null;
  } | null;
  readonly handles: readonly Handle[];
  readonly label: { readonly text: string; readonly valid: boolean; readonly building: Building; readonly floor: number } | null;
}

export function drawBuildingOverlay(ctx: CanvasRenderingContext2D, input: BuildingOverlayInput): void {
  const { project } = input;
  ctx.save();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  const ring = (points: readonly Vec2[], z: number, colour: string, width: number, dash: number[] = []): void => {
    ctx.strokeStyle = colour;
    ctx.lineWidth = width;
    ctx.setLineDash(dash);
    ctx.beginPath();
    points.forEach((p, i) => {
      const s = project(p.x, p.y, z);
      if (i === 0) ctx.moveTo(s.x, s.y);
      else ctx.lineTo(s.x, s.y);
    });
    ctx.closePath();
    ctx.stroke();
    ctx.setLineDash([]);
  };

  if (input.hover && input.hover.building.id !== input.selected?.building.id) {
    const b = input.hover.building;
    for (const v of b.volumes) if (v.base === 0) ring(volumeCorners(b, v), input.hover.floor, HOVER, 1.5, [5, 4]);
  }

  const sel = input.selected;
  if (sel) {
    const b = sel.building;
    for (const v of b.volumes) if (v.base === 0) ring(volumeCorners(b, v, 0.6), sel.floor, SELECTION, 1.5);
    const v = volumeById(b, sel.volume);
    if (v) {
      // The selected volume as a wire box.
      const corners = volumeCorners(b, v);
      const z0 = sel.floor + levelElevation(b, v.base);
      const z1 = sel.floor + volumeHeight(b, v);
      ring(corners, z0, SELECTION, 2);
      ring(corners, z1, SELECTION, 2);
      ctx.beginPath();
      for (const p of corners) {
        const a = project(p.x, p.y, z0);
        const c = project(p.x, p.y, z1);
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(c.x, c.y);
      }
      ctx.stroke();
      // The picked bay, as a filled quad on its facade.
      if (sel.bay) {
        const level = v.base + sel.bay.storey;
        const centre = bayCentreLocal(b, v, sel.bay.side, sel.bay.index);
        const n = SIDE_NORMAL[sel.bay.side];
        const along = { x: Math.abs(n.y), y: Math.abs(n.x) };
        const half = b.module / 2;
        const za = sel.floor + levelElevation(b, level);
        const zb = za + levelHeight(b, level);
        const out = 0.15;
        const at = (a: number): Vec2 =>
          localToWorld(b, centre.x + along.x * a + n.x * out, centre.y + along.y * a + n.y * out);
        const p0 = at(-half);
        const p1 = at(half);
        const quad = [project(p0.x, p0.y, za), project(p1.x, p1.y, za), project(p1.x, p1.y, zb), project(p0.x, p0.y, zb)];
        ctx.fillStyle = 'rgba(101,229,195,0.28)';
        ctx.strokeStyle = SELECTION;
        ctx.lineWidth = 2;
        ctx.beginPath();
        quad.forEach((q, i) => (i === 0 ? ctx.moveTo(q.x, q.y) : ctx.lineTo(q.x, q.y)));
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
      }
    }
  }

  for (const h of input.handles) drawHandle(ctx, h, project);

  if (input.label) {
    const { building, floor, text, valid } = input.label;
    const c = footprintCentre(building);
    const s = project(c.x, c.y, floor + buildingHeight(building) + 6);
    ctx.font = '600 11px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const width = ctx.measureText(text).width + 16;
    ctx.fillStyle = 'rgba(12,18,16,0.8)';
    ctx.beginPath();
    ctx.roundRect(s.x - width / 2, s.y - 20, width, 20, 9);
    ctx.fill();
    ctx.fillStyle = valid ? SELECTION : INVALID;
    ctx.fillText(text, s.x, s.y - 9.5);
  }
  ctx.restore();
}

const GLYPH: Readonly<Record<Handle['kind'], string>> = {
  storeys: '⇕',
  side: '',
  move: '✥',
  rotate: '⟳',
};

function drawHandle(ctx: CanvasRenderingContext2D, h: Handle, project: (x: number, y: number, z: number) => Vec2): void {
  const p = project(h.x, h.y, h.z);
  ctx.fillStyle = 'rgba(12,18,16,0.82)';
  ctx.strokeStyle = SELECTION;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(p.x, p.y, h.kind === 'side' ? 8 : 11, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  if (h.kind === 'side') {
    // An arrow along the side's outward normal, projected.
    const q = project(h.x + h.dx * 4, h.y + h.dy * 4, h.z);
    const dx = q.x - p.x;
    const dy = q.y - p.y;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len;
    const uy = dy / len;
    ctx.fillStyle = SELECTION;
    ctx.beginPath();
    ctx.moveTo(p.x + ux * 6, p.y + uy * 6);
    ctx.lineTo(p.x - ux * 3 - uy * 4.5, p.y - uy * 3 + ux * 4.5);
    ctx.lineTo(p.x - ux * 3 + uy * 4.5, p.y - uy * 3 - ux * 4.5);
    ctx.closePath();
    ctx.fill();
    return;
  }
  ctx.fillStyle = SELECTION;
  ctx.font = '700 13px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(GLYPH[h.kind], p.x, p.y + 0.5);
}
