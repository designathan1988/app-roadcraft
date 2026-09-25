import earcut from 'earcut';
import {
  BufferAttribute,
  BufferGeometry,
  Float32BufferAttribute,
  Mesh,
  type Material,
} from 'three';

import { cutAtAxis } from '@core/axisCut';
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
/** Four numbers per vertex for a material's own use (see `SurfaceMeshOptions.extra`). */
export type ExtraFn = (x: number, y: number, out: [number, number, number, number]) => void;

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
  /**
   * Four numbers per top-face vertex, written as the attribute `extra.name`
   * (skirt vertices get zeros). The carriageway uses it for the road-space
   * detail its shader draws - gutter, wheel tracks - which needs the road's
   * own widths at each vertex (`roadSurfaces.ts`).
   */
  readonly extra?: { readonly name: string; readonly fn: ExtraFn };
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
      // The three edges in the order a-c, c-d, d-a; the first of equal longest wins.
      const ac = edgeLength(b, a, c);
      const cd = edgeLength(b, c, d);
      const da = edgeLength(b, d, a);
      let bestLength = maxEdge;
      let i = -1;
      let j = -1;
      if (ac > bestLength) { bestLength = ac; i = a; j = c; }
      if (cd > bestLength) { bestLength = cd; i = c; j = d; }
      if (da > bestLength) { i = d; j = a; }
      if (i >= 0) marked.add(i < j ? i * 0x4000_0000 + j : j * 0x4000_0000 + i);
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

  const cutX = width >= height;
  const middle = cutX ? (minX + maxX) / 2 : (minY + maxY) / 2;
  // A straight cut, done as one (see `cutAtAxis`); the general clipper only
  // for a polygon the fast path declines.
  const halves = cutAtAxis(polygon, cutX ? 0 : 1, middle) ?? clipHalves(polygon, span, cutX, middle, minX, minY, maxX, maxY);
  for (const half of halves) {
    for (const piece of half) splitToSpan(piece, span, out, depth + 1);
  }
}

/** The two sides of a cut, by intersection with a rectangle either side of it. */
function clipHalves(
  polygon: Poly,
  pad: number,
  cutX: boolean,
  middle: number,
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
): MultiPoly[] {
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
  return halves.map((half) => intersection([polygon], half));
}

/** Twice the summed signed area of triangles over a flat [x,y,...] list; positive means CCW. */
function trianglesArea(flat: readonly number[], tris: readonly number[]): number {
  let sum = 0;
  for (let i = 0; i + 2 < tris.length; i += 3) {
    const a = (tris[i] as number) * 2;
    const b = (tris[i + 1] as number) * 2;
    const c = (tris[i + 2] as number) * 2;
    const ax = flat[a] as number;
    const ay = flat[a + 1] as number;
    sum += ((flat[b] as number) - ax) * ((flat[c + 1] as number) - ay)
      - ((flat[b + 1] as number) - ay) * ((flat[c] as number) - ax);
  }
  return sum;
}

/** Vertex and index streams of a mesh under construction. */
interface Streams {
  readonly positions: number[];
  readonly normals: number[];
  readonly uvs: number[];
  readonly colors: number[];
  readonly extras: number[];
  readonly indices: number[];
}

const streams = (): Streams => ({ positions: [], normals: [], uvs: [], colors: [], extras: [], indices: [] });

/** One build's options and the scratch its callbacks write into. */
interface Context {
  readonly options: SurfaceMeshOptions;
  readonly uv: [number, number];
  /** White until a tint writes it, so an untinted surface is written white. */
  readonly rgb: [number, number, number];
  readonly four: [number, number, number, number];
}

export function buildSurfaceMesh(options: SurfaceMeshOptions): Mesh | null {
  const context: Context = { options, uv: [0, 0], rgb: [1, 1, 1], four: [0, 0, 0, 0] };

  // Compact pieces first (see `splitToSpan`), then ear clipping inside each.
  const out = streams();
  const pieces: Poly[] = [];
  for (const polygon of options.polygons) splitToSpan(polygon, options.maxEdge * 6, pieces);
  for (const piece of pieces) meshPiece(piece, context, out);
  if (options.bottom) meshSkirts(context, out);

  const { positions, normals, uvs, colors, extras, indices } = out;
  if (indices.length === 0) return null;
  // Only the top face was given a placeholder normal; recomputing just those
  // vertices keeps the skirt's hard edges while the surface itself is smooth.
  smoothTopNormals(positions, normals, indices);
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new Float32BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new Float32BufferAttribute(uvs, 2));
  // Always present, white when no tint was asked for: a material that declares
  // `vertexColors` requires the attribute, and it is cheaper to write three
  // ones than to keep two variants of every road material.
  geometry.setAttribute('color', new Float32BufferAttribute(colors, 3));
  if (options.extra) geometry.setAttribute(options.extra.name, new Float32BufferAttribute(extras, 4));
  geometry.setIndex(indices);
  return finish(geometry, options);
}

function finish(geometry: BufferGeometry,
  options: Pick<SurfaceMeshOptions, 'name' | 'material' | 'castShadow' | 'receiveShadow'>): Mesh {
  geometry.computeBoundingSphere();
  geometry.computeBoundingBox();
  const mesh = new Mesh(geometry, options.material);
  mesh.name = options.name;
  mesh.castShadow = options.castShadow ?? false;
  mesh.receiveShadow = options.receiveShadow ?? true;
  return mesh;
}

/**
 * The top face of one compact piece: ear clipping, refinement, and one read
 * of the height, texture frame and tint per vertex.
 *
 * The outline is sampled at exactly `maxEdge`, which is what makes the result
 * crack-free across a cut: refinement only ever splits an edge LONGER than
 * `maxEdge`, so no boundary edge is ever split, so two pieces that share a cut
 * keep the identical vertices along it.
 */
function meshPiece(polygon: Poly, context: Context, out: Streams): void {
  const { options, uv: scratch, rgb, four } = context;
  const { top, maxEdge, uv, tint, extra } = options;
  const { positions, normals, uvs, colors, extras, indices } = out;
  const outer = polygon[0];
  if (!outer || outer.length < 3) return;

  const flat: number[] = [];
  const holes: number[] = [];
  for (let ringIndex = 0; ringIndex < polygon.length; ringIndex++) {
    const ring = polygon[ringIndex];
    if (!ring || ring.length < 3) continue;
    if (ringIndex > 0) holes.push(flat.length / 2);
    densify(flat, ring, maxEdge);
  }
  const seed = earcut(flat, holes, 2);
  if (seed.length === 0) return;

  // Which way round the TRIANGLES run decides which side faces the sky, so
  // that is what is measured. Relying on the clipper's ring orientation is
  // how a whole road network came to be drawn inside-out and vanished under
  // the terrain. Measuring the RING instead was wrong the other way: earcut
  // hands back anticlockwise triangles whatever the ring's winding, so a
  // clockwise piece was flipped face down — every piece of a horizontal cut,
  // the day `cutAtAxis` began returning them clockwise. The triangles are
  // what is drawn; ask them.
  const flip = trianglesArea(flat, seed) < 0;

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
    if (extra) {
      extra.fn(x, y, four);
      extras.push(four[0], four[1], four[2], four[3]);
    }
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
        if (extra) extras.push(extras[v * 4]!, extras[v * 4 + 1]!, extras[v * 4 + 2]!, extras[v * 4 + 3]!);
        fresh.push(positions.length / 3 - 1);
      }
      [a, b, c] = fresh as [number, number, number];
    }
    if (flip) indices.push(a, c, b);
    else indices.push(a, b, c);
  }
}

/**
 * The walls hung from a surface's outline down to `bottom`.
 *
 * Built from the ORIGINAL outlines, never from the pieces. A cut made for
 * triangulation is an interior line, and giving it a wall would hang a sheet
 * of kerb down the middle of the carriageway — invisible from above, but real
 * geometry, and doubled at every cut.
 */
function meshSkirts(context: Context, out: Streams, cut?: TileRect): void {
  const { options, rgb } = context;
  const { polygons, top, maxEdge, tint } = options;
  const bottom = options.bottom;
  if (!bottom) return;
  const { positions, normals, uvs, colors, extras, indices } = out;
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
        if (cut && alongCut(cut, ax, ay, bx, by)) continue;
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
        if (options.extra) for (let n = 0; n < 4; n++) extras.push(0, 0, 0, 0);
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

// ------------------------------------------------------------------ tiles

/**
 * One tile's worth of a surface: its top faces and the skirts along its part
 * of the outline, ready to be copied into the surface's mesh (`mergeTiles`).
 */
export interface Tile {
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  readonly uvs: Float32Array;
  readonly colors: Float32Array;
  /** Four per vertex when the surface asked for `extra`, else empty. */
  readonly extras: Float32Array;
  /** Local to the tile. */
  readonly indices: Uint32Array;
}

/** An axis-aligned rectangle a surface has been cut to: [minX, minY, maxX, maxY]. */
export type TileRect = readonly [number, number, number, number];

/**
 * How far a cut may land from the line it was asked for: `cutAtAxis` moves a
 * cut a few thousandths off any vertex it would otherwise pass through.
 */
const CUT_SLACK = 0.1;

/**
 * The parts of `polygons` inside a rectangle, by four straight cuts (see
 * `cutAtAxis`). Both sides of a cut come from the same crossing points, so
 * the neighbouring rectangle, cut along the same line, meets these pieces
 * vertex for vertex.
 */
export function clipToRect(polygons: MultiPoly, rect: TileRect): MultiPoly {
  let pieces: MultiPoly = polygons;
  const cuts: [0 | 1, number, boolean][] = [
    [0, rect[0], true], [0, rect[2], false], [1, rect[1], true], [1, rect[3], false],
  ];
  for (const [axis, at, keepAbove] of cuts) {
    const next: MultiPoly = [];
    for (const polygon of pieces) {
      const box = bounds(polygon);
      if (!box) continue;
      const low = axis === 0 ? box[0] : box[1];
      const high = axis === 0 ? box[2] : box[3];
      // Wholly on the kept side, or wholly off it: no cut to make.
      if (keepAbove ? low >= at : high <= at) {
        next.push(polygon);
        continue;
      }
      if (keepAbove ? high <= at : low >= at) continue;
      const [below = [], above = []] = cutAtAxis(polygon, axis, at) ??
        clipHalves(polygon, Math.max(box[2] - box[0], box[3] - box[1]) + 1, axis === 0, at,
          box[0], box[1], box[2], box[3]);
      for (const piece of keepAbove ? above : below) next.push(piece);
    }
    pieces = next;
  }
  return pieces;
}

/**
 * Builds one tile of a surface: the top faces of `options.polygons` (already
 * cut to `rect`), and the skirts along every edge of their outline except the
 * edges the cut itself made, which are interior to the whole surface.
 */
export function meshTile(options: SurfaceMeshOptions, rect: TileRect): Tile {
  const context: Context = { options, uv: [0, 0], rgb: [1, 1, 1], four: [0, 0, 0, 0] };
  const out = streams();
  const spans: Poly[] = [];
  for (const polygon of options.polygons) splitToSpan(polygon, options.maxEdge * 6, spans);
  for (const span of spans) meshPiece(span, context, out);
  // No vertex is shared with another tile, so the smoothing is the one the
  // whole mesh would get.
  smoothTopNormals(out.positions, out.normals, out.indices);
  if (options.bottom) meshSkirts(context, out, rect);
  return {
    positions: new Float32Array(out.positions),
    normals: new Float32Array(out.normals),
    uvs: new Float32Array(out.uvs),
    colors: new Float32Array(out.colors),
    extras: new Float32Array(out.extras),
    indices: new Uint32Array(out.indices),
  };
}

/** Whether an edge runs along one of the lines a tile was cut on. */
function alongCut(rect: TileRect, ax: number, ay: number, bx: number, by: number): boolean {
  for (let k = 0; k < 4; k++) {
    const at = rect[k] as number;
    if (k % 2 === 0 ? Math.abs(ax - at) < CUT_SLACK && Math.abs(bx - at) < CUT_SLACK
      : Math.abs(ay - at) < CUT_SLACK && Math.abs(by - at) < CUT_SLACK) return true;
  }
  return false;
}

/** One mesh of a surface from its tiles, in order. */
export function mergeTiles(parts: readonly Tile[], options: Pick<SurfaceMeshOptions,
  'name' | 'material' | 'castShadow' | 'receiveShadow' | 'extra'>): Mesh | null {
  let vertices = 0;
  let count = 0;
  for (const tile of parts) {
    vertices += tile.positions.length / 3;
    count += tile.indices.length;
  }
  if (count === 0) return null;
  const positions = new Float32Array(vertices * 3);
  const normals = new Float32Array(vertices * 3);
  const uvs = new Float32Array(vertices * 2);
  const colors = new Float32Array(vertices * 3);
  const extras = options.extra ? new Float32Array(vertices * 4) : null;
  const indices = vertices > 0xffff ? new Uint32Array(count) : new Uint16Array(count);
  let v = 0;
  let k = 0;
  for (const tile of parts) {
    positions.set(tile.positions, v * 3);
    normals.set(tile.normals, v * 3);
    uvs.set(tile.uvs, v * 2);
    colors.set(tile.colors, v * 3);
    if (extras && tile.extras.length === (tile.positions.length / 3) * 4) extras.set(tile.extras, v * 4);
    const local = tile.indices;
    for (let i = 0; i < local.length; i++) indices[k++] = (local[i] as number) + v;
    v += tile.positions.length / 3;
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new BufferAttribute(uvs, 2));
  geometry.setAttribute('color', new BufferAttribute(colors, 3));
  if (extras && options.extra) geometry.setAttribute(options.extra.name, new BufferAttribute(extras, 4));
  geometry.setIndex(new BufferAttribute(indices, 1));
  return finish(geometry, options);
}

/** Bounding box of a polygon's outer ring, [minX, minY, maxX, maxY]. */
function bounds(polygon: Poly): [number, number, number, number] | null {
  const outer = polygon[0];
  if (!outer || outer.length < 3) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const point of outer) {
    const x = point[0] as number;
    const y = point[1] as number;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return [minX, minY, maxX, maxY];
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
 * Recomputes normals for the up-facing vertices only, in place.
 *
 * `computeVertexNormals` would average a kerb's vertical face into the footway
 * above it and round off every edge in the scene. The skirt already carries an
 * exact normal, so only the vertices that were flagged as flat-up are solved
 * here, and they are solved by area-weighted accumulation like any smooth
 * surface.
 */
function smoothTopNormals(
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
  for (const index of flat) {
    const x = acc[index * 3] as number;
    const y = acc[index * 3 + 1] as number;
    const z = acc[index * 3 + 2] as number;
    const length = Math.hypot(x, y, z);
    if (length < 1e-9) continue;
    normals[index * 3] = x / length;
    normals[index * 3 + 1] = y / length;
    normals[index * 3 + 2] = z / length;
  }
}

export function disposeMesh(mesh: Mesh): void {
  mesh.geometry.dispose();
}
