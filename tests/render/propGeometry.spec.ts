import { describe, expect, it } from 'vitest';
import type { BufferGeometry } from 'three';

import {
  BUSH_KINDS,
  TREE_SPECIES,
  benchGeometry,
  binGeometry,
  bushGeometry,
  grassTuftGeometry,
  hydrantGeometry,
  lampGeometry,
  lampLensGeometry,
  postboxGeometry,
  treeGeometry,
  treePitGeometry,
  wildflowerGeometry,
  LAMP_HEIGHT,
} from '@render/propGeometry';

/**
 * The prop models' contract. The wind shader reads a plant's local `y` as the
 * fraction of its height, so a plant that is not one unit tall with its root
 * at the origin bends from the wrong place: a tree rooted below zero swings
 * its trunk through the ground.
 */

function check(geometry: BufferGeometry): { minY: number; maxY: number } {
  const position = geometry.getAttribute('position');
  const normal = geometry.getAttribute('normal');
  const color = geometry.getAttribute('color');
  expect(position.count % 3).toBe(0);
  expect(normal.count).toBe(position.count);
  expect(color.count).toBe(position.count);
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < position.count; i++) {
    const values = [position.getX(i), position.getY(i), position.getZ(i), color.getX(i), color.getY(i), color.getZ(i)];
    for (const value of values) expect(Number.isFinite(value)).toBe(true);
    minY = Math.min(minY, position.getY(i));
    maxY = Math.max(maxY, position.getY(i));
  }
  return { minY, maxY };
}

describe('vegetation models', () => {
  it('are one unit tall with the root at the origin', () => {
    for (const species of TREE_SPECIES) {
      const { minY, maxY } = check(treeGeometry(species));
      expect(minY, species).toBeGreaterThanOrEqual(-0.01);
      expect(maxY, species).toBeGreaterThan(0.85);
      expect(maxY, species).toBeLessThan(1.15);
    }
    for (const kind of BUSH_KINDS) {
      const { minY, maxY } = check(bushGeometry(kind));
      expect(minY, kind).toBeGreaterThanOrEqual(-0.05);
      expect(maxY, kind).toBeLessThan(1.15);
    }
    for (const geometry of [grassTuftGeometry(), wildflowerGeometry()]) {
      const { minY, maxY } = check(geometry);
      expect(minY).toBeGreaterThanOrEqual(-0.01);
      expect(maxY).toBeLessThanOrEqual(1.01);
    }
  });

  it('stay within a budget a thousand-tree map can afford', () => {
    for (const species of TREE_SPECIES) {
      expect(treeGeometry(species).getAttribute('position').count / 3, species).toBeLessThan(900);
    }
    expect(grassTuftGeometry().getAttribute('position').count / 3).toBeLessThanOrEqual(40);
  });
});

describe('street furniture models', () => {
  it('stand on the ground at real size', () => {
    const lamp = check(lampGeometry());
    expect(lamp.minY).toBeGreaterThanOrEqual(-0.01);
    expect(Math.abs(lamp.maxY - LAMP_HEIGHT)).toBeLessThan(1);
    check(lampLensGeometry());
    for (const geometry of [benchGeometry(), binGeometry(), hydrantGeometry(), postboxGeometry(), treePitGeometry()]) {
      const { minY, maxY } = check(geometry);
      expect(minY).toBeGreaterThanOrEqual(-0.01);
      // Nothing on the pavement is taller than a person, in world units.
      expect(maxY).toBeLessThan(5);
    }
  });
});
