# Crowd step 06: prevent overlapping city group births

Live only under `?people=crowd`. The default engine is unchanged. The player
explicitly authorized city group placement changes; fixed scenario births,
population demand, radii, destinations, durations and thresholds are unchanged.

## Cause and change

Companion offsets projected onto a narrow sidewalk could overlap the leader.
In the player city, 51/54 start 0.082011 m apart for 0.54 m combined diameter.
Detour's own penetration resolution produces the resulting jump. See
[the captured before-update trace](crowd-group-birth-trace.json).

Keep already-clear births; for an overlapping companion, find a nearby,
reachable footway position with the existing intended group spacing. At most
64 alternatives within 3.06 m of the leader are considered. No body position,
velocity, interpolation history, animation, vehicle or solver preset is changed.
An unsuccessful placement rolls back the whole unpublished party through the
existing bounded spawn attempts rather than silently dropping a member.

[Primary research and rejected alternative](../research/crowd-group-birth.md).
Self-review found that minimum tangent spacing created a later prolonged contact;
using the already-intended group spacing avoided that regression. It also found
partial-party loss on failed placement; whole-party rollback and forced-failure
tests cover it. No review agent was launched, per the player's latest order.

## Validation

- Full fixed battery: **9/19 -> 9/19**, complete reports byte-identical to
  `crowd-first-pose.jsonl`. The same ten pre-existing scenarios fail.
- New `crowdBirth.spec.ts`: **2/2**, full original city demand and all requested
  members of every admitted party, including deliberately blocked placement.
- TypeScript and ESLint on the changed files pass.
- Full player city, 60 seconds: [result](crowd-city-group-birth.json).

| City measurement | Before | After |
| --- | ---: | ---: |
| Artificial backward displacement samples | 656 | 540 |
| Sliding samples | 58 | 1 |
| Native contact-correction samples | 1,019 | 818 |
| Jump samples above 3 m/s | 28 | 0 |
| Unauthorized road-entry samples | 0 | 0 |
| Longest stationary spell, seconds | 41.700 | 39.733 |
| Longest unexplained stationary spell, seconds | 39.933 | 39.733 |
| Longest physical starvation spell, seconds | 24.333 | 17.133 |
| Initial population | 334 | 334 |
| Population at 60 seconds | 335 | 334 |

Both versions retain the same demand and complete initial population; corrected
occupancy can affect later accepted sources and trips, so identities and final
population churn are not claimed identical. No scenario or demand was reduced.

Final people-step cost: mean **3.910 ms**, p95 **15.492 ms**, maximum **40.286 ms**.
A same-session old-version rerun measured 3.952 / 15.456 / 40.382 ms. The small
p95 variation is reported, not represented as an optimization. Whole-pipeline
maximum is 488.770 ms on initial population creation; after five seconds the
maximum is 28.097 ms. The average people-step target is met, not the full goal.

## Fixed-camera visual proof

Same city seed `0x2026`, first published movement at 1/60 s, then six images one
step apart. Identical camera metadata in both files. No browser page errors.

- [Before](../audit/2026-10-01/crowd-group-birth/before/player-city.jpg): blue/green
  pair separates abruptly; centres are only 0.321 m apart in the first photograph.
- [After](../audit/2026-10-01/crowd-group-birth/after/player-city.jpg): the blue person
  starts on free sidewalk; pair separation begins at 1.515 m and changes gradually.

Both sheets were opened, inspected and displayed as images in the conversation.
`scripts/crowd-shots.mjs` now supports `player-city`; `CROWD_KEEP_OPEN=1` leaves
the photographed browser visible and running for the player after capture.
The server and visible browser were left open at the player's explicit request.

## Still incomplete

Backward movement, one city slide, stationary contacts and long stalls remain;
ten fixed scenarios still fail. No claim that the entire pedestrian engine is
finished. Next evidence: city walkers 595/596 stand about 40 seconds at a partial
path endpoint; 212 does likewise without neighbours. Diagnose path admission
and partial-path progress separately from physical crowd deadlock.
