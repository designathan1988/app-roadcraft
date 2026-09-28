import { baysOn } from '@world/buildings/geometry';
import { volumeSides } from '@world/buildings/footprints';
import { type Building, type BuildingUse, type FacadeGeometry, type FacadePattern, type FaceId,
  MAX_PROJECTION, bayKey } from '@world/buildings/types';
import { clamp } from '@core/scalar';

export type FacadeTarget =
  | { scope: 'building' }
  | { scope: 'volume'; volume: number }
  | { scope: 'face'; volume: number; face: FaceId }
  | { scope: 'floor'; volume: number; floor: number };

const USE: Readonly<Record<FacadePattern, BuildingUse>> = {
  residential: 'residential', storefront: 'commercial', office: 'commercial',
  industrial: 'industrial', arcade: 'commercial', gallery: 'commercial',
  artDeco: 'commercial',
  artDecoCrown: 'commercial', observation: 'commercial',
};

/** A coherent facade is one command; individual bays remain fully editable. */
export function applyFacadePattern(b: Building, target: FacadeTarget, pattern: FacadePattern): boolean {
  const before = JSON.stringify([b.use, b.volumes]);
  const volumes = target.scope === 'building' ? b.volumes : b.volumes.filter((v) => v.id === target.volume);
  if (volumes.length === 0) return false;
  if (target.scope === 'building') b.use = USE[pattern];
  for (const volume of volumes) {
    if (target.scope === 'building' || target.scope === 'volume') volume.facadePattern = pattern;
    const faces = target.scope === 'face' ? [target.face] : volumeSides(volume);
    for (let floor = 0; floor < volume.storeys.length; floor++) {
      if (target.scope === 'floor' && floor !== target.floor) continue;
      const storey = volume.storeys[floor]!;
      if (target.scope !== 'face') storey.use = USE[pattern];
      const facade = storey.facade;
      if (target.scope === 'building' || target.scope === 'volume') {
        delete facade.pattern;
        delete facade.patterns;
      } else if (target.scope === 'floor') {
        facade.pattern = pattern;
        delete facade.patterns;
      } else {
        facade.patterns = { ...(facade.patterns ?? {}), [target.face]: pattern };
      }
      const sides = { ...(facade.sides ?? {}) };
      const bays = { ...(facade.bays ?? {}) };
      for (const face of faces) {
        for (const key of Object.keys(bays)) if (key.startsWith(`${face}:`)) delete bays[key];
        const ground = volume.base + floor === 0;
        let fill: typeof facade.fill = 'window';
        if (pattern === 'storefront') fill = ground ? 'shopfront' : 'wideWindow';
        if (pattern === 'office') fill = ground && face === faces[0] ? 'shopfront' : 'wideWindow';
        if (pattern === 'industrial') fill = 'wall';
        if (pattern === 'arcade') fill = ground ? 'pillar' : 'window';
        if (pattern === 'gallery') fill = 'pillar';
        if (pattern === 'artDeco') fill = 'sashWindow';
        if (pattern === 'artDecoCrown') fill = 'sashWindow';
        if (pattern === 'observation') fill = 'wideWindow';
        sides[face] = fill;
        const count = baysOn(b, volume, face);
        if (ground && face === faces[0]) {
          if (pattern === 'industrial') {
            for (let i = 0; i < count; i += 2) bays[bayKey(face, i)] = 'loadingDoor';
          }
          bays[bayKey(face, Math.floor(count / 2))] = 'door';
        } else if (pattern === 'residential' && floor > 0 && face === faces[0]) {
          for (let i = 1; i < count; i += 2) bays[bayKey(face, i)] = 'balcony';
        } else if (pattern === 'industrial' && floor > 0) {
          for (let i = 0; i < count; i += 3) bays[bayKey(face, i)] = 'window';
        } else if ((pattern === 'artDeco' || pattern === 'artDecoCrown') && !ground) {
          for (let i = 0; i < count; i += 3) bays[bayKey(face, i)] = 'wall';
        }
      }
      facade.sides = sides;
      if (Object.keys(bays).length > 0) facade.bays = bays;
      else delete facade.bays;
    }
  }
  return JSON.stringify([b.use, b.volumes]) !== before;
}

/** A face's proportions are authored data; reducing its bay count resamples edits. */
export function updateFacadeGeometry(b: Building, volumeId: number, face: FaceId, patch: Partial<FacadeGeometry>): boolean {
  const volume = b.volumes.find((v) => v.id === volumeId);
  if (!volume || !volumeSides(volume).includes(face)) return false;
  const before = JSON.stringify([volume.facadeGeometry, volume.storeys, volume.reliefs]);
  const oldCount = baysOn(b, volume, face);
  const next: FacadeGeometry = { ...(volume.facadeGeometry?.[face] ?? {}) };
  if (patch.bays !== undefined && Number.isFinite(patch.bays)) next.bays = clamp(Math.round(patch.bays), 1, 64);
  for (const key of ['windowWidth', 'windowHeight'] as const)
    if (patch[key] !== undefined && Number.isFinite(patch[key])) next[key] = clamp(patch[key], .15, .95);
  for (const key of ['sill', 'pierWidth', 'pierDepth'] as const)
    if (patch[key] !== undefined && Number.isFinite(patch[key])) next[key] = clamp(patch[key], 0, MAX_PROJECTION);
  if (patch.pierEvery !== undefined && Number.isFinite(patch.pierEvery)) next.pierEvery = clamp(Math.round(patch.pierEvery), 1, 16);
  volume.facadeGeometry = { ...(volume.facadeGeometry ?? {}), [face]: next };
  const newCount = baysOn(b, volume, face);
  if (oldCount !== newCount) {
    const index = (i: number): number => Math.min(newCount - 1, Math.floor(i * newCount / oldCount));
    for (const storey of volume.storeys) {
      const bays = storey.facade.bays;
      if (!bays) continue;
      const resampled: typeof bays = {};
      for (const [key, component] of Object.entries(bays)) {
        const [side, bay] = key.split(':').map(Number);
        resampled[side === face && bay !== undefined ? bayKey(face, index(bay)) : key] = component;
      }
      storey.facade.bays = resampled;
    }
    for (const relief of volume.reliefs ?? []) if (relief.side === face) {
      relief.bay0 = index(relief.bay0);
      relief.bay1 = Math.min(newCount - 1, Math.ceil((relief.bay1 + 1) * newCount / oldCount) - 1);
    }
  }
  return JSON.stringify([volume.facadeGeometry, volume.storeys, volume.reliefs]) !== before;
}
