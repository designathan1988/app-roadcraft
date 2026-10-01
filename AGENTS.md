# AGENTS.md — the map of this project

This file exists so that an AI (or a new engineer) can find the right file on
the first try, change it without breaking three other things, and know what to
run afterwards. Read this before touching anything.

**Everything in this repository is in English** — code, identifiers, file names,
folder names, comments, commit messages and documentation. The *interface* is
translated at runtime (`src/ui/i18n/`); nothing else is.

---

## 1. One paragraph on what this is

Roadcraft is a browser game. The player draws a road network onto a terrain they
can also sculpt, and a continuous traffic simulation runs on it. The view is a
fixed-angle isometric 3D scene rendered with three.js. Every edit — a road, a
brush stroke, a lane count — takes effect immediately, which means every system
here has to be rebuildable from the document in a fraction of a second.

---

## 2. The dependency order (enforced, not merely stated)

```
core  →  world  →  sim
                →  render
        world  →  editor  →  ui
core  →  view   →  render, ui
```

* `core` knows nothing about roads. Pure 2D geometry and numerics.
* `world` owns the **document** (what the player authored) and everything
  derived from it that is not a picture: road widths, junction outlines, surface
  polygons, the **elevation field**, lanelets, terrain, and **where the map
  ends** (`world/bounds.ts`).
* `sim` reads `world` and owns vehicles, pedestrians and signals. It never
  reads `render`.
* `view` is the seam between a world point and a screen point, and knows only
  `core`. Both renderers implement it, which is what lets the editor work in
  world coordinates and never ask which renderer is running.
* `render` reads `world`, `sim` and `view`, and owns three.js. **Nothing
  outside `src/render/` may import `three`.**
* `editor` mutates the document. `ui` is the DOM; it may READ `sim`, because
  the inspector and the minimap display live simulation state.
* `main.ts` wires them together and owns the input handling and the frame loop.
  It is the composition root, and the only file allowed to touch everything -
  together with `buildingsWiring.ts`, which is `main.ts`'s building section
  split out (the building tool's view, host, palette and overlay), so the
  building feature touches `main.ts` in a handful of lines.

If you find yourself wanting to import `render` from `world`, the thing you
want belongs in `world` instead.

**`eslint.config.js` now enforces this**, one `no-restricted-imports` block per
layer. It was a paragraph before, and two violations had grown under it: a real
cycle, `world/markings.ts` importing its line colours from `ui/overlay/palette`,
and `render` reaching `ui` through `view` because the flat camera sat in
`ui/overlay/`. The colours moved to `world/roadTypes.ts` and the camera to
`view/camera.ts`; the rule is what stops the next one.

`tests/arch/layers.spec.ts` covers the two rules a lint rule cannot express:
that `world` and `sim` never call `Math.random` (invariant 5, which
`core/rng.ts` claimed was checked by a test that did not exist), and that
`three` is imported nowhere outside `render`.

---

## 3. Where to change what

| I want to change… | Go to | Also read |
|---|---|---|
| how high a road sits, ramps, junction plates, grade limits | `src/world/elevation.ts` | [docs/elevation.md](docs/elevation.md) |
| the shape of a junction (corner radii, trims, mouths) | `src/world/junction/` | [docs/intersections.md](docs/intersections.md) |
| road widths, lane counts, classes, markings style | `src/world/roadTypes.ts` | [docs/road-system.md](docs/road-system.md) |
| which surface polygons exist at all | `src/world/surfaces.ts` | [docs/road-system.md](docs/road-system.md) |
| structural levels (elevated / viaduct / bridge / tunnel) | `src/world/structures.ts` | [docs/elevation.md](docs/elevation.md) |
| the land itself, brushes, rivers, base relief | `src/world/terrain.ts` | [docs/terrain.md](docs/terrain.md) |
| how a polygon becomes triangles | `src/render/mesh/surfaceMesh.ts` | [docs/mesh-generation.md](docs/mesh-generation.md) |
| the terrain mesh, its material, the water geometry | `src/render/terrain.ts` | [docs/terrain.md](docs/terrain.md) |
| what water LOOKS like — ripples, depth tint, foam, fresnel | `src/render/water.ts` | [docs/terrain.md](docs/terrain.md) |
| what a surface looks like (colour, roughness, relief) | `src/render/materials.ts` | [docs/materials-textures.md](docs/materials-textures.md) |
| sun, sky, shadows, fog, environment map | `src/render/environment.ts` | [docs/lighting.md](docs/lighting.md) |
| ambient occlusion, anti-aliasing, tone mapping | `src/render/postprocess.ts` | [docs/rendering.md](docs/rendering.md) |
| what is built and when, the scene graph | `src/render/renderer.ts` | [docs/rendering.md](docs/rendering.md) |
| road markings, crossings, stop bars | `src/world/markings.ts` + `src/render/markings.ts` | [docs/road-system.md](docs/road-system.md) |
| piers, parapets, tunnel portals | `src/render/structures.ts` | [docs/rendering.md](docs/rendering.md) |
| lamps, trees | `src/render/scenery.ts` | [docs/rendering.md](docs/rendering.md) |
| vehicles and pedestrians on screen | `src/render/agents.ts` | [docs/rendering.md](docs/rendering.md) |
| the vehicle fleet — classes, sizes, driving behaviour, spawn shares | `src/sim/vehicles/archetypes.ts` | [docs/architecture.md](docs/architecture.md) |
| traffic signal heads and their lamps | `src/render/signals.ts` | [docs/rendering.md](docs/rendering.md) |
| editing tools, the terrain brush, the control tool, the overlay | `src/main.ts` | [docs/architecture.md](docs/architecture.md) |
| the road/traffic defect detector, its fixtures | `tests/fuzz/` | [docs/fuzzing.md](docs/fuzzing.md) |
| road-space asphalt detail: gutter, wheel tracks | `src/render/materials.ts` (`ROAD_SPACE_FRAGMENT`) | `src/render/roadSurfaces.ts` (`roadEdge`) |
| quality tiers, the automatic downgrade | `src/render/quality.ts` | [docs/performance.md](docs/performance.md) |
| car-following, lane changes, spawning | `src/sim/vehicles/` | [docs/architecture.md](docs/architecture.md) |
| how one driver differs from another | `src/sim/vehicles/driver.ts` | [docs/architecture.md](docs/architecture.md) |
| overtaking and lane discipline | `src/sim/vehicles/laneChange.ts` | [docs/architecture.md](docs/architecture.md) |
| the NEW pedestrian engine (Detour crowd, `?people=crowd`): intent, zebras, narrow passages | `src/sim/people/crowd.ts`, `crowdNav.ts` | [docs/handoff/people-crowd.md](docs/handoff/people-crowd.md), skill `roadcraft-people-crowd` |
| pedestrian pace, parties, steering, destinations | `src/sim/peds/behaviour.ts` | [docs/architecture.md](docs/architecture.md) |
| what pedestrians do in places — benches, stopping to look, talking | `src/sim/peds/activities.ts` | [docs/architecture.md](docs/architecture.md) |
| how a pedestrian's body moves — walk, start, stop, turns, sit, talk | `src/render/riggedCitizens.ts` + `src/render/citizenWalk.ts` | `scripts/extract-rocketbox-clips.mjs` |
| the citizen model files, their catalog, hashes and download size | `public/models/citizens/`, rebuilt by `scripts/convert-citizens.mjs` → `pack-citizens.py` → `citizen-lods.mjs` → `strip-citizen-animations.mjs` | [docs/pedestrians.md](docs/pedestrians.md) |
| right of way, gap acceptance, deadlock | `src/sim/intersections/admission.ts` | [docs/architecture.md](docs/architecture.md) |
| the path a turn takes through a junction | `src/world/turnPaths.ts` | `tests/world/connectorFootprints.spec.ts` |
| cars stopping at the kerb, doors, people getting in and out | `src/sim/vehicles/kerbStops.ts` | `tests/sim/kerbStops.spec.ts` |
| vehicle bodies, doors, seats, two-wheeler frames | `src/render/vehicleModels.ts` | `tests/render/occupantFit.spec.ts` |
| drivers', passengers' and riders' poses | `src/render/riderPoses.ts` | `docs/audit/seated-pose-extents.json` |
| which movements physically conflict, and where | `src/world/conflictPoints.ts` | `tests/sim/collisions.spec.ts` |
| signal plans and phases | `src/sim/signals/` | [docs/architecture.md](docs/architecture.md) |
| tools, undo, save/load | `src/editor/` | [docs/architecture.md](docs/architecture.md) |
| the building model: volumes, storeys, facades, foundations, validation, presets | `src/world/buildings/` | [docs/buildings.md](docs/buildings.md) |
| building commands, snapping, the building tool | `src/editor/buildings.ts`, `buildingSnap.ts`, `buildingTool.ts` | [docs/buildings.md](docs/buildings.md) |
| what a building LOOKS like: shell, openings, roofs, instanced parts | `src/render/buildings/` | [docs/buildings.md](docs/buildings.md) |
| the building creator and its handles | `src/ui/buildingCreatorPanel.ts`, `src/ui/overlay/buildingOverlay.ts`, `src/buildingsWiring.ts` | [docs/buildings.md](docs/buildings.md) |
| any text the player reads | `src/ui/i18n/en.ts` **and** `pt-BR.ts` | [docs/i18n.md](docs/i18n.md) |
| panels, buttons, the inspector | `index.html`, `src/ui/` | [docs/i18n.md](docs/i18n.md) |

---

## 4. The execution flow, once

```
pointer / key
  └─ main.ts  ──────────────────────────────── mutates the document
       RoadDoc                                  (src/world/doc.ts)
         │ revision++
         ▼
       Network.rebuild()                        (src/world/network.ts)
         │  ribbons, junction rings, trims
         ▼
       requestAnimationFrame → frame()          (src/main.ts)
         ├─ SimWorld.step()                     (src/sim/pipeline.ts)
         └─ SceneHandle.draw()                  (src/render/renderer.ts)
              ├─ terrain.update(doc)            terrain revision gate
              └─ rebuildWorld(net)              network + terrain revision gate
                   ├─ buildRoadElevation()      ONE height field  ← the keystone
                   ├─ buildRoadSurfaces()       4 bands per structural level
                   ├─ buildStructureDetails()   piers, parapets
                   └─ buildScenery()            lamps, vegetation
```

**Three road and land revisions gate rebuilds**: `doc.revision` changes road
geometry, `doc.trafficRevision` changes the road plan read by vehicle and
pedestrian topology, and `doc.terrainRevision` changes the land. A height edit
always moves `doc.revision`; it moves `trafficRevision` only if it changes the
tunnel junction mode. A road is laid *on* the terrain, so a terrain edit also
invalidates road meshes. Build derived render geometry inside `rebuildWorld`,
never inside `draw`.

---

## 5. The five invariants that hold this together

Break one of these and the symptom appears somewhere else entirely.

1. **The road height field is a continuous function of position.**
   `world/elevation.ts` is queried per mesh vertex, and a vertex knows only its
   `(x, y)`. Any discontinuity in that function is a crack, a step or an
   overlapping plate in the mesh. There is a test that measures continuity by
   halving the sampling step (`tests/world/elevation.spec.ts`).

2. **Every band of a road reads the same deck height.**
   Verge, footway, kerb and carriageway are offsets from one number. Never give a
   band its own elevation source.

3. **A junction plate is flat, and every leg is flat over the plate's reach.**
   That is what makes the junction and its legs agree exactly. The reach comes
   from `Network.trims`, which the junction builder already computed.

4. **Nothing computes geometry inside a draw call.**
   Everything derived is built in `rebuildWorld` behind the revision gates.

5. **`world` and `sim` never call `Math.random`.**
   Use `core/rng.ts`. Determinism is tested.

---

## 6. How to add a feature without breaking things

### A new road class
`src/world/roadTypes.ts` → add to `ROAD_TYPES` with a `nameKey`/`subKey`; add
those two keys to **both** dictionaries in `src/ui/i18n/`. Widths, junctions,
markings, lanelets and meshes are derived. Classes with one-way defaults also
need the direction rule in `src/editor/commit.ts`; limited-access classes must
be excluded from pedestrian paths in `src/sim/peds/sidewalk.ts`.

### A road that rises or falls
Road height is authored as `RoadNode.heightOffset`, relative to designed ground.
`src/world/elevation.ts` solves the vertical profile continuously, while
`src/render/roadSurfaces.ts` keeps authored decks separate at grade crossings
and `src/render/structures.ts` derives supports and portals from terrain cover.
`ROAD_STRUCTURES` remains for loading legacy maps, not for new tool modes.

### A new editing tool
`src/main.ts`: add it to the `Tool` union, add a `case` in the `pointerdown`
switch, add a letter to the `shortcuts` map, and add a button with
`data-tool="…"` to `index.html`. Then `tool.<name>`, `hint.<name>` and
`hint.mobile.<name>` in **both** dictionaries — `hintKey` derives the key from
the tool, so a missing one shows as a blank hint bar rather than as an error.
The junction-control tool (`cycleNodeControl`) is the smallest complete example.

### A new surface layer (say, a cycle track)
`src/world/roadTypes.ts` (`Level`, `halfWidth`) → `src/world/surfaces.ts`
(`Surfaces`, `Bands`) → `src/render/roadSurfaces.ts` (one more
`buildSurfaceMesh` call, at its own offset from the shared deck).

### A new visual effect
Put it in `src/render/postprocess.ts` behind a flag in
`src/render/quality.ts`, so it can be switched off on a weak machine. Never add
an unconditional cost.

### A new terrain brush
`src/world/terrain.ts` (`TerrainMode` + the branch in `sampleTerrainHeight`) →
`index.html` (a button with `data-terrain-mode`) → `TERRAIN_BRUSH_COLOUR` and
`TERRAIN_BRUSH_FILL` in `src/main.ts`, or the ring preview throws → both
dictionaries, including `hint.terrain.<mode>` and `hint.mobile.terrain.<mode>`.
If the brush needs a parameter of its own, add an optional field to
`TerrainStamp` and default it where it is read, the way `level` does: a stamp
written by an older build must load unchanged.

### A new player-facing string
Never write it inline. Add a key to `src/ui/i18n/en.ts` **and**
`src/ui/i18n/pt-BR.ts`; a test fails if the two drift apart. In markup use
`data-i18n`; in code use `t('key')`.

---

## 7. What to run

```bash
npm install
npm run dev              # the game, on localhost
npm run check            # lint + typecheck + tests with coverage + build
npm run verify:visual    # boots the real app in a browser and measures the scene
npm run verify           # both of the above
npm run screens          # verify:visual, and write docs/screenshots/*.jpg
node scripts/bench-sim.mjs out.json          # headless ms/tick per stage and ms/edit (docs/performance.md)
node scripts/capture-scene.mjs <dir> [url]   # scene photos: fixed cameras, close-ups, pan/zoom frames, draw cost
```

**The defect detector** is `tests/fuzz/` (docs/fuzzing.md). Its smoke profile
runs in `npm run check`; before touching `world/` or `sim/`, run a hunt
(`FUZZ_HUNT=1 FUZZ_SEEDS=80 FUZZ_OPS=40 npx vitest run tests/fuzz/fuzz.spec.ts
--testTimeout=0`) and compare the tally before and after your change. A defect
you fix gets a shrunk fixture in `tests/fuzz/fixtures/`; one you cannot fix
gets a fixture with `open` saying why.

`npm run check` must be green before anything is considered done. It is fast
(seconds). `npm run verify:visual` is the one that catches what unit tests
cannot: a scene that does not boot, a surface under the terrain, a non-finite
vertex, a page error. It drives the installed Chrome on the real GPU (set
`CHROME_PATH` to use another); `ROADCRAFT_SOFTWARE_GL=1` falls back to
SwiftShader for a machine with no GPU, which rasterises on the CPU and is
many times slower.

**Never saturate the machine.** The game is played on the same computer the
tests run on. `vitest` is capped at 6 workers (`VITEST_MAX_WORKERS`), because
each worker may be simulating a whole map; run one heavy job at a time (a full
suite, a build, a browser harness), prefer the targeted spec files, and stop
dev servers and browsers as soon as a check is done.

---

## 8. Working here

* **The whole master plan is handed to Codex** (2026-10-01): stages 0-13,
  people, vehicles, buildings and roads. Read
  [docs/handoff/codex-program.md](docs/handoff/codex-program.md) first; the
  plan itself is [docs/handoff/master-plan.md](docs/handoff/master-plan.md).
* **Pedestrians are handed to Codex** (2026-10-01): any work on people
  movement follows the skill `.agents/skills/roadcraft-people-crowd/` and
  [docs/handoff/people-crowd.md](docs/handoff/people-crowd.md). That work is
  done in the shared checkout on `master` (its uncommitted trace tools live
  there and it has a single writer); the worktree rule below applies to
  everything else.
* **A worktree of your own, always.** Several agents work in this repository
  at once. `git worktree add -b <branch> ../<name> master`, work and commit
  there, and never edit, stage or commit someone else's uncommitted changes in
  the shared checkout. Do not delete branches or worktrees you did not create.
* **One heavy job on the machine at a time** (a full suite, a build, a browser
  harness, a benchmark), and tell the other sessions before you start one.
  Prefer the targeted spec files while working.
* **A replacement is built, not patched into the old code.** When the
  player orders a system replaced (pedestrian or traffic agents, the person
  model), build the new one and switch it on in the game; do not patch the
  model being replaced, and do not report design, research or
  behaviour-neutral seams as progress the player can see. Status reports say
  what is live in the game and what is not. See `CLAUDE.md`.
* **Tests measure what the player sees.** A green suite does not prove a
  visible defect gone: measure the drawn result (for motion, the published
  `PedView` per tick) and look at it in the game. No hour-long or parallel
  background runs.
* **One writer per field.** Every piece of state has exactly one module that
  writes it (the list for the simulation is in `sim/pipeline.ts`: topology in
  stage 0, signals in 1, routes and population in 2, pedestrians in 3,
  constraints 4-5, position and speed only in `integrate` at 6). A number
  used in two places is declared once (the footway height is
  `world/roadTypes.ts` `FOOTWAY_RISE`, and `tests/arch` checks it). If you
  need to write something from a second place, you need a new field.

## 9. Couplings that break far from where you edit

1. **One trim per segment end** feeds the junction mouth, the zebra, the stop
   line, the lanelet end, the elevation plate, the footway kerb nodes and the
   markings. Changing a constant in `world/approach.ts` moves all of them.
   `Network.stopLineDistance` never returns less than the mouth.
2. **`HEADING_CHORD`** is shared by `sim/pose.ts`, `world/conflictPoints.ts`
   and `world/turnPaths.ts`: change the three together or none;
   `tests/sim/collisions.spec.ts` is the guard.
3. **Seat and door numbering**: `sim/vehicles/kerbStops.ts` counts seats with
   `archetype.doorsPerSide`, `render/vehicleModels.ts` with its door edges.
   They agree by construction only; a new body style must keep both.
4. **Population ceilings**: `FLEET_CEILING` and `PED_CEILING` (`sim/params.ts`)
   also size the renderer's instance buffers (`render/agents.ts`).
5. **Revisions**: `doc.revision` (all road geometry) gates `Network`, road meshes
   and the minimap; `doc.trafficRevision` gates lanelets, crossings and the
   simulation topology; `terrainRevision` gates terrain and the roads on it;
   `buildings.revision` gates buildings;
   `utilityRevision` the poles, wires and the pedestrians' obstacles. An edit
   that moves the wrong one either rebuilds everything or nothing.
6. **`commitDraft` adopts its work network**, rebuilt after the draft's
   segments are added; adopting it before that hands back a stale network
   stamped current.
7. **`RoadSample`** (`elevation.roadAt`) feeds the road UV frame and the
   asphalt's `roadEdge` attribute; the asphalt shader (`materials.ts`,
   `ROAD_SPACE_FRAGMENT`) assumes `uv.x * ASPHALT_TILE` is `across`.
8. **Street furniture** (`world/streetFurniture.ts`) is both what the renderer
   draws and what pedestrians walk round (`sim/peds/clearance.ts`).
9. **Junction legs are framed at the trim they are cut at** (`junction/legs.ts`,
   `build.ts`): a trim changed after framing (the slab bump) must re-frame.
10. **Signal stages come from the conflict matrix** (`signals/plan.ts` over
    `conflictPoints.ts`): a new conflict rule changes the phasing.
11. **Shadow bias is in world units over the fitted depth range**
    (`render/environment.ts` `fitDepth`); change the range and the bias follows.
12. **`SUN_AZIMUTH` against the camera's azimuth** decides whether shadows are
    visible at all (section 10).
13. **The pedestrians' crossing-reservation index** (`crossingFsm.ts`) is built
    at the start of `stepPedestrians` and valid only inside it.
14. **`clock.tick` does not advance under test** (section 10): a cache keyed on
    it is stale in every spec.

## 10. Traps that have already caught someone

* **Winding.** World `y` is mirrored into three's `z`. That reflection flips
  handedness. `surfaceMesh.ts` measures the ring's signed area instead of
  assuming — an earlier version reversed the winding "because the axis is
  mirrored", the whole road network was back-face culled, and the roads simply
  were not there.
* **Ear clipping fans.** `earcut` on a long thin band produces triangles with
  1400-unit edges. Never feed it a long polygon; `splitToSpan` cuts first.
* **The sun's bearing decides whether shadows exist.** With the sun opposite the
  isometric camera every shadow falls behind its own caster and is invisible.
  See `SUN_AZIMUTH` in `src/render/environment.ts`.
* **`shadowMap.enabled` is a tier setting.** If shadows "stop working", check
  whether the quality governor dropped to `low`.
* **Terrain height has two meanings.** `heightAt` is the analytic field;
  `renderedHeightAt` is what the triangles actually draw. Anything laid on the
  ground must clear the second one.
* **Textures are baked once.** `materials.ts` and `textureBaker.ts` cache by key.
  Do not create a material inside a rebuild.
* **Repeated scene parts are instanced, never one object each.** Signal heads
  were a dozen meshes per head and cost over a thousand draw calls a frame
  (every mesh is drawn again for the shadow map and the occlusion pass); they
  are nine instanced batches for the whole map now (`render/signals.ts`). A
  material shared by instanced meshes must see every one of them with the same
  program variant - all with instance colours or none, never also a plain mesh,
  and a transparent DoubleSide material needs `forceSinglePass` - or three
  re-evaluates its program on every draw.
* **A vertex colour attribute does nothing unless the material asks for it.**
  The mesh builder always writes `color`, and the per-class road tint was
  written into it for a whole revision while every road still came out the same
  near-black, because no material set `vertexColors: true`. If a per-vertex
  tint "has no effect", check the material before the maths.
* **A heightfield cannot have a hole in it.** A tunnel mouth is therefore a
  STEP in the terrain plus a portal wall built to cover it, not an opening. The
  constants that place it (`TUNNEL_ROOF`, `TUNNEL_BORE`, `TUNNEL_PORTAL_COVER`,
  `CUT_SHOULDER`) have to stay consistent with one another; widening the fade
  between roof and bore buries the road in a thin skin of earth instead of
  opening a mouth.
* **Terrain shaping must clear the lowest road band, not the deck.** The ground
  beside a road is pulled to `deck - SHAPE_DROP`, and `SHAPE_DROP` has to absorb
  the difference between the blended field the mesh reads and the single nearest
  profile the shaper answers for, plus the terrain grid's own interpolation. At
  the clearance value it looked right and put road vertices under the ground on
  a flat crossroads; `npm run verify:visual` counts them.
* **A road at grade is a DESIGNED line, not the ground.** `solveGround` smooths
  the balanced ground over `SMOOTH_REACH` and limits the gradient in both
  directions; the terrain is then cut and filled to meet it. If you make a
  profile follow the ground more closely, you are undoing the fix for "the roads
  are not level", and the two-sided `slopeLimit` is not interchangeable with the
  raise-only `gradeEnvelope`.
* **A junction's height comes from its legs' grade lines at the plate edge**, and
  only from legs actually built at grade. Reading the ground instead perches
  every crossroads on the tallest hummock near it; letting a viaduct vote lifts
  the junction to the ramp and leaves the street with a step.
* **`clock.tick` and `clock.time` do not advance under test.** They move only
  inside `SimClock.advance` and `SimClock.run`, and every test here drives
  `step` from the pipeline directly. Behaviour keyed on the clock is behaviour
  that silently never happens in the suite — which is how the lane-change
  cooldown came to block every overtake. Use the agent's own `age`.
* **`archetype` is the machine; `driver` is the person.** Size, mass and palette
  read the archetype. Acceleration, braking, headway, gap acceptance, patience
  read the driver. And `driver.bEmergency` is deliberately almost constant: the
  safe-speed cap sizes every following distance from it.
* **Every dab of the terrain brush re-solves the whole road network.** That is
  why painting is rate-limited by what the last rebuild actually cost
  (`terrainPaintInterval` in `src/main.ts`) rather than by a fixed interval.
* **A conflict is two bodies, not two lines.** `world/conflictPoints.ts` sweeps
  the drawn body rectangle of three size classes along every movement; a zone
  is where two swept areas overlap, and a claim is held until the body centre
  is past the zone exit. The centreline version missed opposing left turns,
  a bus swinging over the turn beside it, and released claims while the body
  was still across the other lane. If you change the vehicle pose in
  `sim/pose.ts`, the sweep in `conflictPoints.ts` must change with it, and
  `tests/sim/collisions.spec.ts` is what will tell you.
* **A pedestrian faces where they are GOING, not where the body moved.**
  `settlePose` steers the heading through `turnV` towards the path tangent
  (leaning a little into a sidestep), and holds it while standing. It used to
  face each tick's drawn displacement: every step aside swung the whole body
  and back (the zigzag), and a millimetre shuffle turned a standing person
  round on motionless legs. The renderer reads `turnV` to step the feet round.
* **Pedestrian clips are Rocketbox captures, transferred, not retargeted.**
  `scripts/extract-rocketbox-clips.mjs` writes `src/render/motion/rocketbox*.json`
  as world rotations relative to the walk avatar's bind pose — measured equal
  to the user's walk package to 0.6°. The Quaternius clips the citizen GLBs
  used to carry were what hunched them; nothing played them, and
  `scripts/strip-citizen-animations.mjs` removed them (47% of the download).
  `tests/render/citizenAssets.spec.ts` fails if a clip comes back.
* **A signal stage never holds two movements whose cars could meet.**
  `signals/plan.ts` groups approaches from the conflict matrix, so a crossroads
  of two-way streets runs one approach at a time. Pairing opposing approaches
  again (for capacity) brings back the permissive left turn players reported
  as a fault; `tests/sim/fourWay.spec.ts` will fail.
* **A seated person must fit the seat's room.** Car-seat poses are IK poses
  sized by `seatFitScale` against measured extents; the chair clips the citizen
  GLBs used to carry put heads through roofs. If you change a body profile or a pose,
  rerun `scripts/measure-seated-poses.mjs` (against `npm run dev`) and `occupantFit.spec.ts`.
* **A lane change occupies two lanes.** The transfer moves the occupancy index
  at once; the body slides across over the next second. `Vehicle.shadow`
  keeps it in the old lane until a heavy vehicle could pass beside it, and
  `SimWorld.bodiesIn` is the list anything asking "is this lane clear here"
  must read — not `rt(id).order`, which misses shadows and the tails of
  vehicles whose front has already entered the junction.
* **A building edit moves `doc.buildings.revision`, never `doc.revision`.**
  Bumping the document revision for a storey rebuilds the whole road network,
  the lanelets and the simulation. Buildings have their own gate in the
  renderer (`render/buildings/layer.ts`), which also caches each building's
  meshes, so an edit re-emits one building. The other way round, a ROAD edit
  demolishes any building it now overlaps (`clearBuildingsOnRoads`, called
  from `mutateBuilt`), in the same undo step - see docs/buildings.md.
