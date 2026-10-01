import { beforeAll, describe, expect, it } from 'vitest';
import { Matrix4, Vector3, type Object3D } from 'three';
import {
  BIKE_FIT, HELMET_MAX, HELMET_SEGMENTS, MOTO_FIT, NO_HELMET, RIDER_CLIPS, STEER_FULL, gripPoint, headPoints, helmetShape, pedalPoint,
  type RiderClipKey, type TwoWheelerFit,
} from '@render/riderPoses';
import { CROWD } from '@render/citizenCasting';
import { buildTwoWheelerModel } from '@render/vehicleModels';
import { ARCHETYPES } from '@sim/vehicles/archetypes';
import { m } from '@world/units';
import { bonePosition, citizenRig } from './support/citizenRig';

/**
 * PEOPLE ON TWO-WHEELERS ARE ON THEM.
 *
 * Reported: a motorcyclist with a ball stuck in their head - the helmet, one
 * sphere of one size at a fixed height over the seat, through which a tall
 * or leaning rider's head came out. And measured before the fix: the hands
 * 18 to 25 cm off the grips, feet in the air beside a motorcycle that had no
 * footpegs, the right knee bent into the tank, and every contact drifting
 * with the rider's drawn height.
 *
 * Each check poses EVERY adult body of the roster (riders are never children)
 * exactly as the renderer bakes it, in node, and measures on the real
 * skeleton and mesh.
 */

// Every body the casting may put on a two-wheeler.
const ADULTS = CROWD.filter((m) => m.ageBand !== 'child' && m.rides !== false).map((m) => m.id);
const clip = (key: RiderClipKey) => RIDER_CLIPS.find((c) => c.key === key)!;

/** A posed rig, pelvis-relative, rig frame (+X left, +Y up, +Z forward), metres. */
async function posed(name: string, key: RiderClipKey, time = 0): Promise<{ rig: Object3D; at: (bone: string) => Vector3 }> {
  const rig = await citizenRig(name);
  clip(key).pose(rig, time);
  const pelvis = bonePosition(rig, 'Bip01_Pelvis');
  return { rig, at: (bone) => bonePosition(rig, bone).sub(pelvis) };
}

const v = (p: readonly [number, number, number]): Vector3 => new Vector3(p[0], p[1], p[2]);
/** Where the wrist sits on a grip: 3 cm above and 6 cm behind its centre, 2 cm in. */
const wristOn = (fit: TwoWheelerFit, side: 1 | -1, steer = 0): Vector3 =>
  v(gripPoint(fit, side, steer)).add(new Vector3(-side * 0.02, 0.03, -0.06));

describe('two-wheeler riders', () => {
  const helmets = new Map<string, Matrix4>();
  beforeAll(async () => {
    for (const name of ADULTS) {
      const shape = helmetShape(await citizenRig(name));
      if (shape) helmets.set(name, shape);
    }
  });

  it('a motorcyclist\'s helmet holds their whole head, on every body, in every riding pose', async () => {
    // The shell's facets lie inside the ellipsoid through their corners.
    const inside = 0.5 * Math.cos(Math.PI / HELMET_SEGMENTS.height) * Math.cos(Math.PI / HELMET_SEGMENTS.width);
    const worst: { name: string; key: string; reach: number }[] = [];
    for (const name of ADULTS) {
      const shape = helmets.get(name);
      expect(shape, name).toBeDefined();
      const toUnit = shape!.clone().invert();
      for (const key of ['motoRide', 'motoLeft', 'motoRight', 'motoStop'] as const) {
        const { rig } = await posed(name, key);
        const head = rig.getObjectByName('Bip01_Head')!;
        let reach = 0;
        for (const p of headPoints(rig, head)) reach = Math.max(reach, p.applyMatrix4(toUnit).length());
        worst.push({ name, key, reach });
      }
    }
    worst.sort((a, b) => b.reach - a.reach);
    expect(worst[0]!.reach, `${worst[0]!.name} ${worst[0]!.key}`).toBeLessThanOrEqual(inside);
  });

  it('a helmet is the size of a helmet, round the skull; no motorcyclist rides on a head no helmet fits', async () => {
    for (const name of ADULTS) {
      const shape = helmets.get(name)!;
      const rig = await citizenRig(name);
      const head = rig.getObjectByName('Bip01_Head')!;
      const world = head.matrixWorld.clone().multiply(shape);
      const size = new Vector3().setFromMatrixScale(world);
      // Diameters, metres: a real helmet is about 26 cm wide and 32 cm long.
      // A body whose hair needs more is never drawn on a motorcycle, and the
      // list of them (`NO_HELMET`) is exactly the heads that need more.
      const largest = Math.max(size.x, size.y, size.z);
      expect(NO_HELMET.has(name), `${name}: ${largest.toFixed(2)} m`).toBe(largest > HELMET_MAX);
      if (NO_HELMET.has(name)) continue;
      for (const d of [size.x, size.y, size.z]) expect(d, name).toBeGreaterThan(0.2);
      // Its centre within 8 cm of the middle of the skull.
      const centre = new Vector3().setFromMatrixPosition(world);
      const skull = head.localToWorld(new Vector3(9, 0.5, 0));
      expect(centre.distanceTo(skull), name).toBeLessThan(0.08);
    }
  });

  it('a motorcyclist has their hands on the grips, the grips turning with the bars', async () => {
    for (const name of ADULTS) {
      for (const [key, steer] of [['motoRide', 0], ['motoLeft', STEER_FULL], ['motoRight', -STEER_FULL], ['motoStop', 0]] as const) {
        const { at } = await posed(name, key);
        expect(at('Bip01_L_Hand').distanceTo(wristOn(MOTO_FIT, 1, steer)), `${name} ${key} left hand`).toBeLessThan(steer === 0 ? 0.05 : 0.08);
        expect(at('Bip01_R_Hand').distanceTo(wristOn(MOTO_FIT, -1, steer)), `${name} ${key} right hand`).toBeLessThan(steer === 0 ? 0.05 : 0.08);
      }
    }
  });

  it('a motorcyclist rides with the feet on the pegs, the knees either side of the tank', async () => {
    const peg = MOTO_FIT.peg!;
    for (const name of ADULTS) {
      const { at } = await posed(name, 'motoRide');
      for (const side of [1, -1] as const) {
        const foot = at(side === 1 ? 'Bip01_L_Foot' : 'Bip01_R_Foot');
        const pegAt = new Vector3(side * peg.side, peg.up, peg.forward);
        // The ankle over the peg, 7 cm up and 8 cm behind it.
        expect(foot.distanceTo(pegAt.clone().add(new Vector3(0, 0.07, -0.08))), `${name} foot`).toBeLessThan(0.06);
        const knee = at(side === 1 ? 'Bip01_L_Calf' : 'Bip01_R_Calf');
        expect(side * knee.x, `${name} knee on its own side`).toBeGreaterThan(0.1);
      }
    }
  });

  it('a stopped rider has a foot down on the road, the machine tilted onto it', async () => {
    for (const [key, fit] of [['motoStop', MOTO_FIT], ['bikeStop', BIKE_FIT]] as const) {
      const t = fit.stopTilt;
      for (const name of ADULTS) {
        const { at } = await posed(name, key);
        const ankle = at('Bip01_L_Foot');
        // Rolled onto the left about the tyres' line on the road (`agents.frameAt`).
        const h = fit.pelvisY + ankle.y;
        const height = -ankle.x * Math.sin(t) + h * Math.cos(t);
        expect(height, `${name} ${key} ankle over the road`).toBeGreaterThan(0.02);
        expect(height, `${name} ${key} ankle over the road`).toBeLessThan(0.17);
      }
    }
  });

  it('a cyclist\'s feet go round with the pedals, and the hands are on the bars', async () => {
    for (const name of ADULTS.filter((_, i) => i % 3 === 0)) {
      for (const time of [0, 0.25, 0.5, 0.75]) {
        const { at } = await posed(name, 'bikePedal', time);
        const angle = time * Math.PI * 2;
        const left = v(pedalPoint(BIKE_FIT, angle, 1));
        const right = v(pedalPoint(BIKE_FIT, angle + Math.PI, -1));
        expect(at('Bip01_L_Foot').distanceTo(left), `${name} ${time} left foot`).toBeLessThan(0.14);
        expect(at('Bip01_R_Foot').distanceTo(right), `${name} ${time} right foot`).toBeLessThan(0.14);
        expect(at('Bip01_L_Hand').distanceTo(wristOn(BIKE_FIT, 1)), `${name} left hand`).toBeLessThan(0.05);
        expect(at('Bip01_R_Hand').distanceTo(wristOn(BIKE_FIT, -1)), `${name} right hand`).toBeLessThan(0.05);
      }
    }
  });

  it('builds the machines round the rider: saddle under the pelvis, grips, pegs and bracket where the poses reach', () => {
    for (const id of ['motorcycle', 'bicycle'] as const) {
      const model = buildTwoWheelerModel(ARCHETYPES.find((a) => a.id === id)!);
      const fit = model.fit;
      expect(model.seatY).toBeCloseTo(m(fit.pelvisY), 6);
      expect(model.headX - model.seatX).toBeCloseTo(m(fit.steerAxis), 6);
      // The saddle's top is under the pelvis bone by the seat of the trousers.
      model.trim.computeBoundingBox();
      if (fit.bracket) {
        expect(model.bracketX - model.seatX).toBeCloseTo(m(fit.bracket.forward), 6);
        expect(model.bracketY - model.seatY).toBeCloseTo(m(fit.bracket.up), 6);
      }
      // The grips are in the steering part, on the bars.
      const steering = model.steering;
      steering.computeBoundingBox();
      const box = steering.boundingBox!;
      const grip = v(gripPoint(fit, 1));
      expect(box.min.z).toBeLessThanOrEqual(-m(grip.x) + 1e-6);
      expect(box.max.z).toBeGreaterThanOrEqual(m(grip.x) - 1e-6);
    }
  });
});
