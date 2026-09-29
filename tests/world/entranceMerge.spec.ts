import { describe, expect, it } from 'vitest';

import { foundationOf } from '@world/buildings/foundation';
import { blueprintByKey } from '@world/buildings/blueprints';
import { type Building, type BuildingId, cloneBuilding } from '@world/buildings/types';
import { bayKey } from '@world/buildings/types';

/**
 * Two doors side by side are ONE way in.
 *
 * They used to be two entrances, each with its own narrow flight and a strip of
 * bare wall between them - the chasm a player photographed and called absurd.
 * Contiguous bays sharing a way in (same volume, side, component and flight
 * geometry) are a single entrance as wide as the run.
 */

const flat = (): number => 0;

function withDoors(bays: number[]): Building {
  const body = cloneBuilding(blueprintByKey('house')!.body as unknown as Building) as Building & { id?: BuildingId };
  const ground = body.volumes[0]!.storeys[0]!;
  const overrides: Record<string, 'door'> = {};
  for (const bay of bays) overrides[bayKey(0, bay)] = 'door';
  ground.facade = { fill: 'window', bays: overrides };
  body.id = 1 as BuildingId;
  return body as Building;
}

describe('entrance flights', () => {
  it('merges two adjacent doors into one wide flight', () => {
    const one = foundationOf(withDoors([1]), flat);
    const two = foundationOf(withDoors([1, 2]), flat);
    const single = one.entrances.filter((e) => e.component === 'door');
    const merged = two.entrances.filter((e) => e.component === 'door');
    expect(single).toHaveLength(1);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.width).toBeCloseTo(single[0]!.width * 2, 6);
  });

  it('keeps doors apart when a wall stands between them', () => {
    const f = foundationOf(withDoors([0, 2]), flat);
    expect(f.entrances.filter((e) => e.component === 'door').map((e) => [e.index, +e.width.toFixed(2)])).toHaveLength(2);
  });
});
