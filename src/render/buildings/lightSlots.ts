import { DataTexture, RGBAFormat, UnsignedByteType } from 'three';

/**
 * Which spaces of which buildings are lit, for their windows.
 *
 * Every window pane belongs to a space - a flat, a shop, an office floor -
 * found when the building is drawn (`buildingMesh.ts`), and carries that
 * space's slot. The renderer marks each slot lit or dark from who is inside
 * the space now and awake (`renderer.ts`), and the glass reads the slot: a
 * window is lit exactly when its room is, never a lit window over an empty
 * flat or a dark one over a family watching television.
 */
export const SLOT_WIDTH = 1024;
const SLOT_ROWS = 64;

const index = new Map<string, number>();
const byFloor = new Map<string, number[]>();

/** The key of one space: building, floor, block, and the space's corner. */
export const spaceKey = (building: number, level: number, volume: number, x: number, y: number): string =>
  `${building}:${level}:${volume}:${Math.round(x * 10)}:${Math.round(y * 10)}`;

/** The slot of a space, made on first use; -1 when the table is full. */
export function slotFor(building: number, level: number, volume: number, x: number, y: number): number {
  const key = spaceKey(building, level, volume, x, y);
  let slot = index.get(key);
  if (slot === undefined) {
    if (index.size >= SLOT_WIDTH * SLOT_ROWS) return -1;
    slot = index.size;
    index.set(key, slot);
    const floor = `${building}:${level}`;
    const list = byFloor.get(floor);
    if (list) list.push(slot); else byFloor.set(floor, [slot]);
  }
  return slot;
}

/** The slot of a known space, or -1. */
export const slotOf = (building: number, level: number, volume: number, x: number, y: number): number =>
  index.get(spaceKey(building, level, volume, x, y)) ?? -1;

/** Every slot of one floor of a building. */
export const slotsOnFloor = (building: number, level: number): readonly number[] => byFloor.get(`${building}:${level}`) ?? [];

/** Every floor that has slots, as [building, level]. */
export function floorsWithSlots(): [number, number][] {
  return [...byFloor.keys()].map((k) => k.split(':').map(Number) as [number, number]);
}

/** The lit table the glass reads: red 255 = lit. */
export const litTexture = new DataTexture(new Uint8Array(SLOT_WIDTH * SLOT_ROWS * 4), SLOT_WIDTH, SLOT_ROWS, RGBAFormat, UnsignedByteType);
litTexture.needsUpdate = true;

/** Sets the lit slots, all others dark. */
export function setLit(lit: ReadonlySet<number>): void {
  const data = litTexture.image.data as Uint8Array;
  for (let i = 0; i < index.size; i++) data[i * 4] = lit.has(i) ? 255 : 0;
  litTexture.needsUpdate = true;
}
