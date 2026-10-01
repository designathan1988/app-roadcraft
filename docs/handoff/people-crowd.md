# Handoff: the pedestrian crowd engine (Detour)

Owner from 2026-10-01: **Codex**, working in this checkout (`C:\Codex-Shared\Road`, branch
`master`). Reviewer: Claude, in a separate session, after every delivery (see the review log at the
end). The method you must follow is the skill `.agents/skills/roadcraft-people-crowd/SKILL.md`.
Read that, `AGENTS.md`, `CLAUDE.md` and the player's orders
([people-crowd-orders.md](people-crowd-orders.md)) before you change anything.

## 1. What is LIVE in the game, and what is not

- **Default game (no flag): unchanged.** People are walked by the ORCA People engine
  (`src/sim/people/people.ts` + `orca.ts`), with the defects the player rejected (backward steps,
  milling, sliding).
- **`?people=crowd`: the new engine.** Pedestrians are Recast/Detour crowd agents
  (`recast-navigation`, MIT). This is the system the player ordered. It is not finished and not the
  default.
- Commit holding the work so far: `40f149b` ("People: Detour crowd engine behind ?people=crowd").
  It was pushed to `designathan1988/app-roadcraft` main.
- First continuation step: [crowd-step-01.md](crowd-step-01.md). Companion places
  use a navigation frame instead of the leader's visual heading; city backward
  ticks 1395 -> 1176, battery still 8/19. Hygiene and movement work remain open.
  The player's relayed Claude review at 16:06 approved committing this step.

## 2. Architecture (keep it)

```
world/walkways.ts      footways, corners, crossings (from the road cross-section)  ── the walkable graph
sim/people/crowdNav.ts graph → triangle strips → Recast navmesh (tiled; cells 0.1 m)
                       furniture = obstacles; zebras = their own Recast AREA (ZEBRA_FLAG 2, WALK_FLAG 1)
                       findNarrows(): passages narrower than 2R near obstacles (one-person passages)
sim/people/crowd.ts    INTENT only, in layers, above Detour:
                         1 DESTINATION (goal)          never replaced
                         2 CORRIDOR (laneTarget)       Detour's path, walked on the right
                         3 PLACES TO WAIT              zebra not granted (crossings/permission.ts);
                                                       narrow passage one way at a time (admit/queueFor)
                         4 LOCAL MANOEUVRES            makeWay (step aside, 4 s, back), overshoot,
                                                       approach (brake to a place), companions beside leader
                       Detour crowd.update(DT) = the ONLY thing that moves a body
                       read back → heading (visual only) → publish PedView
render/citizenGait.ts  plays PedView: idle below 0.14 m/s (MOVE_FROM_STILL), forward loco above
```

Hard rules that come from the player's orders:
- Detour is the movement authority. There is no snap, push, teleport, clamp or position fix after
  `crowd.update`.
- Orientation never moves the body.
- Stopped means stopped.
- There is one parameter preset for every situation.
- Scenarios are never changed to make a counter green.

## 3. Files

| File | Role |
|---|---|
| `src/sim/people/crowd.ts` | the engine: spawn, goals, intent layers, zebra grants, passages, `step`, `publish`, `inspectCrowd`, `addScriptedWalker` |
| `src/sim/people/crowdNav.ts` | navmesh build, `AGENT_RADIUS` 0.27 m, tile size, zebra areas, `findNarrows` |
| `src/world/walkways.ts` | pedestrian graph (footways, corners, crossings) |
| `tests/fixtures/crowdScenarios.ts` | the 19 fixed adversarial scenarios (also run in the game) |
| `tests/sim/people/crowdScenarios.spec.ts` | the battery and its metrics; `CROWD_REPORT=<file>` writes one JSON line per scenario |
| `tests/sim/agents/defects.spec.ts` + `tests/sim/support/agentDefects.ts` | city harness; `AGENT_ENGINE=crowd` |
| `scripts/probe-agents.mjs` | probe in the running game (`--query=people=crowd`), with hotspot photos |
| `scripts/crowd-shots.mjs` | one scenario in the running game, fixed camera, timed sequence → `<name>.jpg` |
| `src/main.ts` | `?people=crowd` switch; `window.__roadcraft.crowd` and `.step` hooks |
| `src/render/citizenGait.ts` | how a `PedView` is animated |

There are also scratch tools in the checkout. They are **never committed**, but you can use and edit them:
- `tests/sim/people/zzTrace.spec.ts`: a tick-by-tick trace of one scenario. Env: `SC` (scenario),
  `T` (seconds run), `FROM` (seconds), `EVERY` (ticks, 60 a second), `ONLY` (ids, comma list).
  It writes `zz-trace.txt`.
- `tests/sim/people/zzCity.spec.ts`: who walks backwards in a city and why. It writes `zz-city.txt`.
- `tests/sim/people/zzCost.spec.ts`: cost per tick and per stage. It writes `zz-cost.txt`.
- `zzJumps`, `zzStill`, `zzMeshWidth`, `zzOnRoad`, `zzCityMesh`.

## 4. Decisions already measured (do not re-tune them blindly)

- **Radius 0.27 m.** Pairs of drawn bodies were photographed side by side: at 0.44 m apart the arms
  cross (`docs/audit/2026-10-01/body/`, `body27/`).
- **ACCEL 2.5 m/s².** Detour brakes for a corridor end within 2R (0.54 m), so the acceleration must be
  at least v²/(2·0.54) = 2.4 m/s². At 1.6 m/s² people overshot their place by 0.8 m and walked back.
- **Separation OFF** (flags 1|2|8|16). Separation pushes people back against the avoidance.
- **Detour "high" preset, default weights** (`configureAvoidance`). One preset for everything.
- **Zebras are a Recast area.** The crowd filter 1 is WALK only. `zebraAccess` gives filter 0 only
  while the zebra is granted (companions copy their leader's grants). Result: trespass 0.
- **WAIT_BACK = 2R + 0.1 m** (derived from the closed area's edge).
- **`approach`:** maxSpeed = √(2·BRAKE·d) near a place. Detour's own linear ramp needs 3.4–4.7 m/s².
- **Narrow passages** run as one-lane bridges (`admit`):
  - one way at a time;
  - the oldest waiter goes first;
  - the turn changes after 8 s (`TURN_AFTER`);
  - the wait slot leaves a body's room for those coming out.
- **Everybody always avoids.** Detour avoidance is reciprocal: switching it off for standing people
  made walkers shove them.

## 5. REJECTED: measured worse, do not retry

- Pairwise yield with side spots. It piled people up at the passage mouth.
- A face-to-face pause. Release-both went from 46 to 87 s and the crowd got worse.
- "Standing or arriving people do not avoid". It made walkers shove them.
- keepRight retargeting every 0.3 m.
- The `lanes.ts` lane engine. It was a chain of threshold patches and was deleted.
- Patches on the ORCA engine: no-reverse, pivot, overshoot and companion rules.
- A funnel "horizon" stand-in point.
- Anything that moves a body after Detour.

## 6. Baseline at hand-off (`docs/handoff/crowd-baseline.jsonl`)

The battery takes ~18 s. **8 of 19 scenarios pass.** Everybody arrives in all 19, trespass is 0 and
jumps are 0.

| scenario | backward ticks | slides | reversals | stood s | starved s |
|---|---|---|---|---|---|
| crowd (40, signals) | 535 | 102 | 4 | 11.3 | 18.1 |
| bidirectional-dense (30) | 211 | 0 | 3 | **28.8** | 4.3 |
| bottleneck (12) | 98 | 0 | 1 | 0.8 | 2.3 |
| gap-two (10) | 70 | 0 | 0 | 0.7 | 3.6 |
| queue (8) | 55 | 0 | 3 | 0.5 | 1.1 |
| release-both (12) | 53 | 0 | 1 | 0.9 | 1.3 |
| obstacles (8) | 25 | 0 | 1 | 0.1 | 1.0 |
| bidirectional-10 | 23 | 0 | 0 | 0.3 | 1.0 |
| slow-ahead | 10 | 0 | 0 | 0 | 0.5 |
| group | 6 | 0 | 0 | 0.8 | 0.6 |
| side-by-side | 0 | 1 | 0 | 0.1 | 0.6 |

**The player's city**, 60 s with `?people=crowd` (`zz-city.txt`, `zz-cost.txt`):
- 334 people, **1395 backward ticks**.
- About 950 of those ticks are INTENT, not avoidance: the desired velocity points behind the body.
  The biggest groups are companions under 0.8 m/s (≈530) and walkers (≈400). So places and targets
  that land behind the body are the first suspect, before the solver.
- **People cost 12–17 ms per tick**: decide 7.8, passages 3.4, readback 2.9, detour 2.1, makeWay 0.6.
  Cars only cost 2.4–3.6 ms. This is too slow for the default.
- The city navmesh used to abort in the WebAssembly (too many tiles). That is fixed: `tileSizeFor`
  grows the tile size to fit `MAX_TILES`.

## 7. Open work, in order

0. **Hygiene.**
   - `step()` carries profiling scratch (`__crowdProf`). Remove it, or make it a proper opt-in
     inspector.
   - Three mechanisms were added in the last hour and never checked against section 5: the "ease"
     state (`EASE_AFTER`/`SHUFFLE`/`EASE_HOLD`/`EASE_GOING`), `unlock` (`DEADLOCK_AFTER`) and the
     companion place "beside if the ground is there, otherwise in line". Each one stays only if a
     trace shows it removes a cause. Otherwise remove it.
1. **Backward motion and slides** (the player's main visible defect).
   - Trace the city's INTENT-backward cases first: companion places and corridor targets behind the
     body.
   - Then the avoidance retreat in dense counterflow.
   - The renderer must play what the body really does: slow, sideways and backward displacement as
     steps, never as idle sliding (`citizenGait.ts`, below `MOVE_FROM_STILL`). Point 7 of the orders:
     the gait follows the velocity, and the velocity never waits for the body to turn.
2. **Standing people shoved** by passing flows (crowd: 102 slide ticks). Find the cause by trace.
   Point 6 forbids an external fix.
3. **Starvation and standing in dense flows** (bidirectional-dense stood 28.8 s, crowd starved 18 s).
4. **Cost.** People must cost at most 5 ms per tick at 334 people in the player city
   (`zzCost.spec.ts`). Measure per stage, then remove the cause.
5. **Player city in the game.**
   - Run `node scripts/probe-agents.mjs docs/audit/<date>/city-crowd --base=http://localhost:<port> --seconds=60 --query=people=crowd`.
   - Take the hotspot photos and look at them.
6. **Photos** of all 19 scenarios with a FIXED camera (`scripts/crowd-shots.mjs`), covering approach,
   conflict, resolution and exit.
7. **Default and deletion.** Only after 1–6 are met, and only after asking the player:
   - make the crowd engine the default;
   - delete the ORCA People engine and the old navmesh pieces it alone uses;
   - keep `?peds=legacy` until the traffic suites stop using it (`simOf` in the tests still installs
     the legacy pedestrians);
   - update the `AGENTS.md` rows that point to `sim/peds`.
8. **Not now: vehicles.** The player said: pedestrians first. Do not touch `src/sim/vehicles`,
   `intersections` or `signals` beyond reading them.

## 8. Definition of done (the player's point 15, made measurable)

- The battery has all 19 scenarios green with the CURRENT thresholds of `crowdScenarios.spec.ts`,
  unchanged. Every threshold change needs the player's approval.
- In the player city (60 s, `?people=crowd`):
  - backward ticks 0;
  - slides 0;
  - jumps 0;
  - trespass 0;
  - nobody stands more than 3 s on a zebra, or more than 2 s on a footway, without a reason (signal,
    queue);
  - people cost at most 5 ms per tick.
- Photos of the scenarios and of the city, from a fixed camera, looked at one by one. They must show:
  - continuous walking;
  - early and smooth avoidance;
  - overtaking;
  - two-way flow;
  - one-way passage through gaps;
  - queues that move;
  - no dance, jitter, backward walking, sliding, teleport, overlap or walking through furniture.
- Then the default switch and the deletion (item 7).

## 9. Commands

```bash
npx tsc --noEmit
node scripts/test-light.mjs tests/sim/people/crowdScenarios.spec.ts
CROWD_REPORT=zz-report.jsonl node scripts/test-light.mjs tests/sim/people/crowdScenarios.spec.ts
SC=bottleneck T=40 FROM=10 EVERY=6 ONLY=3,7 node scripts/test-light.mjs tests/sim/people/zzTrace.spec.ts
CITY=player-city T=60 node scripts/test-light.mjs tests/sim/people/zzCity.spec.ts
node scripts/test-light.mjs tests/sim/people/zzCost.spec.ts
PORT=5180 npm run dev
node scripts/crowd-shots.mjs http://localhost:5180 docs/audit/<date>/scenarios gap-one 6 0.5 8 30 1.2
node scripts/probe-agents.mjs docs/audit/<date>/city-crowd --base=http://localhost:5180 --seconds=60 --query=people=crowd
```

- The commands are written in bash syntax. In PowerShell, set variables first, e.g.
  `$env:SC='bottleneck'; $env:T='40'; node scripts/test-light.mjs ...`, and clear them afterwards.
- Run the dev server in the background only while you take photos, then stop it.
- Other dev servers may already hold port 5173. Use your own port, and never stop servers you did not
  start.

## 10. Review log (written by the reviewer)

| date | commits reviewed | verdict | notes |
|---|---|---|---|
| 2026-10-01 | 40f149b | baseline | hand-off state recorded above |
| 2026-10-01 16:06 | none yet (working tree) | **on track** | Item 0 done right: profiling removed; ease, unlock and companion-file each measured by ablation. Without ease, backward doubles (1086→2154) but slides fall (103→41) and the stood maximum falls (28.8→4.4 s): it is doing something, so explain the cause before keeping it as it is. Without unlock, 5 people never arrive and starvation reaches 80 s: keep it. Without file, the change is negligible: keep it only if a trace shows a case it handles. Real cause found: the companion place followed the leader's VISUAL heading (point 7). Fixed with `routeDirection`, proved by `crowdIntent.spec.ts` (fails before, passes after). City backward 1395→1176; battery unchanged. To do: **commit and push** this step now; the next cause is `walk <0.8 INTENT` (215); check whether bodies overlap at +3.5 s in `codex-crowd-intent/group-conflict/group.jpg`. |
| 2026-10-01 16:15 | a3d5c82 | **right work, too slow, no parallel agents seen** | The commit is honest and verified: route direction for companions, profiling gone, photo loading fixed, step note `crowd-step-01.md`. Good finds left open: `clearSpot` still reads the visual heading (point 7); `askPlace` re-requests the same projected target (fix and spec prepared, uncommitted). Battery still 8/19 with 1086 backward ticks, and nothing new is visible in the game. No agent worktree and no parallel jobs appeared after the order to use agents. The pace has to rise: run the analyses (ease/unlock, shoves, cost) as agents while the main thread fixes; commit the prepared `askPlace` and `clearSpot` fixes. |
