# Building editor interaction plan

## Evidence and decision

The current 1280 × 800 browser pass shows a 338 px right panel with a four-step rail, a large paragraph, and many text buttons. The building remains editable in the scene, but the controls needed to edit a selected face or roof sit in a long scrolling panel. The result hides the connection between the selected geometry and the command that changes it. The mobile layout has even less scene area.

The replacement is a **stable contextual dock at the bottom**, direct handles on the building, and a small optional properties inspector. The left rail remains the global game-mode switch. The dock changes with the current selection; it never repeats every building command at once. A toolbar floating over the building was considered and rejected because it would cover the geometry and move as the camera pans.

This combines selection-adaptive commands and gizmos from [Shapr3D](https://support.shapr3d.com/hc/en-us/articles/7873882619548-Adaptive-user-interface), drawing/extruding directly with exact values from [SketchUp](https://help.sketchup.com/en/sketchup/drawing-basic-shapes) and [its Measurements box](https://help.sketchup.com/cs/using-measurements-box), and the separation of a bottom tool bar, canvas, and right properties panel documented by [Figma](https://help.figma.com/hc/en-us/articles/360039832014). Tiny Glade's [shape-derived detail](https://store.steampowered.com/app/2198150/Tiny_Glade/) supports generating a useful facade and roof before manual edits. Because icons alone are hard to learn, the primary dock uses **one visible word per tool**, not paragraphs or text-button grids, following [NN/g's icon usability guidance](https://www.nngroup.com/articles/icon-usability/).

## Interaction contract

| Scene selection | Bottom dock: primary tools | Context row | In-scene gesture | Optional inspector |
|---|---|---|---|---|
| Nothing | Draw, quick shapes, saved model | Visual thumbnails for house, block, tower, courtyard | Click/drag on terrain to place or trace; Enter finishes a polygon | Hidden |
| Whole building or mass | Plan, Volume, Facade, Roof, Paint | Only the active tool's 3–5 relevant choices | Drag corner/edge/roof handles to reshape, extend, or raise; move from the centre handle | Exact width, depth, storeys; advanced folded |
| Wall face or bay | Facade and Paint become primary | Visual facade patterns, opening types or material swatches, with selection shown | Click the face/bay, then one swatch; drag face handles for depth or opening rhythm | Selected face/floor and exact bay dimensions |
| Roof | Roof and Paint become primary | Visual roof forms and a short detail strip | Drag roof handle for height/pitch; click roof to place the armed detail | Exact pitch/height; advanced folded |
| Active polygon drawing | Finish, Back, Cancel | Point count and current dimensions | Click terrain or roof for the next point; double-click/Enter finishes | Hidden |

The dock stays at the same screen position, above the status bar. It shows one primary row and at most one secondary row. Options that do not apply to the selected geometry are absent rather than disabled. The player can always pick another part of the building without returning to the panel. Desktop shortcuts and touch targets remain available; every icon has an accessible name and a visible short label in the primary row.

## Implementation sequence

1. Extract a single selection-to-command model from `BuildingTool` (`none`, `mass`, `face`, `bay`, `roof`, `drawing`). Reuse the current editor commands and undo history. Stage changes and panel clicks must call the same command path.
2. Add a `buildingCommandDock` UI module and a bottom dock in `index.html`. The left game rail stays intact. Drive dock content from selection, current tool, preview validity and locale. Keep its location stable while camera and building move.
3. Extend `buildingOverlay` with clear hover/selected states and handles for mass, face and roof. Place a small measurement chip beside the active handle, and show invalid geometry at the attempted edit with a short reason.
4. Reduce `buildingCreatorPanel` to exact measurements and one collapsed advanced section for the selected object. Move facade patterns, materials, opening choices and roof choices into the dock's visual context row. Keep all existing advanced operations reachable.
5. Verify the same operations through mouse and touch: quick house; irregular multi-tier tower; closed courtyard; facade and roof style/color; move and rotate; save, load, undo and redo. Test at 1280 × 800 and 390 × 844; the dock must not cover selected handles or make the game horizontally scroll. Capture before/after screens and page errors.

## Acceptance gates

- A new player can place a house, pull its height, click a face, change its facade, click the roof, and change its form without opening advanced options.
- Selection visibly changes the dock within the next frame; the primary row does not jump in position. The canvas remains the focus.
- A selected handle reveals its dimension; dragging previews the result and commits one undo step. Invalid edits show why at the attempted geometry.
- All existing building operations remain reachable, including polygon editing, connected wings, distinct upper tiers, facade bays, roof details, materials, and legacy saves.
- Desktop and mobile browser passes show no clipping, hidden primary actions, accidental map edits behind the dock, or page errors. `npm run check` and `npm run verify:visual` remain final gates for the integrated release.
