# Crowd step 05: short, lateral and backward footwork

The renderer now represents slow displacement with a genuinely shorter pose,
and side/back displacement with directional cycles derived from the existing
Rocketbox capture. Bake-time leg IK preserves local bone lengths; measured hip
and sole widths constrain side steps. Directional weights use inverse effective
stride, including run blending, so diagonals preserve both vector components.
Only pose and animation state change; PedView is read-only and Detour movement
is untouched. The navigation engine default is unchanged.

Research and alternatives: [directional gait](../research/crowd-directional-gait.md).
Independent review found crossed-foot and diagonal-distance risks; actual-foot
and signed-vector regressions cover them. Sixteen focused tests, TypeScript and
changed-file ESLint pass. The old long legacy gait auditor was interrupted and
is not claimed to pass.

The integrated physical battery remains exactly 9/19, with identical complete
reports to step 04. A bounded old/new gait comparison then consumed the same
frozen real PedViews for every unchanged scenario and the 60-second player city.
None of its measured fields worsened in any of the 20 cases.

| Measure, accumulated person-seconds | Old | New |
| --- | ---: | ---: |
| Slow motion dominated by static pose, 19 scenarios | 155.667 | 9.733 |
| Stable translational cycle glide, 19 scenarios | 111.183 | 11.700 |
| Slow motion dominated by static pose, player city | 73.600 | 5.117 |
| Stable translational cycle glide, player city | 63.867 | 5.467 |

The static measure includes the new walkRest pose; changing an animation name
cannot evade it. The slow band remains 0.03-0.14 m/s. Stable city signed travel
error falls 0.006400 -> 0.002348 m/s. These controller measurements are not claims
of exact world-space foot locking. Raw city input still has 656 backward ticks
and 28 jumps; physical pushing and blocking are not fixed by animation.

Photos inspected individually: the real fixed-camera crowd sequence at
`../audit/2026-10-01/crowd-directional-gait/crowd.jpg` shows short footwork during
small crowded movements. The separately labelled synthetic slow, back and
diagonal-back previews show alternating feet while retaining torso direction;
they demonstrate animation, not navigation validity. Existing remaining movement
defects remain open. No source in vehicles, intersections or signals was changed.
