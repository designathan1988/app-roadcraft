# Mesh generation

**File:** `src/render/mesh/surfaceMesh.ts`
**Tests:** `tests/render/surfaceMesh.spec.ts`, `tests/render/tessellation.spec.ts`

`buildSurfaceMesh` turns one clipped surface band into one solid, watertight
mesh. It is a small file that has to get four things right at once, and each of
them has a specific failure it exists to prevent.

## 1. Compact pieces before triangulation

Ear clipping is a *triangulation* algorithm, not a *meshing* one: it guarantees a
valid cover and says nothing about triangle shape. On a long thin band — a road's
verge is 1400 units long and 1.5 wide — `earcut` emits a **fan**. Measured on
exactly that shape, every one of the 352 triangles it returned had an edge up to
1392 units long.

No refinement recovers cheaply from a fan. Bisecting a sliver whose long edge is
shared with its neighbour cascades: the same strip refined to an 8-unit edge cost
**274 000 triangles for 2 100 square units of surface**, and one straight road
cost over a million.

`splitToSpan` cuts the polygon first, recursively bisecting along its longer axis
with the polygon clipper until no piece is wider than `maxEdge × 6` in either
direction. A recursive bisection costs `O(log n)` passes over the polygon rather
than one clipper call per grid cell — on a city-sized network that is the
difference between 0.4 s and several seconds.

Measured after the change, for the same strip: **2 624 triangles, 34 ms.**

## 2. Outline sampling that cannot crack across a cut

Each piece's outline is sampled at exactly `maxEdge`, and the refinement below
only ever splits an edge **strictly longer** than `maxEdge`. No boundary edge is
ever split, so two pieces sharing a cut keep identical vertices along it and no
T-junction can appear between them.

## 3. Longest-edge bisection with red/green closure

```
each round:
   for every triangle, mark its LONGEST edge if that edge is over the limit
   then rewrite every triangle from how many of its edges are marked:
      0 → keep         1 → 2 triangles
      2 → 3 triangles  3 → 4 triangles
```

Marking is **global**, which is what keeps the mesh conforming: an edge is split
for both triangles that share it, or for neither. Marking only the *longest*
edge is what keeps it cheap: a well-shaped triangle is never touched, and an
over-long one halves rather than quarters.

## 4. Winding measured, not assumed

World `y` is mirrored into three's `z`. That reflection flips handedness, so a
ring that is counter-clockwise on the map comes out clockwise in the scene —
which, taken in index order, gives a normal pointing **up**, exactly what a top
face needs.

An earlier version "corrected" for the mirrored axis and reversed the winding.
Every road surface faced downwards, was back-face culled, and the roads were
simply not on screen — while every diagnostic said the meshes existed, with the
right vertex counts, at the right heights.

`signedArea` measures the outer ring instead. It costs nothing and cannot be
wrong.

## Skirts

A band that stands proud of the one outside it (a kerb, a raised deck) gets a
vertical face drawn down from its outline, so the edge is a solid surface rather
than an infinitely thin sheet seen edge-on.

Skirts are built from the **original outlines**, never from the split pieces. A
cut made for triangulation is an interior line; giving it a wall would hang a
sheet of kerb down the middle of the carriageway.

Skirt vertices carry a horizontal normal written directly, and `smoothTopNormals`
recomputes only the up-facing vertices. `computeVertexNormals` would average the
kerb's vertical face into the footway above it and round off every edge in the
scene.

The skirt's winding is derived from the same measured orientation as the top
face, so its outward normal and its visible side always agree.

## UVs

The caller supplies `uv(x, y, out)`. `roadSurfaces.ts` passes road-local
coordinates from `RoadElevation.frameAt` — distance **along** the nearest road
and offset **across** it — divided by the material's declared tile size. Asphalt
grain therefore runs along the carriageway and kerb joints run along the kerb,
whatever compass direction the road happens to point.

## Cost ceilings

`tests/render/tessellation.spec.ts` pins the measured cost, so a regression of
the fan or the explosion is a failing number rather than a slow frame:

| case | ceiling |
|---|---|
| 1400 × 1.5 band | 4 000 triangles |
| 1400 × 60 band | 20 000 triangles |
| whole city grid, four bands | 200 000 triangles, under 4 s cold |

## Reading the file

| function | role |
|---|---|
| `splitToSpan` | recursive bisection into compact pieces |
| `densify` | outline sampling at `maxEdge` |
| `refine` | longest-edge bisection until every edge fits |
| `emit` | the red/green cases |
| `signedArea` / `ringArea` | orientation, measured |
| `smoothTopNormals` | smooth the surface, keep the edges hard |
