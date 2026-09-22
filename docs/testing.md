# Testing

```bash
npm run check            # lint + typecheck + tests with coverage + build
npm run verify:visual    # boot the real app in a browser and measure the scene
npm run verify           # both
npm run screens          # verify:visual, writing docs/screenshots/*.jpg
```

`npm run check` must be green before anything is considered done. It takes
seconds.

## What the unit suite covers

| suite | what it pins |
|---|---|
| `tests/core/geometry.spec.ts` | vectors, polyline sampling and closest point, offsetting, Bézier flattening, the clipper wrapper |
| `tests/world/terrain.spec.ts` | base relief is deterministic, continuous, not flat, and inside the gradient a road can climb; brushes; levelling reaches its target, leaves the ground outside the brush alone, and reproduces the old rule exactly when a stamp carries no target; the stamp index answers exactly what a linear scan does and copies its input |
| `tests/world/elevation.spec.ts` | the height field is continuous, flat across a junction, above the ground everywhere a surface is drawn, inside the gradient limits; ramps land exactly on the road they join; a short span lowers its deck instead of steepening its ramp; a tunnel dives under its hill, meets the ground at both portals, stays continuous, and becomes an open cutting when it is too short to reach depth |
| `tests/world/surfaces.spec.ts` | levels nest, bands partition the casing exactly, classes carry keys rather than sentences |
| `tests/render/surfaceMesh.spec.ts` | no edge over the limit, no T-junction, every top face wound upwards, holes carried through, skirts and their outward normals |
| `tests/render/tessellation.spec.ts` | the measured cost ceilings |
| `tests/editor/editing.spec.ts` | split, join, duplicate, undo, terrain revisions, JSON round-trip |
| `tests/sim/drivers.spec.ts` | drivers of one class differ in acceleration, headway, gap and threshold; each one is internally consistent; the emergency brake barely varies; the speed wander is continuous and bounded; faster vehicles actually overtake slower ones; nobody weaves; the fleet does not accumulate in the inner lane; no two vehicles overlap |
| `tests/sim/pedestrians.spec.ts` | the same seed gives the same crowd; parties stay together within a bound and agree on their pace; nobody is in a carriageway outside a crossing; lateral offsets stay on the footway and never jump; speeds and destinations spread |
| `tests/sim/agents.spec.ts` | every archetype has sane dimensions and driving parameters, the spawn shares sum to one, the fleet covers the classes it claims to, and the per-agent variation is stable, in range and spread |
| `tests/sim/traffic.spec.ts` | traffic spawns and moves; an **uncontrolled** junction is never deadlocked; a signalised one flows; agents stay on real lanelets at finite speeds; the network can be edited underneath the simulation; the same seed gives the same result |
| `tests/ui/i18n.spec.ts` | the dictionaries cover the same keys with the same placeholders; the markup names only keys that exist; no Portuguese is left in the shipped markup |

### The continuity test is the important one

A continuous field's worst jump shrinks in proportion to the sampling step; a
field with a cliff keeps the same jump however finely it is sampled. Halving the
step and requiring the jump to halve with it is therefore the test that actually
distinguishes the two — and it is what caught an 8.8-unit cliff a few tens of
units off the kerb.

## Coverage

Coverage is scoped to the layers that can be tested headlessly and
deterministically: `core`, `world`, `sim`, `editor`, `render/mesh` and
`ui/i18n`. WebGL, the DOM and the viewport seam are covered by the browser check
instead; asking a node runner to cover them would only measure how much of the
renderer can be imported without a GPU.

Thresholds are set from the measured value, so they can only ever be raised.

## The browser check

`scripts/verify-visual.mjs` boots the production bundle in Chromium, builds eight
scenarios through the same public API the editor uses, and measures the scene
graph. Two more checks follow them, because only the running app can answer
either.

| scenario | why it is in the list |
|---|---|
| `crossroads-flat` | the baseline junction |
| `crossroads-rolling` | a junction over ground that rises and falls |
| `viaduct-over-road` | a raised road crossing one at grade with no node |
| `elevated-to-grade` | a ramp landing on a street |
| `bridge-over-river` | a span over carved terrain and water |
| `city-on-edited-terrain` | scale, on ground the player has sculpted |
| `tunnel-through-hill` | the one structure whose road is *supposed* to be buried |
| `signalised-junction` | every lamp exists and at least one of them is lit |

Then:

* **`aim-at-elevated-node`** — the editor must be able to *point* at a raised
  deck. A tilted view projects a deck fifteen units up about thirteen units away
  from the ground beneath it, so an editor casting at `y = 0` picks a spot short
  of the node the player is aiming at and nothing ever snaps. The check measures
  that offset (it is 23 px at the scenario's zoom, so the case is real) and
  requires the pick to land on the node anyway.
* **`after-terrain-edit`** — the terrain is edited *after* the roads exist, and
  every surface is measured again.

It fails on:

* nothing built;
* any non-finite vertex;
* **any road-surface vertex under the terrain** (skirt vertices are excluded by
  their normal, because a skirt is meant to run into the ground; a tunnel's bands
  are excluded by their name, and separately *required* to be buried, so a tunnel
  that silently drew nothing could not pass);
* a scenario's own expectation — the tunnel's portal walls, the signal's lamps;
* any page error or console error.

It prints mesh, vertex and triangle counts either way, so a regression is a
number rather than an impression.

Set `CHROME_PATH` if Playwright's own browser download is unavailable.

`npm run verify:visual` takes a couple of minutes. `npm run screens` takes about
ten, almost all of it in the screenshot capture itself: on a software rasteriser
one frame of a lit, post-processed scene at 1280×800 costs about a minute to
compose. It also runs the simulation and then **pauses traffic** before each
capture — a canvas that redraws every frame makes the compositor wait for a
stable frame that never arrives, and the capture times out rather than producing
a blurred image.

## Adding a test

Put it beside its subject under `tests/`, mirroring `src/`. Prefer a property
over an example where one exists — "the field is continuous", "the bands
partition the casing", "the same seed gives the same result" — and when you pin a
number, write down the measurement it came from so the next person knows whether
it may move.
