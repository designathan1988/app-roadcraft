# Performance

The brief is a balance: the scene must look three-dimensional and must stay fast
on a large map. Everything here is one of the two halves of that.

## Where the time goes

| phase | when | cost driver |
|---|---|---|
| terrain update | a brush stroke | grid corners inside the stamp's reach |
| network rebuild | any road edit | junction solving, polygon booleans |
| elevation solve | either | stations × lateral samples, then the query per vertex |
| surface meshing | either | polygon splitting, ear clipping, refinement |
| frame | always | draw calls, shadow map, post-processing |

## What keeps each of them bounded

### Terrain

* **Analytic height field, no stored heightmap.** Nothing to allocate or copy.
* **`TerrainIndex`** — a uniform grid over the stamps. With a linear scan over
  the 512-stamp cap, a full terrain rewrite was over fifty million distance
  tests; the grid reduces it to the handful of stamps that actually reach a
  point.
* **Incremental rewrite.** A stroke rewrites only the corners its stamp can
  reach, not all 90 601.

### Elevation

* **One solve for the whole network**, shared by every band, every marking, every
  agent and every prop. Solving per structure or per band is both slower and the
  reason two surfaces used to disagree about the same junction.
* **A spatial grid over the segments.** The query runs once per mesh vertex —
  hundreds of thousands of times on a large map — and a linear scan made the
  rebuild quadratic in the size of the network.

### Meshing

This is where the largest win is, and it is worth stating as a number.

| | triangles | time |
|---|---|---|
| 1400 × 1.5 band, before | 1 026 232 | ~900 ms |
| the same, after | 2 624 | 34 ms |
| a city grid's four bands, before | ~1 000 000 | 2 708 ms |
| the same, after | 92 856 | 393 ms |

Two changes did that: cutting the polygon into compact pieces so ear clipping
cannot fan, and bisecting only the longest edge so refinement doubles the
triangles that are too big instead of quadrupling all of them. See
[mesh-generation.md](mesh-generation.md).

Tessellation limits are also no longer sized against the terrain's curvature.
The elevation solver already dilates its ground reading over a window wider than
the chord, so the mesh needs only enough vertices to shade well — 8 units at
grade, 16 on a raised deck.

`tests/render/tessellation.spec.ts` pins these as ceilings, so a regression is a
failing number rather than a slow frame.

### Frame

* **Instancing** for everything repeated — see
  [rendering.md](rendering.md#instancing).
* **One material per surface**, shared across every structural level, so the
  renderer batches.
* **Bounding spheres** on every static instanced mesh, so the frustum can reject
  them.
* **Zoom-gated detail.** Below `detailCutoffZoom` the props, the pedestrians, the
  signal heads and the small vehicle parts are not written at all.
* **A fitted shadow frustum**, re-fitted only when the view changes by more than
  8%.
* **Signal heads are removed, not hidden**, when their junction disappears.

## Quality tiers

`src/render/quality.ts` is one table. Every expensive feature is named there
once, so a tier is a table entry rather than conditionals scattered across the
renderer.

| | low | medium | high | ultra |
|---|---|---|---|---|
| pixel ratio cap | 1 | 1.25 | 1.5 | 2 |
| shadows | — | 1024 | 2048 | 4096 |
| post-processing | — | — | yes | yes |
| ambient occlusion | — | — | 8 samples | 16 samples |
| SMAA | — | — | yes | yes |
| anisotropy | 2 | 4 | 8 | 16 |
| props | — | yes | yes | yes |
| vegetation | 0 | 600 | 1 400 | 2 600 |
| detail cutoff zoom | 0.50 | 0.34 | 0.26 | 0.20 |

### The automatic governor

Starts at `high`. It takes one frame-time sample per frame, discards anything
over 400 ms (a rebuild stall is one bad frame, not a frame rate), and every 60
samples compares the **median** against two thresholds: step down under 34 fps,
step up over 110 fps.

Hysteresis on both sides and a 2.5-second cooldown after every change, because a
tier switch itself costs a frame — without them the monitor oscillates between
two tiers for ever, which is worse than sitting on the slower one.

The player can override it from the top bar at any time; the choice is
remembered.

## Measuring

```bash
npm run verify:visual
```

prints per-scenario mesh counts, vertex counts, triangle counts, the heaviest
single mesh and a smoothed frame rate, for six scenarios including a city grid on
edited terrain. Compare the table, not an impression.

Frame rates from that harness are only comparable to each other: in a headless
container the browser falls back to a software rasteriser, and the number says
nothing about a real GPU. The mesh and triangle counts are hardware-independent
and are the numbers worth watching.
