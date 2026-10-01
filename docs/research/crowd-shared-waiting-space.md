# Shared bypasses and exclusive waiting places

Research checked again on 2026-10-01 before reintegrating both experiments.
The player explicitly changed acceptance: retain a clear net improvement with
all arrivals preserved, document smaller regressions and fix them next.

## Measured causes

1. A standing person was asked to clear an unchanged straight centreline by a
   full two-body width. A nearby place can instead work when the passer also
   steers around the new footprint. The old rule rejected that usable shared
   maneuver and could repeatedly request ineffective lateral targets.
2. Logical zebra queue indices were not unique physical places. In the crowd
   scenario, raw targets (24.2,17.475) and (24.2,15.85) both projected onto
   (24.5,15). Stopped people and incoming waiters were asked to occupy the same
   body-sized space. Earlier traces also captured the contact chain 18 -> 8 -> 14
   at 25.2667 seconds while 14's requested and native velocities were zero.

## Primary sources and comparison

- [Recast crowd source](https://github.com/recastnavigation/recastnavigation/blob/main/DetourCrowd/Source/DetourCrowd.cpp):
  neighbor velocity planning and penetration correction do not reserve destinations.
  A zero desired velocity does not make a body an immovable wall.
- [Firsthand Detour discussion, stationary agents](https://groups.google.com/g/recastnavigation/c/IHO0CMbO3b4):
  reciprocal avoidance expects cooperation from agents in the way. This explains
  why simply stopping an agent does not solve destination ownership or passage
  planning. It is corroboration, not a proof that a particular parameter works.
- [Epic Smart Objects runtime flow](https://dev.epicgames.com/documentation/en-us/unreal-engine/smart-objects-in-unreal-engine---overview):
  claim a slot before approach, keep it unavailable to others, and release it on
  completion or abort. Roadcraft adopts that ownership lifecycle for footprints,
  without adding Epic's activity system or changing the physical controller.
- [JuPedSim routing and waiting sets](https://www.jupedsim.org/stable/concepts/routing.html):
  waiting stages contain explicit ordered positions in walkable space. Its
  documented overflow behavior shares the last waiting location; we deliberately
  do not copy that behavior because it recreates this collision cause.
- [SUMO pedestrian striping model](https://sumo.dlr.de/docs/Simulation/Pedestrians.html#model_striping):
  lateral changes require free space in both the current and new stripes;
  oncoming-flow reservations can mitigate jams. Roadcraft checks the giver's
  approach and a possible bypass, not just an empty endpoint. SUMO's jam escape
  that ignores obstacles is rejected under the player's integrity rules.
- [Reynolds, GDC 1999 steering paper](https://www.red3d.com/cwr/steer/gdc99/):
  collision avoidance predicts both bodies' future motion, and local neighborhoods
  bound interaction. The shared maneuver checks both bodies' available space.
  We retain Detour movement instead of adding Reynolds-style position forces.
- [LaValle, Planning Algorithms, chapter 4](https://lavalle.pl/planning/ch4.pdf):
  configuration-space reasoning accounts for body extents along a path. We test
  a swept two-body clearance, including height overlap, rather than accepting an
  empty centre point whose approach crosses another standing body.
- [Menge primary paper](https://gamma.cs.unc.edu/Menge/files/mengeCDMain.pdf):
  separates goal selection, plan computation and local motion. Reservation and
  short approach feasibility belong above the unchanged local movement engine.

Searches covered stationary Detour agents, destination conflict, queue ownership,
pedestrian bottlenecks, shared passage and bounded local capacity. Sources were
opened beyond snippets. They support separation of intent/ownership from physical
avoidance, but do not imply that ownership alone eliminates every moving contact.

## Retained implementation

`standingPlace` tests at most five local radii and sixteen directions. A place
must leave a navmesh-valid bypass for the passer, respect closed crossings, and
have a clear approach and unclaimed destination. Detour still decides and applies
all movement. The existing moving-versus-moving recovery is preserved separately.

`waitSlot` owns canonical, non-overlapping waiting footprints until release. It
checks the route, height, crossing permissions and existing bodies, including a
departing body whose logical claim was released. Candidate lattice indices are
clipped to the existing six-metre crossing-request region before enumeration;
map extent cannot enlarge the search. Capacity failures retry at the existing
intent cadence; only genuinely shared capacity failure suppresses other waiters.

The previously rejected map-wide ring search is not restored. Twelve regression
tests cover scale, bounded retries, claim lifecycle, approach clearance, stacked
levels, crossing permissions and requester-specific failures. The combined full
battery and city are measured anew: individual experimental numbers are not
claimed to add together. See `docs/handoff/crowd-step-07.md` for actual results.

Known tradeoffs remain: a feasible bypass is not guaranteed to be the route
Detour immediately chooses; some waiters still take longer, and `gap-one` gains
13 backward samples. These remain visible test failures rather than relaxed
thresholds or reclassified success.
