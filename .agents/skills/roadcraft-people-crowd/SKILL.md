---
name: roadcraft-people-crowd
description: Continue the Roadcraft pedestrian crowd engine (Recast/Detour, `?people=crowd`) - fixing walking defects, measuring them, photographing them in the game, committing and reporting. Use for ANY work on pedestrians, people movement, crowds, zebras/crossings for people, narrow passages, gait/animation of walkers, or the crowd scenario battery in Roadcraft. Never patch the old ORCA People engine instead.
---

# Roadcraft: the pedestrian crowd engine

The state, the files, the baseline numbers, what was already tried and the known open work are in
`docs/handoff/people-crowd.md`. The player's orders are in `docs/handoff/people-crowd-orders.md`.

## You own the plan

The player decided (2026-10-01): **you work freely.** You decide:
- the order of the work;
- the approach and the technique;
- which experiments to run;
- how many agents to use and what each one does (you are in ultracode mode; use them whenever they
  speed things up);
- when to change course, go back, or rewrite a whole layer because that is the better path.

Try things, measure, keep what works, throw away what does not. Nobody gives you a task list: the
reviewer (Claude) only audits results.

**Only two things are fixed:** the GOAL and the INTEGRITY RULES below.

## The goal

Section 8 of the handoff: what the player must see in the game, in the 19 scenarios and in the
player city, with fixed-camera photos as proof. "Done" is that, not a green counter.

## Integrity rules (the player's, not negotiable)

1. **Never cheat the measurement.** Do not change a scenario, threshold, radius, spawn, destination
   or duration so that a counter turns green.
   - If a scenario is objectively wrong, fix it, document the error and keep its difficulty.
   - Changing a threshold needs the player's approval.
2. **Detour is the only thing that moves a body.** No snap, push, teleport, clamp, or position or
   velocity rewrite after `crowd.update`. You may change intent and constraints, the gait, or the
   solver's configuration. You may even replace the solver with an established one if you show it is
   better. What you may not do is add a second physics that corrects the result.
3. **Orientation and animation only READ the velocity.** They never change it.
4. **One coherent configuration** for every situation. No preset per scenario.
5. **Not vehicles** (`src/sim/vehicles`, `intersections`, `signals`): pedestrians first.
6. **Ask the player first** before:
   - switching the default engine;
   - deleting the old engines;
   - changing a threshold.
7. **Prove what you claim.** Battery numbers and photos looked at in the game. Never report from
   numbers alone.

Measuring before changing (reproduce, trace, find the cause) is the fastest way to a right fix, so
use it. It is a tool, not a ritual: quick experiments are fine as long as you measure them and keep
only what is better.

## Save the work

- Commit and push often. Every verified improvement is a commit; do not let work pile up.
- Stage explicit paths only; never `git add -A` or `git add .`.
- Never commit scratch (`zz*`, `.claude/_*`, `*.png`) or other sessions' files
  (`.agents/skills/roadcraft-clothes/`, `docs/codex-prompts-modelos-3d.md`, `docs/audit/2026-09-30/`).
- Write commit messages in English and honestly: what changed, why, numbers before and after, what
  still fails.
- `npx tsc --noEmit` and eslint must be clean on the files you touched.
- Push: `git push https://github.com/designathan1988/app-roadcraft master:main`.
  - Never push to `origin`.
  - Never force-push or rewrite pushed history.
- Subagents do not commit or push; you integrate.

## Do not freeze the player's computer

The player plays on this machine:
- at most TWO test runs at once, each through `node scripts/test-light.mjs` (one worker);
- at most ONE browser or dev server (`PORT=5180 npm run dev`), stopped when the photos are taken;
- nothing that runs ten minutes or more;
- never stop servers you did not start.

Reading code, reading traces and planning have no limit. Two agents never edit the same file at
the same time: use separate files or worktrees.

## Tell the player what you are doing

The player cannot see your work unless you write it.
- Before each step, say in one line what and why.
- After each result, say what it showed.
- When you launch an agent, say what it is doing; when it returns, say what it found.
- Never go more than 5 minutes silent.

When a piece of work is finished, report in Portuguese, in plain words:

```
O QUE ESTÁ NO JOGO AGORA: <com ?people=crowd / por padrão> ...
O QUE MUDOU E POR QUÊ
NÚMEROS: antes -> depois (bateria, cidade, custo, se medidos)
FOTOS: caminhos dos .jpg e o que se vê
PRÓXIMO: o que você decidiu fazer em seguida
COMMIT: <hash>
```
