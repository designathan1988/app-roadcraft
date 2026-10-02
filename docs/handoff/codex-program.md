# Codex program: the whole master plan (stages 0–13)

From 2026-10-01 Codex delivers the **entire** master plan the player approved
([master-plan.md](master-plan.md), Portuguese, verbatim): people, vehicles, buildings and roads. The
pedestrian engine ([people-crowd.md](people-crowd.md)) is only Stage 1.

Work through all the stages without stopping between them. Pedestrians come first, then the rest
in the plan's order.

## Status at 2026-10-01 20:50

| Stage | What | State |
|---|---|---|
| 0 | measurement base (harness, probe) | **done**, 1c431c3 |
| 1 | new base for roads and pedestrians | **deferred by player**: remaining work at the end of this file |
| 1b | vehicle motion: measure and fix on the new base | **default in Drive v2**, player approved; b43bd33, 2695613 |
| 2 | skin, phenotype, sex profiles, child clothes | **in progress** |
| 3 | live expression | not started |
| 4 | crowd without repetition, plus memory | not started |
| 5 | citizen registry, day clock, day/night | not started |
| 6 | mind, schedule, inhabited buildings (abstract) | not started |
| 7 | parking and lot accesses | not started |
| 8 | a person drives (no more "pretend to get in") | not started |
| 9 | smart cars, signals | not started |
| 10 | car generator and Vehicle Creator | not started |
| 11 | social interactions | not started |
| 12 | free roads (cross-section editor, roundabout, new types) | not started |
| 13 | free building, then interiors | not started |

Stage 1 in detail:
- Cross-section: f7dbfa5.
- Pedestrian graph: ab4a3d0.
- Detour crowd engine, behind `?people=crowd`: the battery has 13 of 19 scenarios green; in the
  city, backward motion fell from 1395 to 466.
- Gait: b0de1df.
- Still open in Stage 1:
  - 6 scenarios;
  - the long waits in the crowd scenario;
  - stops of up to 12 s in the city;
  - switching the default engine;
  - deleting the old engines.

Update this table in every stage-closing commit.

Stage 1b: the 90-second player-city measurement changed emergency-braking
violations 7 -> 0 and instant stops 2 -> 0. Jerk p95 stays 2.5 m/s3; pose jumps
stay zero. Stop/go count 297 -> 298. Six collision tests pass, including eight
unchanged 150-second traffic scenarios. Browser probe confirms the flag runs
without page errors and without observed instant stops; photos are under
`docs/audit/2026-10-01/vehicle-motion/{before-wide,after-wide}`. Browser population
differs from the headless city setup, so their counts are not interchangeable.

## Working mode (player's order: fast, without losing rigour)

1. **Heavy coding, light tests.** Implement change after change without stopping. Each change gets
   only the fast check of what it touches (the 19-scenario battery runs in ~15 s, or the touched
   specs, plus `tsc`) and its own commit, so a culprit can be found later.
2. **Heavy verification per batch:** every hour, or every 4–5 changes, and always at a stage's end.
   It covers:
   - the player city;
   - a review of the whole batch;
   - before/after photos shown in the chat;
   - push.

   If something broke, use the separate commits to find which change did it, and fix it.
3. **Net gains go in.** Commit when the total gain clearly outweighs small regressions, nobody stops
   arriving, and no rule is broken. Record the regressions and fix them next.
4. **Agents:** up to 3 per conversation (see "Two conversations in parallel").
5. **When a stage meets its acceptance criterion** in the plan:
   - show the photos;
   - ask the player in one line before switching the default and deleting the old code;
   - continue with the next stage at once, without waiting idle.
6. **Before every stage** do focused internet research: several sources, primary sources, not just
   the first result. Record it in `docs/research/<topic>.md`.

## Two conversations in parallel (player's order, 2026-10-01 23:00)

Two Codex conversations now work at the same time:
- **A** is in `C:\Codex-Shared\Road` on `master`. It owns stages 1b to 9 and 11, plus the deferred
  pedestrian work, and it is the integrator.
- **B** is in the worktree `C:\Codex-Shared\Road-b` on `codex/stages-b`. It owns stages 12, 13
  and 10.

They coordinate through the live board `C:\Codex-Shared\road-coordination.md`, which is outside git.
That board holds the ownership of code areas, the shared files, the merge protocol and the claims.
Read it before every batch.

Each conversation may use up to 3 agents. This replaces the earlier "no subagents" rule.

## No overhead

At 20:54 the player complained that the project had stopped while time went to extras:
- 5 photo scripts;
- JSON dumps of 100,000 lines;
- a report per step;
- a test per detail.

So:
- use the existing tools;
- the commit message is the report;
- photos at the end of a batch or stage only;
- regression tests only where they matter.

Measure every change, but spend most of the time on code that changes the game.

## Rules that never change

- Never cheat a measurement: scenarios, thresholds, spawns and durations stay untouched unless the
  player authorises a change.
- A new system is built and switched on; do not patch the old one (CLAUDE.md).
- People: Detour alone moves bodies; orientation and animation only read velocity.
- Vehicles: the same principle. One owner for position (the integrator), and no second physics
  that corrects it.
- Show everything in the chat:
  - photos as images, before and after;
  - plain Portuguese;
  - the game left open where the change is visible.
- Commits:
  - explicit paths only;
  - honest messages in English, with numbers before and after;
  - push with `git push https://github.com/designathan1988/app-roadcraft master:main`, never to
    `origin`.
- Machine limits: at most 2 test runs and 1 browser or dev server at a time; nothing longer than
  10 minutes.
- All player-facing strings go in i18n (en and pt-BR). Every gesture needs a touch equivalent.
  Licences are recorded (master plan, execution rules).
- Other sessions' uncommitted files are not yours. In particular `.agents/skills/roadcraft-clothes/`
  belongs to the 3D-assets session. Before Stage 2 (clothes), read what it holds and tell the player
  how you will use it.

## Deferred pedestrian work (player order, 2026-10-01)

Continue with stages 1b through 13 now; return to these items afterwards.

- `fb85974` restores stable facing, `TURN_TIME = 0.25`, and crossing/passage
  waiting directions. It retains `clearSpot` independent of visual heading.
  The apparent backward improvement in `3ca3e19` was an orientation artifact,
  not better movement. The corrective commit is already pushed.
- Baseline: 13/19 scenarios pass. Remaining failures: bidirectional-10, crowd,
  bidirectional-dense, side-by-side, gap-two, obstacles. Everyone arrives.
- Crowd: longest stationary spell 19.9 s, longest starvation 39.4 s.
- Player city, 60 s: backward 504 ticks, unexplained stop 11.68 s, physical
  starvation 15.78 s. Compare backward and turn together; never trade reverse
  movement for spinning. Measure physical contacts as well.
- Companion shared-route experiments were discarded, not committed: some
  reduced stops but introduced sliding/contact regressions. No experimental
  shared-route code remains active.
- Keep `?people=crowd` optional. Default promotion and old-engine removal
  remain subject to player approval after the remaining defects are fixed.
