# City life: residents, interiors, trips (plan, 2026-10-02)

The player's order: The Sims inside SimCity. People live in the buildings,
which can all be seen inside, with the objects they use; they leave home,
walk or take their car to work, go in and work; the traffic on the streets is
theirs - no more endless traffic from the map's edges, for now. People must
walk properly, because the player will later walk and drive a resident through
the city. If the roads or the pedestrian system stand in the way, rebuild them.

## What the references do

* **SimCity (2013, GlassBox)** - every car and pedestrian is an agent going
  somewhere to do something; jams are the pattern of their trips. Each Sim has
  a home, a job, shops. ([PC Gamer](https://www.pcgamer.com/uk/simcity-inside-the-glassbox-engine))
* **Cities: Skylines** - citizens have a name, an age, a home and a workplace;
  they go to work, shop, visit parks; some own cars, some walk.
  ([dev diary 7](https://admin-forum.paradoxplaza.com/forum/developer-diary/cities-skylines-dev-diary-7-simulation.828492))
* **The Sims** - rooms with objects that answer needs (sleep, eat, sit, work),
  walls cut away to look inside.

## The model

* **Time of day.** A game clock (hours, days) driven by the sim clock: one sim
  second is one game minute at 1x, so a day lasts 24 minutes.
* **Places.** Every building's floors are divided into spaces (`deriveSpaces`):
  dwellings in residential use, offices, shops, workshops. A dwelling holds a
  household; a workplace offers jobs by floor area.
* **Residents.** Generated deterministically from the buildings (seeded by
  building and unit, so they are the same people every time the city loads);
  the people made in the Person Creator move into homes first. Each resident:
  home (building, unit), job (building) or none (child, retired), car or not,
  a daily plan (leave around 7-9, work 8 h, come home, sometimes go out).
* **Trips.** Departure -> walk from the door (or to the car parked at the
  kerb) -> walk to the destination door, or drive to the street in front of
  it and park -> go in. A resident inside a building is not an agent on the
  street: they are drawn inside when the building is seen inside.
* **Traffic is the residents'.** With residents in the city, the map's edges
  stop feeding endless cars and walkers; what moves is the commute.
* **Inside.** Spaces become rooms with furniture by kind (living room,
  bedroom, kitchen, bath; desks; shelves; lobby). Any building can be seen
  inside: the player turns "see inside" on and the buildings near the camera
  are drawn cut open at a chosen floor; furniture is instanced and built only
  for those buildings (cost bounded by what is on screen).
* **Walking.** The People engine is measured on the drawn body (`PedView`):
  sliding, backward steps, pops. What fails is rebuilt, not patched. Doors are
  real places on the walk mesh, so a resident walks out of a door, along the
  pavement, across at the crossings, into another door.
* **Player as a resident (later).** A resident can be taken over: third-person
  walking on the same walk mesh, driving a car in the traffic.

## Slices, each switched on in the game

1. Building mode leftovers: facade clock, preview of a basic shape before the
   click.
2. Clock and population: time of day on the top bar; residents and jobs
   counted from the buildings; Inspect a building lists who lives and works
   there.
3. Walking commuters from door to door; edge traffic off when residents live
   in the city.
4. Driving commuters: car from the home kerb to the street of the work place.
5. Inside: rooms, furniture, "see inside" for every building near the camera;
   residents drawn inside at home and at work.
6. Walking quality: measured, and the engine rebuilt where it fails.
7. Taking over a resident: walk and drive.
