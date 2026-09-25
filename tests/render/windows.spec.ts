import { describe, expect, it } from 'vitest';
import { Box3 } from 'three';
import { ARCHETYPES } from '@sim/vehicles/archetypes';
import { buildVehicleModel } from '@render/vehicleModels';
import { vehicleLook, windowPane } from '@render/agents';

/**
 * A LOWERED WINDOW STAYS INSIDE ITS DOOR.
 *
 * `agents.ts` draws a part-lowered window as the pane shortened from the top
 * (`windowPane`) and a fully lowered one not at all: whatever is drawn stays
 * inside the window's own opening, so it can never show outside the door.
 */
describe('car windows', () => {
  it('lower into the door, never out of it', () => {
    for (const a of ARCHETYPES) {
      if (a.shape !== 'car') continue;
      const model = buildVehicleModel(a);
      for (const door of model.doors) {
        if (door.kind !== 'hinge') continue;
        const shut = new Box3().setFromBufferAttribute(door.glass.getAttribute('position') as never);
        for (const drop of [0, 0.25, 0.45, 0.7, 0.9, 1]) {
          const pane = windowPane(door, drop);
          if (drop >= 0.98) {
            // Fully down: inside the door, not drawn.
            expect(pane.visible, `${a.id} door ${door.index}`).toBe(false);
            continue;
          }
          // What is drawn is always within the pane's own shut outline: the
          // opening in the door, never beside it, below it or outside it.
          const lowest = pane.up + shut.min.y * pane.sy;
          const highest = pane.up + shut.max.y * pane.sy;
          expect(lowest, `${a.id} door ${door.index} drop ${drop}`).toBeGreaterThan(shut.min.y - 1e-6);
          expect(highest, `${a.id} door ${door.index} drop ${drop}`).toBeLessThan(shut.max.y + 1e-6);
          expect(highest - lowest).toBeCloseTo((shut.max.y - shut.min.y) * (1 - drop), 6);
        }
      }
    }
  });

  it('are mostly shut, some part-way, some fully down', () => {
    let down = 0;
    let part = 0;
    for (let id = 0; id < 1000; id++) {
      const look = vehicleLook(id, 5);
      if (look.windowsDown !== 0) {
        down++;
        if (look.windowDrop < 1) part++;
      }
    }
    expect(down).toBeGreaterThan(200);
    expect(down).toBeLessThan(400);
    expect(part).toBeGreaterThan(40);
  });
});
