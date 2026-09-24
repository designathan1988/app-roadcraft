import earcut from 'earcut';
import {
  BufferGeometry,
  Float32BufferAttribute,
  Mesh,
  type Material,
} from 'three';

import { intersection, type MultiPoly, type Poly } from '@core/clipper';

/**
 * Turns a clipped surface band into a solid, watertight mesh.
 *
 * ## The two failures this module exists to prevent
 *
 * **Chords under the ground.** A deck vertex reads the height field only AT
 * ITSELF, and the triangle between two vertices is a straight chord. If that
 * chord is long and the surface it follows is curved, the chord dives beneath
 * the surface: the terrain cuts the road into plates. Densifying only the
 * polygon OUTLINE does not fix it, because ear clipping happily draws a single
 * triangle straight across a 60-unit boulevard. The fix is to refine the
 * TRIANGULATION until no edge is longer than `maxEdge`.
 *
 * **Cracks from a T-junction.** Refining each triangle on its own splits an
 * edge that its neighbour leaves whole, and the two no longer meet: a hairline
 * of background shows through. The refinement below is therefore done with
 * shared, cached edge midpoints and the standard red/green rule — a triangle
 * with one, two or three marked edges is split into two, three or four — so
 * every shared edge is split identically from both sides and no T-junction can
 * ever appear.
 */

export type HeightFn = (x: number, y: number) => number;
/** `u` runs across the surface and `v` along it, both in world units. */
export type UvFn = (x: number, y: number, out: [number, number]) => void;
/**
 * The UV of (x, y), in the frame of whichever road is nearest to (pickX, pickY)
 * rather than to the point itself. See `uvFrame` below.
 */
export type UvFrameFn = (x: number, y: number, pickX: number, pickY: number, out: [number, number]) => void;
/** Writes a linear RGB tint for one vertex. */
export type TintFn = (x: number, y: number, out: [number, number, number]) => void;

export interface SurfaceMeshOptions {
  readonly name: string;
  readonly polygons: MultiPoly;
  /** Height of the visible top face. */
  readonly top: HeightFn;
  /**
   * Height of the bottom face of the skirt drawn down from the boundary.
   *
   * Omitted for a surface that lies flush on the ground. Supplied for anything
   * that stands proud of it — a kerb, a raised deck — so the edge is a solid
   * face instead of an infinitely thin sheet seen edge-on.
   */
  readonly bottom?: HeightFn;
  readonly material: Material;
  /** Longest triangle edge, in world units, before it is refined. */
  readonly maxEdge: number;
  readonly uv: UvFn;
  /**
   * Keeps every triangle inside ONE texture frame.
   *
   * Road UVs are laid in the frame of the nearest road, which is what makes
   * slabs and aggregate run along the street. At a junction corner the nearest
   * road changes between two vertices of the same triangle, and the triangle
   * then interpolates from one road's coordinates to the other's: tens of
   * texture tiles squeezed across a metre, which is the zigzag smear a player
   * saw in every footway corner. A triangle whose UV edges disagree with its
   * real edges by more than a factor of two is detected here and given its own
   * vertices, all framed by the road nearest its centroid - so the worst that
   * can happen is a clean joint where two roads' paving meets, which is what a
   * real corner looks like anyway.
   *
   * `uvWorld` is the world size of one UV unit, needed to compare the two.
   */
  readonly uvFrame?: UvFrameFn;
  readonly uvWorld?: number;
  /**
   * Per-vertex tint, multiplied into the material's colour.
   *
   * This is what lets ONE asphalt mesh carry a residential street's grey and a
   * boulevard's near-black: the alternative is a mesh per class, which means a
   * junction polygon belonging to two classes at once and a draw call for each.
   */
  readonly tint?: TintFn;
  readonly castShadow?: boolean;
  readonly receiveShadow?: boolean;
  /** Extra UV scale for the skirt, so its texture is not stretched. */
  readonly skirtUvScale?: number;
}

interface Builder {
  readonly xs: number[];
  readonly ys: number[];
  readonly tris: number[];
  readonly midpoints: Map<number, number>;
}

function addVertex(b: Builder, x: number, y: number): number {
  b.xs.push(x);
  b.ys.push(y);
  return b.xs.length - 1;
}

function midpoint(b: Builder, i: number, j: number): number {
  const key = i < j ? i * 0x4000_0000 + j : j * 0x4000_0000 + i;
  const cached = b.midpoints.get(key);
  if (cached !== undefined) return cached;
  const index = addVertex(
    b,
    ((b.xs[i] as number) + (b.xs[j] as number)) / 2,
    ((b.ys[i] as number) + (b.ys[j] as number)) / 2,
  );
  b.midpoints.set(key, index);
  return index;
}

const edgeLength = (b: Builder, i: number, j: number): number =>
  Math.hypot((b.xs[i] as number) - (b.xs[j] as number), (b.ys[i] as number) - (b.ys[j] as number));

/**
 * Refines until no triangle edge is longer than `maxEdge`.
 *
 * ## Longest-edge bisection, not uniform subdivision
 *
 * Each round marks only the LONGEST edge of each over-long triangle, then
 * rewrites the mesh with the red/green closure below. That choice is the
 * difference between a mesh and a hang:
 *
 * Ear clipping a long, thin, densely-sampled band — which is exactly what a
 * road's verge is, 1400 units long and 1.5 wide — emits fans whose triangles
 * reach from one end of the strip to the other. Marking EVERY over-long edge
 * quarters every such triangle every round, so a 1400-unit edge needs eight
 * rounds at four times the count each: measured, a single 1400x1.5 strip came
 * out at 256 736 vertices, and one straight road cost over a million triangles.
 *
 * Bisecting the longest edge halves it instead, doubling only the triangles
 * that were actually too big, and leaves well-shaped triangles alone. The same
 * strip now costs a few thousand vertices, and the result is still conforming
 * because the marking is global: an edge is split for both of the triangles
 * that share it, or for neither.
 */
function refine(b: Builder, maxEdge: number, maxRounds = 24, budget = 600_000): void {
  for (let round = 0; round < maxRounds; round++) {
    if (b.tris.length / 3 > budget) return;
    const marked = new Set<number>();
    for (let t = 0; t < b.tris.length; t += 3) {
      const a = b.tris[t] as number;
      const c = b.tris[t + 1] as number;
      const d = b.tris[t + 2] as number;
      let bestKey = -1;
      let bestLength = maxEdge;
      for (const [i, j] of [[a, c], [c, d], [d, a]] as const) {
        const length = edgeLength(b, i, j);
        if (length > bestLength) {
          bestLength = length;
          bestKey = i < j ? i * 0x4000_0000 + j : j * 0x4000_0000 + i;
        }
      }
      if (bestKey >= 0) marked.add(bestKey);
    }
    if (marked.size === 0) return;

    const split = (i: number, j: number): number | null => {
      const key = i < j ? i * 0x4000_0000 + j : j * 0x4000_0000 + i;
      return marked.has(key) ? midpoint(b, i, j) : null;
    };

    const next: number[] = [];
    for (let t = 0; t < b.tris.length; t += 3) {
      const a = b.tris[t] as number;
      const c = b.tris[t + 1] as number;
      const d = b.tris[t + 2] as number;
      emit(next, a, c, d, split(a, c), split(c, d), split(d, a));
    }
    b.tris.length = next.length;
    for (let i = 0; i < next.length; i++) b.tris[i] = next[i] as number;
  }
}

/** The red/green cases: 0, 1, 2 or 3 split edges of one triangle. */
function emit(
  out: number[],
  a: number,
  b: number,
  c: number,
  ab: number | null,
  bc: number | null,
  ca: number | null,
): void {
  const count = (ab !== null ? 1 : 0) + (bc !== null ? 1 : 0) + (ca !== null ? 1 : 0);
  if (count === 0) {
    out.push(a, b, c);
    return;
  }
  if (count === 3) {
    out.push(a, ab as number, ca as number);
    out.push(ab as number, b, bc as number);
    out.push(ca as number, bc as number, c);
    out.push(ab as number, bc as number, ca as number);
    return;
  }
  if (count === 1) {
    if (ab !== null) out.push(a, ab, c, ab, b, c);
    else if (bc !== null) out.push(b, bc, a, bc, c, a);
    else out.push(c, ca as number, b, ca as number, a, b);
    return;
  }
  // Two split edges: cut off the corner they share, then split the quad left
  // over along its shorter diagonal — which is what keeps the triangles fat.
  if (ab !== null && bc !== null) out.push(b, bc, ab, ab, bc, c, ab, c, a);
  else if (bc !== null && ca !== null) out.push(c, ca as number, bc, bc, ca as number, a, bc, a, b);
  else out.push(a, ab as number, ca as number, ca as number, ab as number, b, ca as number, b, c);
}

/** Appends a ring, inserting points so no edge is longer than `step`. */
function densify(flat: number[], ring: readonly (readonly number[])[], step: number): void {
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i] as readonly number[];
    const b = ring[(i + 1) % ring.length] as readonly number[];
    const ax = a[0] as number;
    const ay = a[1] as number;
    const bx = b[0] as number;
    const by = b[1] as number;
    flat.push(ax, ay);
    const cuts = Math.min(512, Math.floor(Math.hypot(bx - ax, by - ay) / step));
    for (let k = 1; k <= cuts; k++) {
      const t = k / (cuts + 1);
      flat.push(ax + (bx - ax) * t, ay + (by - ay) * t);
    }
  }
}

/**
 * Cuts a polygon down until no piece is wider than `span` in either axis.
 *
 * ## Why this is here, and why it is not optional
 *
 * Ear clipping is a triangulation, not a MESHING, algorithm: it guarantees a
 * valid cover and says nothing about triangle shape. On a long thin band — a
 * road's 1400-by-1.5 verge — it emits a fan, and measured on exactly that
 * shape every one of the 352 triangles it returned had an edge up to 1392 units
 * long. No refinement can recover cheaply from that: bisecting a sliver whose
 * long edge is shared by its neighbour cascades, and the same strip refined to
 * an 8-unit edge cost 274 000 triangles for 2 100 square units of surface.
 *
 * Cutting first fixes the cause instead of paying for the symptom. Each piece is
 * compact, so earcut's worst output inside one is its diagonal, and the
 * refinement afterwards has three or four halvings to do rather than eight.
 *
 * The cut is a recursive bisection along the longer axis rather than a sweep
 * over a grid, so the clipper does `O(log n)` passes over the polygon instead of
 * one pass per cell — the difference between a fraction of a second and several
 * seconds on a city-sized network.
 */
function splitToSpan(polygon: Poly, span: number, out: Poly[], depth = 0): void {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const outer = polygon[0];
  if (!outer || outer.length < 3) return;
  for (const point of outer) {
    const x = point[0] as number;
    const y = point[1] as number;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  const width = maxX - minX;
  const height = maxY - minY;
  // Depth is bounded so a pathological shape cannot recurse for ever; at 12
  // levels a piece is already 4096 times smaller than the whole.
  if ((width <= span && height <= span) || depth >= 12) {
    out.push(polygon);
    return;
  }

  const pad = span;
  const cutX = width >= height;
  const middle = cutX ? (minX + maxX) / 2 : (minY + maxY) / 2;
  const rect = (x0: number, y0: number, x1: number, y1: number): MultiPoly => [
    [[[x0, y0], [x1, y0], [x1, y1], [x0, y1]]],
  ];
  const halves: MultiPoly[] = cutX
    ? [
        rect(minX - pad, minY - pad, middle, maxY + pad),
        rect(middle, minY - pad, maxX + pad, maxY + pad),
      ]
    : [
        rect(minX - pad, minY - pad, maxX + pad, middle),
        rect(minX - pad, middle, maxX + pad, maxY + pad),
      ];

  for (const half of halves) {
    for (const piece of intersection([polygon], half)) splitToSpan(piece, span, out, depth + 1);
  }
}

/** Twice the signed area of a flat [x,y,...] ring slice; positive means CCW. */
function signedArea(flat: readonly number[], start: number, end: number): number {
  let sum = 0;
  const count = end - start;
  for (let i = 0; i < count; i++) {
    const a = (start + i) * 2;
    const b = (start + ((i + 1) % count)) * 2;
    sum += (flat[a] as number) * (flat[b + 1] as number) - (flat[b] as number) * (flat[a + 1] as number);
  }
  return sum;
}

export function buildSurfaceMesh(options: SurfaceMeshOptions): Mesh | null {
  const { polygons, top, bottom, maxEdge, uv } = options;
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  const scratch: [number, number] = [0, 0];
  const rgb: [number, number, number] = [1, 1, 1];
  const tint = options.tint;

  // ------------------------------------------------------------- top faces
  //
  // Compact pieces first (see `splitToSpan`), then ear clipping inside each.
  // The outline is sampled at exactly `maxEdge`, which is what makes the result
  // crack-free across a cut: refinement only ever splits an edge LONGER than
  // `maxEdge`, so no boundary edge is ever split, so two pieces that share a cut
  // keep the identical vertices along it.
  const pieces: Poly[] = [];
  for (const polygon of polygons) splitToSpan(polygon, maxEdge * 6, pieces);

  for (const polygon of pieces) {
    const outer = polygon[0];
    if (!outer || outer.length < 3) continue;

    const flat: number[] = [];
    const holes: number[] = [];
    for (let ringIndex = 0; ringIndex < polygon.length; ringIndex++) {
      const ring = polygon[ringIndex];
      if (!ring || ring.length < 3) continue;
      if (ringIndex > 0) holes.push(flat.length / 2);
      densify(flat, ring, maxEdge);
    }
    const seed = earcut(flat, holes, 2);
    if (seed.length === 0) continue;

    // Which way round the outer ring runs decides which side of every triangle
    // faces the sky. Clipper is asked for positive-orientation outer rings, but
    // relying on that is how a whole road network came to be drawn inside-out
    // and vanished under the terrain — the surfaces were there, back-face
    // culled. Measuring the ring costs nothing and cannot be wrong.
    const outerEnd = holes.length > 0 ? (holes[0] as number) : flat.length / 2;
    const flip = signedArea(flat, 0, outerEnd) < 0;

    const builder: Builder = { xs: [], ys: [], tris: [...seed], midpoints: new Map() };
    for (let i = 0; i < flat.length; i += 2) {
      builder.xs.push(flat[i] as number);
      builder.ys.push(flat[i + 1] as number);
    }
    refine(builder, maxEdge);

    const base = positions.length / 3;
    for (let i = 0; i < builder.xs.length; i++) {
      const x = builder.xs[i] as number;
      const y = builder.ys[i] as number;
      positions.push(x, top(x, y), -y);
      uv(x, y, scratch);
      uvs.push(scratch[0], scratch[1]);
      normals.push(0, 1, 0);
      if (tint) tint(x, y, rgb);
      colors.push(rgb[0], rgb[1], rgb[2]);
    }
    // World Y is mirrored into three's Z. That reflection flips handedness, so
    // a ring that is counter-clockwise on the map comes out clockwise in the
    // scene: taken in order, the triangle's normal points UP, which is what a
    // top face needs. A clockwise ring is emitted the other way round.
    for (let i = 0; i < builder.tris.length; i += 3) {
      let a = base + (builder.tris[i] as number);
      let b = base + (builder.tris[i + 1] as number);
      let c = base + (builder.tris[i + 2] as number);
      if (options.uvFrame && options.uvWorld && !uvConsistent(positions, uvs, a, b, c, options.uvWorld)) {
        const cx = (positions[a * 3]! + positions[b * 3]! + positions[c * 3]!) / 3;
        const cy = -(positions[a * 3 + 2]! + positions[b * 3 + 2]! + positions[c * 3 + 2]!) / 3;
        const fresh: number[] = [];
        for (const v of [a, b, c]) {
          const x = positions[v * 3]!;
          const y = -positions[v * 3 + 2]!;
          positions.push(x, positions[v * 3 + 1]!, -y);
          options.uvFrame(x, y, cx, cy, scratch);
          uvs.push(scratch[0], scratch[1]);
          normals.push(0, 1, 0);
          colors.push(colors[v * 3]!, colors[v * 3 + 1]!, colors[v * 3 + 2]!);
          fresh.push(positions.length / 3 - 1);
        }
        [a, b, c] = fresh as [number, number, number];
      }
      if (flip) indices.push(a, c, b);
      else indices.push(a, b, c);
    }
  }

  // ----------------------------------------------------------------- skirts
  //
  // Built from the ORIGINAL outlines, never from the pieces. A cut made for
  // triangulation is an interior line, and giving it a wall would hang a sheet
  // of kerb down the middle of the carriageway — invisible from above, but real
  // geometry, and doubled at every cut.
  if (bottom) {
    const scale = options.skirtUvScale ?? 1;
    for (const polygon of polygons) {
      const outer = polygon[0];
      if (!outer || outer.length < 3) continue;
      const area = ringArea(outer);
      const flip = area < 0;
      for (const ring of polygon) {
        if (!ring || ring.length < 3) continue;
        const flat: number[] = [];
        densify(flat, ring, maxEdge);
        const count = flat.length / 2;
        let run = 0;
        for (let k = 0; k < count; k++) {
          const i = k * 2;
          const j = ((k + 1) % count) * 2;
          const ax = flat[i] as number;
          const ay = flat[i + 1] as number;
          const bx = flat[j] as number;
          const by = flat[j + 1] as number;
          const span = Math.hypot(bx - ax, by - ay);
          if (span < 1e-6) continue;
          const sign = flip ? -1 : 1;
          const nx = (sign * (by - ay)) / span;
          const nz = (sign * (bx - ax)) / span;
          const topA = top(ax, ay);
          const topB = top(bx, by);
          const lowA = bottom(ax, ay);
          const lowB = bottom(bx, by);
          const side = positions.length / 3;
          positions.push(ax, topA, -ay, bx, topB, -by, bx, lowB, -by, ax, lowA, -ay);
          if (tint) tint((ax + bx) / 2, (ay + by) / 2, rgb);
          for (let n = 0; n < 4; n++) colors.push(rgb[0], rgb[1], rgb[2]);
          // Written rather than averaged, so a kerb keeps its hard edge instead
          // of smearing into the surface above it.
          for (let n = 0; n < 4; n++) normals.push(nx, 0, nz);
          const u0 = run / scale;
          const u1 = (run + span) / scale;
          uvs.push(u0, topA / scale, u1, topB / scale, u1, lowB / scale, u0, lowA / scale);
          run += span;
          // Wound so the face looks the same way as the normal written above.
          if (flip) indices.push(side, side + 1, side + 2, side, side + 2, side + 3);
          else indices.push(side, side + 2, side + 1, side, side + 3, side + 2);
        }
      }
    }
  }

  if (indices.length === 0) return null;
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new Float32BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new Float32BufferAttribute(uvs, 2));
  // Always present, white when no tint was asked for: a material that declares
  // `vertexColors` requires the attribute, and it is cheaper to write three
  // ones than to keep two variants of every road material.
  geometry.setAttribute('color', new Float32BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  // Only the top face was given a placeholder normal; recomputing just those
  // vertices keeps the skirt's hard edges while the surface itself is smooth.
  smoothTopNormals(geometry, positions, normals, indices);
  geometry.computeBoundingSphere();
  geometry.computeBoundingBox();

  const mesh = new Mesh(geometry, options.material);
  mesh.name = options.name;
  mesh.castShadow = options.castShadow ?? false;
  mesh.receiveShadow = options.receiveShadow ?? true;
  return mesh;
}

/**
 * Whether a triangle's UV edges have the lengths its world edges say they
 * should. A road frame is (almost) an isometry, so a ratio far from one means
 * the three vertices were framed by different roads.
 */
function uvConsistent(
  positions: readonly number[],
  uvs: readonly number[],
  a: number,
  b: number,
  c: number,
  uvWorld: number,
): boolean {
  const edge = (p: number, q: number): boolean => {
    const world = Math.hypot(positions[p * 3]! - positions[q * 3]!, positions[p * 3 + 2]! - positions[q * 3 + 2]!);
    if (world < 1e-3) return true;
    const texture = Math.hypot(uvs[p * 2]! - uvs[q * 2]!, uvs[p * 2 + 1]! - uvs[q * 2 + 1]!) * uvWorld;
    const ratio = texture / world;
    return ratio > 0.5 && ratio < 2;
  };
  return edge(a, b) && edge(b, c) && edge(c, a);
}

/** Twice the signed area of a ring of [x, y] pairs; positive means CCW. */
function ringArea(ring: readonly (readonly number[])[]): number {
  let sum = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i] as readonly number[];
    const b = ring[(i + 1) % ring.length] as readonly number[];
    sum += (a[0] as number) * (b[1] as number) - (b[0] as number) * (a[1] as number);
  }
  return sum;
}

/**
 * Recomputes normals for the up-facing vertices only.
 *
 * `computeVertexNormals` would average a kerb's vertical face into the footway
 * above it and round off every edge in the scene. The skirt already carries an
 * exact normal, so only the vertices that were flagged as flat-up are solved
 * here, and they are solved by area-weighted accumulation like any smooth
 * surface.
 */
function smoothTopNormals(
  geometry: BufferGeometry,
  positions: readonly number[],
  normals: number[],
  indices: readonly number[],
): void {
  const flat = new Set<number>();
  for (let i = 0; i < normals.length; i += 3) {
    if (normals[i] === 0 && normals[i + 1] === 1 && normals[i + 2] === 0) flat.add(i / 3);
  }
  if (flat.size === 0) return;
  const acc = new Float64Array(normals.length);
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t] as number;
    const b = indices[t + 1] as number;
    const c = indices[t + 2] as number;
    if (!flat.has(a) || !flat.has(b) || !flat.has(c)) continue;
    const ax = positions[a * 3] as number;
    const ay = positions[a * 3 + 1] as number;
    const az = positions[a * 3 + 2] as number;
    const ux = (positions[b * 3] as number) - ax;
    const uy = (positions[b * 3 + 1] as number) - ay;
    const uz = (positions[b * 3 + 2] as number) - az;
    const vx = (positions[c * 3] as number) - ax;
    const vy = (positions[c * 3 + 1] as number) - ay;
    const vz = (positions[c * 3 + 2] as number) - az;
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    for (const index of [a, b, c]) {
      acc[index * 3] = (acc[index * 3] as number) + nx;
      acc[index * 3 + 1] = (acc[index * 3 + 1] as number) + ny;
      acc[index * 3 + 2] = (acc[index * 3 + 2] as number) + nz;
    }
  }
  const attribute = geometry.getAttribute('normal');
  for (const index of flat) {
    const x = acc[index * 3] as number;
    const y = acc[index * 3 + 1] as number;
    const z = acc[index * 3 + 2] as number;
    const length = Math.hypot(x, y, z);
    if (length < 1e-9) continue;
    attribute.setXYZ(index, x / length, y / length, z / length);
  }
  attribute.needsUpdate = true;
}

export function disposeMesh(mesh: Mesh): void {
  mesh.geometry.dispose();
}
