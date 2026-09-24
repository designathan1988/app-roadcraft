import { Color, MeshStandardMaterial, type Material } from 'three';

import type { Vec2 } from '@core/vec2';
import { GEO_EPS } from '@core/scalar';
import { Level } from '@world/roadTypes';
import type { Network } from '@world/network';
import type { SegmentId } from '@world/ids';
import {
  type Bar,
  type StrokeSpec,
  junctionDetail,
  segmentMarkings,
  transitionMarkings,
} from '@world/markings';

/**
 * Painted road markings, as real geometry lifted just off the carriageway.
 *
 * Two things matter here and both were wrong before.
 *
 * **The paint is lit.** Markings used to be `MeshBasicMaterial` with
 * `toneMapped: false`, which makes them the same flat white in sunlight and in
 * shadow — a dead giveaway that the scene is a diagram. Thermoplastic road paint
 * is a rough, slightly raised surface; drawing it with a lit material and a high
 * roughness puts it under the same sun as the asphalt around it, and it darkens
 * with the road when a viaduct passes overhead.
 *
 * **One mesh per colour, not per stroke.** All the white paint in the network is
 * one draw call, all the yellow another.
 *
 * The central reservation is NOT here. It used to be two overlapping strokes at
 * the same height, which is two coplanar surfaces in the depth buffer and the
 * torn green scribble that ran down the middle of every boulevard. It is built
 * as a kerbed island in `roadSurfaces.ts` instead.
 */

/** How far paint stands above the asphalt. Enough to win the depth test. */
export const PAINT_RISE = 0.02;

interface Batch {
  rings: number[][][];
}

function quad(batch: Batch, a: Vec2, b: Vec2, half: number): void {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = Math.hypot(dx, dy);
  if (length < GEO_EPS) return;
  const nx = (-dy / length) * half;
  const ny = (dx / length) * half;
  batch.rings.push([
    [a.x - nx, a.y - ny],
    [a.x + nx, a.y + ny],
    [b.x + nx, b.y + ny],
    [b.x - nx, b.y - ny],
  ]);
}

function stroke(batch: Batch, spec: StrokeSpec): void {
  const pattern = spec.dash;
  if (!pattern?.length) {
    for (let i = 1; i < spec.points.length; i++) {
      quad(batch, spec.points[i - 1] as Vec2, spec.points[i] as Vec2, spec.width / 2);
    }
    return;
  }

  const period = pattern.reduce((sum, value) => sum + value, 0);
  let phase = ((spec.dashOffset % period) + period) % period;
  let patternIndex = 0;
  while (phase >= (pattern[patternIndex] as number)) {
    phase -= pattern[patternIndex] as number;
    patternIndex = (patternIndex + 1) % pattern.length;
  }
  let remaining = (pattern[patternIndex] as number) - phase;
  let ink = patternIndex % 2 === 0;

  for (let i = 1; i < spec.points.length; i++) {
    const a = spec.points[i - 1] as Vec2;
    const b = spec.points[i] as Vec2;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const length = Math.hypot(dx, dy);
    if (length < GEO_EPS) continue;
    let travelled = 0;
    while (travelled < length) {
      const amount = Math.min(remaining, length - travelled);
      if (ink) {
        const t0 = travelled / length;
        const t1 = (travelled + amount) / length;
        quad(
          batch,
          { x: a.x + dx * t0, y: a.y + dy * t0 },
          { x: a.x + dx * t1, y: a.y + dy * t1 },
          spec.width / 2,
        );
      }
      travelled += amount;
      remaining -= amount;
      if (remaining <= GEO_EPS) {
        patternIndex = (patternIndex + 1) % pattern.length;
        remaining = pattern[patternIndex] as number;
        ink = !ink;
      }
    }
  }
}

function addBar(batch: Batch, value: Bar): void {
  quad(batch, value.a, value.b, value.width / 2);
}

/** Paint of one colour: lit like the asphalt under it, drawn over it. */
export function paintMaterial(color: string): Material {
  return new MeshStandardMaterial({
    color: new Color(color),
    roughness: 0.72,
    metalness: 0,
    // Paint is applied over the asphalt, so it takes the same light but never
    // reflects the sky the way wet tarmac does.
    envMapIntensity: 0.25,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
}


/**
 * The painted strokes of the network, one list of quads per colour, before
 * they are merged and clipped: `roadSurfaces.ts` does that a tile at a time,
 * against the carriageway of the ribbons alone, so paint belongs to the road
 * legs and a crossing never becomes a white lattice at close zoom.
 */
export function markingQuads(
  net: Network,
  include: (segment: SegmentId) => boolean,
  includeJunctionDetails: boolean,
): Map<string, number[][][]> {
  const batches = new Map<string, Batch>();
  const at = (color: string): Batch => {
    let batch = batches.get(color);
    if (!batch) {
      batch = { rings: [] };
      batches.set(color, batch);
    }
    return batch;
  };

  for (const ribbon of net.ribbons.values()) {
    if (!include(ribbon.id)) continue;
    const start = net.trims.get(ribbon.id)?.a[Level.Asphalt] ?? 0;
    for (const spec of segmentMarkings(ribbon, start)) stroke(at(spec.color), spec);
  }
  for (const node of net.transitions) {
    const leg = net.junctions.get(node)?.get(Level.Asphalt)?.legs[0];
    if (!leg || !include(leg.seg)) continue;
    for (const spec of transitionMarkings(net, node)) stroke(at(spec.color), spec);
  }
  if (includeJunctionDetails) {
    const detail = junctionDetail(net);
    for (const value of detail.stops) addBar(at('#ece9d9'), value);
    for (const value of detail.zebras) addBar(at('#f4f1e3'), value);
  }
  const out = new Map<string, number[][][]>();
  for (const [color, batch] of batches) if (batch.rings.length > 0) out.set(color, batch.rings);
  return out;
}
