import type { RoadType } from '@world/roadTypes';
import { roadStructure, type RoadStructure } from '@world/structures';
import { plural, t } from './i18n';

/**
 * Turns model values into text for the interface.
 *
 * The model stores translation KEYS, never sentences — see `RoadType.nameKey`
 * and `RoadStructureSpec.key`. This module is the one place those keys become
 * words, which is what lets the language change without touching the document,
 * the network, the simulation or any saved map.
 */

export const roadTypeName = (type: RoadType): string => t(type.nameKey);

/** The one-line description under a class name, with its lane count filled in. */
export function roadTypeDescription(type: RoadType): string {
  if (type.subLanes === null) return t(type.subKey);
  return t(type.subKey, {
    count: type.subLanes,
    way: t(type.subOneWay ? 'road.way.one' : 'road.way.two'),
  });
}

export const structureName = (structure: RoadStructure): string => t(roadStructure(structure).key);

export const roadCountLabel = (count: number): string => plural('status.roads', count);
export const nodeCountLabel = (count: number): string => plural('status.nodes', count);
export const vehicleCountLabel = (count: number): string => plural('status.vehicles', count);
export const peopleCountLabel = (count: number): string => plural('status.people', count);
