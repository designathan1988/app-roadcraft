# Crowd step 01: navigation frame for companions

2026-10-01. Approved for commit by the player's relayed Claude review at 16:06.

## Live scope

Only `?people=crowd` changes. The default remains the old engine. This step does
not complete hygiene or backward-motion work.

Companion places now use the leader's route direction instead of its visual
heading. The direction comes from the first nonzero route segment and is held
inside the existing destination arrival radius. No solver parameters, scenario
geometry, spawns, destinations, durations or thresholds changed. Detour still
owns every position update.

The regression test originally failed on tick zero: changing only initial
visual facing changed companion 2's target from (-37.5, 13.2) to (-39.75, 14.825)
and changed its actual velocity. It now passes through all 50 seconds of the
group scenario. This is evidence of the formation/facing separation, not proof
that all backward movement is solved. `clearSpot` still reads visual heading;
that remaining coupling is open.

The unconditional global `__crowdProf` writes and timing calls were removed.
The photography script now publishes the initial state without advancing time,
waits for the visible cast's actual meshes, reports page errors and closes its
browser on failure. It previously photographed an empty first frame while the
models were loading.

## Measurements

- Baseline reproduced exactly: 8/19 battery scenarios pass, 1086 backward ticks,
  103 slide ticks, zero jumps and trespass, everybody arrives in every scenario.
- After this step: still 8/19, 1086 backward ticks, 103 slides, zero jumps and
  trespass; everybody arrives. Full after report: `crowd-route-direction.jsonl`.
- Only group and side-by-side results change. Group: trip 30.5 -> 30.6 s,
  backward 6 -> 6, stood 0.8 -> 0 s, starvation 0.6 -> 0.7 s, replans/min
  76.5 -> 77.1. Side-by-side: trip 22.6 -> 22.8 s, backward 0 -> 0,
  slides 1 -> 1, starvation 0.6 -> 0.4 s. These deterministic small increases
  are recorded rather than described as an unchanged trajectory.
- Player city, 60 s: 1395 -> 1176 backward ticks. End population 334 -> 335;
  this is the same city/demand setup, not a fixed identical population census.
- TypeScript and ESLint on changed files pass. Tests run only through
  `scripts/test-light.mjs`, one worker. The full battery retains its 11 known
  failures; no claim that the full project check is green.
- The 80-seed/40-operation general fuzz hunt was stopped after more than two
  minutes without a complete result, respecting the player's foreground budget.

## Photos inspected

`../audit/2026-10-01/codex-crowd-intent/group-conflict/group.jpg`:
fixed camera, simulation 10-13.5 s. Frames after the first show the group walking
and meeting an oncoming person. The first frame was blank from asynchronous
model loading; do not count it as complete approach evidence. The closest pair
in the +3.5 s frame requires measurement, as requested in review.

`../audit/2026-10-01/codex-crowd-intent/loaded-first-frame/group.jpg`:
fixed camera, simulation 10 and 10.5 s, photographed after fixing readiness.
Both frames show all four people, with walking poses and positions on the
footway. No page errors. This verifies loading, not absence of overlap later.

## Hygiene audit remains open

Independent ablations were fully reverted:

| Removed mechanism | Observed result |
| --- | --- |
| unlock | crowd arrivals 40 -> 36; dense arrivals 30 -> 29 |
| ease | 8/19 -> 7/19; dense backward 211 -> 863, slides 0 -> 40 |
| beside/file fallback | 8/19 -> 9/19; group backward 6 -> 0, starvation 0.6 -> 1.4 s; side-by-side stood 0.1 -> 1 s |

Worse ablations do not establish these mechanisms as structurally correct.
`ease` changes the speed reference used by its own blocked counter; `unlock`
resets that counter before physical recovery. Baseline crowd walker 29 receives
nearly the same ineffective side target at 36.583 and 41.483 s. Independent
physical progress must be traced before deciding whether these mechanisms stay.

The waiting-place investigation also found two raw places projecting to one
target: at 26.1 s, walker 19 waits for (24.2,17.475) and walker 29 for
(24.2,15.85); both request (24.5,15), allowed by their WALK filters. Comparing
raw and projected places repeatedly requests an unchanged path. A separate
fix/test is prepared but is not part of this step.

Next: measure the +3.5 s pair, finish the hygiene audit, trace solo city INTENT
episodes, then continue handoff section 7 in order. No permission to switch the
default or delete old engines has been requested or assumed.
