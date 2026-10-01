# Crowd step 04: initialize the first visible moving pose

A newly created walker previously turned from a random facing even when it
already moved along its intended path. All 215 measured solo `walk <0.8 INTENT`
events happened before age one second and progressed along the desired velocity.
The first unpublished moving pose now reads Detour velocity and initializes both
orientation endpoints. Positions, previous positions, velocities and RNG draws
are unchanged. Previously published idle bodies and alighting people retain
smooth turning. Research: [initial orientation](../research/crowd-initial-orientation.md).

The unchanged 19-scenario battery improves 8/19 -> 9/19. Group backward ticks
6 -> 0; crowd 535 -> 522; total backward 1086 -> 1067. Other defect metrics do
not worsen. All arrivals, zero jumps/trespass and 103 slide ticks remain.

The 60-second player city has 335 people in both runs: backward 1176 -> 656;
slides 58, collision-correction ticks 1019, jumps 28, trespass 0, unexplained
standing 39.933 s and physical starvation 24.333 s remain unchanged. Pedestrian
step mean 3.899 -> 3.807 ms, p95 15.365 -> 14.966, overall maximum 38.457 ->
37.608 ms. Raw reports retain initialization and steady-window timings separately.
These remaining city defects are not fixed by this pose change.

Two regressions cover the first visible moving pose and a previously published
idle pose. TypeScript and changed-file ESLint pass. Independent review found
publication-order, interpolation and continuity hazards; the guards address them.
The pre-existing clearSpot/crossing-forward dependencies on visual facing remain
open. No claim of a complete separation of every navigation layer is made.

Photo: `../audit/2026-10-01/crowd-first-pose/group-start/group.jpg`, fixed camera,
eight frames from age 1/60 s through approximately 0.717 s. Inspected individually:
the group sets off with alternating walking poses; a companion turns into the
formation. This is not proof that every crowd defect has disappeared.

The photo script now resets scenario RNG streams to the battery seed, preserves
publication order for nonzero starts, renders each tick between captures and
saves frame states. Zero-time photographs explicitly publish their initial pose.

Rejected work was removed before this step: exclusive queue places reduced crowd
slides 102 -> 0, but increased city backward 1176 -> 1185 and queue slides 0 -> 1.
