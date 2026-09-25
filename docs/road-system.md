# The road system

**Files:** `src/world/roadTypes.ts`, `src/world/network.ts`,
`src/world/surfaces.ts`, `src/world/markings.ts`,
`src/render/roadSurfaces.ts`, `src/render/markings.ts`
**Tests:** `tests/world/surfaces.spec.ts`

## Classes

| index | id | carriageway | lanes | footway | median | speed | markings |
|---|---|---|---|---|---|---|---|
| 0 | `local` | 15 u | 2 | 4.5 u | — | 30 km/h | none |
| 1 | `urban` | 22 u | 2 | 5 u | — | 50 km/h | centre line |
| 2 | `avenue` | 34 u | 4 | 6 u | — | 60 km/h | lane lines |
| 3 | `boulevard` | 46 u | 4 | 7 u | 6 u | 60 km/h | lane lines |

A class carries a `nameKey` and a `subKey`, never a sentence: the model states
what the text is *about*, and `src/ui/labels.ts` renders it in whatever language
is showing.

`roadProfile(type, lanes, direction)` derives an overridden profile when the
player changes the lane count. A two-way road splits its lanes across directions
and keeps its median; a one-way road uses all of them and loses it. The
description becomes a parameterised key with the lane count attached.

## Surface levels

Four nested half-widths, strictly decreasing from the outside in — which is what
guarantees the level rings nest, and is asserted by a test:

```
   casing  ── verge, the grass shoulder
   sidewalk ── the footway
   curb    ── the kerb face
   asphalt ── the carriageway
```

## Ribbons

`Network.rebuild()` derives, per segment:

* `full` — the untrimmed centreline (a flattened Bézier if the road is curved);
* `centre[level]` — the centreline trimmed for that level's junction setback;
* `rings[level]` — the closed outline at that level;
* `dashOrigin` — an arc-length offset so dash phase survives a split.

And per node that needs one, a junction outline per level. See
[intersections.md](intersections.md).

## Bands

`surfaces.ts` unions all the ribbon and junction rings per level, then subtracts
each level from the one inside it:

```
verge       = casing   − sidewalk
footway     = sidewalk − curb
kerb        = curb     − asphalt
carriageway = asphalt
```

Four **non-overlapping** polygon sets. No polygon offsetting is needed anywhere,
because every level already has its own half-width and its own trim — one source
for every distance, and no second way to compute it. A test asserts that the four
bands partition the casing exactly.

## The cross-section on screen

`render/roadSurfaces.ts` gives each band a height offset from **one** deck value
and a skirt down to the band outside it:

```
              footway  +0.36 ─────┐
     kerb face ───────┐           │   (skirt down to the verge)
     asphalt  0.00 ───┘   paint +0.02 └── verge  −0.10
                                         │
                                         └─ skirt into the terrain
```

Because every offset comes from the same `RoadElevation.at`, two bands can never
disagree about where the road is — that was the defect behind steps and gaps
between a carriageway and its kerb.

For a raised structure the verge becomes the deck's own concrete edge, and the
soffit is the underside of the structure rather than the ground.

## Tessellation limits

| surface | longest edge |
|---|---|
| at grade | `TERRAIN_CELL / 2` = 8 units |
| raised | `TERRAIN_CELL` = 16 units |
| markings | 5 units |

These are **not** sized against the terrain's curvature. The deck reads a solved
profile whose every station has already been raised to clear the ground within a
window wider than the chord (see [elevation.md](elevation.md)), so the
tessellation only has to be fine enough to shade well.

## Markings

`world/markings.ts` produces the marking *geometry* — centre lines, lane lines,
stop bars, zebra crossings — as strokes and bars with a dash pattern and a
phase. The central reservation is **not** among them: it used to be two
overlapping strokes at the same height, which is two coplanar surfaces in the
depth buffer and the torn green scribble a player photographed down the middle
of every boulevard. A median is not paint, so it is built as a kerbed island
with its own height and its own skirt, in `render/roadSurfaces.ts`. `render/markings.ts` turns those into quads, unions them per
colour, clips them against the ribbons (so a crossing does not become a white
lattice over the junction interior), and builds one mesh per colour.

Paint is drawn with a **lit** material, not an unlit one. Unlit paint is the same
flat white in sunlight and in shadow, which is a giveaway that the scene is a
diagram; thermoplastic road paint is a rough, slightly raised surface, so it takes
the same light as the asphalt around it and darkens when a viaduct passes
overhead.

## Structures

| id | clearance above the ground it spans | deck thickness | piers | solver |
|---|---|---|---|---|
| `ground` | 0 | 0.55 | no | `solveGround` |
| `elevated` | 14 | 2.6 | yes | `solveRaised` |
| `bridge` | 7.5 | 2.4 | yes | `solveRaised` |
| `tunnel` | −`TUNNEL_DEPTH` | 0.6 | no | `solveSunken` |

Values as in `ROAD_STRUCTURES` (`src/world/structures.ts`), which is the
source of truth. `viaduct` was a fifth level players could not tell from
`elevated`; it was merged, and a map saved with one loads as elevated
(`migrateStructure`).

A structure is **not** a fixed world height. `elevated` used to mean "asphalt at
y = 18", which is only correct on flat ground: over a hill the terrain swallowed
the deck, and next to a valley the deck hung far higher than any viaduct would
be built. What a structure really states is how much room it keeps over the
ground it spans, and that is what is stored.

## Tunnels

Tunnels are drawn and driven. They were not, for a whole revision, because the
terrain could not be cut at the portals — the bore sat under the ground with its
portals anchored above it, so there was no honest geometry to draw and no honest
way to carry traffic either. `TUNNELS_DRAWN` gated both, on the rule that a
vehicle must never pass silently through something invisible.

What changed is that the ground now comes to meet the roads. The same cut-and-
fill rule that removed the walls beside a road (`shapeAt` in
`world/elevation.ts`) produces a tunnel with no code of its own: it fades its own
weight out as a road goes deeper, so the approach is an open cutting, the ground
closes over the arch, and the bore runs through intact hill.

The numbers are derived from one another in `world/structures.ts`, and they have
to stay consistent:

| constant | what it is |
|---|---|
| `TUNNEL_HEADROOM` | clear height inside the bore (11 units ≈ 4.4 m) |
| `TUNNEL_ARCH` | thickness of the arch over it |
| `TUNNEL_DEPTH` | how far the floor sits below the lowest ground on the span |
| `TUNNEL_ROOF` / `TUNNEL_BORE` | the cover over which the ground closes |
| `TUNNEL_PORTAL_COVER` | the cover at which the portal wall stands |
| `TUNNEL_GRADE` | design gradient of the approach ramps |
| `CUT_SHOULDER` | how wide the approach cutting's batter is |

Two of those are counter-intuitive and both were arrived at by looking at the
result:

* **`ROOF` and `BORE` are less than a unit apart.** A generous fade sounds
  gentler and gives the worst result: the ground comes down towards the road over
  a long stretch, so the road runs under a few units of earth with no opening at
  all and simply evaporates into a meadow. A heightfield cannot have a hole in
  it; what it can have is a **step**, and a portal wall is built to close a step.
* **`TUNNEL_PORTAL_COVER` is small** — the wall stands at the *foot* of the
  cutting, where the ground first rises over the road, not at the depth the bore
  closes. From a camera locked to a 48° diagonal you cannot see into a tunnel
  mouth, so a wall at the closing depth is buried in the hillside. At the foot it
  stands clear, and reads from above as a concrete face with a road going into it
  and a hill rising behind.

A tunnel too short to hold both its ramps at `TUNNEL_GRADE` has its floor raised
until they fit, exactly as a short viaduct has its deck lowered. It then never
reaches the cover at which the ground closes, so it is drawn as the open cutting
it is. That is the honest answer, and it is what the player sees when they draw a
tunnel that is too short: `tests/world/elevation.spec.ts` pins it.

## Junction control

Every node with three or more legs carries a `JunctionControl`: `auto`,
`signal`, `priority`, `stop`, `yield` or `none`. `auto` lets the simulation
choose from the road classes meeting there; the rest are the player's decision.

It is reachable two ways, deliberately. The inspector has a select, which names
the modes. The **Control** tool (`c`) cycles them with a click on the junction —
shift-click walks back — and while it is active every junction on the map draws
its current mode as a letter. A setting three clicks away behind a select nobody
opens is not the same thing as a decision you can take while looking at the
junction, which is what a player asking for signals to be *optional* was really
asking for.
