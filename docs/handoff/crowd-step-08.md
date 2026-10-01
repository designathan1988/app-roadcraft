# Crowd step 08: physical queue approaches and forward/side yielding

Live under `?people=crowd`, on top of `f09f2b7`. The default remains unchanged.
The player-authorized net-gain rule applies; all 161 scenario walkers still arrive.

## Cause and implementation

At 7.067 s in `gap-one`, walker 6 was released while walker 4 stood in its
approach. A logical row was also advanced before its new physical place was
clear. Admission now checks the existing path prefix to the entrance against
same-side standing waiters; queue-place selection checks the approach as well.
This preserves the existing opposing-flow priority rather than imposing FIFO
on a physically free entrance. A full queue waits where it already stands.

Shared yielding now prefers a feasible side/forward place in the actual trip's
navigation frame, including the leader's frame for companions. A feasible
retreat remains the fallback when none of the existing bounded alternatives
works. Visual heading does not select these targets. Detour movement, radii,
configuration, test fixtures, durations, thresholds and destinations are unchanged.

[Research, trace and rejected alternatives](../research/crowd-passage-space.md).

## Full battery and retained regressions

[Complete report](crowd-passage-space.jsonl), versus step 07:

| Measure | Before | After |
| --- | ---: | ---: |
| Passing scenarios | 12/19 | 13/19 |
| Arrivals | 161/161 | 161/161 |
| Backward displacement samples | 496 | 338 |
| Sliding samples | 7 | 6 |
| Reversals | 3 | 5 |
| Jumps / unauthorized road-entry samples | 0 / 0 | 0 / 0 |
| gap-one backward samples | 13 | 0 |
| gap-one last arrival, seconds | 31.5 | 30.8 |
| queue backward samples | 27 | 0 |
| crowd backward samples | 274 | 231 |
| crowd slides | 6 | 0 |
| dense opposing-flow backward samples | 108 | 37 |
| gap-two backward samples | 54 | 40 |

The gain is retained with these explicit costs:

- Crowd longest stop **14.4 -> 19.9 s**, reported starvation **30.5 -> 39.4 s**,
  last arrival **136.1 -> 145.1 s**, reversals **1 -> 3**. All forty still arrive.
- Dense opposing-flow slides **0 -> 5**, last arrival **70.1 -> 70.2 s**.
- Bottleneck longest stop **0.6 -> 3.4 s**, starvation **0.9 -> 4.2 s**,
  last arrival **41.8 -> 45.5 s**; backward remains zero.
- Obstacles backward **0 -> 8**, longest stop **0.5 -> 1.7 s**, starvation
  **0.8 -> 2.9 s**, last arrival **33.3 -> 36.4 s**.
- Bidirectional-10 backward **20 -> 22**, but longest stop and last arrival improve.
- Gap-two last arrival **27.5 -> 28.5 s**.

The original limits still expose six failing scenarios. This is not completion.

## Player city, full 60 seconds

[City report](crowd-city-passage-space.json): backward **529 -> 521**; slides
**1 -> 1**, contacts **752 -> 752**, jumps and trespass **0 -> 0**, population
**334 -> 334**. Longest unexplained stop **39.733 s** and physical starvation
**17.133 s** remain unchanged.

People-step mean **4.625 -> 4.744 ms**, p95 **16.268 -> 16.878 ms**, maximum
**40.142 -> 45.673 ms**. The mean remains below 5 ms; this is not a performance
improvement and the higher tail cost is recorded rather than hidden.

## Protection and review

`crowdPassageSpace.spec.ts`: 2/2 pass. The blocked-approach regression fails on
the previous commit at 7.067 s, then passes on this version. The second test
protects side/forward preference after an actual completed westbound trip; it
also passed before and is not claimed as independent proof of this bug fix.
The 12 reservation/geometry/capacity regressions and existing intent test pass.
TypeScript and changed-file ESLint pass. Full source hash:
`ac3b28a74302bce3c678706f902a0240432abafe`.

Self-review checks: approach is clipped to the existing local entrance distance;
no new global path query, map-sized loop, native position rewrite or visual
heading feedback was introduced. The same-side standing waiter restriction
avoids blocking forever behind a completed unrelated trip. Retreat fallback
preserves available escapes. The remaining regressions above are measured risks.

## Photos shown to the player

- Gap-one, 6.5-8.25 s, identical fixed camera:
  [before](../audit/2026-10-01/crowd-passage-order/before/gap-one.jpg) /
  [after](../audit/2026-10-01/crowd-passage-order/after/gap-one.jpg).
  The waiting rear person no longer starts and retreats into the post-side space.
- Crowd, 25-26.75 s, identical fixed camera:
  [before](../audit/2026-10-01/crowd-shared-wait/after/crowd.jpg) /
  [after](../audit/2026-10-01/crowd-passage-order/after/crowd.jpg).
  Waiting places remain stable in this interval. This interval does not by itself
  show the elimination of the six later sliding samples; that is a full-run result.

Sheets were opened and inspected, camera/time metadata matched, no page errors,
and every captured sheet was displayed in chat with its link. The game browser
was left open for the player as requested.

Next: reduce the retained crowd waiting/starvation increase and the five dense
slides, and preserve target height through city navigation (already traced:
elevated walker 595 targets ground level, 212 loses its destination height).
