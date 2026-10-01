# Physical queue approaches and route-consistent yielding

Research and experiments, 2026-10-01, following step 07's accepted net gain.

## Evidence

In unchanged `gap-one`, at 7.067 seconds walker 6 is admitted while walker 4
still holds a place in its approach. At 7.4 seconds, 6's desired velocity points
west but its actual velocity points east: it backs away from the obstruction.
A strict FIFO alone fails: backward samples 13 -> 15, and obstacles 0 -> 11.
The follower's waiting target also advances when a logical row is released,
although another body still physically blocks that new place.

The retained admission checks the actual bounded path prefix to the entrance
against same-side standing waiters. Queue compaction separately checks the
approach to a candidate standing place. Opposing-flow priority and time limits
are untouched. This is physical approach feasibility, not a new global FIFO.

The standing-person bypass also optimized only the passer's route. At 32.98 s
in `obstacles`, walker 6 receives an aside behind its completed westbound trip.
The restored bypass planner now prefers feasible forward/side places in the
navigation trip frame (the leader's frame for companions), keeping the closest
feasible retreat as fallback only if the existing bounded candidate set has no
forward/side option. No visual heading participates in this new choice.
This reduces total reverse motion but does not remove all retreats: that eight-
sample obstacles episode remains, and larger forward maneuvers can take longer.

## Primary sources read

- [JuPedSim queue stages](https://www.jupedsim.org/stable/concepts/routing.html):
  release the first requested number of queued agents. It establishes explicit
  queue membership, but logical release alone does not prove physical approach
  capacity in our implementation. Its overflow sharing is not copied.
- [SUMO pedestrian model](https://sumo.dlr.de/docs/Simulation/Pedestrians.html#model_striping):
  update front walkers before followers and check space in both occupied stripes
  during a lateral change. Our analogous requirement is free approach space,
  without changing Detour's movement or adopting SUMO's obstacle-ignoring jam escape.
- [Menge paper, sections 3.6 and 4](https://gamma.cs.unc.edu/Menge/files/mengeCDMain.pdf):
  finite goal capacity is claimed by agents; the aircraft example conditions
  disembarkation on an empty aisle. This supports checking physical room before
  admitting another agent, above the local motion algorithm.
- [Epic Smart Object lifecycle](https://dev.epicgames.com/documentation/en-us/unreal-engine/smart-objects-in-unreal-engine---overview):
  claimed and occupied states are distinct; releasing a logical claim is not a
  physical relocation of its former occupant. This distinction motivated the guard.
- [Reynolds, GDC steering paper](https://www.red3d.com/cwr/steer/gdc99/):
  path following maintains a direction along the path; collision avoidance
  combines both actors' prospective movement. We preserve the navigation frame,
  rather than feeding rendered facing back into target selection.
- [Moussaid, Helbing and Theraulaz, primary paper](https://arxiv.org/pdf/1105.2152),
  model section: choose an unobstructed direction while limiting deviation from
  the desired destination direction, and adapt speed to available distance.
  Our preference for forward/side yielding is a design inference inspired by that
  principle, not a claim to implement or reproduce their complete model.
- [ORCA primary paper](https://gamma.cs.unc.edu/ORCA/publications/ORCA.pdf):
  choose a safe velocity close to the preferred velocity. Feasibility and
  preference are separate concerns; we preserve a retreat fallback instead of
  forbidding a feasible escape and creating an artificial deadlock.

Searches covered pedestrian FIFO/head-of-queue admission, narrow passages,
occupied approach capacity, preferred direction and stationary-agent yielding.
Official documents and paper bodies were read, not just search snippets. Three
additional source URLs failed to open and were not used as evidence.

## Alternatives and bounds

Strict FIFO alone was rejected. Checking queue-place approaches alone was
behavior-identical to step 07 because premature admission bypassed that check.
The combined physical checks fix `gap-one` but create eight reverse samples in
`obstacles`; route-consistent yielding provides the clear overall improvement.

A shorter-radius-only direction preference was also measured: 13/19 and all
arrivals, but 396 reverse samples and nine slides, versus 338 and six in the
retained version. It avoids the retained version's additional crowd delay.
The tradeoff is explicit in step 08; neither variant is claimed universally best.

Admission clips the existing path to the already-bounded entrance distance;
it performs no new path search. Waiting candidates use the unchanged bounded
six-metre scan. Yielding still tests at most the existing five radii and sixteen
directions. Heights and swept body clearances are checked; body movement,
test fixtures, durations, thresholds, radii and the Detour preset are unchanged.
