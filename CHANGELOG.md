# Changelog

## This revision — full review, repair and overhaul

Everything below was found by reading the code, reproducing the defect in the
running application, fixing the cause, and pinning the fix with a test or a
measurement.

---

## 1. Mesh generation — the reported defects, and their causes

### The road surfaces were invisible

The mesh builder reversed its triangle winding "because world *y* is mirrored
into three's *z*". That reflection already flips handedness, so reversing it a
second time pointed every top face **downwards**. With front-face culling the
whole road network was back-face culled — while every diagnostic reported the
meshes present, with the right vertex counts, at the right heights. The previous
code hid this behind `DoubleSide` on every material.

Now the outer ring's signed area is **measured** and the winding derived from it.
Materials are front-side, which also halves the shadow cost.

### Holes, steps, cracks and overlapping plates over edited terrain

Root cause: the deck height was not a continuous function of position.

* the nearest segment's profile was used — which steps wherever the nearest
  segment changes, i.e. in the middle of every junction;
* `max(profile, terrain + clearance)` was evaluated per vertex, so a junction
  copied the terrain while its legs stayed flat;
* a raised deck took the *nearest span's* height, so two spans of one chain
  disagreed over the junction between them;
* the field simply stopped at the last road it could find — an **8.8-unit cliff**
  a few tens of units off the kerb.

Replaced by `src/world/elevation.ts`: one continuous height field solved for the
whole network at once, with flat junction plates whose reach comes from the
junction builder's own trims, globally solved node heights, grade-limited
profiles, and a smooth fade to the terrain at its edge. Every band, every
marking and every agent now reads the same number at the same point.

`groundDeck.ts` and `raisedDeck.ts` are gone.

### Roads cut into plates by the ground

Triangles were up to **three times larger than the stated limit**: the refinement
ran a fixed four rounds, which is not enough when the number required is
`log2(longest / limit)`. A 60-unit-wide strip refined to 8 came out at 26.4.

### Tessellation that could not finish

Ear clipping a long thin band emits a **fan**: measured on a road's 1400 × 1.5
verge, every one of the 352 triangles had an edge up to 1392 units long, and
refining that cost **1 026 232 triangles and 900 ms for one straight road**.

Fixed at the cause. The polygon is now cut into compact pieces by recursive
bisection before triangulation, and refinement bisects only the **longest** edge
so it doubles what is too big instead of quadrupling everything.

| | before | after |
|---|---|---|
| 1400 × 1.5 band | 1 026 232 tris, 900 ms | 2 624 tris, 34 ms |
| a city grid's four bands | ~1 000 000 tris, 2 708 ms | 92 856 tris, 393 ms |

### Cracks between triangulated pieces

Outlines are sampled at exactly the refinement limit, and refinement never splits
an edge that is not *strictly* over it — so two pieces sharing a cut keep
identical vertices along it.

### Interior walls inside the carriageway

Skirts are built from the original outlines, never from the split pieces. A cut
made for triangulation is an interior line; giving it a wall hung a sheet of kerb
down the middle of the road.

### Normals

`computeVertexNormals` averaged a kerb's vertical face into the footway above it
and rounded off every edge in the scene. Skirt normals are now written exactly
and only the up-facing vertices are smoothed.

### UVs

Planar world-axis UVs replaced by **road-local** ones — distance along the road
and offset across it — so asphalt grain runs along the carriageway and kerb
joints run along the kerb, whatever direction the road points.

---

## 2. Elevated roads, ramps, bridges and connections

* A structure is no longer a fixed world height. `elevated` meant "asphalt at
  y = 18", which the terrain swallowed over a hill and which hung absurdly high
  beside a valley. A structure now states the **clearance it keeps over the
  ground it spans**.
* Raised spans get a real vertical profile: flat deck, eased ramp at each end,
  sized so the stated gradient is the real one (a smoothstep's slope peaks at
  1.5× its mean, so a ramp sized as `rise / grade` actually climbs at
  `1.5 × grade`).
* Where a span is too short for two ramps, the **deck is lowered** until they
  fit. Steepening the ramp instead produced a 36% wall of asphalt.
* A node where every road is raised stays up; a node with even one road at grade
  is a landing and everything comes down to it. A ramp now lands exactly on the
  junction plate it joins, because both read the same node height.
* Piers are sized from the deck's own elevation, skipped where there is no room
  and where they would stand on another road's carriageway — that last check now
  uses a spatial grid instead of walking every segment (it was quadratic).
* Parapets added down both edges of a raised deck, which is what gives an
  elevated road a silhouette with thickness.

---

## 3. Graphics

### Lighting

The scene was lit from every direction at once — hemisphere 1.28, ambient 0.26,
sun nearly overhead. Measured on a hill fourteen units high and a hundred and
fifty across, the shading difference between its slope and the flat ground beside
it was **under two percent**.

Now: one dominant low warm key light (38° elevation) at roughly six times the
fill, a cool sky fill, real soft shadows with a view-fitted frustum, a gradient
sky dome that doubles as the environment map, and horizon-tinted fog.

**Shadows were invisible for a geometric reason, not a configuration one.** With
the sun on the opposite diagonal to the isometric camera, every shadow fell
towards the viewer and hid behind its own caster: turning shadows off changed the
image by 0.08 of a luminance level. The sun now sits clockwise of the camera's
bearing.

### Terrain

* Procedural base relief, so a new map is never a flat plane. Amplitudes set by
  measuring the resulting slope distribution, not by taste.
* A three-way splat material — grass, dirt, rock — blended by **slope in
  degrees**. The previous formulation used one minus the cosine, which is
  unreadable for small angles: a 10° hillside evaluated to 0.015, under a
  threshold meant to start at a gentle slope, so the map stayed one flat green
  however steep it got.
* Two texture scales mixed, to break the repeat at distance; macro colour
  variation; dryness with height and damp in the hollows; a slope-gated
  hillshade.
* The backdrop beyond the editable plate is a **frame**, not a plane. A plane
  drew straight over the terrain, the roads and everything on them wherever the
  ground dipped below it — which hid most of the network behind a grey sheet.

### Materials

Procedural colour, normal and roughness maps baked from one sweep per material,
cached by key. The previous code baked a fresh canvas **per band per structural
level on every rebuild**, which the player felt as a hitch while drawing.

Only the aggregate drives the asphalt relief; letting the wide wear patches into
the height map turned a smooth carriageway into a field of shallow craters.

### Post-processing

`EffectComposer` with ground-truth ambient occlusion, SMAA and filmic tone
mapping, all behind quality tiers. Ambient occlusion earns its place here
specifically: almost every contact in this scene is a flat surface meeting
another flat surface at a small height difference, which direct light cannot
describe at all.

### Models and detail

Better vehicles (tapered bodies, cabins, glass, bumpers, round wheels, unlit
lamps), two-part pedestrians, instanced vegetation that gives the eye something
of known height to judge a hillside by, gateways and lamp columns, piers with
caps, parapets.

Road markings are now drawn with a **lit** material. Unlit paint is the same flat
white in sunlight and in shadow, which is a giveaway that the scene is a diagram.

---

## 4. Performance

* Terrain: analytic field, a spatial index over the stamps (a full rewrite was
  over fifty million distance tests), and incremental rewrite of only the corners
  a new stamp can reach.
* Elevation: one solve for the whole network, queried through a spatial grid
  (the previous linear scan made rebuild quadratic in network size).
* Meshing: the two changes in §1, worth an order of magnitude.
* Tessellation limits no longer sized against the terrain's curvature — the
  elevation solver's dilation window covers the chord, so the mesh needs only
  enough vertices to shade well.
* Instancing for every repeated object, real bounding spheres on the static ones,
  zoom-gated detail, a fitted shadow frustum, shared materials.
* Signal heads are removed rather than hidden when their junction disappears;
  hiding them left hundreds of invisible objects in the scene graph.
* Four quality tiers in one table, with an automatic governor that has hysteresis
  and a cooldown on both sides.

---

## 5. Simulation

**An uncontrolled junction could deadlock permanently.** The authoring policy
"no control device" was mapped to a *yield* right of way, so every approach
waited for every other one: measured on a four-leg cross, four of nine vehicles
stopped, the leader carrying `yield` for ever. Nothing in the audit saw it,
because the audit only watches signals and there was no signal.

A real uncontrolled junction is not symmetric. It now falls through to the same
road-class ranking an automatic junction uses, which breaks the tie. Pinned by a
test.

---

## 6. Cleanup

Removed: the entire 2D canvas renderer and its painter, sprite cache and scene
paths; the superseded ground and raised deck modules; the dead geometry module; a
scenario that was not part of the game and its environment; an unused image
asset; a lifecycle/hook harness with no files to run; seven one-off probe scripts
and two report directories; the committed `dist/` and `playwright-report/`.

Restructured into a dependency order that reads in one direction:
`core → world → sim/render → editor → ui`. `render-three/` became `render/`;
shared geometry moved into `world/`; agent poses into `sim/`; the overlay canvas
into `ui/`.

---

## 7. Language

The whole project is in English — code, identifiers, file and folder names,
comments and documentation.

The **interface** is translated at runtime, in English and Brazilian Portuguese,
switchable from the top bar and defaulting to the browser's language. The model
stores translation keys rather than sentences, so the language can change without
touching the document, the network, the simulation or any saved map. A test fails
if the dictionaries drift apart, if placeholders differ, or if the markup names a
key that does not exist.

---

## 8. Tests and verification

From **zero tests** to 136, plus a browser-driven scene check.

* `npm run check` — lint, typecheck, tests with coverage thresholds, build.
* `npm run verify:visual` — boots the production bundle in a real browser, builds
  eight scenarios through the editor's own API, and fails on a non-finite vertex,
  on any road-surface vertex under the terrain, on nothing being built, or on any
  page error. It prints mesh, vertex and triangle counts either way.

The tests that matter most are properties rather than examples: the height field
is continuous (measured by halving the sampling step), the bands partition the
casing exactly, the mesh has no T-junction, the same seed gives the same
simulation.

---

## 9. Documentation

`README.md`, `AGENTS.md` — a map for the next AI or engineer: where every system
lives, what depends on what, the execution flow, the five invariants, how to add
each kind of feature, and the traps that have already caught someone — plus
`docs/` covering architecture, folder structure, terrain, the road system,
elevation, intersections, mesh generation, rendering, materials, lighting,
performance, i18n and testing.


---

# Second pass — the defects a player found in the delivered build

Everything in this section came from someone playing the game and saying what
was wrong with it. Each one is named as they reported it, then as it turned out
to be.

## "The central reservation of the boulevard has a broken mesh"

Two overlapping marking strokes at the same height — a wide kerb colour with a
narrower green inside it — which is two coplanar surfaces in the depth buffer.
The torn green scribble down the middle of every boulevard was z-fighting.

A median is not paint. It is built as a real kerbed island in
`render/roadSurfaces.ts` now, with its own height and its own skirt, clipped to
the carriageway so it cannot leak past the kerb line and unioned so two medians
meeting at a junction are one shape. `medianStrokes` is gone.

## "Remove the gantry at the end of the roads"

Gone. It was a piece of scenery nobody asked for, standing in the middle of open
country at every map-edge stub. A road that ends simply ends.

## "The road should follow the terrain smoothly and not create walls"

A road has to sit at one height across its full width, so where the ground falls
away there is a difference to absorb. It was being absorbed in the road's own
verge skirt, which draws a vertical face — the wall.

The ground now comes to meet the road: `shapeAt` in `world/elevation.ts` returns
a target height and an authority for any point of ground, and `shapeToRoads` in
`render/terrain.ts` blends the terrain towards it over a forty-five unit batter.
Embankments and cuttings instead of a wall. The restore-then-reshape structure
makes it a pure function of the current network rather than an accumulation over
every edit.

It also, from the same rule and with no code of its own, produces **tunnels**:
the shaping fades its own weight out where a road is buried deeply, so the
approach is an open cutting and the bore runs through intact hill.

One number in it was wrong for a whole revision. The ground was pulled to the
road's own clearance — three tenths of a unit below the surface — and three
things compound above that: the shaper answers for the nearest profile while the
road mesh reads the blended field, the terrain is a 16-unit grid that interpolates
between shaped corners, and the lowest road band is itself only a tenth of a unit
below the deck. The drawn ground ended up as much as **seven tenths of a unit
above the drawn verge**, which `npm run verify:visual` caught as twenty-one road
vertices under the terrain on a flat crossroads. `SHAPE_DROP` is 1.5 now, and the
verge skirt — which is sized from the terrain — simply grows to meet it.

## "The traffic signals have no green or amber light"

Three causes, none of them in the signal controller, which a test showed cycling
all three colours correctly.

* **Half the heads faced away from the camera.** A real signal aims its lenses
  at the traffic it controls; the camera here is locked to one isometric
  diagonal, so at any junction roughly half the heads showed the player a black
  box. Every head now carries a lens cluster on **both** faces, driven from one
  state — which is also what a real repeater head does.
* **An unlit lens was almost black** against an almost-black housing, so a head
  showed one glowing dot and nothing else. The other two colours were invisible
  rather than merely off. A real lens is a coloured filter over a dark can,
  legible across a junction with the lamp out, and that is what they are now.
* **The head was four pixels across** at the zoom the game is played at. Signal
  heads are drawn at 1.5 times life size — the only object in the scene that is —
  because the lamp is the single piece of information a player most needs from a
  junction.

The lit lens is unlit and un-tone-mapped with a dimmer halo behind it, so it
keeps its hue at full brightness where ACES would otherwise roll it towards
white. `verify:visual` now counts lamps and lit lamps on a scenario that runs the
simulation long enough for the controller to cycle.

## "Residential streets should be greyer, not black"

The per-class vertex tint was implemented, the mesh builder was writing the
`color` attribute, and `roadSurfaces.ts` was filling it with the right numbers.
No material had `vertexColors: true`, so every class came out the same
near-black. One flag. The class colour was also darkened slightly afterwards,
because at the full ratio a residential street read as concrete.

## "Signals should be optional at intersections — think about how"

They already were: the setting lived in the inspector, three clicks away behind a
select nobody opens. That is not the same thing as a decision you can take while
looking at the junction.

There is now a **Control** tool (`c`). Click a junction to cycle automatic →
signal → priority → stop → give way → uncontrolled; shift-click walks back. While
it is active, every junction on the map draws its current mode as a letter, so
choosing one no longer means clicking each node in turn to read it back. A node
with fewer than three legs says so rather than silently cycling a setting nothing
will read. The inspector's select stays — it names the modes, which a cycling
tool cannot.

## "It is impossible to connect elevated roads, the points do not snap"

The editor turned a screen position into a world position by casting against the
ground plane. A tilted view projects a raised surface *away* from the point under
it — a deck fifteen units up lands about thirteen units off — so pointing at the
end of an elevated road picked a spot thirteen units short of it, and no snap
candidate was ever within range.

`Viewport` gained `toWorldAt(px, py, height)`, and `main.ts` solves the fixed
point: cast at zero, ask what is at that position, cast again at that height,
three times. Every pointer path goes through it, and the 2D overlay projects at
the same height, so the draft line and the snap ring sit on the deck rather than
on the ground beneath it.

## "The terrain tool is very uncomfortable"

Five separate things, in the order they hurt:

* **Every dab re-solved the whole road network** and dabbing on every pointer
  sample queued rebuilds until the player let go. The rate limit now asks the
  last rebuild what it cost, exactly as the node-drag preview does.
* **Dabs were spaced at 0.28 of the radius**, which reads as a string of craters,
  and a fast drag skipped between pointer samples entirely — a river ran straight
  through the gap. Dabs are interpolated along the path at a fifth of the radius.
* **A held brush did nothing.** It reapplies itself while the button is down.
* **Size and strength were only on a slider** across the map. The wheel sizes the
  brush, shift-wheel sets the strength, `[`/`]` and `-`/`=` do the same from the
  keyboard, and the number row picks the operation.
* **Nothing said where the brush would land.** The ring shows the radius, a
  second ring the bite at the current strength, a crosshair, and the ground
  height — the target height while levelling.

And *flatten* became **level**. It used to scale the ground towards sea level, so
on a hillside it pulled a plateau down to the datum instead of making the ground
under the cursor level with itself. A stamp now carries an optional `level`, the
editor captures the height where the stroke starts and reuses it for the whole
stroke, and an absent target means sea level — which is algebraically the rule it
replaced, so every saved map loads unchanged.

The stamp cap was 512 and a river across the map is several hundred on its own:
the start of the player's own river was falling off the front of the list while
they were drawing the end of it. It is 4 096.

## "The river water is ugly"

It was a flat blue `MeshStandardMaterial` with a little metalness: a sheet of
plastic. `render/water.ts` extends a standard material through `onBeforeCompile`,
so it still takes the scene's lights, environment map, shadows and tone mapping,
and adds two scrolling normal layers, a depth tint driven by a new `aDepth`
vertex attribute, shore foam, and a fresnel term. Two texture fetches from one
sampler — the foam's noise rides in the normal map's alpha channel — and the
animation drives itself from the mesh's own `onBeforeRender`.

The depth attribute fixed a real defect as well as adding a look: with uniform
opacity the bank vanished under the water at the same rate everywhere, so a river
had no visible bed.

## "I do not know how to create tunnels"

Tunnels were authored and saved but drew nothing and carried no traffic, behind
`TUNNELS_DRAWN`, because the terrain could not be cut at the portals. Now that
the ground conforms to the roads, it can.

* `solveSunken` in `world/elevation.ts` — the mirror of the raised solver, with
  the ground envelope dropped and the gradient envelope reversed.
* The depth is measured against the **lowest** ground on the span, so the ramps
  can reach it; a span too short to hold them raises its floor until they fit and
  is drawn as the open cutting it then is.
* The portal stands at the **foot** of the cutting, not at the depth the bore
  closes: from a camera locked to a 48° diagonal you cannot see into a tunnel
  mouth, so a wall at the closing depth is buried in the hillside.
* The cover window over which the ground closes is deliberately narrow. A
  generous fade buries the road under a thin skin of earth with no opening at
  all — a heightfield cannot have a hole in it, only a step, and a portal wall is
  built to close a step.

Drawing one is a hint in the bar and a tooltip on the button: choose *Tunnel*,
drag through the hill, make it long enough.

## "Improve the cars and the people"

`sim/vehicles/archetypes.ts` now describes eight classes — hatchback, sedan, SUV,
van, bus, lorry, motorcycle, bicycle — each with real dimensions, its own driving
parameters, its own palette and the body plan the renderer builds from, so no
`if (id === 'truck')` survives in the render loop.

`render/agents.ts` was rewritten around twelve instanced meshes grouped by
geometry rather than by what the part depicts: a bumper, a wing mirror, a bus
door and a bicycle fork are all boxes of trim; an arm, a shin and a dog's tail
are all limbs. A thousand vehicles and a thousand pedestrians, each assembled
from a dozen parts, still cost twelve draw calls.

* Vehicles have a body and a greenhouse on glass, wheels with hubs, bumpers,
  mirrors, number plates, head and tail lamps; motorcycles and bicycles have
  riders; buses have a glazing band, doors and six wheels.
* **Occupants** are seated figures inside the cabin, and **windows down** is a
  side-glass instance that is simply not written. Both come from a hash of the
  vehicle's id, so neither flickers and neither costs storage.
* **Pedestrians** are figures with a head, hair, a torso, hips, arms, legs and
  shoes, varying in age, build, height, skin tone and dress — all from the same
  hash — and some of them walk a dog. Their gait comes from their arc position
  rather than from a clock, so a figure held at a kerb stands still and one that
  resumes picks its stride up where it left it.
* Three detail bands rather than two, so the cost falls away with the zoom.


---

## "The roads are not level on sloping ground"

A road at grade took the dilated terrain ceiling as its own profile. That is not
a road: it is the ground, copied. It rode over every hummock the brush left
behind, and because the lateral samples were reduced with a **maximum**, on any
side slope it perched on the high kerb and left the low one hanging.

A road at grade is now a designed vertical alignment — the *mean* ground across
the casing, averaged over ninety units, limited in gradient in **both**
directions — and the terrain is cut and filled to meet it. Four things had to
change together, and each one was found by the next one failing:

* **Two-sided slope limiting.** `gradeEnvelope` only ever raises, which is right
  for a profile that must clear the ground and wrong for one allowed to cut into
  it: raising to fix a descent undoes the cut.
* **The junction height comes from the roads, not from the ground.** It was the
  highest point anywhere inside the plate, which perched every crossroads on the
  tallest hummock near it and made all four legs climb to it. It is now the mean
  of the legs' own grade lines, read **at the plate edge** — the plate is a flat
  platform tens of units across, so the height that matters is the one its legs
  reach where it begins. Only roads actually built at grade get a vote.
* **The tie-in is sized from the correction it carries.** A fixed transition
  adds `1.5 × shift / reach` to the profile's own gradient, so a large
  correction over a short tie breaks the limit — and the limiter then flattens
  the approach and leaves the difference as a step against the plate, which is
  the defect this was meant to remove. Measured at 0.92 per unit before, 0.12
  after.
* **A ramp's ground floor is relaxed where it lands, and the ground under it is
  shaped.** A ramp coming down onto a mound insisted on staying above the mound,
  dragged the junction up with it, and left the street meeting it with eight
  units to climb in one terrain cell. Shaping is no longer "roads at grade only"
  but "whatever is on the ground", decided by how far the structure stands above
  it.

The batter is now sized from the earthwork it carries — a 1:2.5 slope — rather
than being a fixed 45 units, so a ten-unit cut and a one-unit fill come out at
the same believable angle instead of the first becoming a cliff.

`tests/world/elevation.spec.ts` states the new contract as properties: the road
cuts into what rises above it and fills over what falls away, the earthwork stays
bounded, and the designed line curves measurably less than the ground it crosses.


---

## "The traffic moves in straight, robotic lines"

The car-following model was a good one. Every instance of it was the same
instance.

`a`, `b`, `T` and `s0` lived on the **archetype**, and an archetype is one
object shared by every vehicle of its class, so every sedan braked identically,
held the same headway and accepted the same gap at a junction. The only thing
distinguishing two drivers was ±8% on the free-flow speed. A queue discharged
like a goods train; a platoon on an open road held station to the centimetre.

### The driver is now a different object from the vehicle

`src/sim/vehicles/driver.ts`. A vehicle carries its own `Driver`: acceleration,
braking, headway, standstill gap, critical-gap factor, politeness, lane-change
threshold, patience. All of it derived from **one** number drawn at spawn,
`aggression`, so a driver is internally consistent — somebody who accelerates
hard also follows closely, accepts a tighter gap and is readier to pull out.
Drawing each parameter independently gives a population that is statistically
varied and individually incoherent, which reads as a bug rather than as a
person. The draw is triangular, so most drivers are ordinary and the extremes
are rare; a flat draw makes one car in five a maniac.

Two rules hold it together, both tested:

* **`archetype` is the machine, `driver` is the person.** A van is a van whoever
  is driving it, so dimensions and palette stay on the archetype and only
  behaviour moves.
* **`bEmergency` barely varies** — 2.5%. The safe-speed cap sizes every
  following distance in the engine from it, so a driver who cannot brake as hard
  as the cap assumed can be driven into the car in front by arithmetic alone.

The target speed also wanders slowly per driver, a continuous sine bounded well
inside the limit. Nobody holds an exact speed, and a fleet that does turns an
open road into a conveyor belt.

### Overtaking

There was none. `stepLaneChange` executed the change the route asked for and
nothing else, so every vehicle inherited the speed of the slowest vehicle ahead
of it for the length of the block — which is why a bicycle on an avenue
gathered a silent procession of cars behind it.

Discretionary changes are MOBIL: change if my acceleration improves by more than
my own threshold, having weighted the drivers I inconvenience by my own
politeness, and never if the car behind me over there would have to brake harder
than a driver reasonably can. Three guards make it shippable — a refractory
period, a keep-to-the-kerb bias so the fleet drains outward instead of
accumulating in the fast lane, and no discretionary change on a junction
approach, where mandatory changes need the room.

Measured on a mixed fleet queued behind a bicycle on a four-lane avenue: **0
lane changes in three minutes before, 229 after**, worst case 6 per vehicle in
two minutes — nowhere near weaving. Lane occupancy comes out 195/205 across the
two lanes of a carriageway rather than accumulating inward. It costs 0.083 ms of
a 3.0 ms simulation step with 375 vehicles and 300 pedestrians; the neighbour
lookups are binary searches over the lane's own sorted occupancy list, which is
what keeps lane changing from becoming quadratic in the length of a queue
exactly when there is a queue.

### Two things the first version got wrong, and what they taught

* **The cooldown was keyed on `clock.tick`,** and `clock.tick` only advances
  inside `SimClock.advance` and `SimClock.run` — every test in this repository
  drives `step` from the pipeline directly. So the cooldown never elapsed, every
  overtake was refused, and the whole feature silently did nothing under test
  while type-checking and linting clean. It is keyed on the vehicle's own `age`
  now, and the trap is written down in `AGENTS.md`.
* **The "don't move into a dead end" guard used the router's cost,** which is a
  five-hop recursive search — a full route search per candidate lane per vehicle
  per tick — and on a road with no junction at either end it is infinite for
  *every* lane, so it refused every overtake on a straight road. It asks
  `exitsOf` now, which is the question it actually needed answered.

### Reconsidering a route

`routeCost` has always priced congestion, but the question was only asked at a
junction, when the route ran short. A driver who joins the back of a queue two
hundred units earlier has already committed and will sit there however long it
takes, which is what makes a jam look like a car park rather than like traffic.
A driver who has been crawling for longer than their own patience now re-plans
from where they are, against the densities as they are now — never abandoning a
movement they have been admitted to, and resetting the counter whether or not
the answer changes, so a jammed fleet cannot re-plan every tick.

### Pedestrians

`src/sim/peds/behaviour.ts`, kept deliberately separate from the crossing state
machine: that machine owns the rules that keep people out of the carriageway,
and nothing in the new file is reachable from them.

* **Parties** of one to four share a pace and a destination and pace themselves
  to the member behind. They break up rather than stretch — past a bound the
  link is cut, because a party that can never give up on a member is a party
  that can be a block long, and a member that can stop dead waiting for one is a
  jam with a stationary head.
* **Destinations** replace what was a uniform draw over adjacent edges — a
  random walk with no direction at any scale. A party now walks towards a goal
  node, by a greedy bounded choice rather than a pathfinder.
* **Lateral position** is a target plus a rate limit: preferred file, a
  side-of-the-footway habit, a place in the party's line abreast, a step around
  somebody slower, and a shift to the keep-side against oncoming walkers. Both
  walkers shift to the same hand, so the corrections add to a gap instead of
  cancelling.
* **Pace varies within one person**, not only between them: a slow wander, a
  rare deep dip that reads as stopping to look at something, a slow-down at a
  kerb or a corner, and urgency when a crossing's protected time is running out.

It also brought the per-edge occupancy index the model never had. `followSpeed`
used to scan every pedestrian in the world, once per pedestrian per tick. The
whole richer model now costs **1.1 µs per pedestrian per tick against 9.8 µs**
for what it replaced.

---

## "The connections are broken: sharp angles and elevated roads that float"

Two saved maps, both reproduced in the running application before anything was
changed.

### An elevated road with no support under it

The piers were never missing. The scene held seventeen of them, sixteen to
thirty-four units tall, correctly seated on the ground with their caps under a
deck solved eighteen units above the terrain. Not one of them could be seen,
and hiding the terrain entirely did not reveal them.

The cause is the camera, not the model. The view is locked at 48 degrees, so a
point `h` above the ground is drawn where the ground point `h / tan(48°)`, about
`0.9 h`, further from the camera would be. A fifteen-unit deck therefore slides
about thirteen units across the screen — less than an urban street's half-width
— and a column standing on the road's **centre line** ends up behind the very
deck it carries, at every height a viaduct is ever built at. Measured on the
reported map, a centreline column cleared the deck's silhouette by 0.5 units: a
sliver two pixels wide at full zoom.

Each span now carries a **two-column bent** — a column near each deck edge under
a crossbeam spanning them — instead of a single column on the centre line. On
the side facing the camera the column clears the deck by about twelve units and
the road reads as a structure standing on the ground. The far column is hidden
behind the deck, which is what it should be.

`src/render/structures.ts`. The columns are also dropped individually rather
than with the bent, so uneven ground under the two sides is handled, and one of
them landing on another road leaves that side out instead of leaving the span
unsupported.

### The outside of a bend ended in a spike, with no kerb on it

Every ring a junction builds runs **forward** from the node: the corner boundary
joins mouths that lie along the legs, and each leg's tongue is a rectangle from
the node out to its own mouth. Nothing covers the ground behind the node — which
is only empty when the legs surround it.

At a bend they do not. Measured on the reported hairpin, two legs leaving at 60
and 105 degrees: over the whole 315-degree outer side of the turn the junction
surface had **zero extent** at every bearing sampled. The two tongues met in a
point at the node, the asphalt, kerb and footway all stopped dead on a straight
cut, and the outside of the bend was a vertical face onto the grass with no kerb
anywhere on it.

A **node cap** now closes it: a disc of the level's own half-width, added only
when the legs leave a gap wider than 180 degrees. Its radius nests exactly like
every other ring — casing over footway over kerb over carriageway — so the bands
wrap the outside of the turn and its edge becomes an arc instead of a point. On
the same node the outer side now carries 10.5 units of carriageway and a
continuous 6.5-unit kerb-and-footway band at every bearing.

It is a full circle because the union decides how much of it shows: inside the
tongues it is invisible. A T-junction's back is straight at exactly 180 degrees
and is left untouched, and no crossroads has a gap over 180 at all — on the test
map only the five two-leg bends took a cap, and the five four-leg junctions
were unchanged.

`src/world/junction/polygon.ts`.
