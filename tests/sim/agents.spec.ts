import { describe, expect, it } from 'vitest';

import {
  ARCHETYPES,
  archetypeById,
  archetypeWeights,
  type Archetype,
} from '@sim/vehicles/archetypes';
import {
  HAIR_COLOURS,
  SHIRT_COLOURS,
  SKIN_TONES,
  TROUSER_COLOURS,
  agentHash,
  pedLook,
  vehicleLook,
} from '@render/agents';
import { METERS_PER_UNIT } from '@world/units';

/**
 * The fleet's data, and the deterministic variation the renderer builds on.
 *
 * The renderer itself needs a GL context and is covered by the visual run; what
 * can be checked headlessly is that every archetype is physically sane, that
 * the spawn shares still form a distribution, and that the per-agent hash is
 * stable, bounded and actually spread — the three properties a frame-to-frame
 * appearance depends on. A hash that is stable but collapses onto one palette
 * entry produces a crowd of identical people and no test would notice.
 */

const metres = (units: number): number => units * METERS_PER_UNIT;

describe('vehicle archetypes', () => {
  it('describes every class with finite, positive dimensions', () => {
    for (const a of ARCHETYPES) {
      for (const [field, value] of [
        ['length', a.length],
        ['width', a.width],
        ['height', a.height],
        ['wheelRadius', a.wheelRadius],
      ] as const) {
        expect(Number.isFinite(value), `${a.id}.${field}`).toBe(true);
        expect(value, `${a.id}.${field}`).toBeGreaterThan(0);
      }
      // Nothing in the fleet is wider than it is long, and nothing is taller
      // than a low bridge; both would come out of a units mistake rather than a
      // design choice.
      expect(a.width, a.id).toBeLessThan(a.length);
      expect(metres(a.height), a.id).toBeLessThan(4.2);
      expect(metres(a.width), a.id).toBeLessThanOrEqual(2.6);
      // A wheel has to fit under the body.
      expect(a.wheelRadius * 2, a.id).toBeLessThan(a.height);
    }
  });

  it('gives every class sane IDM parameters', () => {
    for (const a of ARCHETYPES) {
      expect(a.a, a.id).toBeGreaterThan(0);
      expect(a.b, a.id).toBeGreaterThan(0);
      // Emergency braking must be harder than comfortable braking, or the safe
      // speed cap is looser than the interaction term and vehicles tailgate.
      expect(a.bEmergency, a.id).toBeGreaterThan(a.b);
      expect(a.T, a.id).toBeGreaterThan(0.5);
      expect(a.T, a.id).toBeLessThan(3);
      expect(a.s0, a.id).toBeGreaterThan(0);
      expect(a.speedFactor, a.id).toBeGreaterThan(0.2);
      expect(a.speedFactor, a.id).toBeLessThan(1.3);
      expect(a.axles, a.id).toBeGreaterThanOrEqual(2);
      expect(a.seats, a.id).toBeGreaterThanOrEqual(1);
      expect(a.cabinFraction, a.id).toBeGreaterThan(0);
      expect(a.cabinFraction, a.id).toBeLessThanOrEqual(1);
      expect(Math.abs(a.cabinShift), a.id).toBeLessThan(0.5);
      expect(a.palette.length, a.id).toBeGreaterThan(0);
      for (const swatch of a.palette) expect(swatch, a.id).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it('spreads the spawn share across the fleet and sums to one', () => {
    let total = 0;
    for (const [archetype, weight] of archetypeWeights()) {
      expect(weight, archetype.id).toBe(archetype.weight);
      expect(weight, archetype.id).toBeGreaterThan(0);
      total += weight;
    }
    expect(total).toBeCloseTo(1, 6);
    expect(archetypeWeights()).toHaveLength(ARCHETYPES.length);
  });

  it('contains the classes the traffic mix is meant to show', () => {
    const ids = ARCHETYPES.map((a) => a.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        'hatch',
        'sedan',
        'suv',
        'van',
        'bus',
        'truck',
        'motorcycle',
        'bicycle',
      ]),
    );
    const shapes = new Set(ARCHETYPES.map((a) => a.shape));
    expect([...shapes].sort()).toEqual(['bicycle', 'bus', 'car', 'motorcycle', 'truck']);
  });

  it('keeps the heavy classes heavy and the two-wheelers light', () => {
    const by = (id: string): Archetype => archetypeById(id);
    // A bus and a truck pull away slowly and want a long headway; a bicycle is
    // slow enough to be overtaken and needs almost no standstill gap.
    for (const id of ['bus', 'truck']) {
      expect(by(id).a, id).toBeLessThan(by('hatch').a);
      expect(by(id).T, id).toBeGreaterThan(by('sedan').T);
      expect(by(id).s0, id).toBeGreaterThan(by('sedan').s0);
    }
    expect(by('motorcycle').a).toBeGreaterThan(by('sedan').a);
    expect(by('motorcycle').T).toBeLessThan(by('sedan').T);
    expect(by('bicycle').speedFactor).toBeLessThan(0.4);
    expect(by('bicycle').s0).toBeLessThan(by('hatch').s0);
    // Hatchbacks and sedans have to dominate, or the street reads as a depot.
    expect(by('hatch').weight + by('sedan').weight).toBeGreaterThan(0.5);
    expect(by('bus').weight + by('truck').weight).toBeLessThan(0.1);
  });

  it('gives the heavy classes their own paint', () => {
    const car = new Set([...archetypeById('hatch').palette, ...archetypeById('sedan').palette]);
    for (const id of ['bus', 'truck']) {
      for (const swatch of archetypeById(id).palette) {
        expect(car.has(swatch), `${id} reuses ${swatch}`).toBe(false);
      }
    }
  });
});

describe('archetypeById', () => {
  it('round-trips every id', () => {
    for (const a of ARCHETYPES) expect(archetypeById(a.id)).toBe(a);
  });

  it('falls back to a real class on an id this build no longer ships', () => {
    // A saved document can name a class that has since been removed; the
    // alternative to substituting one is a crash on load.
    for (const missing of ['compact', '', 'tram', 'SEDAN']) {
      const fallback = archetypeById(missing);
      expect(ARCHETYPES).toContain(fallback);
      expect(fallback.length).toBeGreaterThan(0);
    }
  });
});

describe('agentHash', () => {
  it('is stable and unsigned', () => {
    for (let id = 0; id < 64; id++) {
      const first = agentHash(id);
      expect(agentHash(id)).toBe(first);
      expect(Number.isInteger(first)).toBe(true);
      expect(first).toBeGreaterThanOrEqual(0);
      expect(first).toBeLessThanOrEqual(0xffffffff);
    }
  });

  it('avalanches, so neighbouring ids do not look alike', () => {
    const seen = new Set<number>();
    for (let id = 0; id < 4096; id++) seen.add(agentHash(id));
    expect(seen.size).toBe(4096);
    // The low byte is what every palette index is taken from, so it is the byte
    // that has to be spread: a hash that only mixes the high bits would give a
    // whole crowd the same skin tone.
    const lowBytes = new Set<number>();
    for (let id = 0; id < 4096; id++) lowBytes.add(agentHash(id) & 0xff);
    expect(lowBytes.size).toBe(256);
  });
});

describe('pedLook', () => {
  it('is stable for an id', () => {
    for (let id = 0; id < 32; id++) expect(pedLook(id)).toEqual(pedLook(id));
  });

  it('keeps every field in range and every colour on its palette', () => {
    for (let id = 0; id < 600; id++) {
      const look = pedLook(id);
      expect(['child', 'adult', 'elder']).toContain(look.build);
      const height = metres(look.height);
      if (look.build === 'child') {
        expect(height).toBeGreaterThanOrEqual(1.05);
        expect(height).toBeLessThan(1.41);
      } else {
        expect(height).toBeGreaterThanOrEqual(1.5);
        expect(height).toBeLessThan(1.91);
      }
      expect(look.girth).toBeGreaterThanOrEqual(0.86);
      expect(look.girth).toBeLessThan(1.21);
      expect(look.stride).toBeGreaterThanOrEqual(0.86);
      expect(look.stride).toBeLessThan(1.21);
      expect(look.stoop).toBeGreaterThanOrEqual(0);
      expect(look.stoop).toBeLessThan(0.4);
      expect(SKIN_TONES).toContain(look.skin);
      expect(HAIR_COLOURS).toContain(look.hair);
      expect(TROUSER_COLOURS).toContain(look.trousers);
      // A child never walks a dog unaccompanied.
      if (look.build === 'child') expect(look.dog).toBe(false);
      // Children are top-heavy, which is most of what makes them read as
      // children rather than as small adults.
      expect(look.headFraction).toBeGreaterThan(look.build === 'child' ? 0.15 : 0.1);
      expect(look.headFraction).toBeLessThan(0.21);
    }
  });

  it('produces a crowd rather than a family', () => {
    const skins = new Set<number>();
    const hairs = new Set<number>();
    const trousers = new Set<number>();
    const builds = new Set<string>();
    let dogs = 0;
    let skirts = 0;
    const N = 1000;
    for (let id = 0; id < N; id++) {
      const look = pedLook(id);
      skins.add(look.skin);
      hairs.add(look.hair);
      trousers.add(look.trousers);
      builds.add(look.build);
      if (look.dog) dogs++;
      if (look.skirt) skirts++;
    }
    expect(skins.size).toBe(SKIN_TONES.length);
    expect(hairs.size).toBe(HAIR_COLOURS.length);
    expect(trousers.size).toBe(TROUSER_COLOURS.length);
    expect([...builds].sort()).toEqual(['adult', 'child', 'elder']);
    // Dogs are flavour: a tenth of the crowd at most, but not none.
    expect(dogs).toBeGreaterThan(N * 0.02);
    expect(dogs).toBeLessThan(N * 0.12);
    expect(skirts).toBeGreaterThan(N * 0.2);
    expect(skirts).toBeLessThan(N * 0.55);
  });
});

describe('vehicleLook', () => {
  it('is stable for an id', () => {
    for (let id = 0; id < 32; id++) expect(vehicleLook(id, 2)).toEqual(vehicleLook(id, 2));
  });

  it('never seats more people than the class has seats', () => {
    for (const a of ARCHETYPES) {
      for (let id = 0; id < 400; id++) {
        const look = vehicleLook(id, a.seats);
        expect(look.occupants, a.id).toBeGreaterThanOrEqual(1);
        expect(look.occupants, a.id).toBeLessThanOrEqual(a.seats);
        expect(look.windowsDown, a.id).toBeGreaterThanOrEqual(0);
        expect(look.windowsDown, a.id).toBeLessThanOrEqual(3);
        expect(SKIN_TONES).toContain(look.driverSkin);
        expect(SKIN_TONES).toContain(look.passengerSkin);
        expect(SHIRT_COLOURS).toContain(look.driverShirt);
        expect(SHIRT_COLOURS).toContain(look.passengerShirt);
      }
    }
  });

  it('gives every car a solid roof, one in five of them black', () => {
    // Glass roofs showed the whole cabin from the isometric camera and read
    // as a car with no roof; the people inside show through the dark side
    // glass close up instead.
    let glass = 0;
    let black = 0;
    let passengers = 0;
    for (let id = 0; id < 1000; id++) {
      const look = vehicleLook(id, 5);
      if (look.glassRoof) glass++;
      if (look.blackRoof) black++;
      if (look.occupants > 1) passengers++;
    }
    expect(glass).toBe(0);
    expect(black).toBeGreaterThan(120);
    expect(black).toBeLessThan(280);
    // Most cars carry somebody beside the driver.
    expect(passengers).toBeGreaterThan(500);
  });

  it('survives a degenerate seat count rather than producing a modulo by zero', () => {
    for (const seats of [0, -3, 0.4]) {
      const look = vehicleLook(7, seats);
      expect(Number.isInteger(look.occupants)).toBe(true);
      expect(look.occupants).toBe(1);
    }
  });

  it('puts some windows down and leaves some up', () => {
    let anyDown = 0;
    let allUp = 0;
    let bothDown = 0;
    for (let id = 0; id < 800; id++) {
      const down = vehicleLook(id, 2).windowsDown;
      if (down !== 0) anyDown++;
      if (down === 0) allUp++;
      if (down === 3) bothDown++;
    }
    expect(anyDown).toBeGreaterThan(200);
    expect(allUp).toBeGreaterThan(100);
    expect(bothDown).toBeGreaterThan(100);
  });

  it('fills a bus with several passengers and a car with one or two', () => {
    const bus = archetypeById('bus');
    let busy = 0;
    for (let id = 0; id < 400; id++) if (vehicleLook(id, bus.seats).occupants >= 3) busy++;
    expect(busy).toBeGreaterThan(100);

    const carSeats = archetypeById('sedan').seats;
    let solo = 0;
    for (let id = 0; id < 400; id++) if (vehicleLook(id, carSeats).occupants === 1) solo++;
    expect(solo).toBeGreaterThan(100);
    expect(solo).toBeLessThan(300);
  });
});
