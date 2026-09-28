# Building Creator redesign

## Goal and limits

Make a building by acting on the building and its site, not by filling a long
form. A player should be able to make a house, apartment block, tower on a
podium, shop, U-shaped school, shed or factory with the same few tools. The
result is an exterior construction system, not room-level BIM or structural
engineering. A building can combine several polygons and floor ranges;
curved edges are editable faceted arcs. An enclosed courtyard can be assembled
from adjacent masses. True curved parametric surfaces and arbitrary interior
holes are future extensions, not silent promises of this version.

## Evidence from the previous editor

The former inspector showed ten presets, five unrelated sliders and then a
large stack of volume, facade, material, roof and element controls. There was
no visible path from a first block to a complex building. Selecting a bay and
choosing scope required understanding the data model. Every volume had only
four sides. A model was painted by editing many unrelated bay values. At the
initial camera scale a placed house was only a few dozen pixels wide.

The first attempted revision added polygon outlines and a three-tab wrapper
around the old inspector. That expanded the possible footprint, but kept the
old command structure and exposed too many permanent handles. It is a useful
geometry prototype, not the final interaction model. Its runtime DOM
reparenting and cardinal `Side` casts must be removed.

## The player workflow: four verbs on the live terrain

**Sketch** draws a ground mass, an attached wing or a mass on the selected
roof. Click points in world space; the first point and Enter close the loop.
The ghost shows real walls and a roof from the third point onward. The cursor
snaps to the grid, existing vertices and nearby parallel edges; Shift
temporarily frees it. A small floating measure follows the new segment. The
side inspector shows the selected mass and a compact list of other masses,
but the canvas remains the main editor.

**Shape** keeps the side arrows visible on a selected ordinary mass, because
they are the quickest way to expand it. Vertices remain small. On a curved
mass with many edges, selecting one face shows its side arrow. Dragging a
vertex changes the footprint. Dragging an edge offsets it. Dragging
the roof changes the number of floors. A roof selection offers an inset mass
on top; Shift+edge drag creates a wing. A `Cut` subtool removes a polygon from
the side of a mass, making alcoves, L and U plans without rebuilding it. Every
gesture previews the actual derived mesh, validates on a draft and commits as
one undo step. Invalid drafts show the reason at the cursor.

The selected mass has a direct storey count and the building has a floor-height
field. Upper masses can inherit the outline or take a rectangle, octagon or
faceted circle; inset, width, depth and offsets are independent. A new shape
fits its support automatically, and its handles remain editable afterwards.
Several masses can share a level without intersecting, making flanking blocks
and asymmetrical setback towers possible.

**Facade** paints a *rule* before individual details: residential, storefront,
office curtain wall, industrial, arcade, open gallery, Art Deco ribs, a deeper
Deco crown or a glazed observation lantern. Apply it to the entire building,
a mass, a face, or one floor. The rule generates a useful bay rhythm and an
entrance. The player can then replace an individual bay with a door, window,
balcony or loading door by clicking directly on it. Colour and finish use the
same target. This avoids asking for scope before the player sees a face.
The panel names the picked floor. The selected bay or Shift-selected region can
also be recessed or projected by a precise depth, independently of the rule.

**Roof** chooses flat, terrace, gable, hip, shed or sawtooth and exposes only
the parameters relevant to that roof. On the roof surface the player can place
solar panels, skylights, vents, chimneys, water tanks and adjustable spires.
A spire can carry a flag. The panel also exposes ridge direction, shed slope
direction, roof finish and roof colour. Accessories move and
rotate with the building, participate in save/load, and have visible selection
and delete controls. A roof type and its accessories form part of a reusable
blueprint.

## Interface model

- A short floating tool rail next to the game toolbar: Sketch, Shape, Facade,
  Roof. The right inspector is contextual: at most one compact property group
  and one clear next action. Clicking a mass or face updates the inspector.
- At the start, offer `Draw freely` plus three recognizable starters: House,
  Apartment block and Factory. Six quick geometric shapes live in a collapsed
  optional group; they never suggest a limit on what can be drawn.
- Show a concise on-canvas hint, live dimensions and a green/red ghost. Hide
  unrelated simulation controls during construction, while keeping the global
  pause button. Frame a selected building in the visible terrain area beside
  the inspector, including narrow screens.
- Preserve keyboard and touch alternatives: Enter finishes, Escape cancels,
  Backspace removes the last point, R rotates a ghost, Ctrl+Z undoes a complete
  gesture; a second tap on the first point closes a touch outline. Buttons have
  labels and focused state. All text is in both runtime dictionaries.

## Model and dependency boundaries

`Building` remains serializable data owned by `world`. A `Volume` has a local
polygon (a rectangle when absent), a base level, storeys, roof specification,
facade rule, and optional face/bay overrides. Adjacent volumes may touch;
shared wall portions are not rendered. `world/buildings/footprints.ts` owns
polygon validity, area, intersection and support. Its face IDs are integers
0..n-1, distinct from the four cardinal directions used by stairs, ramps and
roof fall. `world/buildings/geometry.ts` derives facade bays and exposed roof
regions from those faces. `render/buildings/` triangulates the actual polygon
once behind the building revision gate. It does not infer model geometry from
the panel. `editor` owns the interaction state machine and all document writes;
`ui` renders the current tool and selection from state. No UI module moves or
reparents another UI module's DOM nodes. `buildingsWiring.ts` is the seam from
screen/world coordinates to the editor and renderer.

Older rectangular records load unchanged. New optional fields are validated,
clamped and serialized through one migration path. Facade metadata stays on
the same physical edge when vertices are inserted, removed or mirrored.

## Acceptance gates

1. Sketch a concave house on terrain, close it, edit a vertex, undo and redo.
2. Sketch an attached angled wing and a narrower mass on top of a podium;
   the derived walls, roof and support agree, including after save/load.
3. Cut a notch from a footprint and confirm the empty land neither draws nor
   collides as building; refuse self intersections and road encroachment.
4. Apply a factory facade to a mass, a shopfront to one face, then a door to
   one bay. All remain after vertex edits and save/load.
5. Switch each roof type on a concave mass; no flipped or non-finite mesh
   triangles. Place and remove a solar panel and vent on different roofs.
6. In the browser, a new player can complete Sketch -> Shape -> Facade -> Roof
   without reading documentation. Check current desktop and narrow layout,
   console errors and the game's normal visual harness.
7. Run the required project checks one heavy job at a time. Keep the parallel
   agent's checkout and preview untouched. The development preview is port
   5184 in the `codex/building-studio` worktree.

## Landmark exercise: Edifício Altino Arantes

The [official Farol Santander history](https://www.farolsantander.com.br/sp/sobre-o-farol)
states 35 storeys and 161.22 m. The
[Wikimedia elevation photograph](https://commons.wikimedia.org/wiki/File:Altino_Arantes_Building_(cropped).jpg)
shows a monumental pale facade, a long vertical shaft, several stepped
shoulders, a narrow glazed observation lantern and a flagpole. The composition
was built in the live game rather than injected as a fixed mesh: ground podium,
20-storey shaft, nine-storey upper block, two-storey crown, two-storey lantern,
two independent five-storey flanking blocks and an 11.7 m spire. The shaft's
top floor uses a recessed gallery; facade rules and finishes remain editable.
The result is saved in the local blueprint library as
`Banespa — composição editável`.

This exercise tests the editor's geometry and visual grammar. A photograph
alone does not supply measured floor plans or all four elevations, so it is not
a claim of a dimensionally surveyed replica. The browser artifact is a
reference-inspired building at the game's scale; a 1:1 reconstruction would
require measured drawings and a dedicated texture/ornament pass.
