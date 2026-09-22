# Intersections and connections

**Files:** `src/world/junction/`, `src/world/legAngles.ts`,
`src/world/surfaces.ts`, `src/world/elevation.ts`
**Tests:** `tests/world/surfaces.spec.ts`, `tests/world/elevation.spec.ts`

## The geometry

For every node that carries a junction, `world/junction/` solves:

* **leg order and half-widths** (`legs.ts`) — every incident road, sorted by
  bearing, with its half-width at each of the four surface levels;
* **corner radii and setbacks** (`corners.ts`) — the arc that joins two adjacent
  legs, and how far back each must be cut for that arc to exist. Two legs
  separated by a narrow angle need a large setback: any smaller value puts the
  mouth of one leg inside the carriageway of the other, which is how a shallow
  fan degenerates into a self-intersecting ring;
* **trims** (`trim.ts`) — the setbacks reconciled against the segment's own
  length. Both ends share the segment proportionally and always reserve
  `MIN_RIBBON` for the driveable link, because a link too short to hold a vehicle
  wedges the network;
* **the outline** (`polygon.ts`) — a closed ring per level, from the mouths and
  the corner arcs.

`Network.rebuild()` runs this as a solver: an unconstrained pass finds what each
junction wants, the segments reconcile both ends against their length and hand
back a scale factor, and the nodes under length pressure are re-solved with
scaled radii. A final clamp guarantees the invariant even where the second pass
did not converge.

## Impossible junctions

Below about 25° between two legs the junction cannot close. The editor refuses
to create one, but a map can arrive from a file, from `localStorage` or from an
undo into an older state — and **loading never refuses**, because refusing
destroys the player's work. Such nodes are reported instead: `Network.impossible`
carries the measured gap, the status bar counts them, and the inspector offers to
join the two legs or remove the node.

The mark is derived, never stored. A flag written into the document would have to
be kept in step with every move, split, delete and undo, and a stale mark is
worse than none.

## Which pass draws the junction

A junction's rings are built once, from **all** of the node's legs, whatever
structure each belongs to. So they cannot simply be drawn in every render pass
that has a leg there — that painted the same shape twice at two elevations, and
one road's markings cut across the other's deck. Nor can they be skipped in every
pass: a segment ending on another structure would keep its own closed end, and
its kerb and footway would close *across* the carriageway.

The rule is one line: **the junction belongs to the pass whose deck is at grade**
— the lowest structure at that node. A road on the ground keeps its mouth and its
markings; a raised deck arriving there comes down to it along its own ramp and
draws no junction of its own.

## Connecting levels

This is the part that used to break most visibly, and it is now a consequence of
the elevation solve rather than a special case.

* A node is **aloft** when every road meeting it is raised. Its height is the
  highest deck of those roads, and the chain runs over the junction.
* A node is a **landing** when at least one road meeting it is at grade.
  Everything meeting there takes the grade height.
* Every profile is held **flat over the junction's own reach** at that height.

So a ramp lands *exactly* on the junction plate it joins, and two raised spans
meeting in the air share one height. There is no separate "connection" code: the
connection is what you get when both sides read the same number.

Where a raised road merely **crosses** a road at grade without a node, nothing
special happens either — the two are different structural levels, each with its
own band set and its own height field, and the viaduct passes over.

## Piers and parapets

`render/structures.ts` places a pier every 58–108 units depending on the
structure, sized from the deck's own elevation so it always reaches the surface.
A pier is skipped when there is no room for one (the deck is on the ground here)
and when it would stand **on another road's carriageway** — that check uses a
spatial grid, because asking it by walking every segment is quadratic in the size
of the network and showed up as a rebuild stall.

Parapets run down both edges of a raised deck wherever it stands clear of the
ground. They do most of the work of making an elevated road read as a structure:
they give the deck a silhouette with thickness, and they catch the sun along
their top edge, which is the line the eye follows to read the road's height.
