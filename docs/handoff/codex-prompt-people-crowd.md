# Prompt para o Codex: motor de pedestres (Detour)

Abra o Codex na pasta `C:\Codex-Shared\Road` e cole o bloco abaixo, inteiro, como primeira mensagem.
Depois de cada entrega do Codex, peça ao Claude a revisão. Ele devolve um veredito e, se for o caso,
um prompt de correção para colar aqui.

```text
Você vai continuar o motor de pedestres do Roadcraft (jogo de cidade em three.js), que roda sobre
Recast/Detour Crowd atrás da flag ?people=crowd. O trabalho até aqui está no commit 40f149b, em
master, neste checkout (C:\Codex-Shared\Road). Trabalhe AQUI, em master. Não crie worktree.

ANTES DE QUALQUER EDIÇÃO, leia nesta ordem:
1. .agents/skills/roadcraft-people-crowd/SKILL.md      (o método obrigatório; siga-o à risca)
2. docs/handoff/people-crowd.md                         (estado, arquivos, linha de base, REJEITADOS, lista de trabalho)
3. docs/handoff/people-crowd-orders.md                  (as duas ordens do jogador: são lei)
4. AGENTS.md e CLAUDE.md
Depois rode `git status`, `npx tsc --noEmit` e a bateria
(`node scripts/test-light.mjs tests/sim/people/crowdScenarios.spec.ts`), e confirme que os números
batem com a seção 6 do handoff. Se não baterem, diga isso antes de continuar.

O QUE ENTREGAR: os itens da seção 7 do handoff, NA ORDEM. Cada item é uma fatia:
- reproduzir;
- fazer o trace;
- achar a causa;
- corrigir a causa estrutural;
- rodar a bateria inteira;
- fotografar no jogo com câmera fixa;
- fazer o commit e o push para app-roadcraft main;
- me mandar o relatório no formato da skill.

Comece pelo item 0 (higiene) e pelo item 1 (andar de ré e deslize). Na cidade do jogador, ~950 dos
1395 ticks de ré são de INTENÇÃO: o alvo ou o lugar do companheiro fica atrás do corpo. Investigue
isso primeiro.

REGRAS QUE NÃO SE NEGOCIAM:
- O Detour é o único que move o corpo. Nada de snap, empurrão, teleporte ou correção de posição depois
  do crowd.update.
- A orientação e a animação só leem a velocidade, nunca a alteram.
- Proibido mudar parâmetro, raio, geometria, spawn, destino, duração ou limiar de cenário para ficar
  verde. Um preset único do Detour.
- Não repita nada da lista de REJEITADOS. Depois de duas tentativas sem sucesso no mesmo defeito,
  pare, registre o que mediu e pesquise como simuladores consolidados resolvem antes de tentar de novo.
- Não mexa em veículos.
- Antes de tornar o motor novo o padrão ou de apagar os motores antigos, peça a minha autorização.
- Testes só pelo scripts/test-light.mjs (1 worker), em primeiro plano, poucos minutos. Nada pesado em
  segundo plano. Dev server só para fotografar (PORT=5180) e desligado depois.
- Commits com caminhos explícitos. Nunca `git add -A`. Nunca commite zz*, .claude/_*, PNG nem arquivos
  de outras sessões. Push SEMPRE com:
  git push https://github.com/designathan1988/app-roadcraft master:main
  Nunca no origin. Nunca force-push.
- Não diga que algo está pronto só por número. A prova são as fotos do jogo, olhadas uma a uma.
- Em cada relatório, diga claramente o que está NO JOGO agora e o que ainda não está implementado.

Trabalhe sem parar entre as fatias, até cumprir a definição de pronto da seção 8 do handoff. As
exceções são os pontos em que a skill manda perguntar: mudar cenário ou limiar, trocar o padrão,
apagar motor antigo.
```

## Prompt curto para retomar (nova conversa no Codex, ou depois de compactação)

```text
Retome o motor de pedestres do Roadcraft. Leia .agents/skills/roadcraft-people-crowd/SKILL.md,
docs/handoff/people-crowd.md (incluindo o Registro de revisões no fim, com as correções pedidas pelo
revisor) e docs/handoff/people-crowd-orders.md. Rode `git log --oneline -10`, `git status` e a
bateria, e continue do próximo item aberto da seção 7, com o mesmo método, commits e relatórios.
```
