import { describe, expect, it } from 'vitest';

import { MAX_PLINTH, PLINTH_MIN, floorHeight, foundationOf } from '@world/buildings/foundation';
import { blueprintByKey } from '@world/buildings/blueprints';
import { type Building, type BuildingId, cloneBuilding } from '@world/buildings/types';
import { m } from '@world/units';

/**
 * A door's street is the paving at the level of the land, not a deck passing
 * overhead. A house placed beside the player's raised road stood on a brick
 * plinth as tall as the road: the deck in front of its door was read as the
 * footway it opens onto.
 */

const flat = (): number => 0;

function house(): Building {
  const body = cloneBuilding(blueprintByKey('house')!.body as unknown as Building) as Building & { id?: BuildingId };
  body.id = 1 as BuildingId;
  return body as Building;
}

describe('foundation beside a deck', () => {
  it('ignores paving storeys above the land in front of the door', () => {
    const deck = m(15);
    const everywhere = (): number => deck;
    const b = house();
    expect(foundationOf(b, flat, undefined, everywhere).floor).toBeCloseTo(PLINTH_MIN, 6);
    expect(floorHeight(b, flat, everywhere)).toBeCloseTo(PLINTH_MIN, 6);
  });

  it('still lifts the floor to a footway a kerb above the land', () => {
    const footway = m(0.3);
    expect(footway).toBeLessThan(MAX_PLINTH);
    const b = house();
    expect(foundationOf(b, flat, undefined, () => footway).floor).toBeCloseTo(footway + PLINTH_MIN, 6);
  });
});
