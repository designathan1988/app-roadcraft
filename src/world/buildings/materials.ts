import type { Building, RoofKind, Side, Volume } from './types';

/**
 * What a building is made of. See docs/buildings.md, "Materials".
 *
 * A material is a FINISH - the surface a wall or a roof is built in, which the
 * renderer draws with its own baked texture - and a COLOUR that tints it. Any
 * surface can take any material: a brick wing on a plaster block, a glass face
 * on a concrete tower, a metal roof on a brick house. Materials resolve from
 * the most specific setting to the least:
 *
 * ```
 * wall of one side:  volume.materials.sides[side] ?? volume.materials.wall ?? building.materials.wall ?? palette
 * roof of a volume:  volume.materials.roof ?? building.materials.roof ?? palette (by roof kind)
 * trim, plinth:      building.materials.trim / .plinth ?? palette
 * ```
 */

export const FINISHES = ['plaster', 'brick', 'stone', 'concrete', 'wood', 'metal', 'glass', 'tile', 'roofing'] as const;
export type Finish = (typeof FINISHES)[number];

export interface MaterialSpec {
  readonly finish: Finish;
  /** 0xRRGGBB, in sRGB. */
  readonly colour: number;
}

/** Surfaces a building-wide material can be set for. */
export const MATERIAL_SLOTS = ['wall', 'trim', 'roof', 'plinth'] as const;
export type MaterialSlot = (typeof MATERIAL_SLOTS)[number];

export type BuildingMaterials = Partial<Record<MaterialSlot, MaterialSpec>>;

export interface VolumeMaterials {
  /** Every wall of the volume. */
  wall?: MaterialSpec;
  /** One side's walls, over `wall`. */
  sides?: Partial<Record<Side, MaterialSpec>>;
  roof?: MaterialSpec;
}

export const isFinish = (v: unknown): v is Finish => (FINISHES as readonly unknown[]).includes(v);

export function isMaterialSpec(v: unknown): v is MaterialSpec {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return isFinish(r['finish']) && typeof r['colour'] === 'number' && Number.isInteger(r['colour']) &&
    (r['colour'] as number) >= 0 && (r['colour'] as number) <= 0xffffff;
}

const spec = (finish: Finish, colour: number): MaterialSpec => ({ finish, colour });

/**
 * The colour schemes a building starts with (`Building.palette`): what every
 * surface is made of until the player says otherwise.
 */
export interface PaletteMaterials {
  readonly wall: MaterialSpec;
  readonly trim: MaterialSpec;
  /** Pitched roofs. */
  readonly roof: MaterialSpec;
  readonly awning: number;
}

export const PALETTE_MATERIALS: readonly PaletteMaterials[] = [
  { wall: spec('plaster', 0xe6d8bd), trim: spec('plaster', 0xf4eee2), roof: spec('tile', 0x9c4f3a), awning: 0x2f6f5e },
  { wall: spec('brick', 0xa4563f), trim: spec('plaster', 0xe0d6c6), roof: spec('tile', 0x4a4b50), awning: 0x8c2f2a },
  { wall: spec('concrete', 0xbdbcb4), trim: spec('concrete', 0xdcdcd6), roof: spec('metal', 0x55585c), awning: 0x2d4f7a },
  { wall: spec('plaster', 0xd8c297), trim: spec('plaster', 0xf0e6cf), roof: spec('tile', 0x8a5a3c), awning: 0xb5452b },
  { wall: spec('plaster', 0xf0efe9), trim: spec('concrete', 0xc9ccc9), roof: spec('tile', 0x5b5f63), awning: 0x2f6f5e },
  { wall: spec('brick', 0x72412f), trim: spec('stone', 0xd2c4b2), roof: spec('tile', 0x3d3e42), awning: 0xc4832d },
  { wall: spec('metal', 0x8f9ba5), trim: spec('metal', 0xe0e5e8), roof: spec('metal', 0x4f5357), awning: 0x2d4f7a },
  { wall: spec('metal', 0x939b91), trim: spec('concrete', 0xc4c8c1), roof: spec('metal', 0x6f7577), awning: 0xc4a02d },
];

/** A flat roof's default: a smooth membrane, whatever the palette (a panel grid read as a floor). */
export const FLAT_ROOF_MATERIAL = spec('roofing', 0x74716a);
export const PLINTH_MATERIAL = spec('stone', 0x7f786d);

export const paletteOf = (b: Building): PaletteMaterials =>
  PALETTE_MATERIALS[((b.palette % PALETTE_MATERIALS.length) + PALETTE_MATERIALS.length) % PALETTE_MATERIALS.length] as PaletteMaterials;

const isPitched = (roof: RoofKind): boolean => roof !== 'flat' && roof !== 'terrace';

export function wallMaterial(b: Building, v: Volume, side: Side): MaterialSpec {
  return v.materials?.sides?.[side] ?? v.materials?.wall ?? b.materials?.wall ?? paletteOf(b).wall;
}

export function roofMaterial(b: Building, v: Volume): MaterialSpec {
  return v.materials?.roof ?? b.materials?.roof ?? (isPitched(v.roof) ? paletteOf(b).roof : FLAT_ROOF_MATERIAL);
}

export const trimMaterial = (b: Building): MaterialSpec => b.materials?.trim ?? paletteOf(b).trim;
export const plinthMaterial = (b: Building): MaterialSpec => b.materials?.plinth ?? PLINTH_MATERIAL;

/** Where a material is being set. */
export type MaterialTarget =
  | { readonly scope: 'building'; readonly slot: MaterialSlot }
  | { readonly scope: 'volume'; readonly volume: number; readonly slot: 'wall' | 'roof' }
  | { readonly scope: 'side'; readonly volume: number; readonly side: Side };

/** The material a target currently resolves to (what the palette shows as chosen). */
export function materialAt(b: Building, target: MaterialTarget): MaterialSpec | null {
  switch (target.scope) {
    case 'building':
      switch (target.slot) {
        case 'wall': return b.materials?.wall ?? paletteOf(b).wall;
        case 'trim': return trimMaterial(b);
        case 'plinth': return plinthMaterial(b);
        case 'roof': return b.materials?.roof ?? paletteOf(b).roof;
      }
      return null;
    case 'volume': {
      const v = b.volumes.find((x) => x.id === target.volume);
      if (!v) return null;
      return target.slot === 'roof' ? roofMaterial(b, v) : v.materials?.wall ?? b.materials?.wall ?? paletteOf(b).wall;
    }
    case 'side': {
      const v = b.volumes.find((x) => x.id === target.volume);
      return v ? wallMaterial(b, v, target.side) : null;
    }
  }
}

/**
 * Sets (or with `null` clears) the material of a target, in place. Setting a
 * wider scope clears the narrower overrides under it, so "paint the whole
 * building" does what it says. Returns whether anything changed.
 */
export function applyMaterial(b: Building, target: MaterialTarget, value: MaterialSpec | null): boolean {
  const before = JSON.stringify([b.materials, b.volumes.map((v) => v.materials)]);
  const tidyVolume = (v: Volume): void => {
    const m = v.materials;
    if (!m) return;
    if (m.sides && Object.keys(m.sides).length === 0) delete m.sides;
    if (Object.keys(m).length === 0) delete v.materials;
  };
  switch (target.scope) {
    case 'building': {
      const next: BuildingMaterials = { ...(b.materials ?? {}) };
      if (value) next[target.slot] = { ...value };
      else delete next[target.slot];
      if (Object.keys(next).length > 0) b.materials = next;
      else delete b.materials;
      if (value && (target.slot === 'wall' || target.slot === 'roof')) {
        for (const v of b.volumes) {
          if (!v.materials) continue;
          delete v.materials[target.slot];
          if (target.slot === 'wall') delete v.materials.sides;
          tidyVolume(v);
        }
      }
      break;
    }
    case 'volume': {
      const v = b.volumes.find((x) => x.id === target.volume);
      if (!v) return false;
      const m: VolumeMaterials = { ...(v.materials ?? {}) };
      if (value) m[target.slot] = { ...value };
      else delete m[target.slot];
      if (value && target.slot === 'wall') delete m.sides;
      v.materials = m;
      tidyVolume(v);
      break;
    }
    case 'side': {
      const v = b.volumes.find((x) => x.id === target.volume);
      if (!v) return false;
      const m: VolumeMaterials = { ...(v.materials ?? {}) };
      const sides = { ...(m.sides ?? {}) };
      if (value) sides[target.side] = { ...value };
      else delete sides[target.side];
      m.sides = sides;
      v.materials = m;
      tidyVolume(v);
      break;
    }
  }
  return JSON.stringify([b.materials, b.volumes.map((v) => v.materials)]) !== before;
}

/** A stored material, repaired: a valid spec, or undefined. */
export function migrateMaterial(raw: unknown): MaterialSpec | undefined {
  return isMaterialSpec(raw) ? { finish: raw.finish, colour: raw.colour } : undefined;
}

export function migrateBuildingMaterials(raw: unknown): BuildingMaterials | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const out: BuildingMaterials = {};
  for (const slot of MATERIAL_SLOTS) {
    const m = migrateMaterial((raw as Record<string, unknown>)[slot]);
    if (m) out[slot] = m;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export function migrateVolumeMaterials(raw: unknown): VolumeMaterials | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  const out: VolumeMaterials = {};
  const wall = migrateMaterial(r['wall']);
  const roof = migrateMaterial(r['roof']);
  if (wall) out.wall = wall;
  if (roof) out.roof = roof;
  if (typeof r['sides'] === 'object' && r['sides'] !== null) {
    const sides: Partial<Record<Side, MaterialSpec>> = {};
    for (const side of [0, 1, 2, 3] as const) {
      const m = migrateMaterial((r['sides'] as Record<string, unknown>)[String(side)]);
      if (m) sides[side] = m;
    }
    if (Object.keys(sides).length > 0) out.sides = sides;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Factory styles: a coherent set of materials for a whole building, applied
 * in one click and freely changed afterwards - a style locks nothing.
 */
export const STYLES: readonly { readonly key: string; readonly materials: Required<BuildingMaterials> }[] = [
  {
    key: 'brick',
    materials: { wall: spec('brick', 0x9a5540), trim: spec('stone', 0xe3dccd), roof: spec('tile', 0x5a4a44), plinth: spec('stone', 0x6f6a62) },
  },
  {
    key: 'modern',
    materials: { wall: spec('plaster', 0xf1efe9), trim: spec('concrete', 0xb9bcbb), roof: spec('metal', 0x4d5256), plinth: spec('concrete', 0x8a8a84) },
  },
  {
    key: 'mediterranean',
    materials: { wall: spec('plaster', 0xe8cfa0), trim: spec('plaster', 0xf6efe2), roof: spec('tile', 0xa65a3c), plinth: spec('stone', 0x8f8069) },
  },
  {
    key: 'industrial',
    materials: { wall: spec('metal', 0x7f8a86), trim: spec('concrete', 0xc7c6be), roof: spec('metal', 0x5d6462), plinth: spec('concrete', 0x77766f) },
  },
  {
    key: 'timber',
    materials: { wall: spec('wood', 0x8a6a4a), trim: spec('plaster', 0xeee8dc), roof: spec('metal', 0x3f4447), plinth: spec('stone', 0x6d665c) },
  },
];

/** Applies a style to a whole building (clearing per-volume and per-face overrides). */
export function applyStyle(b: Building, key: string): boolean {
  const style = STYLES.find((s) => s.key === key);
  if (!style) return false;
  const before = JSON.stringify([b.materials, b.volumes.map((v) => v.materials)]);
  b.materials = { ...style.materials };
  for (const v of b.volumes) delete v.materials;
  return JSON.stringify([b.materials, b.volumes.map((v) => v.materials)]) !== before;
}
