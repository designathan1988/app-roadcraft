# Terrain

**Model:** `src/world/terrain.ts` · **Mesh and material:** `src/render/terrain.ts`
**Tests:** `tests/world/terrain.spec.ts`

## The height field

```
height(x, y) = clamp( baseRelief(x, y) + Σ stamps , MIN, MAX )
```

Analytic, deterministic, and identical in the renderer, the simulation and a
headless test. There is no stored heightmap: the terrain *is* this function, and
the mesh is one sampling of it.

### Base relief

Four octaves of tiling value noise, so a new map is never a flat plane. A flat
plane is the single biggest reason a 3D scene reads as a drawing — with no
relief there is nothing for the sun to shade, and the ground is one colour from
horizon to horizon whatever the lighting does.

The amplitudes were set by **measuring the result**, not by taste. With a single
broad wavelength the field's median slope came out at 2° and its steepest at 7°,
which changes how much sun a face takes by about a tenth — under the threshold at
which the eye reads shape, and the reason the ground still looked painted after
the lighting was fixed. Splitting the amplitude across four octaves at shorter
wavelengths brings the median to roughly 5° and the steepest to about 16°, which
the sun models clearly, while the largest landforms stay gentle enough for a road
at grade (limited to 12%) to climb.

### Brushes

| mode | effect |
|---|---|
| `raise` | adds `strength × influence` |
| `lower` | subtracts the same |
| `river` | subtracts `strength × RIVER_CARVE × influence` — a deeper cut |
| `flatten` | levels towards the stamp's own `level`, or towards zero if it has none |

`influence` is a smoothstep from 1 at the centre of the brush to 0 at its rim,
so a stamp blends into the ground instead of leaving a disc. It is monotone,
which lets the water code invert it to find where a carve reaches a given depth.

`flatten` **blends** rather than sets, which is why the stamp list is applied in
authoring order and why `TerrainIndex` preserves that order.

Its `level` field is optional, and absent means sea level — which is
algebraically the rule it replaced (`h + (0 − h)·k` is `h·(1 − k)`), so a saved
map loads bit-for-bit unchanged. The editor captures the ground height under the
cursor when a levelling stroke *starts* and reuses it for every dab in that
stroke. That is the difference between a tool that flattens and a tool that
levels: drag across a slope and the whole swept area comes to the height you
started from, rather than each dab chasing the ground under itself and leaving
the slope exactly as it was.

### The brush, from the player's side

Handled in `src/main.ts`, and reworked because a player said sculpting was "not
at all comfortable". What that turned out to mean, in order of how much each one
hurt:

* **Every dab re-solves the whole road network.** A terrain edit moves
  `terrainRevision`, which re-solves the elevation field and re-triangulates
  every band laid on the ground. Dabbing on every pointer sample queued rebuilds
  until the player let go. `terrainPaintInterval()` asks the last rebuild what it
  cost, exactly as the node-drag preview does, so the brush stays live on an
  empty map and merely coarsens on a full one.
* **Dabs were spaced at 0.28 of the radius**, which reads as a string of craters
  rather than as a stroke, and a fast drag skipped between pointer samples
  entirely — a river ran straight through the gap. Dabs are now interpolated
  along the path at a fifth of the radius, with the count per event bounded so a
  pointer re-entering the canvas cannot lay two hundred at once.
* **A held brush did nothing.** It now reapplies itself while the button is
  down, which is what makes digging feel like digging.
* **The size and strength were only on a slider** across the map. The wheel
  sizes the brush and shift-wheel sets the strength while the terrain tool is
  up; `[` and `]`, `-` and `=` do the same from the keyboard, and the number row
  picks the operation (the road palette is hidden in this mode, so binding the
  digits to road classes there was a shortcut to something invisible).
* **Nothing said where the brush would land.** The ring now shows the radius,
  a second ring showing the bite at the current strength, a crosshair, and the
  ground height — with the *target* height while levelling, because you cannot
  match one slope to another by eye in an isometric projection.

The stamp cap was 512, and a river across the map is several hundred on its own:
the oldest dabs fell off the front of the list and the start of the player's own
river disappeared while they were drawing the end of it. It is 4 096 now. The
spatial index makes sampling cost depend on local density rather than on the
cap.

### `TerrainIndex`

A uniform grid over the stamps. `sampleTerrainHeight` runs once per terrain
vertex on every edit, and again for every road profile station and every mesh
vertex of every road; with a linear scan over the 512-stamp cap that was over
fifty million distance tests per brush stroke — exactly the stall felt while
painting.

The index **copies** the stamp list. Holding the document's live array made
every index look identical to the next one, and the renderer could never tell
what had just changed.

## The terrain mesh

A 4 800-unit plate at 300 cells a side, so one cell is 16 units (6.4 m) — fine
enough for the smallest brush. Around it sits a **frame**, not a plane: a plane
under the plate is the wrong shape, because the plate's own ground dips below it
wherever the relief goes negative and the plane then draws straight over the
terrain, the roads and everything on them. The frame occupies only the ground the
plate does not.

### Two heights, and the difference matters

```ts
heightAt(x, y)          // the analytic field — the smooth surface
renderedHeightAt(x, y)  // what the triangles actually draw
```

The mesh samples the field at cell corners and interpolates linearly across the
triangles between them, so the drawn surface differs from the field by up to
`(cell² / 8) × |H″|`. **Anything laid on the ground must clear the second one.**
`renderedHeightAt` reproduces `PlaneGeometry`'s own diagonal so it returns
exactly the number that is on screen.

### The material

Three surfaces blended in the fragment shader:

* **Slope decides the surface.** The blend is written against the slope in
  **degrees**, via `acos(normal.y)`. The obvious formulation — one minus the
  cosine — is unreadable for small angles and was simply wrong: a 10° hillside
  came out at 0.015, under a threshold meant to start at a gentle slope, and the
  whole map stayed one flat green however steep it got. Dirt fades in from 9° to
  26°; rock from 26° to 42°.
* **Two scales of each texture.** Each map is sampled at its own size and again
  eight times larger, and the two are mixed. The large sample breaks the repeat
  the eye otherwise locks on to from far away.
* **Macro variation.** A very slow noise tints whole regions warm or cool, and
  height adds dryness while hollows read damp.
* **A hillshade in the albedo.** Direct sun alone moves a 10° slope by about a
  tenth, which is under what the eye reads as shape at map zoom. A slope-gated
  term roughly doubles it, and leaves flat ground untouched.

## Water

A river's surface stands at the level of the channel it was cut **into**, below
the banks — not at a fixed world datum and not level with the banks. Both
mistakes were made and both are visible:

* at a fixed datum, ground raised to 28 and then carved left a bed at 14 with the
  water plane at 0.12 — fourteen units under the bed, so the river drew nothing;
* level with the banks, the ground hid the plane only outside the whole carved
  valley, and the valley rendered as one flat sheet over the landscape.

So the level is a share of the channel's depth below its banks, computed from the
stamp list **without the rivers** — which is exactly the surface the channel was
carved from.

The surface itself is one triangulated grid accumulated from every overlapping
river stamp, not one translucent disc per stamp. Forty brush samples meant forty
blended discs, which is the pale cloud saved maps used to show. On the shared
grid the union happens before rendering: overlap changes the local level, never
the opacity. Each vertex takes the weighted average of the stamps reaching it, so
the surface runs **down** the channel's own profile instead of standing at one
height along a river that drops seventeen units across the map.

Cells whose surface is not actually held inside the carved ground are dropped, so
the water ends at its shore rather than showing a circular rim in open air.

### What it looks like

`src/render/water.ts`. The surface used to be a flat blue `MeshStandardMaterial`
with a little metalness, which reads as a sheet of plastic. It is now a
`MeshStandardMaterial` extended through `onBeforeCompile` — so it still takes the
scene's lights, environment map, shadows and tone mapping — with:

* **two scrolling normal layers** at different scales and speeds, summed rather
  than blended, because a lerp of two opposed normals cancels to flat;
* a **depth tint**, from an `aDepth` attribute the geometry builder writes as
  `level − ground`: shallow water is lighter and greener, deep water darker and
  bluer, and the opacity ramps with it so a river has a visible bed instead of
  vanishing at the same rate everywhere;
* **shore foam**, a pale band where the depth approaches zero, broken up with a
  noise sample so it does not read as a contour line;
* a **Schlick fresnel** — with a deliberately unphysical exponent and base,
  because an orthographic camera locked at 48° never reaches the angles at which
  a real fresnel term switches on, and at 4% reflectivity the water reads as
  paint again.

The whole thing costs **two texture fetches** from one sampler plus arithmetic:
the foam's noise rides in the alpha channel of the same normal map. The
animation drives itself from the mesh's `onBeforeRender`, so nothing outside the
module has to tick it.

## Incremental update

A brush stroke adds one stamp with a bounded radius. `update` rewrites only the
grid corners that stamp can reach; rewriting all 90 601 of them for every stroke
is what made painting drop frames on a large map. Any other change — a load, an
undo, a clear — falls back to a full rewrite.
