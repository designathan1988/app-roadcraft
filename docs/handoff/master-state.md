# master-state — session state for the P0–P13 round (source of truth after compaction)

Written ONLY by the session that owns the P0–P13 prompt ("CHEGA. LEIA TUDO…").
Rewrite sections in place; do not append logs. Committed with the code.
Loaded after compaction through `Road/CLAUDE.local.md` (git-excluded), which
imports this file by absolute path.

Resume protocol: read this file, reconcile with `git status` / `git log` /
tests (git wins), continue from "Next step" without sending a message.

## 1. Rules (verbatim from the user, Portuguese)

1. PRONTO = teste automatizado verde + inspeção visual em close, no BUILD QUE O USUÁRIO RODA, com o carimbo de build visível na captura (item P0). Qualquer outra coisa é "não feito".
2. "Não consigo ver", "poucos pixels", "orçamento acabou", "fora do escopo", "cortado" e "não coberto" por escolha sua NÃO EXISTEM. Se não dá para ver, construa o jeito de ver. Se algo está difícil, resolva; se uma abordagem falha, tente outra. Registrar um bloqueio só é aceito quando exige decisão do usuário (credencial, ação destrutiva irreversível, contradição real) e depois de terminar todo o resto.
3. Nenhuma mensagem intermediária. Nada de "próximos passos", "se quiser que eu siga" ou pedido de permissão. Esta lista É a autorização. Uma única entrega, no fim.
4. Sem subagentes. Sem estimativas de tempo. Execução rápida e com rigor: investigar, decidir, implementar, validar, commitar, seguir.
5. Código, nomes de arquivo, identificadores, comentários e docs em INGLÊS. Toda string de UI via i18n (en + pt-BR, idioma trocável). Atalhos padrão Windows (Ctrl/Alt/Shift). Todo gesto com equivalente touch.
6. Tudo gerado por código, exceto os personagens, que vêm do pacote Microsoft Rocketbox (MIT) curado conforme P3.
7. Simulação: a lógica só muda para corrigir os bugs de simulação listados em P9 e o congelamento do PED_AGENT (P7), sempre com testes de regressão. O visual lê o estado da simulação e nunca o altera.
8. Não dividir o `main.ts` enquanto outra sessão estiver mexendo nele.
9. Nunca refaça uma abordagem que já falhou (ver "hipóteses descartadas") sem evidência nova registrada.

Delivery: ONE final message, [F]/[I] format, a section per P0–P13, cause → commit → test
table, the hash the user runs with proof, perf before/after, all capture paths, a
NÃO COBERTO section that must be empty (only real user-decision blockers).

## 2. Items, why this order, status

| # | Item | Why here | Status |
|---|---|---|---|
| P0 | Build identity: find what the user runs, consolidate master+stabilize, stamp on screen, recapture the reported defects | every check is worthless on a build nobody sees | done: master ff to b878673 (check green 508 pass / 7 it.fails, verify:visual green); Road/dist rebuilt and preview 5311 restarted; wt-check (5220) moved to master; stamp fixed for servers without git on PATH; recapture docs/screenshots/p0-before |
| P1 | Inspection harness: dev camera, frame by id, interior mode, hi-res, fixture map, runtime census | P2–P7 are unverifiable without it | done 9099bac: scripts/inspect-scene.mjs sets play/ground/structures/cars/interior/bikes/people/census, stamp burnt in, city grid in tests/fixtures/inspectionMap.ts; scene().census() |
| P2 | Occupants: typed anchors contract, real seated pose, capsule test, idle life, steering, opaque roof, whitelist, variable occupancy | complaint #1 | in progress: seat close-ups (harness set 'seats', inspector cut plane fixed) show driver hands off the wheel (wheel was 0.215 m over the hip; now 0.36 per docs/vehicle-model-spec.md), rear legs through front seats (one ride pose for all rows), van/truck driver legs through the floor. Left: rear-seat pose, anchors contract + test, capsule test, idle/steer/brake poses |
| P3 | People whitelist manifest + single `pickCitizenModel` + strict dress code + census | P2/P4 draw from it | mostly done 9099bac: manifest (86 shipped, 56 allowed), citizenCasting.ts, arch test, partyCoherence on real manifest, census 165 figures 0 outside / 0 mixed. Left: 60 close-ups with stamp (P13), drop uniform GLBs from dist (P11) |
| P4 | Motorbikes and riders rebuilt | | todo |
| P5 | Cars rebuilt by loft, anchors for P2 | | in progress (WIP commit on stabilize/core, NOT on master): src/render/carBody.ts - one lofted surface, regions for glass/roof/pillars/doors, styles hatch/sedan/wagon/suv/pickup/van, seating package. Not yet visually checked. tests/render/occupantFit.spec.ts FAILS: hatch rear seat fit 0.82 < 0.9 |
| P6 | Slopes and structures | | partly done on stabilize (e5b6e33, e0c06d6, 77ab833, cbc4279, 8b43722) — verify |
| P7 | Living pedestrians + PED_AGENT freeze | | todo |
| P8 | Scene (asphalt, kerb, gutter geometry, footway, grass, zebras, ring objects, trees, lamps, debug overlay) | | todo |
| P9 | Sim open bugs, zero it.fails | | todo |
| P10 | Modular building constructor | buildings session idle (last commit fe11669 23:03) — owned by me unless it resumes | todo |
| P11 | Performance (incremental rebuild, citizen compression, GPU skinning) | | todo |
| P12 | Licences | | todo |
| P13 | Final validation, captures with stamp, self-critique, git | | todo |

Acceptance: see the prompt; key numbers — wheel–road contact < 2 cm; zero transform
deviation; local road edit < 30 ms; zero it.fails; zero out-of-whitelist spawns; zero
incompatible groups; zero capsule interpenetration; no loose part (ε); zero marking overlap.

## 3. Decisions (and why)
- Work on branch `stabilize/core` in worktree `C:\Users\jonathanrodriguesti\Desktop\Projetos\road-stabilize`; fast-forward `master` to it after each validated milestone so the user's build carries the work (master had not moved since fe11669).
- Inherited from stabilize-state.md: PED_AGENT on footways only, FSM on crossings; party archetype derived from ages (RNG untouched); gutter = geometry from kerb polyline; cars by loft; window pane shortened from the top.

## 4. Confirmed causes
- P0 recapture on b878673: kerb vertical face speckled; cars boxy with dark roof panel, floating mirror boxes; rear passengers' legs through front seats; driver hands off the wheel; one car with a passenger and no visible driver (interior-sedan-299); motorbike blocky, ball helmet; conifer black cones; bridge parapet white speckle; crossing lines cross lane lines; grass yellow blotches; no gutter. No hover debug ring seen.
- The user reported more Rocketbox models exist: the library has 115 (40 adults, 4 children, 73 professions); 80 were shipped. Docs = README + Docs/all.pdf (one image sheet of all avatars).
- P0: the user's build lacks every stabilize fix because they live only on `stabilize/core` (e6b1446, e17ae4a, 7efb403, 72f06a8 are contained by no other branch). Servers found: `vite preview` on 127.0.0.1:5311 serving `Road/dist` (built 2026-09-24 21:57 from master), and a dev server on 5220 from worktree `wt-check` at 7537d24 (2026-09-24 10:49). Ports 5199/5320/5391 belong to another project (Documents/builder).

## 5. Discarded hypotheses (with evidence) — do not repeat
- (from stabilize-state.md §6, still valid) AO/shadows as the kerb smear cause; straight nose-to-rear gap guard for hooked turns; re-drawing party ages; shader gutter.

## 6. Environment
- Branch stabilize/core, worktree road-stabilize, head 2ff329a at session start. Master fe11669.
- Other live Claude sessions at start: two on another project (pagebuilder); none on Roadcraft.

## 7. Next step
Stopped at the user's request after the WIP commit. To resume: fix hatch rear seat room (couple distance / roof over rear heads in STYLES.hatch), make occupantFit green, then run the harness sets cars/seats on 5176 and LOOK at every style before anything reaches master. Master is b878673 (+ nothing from P2/P5). Dev server 'road-stabilize-dev' on 5176 may still be running (preview_stop it).
