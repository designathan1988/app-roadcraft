import { describe, expect, it } from 'vitest';

import {
  DEFAULT_AZIMUTH,
  DEFAULT_ELEVATION,
  MAX_ELEVATION,
  MIN_ELEVATION,
  createIsoRig,
} from '@render/isoViewport';

const W = 1200;
const H = 800;

function rig(azimuth = DEFAULT_AZIMUTH, elevation = DEFAULT_ELEVATION) {
  const r = createIsoRig({ x: 100, y: -40 }, 60, { azimuth, elevation });
  r.resize(W, H);
  return r.viewport;
}

describe('free-orbit camera', () => {
  it('turns any bearing and tilt and still maps screen to ground and back', () => {
    for (const az of [0, 0.4, 1.9, 3.3, 5.8]) {
      for (const el of [MIN_ELEVATION, 0.9, 1.3, MAX_ELEVATION]) {
        const v = rig(az, el);
        for (const [px, py] of [[10, 10], [600, 400], [1100, 700], [300, 650]] as const) {
          const g = v.toWorld(px, py, W, H);
          const s = v.toScreen(g, W, H);
          expect(Math.hypot(s.x - px, s.y - py)).toBeLessThan(1e-6);
        }
      }
    }
  });

  it('orbits about the centre of the view: the ground there stays put', () => {
    const v = rig();
    const before = v.centre;
    const under = v.toWorld(W / 2, H / 2, W, H);
    v.orbit(1.1, -0.3);
    expect(v.centre).toEqual(before);
    const after = v.toWorld(W / 2, H / 2, W, H);
    expect(Math.hypot(after.x - under.x, after.y - under.y)).toBeLessThan(1e-6);
  });

  it('tilts no lower than 30 degrees and no further than straight down', () => {
    const v = rig();
    v.orbit(0, -5);
    expect(v.elevation).toBeCloseTo(MIN_ELEVATION, 12);
    v.orbit(0, 10);
    expect(v.elevation).toBeCloseTo(MAX_ELEVATION, 12);
    v.setOrbit(-0.5, Number.NaN);
    expect(Number.isFinite(v.azimuth)).toBe(true);
    expect(v.azimuth).toBeGreaterThanOrEqual(0);
  });

  it('keeps its bearing looking straight down, instead of spinning at random', () => {
    for (const az of [0, 1, 2.5, 4]) {
      const v = rig(az, MAX_ELEVATION);
      const c = v.centre;
      // The camera sits on the +azimuth side, so the ground on the far side
      // (-azimuth) is "ahead" and must be drawn above the centre of the screen.
      const ahead = { x: c.x - Math.cos(az) * 20, y: c.y + Math.sin(az) * 20 };
      const s = v.toScreen(ahead, W, H);
      expect(s.y).toBeLessThan(H / 2 - 10);
      expect(Math.abs(s.x - W / 2)).toBeLessThan(1e-6);
    }
  });

  it('zooms about the pointer at any orbit', () => {
    const v = rig(2.2, 0.7);
    const grabbed = v.toWorld(900, 200, W, H);
    v.zoomAt(900, 200, 1.7, W, H);
    const now = v.toWorld(900, 200, W, H);
    expect(Math.hypot(now.x - grabbed.x, now.y - grabbed.y)).toBeLessThan(1e-6);
  });

  it('a quarter turn still reads as a facing, for the callers that step by quarters', () => {
    const v = rig();
    expect(v.facing).toBe(0);
    v.rotate(1, W / 2, H / 2, W, H);
    expect(v.facing).toBe(1);
    v.orbit(0.2, 0);
    expect(v.facing).toBe(1);
    v.rotate(-2, W / 2, H / 2, W, H);
    expect(v.facing).toBe(3);
  });

  it('a positive orbit turns the map anticlockwise on screen (the sign the twist and the drag rely on)', () => {
    const v = rig(1.3, 0.9);
    // A point drawn straight below the centre of the screen.
    const below = v.toWorld(W / 2, H / 2 + 150, W, H);
    v.orbit(0.1, 0);
    const s = v.toScreen(below, W, H);
    // Anticlockwise, the six o'clock point swings towards five: to the right.
    expect(s.x).toBeGreaterThan(W / 2 + 5);
  });
});
