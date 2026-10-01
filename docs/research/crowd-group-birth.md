# Non-overlapping group births

Research and measurement: 2026-10-01. The player explicitly authorized correcting
group placement in the city while preserving population and all 19 scenario
spawns. This authorization does not cover changes to test radii or thresholds.

## Question and trace

Why does the player city contain 28 drawn displacements above 3 m/s despite
ordinary walking speeds? All 28 occur in the first two simulation steps.
Immediately before the first Detour update, walker 51 and companion 54 are
0.082011 m apart. Their unchanged radius is 0.27 m each, requiring 0.54 m centre
separation. Walker 51 moves at an apparent 13.6345 m/s during the first step.
The same defect appears at 43/45 (0.254691 m) and 219/220 (0.234674 m).

`spawn` generated companion offsets before projecting them onto the navmesh.
Projection onto a narrow sidewalk edge collapsed those offsets onto the leader.
Detour's collision resolution then separated already-overlapping bodies. This
is not a path-filter teleport or an animation error.

## Sources read before implementation

Queries covered Detour collision correction, projected group placement, NavMesh
spawn jumps, bounded nearest-point queries, and pedestrian initial distributions.

1. [Recast DetourCrowd.cpp](https://github.com/recastnavigation/recastnavigation/blob/main/DetourCrowd/Source/DetourCrowd.cpp),
   `dtCrowd::update`, collision handling after integration: four penetration
   correction passes add displacement to `npos`. This explains our trace; changing
   visual interpolation would conceal the symptom rather than prevent overlap.
2. [JuPedSim distribution source](https://www.jupedsim.org/stable/_modules/jupedsim/distributions.html),
   `distribute_by_number`: validate point spacing and geometry before accepting
   a birth; attempts are bounded and insufficient capacity is reported explicitly.
   We use local deterministic candidates instead of sampling an entire polygon.
3. [Unity NavMesh.SamplePosition](https://docs.unity3d.com/ScriptReference/AI.NavMesh.SamplePosition.html):
   nearest-point projection does not check obstructions or guarantee the desired
   floor. Large query radii can hurt frame time; use repeated small queries.
4. [LaValle, Planning Algorithms, chapter 4](https://lavalle.pl/planning/ch4.pdf),
   section 4.3, configuration-space obstacles: a centre must account for both
   bodies' extents. For our discs, the excluded distance is the sum of radii.
5. [ORCA primary paper](https://gamma.cs.unc.edu/ORCA/publications/ORCA.pdf),
   sections 3-5: collision avoidance operates on observed positions, shapes and
   velocities; its collision-free velocity conditions are not a replacement for
   valid initial configurations. We do not replace Detour or import ORCA here.
6. [Godot NavigationAgents documentation](https://docs.godotengine.org/en/4.4/tutorials/navigation/navigation_using_navigationagents.html),
   avoidance section: body radius and height represent occupancy; navigation
   and avoidance occupy distinct models. A projected point alone does not prove
   safe placement relative to other agents.
7. [Firsthand report of spawning agents that jump](https://gamedev.stackexchange.com/questions/169512/spawning-large-numbers-of-navmeshagents-causes-them-to-jump-position):
   the reported symptom resembles ours, but its cause is not established. Its
   attempts to reduce radius or disable avoidance are not adopted. Our diagnosis
   comes from measured overlap and Detour source, not this anecdote.

These sources agree on checking occupied space before admission. They differ in
how they handle insufficient capacity: JuPedSim reports a failed distribution;
navigation sampling APIs merely return a point or failure. Roadcraft retries the
whole unpublished party within its existing bounded spawn attempts. It never
silently discards a child or leaves half a requested party because placement failed.

## Chosen mechanism and limits

Keep every original companion birth whose projected position is already clear.
For an overlapping birth, search at most 64 local alternatives (four rings,
16 directions). Use the existing intended group spacing, `BEHIND`, rather than
placing bodies merely tangent. Candidates must be on permitted footway, on the
leader's level, locally reachable on the navmesh, and clear of nearby bodies.
The search extent is `BEHIND + 4 * bodyDiameter`, independent of map extent.
Nearby bodies are collected once per search, not by a city-wide scan for each
candidate. No computePath or unbounded ring expansion occurs here.

If placement or final position projection fails, remove only the just-created,
unpublished party and retry through the existing population dispatch budget.
The demand is unchanged. The new regression test checks the full city demand,
every admitted party's planned membership, and actual projected body distances.
It also forces route-query failure to check whole-party rollback.

Rejected: retaining only minimum touching clearance. Although jumps disappeared,
later contact corrections rose from 1,019 to 2,581, including a prolonged
614/691 encounter. Restoring the already-intended group spacing avoids this
regression; it is not a change to body radius, avoidance settings or test limits.

Relocating companions can change whether a later random source position is
occupied. Consequently city identities are not promised byte-identical. Demand,
party completeness and the unchanged full scenario battery are checked instead.
The first attempted identity hash also incorrectly compared unpublished groups
with post-step photo state, where orphaned companions may already be detached;
it was replaced by the semantic admission checks above.
