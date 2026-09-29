import type { Vec2 } from '@core/vec2';
import { GRID } from '@world/buildings/geometry';
import type { Handle } from '@world/buildings/handles';
import { m } from '@world/units';

/**
 * The Builder's own layer on the overlay canvas: the construction grid, the
 * gizmos that move, turn and resize the selection where it stands, the
 * footprint being drawn, the repeat control, the snap badge and the box the
 * player types a number into.
 *
 * Everything is projected through `project` at its real height, so a handle
 * sits on the object and nothing floats in screen space except the badges that
 * must stay readable.
 */

const ACTIVE = '#55e6ce';
const ACTIVE_DIM = 'rgba(85,230,206,0.55)';
const SECOND = '#ffc864';
const DANGER = '#ef625c';
const INK = 'rgba(8,20,18,0.86)';

/** A handle is the tool's own record (`world/buildings/handles.ts`): this layer only draws it. */
export type GizmoHandle = Handle;

export interface GizmoInput {
  readonly project: (x: number, y: number, z: number) => Vec2;
  readonly handles: readonly GizmoHandle[];
  /** The handle under the pointer, drawn hot. */
  readonly hovered: GizmoHandle | null;
  /** The grid's centre and the plane it lies on, when the grid is on. */
  readonly grid: { readonly centre: Vec2; readonly z: number } | null;
  /** The ring around the selection while it is being turned. */
  readonly ring: { readonly centre: Vec2; readonly z: number; readonly radius: number; readonly angle: number } | null;
  /** A footprint being drawn on the terrain. */
  readonly draw: { readonly ring: readonly Vec2[]; readonly z: number; readonly valid: boolean; readonly hint: string } | null;
  /** The live measure of the gesture, beside the point it measures. */
  readonly measure: { readonly text: string; readonly x: number; readonly y: number; readonly z: number } | null;
  /** The box the player is typing a measurement into. */
  readonly numeric: { readonly text: string; readonly x: number; readonly y: number } | null;
  /** What the pointer is snapped to, in a small badge under the cursor. */
  readonly snap: { readonly label: string; readonly x: number; readonly y: number } | null;
  /** The repeat control: a row of ghost copies the player drags to extend. */
  readonly repeat: {
    readonly anchors: readonly Vec2[];
    readonly z: number;
    readonly count: number;
    readonly spacing: number;
  } | null;
  /** The active floor, highlighted as a band on the selected volume. */
  readonly floorBand: { readonly corners: readonly Vec2[]; readonly z0: number; readonly z1: number } | null;
}

const circle = (ctx: CanvasRenderingContext2D, p: Vec2, r: number): void => {
  ctx.beginPath();
  ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
};

export function drawBuilderGizmos(ctx: CanvasRenderingContext2D, input: GizmoInput): void {
  const { project } = input;
  ctx.save();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  // ---- the construction grid, laid on the plane the work is happening on
  if (input.grid) {
    const { centre, z } = input.grid;
    const radius = m(24);
    const reach = m(60);
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(85,230,206,0.16)';
    ctx.beginPath();
    for (let v = -reach; v <= reach; v += GRID) {
      const major = Math.abs(Math.round(v / (GRID * 5))) * GRID * 5 === Math.abs(v);
      if (!major && Math.abs(v) > radius) continue;
      ctx.strokeStyle = major ? 'rgba(85,230,206,0.22)' : 'rgba(85,230,206,0.1)';
      const a = project(centre.x + v, centre.y - reach, z);
      const b = project(centre.x + v, centre.y + reach, z);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      const c = project(centre.x - reach, centre.y + v, z);
      const d = project(centre.x + reach, centre.y + v, z);
      ctx.beginPath();
      ctx.moveTo(c.x, c.y);
      ctx.lineTo(d.x, d.y);
      ctx.stroke();
    }
  }

  // ---- the active floor, as a quiet band on the building
  if (input.floorBand) {
    const { corners, z0, z1 } = input.floorBand;
    ctx.fillStyle = 'rgba(85,230,206,0.1)';
    ctx.beginPath();
    const bottom = corners.map((p) => project(p.x, p.y, z0));
    const top = corners.map((p) => project(p.x, p.y, z1));
    bottom.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
    ctx.closePath();
    [...top].reverse().forEach((p) => ctx.lineTo(p.x, p.y));
    ctx.closePath();
    ctx.fill();
  }

  // ---- the footprint being drawn
  if (input.draw) {
    const { ring, z, valid } = input.draw;
    if (ring.length >= 2) {
      ctx.strokeStyle = valid ? ACTIVE : DANGER;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ring.forEach((p, i) => {
        const s = project(p.x, p.y, z);
        if (i === 0) ctx.moveTo(s.x, s.y);
        else ctx.lineTo(s.x, s.y);
      });
      if (ring.length > 2) {
        ctx.closePath();
        ctx.fillStyle = valid ? 'rgba(85,230,206,0.14)' : 'rgba(239,98,92,0.14)';
        ctx.fill();
      }
      ctx.stroke();
      // Every clicked corner, as a tick.
      ctx.fillStyle = valid ? ACTIVE : DANGER;
      for (const p of ring) {
        const s = project(p.x, p.y, z);
        circle(ctx, s, 3);
        ctx.fill();
      }
    }
  }

  // ---- the repeat control: ghosts of the copies the drag would make
  if (input.repeat) {
    ctx.strokeStyle = ACTIVE_DIM;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 3]);
    for (const anchor of input.repeat.anchors) {
      const s = project(anchor.x, anchor.y, input.repeat.z);
      ctx.beginPath();
      ctx.rect(s.x - 4, s.y - 4, 8, 8);
      ctx.stroke();
    }
    ctx.setLineDash([]);
  }

  // ---- the rotate ring
  if (input.ring) {
    const { centre, z, radius, angle } = input.ring;
    const c = project(centre.x, centre.y, z);
    const edge = project(centre.x + radius, centre.y, z);
    const r = Math.hypot(edge.x - c.x, edge.y - c.y) || 1;
    ctx.strokeStyle = 'rgba(85,230,206,0.5)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
    ctx.stroke();
    // The angle swept so far, filled.
    ctx.strokeStyle = ACTIVE;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(c.x, c.y, r, -angle, 0, angle > 0);
    ctx.stroke();
  }

  // ---- the handles
  for (const handle of input.handles) {
    drawGizmoHandle(ctx, handle, project, handle === input.hovered);
  }

  // ---- the measure, as a drawing would give it
  if (input.measure) {
    badge(ctx, project(input.measure.x, input.measure.y, input.measure.z), input.measure.text, ACTIVE, 13);
  }

  // ---- the number being typed
  if (input.numeric) {
    const { text, x, y } = input.numeric;
    ctx.font = '700 14px ui-monospace, SFMono-Regular, Menlo, monospace';
    const width = Math.max(56, ctx.measureText(text).width + 26);
    ctx.fillStyle = INK;
    ctx.strokeStyle = ACTIVE;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.roundRect(x + 16, y - 40, width, 26, 7);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = ACTIVE;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, x + 26, y - 27);
    ctx.textAlign = 'center';
  }

  // ---- what the pointer snapped to
  if (input.snap) {
    ctx.font = '600 10px ui-sans-serif, system-ui, sans-serif';
    const width = ctx.measureText(input.snap.label).width + 14;
    ctx.fillStyle = INK;
    ctx.beginPath();
    ctx.roundRect(input.snap.x + 14, input.snap.y + 14, width, 18, 5);
    ctx.fill();
    ctx.fillStyle = ACTIVE;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(input.snap.label, input.snap.x + 21, input.snap.y + 23.5);
    ctx.textAlign = 'center';
  }

  ctx.restore();
}

function badge(ctx: CanvasRenderingContext2D, at: Vec2, text: string, colour: string, size: number): void {
  ctx.font = `700 ${size}px ui-sans-serif, system-ui, sans-serif`;
  const width = ctx.measureText(text).width + 20;
  ctx.fillStyle = INK;
  ctx.beginPath();
  ctx.roundRect(at.x + 16, at.y - 36, width, size + 11, 7);
  ctx.fill();
  ctx.fillStyle = colour;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, at.x + 16 + width / 2, at.y - 36 + (size + 11) / 2);
}

/** How each handle is drawn: a square you can grab, with its own glyph. */
function drawGizmoHandle(
  ctx: CanvasRenderingContext2D,
  handle: GizmoHandle,
  project: (x: number, y: number, z: number) => Vec2,
  hot: boolean,
): void {
  const p = project(handle.x, handle.y, handle.z);
  const size = hot ? 6 : 5;
  ctx.save();
  ctx.lineWidth = hot ? 2.4 : 1.8;

  switch (handle.kind) {
    case 'side':
    case 'storeys': {
      // Resize: a square you drag, with the direction it grows towards.
      ctx.fillStyle = INK;
      ctx.strokeStyle = hot ? '#ffffff' : ACTIVE;
      ctx.beginPath();
      ctx.rect(p.x - size, p.y - size, size * 2, size * 2);
      ctx.fill();
      ctx.stroke();
      if (handle.kind === 'storeys') {
        const up = project(handle.x, handle.y, handle.z + m(1.6));
        const dx = up.x - p.x;
        const dy = up.y - p.y;
        const len = Math.hypot(dx, dy) || 1;
        ctx.strokeStyle = hot ? '#ffffff' : ACTIVE;
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(p.x + (dx / len) * 14, p.y + (dy / len) * 14);
        ctx.stroke();
      } else {
        const out = project(handle.x + handle.dx * m(1.2), handle.y + handle.dy * m(1.2), handle.z);
        const dx = out.x - p.x;
        const dy = out.y - p.y;
        const len = Math.hypot(dx, dy) || 1;
        ctx.strokeStyle = hot ? '#ffffff' : ACTIVE;
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(p.x + (dx / len) * 13, p.y + (dy / len) * 13);
        ctx.stroke();
      }
      break;
    }
    case 'move': {
      // The planar gizmo: two axis arrows and a centre puck.
      ctx.fillStyle = INK;
      ctx.strokeStyle = hot ? '#ffffff' : ACTIVE;
      ctx.beginPath();
      ctx.arc(p.x, p.y, size + 1, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.strokeStyle = hot ? '#ffffff' : ACTIVE;
      for (const axis of [
        [m(1.6), 0],
        [0, m(1.6)],
      ] as const) {
        const q = project(handle.x + axis[0], handle.y + axis[1], handle.z);
        const dx = q.x - p.x;
        const dy = q.y - p.y;
        const len = Math.hypot(dx, dy) || 1;
        const ux = dx / len;
        const uy = dy / len;
        ctx.beginPath();
        ctx.moveTo(p.x + ux * 6, p.y + uy * 6);
        ctx.lineTo(p.x + ux * 16, p.y + uy * 16);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(p.x + ux * 20, p.y + uy * 20);
        ctx.lineTo(p.x + ux * 15 - uy * 4, p.y + uy * 15 + ux * 4);
        ctx.lineTo(p.x + ux * 15 + uy * 4, p.y + uy * 15 - ux * 4);
        ctx.closePath();
        ctx.fillStyle = hot ? '#ffffff' : ACTIVE;
        ctx.fill();
      }
      break;
    }
    case 'rotate': {
      // The turn grip: a small arc with a dot.
      ctx.strokeStyle = hot ? '#ffffff' : ACTIVE;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 9, Math.PI * 0.15, Math.PI * 1.35);
      ctx.stroke();
      ctx.fillStyle = hot ? '#ffffff' : ACTIVE;
      circle(ctx, p, 3.4);
      ctx.fill();
      break;
    }
    case 'storeys': {
      ctx.fillStyle = INK;
      ctx.strokeStyle = hot ? '#ffffff' : ACTIVE;
      ctx.beginPath();
      ctx.arc(p.x, p.y, hot ? 11 : 10, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = hot ? '#ffffff' : ACTIVE;
      ctx.font = '700 12px ui-sans-serif, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('⇕', p.x, p.y + 0.5);
      break;
    }
    case 'relief': {
      ctx.fillStyle = INK;
      ctx.strokeStyle = hot ? '#ffffff' : SECOND;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 8, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      const q = project(handle.x + handle.dx * m(1.4), handle.y + handle.dy * m(1.4), handle.z);
      const dx = q.x - p.x;
      const dy = q.y - p.y;
      const len = Math.hypot(dx, dy) || 1;
      const ux = dx / len;
      const uy = dy / len;
      ctx.fillStyle = hot ? '#ffffff' : SECOND;
      for (const sign of [1, -1]) {
        ctx.beginPath();
        ctx.moveTo(p.x + ux * 6 * sign, p.y + uy * 6 * sign);
        ctx.lineTo(p.x + (ux * 1 - uy * 4) * sign, p.y + (uy * 1 + ux * 4) * sign);
        ctx.lineTo(p.x + (ux * 1 + uy * 4) * sign, p.y + (uy * 1 - ux * 4) * sign);
        ctx.closePath();
        ctx.fill();
      }
      break;
    }
    default: {
      ctx.fillStyle = INK;
      ctx.strokeStyle = hot ? '#ffffff' : ACTIVE;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 7, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
  }
  ctx.restore();
}

