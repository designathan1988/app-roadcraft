import type { Vec2 } from '@core/vec2';
import { m } from '@world/units';
import { roofPartFits } from '@world/buildings/footprints';
import { type Building, type RoofDetail, type RoofDetailKind } from '@world/buildings/types';

const SIZE: Readonly<Record<RoofDetailKind, readonly [number, number]>> = {
  solar: [m(3), m(2)], skylight: [m(2), m(1.5)], vent: [m(1), m(1)],
  chimney: [m(1), m(1)], waterTank: [m(2.2), m(2.2)], spire: [m(1.5), m(1.5)],
};

/** A roof part belongs to one mass and follows every building edit. */
export function addRoofDetail(b: Building, volumeId: number, kind: RoofDetailKind, at: Vec2): number | null {
  const v = b.volumes.find((volume) => volume.id === volumeId);
  if (!v) return null;
  const [w, d] = SIZE[kind];
  if (!roofPartFits(v, { x: at.x, y: at.y, w, d, rotation: 0 })) return null;
  const used = (v.roofDetails ?? []).reduce((max, detail) => Math.max(max, detail.id), 0);
  const id = used + 1;
  const next: RoofDetail = { id, kind, x: at.x, y: at.y, rotation: 0, w, d };
  if (kind === 'spire') next.h = m(11.7);
  v.roofDetails = [...(v.roofDetails ?? []), next];
  return id;
}

export function updateRoofDetail(b: Building, volumeId: number, id: number, patch: Partial<Pick<RoofDetail, 'x' | 'y' | 'rotation' | 'w' | 'd' | 'h' | 'flag'>>): boolean {
  const v = b.volumes.find((volume) => volume.id === volumeId);
  const current = v?.roofDetails?.find((detail) => detail.id === id);
  if (!v || !current) return false;
  const next = { ...current, ...patch };
  if (!roofPartFits(v, next) || !Number.isFinite(next.rotation) || (next.h !== undefined && (!Number.isFinite(next.h) || next.h < m(1) || next.h > m(40)))) return false;
  Object.assign(current, next);
  return true;
}

export function removeRoofDetail(b: Building, volumeId: number, id: number): boolean {
  const v = b.volumes.find((volume) => volume.id === volumeId);
  if (!v?.roofDetails?.some((detail) => detail.id === id)) return false;
  v.roofDetails = v.roofDetails.filter((detail) => detail.id !== id);
  return true;
}
