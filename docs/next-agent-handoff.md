# Roadcraft handoff prompt

You are taking over the Roadcraft browser-game repository at `C:\Users\jonathanrodriguesti\Desktop\Projetos\Road`. Read `AGENTS.md` and `docs/completion-audit.md` first. The user wants the complete, working game improvements described by the 14 blocks in the audit; the current agent is handing over an **unfinished** project. Do not infer completion from a green test run. Work in a git worktree of your own (AGENTS.md, "Working here"), never directly in the shared folder, make a local commit at each completed checkpoint, and do not push without instruction. The user previously said another assistant had stopped working here; inspect the working tree before editing. All repository text, code, documentation, and commit messages must be in English. Respond to the user in Portuguese.

## Original objective and acceptance standard

The original full request was a local attachment outside this repository and is no longer available. `docs/completion-audit.md` also records the complete scope and required work order. All 14 blocks remain within scope: road meshes and all structural transitions; junction paths and physical movement conflicts; signal permission, phasing and demand; complete vehicle dynamics and route behavior; traffic generation; vehicle models and functional parts/occupants; 80 distinct animated pedestrians with safe navigation; utility poles and furniture; bounds; consistent scale; graphics; performance; architecture and cleanup; and comprehensive tests. For each block, reproduce problems, measure them, identify root causes, implement the fix, test it, run the production game, and visually inspect captures. Do not remove requested features, weaken gates, or relabel partial work as complete.

## Completed local commits before this checkpoint

- `753a309` added rigged Rocketbox pedestrians and pedestrian clearance, but pedestrian behavior and physical avoidance still need broad validation.
- `bcbe431` expanded the roster to 80 distinct Rocketbox characters, preserved full-detail geometry with distance LOD and bounded asset loading, and fixed polygon union/hole behavior. Production evidence: `docs/audit/citizens-production.json` renders all 80 plus 40 repeated actors on an RTX 3060 at approximately 60 FPS without WebGL errors. A separate 41-instance `male_12` repetition check is in `docs/audit/citizens-lod-benchmark.json`. That does **not** establish performance at the requested large combined traffic and crowd load.

## This checkpoint: implemented and verified

The immediately preceding failing gate was vehicle bodies entering the footway. The baseline in `docs/audit/vehicle-containment-baseline.json` contains 6,066 violations among 3,764,556 checked body corners. The simulation stored the vehicle front while the renderer treated it as the body center. `src/sim/vehicles/spawn.ts`, `state.ts`, `integrate.ts`, `src/sim/pose.ts`, and `src/sim/peds/clearance.ts` now start the full body inside the entry and derive its midpoint across recently traversed lanelets. This reduced the count to 196 right-turn corners.

`src/world/lanelets.ts` now uses a 0.65 cubic connector handle. `tests/world/connectorFootprints.spec.ts` verifies 544 connector/archetype pairs across four-way, T, skewed, five-leg, and one-way layouts: 318,240 sampled body points, zero asphalt/kerb overruns. Candidate 0.50/0.55/0.60 results and selected-movement geometry are recorded in `docs/audit/junction-body-*.json`.

A live residual violation traced to a stale `desiredLane` surviving from a prior road across a connector. `src/sim/vehicles/laneChange.ts` and `integrate.ts` now reject transfers to a different carriageway, require adjacent moves and adequate remaining distance, and clear stale approach intent at connector transitions. `src/sim/vehicles/state.ts` and `src/sim/routing/router.ts` preserve the chosen movement through the required adjacent lane changes. `tests/sim/laneChangeIntent.spec.ts` covers a multi-stage right-turn approach; `tests/sim/kerb.spec.ts` contains the original failure reproductions. Final seeded 200-second simulation: `docs/audit/vehicle-containment-final.json` records 3,879,832 checked body corners, **zero** footway invasions and **zero** excessive lateral offsets. This is a finite seeded scenario, not universal proof.

The overtaking test formerly counted longitudinal order reversals in only one chronological direction. Diagnostics found 17 real passes in the other direction (`docs/audit/overtaking-baseline.json`), so `tests/sim/drivers.spec.ts` now counts physical order reversal either way. `tests/sim/signalMovementMatrix.spec.ts` checks protected through conflicts and WALK conflicts in five layouts. `scripts/verify-visual.mjs` now runs four additional junction scenarios and writes `docs/audit/junction-runtime-movements.json` with origin, lane, intent, connector, destination, geometry, light, static conflicts and simultaneous holders. Four production captures are `docs/audit/junction-{mixed-T,skewed,five-leg,one-way}-production.jpg`.

At this checkpoint, `docs/audit/junction-containment-final-check.log` records **green `npm run check`** (lint, typecheck, 258 tests with coverage, build). `docs/audit/junction-visual.log` records **15 passing production visual scenarios**. No known test failure remains in the current checkpoint. The evidence reflects the current implementation, not all 14 acceptance blocks.

## Checkpoint after 8ce8675: physical junction conflicts and dual lane occupancy

- `tests/sim/support/bodies.ts` measures drawn body overlaps directly. Baseline:
  120 overlapping pairs in seven seeded scenarios, 290 at intensity 3.
- `src/world/conflictPoints.ts` now builds swept-footprint zones for three body
  classes (small/car/heavy) instead of centreline crossings. Claims are shared
  only when the bodies cannot touch and released when the body centre leaves
  the zone (`claims.ts`, `admission.ts`, `integrate.ts`).
- Diverging movements from one lane are followed through their shared start
  (`divergeObstacle` in `leaderIndex.ts`).
- A lane change keeps a `shadow` in the old lane until a heavy vehicle could pass
  beside the sliding body; `SimWorld.bodiesIn` (occupants, shadows, tails of
  vehicles already on a connector) feeds lane-change gaps and spawn checks.
- Admission refuses a heavy turn while an unadmitted vehicle stands in its sweep
  at another stop line, and stops arrivals short of such zones.
- Tests: `tests/sim/collisions.spec.ts` (full-run zero overlaps in 7 scenarios,
  shadow correctness, direct reproductions with mutation-checked guards),
  `tests/world/conflictZones.spec.ts`; `signals.spec.ts` and
  `signalMovementMatrix.spec.ts` now assert the physical rule.
- Evidence: `docs/audit/junction-physical-conflicts.json` (before/after, stress
  seeds), `docs/audit/vehicle-collisions.json`, `docs/audit/junction-queue-intrusions.json`.
  Zero overlaps everywhere measured; throughput -6 % (intensity 2) and -8 %
  (intensity 3), concentrated on five-leg and mixed-lane layouts.

## Incomplete work and known limitations

1. **Highest priority: junction discharge and signals.** Physical conflicts are now swept zones (see checkpoint above), but saturated discharge is poor and was already poor before: 3 to 4 vehicles in a four-way avenue box during green with 13 to 18 queued per lane, permissive lefts and protected throughs blocking each other through their zones. Measure saturation flow per lane, then work on queue discharge, protected/permissive left phasing, demand metrics (queue length, wait, arrival rate, downstream capacity), adaptive cycle lengths and corridor offsets. Keep `tests/sim/collisions.spec.ts` at zero.
2. **Vehicle behavior.** Dual-lane occupancy during lane changes is implemented and tested. Still open: the body pose is a centred tangent rectangle, so buses and trucks swing both ends outward on turns instead of off-tracking inward (this inflates heavy conflict zones and is behind the stop-line intrusion cases); lateral slide speed (`LATERAL_CLOSE_RATE`, 3.4 m/s) is faster than a real lane change; cooperative merges, missed-turn recovery, passing completion and return, curvature-based speeds and driver variation remain to verify. `rearPath` is bounded to 32 IDs.
3. **Road/world completeness.** The finite connector sample and seeded kerb test do not cover every junction geometry, edited terrain, ramp, bridge, tunnel or road rebuild. Continue mesh/geometry tests, bounds for every creatable object and actual production captures.
4. **Pedestrians.** The 80 models exist and render, but natural start/walk/stop/turn/idle, variety of activities, personal space, queues, signals, traffic reaction and all furniture/vehicle collisions have not been fully verified. Do not claim the citizen block complete.
5. **Other open blocks.** Traffic generation, vehicle parts and occupants, pole/furniture workflows, scale, day/night graphics and shadows, large-load performance, architecture cleanup and comprehensive acceptance tests remain as detailed in `docs/completion-audit.md`. Existing assets or code are not completion evidence. `docs/completion-audit.md` marks each block honestly.

## Next actions

Start from the clean post-checkpoint commit. Physical conflicts and dual lane occupancy are done for the measured scenarios; continue with junction discharge and signal phasing (item 1), then heavy-vehicle off-tracking (item 2, which must update the sweep in `conflictPoints.ts` together with `sim/pose.ts`). Use the probe pattern in `tests/sim/support/bodies.ts` for measurements; put scratch probes under an underscore directory (ignored by the runner). Run `npm run check` after each block and `npm run verify:visual` for visual blocks, inspect production images, and make local commits.

On this host Chrome is typically at `C:\Program Files\Google\Chrome\Application\chrome.exe`; set `CHROME_PATH` for Playwright if necessary. Useful commands are `npm run check`, `npm run verify:visual -- --shots`, `npm run verify:citizens`, and `npm run dev -- --host 127.0.0.1 --port 5198`. Check whether port 5198 is already serving before starting another server. The current green suite is a checkpoint only: do **not** mark the project or any unverified audit block complete.
