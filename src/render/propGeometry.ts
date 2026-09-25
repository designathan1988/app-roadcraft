import {
  BoxGeometry,
  BufferGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  Euler,
  Float32BufferAttribute,
  IcosahedronGeometry,
  Matrix4,
  PlaneGeometry,
  Quaternion,
  Vector3,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

import { Rng } from '@core/rng';
import { m } from '@world/units';
import { TREE_PIT } from '@world/streetFurniture';

/**
 * Procedural geometry for everything that stands on the ground.
 *
 * The previous props were single primitives - a cone on a cylinder for a tree,
 * a sphere for a bush, a box for a bench - and at any zoom closer than the map
 * view they read as exactly that: a diagram of a street. Each prop here is a
 * small merged model with its colours baked into the vertices, so one prop is
 * still ONE instanced draw call, however many parts it has.
 *
 * Two conventions every caller relies on:
 *
 *  - **Vegetation is authored one unit tall**, root at the origin. The
 *    instance's Y scale is then its height in world units, and the wind shader
 *    (`wind.ts`) reads local `y` as the fraction of height.
 *  - **Furniture is authored at real size**, in world units, root at the
 *    origin, facing a documented local axis.
 *
 * Vertex colours carry a baked ambient-occlusion term (darker low in a canopy
 * and deep inside it), which is most of what makes a lump of triangles read as
 * a crown of leaves under a single sun.
 */

type Rgb = readonly [number, number, number];

const rgb = (hex: number): Rgb => {
  const c = new Color(hex).convertSRGBToLinear();
  return [c.r, c.g, c.b];
};

interface Placement {
  readonly at?: readonly [number, number, number];
  readonly rotate?: readonly [number, number, number];
  readonly scale?: readonly [number, number, number];
}

/**
 * Normalises a primitive into the shared layout - non-indexed, position,
 * normal and colour only - so any two parts can be merged.
 */
function part(
  geometry: BufferGeometry,
  /** A flat colour, or one per vertex given its position, normal and face centre. */
  color: Rgb | ((p: Vector3, n: Vector3, face: Vector3) => Rgb),
  placement: Placement = {},
): BufferGeometry {
  const g = geometry.index ? geometry.toNonIndexed() : geometry;
  if (g !== geometry) geometry.dispose();
  for (const name of Object.keys(g.attributes)) {
    if (name !== 'position' && name !== 'normal') g.deleteAttribute(name);
  }
  const matrix = new Matrix4().compose(
    new Vector3(...(placement.at ?? [0, 0, 0])),
    new Quaternion().setFromEuler(new Euler(...(placement.rotate ?? [0, 0, 0]))),
    new Vector3(...(placement.scale ?? [1, 1, 1])),
  );
  g.applyMatrix4(matrix);
  const position = g.getAttribute('position');
  const normal = g.getAttribute('normal');
  const colors = new Float32Array(position.count * 3);
  const p = new Vector3();
  const n = new Vector3();
  const face = new Vector3();
  const corner = new Vector3();
  for (let i = 0; i < position.count; i++) {
    p.fromBufferAttribute(position, i);
    n.fromBufferAttribute(normal, i);
    if (i % 3 === 0) {
      face.set(0, 0, 0);
      for (let k = 0; k < 3 && i + k < position.count; k++) face.add(corner.fromBufferAttribute(position, i + k));
      face.multiplyScalar(1 / 3);
    }
    const c = typeof color === 'function' ? color(p, n, face) : color;
    colors[i * 3] = c[0];
    colors[i * 3 + 1] = c[1];
    colors[i * 3 + 2] = c[2];
  }
  g.setAttribute('color', new Float32BufferAttribute(colors, 3));
  return g;
}

function merge(parts: BufferGeometry[]): BufferGeometry {
  const merged = mergeGeometries(parts, false);
  for (const geometry of parts) geometry.dispose();
  if (!merged) throw new Error('prop parts could not be merged');
  merged.computeBoundingSphere();
  merged.computeBoundingBox();
  return merged;
}

/** A smooth, deterministic 3D wobble, for lumpy foliage. */
function wobble(x: number, y: number, z: number, seed: number): number {
  return (
    Math.sin(x * 11.3 + seed * 1.7 + Math.cos(z * 7.1 + seed)) * 0.5 +
    Math.sin(z * 13.7 - seed * 2.3 + Math.cos(y * 9.3)) * 0.35 +
    Math.sin(y * 17.9 + x * 5.1 + seed * 0.7) * 0.25
  );
}

/** Per-face hash, so a crown is speckled leaf by leaf rather than smooth. */
function faceNoise(p: Vector3, seed: number): number {
  const h = Math.sin(p.x * 91.7 + p.y * 47.3 + p.z * 63.1 + seed * 12.9) * 43758.5453;
  return h - Math.floor(h);
}

/**
 * Level of detail. 1 is the model seen close up; 0 is the same silhouette at a
 * quarter of the triangles, for the map zoom, where a whole city's trees are on
 * screen at once and each is a few pixels across. The renderer swaps between
 * them by zoom (`Scenery.setNear`).
 */
export type Detail = 0 | 1;

interface Blob {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly r: number;
}

/**
 * A crown of foliage: overlapping lumpy blobs, lit as ONE volume.
 *
 * Each blob's normals are bent towards the direction from the crown's centre,
 * so the crown shades like a single soft mass instead of a pile of balls; and
 * each face gets a small random tone, which reads as leaves.
 */
function crown(
  blobs: readonly Blob[],
  centre: Vector3,
  palette: (face: number, height: number) => Rgb,
  seed: number,
  lumpiness = 0.22,
  detail: Detail = 1,
): BufferGeometry[] {
  let minY = Infinity;
  let maxY = -Infinity;
  for (const blob of blobs) {
    minY = Math.min(minY, blob.y - blob.r);
    maxY = Math.max(maxY, blob.y + blob.r);
  }
  let spread = 0;
  for (const blob of blobs) spread = Math.max(spread, Math.hypot(blob.x - centre.x, blob.z - centre.z) + blob.r);

  return blobs.map((blob, index) => {
    // The facets were never the subdivision: they were a palette picked per
    // face (below). Smooth per-vertex colour makes 80 faces a soft mass, and
    // keeps a crown inside the thousand-tree budget (propGeometry.spec.ts).
    const g = new IcosahedronGeometry(blob.r, detail);
    // Each cluster its own shade and warmth, so a crown is many masses of
    // leaves catching the light differently, not one plastic ball.
    const clusterTone = 0.86 + faceNoise(new Vector3(blob.x, blob.y, blob.z), seed + index) * 0.26;
    const clusterWarm = (faceNoise(new Vector3(blob.z, blob.x, blob.y), seed * 3 + index) - 0.5) * 0.12;
    const position = g.getAttribute('position');
    const normal = g.getAttribute('normal');
    const p = new Vector3();
    const radial = new Vector3();
    const own = new Vector3();
    for (let i = 0; i < position.count; i++) {
      p.fromBufferAttribute(position, i);
      own.copy(p).normalize();
      const w = 1 + wobble(p.x / blob.r, p.y / blob.r, p.z / blob.r, seed + index * 3.1) * lumpiness;
      p.multiplyScalar(w).add(new Vector3(blob.x, blob.y, blob.z));
      position.setXYZ(i, p.x, p.y, p.z);
      radial.copy(p).sub(centre).normalize();
      own.lerp(radial, 0.65).normalize();
      // A crown's underside faces the ground, but it is lit by the sky
      // bounced off it; bending the lowest normals out keeps it from going
      // black under the sun.
      own.y = Math.max(own.y, -0.35);
      own.normalize();
      normal.setXYZ(i, own.x, own.y, own.z);
    }
    return part(g, (q) => {
      const height = (q.y - minY) / Math.max(1e-6, maxY - minY);
      const depth = Math.hypot(q.x - centre.x, q.z - centre.z) / Math.max(1e-6, spread);
      // Baked occlusion: dark low and deep inside the crown.
      const ao = 0.5 + 0.35 * height + 0.25 * Math.min(1, depth * 1.3);
      // Tone and palette per VERTEX, from a smooth noise, never per face.
      // Picking the palette per face made one triangle in five the deep
      // leaf colour at random: the dark triangles scattered over every crown.
      const smooth = 0.5 + 0.5 * wobble(q.x * 7, q.y * 7, q.z * 7, seed + 7);
      const tone = clusterTone * (0.96 + wobble(q.x * 13, q.y * 13, q.z * 13, seed) * 0.05);
      const base = palette(smooth, height);
      return [base[0] * ao * tone * (1 + clusterWarm), base[1] * ao * tone, base[2] * ao * tone * (1 - clusterWarm)];
    });
  });
}

function trunk(
  top: number,
  baseRadius: number,
  topRadius: number,
  bark: Rgb,
  branches: number,
  rng: Rng,
): BufferGeometry[] {
  const parts = [
    part(new CylinderGeometry(topRadius * 0.8, baseRadius * 1.12, top, 10, 3, true), (p) => {
      const t = p.y / top;
      const s = 0.62 + t * 0.38;
      return [bark[0] * s, bark[1] * s, bark[2] * s];
    }, { at: [0, top / 2, 0] }),
    // Root flare: a short cone that splays the trunk into the ground.
    part(new ConeGeometry(baseRadius * 1.9, top * 0.14, 7, 1, true), [bark[0] * 0.55, bark[1] * 0.55, bark[2] * 0.55], {
      at: [0, top * 0.07, 0],
    }),
  ];
  for (let i = 0; i < branches; i++) {
    const yaw = (i / branches) * Math.PI * 2 + rng.float() * 0.8;
    const length = top * (0.38 + rng.float() * 0.2);
    const tilt = 0.6 + rng.float() * 0.35;
    const from = top * (0.72 + rng.float() * 0.2);
    const dx = Math.sin(tilt) * Math.cos(yaw) * (length / 2);
    const dz = Math.sin(tilt) * Math.sin(yaw) * (length / 2);
    const dy = Math.cos(tilt) * (length / 2);
    const q = new Quaternion().setFromUnitVectors(
      new Vector3(0, 1, 0),
      new Vector3(dx, dy, dz).normalize(),
    );
    const e = new Euler().setFromQuaternion(q);
    parts.push(
      part(new CylinderGeometry(topRadius * 0.32, topRadius * 0.75, length, 6, 1, true), bark, {
        at: [dx, from + dy, dz],
        rotate: [e.x, e.y, e.z],
      }),
    );
  }
  return parts;
}

// ------------------------------------------------------------------ species

export type TreeSpecies = 'broadleaf' | 'broadleafTall' | 'conifer' | 'ipeYellow' | 'ipePink';
export const TREE_SPECIES: readonly TreeSpecies[] = ['broadleaf', 'broadleafTall', 'conifer', 'ipeYellow', 'ipePink'];

const BARK = rgb(0x5b4633);
const BARK_PALE = rgb(0x7a6a58);
const LEAF = rgb(0x5c8c33);
const LEAF_DEEP = rgb(0x416c29);
const LEAF_YOUNG = rgb(0x93b545);
const NEEDLE = rgb(0x335a33);

function scatterBlobs(rng: Rng, count: number, cx: number, cy: number, spreadX: number, spreadY: number, r0: number, r1: number): Blob[] {
  const blobs: Blob[] = [{ x: cx, y: cy, z: 0, r: r1 }];
  for (let i = 1; i < count; i++) {
    const a = (i / (count - 1)) * Math.PI * 2 + rng.float() * 0.9;
    const d = 0.55 + rng.float() * 0.45;
    blobs.push({
      x: cx + Math.cos(a) * spreadX * d,
      y: cy + (rng.float() - 0.4) * spreadY,
      z: Math.sin(a) * spreadX * d,
      r: r0 + rng.float() * (r1 - r0),
    });
  }
  return blobs;
}

/** One unit tall, root at the origin. */
export function treeGeometry(species: TreeSpecies, detail: Detail = 1): BufferGeometry {
  const rng = new Rng(0x7ee + species.length * 131 + species.charCodeAt(3));
  /** Branches are hidden inside the crown from far away. */
  const limbs = (count: number): number => (detail === 1 ? count : 0);
  switch (species) {
    case 'broadleaf': {
      // Many smaller clusters over a wider spread: a ragged, broken outline
      // instead of two balls, gaps where the limbs show.
      const blobs = scatterBlobs(rng, 8, 0, 0.68, 0.21, 0.23, 0.1, 0.17);
      blobs.push({ x: 0.02, y: 0.87, z: -0.03, r: 0.13 });
      const green = (f: number, h: number): Rgb => (f < 0.18 ? LEAF_DEEP : h > 0.75 && f > 0.7 ? LEAF_YOUNG : LEAF);
      return merge([...trunk(0.58, 0.032, 0.016, BARK, limbs(6), rng), ...crown(blobs, new Vector3(0, 0.68, 0), green, 1.3, 0.26, detail)]);
    }
    case 'broadleafTall': {
      // A narrower, taller crown on a longer clear stem: a street plane tree.
      const blobs: Blob[] = [];
      for (let i = 0; i < 9; i++) {
        const a = rng.float() * Math.PI * 2;
        const out = 0.06 + rng.float() * 0.07;
        blobs.push({
          x: Math.cos(a) * out,
          y: 0.5 + i * 0.05 + rng.float() * 0.03,
          z: Math.sin(a) * out,
          r: 0.095 + rng.float() * 0.045 - i * 0.004,
        });
      }
      const green = (f: number, h: number): Rgb => (f < 0.22 ? LEAF_DEEP : h > 0.7 && f > 0.75 ? LEAF_YOUNG : LEAF);
      return merge([...trunk(0.62, 0.026, 0.012, BARK_PALE, limbs(5), rng), ...crown(blobs, new Vector3(0, 0.72, 0), green, 4.2, 0.26, detail)]);
    }
    case 'conifer': {
      const parts = trunk(0.28, 0.022, 0.012, BARK, 0, rng);
      for (let i = 0; i < 5; i++) {
        const y0 = 0.16 + i * 0.16;
        const height = 0.3 - i * 0.02;
        const radius = 0.21 * (1 - i * 0.17);
        const cone = new ConeGeometry(radius, height, detail === 1 ? 16 : 9, detail === 1 ? 3 : 1, true);
        const position = cone.getAttribute('position');
        for (let v = 0; v < position.count; v++) {
          const x = position.getX(v);
          const z = position.getZ(v);
          const k = 1 + wobble(x * 6, i, z * 6, 5.5) * 0.18;
          position.setX(v, x * k);
          position.setZ(v, z * k);
        }
        cone.computeVertexNormals();
        parts.push(
          part(cone, (q, n) => {
            const t = (q.y - y0) / height + 0.5;
            const ao = 0.55 + 0.45 * Math.max(0, Math.min(1, t)) * (0.7 + 0.3 * n.y);
            // Per vertex and smooth: a per-face tone speckled the tiers dark.
            const tone = 0.88 + (0.5 + 0.5 * wobble(q.x * 11, q.y * 11, q.z * 11, i)) * 0.22;
            return [NEEDLE[0] * ao * tone, NEEDLE[1] * ao * tone, NEEDLE[2] * ao * tone];
          }, { at: [0, y0 + height / 2, 0] }),
        );
      }
      return merge(parts);
    }
    case 'ipeYellow':
    case 'ipePink': {
      // Brazil's flowering ipê: a wide, open, flat-topped crown that in the
      // dry season is all flower and hardly any leaf.
      const bloom = species === 'ipeYellow' ? rgb(0xf0c52c) : rgb(0xde6fa8);
      const bloomDeep = species === 'ipeYellow' ? rgb(0xc99a1a) : rgb(0xb24c86);
      const blobs = scatterBlobs(rng, 9, 0, 0.74, 0.27, 0.12, 0.085, 0.15);
      const palette = (f: number, h: number): Rgb => (f < 0.14 ? LEAF_DEEP : h < 0.35 && f < 0.4 ? bloomDeep : bloom);
      return merge([...trunk(0.64, 0.028, 0.014, BARK, limbs(6), rng), ...crown(blobs, new Vector3(0, 0.74, 0), palette, 8.1, 0.3, detail)]);
    }
  }
}

export type BushKind = 'bush' | 'bushFlowering' | 'hedge';
export const BUSH_KINDS: readonly BushKind[] = ['bush', 'bushFlowering', 'hedge'];

/** One unit tall, root at the origin; about 1.5 units across. */
export function bushGeometry(kind: BushKind, detail: Detail = 1): BufferGeometry {
  const rng = new Rng(0xb05 + kind.length * 17);
  if (kind === 'hedge') {
    // A clipped shrub for a median: squarer, denser, darker.
    const blobs: Blob[] = [];
    for (let i = 0; i < 5; i++) {
      blobs.push({ x: (i - 2) * 0.28, y: 0.5 + rng.float() * 0.06, z: (rng.float() - 0.5) * 0.15, r: 0.36 + rng.float() * 0.08 });
    }
    const palette = (f: number): Rgb => (f < 0.3 ? LEAF_DEEP : LEAF);
    return merge(crown(blobs, new Vector3(0, 0.45, 0), palette, 2.2, 0.12, detail));
  }
  const blobs = scatterBlobs(rng, 5, 0, 0.5, 0.36, 0.16, 0.3, 0.46);
  const flowers = [rgb(0xf4f1ea), rgb(0xe56b9a), rgb(0xd83b3b)];
  const palette = (f: number, h: number): Rgb => {
    if (kind === 'bushFlowering' && h > 0.35 && f > 0.72) return flowers[Math.floor((f - 0.72) * 10.7) % 3] as Rgb;
    return f < 0.25 ? LEAF_DEEP : LEAF;
  };
  return merge(crown(blobs, new Vector3(0, 0.42, 0), palette, kind === 'bush' ? 3.3 : 6.6, 0.26, detail));
}

/**
 * A tuft of grass: seven tapered blades leaning out from one root, dark at the
 * base and pale at the tip. One unit tall; about half a unit across.
 */
export function grassTuftGeometry(): BufferGeometry {
  const rng = new Rng(0x6a55);
  const positions: number[] = [];
  const colors: number[] = [];
  const root = rgb(0x39591f);
  const tip = rgb(0xa9c25e);
  const blades = 7;
  for (let b = 0; b < blades; b++) {
    const yaw = (b / blades) * Math.PI * 2 + rng.float() * 0.7;
    const lean = 0.12 + rng.float() * 0.34;
    const height = 0.6 + rng.float() * 0.4;
    // Far wider than a real blade (a centimetre or less): at the zoom grass is
    // drawn at, a true-width blade is a hairline and the tuft disappears.
    const width = 0.07 + rng.float() * 0.035;
    const ox = (rng.float() - 0.5) * 0.14;
    const oz = (rng.float() - 0.5) * 0.14;
    const dx = Math.cos(yaw);
    const dz = Math.sin(yaw);
    // Across the blade, perpendicular to its lean.
    const sx = -dz;
    const sz = dx;
    const point = (t: number, side: number): [number, number, number] => {
      const out = lean * t * t;
      const w = width * (1 - t) * side;
      return [ox + dx * out + sx * w, height * t * (1 - lean * 0.25 * t), oz + dz * out + sz * w];
    };
    const tint = (t: number): Rgb => [
      root[0] + (tip[0] - root[0]) * t,
      root[1] + (tip[1] - root[1]) * t,
      root[2] + (tip[2] - root[2]) * t,
    ];
    const quad = (t0: number, t1: number): void => {
      const a = point(t0, -1);
      const b = point(t0, 1);
      const c = point(t1, 1);
      const d = point(t1, -1);
      positions.push(...a, ...b, ...c, ...a, ...c, ...d);
      for (const t of [t0, t0, t1, t0, t1, t1]) colors.push(...tint(t));
    };
    quad(0, 0.45);
    quad(0.45, 0.8);
    const a = point(0.8, -1);
    const c = point(0.8, 1);
    const e = point(1, 0);
    positions.push(...a, ...c, ...e);
    for (const t of [0.8, 0.8, 1]) colors.push(...tint(t));
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(positions, 3));
  // Blades are lit as the sward they belong to: facing the sky. Lit by their
  // own facing, a tuft flickers light and dark as the camera's angle to each
  // blade changes, and at this size that reads as noise, not as grass.
  const normals = new Float32Array(positions.length);
  for (let i = 1; i < normals.length; i += 3) normals[i] = 1;
  g.setAttribute('normal', new Float32BufferAttribute(normals, 3));
  g.setAttribute('color', new Float32BufferAttribute(colors, 3));
  g.computeBoundingSphere();
  return g;
}

/** A wildflower: a stalk and a head, one unit tall. The instance colour tints it. */
export function wildflowerGeometry(): BufferGeometry {
  const stalk = rgb(0x4e7a2a);
  return merge([
    part(new CylinderGeometry(0.012, 0.016, 0.9, 4, 1, true), stalk, { at: [0, 0.45, 0] }),
    part(new BoxGeometry(0.16, 0.012, 0.05), stalk, { at: [0.06, 0.35, 0], rotate: [0, 0.4, 0.5] }),
    part(new IcosahedronGeometry(0.085, 0), [1, 1, 1], { at: [0, 0.93, 0], scale: [1, 0.55, 1] }),
  ]);
}

// ---------------------------------------------------------------- furniture

/** A residential lighting column is 8 to 10 m with a 1.5 to 2.5 m outreach. */
export const LAMP_HEIGHT = m(9);
export const LAMP_OUTREACH = m(2.1);
/**
 * Galvanised grey, not near-black. Seen from above a column is a thin line,
 * and a dark one on dark asphalt was invisible: all a player saw of a street
 * light was its shadow.
 */
const LAMP_METAL = rgb(0x8a918e);
const LAMP_PLINTH = rgb(0x5d6461);

/**
 * A lighting column, root at the origin, arm reaching along local +X.
 */
export function lampGeometry(): BufferGeometry {
  const plinth = m(0.7);
  const armY = LAMP_HEIGHT - m(0.12);
  const rise = 0.1;
  return merge([
    part(new CylinderGeometry(m(0.15), m(0.19), plinth, 10), LAMP_PLINTH, { at: [0, plinth / 2, 0] }),
    part(new CylinderGeometry(m(0.2), m(0.2), m(0.05), 10), LAMP_PLINTH, { at: [0, plinth, 0] }),
    part(new CylinderGeometry(m(0.07), m(0.12), LAMP_HEIGHT - plinth, 10, 1, true), LAMP_METAL, {
      at: [0, plinth + (LAMP_HEIGHT - plinth) / 2, 0],
    }),
    part(new CylinderGeometry(m(0.09), m(0.09), m(0.2), 8), LAMP_PLINTH, { at: [0, LAMP_HEIGHT - m(0.1), 0] }),
    part(new BoxGeometry(LAMP_OUTREACH, m(0.08), m(0.08)), LAMP_METAL, {
      at: [LAMP_OUTREACH / 2, armY + Math.sin(rise) * (LAMP_OUTREACH / 2), 0],
      rotate: [0, 0, rise],
    }),
    // The luminaire housing: a flat, slightly tapered shell, pale enough to
    // read from above, where it is the whole of the lamp the player sees.
    part(new BoxGeometry(m(0.78), m(0.14), m(0.38)), rgb(0xa9b0ad), {
      at: [LAMP_OUTREACH, armY + Math.sin(rise) * LAMP_OUTREACH - m(0.02), 0],
      rotate: [0, 0, rise * 0.4],
    }),
  ]);
}

/**
 * The lamp's lens, in the lamp's own frame, for the unlit glow material.
 *
 * ONE downward-facing face, under the housing. It was a box: its sides and
 * the glow round it showed from above as bright white discs over the
 * carriageway - on the yellow centre line, where the arms reach - and read as
 * an editor marker left on screen. A lens only shines down.
 */
export function lampLensGeometry(): BufferGeometry {
  const armY = LAMP_HEIGHT - m(0.12);
  const rise = 0.1;
  return merge([
    part(new PlaneGeometry(m(0.56), m(0.28)), [1, 1, 1], {
      at: [LAMP_OUTREACH, armY + Math.sin(rise) * LAMP_OUTREACH - m(0.092), 0],
      // Face down (-Y), with the housing's slight tilt.
      rotate: [Math.PI / 2, 0, rise * 0.4],
    }),
  ]);
}

const WOOD = rgb(0x8d6540);
const IRON = rgb(0x262b2a);

/**
 * A park bench, 1.8 m long, root at the origin. The seat runs along local +X
 * and the back stands on the local -Z side, so a bench faces +Z.
 */
export function benchGeometry(): BufferGeometry {
  const L = m(1.8);
  const seat = m(0.45);
  const parts: BufferGeometry[] = [];
  const slat = (hex: Rgb, i: number): Rgb => {
    const s = 0.9 + ((i * 37) % 7) * 0.03;
    return [hex[0] * s, hex[1] * s, hex[2] * s];
  };
  [m(0.17), m(0.03), m(-0.11)].forEach((z, i) =>
    parts.push(part(new BoxGeometry(L, m(0.035), m(0.12)), slat(WOOD, i), { at: [0, seat, z] })),
  );
  [m(0.6), m(0.76)].forEach((y, i) =>
    parts.push(part(new BoxGeometry(L, m(0.1), m(0.03)), slat(WOOD, i + 3), { at: [0, y, m(-0.25) - (y - seat) * 0.12], rotate: [-0.12, 0, 0] })),
  );
  for (const end of [-1, 1]) {
    const x = end * (L / 2 - m(0.14));
    parts.push(
      part(new BoxGeometry(m(0.05), seat, m(0.05)), IRON, { at: [x, seat / 2, m(0.19)] }),
      part(new BoxGeometry(m(0.05), m(0.86), m(0.05)), IRON, { at: [x, m(0.43), m(-0.22)], rotate: [-0.1, 0, 0] }),
      part(new BoxGeometry(m(0.05), m(0.04), m(0.46)), IRON, { at: [x, seat - m(0.03), m(-0.01)] }),
      part(new BoxGeometry(m(0.06), m(0.035), m(0.42)), IRON, { at: [x, m(0.66), m(0.0)] }),
      part(new BoxGeometry(m(0.04), m(0.2), m(0.04)), IRON, { at: [x, m(0.56), m(0.18)] }),
    );
  }
  return merge(parts);
}

/** A litter bin: a 1 m drum with a steel rim and a domed lid. */
export function binGeometry(): BufferGeometry {
  const body = rgb(0x2f4a3a);
  const steel = rgb(0x8b9496);
  return merge([
    part(new CylinderGeometry(m(0.2), m(0.22), m(0.06), 14), rgb(0x232826), { at: [0, m(0.03), 0] }),
    part(new CylinderGeometry(m(0.23), m(0.2), m(0.8), 14, 1, true), (p) => {
      // Vertical ribs, as pressed steel panels have.
      const a = Math.atan2(p.z, p.x);
      const s = 0.9 + 0.1 * Math.cos(a * 14);
      return [body[0] * s, body[1] * s, body[2] * s];
    }, { at: [0, m(0.46), 0] }),
    part(new CylinderGeometry(m(0.245), m(0.245), m(0.05), 14), steel, { at: [0, m(0.88), 0] }),
    part(new CylinderGeometry(m(0.236), m(0.236), m(0.04), 14), rgb(0x0e100f), { at: [0, m(0.84), 0] }),
    part(new CylinderGeometry(m(0.1), m(0.245), m(0.13), 14), body, { at: [0, m(0.97), 0] }),
  ]);
}

/** A pillar fire hydrant, 0.75 m. */
export function hydrantGeometry(): BufferGeometry {
  const red = rgb(0xbd3328);
  const dark = rgb(0x8f2820);
  return merge([
    part(new CylinderGeometry(m(0.16), m(0.18), m(0.07), 10), dark, { at: [0, m(0.035), 0] }),
    part(new CylinderGeometry(m(0.12), m(0.13), m(0.52), 10), red, { at: [0, m(0.33), 0] }),
    part(new CylinderGeometry(m(0.08), m(0.14), m(0.12), 10), red, { at: [0, m(0.65), 0] }),
    part(new CylinderGeometry(m(0.035), m(0.04), m(0.07), 6), dark, { at: [0, m(0.74), 0] }),
    part(new CylinderGeometry(m(0.045), m(0.05), m(0.36), 8), dark, { at: [0, m(0.46), 0], rotate: [0, 0, Math.PI / 2] }),
    part(new CylinderGeometry(m(0.06), m(0.065), m(0.12), 8), dark, { at: [0, m(0.44), m(0.13)], rotate: [Math.PI / 2, 0, 0] }),
  ]);
}

/** A pillar post box: a body on a short plinth with a rounded top. Faces +Z. */
export function postboxGeometry(): BufferGeometry {
  const blue = rgb(0x1f4f8a);
  const dark = rgb(0x12304f);
  return merge([
    part(new BoxGeometry(m(0.3), m(0.25), m(0.24)), dark, { at: [0, m(0.125), 0] }),
    part(new BoxGeometry(m(0.44), m(0.72), m(0.34)), blue, { at: [0, m(0.61), 0] }),
    // A half cylinder, axis across the box, dome up.
    part(new CylinderGeometry(m(0.17), m(0.17), m(0.44), 12, 1, false, 0, Math.PI), blue, {
      at: [0, m(0.97), 0],
      rotate: [0, 0, Math.PI / 2],
    }),
    part(new BoxGeometry(m(0.22), m(0.035), m(0.02)), rgb(0x0a0c0e), { at: [0, m(0.84), m(0.175)] }),
    part(new BoxGeometry(m(0.26), m(0.12), m(0.01)), rgb(0xe8e4d8), { at: [0, m(0.62), m(0.175)] }),
  ]);
}

/**
 * A tree pit in the footway: a square of dark soil behind a steel grate,
 * root at the footway surface.
 */
export function treePitGeometry(): BufferGeometry {
  const soil = rgb(0x3a2c1f);
  const steel = rgb(0x3d4341);
  const half = TREE_PIT / 2;
  const parts = [part(new BoxGeometry(TREE_PIT, m(0.04), TREE_PIT), (_p, _n, face) => {
    const s = 0.85 + faceNoise(face, 2) * 0.3;
    return [soil[0] * s, soil[1] * s, soil[2] * s];
  }, { at: [0, m(0.02), 0] })];
  for (const side of [-1, 1]) {
    parts.push(
      part(new BoxGeometry(TREE_PIT, m(0.05), m(0.05)), steel, { at: [0, m(0.03), side * (half - m(0.025))] }),
      part(new BoxGeometry(m(0.05), m(0.05), TREE_PIT), steel, { at: [side * (half - m(0.025)), m(0.03), 0] }),
    );
  }
  // Grate bars, leaving the root collar open in the middle.
  for (let i = -3; i <= 3; i++) {
    if (Math.abs(i) <= 1) continue;
    parts.push(part(new BoxGeometry(m(0.025), m(0.03), TREE_PIT - m(0.1)), steel, { at: [i * (TREE_PIT / 8), m(0.035), 0] }));
  }
  return merge(parts);
}

/** Triangle count of a non-indexed prop geometry. */
export const trianglesOf = (geometry: BufferGeometry): number =>
  (geometry.index?.count ?? geometry.getAttribute('position').count) / 3;
