import { describe, expect, it } from 'vitest';
import { ROAD_TYPES, halfWidth, roadProfile } from '@world/roadTypes';
import { Level } from '@world/roadTypes';
import { sectionOf, bandWidth, MIN_THROUGH } from '@world/section';
import { m } from '@world/units';

/**
 * The cross-section is the one description of what lies across a road. It
 * must reproduce, exactly, the rings every map has been drawn with (so no
 * saved city changes), and give every footway a through zone people can walk.
 */
describe('cross-section', () => {
  for (let t = 0; t < ROAD_TYPES.length; t++) {
    const rt = roadProfile(t);
    it(`${rt.id}: the bands are the rings the road is drawn with`, () => {
      const s = sectionOf(rt);
      expect(s.carriageway).toBeCloseTo(halfWidth(rt, Level.Asphalt), 9);
      expect(s.side.curb.outer).toBeCloseTo(halfWidth(rt, Level.Curb), 9);
      expect(s.side.frontage.outer).toBeCloseTo(halfWidth(rt, Level.Sidewalk), 9);
    });
    it(`${rt.id}: the zones tile the footway, in order, none negative`, () => {
      const z = sectionOf(rt).side;
      const bands = [z.curb, z.furnishing, z.through, z.frontage];
      for (const b of bands) expect(bandWidth(b)).toBeGreaterThanOrEqual(0);
      for (let i = 1; i < bands.length; i++) expect(bands[i]!.inner).toBeCloseTo(bands[i - 1]!.outer, 9);
    });
    it(`${rt.id}: a walked footway keeps a through zone`, () => {
      const s = sectionOf(rt);
      if (!s.walkable) return;
      expect(bandWidth(s.side.through)).toBeGreaterThanOrEqual(MIN_THROUGH - 1e-9);
    });
  }
  it('highways and ramps are not walked; streets are', () => {
    const walked = ROAD_TYPES.map((_, t) => [roadProfile(t).id, sectionOf(roadProfile(t)).walkable]);
    expect(Object.fromEntries(walked)).toEqual({ local: true, urban: true, avenue: true, boulevard: true, highway: false, ramp: false });
  });
  it('lanes sit where the lanelets put them', () => {
    const s = sectionOf(roadProfile(2));
    expect(s.lanes.map((l) => l.index)).toEqual([0, 1]);
    for (const l of s.lanes) expect(Math.abs(l.offset)).toBeLessThan(s.carriageway);
    expect(m(1)).toBeGreaterThan(0);
  });
});
