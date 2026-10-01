---
name: roadcraft-people-crowd
description: Continue the Roadcraft pedestrian crowd engine (Recast/Detour, `?people=crowd`) - fixing walking defects, measuring them, photographing them in the game, committing and reporting. Use for ANY work on pedestrians, people movement, crowds, zebras/crossings for people, narrow passages, gait/animation of walkers, or the crowd scenario battery in Roadcraft. Never patch the old ORCA People engine instead.
---

# Roadcraft: the pedestrian crowd engine

The state, the map of files, the baseline numbers, what was REJECTED and the open work list are
in `docs/handoff/people-crowd.md`. The player's two orders, which are binding, are in
`docs/handoff/people-crowd-orders.md`. Read both, plus `AGENTS.md` and `CLAUDE.md`, before the
first edit. Work through section 7 of the handoff **in order**.

## The loop, for every defect (no exceptions)

1. **Reproduce** it: a battery scenario, or the player city (`zzCity.spec.ts`), with a number.
2. **Trace** it: `zzTrace.spec.ts` (`SC`, `T`, `FROM`, `EVERY` in ticks, `ONLY` ids), or a
   classifier like `zzCity`. Find the person, the tick and the layer that went wrong:
   - intent: destination, corridor, wait place, manoeuvre;
   - the Detour solver;
   - the readback or the gait.
3. **Name the cause** in one sentence, with the trace lines that prove it.
4. **Fix the cause** in the real implementation (`crowd.ts`, `crowdNav.ts`, `citizenGait.ts`...).
   No new `*_fix3` files and no rule special to a scenario.
5. **Run the whole battery** and compare with the last report line by line. A regression elsewhere
   means the fix is wrong. Remove it completely rather than stacking another fix on top.
6. **Look at it in the game** for anything about motion: `scripts/crowd-shots.mjs`, a FIXED camera,
   approach → conflict → resolution → exit. Open each image and say in writing what you see.
7. **Commit** (rules below), then report.

If two attempts at the same defect fail, stop. Write down what each attempt measured and why it was
wrong, then research how established crowd simulators solve it before a third attempt. Never try a
new technique on the same broken base.

## Never

- **Never move a body outside Detour.** No snap, push, teleport, clamp, or position or velocity
  rewrite after `crowd.update`. Change intent (target, max speed, filter, wait place) only.
- **Never let orientation feed back into movement.** Heading and gait only READ the velocity.
- **Never tune for a counter.** You may not change a parameter, radius, geometry, spawn, destination
  or duration so that a scenario turns green. If a scenario is objectively wrong:
  - document the error in the fixture;
  - keep its difficulty;
  - tell the reviewer in the report.

  The thresholds in `crowdScenarios.spec.ts` change only with the player's approval.
- **Never have a preset per scenario.** There is one Detour configuration (`configureAvoidance`).
- **Never retry an approach listed as REJECTED** in the handoff (section 5).
- **Never touch vehicles** (`src/sim/vehicles`, `intersections`, `signals`) beyond reading them.
- **Never delete the old engines or switch the default** without the player's explicit OK in the
  chat.

## Machine limits (the player plays on this computer)

- Run tests only through `node scripts/test-light.mjs <spec files>`: one worker, below-normal
  priority, in the foreground, a couple of minutes at most.
- No full suites of ten minutes or more, nothing heavy in the background, and one heavy job at a
  time. No parallel subagents.
- A dev server only while photographing: `PORT=5180 npm run dev`. Stop it afterwards. Never stop
  servers you did not start.
- Write scripts to files and run them; avoid shell heredocs.

## Commits and pushes

- One commit per verified step: the fix, the battery report, and the photos (JPEG; convert PNGs).
- Stage **explicit paths only**. Never `git add -A` or `git add .`.
- Never commit any of these:
  - `tests/**/zz*.spec.ts`, `zz-*.txt`, `zz-report.jsonl`, `.claude/_*.mjs`, `*.png` photos;
  - other sessions' files: `.agents/skills/roadcraft-clothes/`, `docs/codex-prompts-modelos-3d.md`,
    `docs/audit/2026-09-30/`.
- Write the message in English and honestly. Its body states:
  - what changed;
  - the cause it removes;
  - the battery numbers before and after;
  - what is still failing.
- End the message with `Co-Authored-By: Codex <noreply@openai.com>`.
- `npx tsc --noEmit` must be clean, and eslint must be clean on the files you touched.
- Push after every commit: `git push https://github.com/designathan1988/app-roadcraft master:main`.
  - Never push to `origin`, which is a different repository.
  - Never force-push, rebase or amend pushed commits.
- Before any edit, run `git status`. If files outside your work changed (another session), do not
  touch, stage or revert them. Tell the player.

## Report to the player after every step (in Portuguese, plain words)

```
O QUE ESTÁ NO JOGO AGORA: <com ?people=crowd / por padrão> ...
O QUE MUDOU E POR QUÊ: causa encontrada (trace), correção estrutural
NÚMEROS: bateria antes -> depois (cenários verdes, ré, deslizes, empurrões, starvation);
         cidade do jogador se medida; custo ms/tick se medido
FOTOS: caminhos dos .jpg, e o que se vê em cada um
AINDA FALTA: próximos itens da seção 7 do handoff
COMMIT: <hash> (push feito em app-roadcraft main)
```

"Seams landed, behaviour unchanged" means the player sees nothing new: say that plainly. Never
report a step as done from numbers alone. The photos are the proof.
