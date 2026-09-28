import { MAX_VOLUMES, type Building, type Relief, type Volume, volumeTop } from '@world/buildings/types';
import { baysOn } from '@world/buildings/geometry';
import { edgeFrame, volumeSides } from '@world/buildings/footprints';
import { type PlanShape, setVolumePlan, shapePoints } from './buildingPlans';

/**
 * Splits one continuous mass at a floor boundary. The new upper tier starts
 * with exactly the same plan and facade, so the visible building and its total
 * height do not change until the player sculpts that tier. Roof fixtures stay
 * on the physical top. This is the primitive behind an editable silhouette.
 */
export function splitVolumeAtFloor(b: Building, volumeId: number, afterFloor: number): number | null {
  const lower = b.volumes.find((volume) => volume.id === volumeId);
  if (!lower || b.volumes.length >= MAX_VOLUMES || !Number.isInteger(afterFloor) ||
    afterFloor <= lower.base || afterFloor >= volumeTop(lower)) return null;
  const lowerCount = afterFloor - lower.base;
  const upper = structuredClone(lower) as Volume;
  upper.id = b.nextVolumeId++;
  upper.base = afterFloor;
  upper.storeys = lower.storeys.slice(lowerCount);
  lower.storeys = lower.storeys.slice(0, lowerCount);
  const oldReliefs = lower.reliefs ?? [];
  const below: Relief[] = [], above: Relief[] = [];
  for (const relief of oldReliefs) {
    if (relief.storey0 < lowerCount) below.push({ ...relief, storey1: Math.min(relief.storey1, lowerCount - 1) });
    if (relief.storey1 >= lowerCount) above.push({ ...relief,
      storey0: Math.max(0, relief.storey0 - lowerCount), storey1: relief.storey1 - lowerCount });
  }
  if (below.length) lower.reliefs = below; else delete lower.reliefs;
  if (above.length) upper.reliefs = above; else delete upper.reliefs;
  lower.roof = 'terrace';
  delete lower.roofDetails;
  delete lower.pitch;
  delete lower.ridge;
  delete lower.fall;
  b.volumes.push(upper);
  return upper.id;
}

/** Turns a tier into another editable plan while mapping facade work by face direction. */
export function reshapeTier(b: Building, volumeId: number, shape: PlanShape): boolean {
  const volume = b.volumes.find((part) => part.id === volumeId);
  if (!volume || volume.reliefs?.length) return false;
  const before = JSON.stringify(volume);
  const old = structuredClone(volume);
  const oldFaces = volumeSides(old);
  const oldFrames = oldFaces.map((side) => edgeFrame(old, side));
  const points = shapePoints(shape).map((point) => ({ x: old.x + point.x * old.w, y: old.y + point.y * old.d }));
  if (!setVolumePlan(volume, points)) return false;
  const newFaces = volumeSides(volume);
  const newFrames = newFaces.map((side) => edgeFrame(volume, side));
  const nearest = (nx: number, ny: number, frames: typeof oldFrames): number => {
    let best = 0, score = -Infinity;
    for (let i = 0; i < frames.length; i++) {
      const frame = frames[i]!;
      const dot = nx * frame.nx + ny * frame.ny;
      if (dot > score) { score = dot; best = i; }
    }
    return best;
  };
  const sourceFor = newFrames.map((frame) => nearest(frame.nx, frame.ny, oldFrames));
  const targetFor = oldFrames.map((frame) => nearest(frame.nx, frame.ny, newFrames));
  const replicate = <T>(source: Partial<Record<number, T>> | undefined): Partial<Record<number, T>> | undefined => {
    if (!source) return undefined;
    const result: Partial<Record<number, T>> = {};
    for (const [side, oldSide] of sourceFor.entries()) {
      const value = source[oldSide];
      if (value !== undefined) result[side] = structuredClone(value);
    }
    return Object.keys(result).length ? result : undefined;
  };
  const mappedGeometry = replicate(old.facadeGeometry);
  if (mappedGeometry) volume.facadeGeometry = mappedGeometry;
  else delete volume.facadeGeometry;
  for (const [side, controls] of Object.entries(volume.facadeGeometry ?? {})) {
    if (controls?.bays === undefined) continue;
    const oldSide = sourceFor[Number(side)]!;
    controls.bays = Math.max(1, Math.min(64,
      Math.round(controls.bays * newFrames[Number(side)]!.length / oldFrames[oldSide]!.length)));
  }
  if (!volume.facadeGeometry) delete volume.facadeGeometry;
  if (volume.materials) {
    const sides = replicate(old.materials?.sides);
    if (sides) volume.materials.sides = sides;
    else delete volume.materials.sides;
  }
  for (const [floor, storey] of volume.storeys.entries()) {
    const previous = old.storeys[floor]!;
    const sides = replicate(previous.facade.sides);
    const patterns = replicate(previous.facade.patterns);
    if (sides) storey.facade.sides = sides;
    else delete storey.facade.sides;
    if (patterns) storey.facade.patterns = patterns;
    else delete storey.facade.patterns;
    if (previous.facade.bays) {
      const moved: NonNullable<typeof previous.facade.bays> = {};
      for (const [key, component] of Object.entries(previous.facade.bays)) {
        const [oldSide, oldBay] = key.split(':').map(Number);
        if (oldSide === undefined || oldBay === undefined) continue;
        const newSide = targetFor[oldSide];
        if (newSide === undefined) continue;
        const from = baysOn(b, old, oldSide), to = baysOn(b, volume, newSide);
        moved[`${newSide}:${Math.min(to - 1, Math.floor(oldBay * to / from))}`] = component;
      }
      storey.facade.bays = moved;
    }
    const materials = replicate(previous.materials);
    if (materials) storey.materials = materials;
    else delete storey.materials;
  }
  return JSON.stringify(volume) !== before;
}
