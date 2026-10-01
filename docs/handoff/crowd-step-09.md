# Crowd step 09: keep navigation targets on their actual deck

Live only under `?people=crowd`. Goal and requested-point storage now preserves
the native height along with the plan coordinates. Intermediate route points
keep the path's height; local requests and companion places use their known
deck. Body movement, destinations in plan coordinates, births, geometry,
query extents, radius, preset and vehicles are unchanged.

## Proof of the cause

[Trace](crowd-route-height-trace.json) and
[primary research](../research/crowd-route-height.md).
Walker 212's accepted destination is on the deck at native height 37.924999,
but the old lookahead rebuilt it at 30.346444. That query failed and omitted
the crossing-permission decision. Walker 595 instead received an intermediate
target at ground height 0.425 while standing on the deck at 37.924999.
These are navigation points on different surfaces, despite nearby plan positions.

`crowdRouteHeight.spec.ts` reproduces the real city case: before, walker 212 has
32.65 seconds of unexplained standing; after, the maximum is below the unchanged
five-second regression bound. This does not claim all city stops are eliminated.

## Full verification

- All 19 scenarios: **13/19**, complete reports byte-identical to
  `crowd-passage-space.jsonl`. All **161/161** still arrive; six scenarios fail
  under the original limits.
- Full player city, 60 seconds: [result](crowd-city-route-height.json).
- New real-city regression passes; 16 birth, passage and waiting/capacity/geometry
  guards pass; existing canonical-target and intent tests pass.
- TypeScript and changed-file ESLint pass.

| City measurement | Step 08 | This change |
| --- | ---: | ---: |
| Backward displacement samples | 521 | 466 |
| Slides | 1 | 1 |
| Native contact-correction samples | 752 | 639 |
| Jumps / unauthorized road entry | 0 / 0 | 0 / 0 |
| Longest stationary spell, seconds | 39.733 | 22.717 |
| Longest unexplained stop, seconds | 39.733 | 12.350 |
| Longest physical starvation spell, seconds | 17.133 | 16.033 |
| Final population | 334 | 334 |
| People step mean, ms | 4.744 | 4.583 |
| People step p95, ms | 16.878 | 16.930 |
| People step maximum, ms | 45.673 | 41.805 |

These are observed timing samples, not a claim of a separate optimization.
The mean remains below five milliseconds. Remaining waits and six scenario
failures mean the complete section 8 goal is still unfinished.

## Visual proof and capture correction

The first photographs misleadingly omitted the moving person: the inspection
camera was wider than the play camera's prepared crowd. Census probing found
212 absent with play zoom 20, present at 10 and 5. This was a capture-framing
problem, not evidence that the person had been removed or rendered underground.
Those preliminary sheets were shown with their limitation and are not the proof.

`crowd-shots.mjs` now accepts `CROWD_VIEW_ZOOM` and `CROWD_FOCUS_IDS`. The capture
waits for every requested focus identity to be in the actual drawn cast as well
as for citizen meshes to load. It fails instead of silently accepting a missing
focus actor. Simulation and the inspection camera are unaffected by this control.

Final pair: player city, seed `0x2026`, 27-30.5 seconds at 0.5-second intervals,
same fixed camera and play zoom 10, focus 212 present in all eight frames in
both runs, zero page errors:

- [Before](../audit/2026-10-01/crowd-route-height/before-visible/player-city.jpg):
  the blue person remains beside the pole while other people walk past.
- [After](../audit/2026-10-01/crowd-route-height/after-visible/player-city.jpg):
  that person has crossed and walks along the other pavement.

Both sheets were opened, inspected, shown as images in chat and linked. The
before run uses the saved `6107acd` engine with the same current renderer and
capture options. The corrected game was left open for the player as requested.

## Review and open work

Self-review checked that every changed request preserves known height without
writing native positions or velocities, widening queries or changing crossing
permissions. The full flat battery proves the coordinate change did not alter
those trajectories. Existing large-city defaults and demand are preserved.

The separate frozen-through-corridor reservation experiment was rejected before
this change: crowd arrivals fell from 40 to 29, reverse samples rose 231 -> 740
and slides 0 -> 65. Existing waiting ownership cannot be preempted independently
without creating new conflicts. Its source changes were completely removed.

Next: the remaining crowd waiting delay, dense-flow stationary slides and
remaining backward maneuvers. Do not switch the default or delete old engines;
the player's completion requirements have not yet been met.
