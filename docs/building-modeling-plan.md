# Construction: the modelling toolset (plan, 2026-10-02)

The player's order: build ANY building with the tools - blocks that snap
together like bricks, everything editable afterwards, nothing destructive,
boolean operations, pulling points like a mesh, extrude, inset, bevel,
offset, and selecting a whole floor, a row or a column of windows, doors.

## What the references do

* **SketchUp** - Push/Pull a face (extrude or cut back), Offset, Follow Me,
  Move/Rotate/Scale, inference snapping (endpoints, edges, midpoints, axes),
  solid tools Union / Subtract / Intersect / Trim / Split.
  ([toolbar](https://help.sketchup.com/en/sketchup-web/sketchup-web-expanded-toolbar))
* **Blender** - select by vertex / edge / face; Extrude Region / Along
  Normals, Inset Faces, Bevel, Loop Cut, Knife; booleans as modifiers, so the
  cutter stays an object. ([edit-mode toolbar](https://docs.blender.org/manual/en/2.82/modeling/meshes/toolbar/index.html))
* **The Sims** - pieces that snap (walls, columns, platforms), roof edit points,
  hand tool to move anything. ([building basics](https://www.carls-sims-4-guide.com/tutorials/building/houses.php))

## Our model, and what it can be

A building is **blocks**. A block is a prism: a plan polygon (up to 64
corners) standing from a floor level for a number of storeys, with a roof,
facades and materials of its own. Blocks never change one another: overlap is
union, and a block can be a **subtract**, **intersect** or **exclude** block,
resolved only when drawn (`world/buildings/blocks.ts`). That is Blender's
boolean modifier and SketchUp's solid tools, kept non-destructive.

Pulling points "like a mesh" therefore means editing the prism: its plan
corners (vertices), plan sides (edges = wall faces), top (height) and its
place. Free 3D sculpting of single vertices up and down is outside a model of
storeys and is not offered; slopes come from roofs (shed, gable, hip,
pyramid, cone) and from stacking.

## The toolset

| Selection | Pick | Tools |
|---|---|---|
| Building | 1st click | move, turn, scale, copy, mirror, join (weld), detach, delete |
| Block | 1st click on a block | drag to move (snaps to the other blocks' sides, corners and centres), turn, scale, width/depth/position/start floor typed, copy, centre, change shape, boolean mode, **offset** (grow/shrink the plan), **bevel** (chamfer every corner) |
| Face (wall) | 2nd click | **extrude +/-** (push/pull the whole face), **extrude as a new block** (Lego), **inset** (recess the face's bays inside a frame), relief of picked bays |
| Corner (vertex) | corner dots in point mode | drag, insert, delete, **bevel one corner** |
| Top | floor arrow | extrude up/down (storeys); setback = inset + extrude |
| Facade | Facade tab | apply a window/door/balcony to a bay, a **row** (a floor of one face), a **column** (a vertical line of bays), a **whole floor** (all faces) or a **whole face** |

Basic shapes to throw at a building: box, cylinder, octagon, prism (gable),
wedge (shed), pyramid, cone, cross - click one, click a roof or a wall: it
lands there as a block, snapped, and is edited like any other.

## Order of work

1. Point mode: corner dots on every block (boxes included), drag, insert,
   delete, bevel one corner.
2. Face: extrude +/- of the whole face; extrude as a new block; inset.
3. Block: offset and bevel typed.
4. Basic shapes dropped on roofs and walls.
5. Facade selection by bay / row / column / floor / face.
6. Snapping of dragged blocks to the others.
7. The Altino Arantes built with these tools, photographed.
8. Inside: a cut-away view by floor; the lobby on the ground floor, stair and
   lift cores placed and seen through every floor they serve (`Building.cores`),
   spaces per floor (`Storey.spaces`). People will walk in later: the cores and
   the lobby are the nodes their path will use (entrance -> lobby -> core ->
   floor), so they are stored as data, not drawn decoration.
