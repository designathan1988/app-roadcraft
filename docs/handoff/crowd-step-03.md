# Crowd step 03: local geometry queries without changing movement

2026-10-01. Five global geometry scans now use conservative spatial candidates:
zebras along a route, nearby narrow passages, current passage, current zebra,
and the road underneath a person. Candidates retain their original order and
the exact original geometry predicates. Indices belong to one nav build and
are replaced with that nav. No decision timing, solver setting or intent changes.

## Verification

- Spatial boundary/order tests: 5/5. TypeScript and changed-file ESLint pass.
- All 19 battery reports are exactly unchanged: 8/19 pass, 1086 backward ticks,
  103 slides, all arrivals, zero jumps and trespass.
- 84,300 per-tick hashes across the complete battery match byte for byte.
  The snapshot includes PedView, inspectCrowd, crossingStates and RNG; it does
  not claim to serialize every private Detour or engine field.
- Paired player-city benchmark: 334 people, 300 warmup and 300 measured ticks
  per mode. Full scans and indexed candidates run in the same process with
  the same seed, exact predicates and original ordering. 600 city hashes match.
- Mean pedestrian dispatch/step/publish: 10.64982 -> 3.19888 ms/tick (-69.96%).
  Median: 6.004 -> 2.2381 ms; p95: 70.3587 -> 16.2175 ms. Pipeline mean:
  11.44289 -> 3.96927 ms. See `crowd-cost-paired.json` for raw results.

The mean is below 5 ms in this five-second measurement window after a five-second
warmup. This is not a claim that every tick is below 5 ms, nor the final 60-second
city validation. No visible defect count is claimed to improve in this commit;
the previously inspected pictures represent unchanged scenario motion.

## Next visible work

An isolated queue reservation candidate has measured crowd backward 535 -> 230
and slides 102 -> 0, with all arrivals. It is not integrated in this commit;
one queue slide and increased standing time remain under investigation. Gait
variants are separately being checked for diagonal direction and photographed.

Two isolated changes of clearSpot preference were rejected and fully removed:
route direction caused 39/40 crowd arrivals and dense stood 45 s; local intended
direction caused crowd slides 120 and dense slides 97. The known visual-facing
dependency is still open and its new reproduction remains work in progress.
