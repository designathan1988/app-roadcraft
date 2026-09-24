# Architecture

## The shape of the thing

Roadcraft is a pipeline that runs from one authored document to one rendered
frame, and back again every time the player touches anything.

```
                    ┌──────────────┐
   input ──────────▶│   RoadDoc    │  the only authored state
                    └──────┬───────┘
                           │ revision, terrainRevision
          ┌────────────────┼────────────────┐
          ▼                ▼                ▼
    ┌──────────┐    ┌─────────────┐   ┌──────────┐
    │ Network  │    │  SimWorld   │   │  Scene   │
    │ ribbons  │───▶│  vehicles   │   │  meshes  │
    │ junctions│    │  peds       │──▶│  lights  │
    │ trims    │    │  signals    │   │  camera  │
    └────┬─────┘    └─────────────┘   └────▲─────┘
         │                                 │
         └────────▶ RoadElevation ─────────┘
                    one height field
```

Everything below `RoadDoc` is **derived**. Nothing is stored twice, and nothing
is patched in place: when the document changes, the derived structures are
rebuilt from it. That is what makes "edit anything at any time" work, and it is
the reason the rebuild has to be fast rather than clever.

## The layers

### `src/core` — geometry with no opinions

`Vec2`, `Polyline`, `Ring`, `Aabb`, polygon offsetting, Bézier flattening, a
clipper wrapper and a seeded RNG. Nothing here knows what a road is. It is the
only layer with no dependencies at all.

`Polyline` is the workhorse: it caches its cumulative lengths and tangents, and
`sampleAt(s)` returns a frame (point, tangent, normal) at an arc position. Most
of the road geometry is expressed in those terms.

### `src/world` — the model

**`doc.ts`** holds the document: nodes, segments, terrain stamps, and the two
revision counters. It is plain data plus mutation methods, serialisable to JSON,
and it is what save/load and undo operate on.

**`network.ts`** derives, from the document, everything geometric that is not a
picture:

* a **ribbon** per segment — the trimmed centreline and the closed outline ring
  at each of the four surface levels;
* a **junction** per node that needs one — corner arcs, leg trims and mouth
  distances, solved by `world/junction/`;
* the **trims**, i.e. how far back each segment is cut at each end to make room
  for its junction. Those numbers are reused by the elevation solver, so the
  junction plate and the road legs agree by construction.

**`surfaces.ts`** unions the ribbons and junction rings into four nested
polygon sets, then subtracts each from the one outside it to get four
non-overlapping **bands**: verge, footway, kerb, carriageway.

**`elevation.ts`** solves one continuous height field for every road surface in
the network. It is the keystone of the whole renderer; see
[elevation.md](elevation.md).

**`terrain.ts`** is the land: procedural base relief plus the player's brush
stamps, sampled analytically.

**`lanelets.ts`** turns the network into the driveable graph the simulation
needs — lanes, connectors through junctions, and the conflict points between
them.

### `src/sim` — traffic

Deterministic, fixed-timestep, seeded. `pipeline.ts` runs one step:

1. rebuild topology if the network changed;
2. spawn and despawn at the boundary;
3. route;
4. signals;
5. junction admission (right of way, gap acceptance, spillback);
6. car-following and lane changes;
7. integrate;
8. pedestrians;
9. audit.

The parts worth knowing:

* **`vehicles/idm.ts`** — the intelligent-driver car-following model.
* **`vehicles/driver.ts`** — the person behind the wheel, as distinct from the
  vehicle. See below; it is the reason the traffic stopped looking like a
  machine.
* **`vehicles/laneChange.ts`** — two decisions, not one: the change the route
  needs, and the change the driver wants.
* **`intersections/admission.ts`** — the single place that decides whether a
  vehicle may enter a junction. Signals, priority roads, stop signs and
  uncontrolled junctions are the same code path with different verdicts.
  An uncontrolled junction ranks its legs by road class, because a node where
  every approach yields is a node nobody ever enters.
* **`signals/`** — the phase plan, its state machine, and the query used by both
  the simulation and the signal heads on screen.
* **`peds/behaviour.ts`** — the pedestrian's traits, parties and steering.
* **`peds/activities.ts`** — what pedestrians do in the street besides walking:
  sitting on the benches beside a footway, stopping at its side to look round or
  read a phone, standing to talk with their party. Decided once per footway
  walked, from a hash of the person, the footway and the trip.

#### The driver and the vehicle are different objects

Every sedan used to brake identically, accept the same gap and hold the same
headway, because the car-following parameters lived on the **archetype** and an
archetype is one object shared by every vehicle of that class. The only thing
that varied between two drivers was ±8% on the free-flow speed. That is why a
queue discharged like a goods train.

A vehicle now carries a `Driver`: its own `a`, `b`, `T` and `s0`, its own
critical-gap factor, politeness, lane-change threshold and patience. All of it
is derived from **one** number drawn at spawn, `aggression`, so a driver is
internally consistent — somebody who accelerates hard also follows closely,
accepts a tighter gap and is readier to pull out. Drawing each parameter
independently gives a population that is statistically varied and individually
incoherent, which reads as a bug rather than as a person.

Two rules hold this together and both are tested:

* **`archetype` is the machine, `driver` is the person.** Anything about size —
  length, width, the palette — reads the archetype. Anything about behaviour
  reads the driver. A van is a van whoever is driving it.
* **`bEmergency` barely varies.** The safe-speed cap sizes every following
  distance in the engine from it, so a driver who cannot brake as hard as the
  cap assumed can be driven into the car in front by arithmetic alone.

On top of that, the target speed wanders slowly per driver — a continuous sine
on the vehicle's own age, bounded well inside the limit. Nobody holds an exact
speed, and a fleet that does turns an open road into a conveyor belt.

Note **the vehicle's own age**, not the simulation clock: `clock.tick` and
`clock.time` only advance inside `SimClock.advance` and `SimClock.run`, and
every test in this repository drives `step` directly. Behaviour built on the
clock is behaviour that silently never happens under test — which is exactly how
the first version of the lane-change cooldown came to block every overtake, at
zero lane changes in three minutes.

#### Overtaking

`stepLaneChange` runs two different decisions.

A **mandatory** change is one the route needs, published once by `planFrom` as
`desiredLane`. It is deliberately not re-decided: an earlier version re-scored
lane costs every link and the whole fleet migrated into whichever lane had the
cheaper turn menu, so a standing queue emptied itself sideways instead of
discharging.

A **discretionary** change is MOBIL: change if my acceleration improves by more
than my own threshold, having weighted the drivers I inconvenience by my own
politeness, and never if the car behind me over there would have to brake harder
than a driver reasonably can. Three guards make it shippable — a refractory
period, a keep-to-the-kerb bias so the fleet drains outward instead of
accumulating in the fast lane, and no discretionary change on a junction
approach, because that is where mandatory changes need the room.

It costs about 2.7% of a simulation step (0.083 ms of 3.0 ms with 375 vehicles
and 300 pedestrians on a grid). The neighbour lookups are binary searches over
the lane's own sorted occupancy list, which is what keeps lane changing from
becoming quadratic in the length of a queue exactly when there is a queue.

Two more rules sit on top, both measured on the saved player map:

* **Signal, then move.** A change is first an INTENT (`laneIntent`): the
  indicator comes on, and the car moves only after `SIGNAL_LEAD` (1.4 s; 0.8 s
  for a mandatory change in a crawling queue) and only if the gap is still
  there. Before this, 16 of 196 changes had shown the indicator for a second
  beforehand; now more than three quarters do.
* **Never overtake out of the lane the route needs.** A discretionary change is
  refused into a lane with no connector to the street the route turns into
  next. The keep-to-the-kerb bias used to pull a car out of its turning lane
  and the route pulled it straight back. A driver with several lanes still to
  cross eases off until the changes fit (`positioningSpeedCap`) instead of
  arriving at speed and missing the turn.

#### Following distance and turning speed

* The queue-release response of `idmAccel` (a shorter headway while a queue
  starts off) only applies at a crawl now. It used to apply to every car
  following a moving leader, and the fleet cruised at a median of 0.6 s bumper
  to bumper; it is about 1.5 s now.
* The lateral acceleration a driver accepts FALLS with speed
  (`MAX_LATERAL_ACCEL`, `LATERAL_ACCEL_FALL`): about 4 m/s² turning a corner,
  about 2.6 m/s² at 55 km/h. The cap is applied from the middle of the body,
  so a car accelerates out of a bend as it straightens.
* Turn paths are as round as the kerbs allow (`world/turnPaths.ts`): each
  movement takes the widest cubic whose swept heavy body stays on the
  carriageway and never swings further over a waiting queue than the old
  shape did. Free right turns now run at 19 to 22 km/h and lefts at 27 to
  29 km/h on a crossroads of avenues, where they ran at 12 and 14.
* The drawn heading is a short chord along the path (`world/heading.ts`), not
  the tangent of one polyline piece, so a body sweeps round a corner instead of
  turning in steps; the conflict sweep and the turn-path check read the same
  chord. Worst yaw rate on the player map: 13.4 rad/s before, 1.6 after.

#### Signal stages never combine crossing movements

`signals/plan.ts` builds stages from the conflict matrix (swept car bodies):
an approach joins a stage only if none of its movements crosses, merges with or
sweeps into a movement of an approach already in it. On a crossroads of two-way
streets that is one approach per stage, because every approach has a left turn
across the opposite through; two one-way streets, or approaches whose left
turns are banned, still run together. Every green movement is therefore
protected, and the only thing a green vehicle yields to is a pedestrian on a
crossing it turns over. Players had watched a left turn cross the stream the
opposite light had released.

The cost is capacity. On a saturated 5×5 grid of streets and avenues, link
entries in 240 s fell from 3190 (paired stages with permissive lefts) to 2420.
A dedicated left-turn lane with its own arrow would recover much of it; the
approach is still one signal group.

#### Kerb stops: people get in and out

`vehicles/kerbStops.ts`. A car carries seat occupancy (`seats`, one bit per
seat in the body model's order) and sometimes an errand: drop a passenger off,
or pick up somebody walking alone. It chooses a place in the kerb lane at least
30 m from either end of the link with a footway beside it, stops there (an
ordinary obstacle, so the traffic behind follows or overtakes), waits until the
swing of the kerb-side door and the spot on the footway are clear of people,
opens the door, moves the person across, shuts it and pulls away. A dropped-off
passenger becomes a pedestrian with the id they had in the seat
(`seatPerson`), so the body drawn in the seat is the body that walks off; a
picked-up pedestrian keeps theirs.

#### Reconsidering a route

`routeCost` has always priced congestion, but the question was only asked at a
junction, when the route ran short. A driver who joins the back of a queue two
hundred units earlier has already committed and will sit there however long it
takes. `reconsiderRoute` lets a driver who has been crawling for longer than
their own patience re-plan from where they are, against the densities as they
are now — never abandoning a movement they have been admitted to, and resetting
the counter whether or not the answer changes, which is what stops a jammed
fleet re-planning every tick.

#### Pedestrians

`peds/crossingFsm.ts` owns the rules that keep people out of the carriageway —
the kerb wait, gap acceptance, the signal gate, the crossing occupancy — and
`peds/behaviour.ts` owns everything those rules do not decide: how fast someone
feels like walking this second, where across the footway they put themselves,
who they are walking with and where they are going. Nothing in `behaviour.ts` is
reachable from `mayEnterCrossing`, which is the point: the safety logic must not
be able to be loosened by a garnish.

* **Traits** come from a hash of the pedestrian's id, not from an RNG stream at
  use time. A value re-rolled each tick strobes; one cached in a map needs
  eviction that has to agree with despawn. A hash is stable for the agent's
  whole life for free.
* **Parties** of one to four share a pace and a destination, and a member paces
  itself to the companion behind it. They break up rather than stretch: past a
  bound the link is cut, because a party that can never give up on a member is a
  party that can be a block long.
* **Lateral position** is a target plus a rate limit — preferred file, a
  side-of-the-footway habit, a place in the party's line abreast, a step around
  somebody slower, and a shift towards the keep-side against oncoming traffic.
  The rate limit is what makes it a step sideways rather than a teleport.
* **Pace** varies within one person as well as between them: a slow wander, a
  rare deep dip that reads as stopping to look at something, a slow-down at a
  kerb or a corner, and urgency when a crossing's protected time is running out.

It also brought a per-edge occupancy index. `followSpeed` used to scan every
pedestrian in the world, once per pedestrian per tick; the index is why the
whole richer model costs 1.1 µs per pedestrian per tick against the 9.8 µs of
what it replaced.

The simulation reads the network and the document. It never reads the renderer,
and it never calls `Math.random`.

### `src/render` — three.js

The only layer allowed to import `three`. See [rendering.md](rendering.md).

Vehicles are built from their class's proportions in `vehicleModels.ts`: a side
profile with wheel arches extruded with a rounded bevel, doors on hinges with
their own glass, a glazed greenhouse, seats, a dashboard and a wheel; bus and
truck bodies the same way; motorcycles and bicycles with a steering assembly and
(bicycles) cranks. A car with its doors shut is two instances. People in and on
vehicles play inverse-kinematics poses baked on the citizens' own rig
(`riderPoses.ts`, drawn by `riggedCitizens.drawClip`): a reclined car seat sized
to each cabin (`seatFitScale`, against the worst of the roster measured in
`docs/audit/seated-pose-extents.json`), astride a motorcycle, pedalling a
bicycle in step with its cranks, a foot down when stopped, leaning into bends.

### `src/editor` — mutation

`commit.ts` turns a drawn gesture into document changes, including splitting any
road the new one crosses and merging endpoints that land on an existing node.
`snap.ts` decides what a pointer is over. `history.ts` is undo/redo over document
snapshots. `persistence.ts` is the autosave and the file import/export.

### `src/ui` — the DOM

Panels, the inspector, the minimap and the overlay canvas that draws the live
drafting preview in screen space. Also `i18n/`, which is the only place a
player-facing string exists. See [i18n.md](i18n.md).

### `src/view` — the seam

`Viewport` is the contract between input handling and whatever is drawing: world
↔ screen, pan, zoom, rotate. `main.ts` talks to that interface, so the input code
does not know or care that an isometric orthographic rig is behind it.

## The revision gates

Two integers decide what gets rebuilt:

| counter | bumped by | invalidates |
|---|---|---|
| `doc.revision` | any node/segment change | `Network`, `SimWorld` topology, every road mesh |
| `doc.terrainRevision` | any brush stroke | the terrain mesh, **and every road mesh** |

A terrain edit invalidating the roads is not an over-approximation: a road at
grade *is* a function of the ground under it. Getting this wrong is how earlier
versions left roads floating over a hill the player had just raised.

## Units

One world unit is 0.4 m. A residential street is 15 units wide (6 m); a viaduct
keeps 10 units (4 m) of clearance over the ground it spans. The simulation works
in world units per second and converts only for display.
