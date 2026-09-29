# Roadcraft completion audit

## Scope and evidence rules

The authoritative request is the full pasted specification supplied on
2026-09-22, attachment `1f7885ef-2989-431b-9587-7083f8b93edd/pasted-text-1.txt`.
All of its requirements remain in scope. This ledger does not replace or
reduce that specification. Existing code and earlier passing checks do not
prove completion. Each block needs reproduction, measurements, a root cause,
implementation, tests, a running production build, and visual inspection.

Status meanings: **open** = not fully verified; **in progress** = active work;
**verified** = every requirement in the block has current evidence. Partial
fixes do not change a block to verified.

## Required blocks

| Block | Full scope to verify | Status | Evidence |
| --- | --- | --- | --- |
| 1. Roads and meshes | Missing asphalt; holes, deformation, overlap, indices, triangulation, normals, UVs; road connections, snapping and alignment; curves, junctions and connectors; edited terrain; ramps, elevated roads, viaducts, bridges and tunnels, including every transition; affected-only rebuilds; pier dimensions and shadows; bounds; vehicle bodies stay on carriageways | Open | Pending union change and player-map fixture found in the worktree |
| 2. Junctions | Running four-way, T, skewed, 5+ leg, mixed class, one/two-way and mixed lane-count scenarios; a record for every movement with origin, lane, intent, connector, destination lane, geometry, displayed signal and simultaneous conflicts; lane order; valid left/right/U-turn paths; physical volume conflicts; buses/trucks; admission, priority, yield, spillback and realistic deadlock handling | In progress | Swept-footprint conflict zones for three body classes; zero body overlaps in 7 layouts x 4 seeds (up to intensity 3, 300 s); stop-line intrusion guards; saturated discharge still low and heavy off-tracking model open |
| 3. Signals | Displayed light agrees with actual permission; protected conflicts excluded; compatible opposite movements; yielding permissive lefts and exclusive phases; queue discharge and cycle length; demand includes queue length, wait, arrival rate, distance, desired movement and downstream capacity; corridor offsets from distance/speed; every phase checked against actual conflicts | In progress | Protected greens checked against swept zones; right of way between green movements is now a hierarchy (be65467). Queued saturation headway measured at 1.8 s (realistic); cycle/demand/offset work and permissive-left box waiting open |
| 4. Vehicle behavior | Natural speed, acceleration/braking/headway and reaction delay; independent driver traits; adjacent, physical lane changes with intermediate occupancy; weaving, early positioning and missed turns; merges and cooperation; complete passing maneuvers and passing side; persistent route intentions and bounded congestion knowledge; curvature/lateral-acceleration speed; physical dimensions, truck off-tracking, bus stops, distinct motorcycles/bicycles; continuous pose and carriageway containment | In progress | Dual-lane occupancy during lane changes (shadows, now held until the change completes), diverge following and tail-aware gaps; lane changes driven as a curve in distance and steered from the rear axle (70bdf0a); curvature speed at a comfortable lateral acceleration (d9abf82); rest of the block open |
| 5. Traffic generation | Coherent scalable demand and distribution; no congestion-balanced spawn shortcut; independent entry demand without a single global fixed attempt | Open | Not yet audited |
| 6. Vehicle visuals and functions | Preserve mirrors, plates, wheels/hubs, pillars and interior; visible human drivers/passengers with correct poses; glass; functioning doors/windows/headlights/tails/brakes/indicators; spinning and steering wheels; every function driven by simulation state | In progress | Rigged drivers/passengers seated (f14b0ab); brake lamps from real deceleration; indicators for turns ahead, wanted and running lane changes, flashing; front-wheel steering and rolling hubs (589c16f). Doors, headlights by time of day open |
| 7. Pedestrians | Target 80 distinct human characters (user increased the earlier minimum of 30); convincing proportional humans; natural start/walk/turn/stop/idle/wait, limbs, gaze and posture; body/appearance/speed/posture variety; no arbitrary pauses, jitter, sliding, overlap or sharp spins; physical obstacle avoidance, personal space and queues; correct footways/zebras, kerb waiting, signals, traffic reactions and persistent destinations | Open | Commit 753a309 is a partial implementation requiring broader validation; expanded variety requested on 2026-09-22 |
| 8. Utilities and furniture | Footway/terrain/existing-pole snapping, 15-degree alignment; actual vertical-pole/wire/connection preview; crossarm axis, capture radius and feedback; selection/deletion/demolition; chained runs; catenary, lighting, bins, benches, hydrants and postboxes | Open | Existing implementation must be exercised in production |
| 9. Bounds | Roads, elevated roads, poles, wires, furniture and every creatable object; previews reject invalid creation | Open | Existing bounds tests require a coverage audit |
| 10. Scale | Coherent people, cars, poles, trees, roads and buildings; human-scale citizens; visible correctly sized vehicle occupants | Open | Production captures required |
| 11. Graphics | Improved viaduct-safe shadows; emissive bloom; day/night with matching lamps/headlights; cascaded shadows; vegetation wind; water reflections; AO; materials and lighting within performance budgets | Open | Not yet audited |
| 12. Performance | Cached static shadows; local vegetation and road/terrain work; avoid full 90,601-vertex shape scans; efficient water rebuilds; stable materials/shaders; instance disposal; anisotropy; fewer per-frame sorts/allocations; large traffic and crowds | Open | Needs measured before/after workloads |
| 13. Architecture and cleanup | Reduce main.ts; terrain brush, overlay and panels extraction; no world/UI cycle; enforced layers and deterministic RNG; dead exports and Portuguese comments; shared scenery/structure and water/texture code; valid tsconfig; remove specified probes | In progress | Named probe files absent; tsconfig valid; no Portuguese comments outside i18n; 26 exports referenced nowhere removed (3847022). main.ts reduction and module extractions open |
| 14. Required tests | Complete movement/phase table; protected conflicts; adjacent physical lane changes; vehicle footprint collisions and heavy turns; curvature; full-run kerb safety; meshes/terrain transitions; universal bounds; pedestrian avoidance; pole workflow; all vehicle lighting/doors/windows/occupants | In progress | Movement-footprint, signal-matrix, lane-intent, full-run containment and full-run body-collision tests pass; remaining gates still open |

## Work order

1. Clean diagnostics and verify unfinished work.
2. Junctions, turning and signals.
3. Full traffic behavior.
4. Road meshes, connections and terrain.
5. Carriageway containment and map bounds.
6. Pedestrians.
7. Vehicles and occupants.
8. Utility-pole tool.
9. Performance and graphics.
10. Architecture and final cleanup.

Run `npm run check` after each block and `npm run verify:visual` for visual
blocks. Visual acceptance requires captures from the production bundle.
Create local commits for completed changes; do not push without instruction.

## Initial authoritative state

- HEAD: `753a309` (`Add rigged citizens and pedestrian clearance`).
- Uncommitted work: `src/core/clipper.ts`, a player-map fixture,
  `tests/world/union.spec.ts`, and `tests/sim/kerb.spec.ts`.
- Unused legacy pedestrian assets remain under `public/models/pedestrians/`.
- `vitest.diag.tmp.config.ts` is a temporary diagnostic configuration.
- `tests/sim/_probe.spec.ts` and `_probe-out.txt` were absent at inventory.
- The prior restricted test run is not a substitute for the required complete
  check. The vehicle containment failure must be fixed, not excluded.

## Findings

- The pending union repair checks only one point per input ring and ultimately
  appends lost rings. That does not establish a correct geometric union or
  preserve all hole semantics. It needs stronger independent tests before
  being accepted.
- A convex corner's triangle centroid is not necessarily inside a concave
  polygon. The current nesting/probe assumption also needs direct regression
  coverage.

## Current progress (not a completion claim)

- Replaced the polygon wrapper's flat-ring nesting and overlapping fallback
  with explicit polygon/hole set operations on a shared coordinate grid.
  `polygonBoolean.spec.ts` reproduces two previous failures; the player-map
  test now samples more than 5,000 interior positions and reverses input order.
  The arbitrary-precision candidate was rejected after the frame-budget test
  failed; the selected kernel passes that unchanged test in the full suite.
- The full `boolean-check-fast.log` has 247 passing tests and one remaining
  failure: complete vehicle footprint containment. No failing test is excluded
  from `npm run check`.
- Vehicle violation recording identifies 12 categories, primarily bodies
  extending behind link entries and several right-turn connector overruns.
  Measurements are in `vehicle-containment-baseline.json`; fixing them is next
  in the junction/traffic work, not an exception to the goal.
- The requested 80-character roster is implemented, reviewed and exercised
  in the production game. All 80 assets have valid skin weights and animated
  legs. Full-detail geometry is preserved; distant index LODs reduce work.
  Assets load on visibility with three concurrent requests and compact growing
  bone palettes. Legacy unused public assets are not shipped by the build.
- `citizens-production.json` records a production run containing all 80
  character models plus 40 repeated instances. The RTX 3060 run held about
  60 FPS with no WebGL errors; software-rasterizer measurements are separate
  and must not be presented as hardware performance. Broader fleet/crowd
  performance requirements remain open.
- Final checks for this checkpoint: `catalog-and-union-check.log` records
  251 passing tests and the same vehicle containment failure;
  `catalog-and-union-visual.log` passes all 11 production scenarios, including
  the player's saved map. The separate denim-jacket repetition benchmark
  (`citizens-lod-benchmark.json`) renders 41 instances of `male_12` at about
  60 FPS on the recorded GPU with no WebGL error.
- The rest of every block above remains open until verified against the full
  specification. In particular, this roster does not complete pedestrian
  navigation, all animation transitions, or vehicle occupants.
- The unused legacy pedestrian directory and rejected candidate sheet were
  safely moved to the local temporary archive `roadcraft-legacy-assets-20260922`.
  They are no longer in the project or production output; the source files
  were preserved outside the worktree rather than deleted.

## Vehicle containment and junction checkpoint

- The recorded baseline checked 3,764,556 visible body corners and found 6,066
  outside the carriageway/kerb. The simulation tracked the vehicle front,
  while rendering used that position as the body centre. Starting with the
  complete body inside the entry and locating the centre along traversed
  lanelets reduced the count to 196 right-turn corners.
- Five configurations (four-way, T, skewed, five-leg and one-way) generated
  544 movement/archetype combinations. Candidate curve handles of 0.50,
  0.55 and 0.60 left 35, 14 and 4 failing combinations. At 0.65 all
  318,240 sampled body points were on asphalt or kerb.
- A residual live violation exposed a stale target from a different street.
  The target is now checked against the current carriageway, mandatory
  changes proceed one adjacent lane at a time, and the chosen movement
  survives the required transfers. The final 200-second seeded run checked
  3,879,832 body corners with zero footway invasions and zero excessive
  lateral-offset events.
- The initial overtaking regression counted order swaps in only one direction.
  Diagnostics recorded 17 actual passes by later-spawned vehicles. The test
  now counts either direction of a physical longitudinal order reversal.
- `junction-containment-final-check.log`: lint, typecheck, 258 tests with
  coverage, and build pass. `junction-visual.log`: 15 production scenarios
  pass, including the saved player map and four new junction layouts.
- Connector records include lane, intention, destination, geometry, displayed
  light and simultaneous holders at the observed instant. Coverage of all
  phases and physical body-volume conflicts remains open. Lane-change
  occupancy is still keyed to the new lane before the lateral manoeuvre
  finishes. Do not mark junctions, signals or vehicle behavior complete.

## Physical junction conflicts and dual lane occupancy checkpoint

- New measurement: `tests/sim/support/bodies.ts` tests every pair of drawn
  vehicle bodies (oriented rectangles at the rendered pose, 4 cm tolerance)
  for overlap. At 8ce8675 it found **120 overlapping pairs** in seven seeded
  150 s scenarios (six junction layouts plus the saved player map) and 290
  at intensity 3 over 300 s. Categories: lane changes (84), followers driving
  into a leader that took a different movement out of the same lane (33),
  and junction bodies whose centrelines never cross (opposing left turns,
  a bus swinging over the adjacent turn, a truck clipping a skewed through).
- Root causes: (1) conflict points were centreline intersections released when
  the REAR passed the crossing point; (2) diverging movements from one lane
  were excluded from conflicts and invisible to car-following; (3) a lane
  change moved occupancy to the new lane at once while the body slid across
  for about a second; (4) lane-change and spawn gaps read only the occupancy
  list, missing tails of vehicles already on a connector.
- Fixes: `world/conflictPoints.ts` sweeps the drawn body for small, car and
  heavy classes and stores a zone per class pair; claims are shared only
  when bodies cannot touch and released when the centre leaves the zone
  (`sim/intersections/claims.ts`); `divergeObstacle` follows sibling
  movements through their shared start; `Vehicle.shadow` keeps a
  lane-changing vehicle in both lanes; `SimWorld.bodiesIn` feeds lane-change
  gaps and spawn checks; admission refuses a heavy turn while an unadmitted
  vehicle stands inside its sweep at another stop line, and stops arrivals
  short of such a zone.
- Result (`docs/audit/junction-physical-conflicts.json`): **zero** body
  overlaps in all seven scenarios at intensity 2 and in 21 runs at intensity
  3 (seeds 7, 1234, 99991; 300 s). In the running dev game (four-way avenues,
  intensity 3, 240 s, 134 vehicles) zero overlapping ticks.
- Throughput, connector entries at intensity 2: 1126 before, 1060 after
  (-6 %); at intensity 3 seed 7: 2059 before, 1889 after (-8 %). Losses are
  concentrated on five-leg (-22 % to -32 %), one-way and mixed-lane layouts,
  where heavy vehicles now wait for bodies they would previously have
  driven through. Part of the old throughput was physically impossible.
- Open, measured: saturated discharge is poor before and after — about 3 to 4
  vehicles inside a four-way avenue box during green with 13 to 18 queued per
  lane; permissive lefts and protected throughs block each other through the
  zones. The body pose is a centred tangent rectangle, so heavy vehicles
  swing both ends OUTWARD on a turn instead of off-tracking inward; that
  inflates heavy zones and produced the recorded
  `junction-queue-intrusions.json` cases. Both belong to the signals and
  vehicle-behaviour blocks and are not solved here.

## Lane-change easing, pedestrian freezes and outbound-leg signals

- Lane changes slid at a constant 3.4 m/s that started and stopped in one tick,
  heading snapping on and off. The offset now follows a quintic minimum-jerk
  profile (`laneChangeOffset`, about 3 s a lane) and the body points along its
  real velocity. The longer slide exposed a vehicle driving its own body into a
  queue still in the lane it was leaving; `shadowLeaderObstacle` brakes for it.
  `tests/sim/collisions.spec.ts` stays at zero overlaps.
- Pedestrians on the saved player map spent 27 % of their time standing while
  wanting to walk (worst 151 s), and waited up to 189 s at kerbs, including at
  WALK. Causes found and fixed: rigid personal discs deadlocking head-on
  meetings; corners one person wide; walkers bound round a corner queueing
  behind people waiting to cross (the next edge is now chosen before the
  kerb); blocked transfers stepping back each tick (the twitch); waiters
  boxing each other in at the kerb; uncontrolled gap acceptance treating a
  stopped queue as arriving traffic; turning vehicles never giving way to
  people waiting at a WALK or zebra kerb. After: 2.4 % held time, worst kerb
  wait 47 s, person-person contacts under 0.2 m about 107 pair-ticks in 240 s
  (was 0 while frozen). `tests/sim/pedFlow.spec.ts` guards it.
- A one-way leg leaving a signalised junction got a signal group, a head facing
  an empty road and a stage of green for nobody. Groups now come from legs
  with inbound lanes only; `signalMovementMatrix.spec.ts` checks it. An audit of
  every connector in seven layouts found turn labels matching geometry, no
  crossing movements within one approach and correct group membership.
- Still open here: permissive left turns share the green with opposing
  through traffic by design; protected-left phasing, discharge rate and
  person-person squeeze contacts need further work.

## Lane changes as driven curves, right of way and vehicle signals

- Reported: cars "float sideways" into the next lane. The lane-change offset was
  a minimum-jerk profile in TIME, so a car creeping in a queue kept moving
  sideways while barely moving forwards; its drawn body moved up to 88 degrees
  off the direction it pointed in (over 45 degrees on 5 % of lane-change
  ticks). The offset is now a curve in DISTANCE (`laneChangeLength`), steered
  from the rear axle, with a shadow in the old lane until the change completes.
  Rear-axle slip is now under 2 degrees (`tests/sim/pose.spec.ts`); body
  overlaps stay at zero (70bdf0a).
- A movement lost protection whenever anything conflicting was green, so a
  through yielded to the opposing left exactly as the left yielded to it; queue
  heads at green stood still 45 % of the time. Protection is now a hierarchy
  (through > right > left > U-turn): through movements held on conflict at
  green fell from 4,754 to 1,360 ticks; total throughput is within noise
  (be65467). The queued saturation headway measures 1.8 s, which is realistic;
  the remaining loss is permissive lefts that cannot wait inside the box.
- Indicators now show turns ahead and wanted lane changes, and flash; front
  wheels steer on the path's curvature and hubs roll (589c16f).
- Pedestrians have an age and gender, families walk closer, and the cosmetic
  catch-up offset can no longer sweep one body through another (3a5595e).
- Known, seed-sensitive: `tests/sim/pedFlow.spec.ts` measured a 12.4 s knot at a
  zebra mouth with 70bdf0a alone (a walker leaving a crossing into the queue
  waiting at that kerb); it passes from 3a5595e on.
- Curvature speed: `MAX_LATERAL_ACCEL` was declared and never read, so bends
  were taken at up to 10.3 m/s² on one urban bend and 22 m/s² on the player
  map. `sim/vehicles/curvature.ts` now caps speed so every bend ahead is
  taken at a comfortable lateral acceleration, braked for in advance: worst
  3.9 and 3.6 m/s² after (d9abf82, `tests/sim/curvature.spec.ts`).
- Dead exports: 26 declarations referenced nowhere were removed (3847022).

## Current pedestrian navigation work (verification pending)

The active worktree fixes corridor reversals, inconsistent physical/perceived
positions, order-dependent neighbour velocities, missing footway links at
two-leg nodes, unpainted crossing edges, generated furniture at crossing
landings, and agent movement on crossings. It also makes crossing admission
check vehicle bodies already occupying the zebra. The investigation and
primary research are recorded in [pedestrian-navigation-audit.md](pedestrian-navigation-audit.md).
The latest checkpoint passed `npm run check` (526 tests, 4 expected failures,
2 skipped, lint, typecheck and build) and `npm run verify:visual` (16 scenarios,
three-webgl backend). The broader 80-seed fuzz hunt, full roster-wide facial
expression coverage, broad occupant visual inspection, and saturated traffic
flow remain open. Block 7 and the full project remain open.

## September 28 branch integration review

The branch adds freeform road editing, authored road heights, destination
routing, a building studio, pedestrian access to doors, turn paths, citizen
casting and vehicle models. Lint, typecheck, production build, the 16-scenario
WebGL verification and the building browser verification passed during the
integration review. The full-map driving test exposed a discontinuous heading
at connector exits; `sim/pose.ts` now samples the following lane on both sides
of the transition, with a focused regression test.

The six-seed fuzz hunt still finds projected vehicle overlaps on folded junction
movements and near independently drawn ground and bridge approaches. The
minimized cases are `open-body-overlap-on-folded-turn.json` and
`open-unrelated-body-overlap-near-bridge.json`. Both remain **open**: the turn
clearance check bounds one body against the asphalt but does not prove that two
vehicles can safely occupy the movement, and the second case needs a height-aware
contact check. These defects are not resolved by the routing and turn-path commits.
