# Crowd step 07: shared bypass and reserved waiting footprints

Both previously measured changes are now integrated on top of `6830ba5`.
The player explicitly requested accepting clear net gains with all arrivals
preserved, recording smaller regressions instead of discarding the entire gain.
The engine remains opt-in under `?people=crowd`.

## What changed

- A standing person can choose a small move that leaves a feasible bypass for
  the passer. It no longer has to vacate the passer's entire unchanged straight
  line. The new place and approach must respect bodies, navmesh and permissions.
- Zebra waiters own distinct physical footprints, not merely logical row indices
  which can project onto the same sidewalk edge. The search is clipped to the
  existing six-metre request region; the rejected map-sized search is not restored.

Detour remains the sole physical mover. No scenario, limit, geometry, body
radius, destination, duration, vehicle code or avoidance preset was changed.
Research: [shared waiting space](../research/crowd-shared-waiting-space.md).

## Full fixed battery

[New report](crowd-shared-wait.jsonl), compared with `crowd-first-pose.jsonl`,
which is also the exact pre-change report at `6830ba5`.

| Measurement | Before | After |
| --- | ---: | ---: |
| Passing scenarios | 9/19 | 12/19 |
| Arrivals | 161/161 | 161/161 |
| Backward displacement samples | 1,067 | 496 |
| Sliding samples | 103 | 7 |
| Reversals | 13 | 3 |
| Jumps / unauthorized road entry | 0 / 0 | 0 / 0 |
| Bottleneck backward samples | 98 | 0 |
| Crowd backward samples | 522 | 274 |
| Crowd slides | 102 | 6 |
| Dense opposing-flow longest stop, seconds | 28.8 | 1.4 |
| Dense opposing-flow last arrival, seconds | 81.2 | 70.1 |
| Crowd last arrival, seconds | 138.1 | 136.1 |

The isolated waiting-place experiment had zero crowd slides. The combined
changes have six; this note reports the combination actually integrated.

### Regressions retained under the player's new rule

- `gap-one`: backward 0 -> 13; final arrival 23.1 -> 31.5 seconds; longest stop
  0.1 -> 0.3 seconds; starvation 1.0 -> 1.4 seconds. All six arrive.
- `crowd`: longest stop 11.3 -> 14.4 seconds; starvation reported by
  the battery 18.1 -> 30.5 seconds. All forty arrive, with earlier final arrival.
- `queue`: longest stop 0.5 -> 0.9 seconds; all eight arrive at the same deadline.
- `bidirectional-10`: reversals 0 -> 1, longest stop 0.3 -> 0.7 seconds;
  backward samples and final arrival improve. All ten arrive.

These remain failures under the original limits. No threshold was relaxed.

## Full player city, 60 seconds

[City report](crowd-city-shared-wait.json), compared with step 06:

- Backward samples **540 -> 529**, contact-correction samples **818 -> 752**.
- Slides **1 -> 1**, jumps and unauthorized road entry **0 -> 0**.
- Longest still/unexplained stop **39.733 -> 39.733 seconds**;
  physical starvation **17.133 -> 17.133 seconds**.
- Final population **334 -> 334**. The earlier isolated experiment's +9 backward
  samples does not recur against the current integrated baseline.
- People-step mean **3.910 -> 4.625 ms**, p95 **15.492 -> 16.268 ms**,
  maximum **40.286 -> 40.142 ms**. This cost increase is retained and remains
  below the requested mean of 5 ms. Whole-pipeline max: **492.934 ms** at startup;
  after warmup: **30.839 ms**.
- Farthest reserved waiting footprint is **1.290 m from its own crossing kerb**,
  versus a hard geometric request-region bound of six metres.

## Checks and review

Twelve restored reservation/capacity/geometry tests pass, including 3 km scale,
bounded probes/retries, stacked decks, closed crossings, partial paths, shared
capacity and request-specific denial. Nine existing intent, canonical-target,
initial-pose and spatial-index regressions pass. TypeScript and changed-file
ESLint pass. The complete battery retains seven failures, honestly reported.

Self-review checked map-independent candidate bounds, same-level body checks,
claim release on departure/reset, shared-capacity cache correctness, local
approaches and crossing permissions. No agents were launched, as requested.
The new shared bypass only replaces stationary-person parking; the pre-existing
moving-versus-moving recovery, including its visual-heading dependence, remains
an open defect and is not represented as fixed.

## Photographs

Every sheet below was inspected and shown as an image in chat. Each pair uses
the same camera, scenario seed, start time and intervals; no page errors.

- Crowd, 25-26.75 seconds: [before](../audit/2026-10-01/crowd-shared-wait/before/crowd.jpg)
  / [after](../audit/2026-10-01/crowd-shared-wait/after/crowd.jpg).
  The congested shared targets become separated waiting positions.
- Bottleneck, 30-33.5 seconds: [before](../audit/2026-10-01/crowd-shared-wait/before-late/bottleneck.jpg)
  / [after](../audit/2026-10-01/crowd-shared-wait/after-late/bottleneck.jpg).
  The old trace identifies walker 5's backward aside at 30.95 seconds.
  The before run uses the saved `b0de1df` engine; its fixed-scenario movement is
  byte-identical to `6830ba5` because the intervening birth change affects only
  automatic city population. Both runs use the current renderer.

An earlier bottleneck sheet at 12 seconds missed the late defect; it was shown
with that limitation and is not used as proof of the correction.

## Next

Fix the retained `gap-one` backward maneuver and longer crowd stalls. The
height-loss cause on elevated city paths is already traced, with a failing
regression prepared, but no height correction is included in this commit.
Full section 8 completion remains unproven; default selection is unchanged.
