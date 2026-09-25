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
| P0 | Build identity: find what the user runs, consolidate master+stabilize, stamp on screen, recapture the reported defects | every check is worthless on a build nobody sees | in progress |
| P1 | Inspection harness: dev camera, frame by id, interior mode, hi-res, fixture map, runtime census | P2–P7 are unverifiable without it | partly done on stabilize (ce5d0a7, 8b43722); census + stamp in shots todo |
| P2 | Occupants: typed anchors contract, real seated pose, capsule test, idle life, steering, opaque roof, whitelist, variable occupancy | complaint #1 | todo |
| P3 | People whitelist manifest + single `pickCitizenModel` + strict dress code + census | P2/P4 draw from it | todo |
| P4 | Motorbikes and riders rebuilt | | todo |
| P5 | Cars rebuilt by loft, anchors for P2 | | todo |
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
- P0: the user's build lacks every stabilize fix because they live only on `stabilize/core` (e6b1446, e17ae4a, 7efb403, 72f06a8 are contained by no other branch). Servers found: `vite preview` on 127.0.0.1:5311 serving `Road/dist` (built 2026-09-24 21:57 from master), and a dev server on 5220 from worktree `wt-check` at 7537d24 (2026-09-24 10:49). Ports 5199/5320/5391 belong to another project (Documents/builder).

## 5. Discarded hypotheses (with evidence) — do not repeat
- (from stabilize-state.md §6, still valid) AO/shadows as the kerb smear cause; straight nose-to-rear gap guard for hooked turns; re-drawing party ages; shader gutter.

## 6. Environment
- Branch stabilize/core, worktree road-stabilize, head 2ff329a at session start. Master fe11669.
- Other live Claude sessions at start: two on another project (pagebuilder); none on Roadcraft.

## 7. Next step
P0: run `npm run check` in road-stabilize (one heavy job), then verify:visual on a free port, fast-forward master, rebuild Road/dist, start Road dev server, capture with stamp.
