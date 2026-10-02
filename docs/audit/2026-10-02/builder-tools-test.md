# Building mode: every tool tried in the game (2026-10-02)

Played in the running game (`127.0.0.1:5173`, own storage), on a house placed
from the models, a free-plan building and a second house. Every tool of the
panel was used on the map, with the pointer, and the document was read after
each action. Pictures: `builder/`.

Legend: **works** - does what it says; **broken** - does nothing, or refuses;
**bad** - works but the player cannot find it, see it or trust it.

## Selecting

| What | Result |
|---|---|
| Open Buildings, click a house | **broken** - starts a free plan ("0 pontos"), does not select (01) |
| "Selecionar", click a house | **bad** - selects one window bay, never the building; the resize arrows disappear (12) |
| Selection panel and floating bar | **bad** - stay on screen in Road, Poles, Terrain (02); the floating bar sits on top of the Selection panel (07) |
| After creating a building | **bad** - the drawing tool stays armed: grabbing the floor arrow starts another plan (11) |

## Create - Draw

| What | Result |
|---|---|
| Shapes: rectangle, L, U, circle, hexagon, octagon, chamfered | works - drawn close together they fuse into one building (09); they come out as small flat boxes |
| Free plan (click corners) | works (10); the measure labels overlap |
| Models: 11 | all place on empty ground; Courtyard and Factory refused next to a building |
| Model next to / over a building | **broken** - the ghost is green, the click answers "Dois volumes ficariam sobrepostos", nothing is built (20). This is the "never merges, always red" defect |
| Pointing a model at a building | **broken** - the ghost disappears and the click selects the building instead of placing |
| Save model | works; the "x" beside a saved model does not delete it (no way to delete) |

## Create - Mass

| What | Result |
|---|---|
| Wing, Stack, Cut | **broken** - built nothing, ever: the dragged rectangle was cleared before it was read (`endShapeDrag`). **Fixed in this pass**; after the fix: |
| Wing | works when drawn beside the wall (03); drawn over the house: red "Dois volumes ficariam sobrepostos", stuck in Finish/Back/Cancel (04) |
| Stack | **broken** - the rectangle drawn on the roof is read at ground height and lands behind the building: always red "Um volume ficaria sem apoio" (05) |
| Cut | works (06) |
| Move volume | works, but leaves the block standing apart from the house as part of it (07) |
| + floor, - floor, Split, Setback | work (08); no message; the pitched roof becomes flat |
| Plan points: add / remove | work, nothing visible until the point is dragged |

## Create - Face

| What | Result |
|---|---|
| Push/Pull | **broken** - arms, but no arrow appears to push |
| Recess, Project, Flush | work, on one bay only |
| Patterns (9) | work; the pictures are near identical (13) |

## Insert

| What | Result |
|---|---|
| Windows (6), Doors (4), Balcony, Shopfront, Arcade, Wall | work on the clicked bay; a garage door is accepted on the second floor |
| Free opening | **broken** - only repeats "wall" |
| Stair, Ramp, Pillar, Wall, Slab | work |
| Canopy on a facade | **broken** - refused "Dois volumes ficariam sobrepostos" (14) |
| Runs: fence | works in the data; barely visible; while armed a red building ghost follows the pointer (15) |
| Roofs (6), pitch, ridge, slope side | work |
| Roof equipment (6) | flat roofs only, refused on a pitched roof with no message (16) |
| Trees, flowers, rocks, bench, planter | work, but join whichever building is selected, however far |
| Parking | refused next to a building |
| AC unit, Awning on a facade | **broken** - refused "overlap", the whole building turns red (17) |
| "Mais" | repeats the same 17 parts of the other tabs (18) |

## Appearance

| What | Result |
|---|---|
| Material, colour, style | work on the whole building (19); on the last placed part if one is still selected |
| Paint (click a face), Copy style | work |

## Handles, bar, numbers, view

| What | Result |
|---|---|
| Side arrows | work on a volume pick; absent on a face pick (the usual pick) |
| Floor arrow | works |
| Rotate | works; the handle sits away from the building |
| Move | works but undoes the rotation; the handle sits at the screen edge, under the status bar |
| Scale | **missing** - no handle exists |
| Duplicate, Demolish | work |
| Mirror | **broken** - "Dimensões fora dos limites" |
| Group | **broken** - "O contorno se cruza ou é pequeno demais" |
| Selection panel numbers | work (floors, heights, pitch, bays, window size) |
| Floor menu: duplicate, insert above | work; insert below does nothing |
| Snap, grid, hide others | work |
| View: top, turn left/right | work; frame the selection does nothing |
| Keys R, PageUp, PageDown, Ctrl+Z | work |

## Layout defects seen throughout

- The panel changes height whenever the hint changes length, so the buttons
  move under the pointer (a click meant for Wall placed a Canopy).
- Labels and handles pile on top of each other at the default zoom.
- The panel covers the left third of the map, where new buildings land.
