import type { RoadType } from './roadTypes';

/** Roads with a traffic verge but no public footway or crossing network. */
export function carriesPedestrians(road: Pick<RoadType, 'id'>): boolean {
  return road.id !== 'highway' && road.id !== 'ramp';
}
