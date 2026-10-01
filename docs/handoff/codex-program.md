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
| 1 | new base for roads and pedestrians | **in progress**: see the breakdown below |
| 1b | vehicle motion: measure and fix on the new base | not started |
| 2 | skin, phenotype, sex profiles, child clothes | not started |
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
4. **No subagents** (player's order); do the work yourself.
5. **When a stage meets its acceptance criterion** in the plan:
   - show the photos;
   - ask the player in one line before switching the default and deleting the old code;
   - continue with the next stage at once, without waiting idle.
6. **Before every stage** do focused internet research: several sources, primary sources, not just
   the first result. Record it in `docs/research/<topic>.md`.

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
