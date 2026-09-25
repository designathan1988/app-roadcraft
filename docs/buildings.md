# Modular buildings

A building in Roadcraft is **data, not a mesh**. The player places a first
module, then pulls storeys up and down, grows wings, stacks setbacks, swaps
facade components and changes the roof; every one of those is an edit to a
small, serialisable record in the document, and the picture is re-derived from
it behind a revision gate, exactly as the roads are.

```
src/world/buildings/     the model: types, geometry, foundations, validation,
                         blueprints, picking, (de)serialisation   (pure, deterministic)
src/editor/buildings.ts  the commands: place, pull, wing, setback, facade, roof,
                         move, rotate, copy, delete - every one validated
src/editor/buildingSnap.ts   snapping a footprint to roads, buildings and the grid
src/editor/buildingTool.ts   the tool's state machine (no DOM, world coordinates)
src/editor/blueprintLibrary.ts  the player's own saved blueprints (localStorage)
src/render/buildings/    the meshes: one merged shell, instanced components
src/ui/buildingPanel.ts  the palette: types, presets, parameters, component picker
src/ui/overlay/buildingOverlay.ts  handles, outlines, the validity label
src/buildingsWiring.ts   main.ts's building section: ToolView, ToolHost, palette, overlay
```

The layer order of AGENTS.md section 2 holds: the model knows nothing of the
editor, the editor nothing of three.js, and `main.ts` (through
`buildingsWiring.ts`) wires the tool to the pointer.

---

## 1. The data model

```
Building                      src/world/buildings/types.ts
 ├─ id, schema (=1)
 ├─ x, y, rotation            placement of the local frame (world units, radians)
 ├─ use                       residential | commercial | industrial | mixed
 ├─ module                    width of one bay / grid cell, world units
 ├─ groundHeight, storeyHeight  default height of level 0 and of every level above
 ├─ levels?: number[]         per-level height overrides, building-wide
 ├─ palette                   facade colour scheme index
 ├─ volumes: Volume[]         the massing
 │   ├─ id
 │   ├─ x, y, w, d            a rectangle of grid cells in the local frame
 │   ├─ base                  the level this volume starts on (0 = the ground)
 │   ├─ roof                  flat | terrace | gable | hip | shed | sawtooth
 │   └─ storeys: Storey[]     bottom to top; storey k occupies level base + k
 │       ├─ use?              overrides the building's use (mixed use)
 │       ├─ facade            { fill, sides?, bays? } - see below
 │       └─ spaces?: Space[]  extension point: units/rooms (empty today)
 ├─ cores: Core[]             extension point: stair / lift shafts
 ├─ nextVolumeId
 └─ name?, blueprint?
```

### Why a grid of modules

Every horizontal dimension is an integer number of **modules** (cells of
`module` world units). That is what makes the building *modular*: a facade is a
row of bays exactly one module wide, a wing is a whole number of bays, a
setback is inset by whole bays, and two volumes either share a wall exactly or
do not touch. It also makes every structural question - does this storey hang
over nothing, do two volumes intersect, is this bay an outside wall - an exact
integer test on cells instead of a floating-point polygon test.

### Levels, not per-storey heights

A **level** is a horizontal slice of the whole building. Level 0 is
`groundHeight` tall, every level above is `storeyHeight`, and `levels[i]`
overrides level `i` for the whole building. A storey of any volume at level
`L` spans exactly `[elevation(L), elevation(L + 1))`, so a podium and the tower
on it, or a wing and the block beside it, always line up floor for floor.

### Facades

A storey's facade resolves, bay by bay, as

```
bays["side:index"]  ??  sides[side]  ??  fill
```

`fill` is the storey's default component, `sides` overrides one whole face,
`bays` overrides single bays. Components (`BayComponent`):

| component | what it is |
|---|---|
| `wall` | a blank panel |
| `window` | a punched window with frame and sill |
| `wideWindow` | a full-bay glazed panel (offices) |
| `balcony` | a French window with a slab and a railing |
| `door` | an entrance door; on level 0 it is the building's access |
| `shopfront` | a glazed shop window with a fascia and an awning |
| `loadingDoor` | an industrial roller shutter |
| `pillar` | an open, recessed bay with a column in front (arcade / pilotis) |

Sides are numbered in the local frame: `0` front (local -y, the street side),
`1` right (+x), `2` back (+y), `3` left (-x). Bays run along +x on sides 0 and
2 and along +y on sides 1 and 3. When a volume grows on its negative side the
bay keys are re-indexed, so an override stays on the bay it was set on.

A bay is only drawn where it is an **outside** wall: if the cell beyond it at
the same level belongs to another volume, the two volumes share a wall and no
facade is built there.

### Extension points (documented, stored, not yet simulated)

* `Storey.spaces: Space[]` - units, shops, corridors: `{ id, x, y, w, d,
  kind, use }` in cells. Empty by default; `deriveSpaces()` in
  `world/buildings/spaces.ts` returns the default subdivision (one unit per
  volume per storey, split along the long axis every four modules for
  residential), which is what a future occupancy model reads.
* `Building.cores: Core[]` - `{ id, x, y, kind: 'stair' | 'lift' |
  'stairLift', from, to }`. The renderer already draws a core's overrun box on
  a flat roof, so a lift is visible; nothing moves in it yet.
* `foundationOf(building, groundAt).entrances` - derived from `door`, `shopfront` and
  `loadingDoor` bays on level 0: position, outward normal and the ground
  height in front. This is where pedestrians and deliveries will attach to the
  footway graph.
* Unknown fields on a storey or a building are **kept** by the serialiser, so a
  newer build's data survives a round trip through an older one.

### Serialisation and versions

`RoadDoc.toJSON()` writes `buildings: SerializedBuilding[]` only when there are
buildings, so every map saved before this feature, and every map without
buildings, has exactly the same JSON as before. `schema: 1` is written on each
building; `migrateBuilding()` in `world/buildings/serialize.ts` is the single
entry point that turns any stored shape into the current one, repairs what it
can (clamps sizes, drops unknown components, re-numbers volumes) and drops a
record it cannot read rather than refusing the whole map.

---

## 2. Derived geometry

`world/buildings/geometry.ts` answers every spatial question from the record:

* `localToWorld`, `worldToLocal`, `volumeCorners`, `footprintRects`
* `levelElevation(b, L)` - height of level `L` above the building's floor
* `occupancy(b)` - the set of `(cell, level)` pairs, for exposure and support
* `facadeBays(b)` - every exposed bay: volume, storey, level, side, index,
  component, world position, normal, width, height

`world/buildings/foundation.ts` reads the ground:

* the ground is sampled on a grid over the whole footprint (every cell corner
  and centre) through the `groundAt` function the caller passes - the renderer
  passes `terrain.renderedHeightAt`, **the height the triangles are drawn at**
  (AGENTS.md trap: terrain height has two meanings);
* the ground floor sits `PLINTH_MIN` above the **highest** sample, so the land
  never pokes through a floor;
* the plinth runs down to `PLINTH_BURY` below the **lowest** sample, so a
  building on a slope stands on a visible stone base instead of floating;
* an entrance reads what a person stands on in front of it: the **paving**
  (footway or carriageway, `pavedAt`, which the renderer answers from the
  solved road surfaces as `SceneHandle.pavedHeightAt`) where there is some,
  the land elsewhere. The terrain under and beside a footway is shaped well
  below the paving (`SHAPE_DROP`), so reading the land there sent flights
  down into a trench, across the footway and into the street;
* the ground floor is never below the paving an entrance opens onto;
* every entrance whose threshold is more than a step above that surface gets
  a flight of steps down to it, **and the flight never crosses paving**: it
  runs out in front of the facade only as far as the paving's edge
  (`pavingEdge`). Where there is no room - the usual case, a building snapped
  to the back of a footway - the flight is **set into the building**:
  `Entrance.recess` deep, the opening becomes a porch, the plinth is notched
  for it, and a threshold slab (`Entrance.threshold`) bridges the verge to
  the footway. A volume too shallow for the whole flight takes as many treads
  as fit;
* a site whose ground varies by more than `MAX_PLINTH` is refused
  (`problem: 'slope'`).

Every caller that needs the floor passes the same two functions - the tool
(`ToolView.groundAt` / `pavedAt`, for handles and picking), the renderer and
the tests - so the handles, the picking and the drawn building agree on it.

Because the foundation is recomputed on every rebuild, a building on terrain
that is later sculpted adapts by itself: its plinth grows or shrinks and its
steps follow.

---

## 3. Validation

`validateBuilding(ctx, building, ignore?)` in `world/buildings/validate.ts`
returns `null` or the first problem:

| problem | rule |
|---|---|
| `size` | every volume at least 1x1 cell, 1..`MAX_STOREYS` storeys, sane module/heights |
| `overlap` | two volumes of one building share a cell on a level |
| `support` | a cell of a volume above level 0 has nothing under it |
| `footprint` | no volume stands on the ground |
| `bounds` | a corner leaves the map (`world/bounds.ts`, with a margin) |
| `road` | a ground footprint reaches a road's footway, or a junction's footway plate (tunnels excepted) |
| `building` | a ground footprint overlaps another building (touching is allowed: terraces) |
| `slope` | the site is steeper than the plinth can take |

Every editor command applies its change to a **copy**, validates the copy and
only then writes it into the document. Nothing invalid is ever stored, and a
drag preview shows the same verdict the release will apply (the ghost is green
or red and the overlay names the problem).

### Roads drawn over buildings

**The road wins.** A road edit (draw, move a node, split, upgrade to a wider
class) that leaves a building overlapping a road demolishes that building in
the same edit, and the hint bar says how many went. It is one undo step with
the road, so Ctrl+Z restores both. This is the rule city builders use, and the
alternative - refusing the road - would make a building an obstacle the player
has to find and remove before they can draw.

Terrain edits never demolish: the foundation adapts (section 2). A building
whose site has since become steeper than `MAX_PLINTH` keeps standing on a tall
plinth; only a new placement or an edit is refused for slope.

---

## 4. Editor commands

`src/editor/buildings.ts`. Each takes a `BuildingContext { doc, net, groundAt }`
and returns `{ ok, problem?, id? }`. `main.ts` runs them through
`mutateBuildings`, which records the history snapshot **before** the change -
so every command is one undo step - bumps `doc.buildings.revision`, autosaves
and redraws. A building edit never moves `doc.revision`: the road network, the
lanelets and the simulation are not rebuilt for it.

| command | what it does |
|---|---|
| `placeBuilding` | a blueprint at a snapped position and rotation |
| `setStoreys` | pull a volume up or down; volumes stacked on it ride with it. A new storey copies the top one, in the building's own style (over a ground storey, `upperStoreyFrom` turns its doors and shopfronts into windows) |
| `resizeVolume` | move one side of a volume by whole modules |
| `addWing` | a new volume against one side, same base and height |
| `addSetback` | a new, inset volume on top; the one below gets a terrace roof |
| `removeVolume` | and anything that loses its support with it |
| `setRoof`, `setUse`, `setParameters`, `setLevelHeight` | parametric edits |
| `setBayComponent`, `setStoreyFill`, `setSideComponent` | facade components |
| `moveBuilding`, `rotateBuilding`, `duplicateBuilding`, `deleteBuilding` | |
| `clearBuildingsOnRoads` | the "road wins" rule above |

### The tool

`src/editor/buildingTool.ts` is a state machine in world coordinates. It does
not know the DOM or three.js; `main.ts` hands it a `ToolView` - project a 3D
point to the screen, turn a screen point into a world point on a plane at a
given height, cast a pick ray, read the rendered ground - and a `commit`
callback that is `mutateBuildings`.

* **Place** (`H`, then the neutral **Block** - shaped by the sliders - a
  ready-made model, or one of *My blueprints*). There are no fixed categories
  in the palette: a model is only a starting point, and every building is
  shaped from there. `Building.use` is still stored, for the simulation to
  read one day, but nothing in the tool sets or depends on it. The ghost
  follows the pointer,
  snapped (below), green when valid, red with the reason when not; click to
  build. `R` turns it a quarter, `Shift+R` 15 degrees. With the pointer
  over an existing building the ghost steps aside and a click selects that
  building instead. After a placement the tool switches to **Edit** on the new
  building, so the first module can be shaped at once.
* **Edit**: click a building to select it and the volume under the pointer.
  * the **arrow on the roof** - drag up or down to add or remove storeys (live
    preview, one storey per storey-height of screen travel);
  * the **arrows on the four sides** - drag out or in to grow or shrink the
    volume by modules; with **Shift** held the drag grows a new **wing**;
  * the **centre cross** - drag to move the building (snapped);
  * the **ring at a corner** - drag to rotate it (15 degree steps, Shift for free);
  * click a facade bay with a component chosen in the picker to replace it
    (scope: bay, storey, side or volume);
  * `PageUp`/`PageDown` or `+`/`-` storeys, `Delete` removes the volume
    (the building if it is the last one), `Ctrl+D` duplicates, `Ctrl+C` /
    `Ctrl+V` copy and paste at the pointer, `R` rotates, `Escape` deselects.

### Snapping

`src/editor/buildingSnap.ts`, in order of preference:

1. **Road**: within reach of a road, the footprint turns to face it and its
   front is laid along the back of the footway; along the road it snaps flush
   to a neighbour on the same frontage, otherwise to the module grid.
2. **Building**: near another building, the rotation is taken from it and the
   nearest edges are made flush (side by side or back to back).
3. **Grid**: otherwise the position snaps to the module grid in world axes.

---

## 5. Rendering

`src/render/buildings/`. Built in `renderer.ts` behind its own gate -
`doc.buildings.revision`, the terrain revision, the network revision and the
preview - never inside a draw call, as AGENTS.md section 4 requires. A building
edit rebuilds **only** the buildings layer; a road or terrain edit rebuilds it
because the ground under the foundations may have moved.

* `kit.ts` builds every component geometry and every material **once**
  (AGENTS.md: do not create a material inside a rebuild).
* `buildingMesh.ts`:
  * one **merged shell** for all buildings - plinth, walls, storey bands,
    cornices, roofs, parapets, steps - with vertex colours, so the whole city's
    massing is a single draw call;
  * **instanced** components: glass, frames, sills, doors, balcony slabs,
    railings, awnings, shutters, columns, roof cores - one `InstancedMesh` per
    part, shared by every building. None of these batches uses instance
    colours, so each material keeps one program variant (AGENTS.md trap).
* The placement / drag **preview** is the same builder run on the one preview
  building with translucent ghost materials, tinted by validity. While a
  building is being edited its solid copy is hidden and the preview stands in
  its place.
* Trees and shrubs whose trunks fall inside a building footprint are dropped by
  the scenery's instance cull (`Scenery.exclude`), so nothing grows through a
  roof - without re-solving the roads.

* The layer keeps each building's emitted geometry (`emitChunk`), keyed by its
  record and a fingerprint of the ground around it. An edit re-emits the one
  building it touched, a terrain dab only the buildings whose ground moved;
  the rest is concatenated from the cache.

A city of several hundred buildings is therefore ~10 draw calls for all of
them. Measured in the real game on the GPU with 400 buildings (about 5.3
million triangles): steady frames at 17 ms, and an edit's rebuild in about
115 ms (it was 450 ms before the per-building cache). A drag only rebuilds the
ghost; the stored layer is rebuilt once when the drag starts (to hide the
building being edited) and once when it ends.

---

## 6. Tests

* `tests/world/buildings.spec.ts` - geometry, exposure, occupancy, levels,
  foundations on slopes, validation (every problem), serialisation, migration
  and old maps without buildings.
* `tests/editor/buildings.spec.ts` - every command, undo/redo through
  `History`, road-over-building demolition, snapping, the tool's drags with a
  fake `ToolView`.

---

## 7. Adding to it

* **A new facade component**: add it to `BAY_COMPONENTS` in `types.ts`, give
  it parts in `render/buildings/kit.ts` and a case in `buildingMesh.ts`'s `openingOf` and `emitBay`, a button in the picker (`ui/buildingPanel.ts` builds them
  from the list) and `building.component.<name>` in both dictionaries.
* **A new roof**: `ROOF_KINDS` in `types.ts`, a case in `buildingMesh.ts`'s
  `emitRoof`, `building.roof.<name>` in both dictionaries.
* **A new preset**: `BLUEPRINTS` in `blueprints.ts` and `building.preset.<key>`
  in both dictionaries.
* **Interiors, lifts, occupants**: fill `Storey.spaces` and `Building.cores`;
  read `foundationOf(...).entrances` to connect a building to the footway graph. The model
  already stores and round-trips all three.
