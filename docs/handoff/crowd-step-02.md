# Crowd step 02: canonical waiting targets

2026-10-01. Correct `askPlace` to compare the projected navigation-mesh target
with the projected target stored by `ask`. Previously it compared the raw
waiting place with the projected one. An unchanged off-mesh place consequently
submitted the same move request every tick and reset the rest timer.

The regression reproduces crowd walker 29 at 26.1-26.5 s: the target and crossing
grants stay unchanged while requests rise 587 -> 611. After the fix there is no
duplicate request during the interval. Rejected Detour requests are no longer
recorded as accepted. Explicit re-requests after filter changes remain intact.

The full 19-scenario report is identical to step 01 except requests per person
per minute: crowd 83.9 -> 11.0, queue 15.9 -> 14.0. All movement measurements are
unchanged: 8/19 passing, 1086 backward ticks, 103 slides, everyone arrives, zero
jumps and trespass. TypeScript, changed-file ESLint, the new target regression
and the 50-second facing regression pass. Tests used test-light, one worker.

No claim of a visible movement improvement or a measured ms/tick gain is made.
The already inspected step-01 photos represent unchanged scenario motion.
The raw queue places can still project to the same point: walkers 19 and 29
both request (24.5,15). This commit does not change queue geometry, resolve
contact cascades, accept ease/unlock or complete handoff items 0-1.

Next, per the player's relayed Claude review at 16:15: remove the remaining
visual-facing dependency in clearSpot with a regression, then continue the
solo-startup diagnosis and measure the pair in the +3.5 s photograph.
