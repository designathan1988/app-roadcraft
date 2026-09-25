import { m } from '../units';
import {
  SIDE_NORMAL,
  footprintBox,
  levelElevation,
  localDirToWorld,
  localToWorld,
  roofRise,
  volumeHeight,
} from './geometry';
import { type Building, type Side, SIDES, volumeById } from './types';

/**
 * Where the edit handles of a selected building stand, in world 3D.
 *
 * Pure geometry, shared by the tool (which hit-tests them) and the overlay
 * (which draws them), so the two can never disagree about where a handle is.
 */
export type HandleKind = 'storeys' | 'side' | 'move' | 'rotate';

export interface Handle {
  readonly kind: HandleKind;
  readonly side?: Side;
  readonly x: number;
  readonly y: number;
  /** Absolute height. */
  readonly z: number;
  /** World direction the handle drags along (sides: the outward normal). */
  readonly dx: number;
  readonly dy: number;
}

const HANDLE_OUT = m(1.6);
const CORNER_OUT = m(3.2);

/**
 * `nearest` orders the four footprint corners (front-left, front-right,
 * back-right, back-left in the local frame) by how close each is to the viewer;
 * the move and rotate handles take the first two, so they never land behind
 * the building or on top of the roof arrow. Default: the front corners.
 */
export function buildingHandles(
  b: Building,
  volumeId: number,
  floor: number,
  nearest: (corners: readonly { x: number; y: number }[]) => readonly number[] = () => [0, 1],
): Handle[] {
  const v = volumeById(b, volumeId) ?? b.volumes[0];
  if (!v) return [];
  const out: Handle[] = [];
  const top = localToWorld(b, v.x + v.w / 2, v.y + v.d / 2);
  out.push({
    kind: 'storeys',
    x: top.x,
    y: top.y,
    z: floor + volumeHeight(b, v) + roofRise(b, v) + m(1.8),
    dx: 0,
    dy: 0,
  });
  const baseZ = floor + levelElevation(b, v.base) + m(0.3);
  for (const side of SIDES) {
    const n = SIDE_NORMAL[side];
    const cx = v.x + v.w / 2 + n.x * (v.w / 2 + HANDLE_OUT);
    const cy = v.y + v.d / 2 + n.y * (v.d / 2 + HANDLE_OUT);
    const p = localToWorld(b, cx, cy);
    const d = localDirToWorld(b, n.x, n.y);
    out.push({ kind: 'side', side, x: p.x, y: p.y, z: baseZ, dx: d.x, dy: d.y });
  }
  const f = footprintBox(b);
  const corners = [
    localToWorld(b, f.x0 - CORNER_OUT, f.y0 - CORNER_OUT),
    localToWorld(b, f.x1 + CORNER_OUT, f.y0 - CORNER_OUT),
    localToWorld(b, f.x1 + CORNER_OUT, f.y1 + CORNER_OUT),
    localToWorld(b, f.x0 - CORNER_OUT, f.y1 + CORNER_OUT),
  ];
  const order = nearest(corners);
  const move = corners[order[0] ?? 0] as { x: number; y: number };
  const turn = corners[order[1] ?? 1] as { x: number; y: number };
  out.push({ kind: 'move', x: move.x, y: move.y, z: floor, dx: 0, dy: 0 });
  out.push({ kind: 'rotate', x: turn.x, y: turn.y, z: floor, dx: 0, dy: 0 });
  return out;
}
