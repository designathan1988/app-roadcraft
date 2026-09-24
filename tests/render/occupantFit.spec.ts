import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { ARCHETYPES } from '@sim/vehicles/archetypes';
import {
  SEATED_EXTENTS, buildBusModel, buildTruckModel, buildVehicleModel, extentsOf, seatFitScale,
} from '@render/vehicleModels';
import { m } from '@world/units';

/**
 * EVERY OCCUPANT FITS INSIDE THEIR VEHICLE.
 *
 * Reported: people in cars with parts of their bodies outside the bodywork.
 * The cause was the seated clips (chair poses, head 0.91 m above the pelvis,
 * feet 0.54 m below it) in cabins 1.1 m tall. Occupants now sit in car-seat
 * poses, and each seat of each model states the room it has; this checks the
 * worst body of the roster, measured on the rig, against every seat.
 */
describe('occupants', () => {
  const measured = JSON.parse(readFileSync('docs/audit/seated-pose-extents.json', 'utf8')) as
    Record<'carDrive' | 'carRide', { top: number; bottom: number; fwd: number; half: number }>;

  it('uses extents no smaller than those measured on the roster', () => {
    for (const pose of [measured.carDrive, measured.carRide]) {
      expect(SEATED_EXTENTS.top).toBeGreaterThanOrEqual(pose.top - 1e-3);
      expect(SEATED_EXTENTS.bottom).toBeGreaterThanOrEqual(-pose.bottom - 1e-3);
      expect(SEATED_EXTENTS.forward).toBeGreaterThanOrEqual(pose.fwd - 1e-3);
      expect(SEATED_EXTENTS.half).toBeGreaterThanOrEqual(pose.half - 1e-3);
    }
  });

  it('seats every body of the roster inside every cabin, at a human size', () => {
    for (const a of ARCHETYPES) {
      const model = a.shape === 'car' ? buildVehicleModel(a)
        : a.shape === 'bus' ? buildBusModel(a) : a.shape === 'truck' ? buildTruckModel(a) : null;
      if (!model) continue;
      expect(model.seats.length, a.id).toBeGreaterThanOrEqual(a.seats);
      for (const seat of model.seats) {
        const s = seatFitScale(seat);
        // Nobody is shrunk into a child to make them fit: at worst the
        // tallest body of the roster is drawn at 90 % in the lowest cabin.
        expect(s, `${a.id} seat at ${seat.x.toFixed(1)}`).toBeGreaterThanOrEqual(0.9);
        const u = (metres: number): number => m(metres) * s;
        // A car seat is sized for the reclined car poses, a bus seat for the
        // upright captured sitting clip.
        const e = extentsOf(seat);
        expect(u(e.top), `${a.id} head`).toBeLessThanOrEqual(seat.headroom);
        expect(u(e.bottom), `${a.id} feet`).toBeLessThanOrEqual(seat.hipY - seat.floor + 1e-6);
        expect(u(e.forward), `${a.id} legs`).toBeLessThanOrEqual(seat.legroom + 1e-6);
        expect(u(e.half), `${a.id} shoulders`).toBeLessThanOrEqual(seat.sideRoom + 1e-6);
        // And the seat itself is inside the body.
        expect(Math.abs(seat.z) + u(e.half)).toBeLessThan(a.width / 2);
        expect(seat.hipY + u(e.top)).toBeLessThan(a.height);
      }
    }
  });
});
