import { describe, expect, it } from 'vitest';
import { Mesh } from 'three';

import { unifiedWaterGeometry, type WaterStamp } from '@render/terrain';
import {
  WATER_CLOCK_WRAP,
  WATER_DEPTH_ATTRIBUTE,
  WATER_DRIFTS,
  createWaterSurface,
  waterClock,
  waterNormalTexels,
  waterTextureSize,
} from '@render/water';

/**
 * What the water owes the shader, stated as tests.
 *
 * None of this needs a GL context: the normal map is baked into a byte array
 * rather than a canvas, and the geometry builder only ever touches numbers. The
 * one thing a headless runner genuinely cannot check — that the injected GLSL
 * compiles — is checked by `npm run verify:visual`, which boots the real app.
 */

/** A bowl, so a disc of water at level 0 has a real bed and a real shore. */
const bowl = (x: number, y: number): number => Math.hypot(x, y) / 12 - 20;

const disc = (level: number): WaterStamp[] => [{ x: 0, y: 0, radius: 180, level }];

function attribute(geometry: ReturnType<typeof unifiedWaterGeometry>, name: string) {
  const found = geometry.getAttribute(name);
  expect(found).toBeDefined();
  return found;
}

describe('waterNormalTexels', () => {
  it('fills one rgba texel per pixel', () => {
    expect(waterNormalTexels(64)).toHaveLength(64 * 64 * 4);
  });

  it('is deterministic, so two tiers bake the same water', () => {
    expect(Array.from(waterNormalTexels(32))).toEqual(Array.from(waterNormalTexels(32)));
  });

  it('points every normal out of the surface', () => {
    // A tangent-space normal whose z falls to or below the encoding midpoint is
    // one pointing into the surface, which lights the water from underneath.
    const data = waterNormalTexels(64);
    for (let i = 2; i < data.length; i += 4) expect(data[i] as number).toBeGreaterThan(127);
  });

  it('varies the foam channel rather than baking it flat', () => {
    const data = waterNormalTexels(64);
    let low = 255;
    let high = 0;
    for (let i = 3; i < data.length; i += 4) {
      low = Math.min(low, data[i] as number);
      high = Math.max(high, data[i] as number);
    }
    expect(high - low).toBeGreaterThan(40);
  });

  it('tiles: the wrap seam is no sharper than the texture is anywhere else', () => {
    // The whole reason the bake uses periodic noise. A seam shows up as a step
    // in the normal down one column, and nothing else in the image looks like it.
    const size = 64;
    const data = waterNormalTexels(size);
    const at = (x: number, y: number, channel: number): number =>
      data[(y * size + x) * 4 + channel] as number;
    const columnStep = (a: number, b: number): number => {
      let total = 0;
      for (let y = 0; y < size; y++) {
        for (let c = 0; c < 3; c++) total += Math.abs(at(a, y, c) - at(b, y, c));
      }
      return total / (size * 3);
    };
    let interior = 0;
    for (let x = 1; x < size - 1; x++) interior += columnStep(x, x + 1);
    interior /= size - 2;
    expect(columnStep(size - 1, 0)).toBeLessThan(interior * 3);
  });
});

describe('the quality tier and the clock', () => {
  it('sizes the texture from the anisotropy the tier already sets', () => {
    expect(waterTextureSize(2)).toBe(128);
    expect(waterTextureSize(4)).toBe(128);
    expect(waterTextureSize(8)).toBe(256);
    expect(waterTextureSize(16)).toBe(256);
  });

  it('keeps every size a power of two', () => {
    for (const anisotropy of [1, 2, 4, 8, 16]) {
      const size = waterTextureSize(anisotropy);
      expect(size & (size - 1)).toBe(0);
    }
  });

  it('wraps the clock on a whole number of tiles, so the wrap is invisible', () => {
    // Without this the scroll offset jumps at the wrap and the river stutters
    // once every sixteen minutes.
    for (const drift of WATER_DRIFTS) {
      for (const axis of drift) {
        expect(Number.isInteger(axis * WATER_CLOCK_WRAP)).toBe(true);
      }
    }
  });

  it('advances and then wraps', () => {
    expect(waterClock(0)).toBe(0);
    expect(waterClock(2_500)).toBeCloseTo(2.5, 9);
    expect(waterClock(WATER_CLOCK_WRAP * 1_000)).toBeCloseTo(0, 9);
    expect(waterClock(WATER_CLOCK_WRAP * 1_000 + 3_000)).toBeCloseTo(3, 9);
  });
});

describe('createWaterSurface', () => {
  it('builds a transparent, front-facing, repeating surface', () => {
    const surface = createWaterSurface(8);
    expect(surface.material.transparent).toBe(true);
    expect(surface.material.normalMap).not.toBeNull();
    expect(surface.material.normalMap?.wrapS).toBe(1_000); // RepeatWrapping
    expect(surface.material.normalMap?.wrapT).toBe(1_000);
    const image = surface.material.normalMap?.image as { width: number } | undefined;
    expect(image?.width).toBe(256);
    surface.dispose();
  });

  it('drives its own clock from the mesh it is attached to', async () => {
    const surface = createWaterSurface(4);
    const mesh = new Mesh();
    surface.attach(mesh);
    expect(surface.time.value).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 30));
    // The arguments are the renderer's; nothing here reads them.
    (mesh.onBeforeRender as unknown as () => void)();
    expect(surface.time.value).toBeGreaterThan(0);
    surface.dispose();
  });
});

describe('unifiedWaterGeometry', () => {
  it('builds nothing at all without a stamp', () => {
    expect(unifiedWaterGeometry([], bowl).getAttribute('position')).toBeUndefined();
  });

  it('builds nothing where the land stands above the surface', () => {
    // The invariant that matters most: water hanging in open air is worse than
    // no water. A level under the ground must produce no triangles at all.
    const geometry = unifiedWaterGeometry(disc(-40), () => 0);
    expect(geometry.getAttribute('position')?.count ?? 0).toBe(0);
  });

  it('writes one depth, one uv and one normal per position', () => {
    const geometry = unifiedWaterGeometry(disc(0), bowl);
    const position = attribute(geometry, 'position');
    expect(position.count).toBeGreaterThan(0);
    expect(position.count % 3).toBe(0);
    expect(attribute(geometry, WATER_DEPTH_ATTRIBUTE).count).toBe(position.count);
    expect(attribute(geometry, 'uv').count).toBe(position.count);
    expect(attribute(geometry, 'normal').count).toBe(position.count);
  });

  it('keeps every vertex finite', () => {
    const geometry = unifiedWaterGeometry(disc(0), bowl);
    const position = attribute(geometry, 'position');
    const depth = attribute(geometry, WATER_DEPTH_ATTRIBUTE);
    for (let i = 0; i < position.count; i++) {
      expect(Number.isFinite(position.getX(i))).toBe(true);
      expect(Number.isFinite(position.getY(i))).toBe(true);
      expect(Number.isFinite(position.getZ(i))).toBe(true);
      expect(Number.isFinite(depth.getX(i))).toBe(true);
    }
  });

  it('never leaves a vertex above the ground under it', () => {
    const geometry = unifiedWaterGeometry(disc(0), bowl);
    const position = attribute(geometry, 'position');
    for (let i = 0; i < position.count; i++) {
      // World y is mirrored into three's z, so the sampler wants -z back.
      expect(position.getY(i)).toBeGreaterThan(bowl(position.getX(i), -position.getZ(i)));
    }
  });

  it('carries the depth the shader tints and foams from', () => {
    const geometry = unifiedWaterGeometry(disc(0), bowl);
    const position = attribute(geometry, 'position');
    const depth = attribute(geometry, WATER_DEPTH_ATTRIBUTE);
    let deepest = 0;
    let shallowest = Infinity;
    for (let i = 0; i < position.count; i++) {
      const expected = position.getY(i) - bowl(position.getX(i), -position.getZ(i));
      expect(depth.getX(i)).toBeCloseTo(expected, 3);
      expect(depth.getX(i)).toBeGreaterThan(0);
      deepest = Math.max(deepest, depth.getX(i));
      shallowest = Math.min(shallowest, depth.getX(i));
    }
    // A flat depth would make the tint, the opacity ramp and the foam band all
    // constant, which is the defect the attribute exists to fix.
    expect(deepest).toBeCloseTo(20, 0);
    expect(shallowest).toBeLessThan(1);
  });

  it('winds every face upwards and normals it upwards', () => {
    // Front faces, so the sheet is rasterised once rather than twice, and a
    // plane normal, so the Fresnel term does not break into per-cell facets.
    const geometry = unifiedWaterGeometry(disc(0), bowl);
    const position = attribute(geometry, 'position');
    const normal = attribute(geometry, 'normal');
    for (let i = 0; i < position.count; i += 3) {
      const ux = position.getX(i + 1) - position.getX(i);
      const uz = position.getZ(i + 1) - position.getZ(i);
      const vx = position.getX(i + 2) - position.getX(i);
      const vz = position.getZ(i + 2) - position.getZ(i);
      expect(uz * vx - ux * vz).toBeGreaterThan(0);
    }
    for (let i = 0; i < normal.count; i++) {
      expect(normal.getX(i)).toBe(0);
      expect(normal.getY(i)).toBe(1);
      expect(normal.getZ(i)).toBe(0);
    }
  });

  it('runs the surface downhill when the stamps disagree about the level', () => {
    // The union's whole point: two overlapping stamps at different levels give a
    // sloping river, not two flat sheets with a step between them.
    const flat = (): number => -30;
    const geometry = unifiedWaterGeometry(
      [
        { x: -120, y: 0, radius: 150, level: -2 },
        { x: 120, y: 0, radius: 150, level: -9 },
      ],
      flat,
    );
    const position = attribute(geometry, 'position');
    let west = -Infinity;
    let east = Infinity;
    for (let i = 0; i < position.count; i++) {
      if (position.getX(i) < -140) west = Math.max(west, position.getY(i));
      if (position.getX(i) > 140) east = Math.min(east, position.getY(i));
    }
    expect(west).toBeGreaterThan(east);
  });
});
