import { describe, expect, it } from 'vitest';

import {
  RIVER_CARVE,
  TERRAIN_MAX_HEIGHT,
  TERRAIN_MIN_HEIGHT,
  TerrainIndex,
  baseRelief,
  sampleTerrainHeight,
  terrainInfluence,
  type TerrainStamp,
} from '@world/terrain';

const stamp = (over: Partial<TerrainStamp> = {}): TerrainStamp => ({
  id: 1,
  x: 0,
  y: 0,
  radius: 100,
  strength: 10,
  mode: 'raise',
  ...over,
});

describe('base relief', () => {
  it('is deterministic', () => {
    expect(baseRelief(123.5, -88.25)).toBe(baseRelief(123.5, -88.25));
  });

  it('is continuous: a small step never moves the ground far', () => {
    let worst = 0;
    for (let i = 0; i < 400; i++) {
      const x = -2000 + i * 10;
      worst = Math.max(worst, Math.abs(baseRelief(x, 37) - baseRelief(x + 0.5, 37)));
    }
    expect(worst).toBeLessThan(0.5);
  });

  it('stays inside a gradient a road at grade can absorb', () => {
    // 12% is the ground road's limit; the land must not routinely exceed it or
    // every road becomes an embankment.
    let steepest = 0;
    for (let x = -2000; x < 2000; x += 7) {
      for (let y = -2000; y < 2000; y += 293) {
        steepest = Math.max(steepest, Math.abs(baseRelief(x + 7, y) - baseRelief(x, y)) / 7);
      }
    }
    expect(steepest).toBeLessThan(0.3);
  });

  it('is not flat — a flat plane is what made the scene read as a drawing', () => {
    let low = Infinity;
    let high = -Infinity;
    for (let i = 0; i < 500; i++) {
      const value = baseRelief(i * 13.7, i * -9.1);
      low = Math.min(low, value);
      high = Math.max(high, value);
    }
    expect(high - low).toBeGreaterThan(8);
  });
});

describe('terrain stamps', () => {
  it('raises at the centre and fades to nothing at the rim', () => {
    const base = baseRelief(0, 0);
    expect(sampleTerrainHeight([stamp()], 0, 0) - base).toBeCloseTo(10, 5);
    expect(sampleTerrainHeight([stamp()], 100, 0)).toBeCloseTo(baseRelief(100, 0), 5);
  });

  it('lowers by the same amount it raises', () => {
    const up = sampleTerrainHeight([stamp({ mode: 'raise' })], 12, 5) - baseRelief(12, 5);
    const down = baseRelief(12, 5) - sampleTerrainHeight([stamp({ mode: 'lower' })], 12, 5);
    expect(up).toBeCloseTo(down, 9);
  });

  it('carves a river deeper than a lower of the same strength', () => {
    const lower = baseRelief(0, 0) - sampleTerrainHeight([stamp({ mode: 'lower' })], 0, 0);
    const river = baseRelief(0, 0) - sampleTerrainHeight([stamp({ mode: 'river' })], 0, 0);
    expect(river / lower).toBeCloseTo(RIVER_CARVE, 6);
  });

  it('clamps to the height range', () => {
    const tall = Array.from({ length: 40 }, (_, i) => stamp({ id: i, strength: 10 }));
    expect(sampleTerrainHeight(tall, 0, 0)).toBeLessThanOrEqual(TERRAIN_MAX_HEIGHT);
    const deep = Array.from({ length: 40 }, (_, i) => stamp({ id: i, strength: 10, mode: 'lower' }));
    expect(sampleTerrainHeight(deep, 0, 0)).toBeGreaterThanOrEqual(TERRAIN_MIN_HEIGHT);
  });

  it('influence is monotone from rim to centre', () => {
    for (let i = 1; i <= 10; i++) {
      expect(terrainInfluence(i / 10)).toBeGreaterThan(terrainInfluence((i - 1) / 10));
    }
  });
});

describe('TerrainIndex', () => {
  const stamps = Array.from({ length: 60 }, (_, i) =>
    stamp({ id: i, x: (i % 10) * 90 - 400, y: Math.floor(i / 10) * 90 - 250, radius: 70, strength: 3 }),
  );

  it('answers exactly what a linear scan answers', () => {
    const index = new TerrainIndex(stamps, 1);
    for (let i = 0; i < 200; i++) {
      const x = -600 + i * 6;
      const y = -300 + ((i * 37) % 600);
      expect(sampleTerrainHeight(index, x, y)).toBeCloseTo(sampleTerrainHeight(stamps, x, y), 9);
    }
  });

  it('copies the stamp list rather than aliasing it', () => {
    const live = [...stamps];
    const index = new TerrainIndex(live, 1);
    live.push(stamp({ id: 999 }));
    expect(index.stamps.length).toBe(60);
  });
});

describe('levelling', () => {
  it('pulls the ground towards a stamp’s own target height', () => {
    const at = { x: 40, y: -18 };
    const before = sampleTerrainHeight([], at.x, at.y);
    const target = before + 9;
    const stamp: TerrainStamp = {
      id: 1,
      x: at.x,
      y: at.y,
      radius: 90,
      strength: 10,
      mode: 'flatten',
      level: target,
    };
    const after = sampleTerrainHeight([stamp], at.x, at.y);
    expect(after).toBeCloseTo(target, 6);
  });

  it('is unchanged for a stamp written before the target existed', () => {
    // The old rule scaled the ground towards sea level. Levelling towards an
    // absent target must reproduce it exactly, or every saved map shifts.
    const at = { x: -120, y: 65 };
    const base: Omit<TerrainStamp, 'level'> = {
      id: 2,
      x: at.x,
      y: at.y,
      radius: 70,
      strength: 6,
      mode: 'flatten',
    };
    const legacy = sampleTerrainHeight([base as TerrainStamp], at.x, at.y);
    const explicit = sampleTerrainHeight([{ ...base, level: 0 }], at.x, at.y);
    expect(explicit).toBeCloseTo(legacy, 9);
  });

  it('leaves the ground alone outside the brush', () => {
    const stamp: TerrainStamp = {
      id: 3, x: 0, y: 0, radius: 50, strength: 10, mode: 'flatten', level: 30,
    };
    const far = { x: 400, y: 400 };
    expect(sampleTerrainHeight([stamp], far.x, far.y)).toBeCloseTo(
      sampleTerrainHeight([], far.x, far.y),
      9,
    );
  });
});
