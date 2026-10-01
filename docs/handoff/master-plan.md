<!-- The master plan approved by the player on 2026-10-01, copied VERBATIM (Portuguese) from the planning session.
     It is the player's document: do not translate or edit it. Status, order and working mode for Codex are in
     docs/handoff/codex-program.md. -->

# Plano completo — pessoas, carros, construção e estradas

## Contexto

O estudo de 2026-10-01 (`docs/audit/2026-10-01/study/relatorio-estudo-agentes.md`, commit `c1c89d5`) mediu e fotografou o jogo. Ele mostrou quatro grupos de problemas.

**Pessoas — aparência**
- Pele de cor chapada.
- Traços sorteados sem coerência.
- Sexo sem perfil.
- 84 corpos repetidos.
- Criança com roupa adulta.
- Expressão que é código morto.

**Pessoas — movimento**
- Grupos giram um em volta do outro.
- Corpos andam de costas em 1,8% dos ticks.
- O teste não vê isso.

**Pessoas — vida**
- Ninguém tem identidade, casa, rotina, carro nem vida dentro dos prédios.

**Carros, construção e estradas**
- Carros sem gerador e sem viagens reais.
- Construção limitada a caixas empilhadas.
- Estradas sem seção transversal editável.

> **Revisão (2026-10-01, ordem do jogador: "pare, audite, mude a estratégia").**
> A Etapa 1 original foi interrompida: ela empilhava regras novas sobre o mesmo motor (tentativa e erro). Uma segunda proposta (malha limpa + pure pursuit) também foi rejeitada pelo jogador, porque mantinha a mesma base. A seção **"Etapa 1"** agora traz as causas medidas, a pesquisa (SUMO, OpenDRIVE, Cities: Skylines, CityEngine, CARLA, Recast/Detour, molas de Holden) e uma **base nova para vias e pedestres**. As edições sem commit em `src/sim/people/people.ts` (sem ré, pivô, regra de canto passado, espera do acompanhante, `STUCK_TURN`, `OVERSHOOT_HELD` e uma linha `DEBUG-REMOVE`) são **descartadas** (`git checkout -- src/sim/people/people.ts`), e o rascunho `tests/sim/zzMillCensus.spec.ts` é apagado. As medidas que essas tentativas produziram ficam como diagnóstico (abaixo).

O jogador pediu tudo isso implementado, "sem brechas". Decisões dele (2026-10-01):
- Este plano fica com **todas** as áreas; a outra sessão para de mexer nelas.
- Vida nos prédios **abstrata primeiro, visitável depois**.
- Roupas **procedurais + comunidade MakeHuman CC0/CC-BY**, com licença por item e créditos.

## Regras de execução (valem para toda etapa)

- **Construir o novo, não remendar.** Cada etapa entra atrás de flag (`?flag=`), é medida, **fotografada opção por opção** no jogo (CLAUDE.md), vira padrão e o código antigo sai.
- **Status honesto:** cada relatório diz o que está LIVE e o que não está.
- **Testes curtos, em primeiro plano**, só os specs tocados: `node scripts/test-light.mjs <spec>`. Nada de suíte longa em background, sem subagentes paralelos.
- **Medir o que o jogador vê:** sondas sobre `PedView` e `RenderableVehicle`, por tick.
- **Commit honesto + push** para `https://github.com/designathan1988/app-roadcraft master:main` ao fim de cada etapa verificada. Atualizar `memory/agents-engine-rewrite.md`.
- Código, nomes e docs em inglês. Toda string de UI em i18n (en + pt-BR), todo gesto com equivalente de toque.
- **Licenças:** só dados MakeHuman (CC0) e itens da comunidade com licença registrada em `public/models/people/LICENSES.json`; CC-BY vai para `ui/about.ts`. Nenhum código MakeHuman/MPFB.
- **Orçamento de CPU:** ≤ 2,5 ms/tick para 1000 pessoas e ≤ 3 ms/tick para 1200 veículos (metas do desenho de agência).

---

## Etapa 0 — Base de medição (pré-requisito de tudo)

- Corrigir `tests/sim/support/agentDefects.ts`:
  - "de costas" passa a contar a partir de 0,05 m/s (hoje só a partir de 0,25, enquanto `BACK_MAX` é 0,15);
  - nova medida **dança**: caminho > 0,6 m em 2 s com deslocamento líquido < 35%;
  - viradas de lado a lado;
  - **pontos quentes** por célula de 25 u.
- Nova sonda de navegador reutilizável `scripts/probe-agents.mjs`, a partir do código usado no estudo: carrega `tests/fixtures/player-city.json`, roda com `step` de `src/sim/pipeline.ts` e grava JSON e fotos do inspetor.
- Consertar a ferramenta de fotos: `scripts/inspect-scene.mjs` `locate('ped')` ainda lê o modelo legado (`pedsInIdOrder`/`sidewalks`) e não tira nenhuma foto. Passa a ler `sim.pedViews`.
- **Aceite:** o teste FALHA hoje (ré 1,8%, dança 22% das pessoas). Isso prova que ele enxerga o defeito.

## Etapa 1 — Auditoria do andar errático e nova locomoção

### 1.1 O que foi medido (cidade do jogador, ~335 pessoas)

| Sintoma visto pelo jogador | Medida no `PedView` (Etapa 0) |
|---|---|
| Pessoa anda de costas | 2,0% do tempo em movimento, a 0,10–0,15 m/s contra o rosto |
| Grupo gira em volta de si | 0,53% do tempo em "dança"; 22% das pessoas num minuto |
| Corpo vira para lá e para cá | ~3 inversões da direção desejada (> 120°) por pessoa-minuto (987 em 60 s) |

Censo das 987 inversões por causa:
- **≈ 55%: alvo ultrapassado.** O corpo passa do canto da rota, da vaga de espera ou da vaga ao lado do líder; o alvo fica atrás e ele volta.
- **≈ 40%: alvo que pula.** A rota é refeita (A* a cada 15 ticks para acompanhantes, `follow()` saindo do corredor, replan após 2 s travado) ou surge um destino novo.

As tentativas desta sessão confirmaram o padrão de remendo:
- **Proibir a ré** trocou a ré por giro no lugar (giradas de 0,03 → 0,23/min).
- **"Canto passado"** criou um travamento de 26–38 s na tira do meio-fio, com o alvo atrás de uma parede.
- **"Só se estiver à vista"** quase nunca se aplicava, porque o canto é vértice da borda da malha.

A memória já registra 7 abordagens rejeitadas, todas na mesma camada.

### 1.2 As causas estão na arquitetura, por isso remendo não resolve

1. **Malha com agulhas.**
   - A pedra do meio-fio (0,36 m, `roadTypes.ts` `CURB_BAND`) é região própria `KERB` (`world/nav/navmesh.ts` `buildNavMesh`; `sim/people/nav.ts:90`).
   - Depois da erosão pelo raio do corpo (`NAV_RADIUS`), sobra uma tira de **~11 cm** de triângulos-agulha ao longo de toda calçada, com parede dos dois lados.
   - O corpo é posto exatamente sobre arestas e vértices, e daí saem as degenerações que o código remenda: `inside()`/`INSET`, "arquivado no triângulo errado", `SLIDE_TURNS`, `WALL_END`, `WALL_SIDE`.
   - Foi na tira do meio-fio que o travamento medido aconteceu.
2. **A direção vem de um ponto refeito a cada tick, sem noção de progresso.**
   - `funnel()` recalcula os próximos cantos a partir do corpo, todo tick (`people.ts:611`). Nada diz "já passei daqui".
   - Daí vêm ultrapassagem, troca ambígua de canto e canto atrás de parede, remendados por `CORNER_ON`, `commitDir`/`COMMIT` e pela mistura com o canto seguinte.
   - É também o maior custo de CPU medido.
3. **Alvos que andam sozinhos.**
   - A vaga do acompanhante sai do heading do líder e vira um A* completo a cada 15 ticks (`slotBeside` + `plan`, `people.ts:592-601`); o lado troca quando ele cruza a linha do líder.
   - A vaga de espera e a fila do meio-fio têm regras próprias (`settle`, `WAIT_SETTLE`, `KERB_DRIFT`, `waiterAhead`).
4. **Quatro camadas de velocidade que se vetam:**
   1. desejo (mistura de cantos, compromisso, mistura de acompanhante, `makingRoom`);
   2. ORCA (parcelas, horizonte de grupo, `keepRight`, paredes);
   3. envelope do corpo;
   4. `slide()` (recusa, giros de tentativa, ponto mais próximo).

   A velocidade final é tirada do deslocamento. No travamento medido, o ORCA alternava "seguir/parar" tick a tick no mesmo ponto.
5. **Vivacidade por escalada** (`blocked` → `urgent` → `ghost` → replan): estados que ligam e desligam e mudam as parcelas de desvio de todos em volta.
6. **O desenho reinterpreta o movimento.** `render/citizenGait.ts` suaviza o heading de novo, inclina o corpo para onde ele desliza e escolhe clipes por limiares (`MOVE_FROM_STILL`, `STOP_BELOW`, `TURN_IN_PLACE`…). Uma oscilação pequena vira troca de clipe visível.
7. **71 constantes de ajuste** em `people.ts`, quase todas com comentário "medido / costumava": é o rastro do remendo sobre remendo.

8. **A causa de fundo, comum aos dois modelos de pedestre: a calçada não existe como objeto.**
   - A via é só "segmento + classe" (`world/doc.ts` `RoadSegment`), com largura, calçada e meio-fio fixos pela classe (`roadTypes.ts`).
   - A calçada é a **sobra de booleanas de polígonos da renderização**: `world/surfaces.ts` une as faixas amostradas e os anéis de cruzamento por nível e faz `bands.footway = sidewalk − curb`.
   - Cada modelo de pedestre teve que **reconstruir caminhos a partir dessa sobra**:
     - o antigo (`sim/peds/*`, ~50 commits) amostrava cantos e herdou "segmentos reversos de centímetros" e quadros de referência inconsistentes (`docs/pedestrian-navigation-audit.md`);
     - o atual erode a sobra numa malha e herdou as agulhas do meio-fio.
   - Os veículos não têm esse problema porque têm um modelo de faixas (`world/lanelets.ts`); os pedestres nunca tiveram.

**Conclusão:** trocar a técnica de navegação mantendo a mesma base repetiria o ciclo pela terceira vez. **A base muda nas vias e nos pedestres.**

### 1.3 Pesquisa: como simuladores e jogos fazem

| Fonte | O que faz | O que aproveitamos |
|---|---|---|
| **SUMO** (DLR, simulador de tráfego urbano de referência) | Calçada é uma **faixa** da via (vClass pedestrian). Nas esquinas, **walkingareas** ligam calçadas e faixas de travessia, com 1 caminho de 1–3 segmentos por par entrada/saída. Travessias são faixas com prioridade, semáforo ou aceitação de brecha. Modelo "striping": a largura é dividida em listras de 0,65 m; o pedestre escolhe a listra com maior distância livre à frente, desvia pela direita de quem vem, e o progresso é longitudinal. Desbloqueio só após `jamtime` (300 s, 10 s na travessia) | Pedestre **por faixa**, progresso monotônico, posição lateral escolhida por espaço livre, esquinas e travessias como objetos topológicos |
| **ASAM OpenDRIVE** (padrão da indústria automotiva) | Via = linha de referência + **seções de faixa**; cada faixa com tipo (driving, sidewalk, curb, border, parking, biking, median…) e largura; cruzamentos com "connecting roads" e ligação faixa a faixa | **Seção transversal** como fonte única da via |
| **Cities: Skylines** | A rede é nó + segmento, e o segmento é **uma coleção de faixas**; o pathfinder vê tudo como faixas (direção, tipo de tráfego, velocidade), pedestres incluídos | Faixa de pedestre no mesmo grafo dos veículos, com custo |
| **CityEngine Street Designer** | Edição de seção por faixa: veículo, estacionamento, bicicleta, calçada, canteiro, transporte | Base do editor de seção (antiga Etapa 12) |
| **CARLA** (simulador urbano aberto) | A navegação dos pedestres é gerada por **Recast** a partir de superfícies **semânticas** (Sidewalk, Crosswalk, Grass), não de sobras de render; a rua só serve para atravessar | Áreas 2D (praças, entradas de prédio) com Recast sobre superfícies tipadas |
| **Recast/Detour** (via `recast-navigation-js`, MIT, WASM/Node/Worker; alternativa `navcat`, JS puro) | Navmesh por voxels, robusta e madura; corredor de rota com otimização de visibilidade e topologia; prevê curvas; frenagem de chegada; aceleração máxima; movimento restrito à superfície | Substitui a navmesh feita à mão onde 2D é necessário |
| **Daniel Holden, "Spring-It-On"** | Controlador de personagem por **mola criticamente amortecida**: a velocidade desejada é o alvo da mola; chega sem ultrapassar e sem oscilar, estável a qualquer passo de tempo, e prevê a trajetória futura | O corpo segue a velocidade desejada sem tremer, e o desenho recebe a trajetória |
| **Artigos sobre DetourCrowd** | O tremor de agente humano vem de o rosto seguir o vetor de direção antes do desvio, em vez da velocidade real, e de pequenos vetores perto da chegada | Rosto pela velocidade suavizada da mola, nunca por vetores pequenos |

Fontes:
- [SUMO — Pedestrians](https://sumo.dlr.de/docs/Simulation/Pedestrians.html) e [documento-fonte](https://github.com/eclipse-sumo/sumo/blob/main/docs/web/docs/Simulation/Pedestrians.md)
- [ASAM OpenDRIVE](https://www.asam.net/standards/detail/opendrive/)
- [CSUR (Cities: Skylines, vias por faixa)](https://github.com/citiesskylines-csur/CSUR)
- [Complete Street Rule / CityEngine](https://github.com/d-wasserman/Complete_Street_Rule)
- [CARLA — Generate Pedestrian Navigation](https://carla.readthedocs.io/en/0.9.14/tuto_M_generate_pedestrian_navigation/)
- [DetourCrowd.cpp](https://github.com/recastnavigation/recastnavigation/blob/main/DetourCrowd/Source/DetourCrowd.cpp)
- [recast-navigation-js (MIT)](https://github.com/isaac-mason/recast-navigation-js)
- [detour-crowd-rs (notas sobre tremor)](https://github.com/bhubbard/detour-crowd-rs)
- [Holden — Spring-It-On / Spring Roll Call](https://theorangeduck.com/page/spring-roll-call)

### 1.4 A nova base

**V. Vias: seção transversal como fonte única** (antecipa o núcleo da antiga Etapa 12)
- `RoadSegment` ganha uma **seção**: faixas ordenadas por lado, cada uma com tipo e largura. Tipos: rolamento, ônibus, bicicleta, estacionamento, meio-fio, faixa de serviço/árvores, calçada, canteiro.
- A classe atual vira **predefinição de seção**. Mapas antigos migram derivando a seção da classe (ida e volta testada).
- **Tudo deriva da seção:** as faixas de veículos (`lanelets.ts`), as **faixas de pedestre** e as superfícies de render (asfalto, meio-fio, calçada).
- Os cantos dos cruzamentos continuam vindo do construtor existente (`world/junction/*`: pernas, cortes, filetes), mas a **calçada é uma faixa com linha de referência** (deslocamento da borda do meio-fio), não a sobra de uma diferença de polígonos.
- **Cruzamento gera, além dos conectores de veículos:**
  - **áreas de esquina** (walkingareas): o polígono entre as pontas das calçadas e o filete da esquina, com um caminho suave (arco paralelo ao filete) por par entrada/saída;
  - **travessias**: faixa do meio-fio ao meio-fio na posição da zebra, que já existe em `crossings/*`.

**P. Pedestres: por faixa na rede, 2D só onde é aberto**
- **Na calçada, na esquina e na travessia:** posição = (faixa, `s`, deslocamento lateral `d`).
  - `s` **só avança**: não há ponto a ultrapassar nem canto a escolher.
  - O rosto segue a tangente da faixa mais a componente lateral.
  - A rota é a sequência de faixas (A* no grafo de faixas, o mesmo tipo de grafo dos veículos), calculada uma vez por viagem.
- **Desvio lateral contínuo, à SUMO:** a cada decisão (~4 Hz), escolher `d` dentro da largura útil pela maior distância livre à frente (pessoas e obstáculos na mesma faixa, ordenados por `s`), com preferência pela direita para quem vem e histerese para manter a escolha. A transição lateral é suave (mola).
  - Desvio em 1D + lateral é **estável por construção**: sem ORCA em 2D, sem vetor oscilando, custo O(n log n) por faixa.
- **Mobiliário e árvores** ficam na faixa de serviço, que é outra faixa da seção. Por isso nunca estão no caminho de quem anda na calçada (fecha também o P1-16).
- **Grupos:** membros na mesma faixa, com `s` do líder menos o espaçamento e `d` em vagas lado a lado, ou em fila quando a largura útil não comporta o grupo, com histerese. **Não existe A* nem vaga por acompanhante.**
- **Espera na travessia:** fila na própria faixa, antes da boca da zebra (posições por `s`), com a permissão atual (`crossings/permission.ts`).
- **Áreas abertas** (praças, caminho até a porta, estacionamento, parque): navmesh **Recast** (`recast-navigation-js`) gerada das superfícies tipadas do lote e da praça, ligada às calçadas por portais. Lá vale o corredor do DetourCrowd (`findCorners` + otimização de visibilidade e topologia + curva antecipada + chegada) com aceleração máxima.

**C. Corpo e desenho**
- **Controlador por mola criticamente amortecida** (Holden): a velocidade desejada (faixa ou corredor) é o alvo da mola. Velocidade e aceleração contínuas, sem ultrapassar e sem oscilar. O rosto segue a velocidade da mola.
- **Ações explícitas**, com duração mínima: `Walk`, `TurnInPlace`, `Wait`, `StepAside`, `Sit`. Desejo atrás das costas = `TurnInPlace` concluído antes de andar. Nada de ré.
- **O `PedView` publica ação, velocidade, giro e a trajetória prevista da mola.** O `citizenGait` toca isso, com fase por distância, sem limiares e sem suavizar de novo.

**O que sai:** o motor `src/sim/people/people.ts` inteiro como modelo de calçada (funnel por tick, ORCA em 2D, `slotBeside`, `commitDir`, `settle`, `slide`, urgente/fantasma e as 71 constantes); a navmesh feita à mão (`world/nav/navmesh.ts`, `path.ts`); a geração de calçada por diferença de polígonos para a simulação. O legado `src/sim/peds/*` é apagado de vez.

**O que fica:** a interface `PedestrianEngine`, `PedView`, `CrossingState` e `PeopleBridge`; a permissão de travessia; bancos e portas (viram objetos de uso nas faixas e áreas); o construtor de cantos dos cruzamentos; o harness e a sonda da Etapa 0.

### 1.5 Entrega (fatias visíveis, A/B com a mesma semente, `?people=lanes`)

1. **Seção transversal** no modelo de via, com migração; superfícies de render derivadas dela. **Aceite:** mapas antigos idênticos em foto (A/B) e no `npm run fuzz`.
2. **Grafo de pedestres:** faixas de calçada, áreas de esquina e travessias geradas da seção e dos cruzamentos. **Aceite:** sobreposição fotografada em 10 cidades; conectividade 100%; nenhuma faixa com largura útil < 0,8 m sem ser marcada.
3. **Pedestre por faixa:** `s` monotônico, lateral contínuo, mola, ações, grupos e espera em fila, para pessoas sozinhas e grupos.
4. **Áreas abertas com Recast**, ligadas por portais (portas, praças).
5. **Desenho por ações** e fotos em sequência.
6. Virar padrão e apagar o antigo (motor 2D atual, navmesh à mão, `sim/peds/*`).

**Aceite final** (harness da Etapa 0, 10 cidades × sementes 0/7/13, mais a sonda no jogo):
- ré = 0;
- dança < 0,1% e nenhum episódio > 1 s;
- inversões da direção desejada < 0,2 por pessoa-minuto (hoje ~3);
- giradas ≤ 0,05/min;
- parada fora de espera < 3 s; faixa < 3 s; cruzamento < 60 s;
- sobreposição de corpos < 0,05/min;
- ≤ 2,5 ms/tick com 1000 pessoas;
- fotos em sequência dos pontos quentes: (200,1425), (1037,1225), (625,1350), (1150,1500), (-350,-100).

**Disciplina:** nenhuma regra ajustada no escuro. Cada fatia começa pelo teste que mede o seu defeito e termina com número e foto. Uma fatia que não bate a meta volta ao censo por causa.

## Etapa 1b — Auditoria do movimento dos veículos

Hoje **não existe nenhuma medida de suavidade dos veículos**: nenhum spec mede jerk, frenagem acima da de emergência, saltos de pose ou para-e-anda.

1. **Sonda de veículos** (estender `scripts/probe-agents.mjs` e `tests/sim/support/agentDefects.ts`) sobre a pose desenhada (`sim/pose.ts` `vehiclePose`):
   - jerk p95;
   - desaceleração acima de `bEmergency`;
   - parada instantânea (`v` zerado num tick);
   - saltos de posição e de heading;
   - oscilação lateral na troca de faixa;
   - ciclos de para-e-anda;
   - sobreposição de corpos;
   - pontos quentes com fotos em sequência.
2. **Fontes vistas no código, a confirmar pela medida:**
   - `integrate.ts:104-119` zera `v` num tick ("sem para onde ir", "fim da faixa");
   - a troca de faixa é instantânea no índice de ocupação (`state.ts:216`);
   - P2-07 (empilhados no mesmo `s`), P2-10 (reservas perdidas após edição), P1-42 (sinal sem amarelo);
   - motorista do ônibus sumindo num quadro (foto da Etapa 0).
3. **Conserto pela causa:** nenhum produtor emite parada que o carro não consegue fazer; nenhuma variável de estado salta.

**Aceite:**
- jerk p95 ≤ 3 m/s³;
- 0 paradas instantâneas fora de colisão;
- 0 saltos de pose;
- 0 sobreposições;
- fotos.

## Etapa 2 — Pele, fenótipo, dimorfismo, roupa infantil

Arquivos: `src/people/spec.ts`, `src/people/roster.ts`, `src/render/people/personRig.ts`, `src/render/riggedCitizens.ts`, `src/render/people/personMesh.ts`, `src/ui/creator/personCreator.ts`. Novo: `src/people/phenotype.ts`.

1. **Pele texturizada.** Reaproveitar as 18 texturas CC0 **já importadas e não usadas** em `public/models/people/skins/` (índice com idade/origem/sexo, feito por `scripts/import-makehuman-proxies.mjs`).
   - **Multidão:** UV da pele no corpo (o base mesh tem UV) e atlas de pele por protótipo.
   - **Tom contínuo** como multiplicador em espaço linear, por instância.
   - **Material de pele:** iluminação wrap, rugosidade ~0,5, especular baixo. É um `onBeforeCompile` sobre o material clonado em `riggedCitizens.ts:497-503`.
   - **Cor por vértice:** fica só para os LODs distantes.
2. **Fenótipo** (`phenotype.ts`):
   - melanina e subtom contínuos a partir de `african/asian/caucasian`;
   - cabelo e olhos condicionados (ruivo e olho claro raros);
   - grisalho por idade.
   - `randomPerson` passa a usar isso em vez de `pick(SKIN_TONES)`, `pick(EYE_COLOURS)` e `pick(HAIR_COLOURS)`.
3. **Perfis de dimorfismo** em `faceShape` e `randomPerson`:
   - distribuições por sexo para mandíbula, queixo, arco superciliar, lábios, maçãs, pescoço e cintura/quadril;
   - `muscle`/`weight` por sexo;
   - sobrancelhas separadas em listas finas/arqueadas e retas/grossas;
   - cabelo longo/médio na maioria das mulheres;
   - **barba/bigode/sombra de barba**: textura sobreposta + cartões da comunidade, se houver CC0/CC-BY;
   - maquiagem leve opcional (textura).
4. **Roupa infantil:** etiqueta `audience: adult|child|any` por peça. O gerador nunca veste uma criança com peça adulta, e `tests/people/wardrobe.spec.ts` bloqueia o caso.
5. **Malha:**
   - corrigir a pele que vaza na barra (margem de `deleteVerts` por peça em `dressedGeometry`);
   - cabelo com alpha-to-coverage em vez do corte `SOLID`;
   - LOD 0 desenhado **texturizado**, como `personPreview.ts` já faz.
6. **Criador:** sliders de fenótipo e dimorfismo; "aleatorizar" usa o mesmo gerador.
7. **Aceite:**
   - contact sheet de 40 retratos (`scripts/contact-sheet.mjs`) revisada a olho, sem laranja, sem branco estourado e com sexo legível a 10 m;
   - teste estatístico: medidas de mandíbula, queixo e lábio separam os sexos em ≥ 95%.

## Etapa 3 — Expressão viva

1. `scripts/import-makehuman.mjs`: deixar de excluir `targets/expression` (`EXCLUDED_TARGET_DIRS`). Empacotar só um conjunto: piscar E/D, sorriso, sorriso aberto, franzir, sobrancelhas para cima, e visemas A/O/E/M.
2. `personRig.ts`: criar `morphAttributes.position` com esses alvos ajustados ao corpo. Os alvos são deltas no espaço do base mesh, então o mesmo `Morpher` (`src/people/body/morph.ts`) aplica.
3. `riggedCitizens.ts`: trocar os nomes Rocketbox em `setFacialExpression` pelos novos. O `facialExpression` já existente dirige piscar, fala e olhar.
4. Olhos seguem um alvo (osso do olho no esqueleto `game_engine`, ou rotação do grupo `helper-*-eye`).
5. Humor de repouso: um campo `mood` no `PersonSpec`, vindo da mente na etapa 6.
6. **Aceite:** sequência de fotos de uma conversa (boca, piscar); orçamento de morph medido com 300 pessoas.

## Etapa 4 — Multidão sem repetição + memória

Arquivos: `src/render/riggedCitizens.ts`, `src/render/citizenCasting.ts`, `src/people/roster.ts`, `src/render/people/personRig.ts`. Novos: `src/people/garments/*` (peças procedurais), `scripts/import-makehuman-community.mjs`.

1. **Protótipos de forma** (128–256): corpos cozidos por cluster de parâmetros macro.
2. **Variação por instância no shader:**
   - um canal de "slot de material" por vértice (pele, cabelo, peça 1..n, sapato);
   - uma textura de paleta por instância: tom de pele, cabelo, cor e estampa por peça.
   - O protótipo é escolhido pelo cidadão (etapa 5); a cor vem do `PersonSpec`.
3. **Vestuário por peças:**
   - slots: roupa de baixo, blusa/camisa, casaco, vestido, sapato, chapéu, óculos, bolsa;
   - **peças procedurais** (camiseta, regata, camisa, polo, calça, jeans, bermuda, saia, vestido, casaco) geradas sobre o corpo como casca deslocada da pele por região, com a mesma estrutura de `fitProxy`/`proxySkin` (`src/people/body/proxy.ts`);
   - **estampas procedurais**: liso, listra, xadrez, jeans, floral simples;
   - o "dress code" (`citizenCasting.ts` `CODES`/`compatible`) passa a combinar peças.
4. **Importador da comunidade:** itens com licença por item, gravada no manifesto; CC-BY nos créditos (`ui/about.ts`).
5. **Animação cozida por esqueleto, não por corpo** (P1-27), com skinning na GPU. Resolver P2-61 junto: uma `texSubImage2D` por lote.
6. **Aceite:**
   - em 300 pessoas, zero pares iguais de rosto+roupa+cor;
   - heap JS < 250 MB na cidade do jogador (hoje ~570);
   - fotos de rua.

## Etapa 5 — Registro de Cidadãos, relógio do dia, dia/noite

Novos: `src/sim/citizens/registry.ts`, `household.ts`, `clock` do dia em `src/sim/clock.ts`; renderer `src/render/environment.ts` + `src/render/lighting` (sol/lua, postes e faróis).

1. **`Citizen`:**
   - id permanente e `PersonSpec`;
   - traços: paciência, sociabilidade, pressa, renda;
   - domicílio, emprego/escola, veículo, agenda e estado (`home|walking|driving|riding|inside(buildingId)|away`).
   - Salvo em `RoadDoc` ao lado de `people` (`src/world/doc.ts:134`), com `normalize` como `normalizePerson`.
2. **População gerada a partir dos prédios:**
   - unidades residenciais por área e por `use`/`spaces` (`world/buildings/types.ts`) → domicílios;
   - comerciais e industriais → empregos.
   - Sem prédios, a cidade usa a borda (visitantes).
3. **O pedestre e o corpo desenhado usam o cidadão:** `PedView` ganha `citizenId`, e `citizenCasting` deixa de sortear pelo hash. O `CROWD` fixo de 84 sai.
4. **Relógio do dia** com velocidade configurável. Dia/noite: luz, postes acesos, faróis (já há código de lâmpadas em `render/vehicleSignals.ts`).
5. **Aceite:** seguir uma pessoa por um dia de jogo (casa de manhã, volta à noite), com fotos de manhã, tarde e noite.

## Etapa 6 — Mente, agenda e prédios habitados (abstrato)

Novos: `src/sim/citizens/mind.ts` (utilidade + persistência ≥ 30%), `src/sim/citizens/schedule.ts` (atividades por papel), `src/sim/affordances/*` (porta de prédio, banco, ponto de conversa, ponto de ônibus, vitrine). Modificar: `people.ts` `pickGoal`, que passa a receber a tarefa da mente.

1. **Agenda por papel:** trabalhador, estudante, aposentado, criança com responsável.
2. **Escolha do lugar** por `use` do prédio e distância; **escolha do modo** (a pé / carro / ônibus) por distância, posse de carro e pressa.
3. **Tarefas:** MoveTo, UseAffordance, WaitFor, Follow, EnterBuilding, ExitBuilding, BoardVehicle.
4. **Ocupação abstrata:**
   - quem entra pela porta passa a constar no andar (`inside`), e o corpo sai do navmesh;
   - inspetor do prédio: moradores e trabalhadores presentes;
   - janelas acesas à noite pela ocupação (`render/buildings/buildingMesh.ts`, emissivo por andar).
5. **Nível de detalhe:** longe da câmera, o cidadão é um registro com hora de chegada; perto, materializa no navmesh.
6. **Aceite:**
   - soma da ocupação = entradas − saídas;
   - nenhuma pessoa "some" sem estado;
   - CPU dentro do orçamento com 1000 cidadãos ativos;
   - fotos de entrada e saída de prédio, e janelas à noite.

## Etapa 7 — Estacionamento e acessos

Modificar: modelo de via (seção transversal mínima, ver etapa 12), `src/world/lanelets.ts` (faixa de estacionamento e vagas), elemento `parking` dos prédios (`ELEMENT_KINDS`) vira vagas de verdade. Novo: `src/world/parking.ts` (vagas: posição, orientação, dono, ocupante) e acessos de lote (meio-fio rebaixado que liga o lote à faixa).

**Aceite:** carros estacionados na rua e nos lotes, desenhados e salvos; fotos de vaga, garagem e lote.

## Etapa 8 — Pessoa dirige (fim do "fingir que entrou")

Modificar: `src/sim/people/engine.ts` (`PeopleBridge` vira caixa de mensagens de duas vias: `offerDoor`/`atDoor`/`boarded`/`aborted`/`alight`), `src/sim/vehicles/kerbStops.ts`, `src/sim/vehicles/spawn.ts`, `src/sim/vehicles/state.ts` (`seats` passa a guardar ids de cidadãos), `src/render/occupants.ts`.

1. O cidadão com tarefa "carro" **anda até o próprio carro** estacionado e para na porta do motorista. A porta abre (já anima); a pose de sentar e dirigir já existe em `riderPoses.ts`.
2. **O carro acorda** e entra no Drive v2. `makeDriver` passa a ler os traços do cidadão (pressa → agressividade, paciência → `patience`). Passageiros são cidadãos reais (família junta).
3. **No destino:** procura vaga (busca nas vagas livres por proximidade do destino), estaciona com manobra, desce e anda até a porta.
4. **Pegar e deixar** (`kerbStops`): a pessoa continua existindo como passageira, com o mesmo id. Nada é apagado nem criado.
5. O tráfego de passagem da borda continua, com motoristas cidadãos "visitantes".
6. **Aceite:**
   - 100% dos embarques completam ou abortam limpos (desenho de agência);
   - o id da pessoa nunca muda;
   - sequência de fotos do sofá ao trabalho.

## Etapa 9 — Carros inteligentes

Modificar: `src/sim/routing/destination.ts` (destino = vaga ou prédio, não `boundaryExit`), `src/sim/routing/router.ts` (P2-06), `src/sim/drive/tactical.ts`, `src/sim/vehicles/spawn.ts` (P2-01), `src/sim/signals/*` (P1-42, P1-43, P1-45), `src/sim/vehicles/kerbStops.ts` (P2-05). Novo: `src/sim/drive/strategic.ts`.

1. **Rota estratégica por tempo de viagem medido**: campos de custo por zona, renovados em rodízio, com histerese.
2. **Percepção:**
   - o que está à vista;
   - pedestre fora da faixa (lê o `PedView`);
   - porta abrindo;
   - ceder a quem já está na faixa.
3. **Semáforos:** ids estáveis de grupo, controladores preservados numa edição, descanso no verde, estágios vazios pulados.
4. **Ônibus com linha e pontos; entregas para prédios comerciais.**
5. **Aceite:**
   - gridlock < 60 s em 20 sementes × 30 min;
   - headway de saturação 1,8–2,2 s;
   - jerk p95 ≤ 3 m/s³;
   - fotos de cruzamentos.

## Etapa 10 — Gerador de carros + Criador de Veículos

Modificar: `src/render/carBody.ts` (que já faz loft paramétrico com 6 `STYLES`), `src/sim/vehicles/archetypes.ts`. Novos: `src/vehicles/spec.ts` (`VehicleSpec`), `src/vehicles/fleet.ts`, `src/ui/creator/vehicleCreator.ts` (no mesmo shell do `personCreator.ts`).

1. **`VehicleSpec`:**
   - proporções: comprimento, entre-eixos, balanços, largura, altura, capô e cintura;
   - silhueta: inclinação do para-brisa e do vidro traseiro, queda do teto, coluna C;
   - frente e traseira, faróis e lanternas (forma e assinatura), grade;
   - rodas: aro e desenho;
   - acabamento;
   - pintura: sólida, metálica, perolada, dois tons; desgaste por idade.
2. Os `STYLES` atuais viram **famílias** (pontos de partida) do gerador.
3. **Frota** com distribuições realistas, sem marcas registradas. Carros de cidadãos ficam salvos com a cidade.
4. **Desenho por protótipos instanciados**, cacheados por hash do spec.
5. **Aceite:** contact sheet de 200 carros sem dois iguais; ≤ 3 ms/tick com 1200 veículos; fotos do Criador em cada seção.

## Etapa 11 — Interações sociais

Novos: affordances `talkSpot`, `queue`, `shopCounter`, `busStop` em `src/sim/affordances/*`; grafo social leve (vizinhos, colegas) no Registro; clipes de acenar e cumprimentar (Quaternius CC0) além dos do Rocketbox já cozidos (`talk`, `listen`, `phone` em `riggedCitizens.ts` `LIBRARY`).

**Aceite:** conhecidos que se cruzam param e conversam (com expressão da etapa 3); filas ordenadas; fotos e contagem de interações por hora de jogo.

## Etapa 12 — Estradas livres

> O **modelo** de seção transversal e a migração passam para a Etapa 1 (fatia 1), como base de vias e pedestres. Aqui fica a liberdade de criação em cima dele: o editor, a rotatória, os tipos novos e os objetos de via.

Modificar: `src/world/doc.ts` (`RoadSegment` ganha `section`: faixas por lado com tipo — carro, ônibus, ciclovia, estacionamento, conversão — e largura; calçada por lado; faixa de árvores; canteiro com largura e tipo), `src/world/roadTypes.ts` (classes viram predefinições de seção), `src/world/lanelets.ts`, `src/world/nav/navmesh.ts`, malhas de via e marcações (`src/render/roadSurfaces.ts`, `src/render/markings.ts`), UI do painel de via.

1. **Editor de seção transversal** por arrastar, com transição suave entre seções no comprimento.
2. Faixas de conversão e bolsões com setas pintadas; o grafo de faixas lê as setas.
3. **Rotatória** (ferramenta: anel de mão única + entradas com "dê a preferência").
4. Rua de pedestres, viela, estrada de terra, ciclovia separada.
5. Faixa de pedestres no meio da quadra, lombada, semáforo de pedestres.
6. Velocidade e preferência por via no inspetor.
7. Trilho de bonde na seção (veículo guiado no fim da etapa).
8. Migração: mapas antigos derivam a seção da classe atual (round-trip testado).
9. **Aceite:** cada tipo desenhado e fotografado com carros e pessoas usando; `npm run fuzz` com o invariante "rede viva ≡ rede nova"; edição local < 30 ms.

## Etapa 13 — Construção livre, depois interiores

Novos: `src/world/buildings/solid/*` (esboços + operações), dependência `manifold-3d` (WASM; viabilidade já medida em `docs/design/building-editor-ux.md`). Modificar: `src/world/buildings/types.ts` (schema 3 com migração do 2), `src/render/buildings/buildingMesh.ts`, `src/editor/buildingTool.ts`, `src/ui/builder/workspace.ts`.

1. **Documento de esboços + operações** (extrudar, cortar, deslocar, chanfrar), com IDs estáveis de face. Volumes antigos migram para esboço + extrusão, e mapas antigos abrem iguais.
2. **Pátio, furo, átrio, corte vazado** (Manifold), com fachadas e materiais preservados pela proveniência de face.
3. **Esboço com arcos e bézier**: paredes curvas, torre redonda; fachada distribuída na curva.
4. **Telhado por aresta** (straight skeleton), mansarda, cônico, **domo e abóbada** (revolução).
5. **Aberturas livres** (posição e tamanho quaisquer, moldura paramétrica) e **pintura por região**.
6. **Elementos presos à face:** sacadas, marquises, colunas, cornijas, frontões; importar glTF com licença.
7. **Interiores visitáveis** (decisão do jogador: depois do abstrato):
   - plantas por andar a partir de `spaces`;
   - vista em corte;
   - móveis paramétricos;
   - cidadãos da etapa 6 aparecem dentro quando o andar está em corte.
8. **Aceite:** pátio, torre redonda, domo, janela livre, telhado misto e um interior em corte, cada um fotografado, com o caminho de volta; desfazer exato; edição < 30 ms.

---

## Ordem e dependências

`0 (feita, 1c431c3) → 1 (nova base: seção transversal + pedestres por faixa + Recast nas áreas abertas) → 1b (veículos medidos e consertados na nova base) → 2 → … → 13`

A 1b vem depois da fatia 1 da Etapa 1, porque as faixas de veículos passam a derivar da seção transversal.

- **1–4:** o que o jogador vê hoje nas pessoas.
- **5–8:** identidade, rotina, prédios habitados e o carro de verdade. A etapa 7 usa a seção mínima de via; a 12 a completa.
- **9–11:** inteligência e vida.
- **12–13:** liberdade de criação.

Cada etapa é uma entrega LIVE; nenhuma é "preparação".

## Arquivos-chave a reutilizar

- `src/people/body/morph.ts` (`Morpher`), `src/people/body/proxy.ts` (`fitProxy`, `proxySkin`, `sampleTexture`), `src/people/body/macro.ts`.
- `src/render/people/personPreview.ts`: desenho texturizado, base do LOD 0.
- `public/models/people/skins/*`: 18 peles CC0 já importadas e não usadas.
- `src/sim/people/orca.ts` (`solveOrca`, `orcaLine`, `wallLine`) e `src/sim/people/people.ts` (`shareOf`/`rankOf`, `slide`, `turn`).
- `src/sim/people/engine.ts` (`PeopleBridge`), `src/sim/vehicles/kerbStops.ts`: portas e fases de embarque.
- `src/render/carBody.ts` (`buildCarModel`, `STYLES`, `carShape`).
- `src/sim/drive/tactical.ts`, `src/sim/vehicles/driver.ts` (`makeDriver`).
- `scripts/inspect-scene.mjs` (inspetor com carimbo), `scripts/contact-sheet.mjs`, `tests/sim/support/agentDefects.ts`.

## Verificação (por etapa e ao final)

1. **Testes curtos dos specs tocados:** `node scripts/test-light.mjs <spec>`; `AGENT_REPORT=<f> node scripts/test-light.mjs tests/sim/agents/defects.spec.ts` (~2,5 min).
2. **Sonda no jogo:** `node scripts/probe-agents.mjs --base=<dev>`. Métricas por tick em `PedView`/veículos e pontos quentes.
3. **Fotos:** `preview_start roadcraft-dev`, depois `node scripts/inspect-scene.mjs <out> <sets> --base=<url>`.
   - Retratos, grupos, rua, carros, Criadores (cada seção), painéis de via e construção (cada opção e o caminho de volta).
   - Olhadas uma a uma, salvas em `docs/audit/<data>/<etapa>/` como JPG.
4. **Desempenho:** `scripts/bench-sim.mjs` antes/depois (ms/tick por estágio) e heap no navegador.
5. **Fechamento:**
   - commit + push para o app-roadcraft;
   - memória atualizada;
   - relatório ao jogador com o que está LIVE, as medidas e as fotos.
